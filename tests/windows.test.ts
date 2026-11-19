import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { migrateSettings, type AgentInfo } from "../src/domain/types";
import { buildHostNormalizedEnv, resolveExecutableOnNormalizedPath } from "../src/herdr/cli-client";
import { herdrConnectPath, HerdrSocketClient } from "../src/herdr/socket-client";
import { HerdrCoordinator } from "../src/services/herdr-coordinator";
import { findWindowsPowerShell, quoteWindowsArg } from "../src/terminal/pty-host";

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
  function coordinatorWith(listed: () => AgentInfo[]) {
    const c = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
    Object.assign(c as unknown as Record<string, unknown>, { disposed: false, socket: { listAgents: async () => listed() } });
    return c as unknown as { waitWhileBlocked: (a: AgentInfo) => Promise<boolean> };
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
});
