import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import type { App } from "obsidian";
import {
  buildBridgeEnvForPanes,
  computeRuntimePaths,
  provisionRuntimeKit,
  readExistingBridgeToken,
} from "../src/bridge/runtime-kit";
import { VaultBridgeServer } from "../src/bridge/vault-bridge-server";
import { VaultOpsService } from "../src/bridge/vault-ops";
import { buildOfflinePreviewSnapshot } from "../src/domain/demo-fixture";
import { OscStreamObserver, parseOsc7501, parseOsc7Path } from "../src/domain/osc-parser";
import {
  guardVaultRelativePath,
  resolveTerminalPathInsideVault,
  VaultPathGuardError,
} from "../src/domain/path-guard";
import { deriveVaultSessionSlug, quoteShellPathForPlatform } from "../src/domain/shell-quote";
import { migrateSettings, type VaultPermissionMode } from "../src/domain/types";
import { buildHostNormalizedEnv, HerdrCliClient } from "../src/herdr/cli-client";
import { HerdrSocketClient } from "../src/herdr/socket-client";
import { parseObsidianUriTarget } from "../src/terminal/link-provider";
import { PtySession } from "../src/terminal/pty-host";
import { resolveTerminalFontFamily } from "../src/terminal/theme-palette";
import { createMockObsidianApp } from "./obsidian-mock";
import "./ui-control.test";

const execFileAsync = promisify(execFile);

if (typeof globalThis.window === "undefined") {
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
}

describe("Domain: OSC stream observer, path guard, shell quoting, and settings migration", () => {
  it("parses OSC 0/2 titles, OSC 7 file URIs, and OSC 7501 program status across chunk splits", () => {
    const titles: string[] = [];
    const cwds: string[] = [];
    const statuses: Array<{ state: string; progress: number | null; message: string | null }> = [];

    const obs = new OscStreamObserver({
      onTitle: (t) => titles.push(t),
      onCwd: (c) => cwds.push(c),
      onProgramStatus: (s) =>
        statuses.push({ state: s.state, progress: s.progress, message: s.message }),
    });

    obs.feed("hello \x1b]2;Claude ");
    obs.feed("Code - Vault\x07 world ");
    obs.feed("\x1b]7;file://aurora/var/home/user/My%20Vault/Notes\x1b\\");
    obs.feed('\x1b]7501;{"state":"working","progress":45,"message":"Indexing backlinks"}\x07');
    obs.feed("\x1b]7501;state=waiting;message=Approve%20rename\x1b\\");
    obs.feed("\x1b]7501;done\x07");

    assert.deepEqual(titles, ["Claude Code - Vault"]);
    assert.deepEqual(cwds, ["/var/home/user/My Vault/Notes"]);
    assert.equal(statuses.length, 3);
    assert.equal(statuses[0].state, "working");
    assert.equal(statuses[0].progress, 45);
    assert.equal(statuses[0].message, "Indexing backlinks");
    assert.equal(statuses[1].state, "blocked");
    assert.equal(statuses[1].message, "Approve rename");
    assert.equal(statuses[2].state, "done");

    assert.equal(parseOsc7Path("file://localhost/C:/Vault/Docs"), "C:/Vault/Docs");
    assert.equal(parseOsc7501("invalid-unknown-state"), null);
  });

  it("blocks traversal, NUL bytes, absolute paths, config directories, and .env secrets", () => {
    assert.equal(guardVaultRelativePath("Projects/Roadmap.md"), "Projects/Roadmap.md");
    assert.equal(guardVaultRelativePath("  ./Daily//2026-11-08.md "), "Daily/2026-11-08.md");

    for (const forbidden of [
      "",
      "../secrets.txt",
      "Notes/../../etc/passwd",
      "/etc/passwd",
      "C:/Users/admin/note.md",
      "Note\0.md",
      ".obsidian/workspace.json",
      ".custom-cfg/plugins/herdr/data.json",
      ".git/config",
      ".trash/deleted.md",
      ".env",
      "sub/.env.production",
    ]) {
      assert.throws(
        () =>
          guardVaultRelativePath(forbidden, {
            configDirName: ".custom-cfg",
            isWrite: true,
          }),
        (err: unknown) => err instanceof VaultPathGuardError
      );
    }

    const resolved = resolveTerminalPathInsideVault(
      "docs/spec.md:42:7",
      "/tmp/mock-vault",
      "/tmp/mock-vault"
    );
    assert.deepEqual(resolved, {
      vaultRelPath: "docs/spec.md",
      line: 42,
      column: 7,
    });
    assert.equal(
      resolveTerminalPathInsideVault("../outside.md", "/tmp/mock-vault", "/tmp/mock-vault"),
      null
    );
    assert.equal(
      resolveTerminalPathInsideVault(".git/HEAD", "/tmp/mock-vault", "/tmp/mock-vault"),
      null
    );
  });

  it("quotes shell paths per platform and migrates settings safely", () => {
    assert.equal(
      quoteShellPathForPlatform("Folder/Daniel's Note.md", "linux"),
      `'Folder/Daniel'\\''s Note.md'`
    );
    assert.equal(
      quoteShellPathForPlatform("Folder/Daniel's Note.md", "win32"),
      `'Folder/Daniel''s Note.md'`
    );
    assert.equal(deriveVaultSessionSlug("AI Marketing Hub!"), "vault-ai-marketing-hub");

    const migrated = migrateSettings({
      terminalFontSize: 99,
      terminalScrollback: 10,
      vaultPermissionMode: "invalid-tier",
    });
    assert.equal(migrated.terminalFontSize, 28);
    assert.equal(migrated.terminalScrollback, 500);
    assert.equal(migrated.vaultPermissionMode, "read-write");

    const preview = buildOfflinePreviewSnapshot("Demo Vault");
    assert.equal(preview.agents.length, 3);
    assert.equal(preview.workspaces.length, 2);

    const parsedOpen = parseObsidianUriTarget(
      "obsidian://open?vault=Demo%20Vault&file=Specs%2FAgent%20Plan.md."
    );
    assert.deepEqual(parsedOpen, {
      kind: "open-file",
      file: "Specs/Agent Plan.md",
      cleanedUri: "obsidian://open?vault=Demo%20Vault&file=Specs%2FAgent%20Plan.md",
    });
    const parsedHerdr = parseObsidianUriTarget("obsidian://herdr?view=terminal&session=dev");
    assert.deepEqual(parsedHerdr, {
      kind: "external",
      cleanedUri: "obsidian://herdr?view=terminal&session=dev",
    });
  });
});

describe("Terminal: Live POSIX PtySession with resize over control FD", () => {
  it("spawns a live PTY shell, streams output, updates terminal size via TIOCSWINSZ, and exits cleanly", async () => {
    let collected = "";
    let exitObserved = false;

    const pty = new PtySession({
      command: "/bin/sh",
      args: [],
      cwd: os.tmpdir(),
      cols: 80,
      rows: 24,
      env: { PS1: "$ " },
      onData: (chunk) => {
        collected += chunk;
      },
      onExit: () => {
        exitObserved = true;
      },
    });

    try {
      pty.resize(132, 42);
      await new Promise((r) => setTimeout(r, 120));
      pty.write("echo PTY_HELLO_OK && stty size && exit\n");

      const deadline = Date.now() + 5000;
      while (!exitObserved && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.ok(collected.includes("PTY_HELLO_OK"), `Expected greeting in PTY output: ${collected}`);
      assert.match(collected, /42\s+132/, `Expected resized stty 42 132 in PTY output: ${collected}`);
      assert.equal(exitObserved, true);
    } finally {
      pty.dispose();
    }
  });

  it("produces Canvas-safe terminal font stacks and normalizes Flatpak PATH and SHELL", () => {
    const fontStack = resolveTerminalFontFamily();
    assert.ok(!fontStack.includes("var("), `Canvas font stack must not contain CSS var(): ${fontStack}`);
    assert.ok(!fontStack.includes("??"), `Canvas font stack must strip Obsidian placeholder: ${fontStack}`);
    assert.ok(!fontStack.includes("ui-monospace"), `Canvas font stack must avoid Linux proportional ui-monospace: ${fontStack}`);
    assert.ok(fontStack.endsWith("monospace"));

    if (process.platform !== "win32") {
      const normalized = buildHostNormalizedEnv({
        HOME: os.homedir(),
        PATH: "/usr/bin:/app/bin",
        SHELL: "/bin/sh",
      });
      const localBin = path.join(os.homedir(), ".local", "bin");
      if (fs.existsSync(localBin)) {
        assert.ok(
          (normalized.PATH || "").split(path.delimiter).includes(localBin),
          `Expected ~/.local/bin in normalized PATH: ${normalized.PATH}`
        );
      }
      if (fs.existsSync("/usr/bin/bash") || fs.existsSync("/bin/bash")) {
        assert.notEqual(normalized.SHELL, "/bin/sh");
      }
    }
  });
});

describe("Vault Control Bridge: Authenticated socket, permission tiers, obs-herdr CLI, undo, and stdio MCP", () => {
  it("serves read/write/undo RPCs, blocks unauthorized & restricted calls, and powers obs-herdr CLI + MCP", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "obs-herdr-bridge-test-"));
    const vaultDir = path.join(tmpBase, "vault");
    const runtimeRoot = path.join(tmpBase, "runtime");
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, "Index.md"),
      "# Home\n\nSee [[Roadmap]] for current milestones. #project\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(vaultDir, "Roadmap.md"),
      '---\nstatus: "draft"\n---\n# Roadmap\n\n## Tasks\n- Initial item\n',
      "utf8"
    );
    fs.mkdirSync(path.join(vaultDir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, "node_modules", "pkg", "README.md"),
      "# pkg\n\nMentions Roadmap inside node_modules.\n",
      "utf8"
    );

    let currentMode: VaultPermissionMode = "read-only";
    const mockApp = createMockObsidianApp(vaultDir, "BridgeTestVault");
    const vaultOps = new VaultOpsService({
      app: mockApp as unknown as App,
      getPermissionMode: () => currentMode,
      getAllowHiddenReads: () => false,
    });

    const kit = computeRuntimePaths(vaultDir, runtimeRoot);
    const server = new VaultBridgeServer({
      socketPath: kit.socketPath,
      dispatcher: (method, params, caller) => vaultOps.dispatch(method, params, caller),
    });

    await server.start();
    try {
      if (process.platform !== "win32") {
        const mode = fs.statSync(kit.socketPath).mode & 0o777;
        assert.equal(mode, 0o600, "Bridge socket must have 0600 permissions");
      }

      provisionRuntimeKit({
        kit,
        token: server.getAuthToken(),
        vaultName: "BridgeTestVault",
        vaultPath: vaultDir,
      });

      // 1. Reject invalid token over raw socket
      const unauthResp = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const client = net.createConnection({ path: kit.socketPath });
        let buf = "";
        client.on("connect", () => {
          client.write(
            JSON.stringify({ id: "u1", token: "wrong-token", method: "vault.info", params: {} }) +
              "\n"
          );
        });
        client.on("data", (d) => {
          buf += d.toString("utf8");
          if (buf.includes("\n")) {
            client.destroy();
            resolve(JSON.parse(buf.trim()) as Record<string, unknown>);
          }
        });
        client.on("error", reject);
      });
      assert.equal((unauthResp.error as { code: string }).code, "unauthorized");

      // 2. Enforce read-only tier: vault info works, note create is denied
      const env = {
        ...process.env,
        ...buildBridgeEnvForPanes({
          kit,
          token: server.getAuthToken(),
          vaultName: "BridgeTestVault",
          vaultPath: vaultDir,
        }),
      };

      const infoOut = await execFileAsync(kit.cliScriptPath, ["vault", "info"], { env });
      const infoJson = JSON.parse(infoOut.stdout) as {
        vaultName: string;
        markdownCount: number;
        permissionMode: string;
      };
      assert.equal(infoJson.vaultName, "BridgeTestVault");
      assert.equal(infoJson.markdownCount, 2);
      assert.equal(infoJson.permissionMode, "read-only");

      const listDefaultOut = await execFileAsync(kit.cliScriptPath, ["note", "list"], { env });
      const listDefaultJson = JSON.parse(listDefaultOut.stdout) as {
        count: number;
        files: Array<{ path: string }>;
      };
      assert.equal(listDefaultJson.count, 2);
      assert.equal(
        listDefaultJson.files.some((f) => f.path.startsWith("node_modules/")),
        false
      );

      const searchDefaultOut = await execFileAsync(
        kit.cliScriptPath,
        ["note", "search", "Roadmap"],
        { env }
      );
      const searchDefaultJson = JSON.parse(searchDefaultOut.stdout) as {
        results: Array<{ path: string }>;
      };
      assert.equal(
        searchDefaultJson.results.some((r) => r.path.startsWith("node_modules/")),
        false
      );

      assert.equal(readExistingBridgeToken(kit.connectionFilePath), server.getAuthToken());
      assert.equal(fs.existsSync(kit.mcpConfigFilePath), true);

      // Verify persistent panes survive stale OBSIDIAN_HERDR_BRIDGE_TOKEN by preferring connection.json
      const staleEnv = {
        ...env,
        OBSIDIAN_HERDR_BRIDGE_TOKEN: "0".repeat(64),
      };
      const staleResilientOut = await execFileAsync(kit.cliScriptPath, ["vault", "info"], {
        env: staleEnv,
      });
      assert.equal(
        (JSON.parse(staleResilientOut.stdout) as { vaultName: string }).vaultName,
        "BridgeTestVault"
      );

      await assert.rejects(() =>
        execFileAsync(
          kit.cliScriptPath,
          ["note", "create", "Blocked.md", "--content", "should fail"],
          { env }
        )
      );

      // 3. Switch to read-write tier and test full CLI note lifecycle + link-safe rename + undo
      currentMode = "read-write";

      await execFileAsync(
        kit.cliScriptPath,
        ["note", "create", "Specs/AgentPlan.md", "--content", "# Agent Plan\n\nStep 1\n"],
        { env }
      );
      assert.equal(fs.existsSync(path.join(vaultDir, "Specs/AgentPlan.md")), true);

      await execFileAsync(
        kit.cliScriptPath,
        [
          "note",
          "frontmatter",
          "Roadmap.md",
          "--set",
          '{"status":"active","owner":"herdr"}',
        ],
        { env }
      );
      const readRoadmap = await execFileAsync(kit.cliScriptPath, ["note", "read", "Roadmap.md"], {
        env,
      });
      const readJson = JSON.parse(readRoadmap.stdout) as {
        frontmatter: Record<string, unknown>;
        backlinks: Array<{ sourcePath: string }>;
      };
      assert.equal(readJson.frontmatter.status, "active");
      assert.equal(readJson.frontmatter.owner, "herdr");
      assert.equal(readJson.backlinks[0]?.sourcePath, "Index.md");

      // Link-safe rename Roadmap.md -> Milestones.md updates [[Roadmap]] in Index.md
      await execFileAsync(
        kit.cliScriptPath,
        ["note", "rename", "Roadmap.md", "Milestones.md"],
        { env }
      );
      const updatedIndex = fs.readFileSync(path.join(vaultDir, "Index.md"), "utf8");
      assert.ok(updatedIndex.includes("[[Milestones]]"), `Expected link update: ${updatedIndex}`);

      // Undo rename via VaultOpsService audit log
      const renameAudit = vaultOps
        .getAuditLog()
        .find((e) => e.method === "vault.rename_note" && e.allowed);
      assert.ok(renameAudit, "Expected audit log entry for rename");
      await vaultOps.undoMutation(renameAudit.id);
      assert.equal(fs.existsSync(path.join(vaultDir, "Roadmap.md")), true);

      // Skill self-doc output
      const skillOut = await execFileAsync(kit.cliScriptPath, ["--skill"], { env });
      assert.ok(skillOut.stdout.includes("obs-herdr"));

      // 4. Test obs-herdr mcp JSON-RPC 2.0 stdio server
      const mcpChild = spawn(kit.cliScriptPath, ["mcp"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const mcpResponses: Array<Record<string, unknown>> = [];
      let mcpBuf = "";
      mcpChild.stdout.on("data", (chunk: Buffer) => {
        mcpBuf += chunk.toString("utf8");
        let nl = mcpBuf.indexOf("\n");
        while (nl !== -1) {
          const line = mcpBuf.slice(0, nl).trim();
          mcpBuf = mcpBuf.slice(nl + 1);
          if (line) {
            mcpResponses.push(JSON.parse(line) as Record<string, unknown>);
          }
          nl = mcpBuf.indexOf("\n");
        }
      });

      mcpChild.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n"
      );
      mcpChild.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n"
      );
      mcpChild.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "obsidian_search_notes", arguments: { query: "Initial item" } },
        }) + "\n"
      );
      mcpChild.stdin.end();

      const waitEnd = Date.now() + 5000;
      while (mcpResponses.length < 3 && Date.now() < waitEnd) {
        await new Promise((r) => setTimeout(r, 40));
      }
      mcpChild.kill();

      assert.equal(mcpResponses.length, 3);
      const toolsList = (mcpResponses[1].result as { tools: Array<{ name: string }> }).tools;
      assert.equal(toolsList.length, 24, "Node MCP server should expose all 24 tools");
      assert.ok(toolsList.some((t) => t.name === "obsidian_read_note"));
      assert.ok(toolsList.some((t) => t.name === "obsidian_patch_frontmatter"));
      assert.ok(toolsList.some((t) => t.name === "obsidian_backlinks"));
      assert.ok(toolsList.some((t) => t.name === "obsidian_upsert_canvas_node"));
      const toolCallText = (
        mcpResponses[2].result as { content: Array<{ text: string }> }
      ).content[0].text;
      assert.ok(toolCallText.includes("Roadmap.md"));

      // 5. Verify 1:1 Python fallback parity (obs-herdr-core.py CLI + 16-tool MCP server)
      const corePyPath = path.join(kit.binDir, "obs-herdr-core.py");
      const pyBacklinks = await execFileAsync(
        "python3",
        [corePyPath, "note", "backlinks", "Roadmap.md"],
        { env }
      );
      const pyBacklinksJson = JSON.parse(pyBacklinks.stdout) as {
        count: number;
        backlinks: Array<{ sourcePath: string }>;
      };
      assert.equal(pyBacklinksJson.count, 1);
      assert.equal(pyBacklinksJson.backlinks[0]?.sourcePath, "Index.md");

      await execFileAsync(
        "python3",
        [
          corePyPath,
          "canvas",
          "upsert",
          "Board.canvas",
          "--type",
          "text",
          "--id",
          "py-node-1",
          "--text",
          "Canvas from Python",
        ],
        { env }
      );
      assert.equal(fs.existsSync(path.join(vaultDir, "Board.canvas")), true);

      const pyMcpChild = spawn("python3", [corePyPath, "mcp"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const pyMcpResponses: Array<Record<string, unknown>> = [];
      let pyMcpBuf = "";
      pyMcpChild.stdout.on("data", (chunk: Buffer) => {
        pyMcpBuf += chunk.toString("utf8");
        let nl = pyMcpBuf.indexOf("\n");
        while (nl !== -1) {
          const line = pyMcpBuf.slice(0, nl).trim();
          pyMcpBuf = pyMcpBuf.slice(nl + 1);
          if (line) {
            pyMcpResponses.push(JSON.parse(line) as Record<string, unknown>);
          }
          nl = pyMcpBuf.indexOf("\n");
        }
      });

      pyMcpChild.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} }) + "\n"
      );
      pyMcpChild.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: { name: "obsidian_backlinks", arguments: { path: "Roadmap.md" } },
        }) + "\n"
      );
      pyMcpChild.stdin.end();

      const pyWaitEnd = Date.now() + 5000;
      while (pyMcpResponses.length < 2 && Date.now() < pyWaitEnd) {
        await new Promise((r) => setTimeout(r, 40));
      }
      pyMcpChild.kill();

      assert.equal(pyMcpResponses.length, 2);
      const pyTools = (pyMcpResponses[0].result as { tools: Array<{ name: string }> }).tools;
      assert.equal(pyTools.length, 24, "Python MCP server must expose all 24 tools");
      const pyBacklinkCall = (
        pyMcpResponses[1].result as { content: Array<{ text: string }> }
      ).content[0].text;
      assert.ok(pyBacklinkCall.includes("Index.md"));
    } finally {
      await server.stop();
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

describe("Live Herdr 0.8.2 Daemon Integration (isolated config & session)", () => {
  it("starts isolated headless herdr session, exchanges protocol 20 RPCs, runs obs-herdr inside a live Herdr pane, links obsidian.vault plugin, and stops cleanly", async () => {
    const cliProbe = new HerdrCliClient();
    const binPath = cliProbe.getBinaryPath();
    if (!binPath) {
      // Skip gracefully only on machines without herdr installed
      return;
    }

    // Herdr places its session sockets under XDG_CONFIG_HOME. Unix socket paths are
    // limited to 107 bytes, so keep this root short even when TMPDIR is deep.
    const shortBase = process.platform !== "win32" && fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
    const tmpRoot = fs.mkdtempSync(path.join(shortBase, "ohd-"));
    const isolatedConfigPath = path.join(tmpRoot, "herdr-config.toml");
    const isolatedXdgConfig = path.join(tmpRoot, "xdg-config");
    const vaultDir = path.join(tmpRoot, "vault");
    const runtimeRoot = path.join(tmpRoot, "runtime");
    fs.mkdirSync(isolatedXdgConfig, { recursive: true });
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, "Welcome.md"), "# Live Herdr Vault Test\n", "utf8");
    fs.writeFileSync(isolatedConfigPath, "", "utf8");

    const sessionName = `obs-ci-${process.pid}`;
    const mockApp = createMockObsidianApp(vaultDir, "LiveHerdrVault");
    const vaultOps = new VaultOpsService({
      app: mockApp as unknown as App,
      getPermissionMode: () => "read-write",
      getAllowHiddenReads: () => false,
    });
    const kit = computeRuntimePaths(vaultDir, runtimeRoot);
    const bridgeServer = new VaultBridgeServer({
      socketPath: kit.socketPath,
      dispatcher: (m, p, c) => vaultOps.dispatch(m, p, c),
    });

    await bridgeServer.start();
    provisionRuntimeKit({
      kit,
      token: bridgeServer.getAuthToken(),
      vaultName: "LiveHerdrVault",
      vaultPath: vaultDir,
    });

    const bridgeEnv = buildBridgeEnvForPanes({
      kit,
      token: bridgeServer.getAuthToken(),
      vaultName: "LiveHerdrVault",
      vaultPath: vaultDir,
    });

    const isolatedDaemonEnv = {
      ...bridgeEnv,
      HERDR_CONFIG_PATH: isolatedConfigPath,
      XDG_CONFIG_HOME: isolatedXdgConfig,
    };

    const cli = new HerdrCliClient(binPath);
    cli.setCustomEnv(isolatedDaemonEnv);

    let socketClient: HerdrSocketClient | null = null;
    try {
      const status = await cli.ensureHeadlessServer({
        sessionName,
        cwd: vaultDir,
        bridgeEnv: isolatedDaemonEnv,
      });

      assert.ok(status?.server?.running, "Isolated headless Herdr server should be running");
      assert.ok(status?.server?.socket, "Isolated Herdr server should expose socket path");

      const listedSessions = await cli.listSessions();
      assert.ok(
        listedSessions.some((s) => s.name === sessionName && s.status === "running"),
        "listSessions() must parse long named sessions via --json"
      );

      socketClient = new HerdrSocketClient(status.server.socket);
      const ping = await socketClient.ping();
      assert.ok(ping.protocol >= 20, `Expected Herdr protocol >= 20, got ${ping.protocol}`);

      const eventsReceived: string[] = [];
      socketClient.onEvent((ev) => {
        eventsReceived.push(ev.event);
      });
      socketClient.startSubscription();

      let snap = await socketClient.getSnapshot();
      if (snap.workspaces.length === 0) {
        await socketClient.createWorkspace({
          label: "LiveHerdrVault",
          cwd: vaultDir,
          focus: true,
          env: bridgeEnv,
        });
        snap = await socketClient.getSnapshot();
      }
      assert.ok(snap.workspaces.length >= 1);
      assert.ok(snap.panes.length >= 1);

      // Split a new pane with bridgeEnv injected and run `obs-herdr vault info` inside the Herdr pane!
      const newPane = await socketClient.splitPane({
        targetPaneId: snap.panes[0].pane_id,
        direction: "right",
        cwd: vaultDir,
        env: bridgeEnv,
      });
      assert.ok(newPane.pane_id.length > 0);

      await socketClient.sendPaneText(
        newPane.pane_id,
        "obs-herdr note create FromHerdrPane.md --content 'Created from inside real Herdr pane'\n"
      );

      const waitFileDeadline = Date.now() + 6000;
      while (
        !fs.existsSync(path.join(vaultDir, "FromHerdrPane.md")) &&
        Date.now() < waitFileDeadline
      ) {
        await new Promise((r) => setTimeout(r, 120));
      }

      assert.equal(
        fs.existsSync(path.join(vaultDir, "FromHerdrPane.md")),
        true,
        "Shell inside live Herdr pane created a vault note through obs-herdr over Vault Control Bridge"
      );

      let paneOutput = "";
      const readDeadline = Date.now() + 4000;
      while (Date.now() < readDeadline) {
        paneOutput = await socketClient.readPane(newPane.pane_id, "recent_unwrapped", 40);
        if (paneOutput.includes("FromHerdrPane.md")) {
          break;
        }
        await new Promise((r) => setTimeout(r, 120));
      }
      assert.ok(
        paneOutput.includes("FromHerdrPane.md"),
        `Expected pane transcript to show command or JSON output, got: ${paneOutput}`
      );

      // Link our generated native Herdr plugin manifest (`obsidian.vault`) into the live Herdr daemon
      const linked = await socketClient.linkPlugin(kit.herdrPluginDir, true);
      assert.equal(linked.plugin_id, "obsidian.vault");

      const installed = await socketClient.listPlugins();
      assert.ok(installed.some((p) => p.plugin_id === "obsidian.vault"));

      const unlinked = await socketClient.unlinkPlugin("obsidian.vault");
      assert.equal(unlinked, true);

      // Export & re-apply split layout over protocol 20
      const exportedLayout = await socketClient.exportLayout({
        tabId: snap.tabs[0].tab_id,
      });
      assert.equal(exportedLayout.root.type, "split");

      const appliedLayout = await socketClient.applyLayout({
        root: exportedLayout.root,
        workspaceId: snap.workspaces[0].workspace_id,
        tabLabel: "ClonedLayout",
        focus: false,
      });
      assert.ok(appliedLayout.tab_id.length > 0);

      // Set & clear TUI workspace filter via agent.view.set / agent.view.clear
      await socketClient.setAgentView({
        source: "user:obsidian-herdr",
        label: "CI Workspace Filter",
        filter: {
          op: "eq",
          field: "workspace_id",
          value: snap.workspaces[0].workspace_id,
        },
      });
      await socketClient.clearAgentView("user:obsidian-herdr");

      assert.ok(eventsReceived.length > 0, "Should receive live events.subscribe push notifications");

      // Gracefully stop daemon over protocol 20 server.stop
      await socketClient.stopServer();
    } finally {
      socketClient?.dispose();
      await cli.stopNamedSession(sessionName).catch(() => undefined);
      await bridgeServer.stop();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
