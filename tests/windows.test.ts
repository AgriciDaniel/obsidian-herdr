import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { migrateSettings, type AgentInfo } from "../src/domain/types";
import { buildHostNormalizedEnv, HerdrCliClient, resolveExecutableOnNormalizedPath } from "../src/herdr/cli-client";
import { herdrConnectPath, HerdrSocketClient } from "../src/herdr/socket-client";
import { HerdrCoordinator } from "../src/services/herdr-coordinator";
import { findWindowsPowerShell, MAX_TERMINAL_CELLS, PtySession, quoteWindowsArg, resolveConPtyApplication } from "../src/terminal/pty-host";

// Windows fixes (AI-Marketing-Hub/home issues #73, #74, #76, PR #78), as in AIMH Team 0.3.29. These tests run on Linux with
// process.platform and the environment set the way Windows has them; they never run Windows
// itself. Nothing outside the temporary folders they make is touched.

if (typeof globalThis.window === "undefined") {
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
}

/** Runs `fn` with process.platform reading `platform`, then puts it back. */
async function asPlatform<T>(platform: NodeJS.Platform, fn: () => T | Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

/** Runs `fn` with these process.env keys set (undefined removes one), then restores them. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, value] of Object.entries(v)) {
      if (value === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = value;
      }
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

describe("Windows: the environment copy keeps one PATH on Windows (#78, #76 second half)", () => {
  it("reads Windows' Path into PATH, leaves no second key and changes neither input", async () => {
    await asPlatform("win32", () => {
      const base = { Path: "C:\\Windows\\System32;C:\\Users\\m\\AppData\\Roaming\\npm", Foo: "x" };
      const out = buildHostNormalizedEnv(base);
      assert.equal(out.PATH, base.Path);
      assert.equal(out.Foo, "x");
      assert.deepEqual(Object.keys(out).filter((k) => k.toUpperCase() === "PATH"), ["PATH"]);

      const overrides = { PATH: "C:\\kit\\bin;C:\\Windows\\System32" };
      const both = buildHostNormalizedEnv(base, overrides);
      assert.equal(both.PATH, overrides.PATH, "an override's PATH wins over the base Path");
      assert.deepEqual(Object.keys(both).filter((k) => k.toUpperCase() === "PATH"), ["PATH"]);
      assert.deepEqual(base, { Path: "C:\\Windows\\System32;C:\\Users\\m\\AppData\\Roaming\\npm", Foo: "x" });

      assert.ok(!("PATH" in buildHostNormalizedEnv({ Foo: "x" })), "no search path anywhere: none is made up");
    });
  });

  it("finds agent programs that npm installs as .cmd shims, with only Path set", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team57-bin-"));
    try {
      fs.writeFileSync(path.join(dir, "codex.cmd"), "@echo off\r\n");
      fs.writeFileSync(path.join(dir, "claude.exe"), "");
      await withEnv({ PATH: undefined, Path: dir }, () =>
        asPlatform("win32", () => {
          assert.equal(resolveExecutableOnNormalizedPath("codex"), path.join(dir, "codex.cmd"));
          assert.equal(resolveExecutableOnNormalizedPath("claude"), path.join(dir, "claude.exe"));
          assert.equal(resolveExecutableOnNormalizedPath("gemini"), null);
        })
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Windows: Herdr's socket path on Windows is a named pipe (#73)", () => {
  it("puts the pipe prefix in front of a Windows path and leaves every other path as it is", () => {
    const win = "C:\\Users\\m\\AppData\\Roaming\\herdr\\sessions\\vault-x\\herdr.sock";
    assert.equal(herdrConnectPath(win, "win32"), "\\\\.\\pipe\\" + win);
    assert.equal(herdrConnectPath("\\\\.\\pipe\\" + win, "win32"), "\\\\.\\pipe\\" + win);
    assert.equal(herdrConnectPath("\\\\?\\PIPE\\herdr", "win32"), "\\\\?\\PIPE\\herdr");
    assert.equal(herdrConnectPath("/home/m/.config/herdr/herdr.sock", "linux"), "/home/m/.config/herdr/herdr.sock");
    assert.equal(herdrConnectPath("/Users/m/.config/herdr/herdr.sock", "darwin"), "/Users/m/.config/herdr/herdr.sock");
    assert.equal(herdrConnectPath("", "win32"), "");
  });

  it("counts Herdr's pointer file as present on Windows, and only a socket elsewhere", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team57-sock-"));
    const pointer = path.join(dir, "herdr.sock");
    fs.writeFileSync(pointer, "1234:token");
    try {
      const client = new HerdrSocketClient(pointer);
      assert.equal(await asPlatform("win32", () => client.isSocketPresent()), true);
      assert.equal(await asPlatform("linux", () => client.isSocketPresent()), false);
      client.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to Herdr's folder under APPDATA on Windows, not \\\\.\\pipe\\herdr", async () => {
    const resolve = HerdrCoordinator.prototype.resolveTargetSocketPath.bind({
      getSettings: () => migrateSettings({}),
      statusPayload: null,
    } as unknown as HerdrCoordinator);
    const appData = "/fake/AppData/Roaming";
    await withEnv({ HERDR_SOCKET_PATH: undefined, APPDATA: appData }, async () => {
      assert.equal(await asPlatform("win32", resolve), path.join(appData, "herdr", "herdr.sock"));
      assert.equal(await asPlatform("linux", resolve), path.join(os.homedir(), ".config", "herdr", "herdr.sock"));
    });
  });
});

describe("Windows: the Windows terminal driver is chosen only where it can run (#76)", () => {
  it("quotes arguments so CommandLineToArgvW reads them back unchanged", () => {
    assert.equal(quoteWindowsArg("herdr.exe"), "herdr.exe");
    assert.equal(quoteWindowsArg(""), '""');
    assert.equal(quoteWindowsArg("C:\\Program Files\\Herdr\\herdr.exe"), '"C:\\Program Files\\Herdr\\herdr.exe"');
    assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
    assert.equal(quoteWindowsArg("trailing slash\\"), '"trailing slash\\\\"');
  });

  it("uses Windows PowerShell on Windows 10 1809 or later, and never on Linux or macOS", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "team57-win-"));
    const ps = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    fs.mkdirSync(path.dirname(ps), { recursive: true });
    fs.writeFileSync(ps, "");
    // The module object itself: the bundled namespace import only reads through to it.
    const nodeOs = process.getBuiltinModule("node:os") as { release: () => string };
    const realRelease = nodeOs.release;
    const setRelease = (value: string) => {
      nodeOs.release = () => value;
    };
    try {
      await withEnv({ SystemRoot: root }, async () => {
        setRelease("10.0.22631");
        assert.equal(await asPlatform("win32", findWindowsPowerShell), ps);
        assert.equal(await asPlatform("linux", findWindowsPowerShell), null);
        assert.equal(await asPlatform("darwin", findWindowsPowerShell), null);
        setRelease("10.0.17134");
        assert.equal(await asPlatform("win32", findWindowsPowerShell), null, "before 1809 there is no pseudoconsole");
        setRelease("10.0.22631");
        fs.rmSync(ps);
        assert.equal(await asPlatform("win32", findWindowsPowerShell), null, "no PowerShell: plain pipes as before");
      });
    } finally {
      nodeOs.release = realRelease;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Windows: no initial prompt into an agent waiting at a question (#74)", () => {
  function coordinatorWith(listed: () => AgentInfo[], binding: () => string = () => "s") {
    const c = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
    Object.assign(c as unknown as Record<string, unknown>, {
      disposed: false,
      socket: { listAgents: async () => listed() },
      sessionBinding: binding,
    });
    return c as unknown as { waitWhileBlocked: (a: AgentInfo, bound?: string) => Promise<boolean> };
  }
  const agent = (over: Partial<AgentInfo>): AgentInfo =>
    ({ pane_id: "w1:p2", name: "a", agent: "claude", agent_status: "blocked", interactive_ready: false, launch_pending: true, focused: false, ...over }) as AgentInfo;

  it("is ready at once for an agent that is not blocked", async () => {
    assert.equal(await coordinatorWith(() => []).waitWhileBlocked(agent({ agent_status: "idle", interactive_ready: true })), true);
  });

  it("waits while blocked and is ready once the member answered", async () => {
    let lists = 0;
    const c = coordinatorWith(() => [++lists < 2 ? agent({}) : agent({ agent_status: "idle", interactive_ready: true, launch_pending: false })]);
    assert.equal(await c.waitWhileBlocked(agent({})), true);
    assert.equal(lists, 2);
  });

  it("gives up when the agent left (it answered No, exit)", async () => {
    assert.equal(await coordinatorWith(() => []).waitWhileBlocked(agent({})), false);
  });
  it("gives up when the member switched to another session during the wait", async () => {
    let session = "s";
    const c = coordinatorWith(() => {
      session = "other";
      return [agent({})];
    }, () => session);
    assert.equal(await c.waitWhileBlocked(agent({}), "s"), false);
  });

  it("sends the initial prompt only while the agent's session is still the active one", async () => {
    let session = "vault";
    const prompts: string[] = [];
    const c = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
    Object.assign(c as unknown as Record<string, unknown>, {
      disposed: false,
      sessionStartInFlight: null,
      socketReachable: true,
      snapshot: { workspaces: [{}], panes: [{}] },
      vaultOps: { getVaultBasePath: () => "/v" },
      app: { vault: { getName: () => "v" } },
      ensureBridgeReady: async () => undefined,
      waitForPaneShellReady: async () => undefined,
      buildAgentSpawnArgs: () => [],
      getBridgeEnv: () => ({}),
      refreshAll: async () => undefined,
      getActiveSessionName: () => session,
      socket: {
        getSocketPath: () => "/sock",
        splitPane: async () => ({ pane_id: "w1:p2" }),
        startAgent: async () => {
          session = "elsewhere"; // the member switched sessions while the agent started
          return agent({ agent_status: "idle", interactive_ready: true });
        },
        listAgents: async () => [],
        promptAgent: async (_t: string, text: string) => void prompts.push(text),
      },
    });
    const start = () => c.splitAndStartAgent({ agentName: "a", agentKind: "claude", direction: "right", initialPrompt: "Hello." });
    await assert.rejects(start(), /session changed meanwhile, so the initial prompt was not sent/);
    assert.deepEqual(prompts, []);
    // The same start without a switch sends it.
    (c as unknown as { socket: { startAgent: () => Promise<AgentInfo> } }).socket.startAgent = async () =>
      agent({ agent_status: "idle", interactive_ready: true });
    session = "vault";
    await start();
    assert.deepEqual(prompts, ["Hello."]);
  });
});

describe("Windows: Herdr commands and the session server open no console window", () => {
  it("passes windowsHide to every Herdr command and to the detached server", async () => {
    // The bundle calls execFile and spawn through the module object, so replacing them here
    // records the options the client passes. Nothing is started.
    const cp = process.getBuiltinModule("node:child_process") as Record<string, unknown>;
    const realExecFile = cp.execFile;
    const realSpawn = cp.spawn;
    const execOptions: Array<Record<string, unknown>> = [];
    const spawnOptions: Array<Record<string, unknown>> = [];
    let serverUp = false;
    cp.execFile = (_bin: string, _args: string[], options: Record<string, unknown>, done: (e: null, out: string, err: string) => void) => {
      execOptions.push(options);
      done(null, serverUp ? JSON.stringify({ server: { running: true, socket: "/fake/herdr.sock" } }) : "", "");
    };
    cp.spawn = (_bin: string, _args: string[], options: Record<string, unknown>) => {
      spawnOptions.push(options);
      serverUp = true;
      return { unref: () => undefined };
    };
    try {
      const cli = new HerdrCliClient(process.execPath);
      await cli.exec(["status", "--json"]);
      await cli.ensureHeadlessServer({ sessionName: "vault-x", cwd: os.tmpdir(), bridgeEnv: {} });
    } finally {
      cp.execFile = realExecFile;
      cp.spawn = realSpawn;
    }
    assert.ok(execOptions.length >= 2);
    assert.ok(execOptions.every((o) => o.windowsHide === true));
    assert.equal(spawnOptions.length, 1);
    assert.equal(spawnOptions[0].detached, true);
    assert.equal(spawnOptions[0].windowsHide, true);
  });
});

describe("Windows terminal: only an absolute .exe is started, through a job, with a bounded size (security review)", () => {
  const files = new Set(["C:\\Tools\\herdr.exe", "C:\\Program Files\\Herdr\\herdr.exe", "C:\\npm\\claude.cmd", "\\\\srv\\share\\herdr.exe"]);
  const isFile = (p: string) => files.has(p);

  it("resolves a bare name to an absolute .exe in a fully qualified PATH folder, never in '.' or a relative folder", () => {
    assert.deepEqual(resolveConPtyApplication("herdr", ".;bin;C:\\Tools", isFile), { ok: true, application: "C:\\Tools\\herdr.exe" });
    assert.deepEqual(resolveConPtyApplication("herdr", '"C:\\Program Files\\Herdr"', isFile), {
      ok: true,
      application: "C:\\Program Files\\Herdr\\herdr.exe",
    });
    const planted = resolveConPtyApplication("herdr", ".;bin", (p) => p.endsWith("herdr.exe"));
    assert.equal(planted.ok, false, "a herdr.exe reachable only through '.' or a relative folder is never chosen");
  });

  it("takes an absolute .exe (drive or UNC) as it is, and adds .exe to an absolute path without one", () => {
    assert.deepEqual(resolveConPtyApplication("C:\\Tools\\herdr.exe", "", isFile), { ok: true, application: "C:\\Tools\\herdr.exe" });
    assert.deepEqual(resolveConPtyApplication("C:\\Tools\\herdr", "", isFile), { ok: true, application: "C:\\Tools\\herdr.exe" });
    assert.deepEqual(resolveConPtyApplication("\\\\srv\\share\\herdr.exe", "", isFile), { ok: true, application: "\\\\srv\\share\\herdr.exe" });
    assert.match((resolveConPtyApplication("C:\\Nope\\herdr.exe", "", isFile) as { reason: string }).reason, /was not found/);
  });

  it("refuses .cmd, .bat and .com files, relative paths and a name not on PATH", () => {
    for (const cmd of ["C:\\npm\\claude.cmd", "claude.cmd", "run.bat", "C:\\x\\tool.com"]) {
      assert.match((resolveConPtyApplication(cmd, "C:\\npm", isFile) as { reason: string }).reason, /is not a \.exe program/, cmd);
    }
    for (const cmd of [".\\herdr.exe", "bin\\herdr", "C:herdr.exe", "\\herdr.exe"]) {
      assert.match((resolveConPtyApplication(cmd, "C:\\Tools", isFile) as { reason: string }).reason, /is not a full path/, cmd);
    }
    assert.match((resolveConPtyApplication("claude", "C:\\npm", isFile) as { reason: string }).reason, /'claude\.exe' was not found in a folder on PATH/);
  });

  it("starts nothing for a refused program on Windows and says why in the terminal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "conpty-refuse-"));
    const ps = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    fs.mkdirSync(path.dirname(ps), { recursive: true });
    fs.writeFileSync(ps, "");
    const nodeOs = process.getBuiltinModule("node:os") as { release: () => string };
    const realRelease = nodeOs.release;
    nodeOs.release = () => "10.0.22631";
    try {
      await withEnv({ SystemRoot: root, PATH: ".", Path: undefined }, () =>
        asPlatform("win32", async () => {
          for (const command of ["herdr.cmd", "herdr"]) {
            const seen: string[] = [];
            let exit: number | null | undefined;
            const pty = new PtySession({
              command,
              args: ["--session", "a&b"],
              cwd: root,
              cols: 80,
              rows: 24,
              onData: (d) => void seen.push(d),
              onExit: (code) => void (exit = code),
            });
            await new Promise((r) => setTimeout(r, 10));
            assert.equal((pty as unknown as { proc: unknown }).proc, null, `${command}: no process was started`);
            assert.equal(exit, 1, command);
            assert.match(seen.join(""), /\[Could not start the terminal: /, command);
            pty.dispose();
          }
        })
      );
    } finally {
      nodeOs.release = realRelease;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("caps a resize at 1000 columns and rows, and ignores a size that is not a number", () => {
    const writes: string[] = [];
    const pty = Object.create(PtySession.prototype) as PtySession;
    Object.assign(pty as unknown as Record<string, unknown>, {
      cols: 80,
      rows: 24,
      disposed: false,
      ctrlStream: { destroyed: false, write: (s: string) => void writes.push(s) },
    });
    pty.resize(50000, 99999999);
    pty.resize(Number.NaN, 30);
    assert.deepEqual(
      writes.map((w) => JSON.parse(w)),
      [
        { type: "resize", cols: MAX_TERMINAL_CELLS, rows: MAX_TERMINAL_CELLS },
        { type: "resize", cols: 10, rows: 30 },
      ]
    );
    assert.equal(MAX_TERMINAL_CELLS, 1000);
  });

  it("the driver starts the checked .exe by name with no search, suspended inside a kill-on-close job", () => {
    const csSrc = fs.readFileSync("src/terminal/drivers/conpty-bridge.cs", "utf8");
    const hostSrc = fs.readFileSync("src/terminal/pty-host.ts", "utf8");
    assert.match(csSrc, /CreateProcessW\(application, new StringBuilder\(commandLine\)/);
    assert.match(csSrc, /0x00080000 \| 0x00000004/, "CREATE_SUSPENDED until the child is in the job");
    assert.match(csSrc, /LimitFlags = 0x00002000 \| 0x00001000;/, "kill on job close, children of the child break away");
    assert.match(csSrc, /AssignProcessToJobObject\(job, process\.hProcess\);\s*ResumeThread\(process\.hThread\);/);
    assert.match(csSrc, /\\\\d\{1,5\}\)\(\?!\\\\d\)/, "at most five digits reach int.Parse");
    assert.match(hostSrc, /HERDR_OBS_CONPTY_APP: resolved\.application/);
    assert.match(hostSrc, /Run\(\$\{this\.cols\},\$\{this\.rows\},\$a,\$c\)/);
  });
});
