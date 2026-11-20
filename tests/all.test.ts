import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { MarkdownView, type App } from "obsidian";
import {
  AgentCursorOverlay,
  formatCursorDisplayLabel,
  type CursorCodeMirrorLike,
} from "../src/control/agent-cursor";
import type { UiControlService } from "../src/control/ui-control";
import {
  buildBridgeEnvForPanes,
  computeRuntimePaths,
  provisionRuntimeKit,
  readExistingBridgeToken,
} from "../src/bridge/runtime-kit";
import { VaultBridgeServer } from "../src/bridge/vault-bridge-server";
import { BridgeRpcError, VaultOpsService } from "../src/bridge/vault-ops";
import { buildOfflinePreviewSnapshot } from "../src/domain/demo-fixture";
import { OscStreamObserver, parseOsc7501, parseOsc7Path } from "../src/domain/osc-parser";
import {
  guardVaultRelativePath,
  resolveTerminalPathInsideVault,
  VaultPathGuardError,
} from "../src/domain/path-guard";
import { deriveVaultSessionSlug, quoteShellPathForPlatform } from "../src/domain/shell-quote";
import { DEFAULT_SETTINGS, migrateSettings, type VaultPermissionMode } from "../src/domain/types";
import { buildHostNormalizedEnv, HerdrCliClient } from "../src/herdr/cli-client";
import { HerdrSocketClient } from "../src/herdr/socket-client";
import { parseObsidianUriTarget } from "../src/terminal/link-provider";
import { PtySession } from "../src/terminal/pty-host";
import { resolveTerminalFontFamily } from "../src/terminal/theme-palette";
import { createMockObsidianApp } from "./obsidian-mock";
import "./ui-control.test";
import "./windows.test";

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
      uiTypingSpeed: "instant-bad",
      allowUiInProtectedAreas: "yes",
    });
    assert.equal(migrated.terminalFontSize, 28);
    assert.equal(migrated.terminalScrollback, 500);
    assert.equal(migrated.vaultPermissionMode, "read-write");
    assert.equal(migrated.uiTypingSpeed, DEFAULT_SETTINGS.uiTypingSpeed);
    assert.equal(migrated.uiTypingSpeed, "visible");
    assert.equal(migrated.allowUiInProtectedAreas, DEFAULT_SETTINGS.allowUiInProtectedAreas);
    assert.equal(migrated.allowUiInProtectedAreas, false);

    const migratedValid = migrateSettings({
      uiTypingSpeed: "fast",
      allowUiInProtectedAreas: true,
    });
    assert.equal(migratedValid.uiTypingSpeed, "fast");
    assert.equal(migratedValid.allowUiInProtectedAreas, true);

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
      assert.equal(toolsList.length, 26, "Node MCP server should expose all 26 tools");
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
      assert.equal(pyTools.length, 26, "Python MCP server must expose all 26 tools");

      // 6. Verify concurrent multi-agent vault & canvas writes preserve all updates
      await Promise.all([
        vaultOps.dispatch("vault.create_note", { path: "ParallelA.md", content: "A0" }, "herdr:w1:p1"),
        vaultOps.dispatch("vault.create_note", { path: "ParallelB.md", content: "B0" }, "herdr:w1:p2"),
      ]);
      await Promise.all([
        vaultOps.dispatch("vault.update_note", { path: "ParallelA.md", mode: "append", content: "A1" }, "herdr:w1:p1"),
        vaultOps.dispatch("vault.update_note", { path: "ParallelB.md", mode: "append", content: "B1" }, "herdr:w1:p2"),
        vaultOps.dispatch("canvas.upsert_node", { path: "Parallel.canvas", id: "n1", text: "One" }, "herdr:w1:p1"),
        vaultOps.dispatch("canvas.upsert_node", { path: "Parallel.canvas", id: "n2", text: "Two" }, "herdr:w1:p2"),
      ]);
      const canvasRaw = fs.readFileSync(path.join(vaultDir, "Parallel.canvas"), "utf8");
      const canvasParsed = JSON.parse(canvasRaw) as { nodes: Array<{ id: string }> };
      assert.equal(canvasParsed.nodes.length, 2, "Per-path lock must preserve concurrent canvas node upserts");
      const pyBacklinkCall = (
        pyMcpResponses[1].result as { content: Array<{ text: string }> }
      ).content[0].text;
      assert.ok(pyBacklinkCall.includes("Index.md"));
    } finally {
      await server.stop();
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("supports --help across groups/subcommands, derives MCP tool count, and implements ui locate/insert-line/anchor targets in Node and Python", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "obs-herdr-cli-help-test-"));
    const vaultDir = path.join(tmpBase, "vault");
    fs.mkdirSync(vaultDir, { recursive: true });
    const kit = computeRuntimePaths(vaultDir, path.join(tmpBase, "runtime"));

    const runWithStdin = (cmd: string, args: string[], stdinText: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
        child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve({ stdout, stderr });
          else reject(new Error(`Exit ${code}: ${stderr || stdout}`));
        });
        child.stdin.write(stdinText);
        child.stdin.end();
      });

    let scrollCount = 0;
    let useNativeLocate = false;
    let useNativeInsertLine = false;
    let forceLocateDenied = false;
    let stackedMode = false;
    let blankMode = false;
    let openNotesOverride: string[] | null = null;
    const noteLines = [
      "# Mission Board",
      "",
      "## agy2: How agents share one note",
      "- Line one",
      "- Target line to locate",
    ];
    const dispatcher = async (method: string, params: Record<string, unknown>) => {
      if (method === "vault.read_note") {
        const reqPath = String(params.path || "Crew Test/Mission Board.md");
        if (reqPath === "Dup.md") {
          return { path: reqPath, content: "same\nmiddle\nsame" };
        }
        if (reqPath === "Blank.md") {
          return { path: reqPath, content: "\n\n" };
        }
        if (reqPath === "Bottom.md") {
          return { path: reqPath, content: "# Bottom\n- Bottom body" };
        }
        if (reqPath === "A/Shared.md" || reqPath === "B/Shared.md") {
          return { path: reqPath, content: "# Shared\nUnique body line" };
        }
        return { path: reqPath, content: noteLines.join("\n") };
      }
      if (method === "workspace.get_state") {
        if (blankMode) {
          return { activeFile: "Blank.md", openNotes: ["Blank.md"] };
        }
        if (stackedMode) {
          return { activeFile: "Top.md", openNotes: ["Top.md", "Bottom.md"] };
        }
        if (openNotesOverride) {
          return { activeFile: openNotesOverride[0], openNotes: openNotesOverride };
        }
        return {
          activeFile: "Crew Test/Mission Board.md",
          openNotes: ["Crew Test/Mission Board.md", "Crew Test/Crew Chat.md"],
        };
      }
      if (method === "ui.scroll") {
        scrollCount += 1;
        return { dispatched: true, target: params.target, deltaX: params.deltaX, deltaY: params.deltaY };
      }
      if (method === "ui.click" || method === "ui.type" || method === "ui.drag") {
        return { dispatched: true, method, params };
      }
      if (method === "ui.screenshot") {
        return {
          image: { data: Buffer.from("fake-png-bytes").toString("base64"), mimeType: "image/png" },
          width: 120,
          height: 80,
          viewport: { width: 120, height: 80, devicePixelRatio: 1 },
        };
      }
      if (method === "ui.insert_line") {
        if (!useNativeInsertLine) {
          throw new BridgeRpcError("unknown_method", "Unknown Vault Bridge method 'ui.insert_line'.");
        }
        return { inserted: true, via: "ui.insert_line", target: params.target, text: params.text };
      }
      if (method === "ui.batch") {
        return { ok: true, via: "ui.batch", steps: params.steps };
      }
      if (
        method === "ui.wait_for" ||
        method === "vault.list_files" ||
        method === "vault.search" ||
        method === "workspace.open_note" ||
        method === "canvas.upsert_node"
      ) {
        return { ok: true, method, params };
      }
      if (method === "ui.locate") {
        if (forceLocateDenied) {
          throw new BridgeRpcError("permission_denied", "Method 'ui.locate' requires a higher Vault Control Bridge permission tier.");
        }
        if (!useNativeLocate) {
          throw new BridgeRpcError("unknown_method", "Unknown Vault Bridge method 'ui.locate'.");
        }
        return {
          found: true,
          path: params.note ?? params.path,
          note: params.note,
          heading: params.heading,
          after: params.after,
          at: params.at,
          pane: "leaf-native",
          line: params.line ?? 5,
          text: "- Target line to locate",
          point: { x: 1410, y: 412 },
          rect: { x: 1086, y: 400, width: 357, height: 24 },
          selector: ".native",
          scrolled: false,
        };
      }
      if (method === "ui.inspect") {
        const sel = typeof params.selector === "string" ? params.selector : "";
        const txt = typeof params.text === "string" ? params.text : "";
        if (sel === ".view-header-title") {
          if (blankMode) {
            return {
              viewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
              total: 1,
              truncated: false,
              elements: [
                { selector: ".p1 .view-header-title", tag: "div", role: null, label: "", text: "Blank", disabled: false, rect: { x: 1086, y: 80, width: 357, height: 30 } },
              ],
            };
          }
          if (stackedMode) {
            return {
              viewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
              total: 2,
              truncated: false,
              elements: [
                { selector: ".p1 .view-header-title", tag: "div", role: null, label: "", text: "Top", disabled: false, rect: { x: 1086, y: 80, width: 357, height: 30 } },
                { selector: ".p2 .view-header-title", tag: "div", role: null, label: "", text: "Bottom", disabled: false, rect: { x: 1086, y: 520, width: 357, height: 30 } },
              ],
            };
          }
          if (openNotesOverride) {
            return {
              viewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
              total: 2,
              truncated: false,
              elements: [
                { selector: ".p1 .view-header-title", tag: "div", role: null, label: "", text: "Shared", disabled: false, rect: { x: 1086, y: 80, width: 357, height: 30 } },
                { selector: ".p2 .view-header-title", tag: "div", role: null, label: "", text: "Shared", disabled: false, rect: { x: 1519, y: 80, width: 357, height: 30 } },
              ],
            };
          }
          return {
            viewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
            total: 2,
            truncated: false,
            elements: [
              { selector: ".p1 .view-header-title", tag: "div", role: null, label: "", text: "Mission Board", disabled: false, rect: { x: 1086, y: 80, width: 357, height: 30 } },
              { selector: ".p2 .view-header-title", tag: "div", role: null, label: "", text: "Crew Chat", disabled: false, rect: { x: 1519, y: 80, width: 357, height: 30 } },
            ],
          };
        }
        if (sel.includes(".cm-line")) {
          if (blankMode) {
            return {
              viewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
              total: 2,
              truncated: false,
              elements: [
                { selector: ".p1 .cm-line:nth-child(1)", tag: "div", role: null, label: "", text: "", disabled: false, rect: { x: 1086, y: 150, width: 357, height: 24 } },
                { selector: ".p1 .cm-line:nth-child(2)", tag: "div", role: null, label: "", text: "", disabled: false, rect: { x: 1086, y: 174, width: 357, height: 24 } },
              ],
            };
          }
          if (stackedMode) {
            const stackedEls = [
              { selector: ".top .cm-line:nth-child(1)", tag: "div", role: null, label: "", text: "Top body", disabled: false, rect: { x: 1086, y: 150, width: 357, height: 24 } },
              { selector: ".bottom .cm-line:nth-child(2)", tag: "div", role: null, label: "", text: "- Bottom body", disabled: false, rect: { x: 1086, y: 600, width: 357, height: 24 } },
            ];
            const filtered = txt ? stackedEls.filter((e) => e.text.includes(txt)) : stackedEls;
            return { viewport: { width: 1920, height: 1080, devicePixelRatio: 1 }, total: filtered.length, truncated: false, elements: filtered };
          }
          const baseVisible = [
            { selector: ".p1 .cm-line:nth-child(3)", tag: "div", role: null, label: "", text: "agy2: How agents share one note", disabled: false, rect: { x: 1086, y: 260, width: 357, height: 28 } },
            { selector: ".p1 .cm-line:nth-child(4)", tag: "div", role: null, label: "", text: "- Line one", disabled: false, rect: { x: 1086, y: 288, width: 357, height: 24 } },
            { selector: ".p2 .cm-line:nth-child(1)", tag: "div", role: null, label: "", text: "Crew Chat", disabled: false, rect: { x: 1519, y: 154, width: 357, height: 47 } },
          ];
          if (scrollCount > 0 || txt.includes("Target")) {
            baseVisible.push({
              selector: ".p1 .cm-line:nth-child(5)",
              tag: "div",
              role: null,
              label: "",
              text: "- Target line to locate",
              disabled: false,
              rect: { x: 1086, y: 312, width: 357, height: 24 },
            });
          }
          const filtered = txt ? baseVisible.filter((e) => e.text.includes(txt)) : baseVisible;
          return {
            viewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
            total: filtered.length,
            truncated: false,
            elements: filtered,
          };
        }
        return { viewport: { width: 1920, height: 1080, devicePixelRatio: 1 }, total: 0, truncated: false, elements: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    };

    const server = new VaultBridgeServer({
      socketPath: kit.socketPath,
      dispatcher: (method, params) => dispatcher(method, params),
    });
    await server.start();
    try {
      provisionRuntimeKit({ kit, token: server.getAuthToken(), vaultName: "HelpVault", vaultPath: vaultDir });
      const env = {
        ...process.env,
        ...buildBridgeEnvForPanes({ kit, token: server.getAuthToken(), vaultName: "HelpVault", vaultPath: vaultDir }),
      };
      const corePyPath = path.join(kit.binDir, "obs-herdr-core.py");

      for (const [cmd, baseArgs] of [
        [kit.cliScriptPath, []],
        ["python3", [corePyPath]],
      ] as Array<[string, string[]]>) {
        useNativeLocate = false;
        useNativeInsertLine = false;

        const mainHelp = await execFileAsync(cmd, [...baseArgs, "--help"], { env });
        assert.ok(mainHelp.stdout.includes("26 tools"), `${cmd} --help derives 26 tools`);
        assert.ok(mainHelp.stdout.includes("press_key") && mainHelp.stdout.includes("insert_line"), `${cmd} --help includes ui batch schema with insert_line`);
        assert.ok(
          mainHelp.stdout.includes("obs-herdr ui insert-line") &&
            mainHelp.stdout.includes("proof returned by `insert-line`") &&
            mainHelp.stdout.includes("Do not run `ui inspect` or `ui locate` before anchored actions") &&
            mainHelp.stdout.includes("screenshot` only on failure or when asked"),
          `${cmd} --help documents lean multi-agent shared-note recipe`
        );

        const skillOut = await execFileAsync(cmd, [...baseArgs, "--skill"], { env });
        assert.equal(skillOut.stdout, mainHelp.stdout, `${cmd} --skill and --help match`);

        const uiHelp = await execFileAsync(cmd, [...baseArgs, "ui", "--help"], { env });
        assert.ok(uiHelp.stdout.includes("obs-herdr ui locate") && uiHelp.stdout.includes("obs-herdr ui insert-line"), `${cmd} ui --help lists ui locate and ui insert-line`);
        assert.ok(
          uiHelp.stdout.includes("skip `ui inspect` before anchored actions") &&
            uiHelp.stdout.includes("proof returned by `ui insert-line`") &&
            uiHelp.stdout.includes("only on failure or when asked"),
          `${cmd} ui --help documents lean UI recipe`
        );

        const batchHelp = await execFileAsync(cmd, [...baseArgs, "ui", "batch", "--help"], { env });
        assert.ok(batchHelp.stdout.includes('"action":"insert_line"') && batchHelp.stdout.includes('"heading":"agy2: How agents share one note"'), `${cmd} ui batch --help shows worked insert_line + anchor example`);

        const locateHelp = await execFileAsync(cmd, [...baseArgs, "ui", "locate", "--help"], { env });
        assert.ok(
          locateHelp.stdout.includes("--note") && locateHelp.stdout.includes("--heading") && locateHelp.stdout.includes("--after") && locateHelp.stdout.includes("--at"),
          `${cmd} ui locate --help documents anchor flags`
        );

        const insertLineHelp = await execFileAsync(cmd, [...baseArgs, "ui", "insert-line", "--help"], { env });
        assert.ok(
          insertLineHelp.stdout.includes("--note") &&
            insertLineHelp.stdout.includes("--heading") &&
            insertLineHelp.stdout.includes("--stdin") &&
            insertLineHelp.stdout.includes("Returns proof") &&
            insertLineHelp.stdout.includes("no separate read-back"),
          `${cmd} ui insert-line --help documents flags and proof`
        );

        const screenshotHelp = await execFileAsync(cmd, [...baseArgs, "ui", "screenshot", "--help"], { env });
        assert.ok(
          screenshotHelp.stdout.includes("only on failure or when asked"),
          `${cmd} ui screenshot --help documents lean screenshot guidance`
        );

        const inspectHelp = await execFileAsync(cmd, [...baseArgs, "ui", "inspect", "--help"], { env });
        assert.ok(
          inspectHelp.stdout.includes("Do not run before anchored note actions"),
          `${cmd} ui inspect --help warns against running before anchored actions`
        );

        const dragHelp = await execFileAsync(cmd, [...baseArgs, "ui", "drag", "--help"], { env });
        assert.ok(dragHelp.stdout.includes("--from-note") && dragHelp.stdout.includes("--to-note"), `${cmd} ui drag --help documents anchor targets`);

        await assert.rejects(execFileAsync(cmd, [...baseArgs, "ui", "nope", "--help"], { env }), /Unknown obs-herdr command/);

        const inspectOut = await execFileAsync(cmd, [...baseArgs, "ui", "inspect", "--text", "Target line"], { env });
        const inspected = JSON.parse(inspectOut.stdout) as {
          total: number;
          elements: Array<{ text: string; notePath?: string; pane?: string }>;
        };
        assert.equal(inspected.total, 1);
        assert.equal(inspected.elements[0].notePath, "Crew Test/Mission Board.md");
        assert.equal(inspected.elements[0].pane, "pane-1");

        scrollCount = 0;
        const locateByLine = await execFileAsync(cmd, [...baseArgs, "ui", "locate", "Crew Test/Mission Board.md", "--line", "5"], { env });
        const locatedLine = JSON.parse(locateByLine.stdout) as {
          found: boolean;
          path: string;
          pane: string;
          point: { x: number; y: number };
          scrolled: boolean;
        };
        assert.equal(locatedLine.found, true);
        assert.equal(locatedLine.path, "Crew Test/Mission Board.md");
        assert.equal(locatedLine.pane, "pane-1");
        assert.equal(locatedLine.scrolled, true);
        assert.equal(locatedLine.point.x, 1431);
        assert.equal(locatedLine.point.y, 324);

        const locateByHeadingStart = await execFileAsync(
          cmd,
          [...baseArgs, "ui", "locate", "--note", "Crew Test/Mission Board.md", "--heading", "agy2: How agents share one note", "--at", "start"],
          { env }
        );
        const locatedHeading = JSON.parse(locateByHeadingStart.stdout) as { found: boolean; line: number; point: { x: number; y: number } };
        assert.equal(locatedHeading.found, true);
        assert.equal(locatedHeading.line, 3);
        assert.equal(locatedHeading.point.x, 1094);

        const locateByAfter = await execFileAsync(
          cmd,
          [...baseArgs, "ui", "locate", "--note", "Crew Test/Mission Board.md", "--after", "- Line one"],
          { env }
        );
        const locatedAfter = JSON.parse(locateByAfter.stdout) as { found: boolean; line: number; point: { x: number; y: number } };
        assert.equal(locatedAfter.found, true);
        assert.equal(locatedAfter.line, 4);

        const locateByText = await execFileAsync(cmd, [...baseArgs, "ui", "locate", "Crew Test/Mission Board.md", "--text", "Line one"], { env });
        const locatedText = JSON.parse(locateByText.stdout) as { found: boolean; line: number; point: { x: number; y: number } };
        assert.equal(locatedText.found, true);
        assert.equal(locatedText.line, 4);
        assert.equal(locatedText.point.y, 300);

        const clickOut = await execFileAsync(
          cmd,
          [...baseArgs, "ui", "click", "--note", "Crew Test/Mission Board.md", "--heading", "## Findings", "--at", "end"],
          { env }
        );
        const clicked = JSON.parse(clickOut.stdout) as { params: { target: Record<string, unknown> } };
        assert.deepEqual(clicked.params.target, { note: "Crew Test/Mission Board.md", heading: "## Findings", at: "end" });

        const typeTextOut = await execFileAsync(
          cmd,
          [...baseArgs, "ui", "type", "--note", "Crew Test/Mission Board.md", "--after", "- Line one", "--text", "typed text"],
          { env }
        );
        const typedText = JSON.parse(typeTextOut.stdout) as { params: { text: string; target: Record<string, unknown> } };
        assert.equal(typedText.params.text, "typed text");
        assert.deepEqual(typedText.params.target, { note: "Crew Test/Mission Board.md", after: "- Line one" });

        const typeStdinOut = await runWithStdin(
          cmd,
          [...baseArgs, "ui", "type", "--note", "Crew Test/Mission Board.md", "--line", "4", "--at", "start", "--stdin"],
          "stdin text",
          env
        );
        const typedStdin = JSON.parse(typeStdinOut.stdout) as { params: { text: string; target: Record<string, unknown> } };
        assert.equal(typedStdin.params.text, "stdin text");
        assert.deepEqual(typedStdin.params.target, { note: "Crew Test/Mission Board.md", line: 4, at: "start" });

        const scrollOut = await execFileAsync(
          cmd,
          [...baseArgs, "ui", "scroll", "--note", "Crew Test/Mission Board.md", "--line", "5", "--dy", "120"],
          { env }
        );
        const scrolledRes = JSON.parse(scrollOut.stdout) as { target: Record<string, unknown>; deltaY: number };
        assert.deepEqual(scrolledRes.target, { note: "Crew Test/Mission Board.md", line: 5 });
        assert.equal(scrolledRes.deltaY, 120);

        const dragOut = await execFileAsync(
          cmd,
          [...baseArgs, "ui", "drag", "--from-note", "A.md", "--from-line", "2", "--to-note", "B.md", "--to-heading", "## Done", "--to-at", "end"],
          { env }
        );
        const dragged = JSON.parse(dragOut.stdout) as { params: { from: Record<string, unknown>; to: Record<string, unknown> } };
        assert.deepEqual(dragged.params.from, { note: "A.md", line: 2 });
        assert.deepEqual(dragged.params.to, { note: "B.md", heading: "## Done", at: "end" });

        const insertFallbackOut = await execFileAsync(
          cmd,
          [...baseArgs, "ui", "insert-line", "--note", "Crew Test/Mission Board.md", "--heading", "## agy2: How agents share one note", "--at", "end", "--text", "- Added line"],
          { env }
        );
        const insertFallback = JSON.parse(insertFallbackOut.stdout) as { via: string; steps: Array<{ action: string; target: Record<string, unknown>; text: string }> };
        assert.equal(insertFallback.via, "ui.batch");
        assert.deepEqual(insertFallback.steps, [{
          action: "insert_line",
          target: { note: "Crew Test/Mission Board.md", heading: "## agy2: How agents share one note", at: "end" },
          text: "- Added line",
        }]);

        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "locate", "--note", "Dup.md", "--line", "3"], { env }),
          /multiple lines/
        );

        blankMode = true;
        try {
          await assert.rejects(
            execFileAsync(cmd, [...baseArgs, "ui", "locate", "--note", "Blank.md", "--line", "2"], { env }),
            /Could not locate line 2/
          );
        } finally {
          blankMode = false;
        }

        stackedMode = true;
        try {
          const stackedLocate = await execFileAsync(
            cmd,
            [...baseArgs, "ui", "locate", "--note", "Bottom.md", "--line", "2"],
            { env }
          );
          const stackedJson = JSON.parse(stackedLocate.stdout) as { pane: string; point: { y: number } };
          assert.equal(stackedJson.pane, "pane-2");
          assert.equal(stackedJson.point.y, 612);
        } finally {
          stackedMode = false;
        }

        forceLocateDenied = true;
        try {
          await assert.rejects(
            execFileAsync(cmd, [...baseArgs, "ui", "locate", "--note", "Crew Test/Mission Board.md", "--line", "5"], { env }),
            /permission_denied/
          );
        } finally {
          forceLocateDenied = false;
        }

        openNotesOverride = ["A/Shared.md", "B/Shared.md"];
        try {
          await assert.rejects(
            execFileAsync(cmd, [...baseArgs, "ui", "locate", "--note", "B/Shared.md", "--line", "2"], { env }),
            /ambiguous across multiple open notes/
          );
        } finally {
          openNotesOverride = null;
        }

        useNativeLocate = true;
        useNativeInsertLine = true;
        const nativeOut = await execFileAsync(
          cmd,
          [...baseArgs, "ui", "locate", "--note", "Crew Test/Mission Board.md", "--line", "5", "--at", "start"],
          { env }
        );
        const nativeJson = JSON.parse(nativeOut.stdout) as { pane: string; point: { x: number; y: number }; at: string };
        assert.equal(nativeJson.pane, "leaf-native");
        assert.equal(nativeJson.point.x, 1410);
        assert.equal(nativeJson.at, "start");

        const nativeInsertOut = await runWithStdin(
          cmd,
          [...baseArgs, "ui", "insert-line", "--note", "Crew Test/Mission Board.md", "--after", "- Line one", "--at", "end", "--stdin"],
          "- Native stdin line",
          env
        );
        const nativeInsert = JSON.parse(nativeInsertOut.stdout) as { via: string; target: Record<string, unknown>; text: string };
        assert.equal(nativeInsert.via, "ui.insert_line");
        assert.deepEqual(nativeInsert.target, { note: "Crew Test/Mission Board.md", after: "- Line one", at: "end" });
        assert.equal(nativeInsert.text, "- Native stdin line");

        // Round 4 CLI parity: --output alias works and unknown/incomplete ui flags fail cleanly
        const aliasPath = path.join(tmpBase, `shot-${path.basename(cmd)}-1.png`);
        const aliasEqPath = path.join(tmpBase, `shot-${path.basename(cmd)}-2.png`);
        const aliasRes = await execFileAsync(cmd, [...baseArgs, "ui", "screenshot", "--output", aliasPath], { env });
        const aliasJson = JSON.parse(aliasRes.stdout) as { path: string };
        assert.equal(aliasJson.path, path.resolve(aliasPath));
        assert.equal(fs.readFileSync(aliasPath, "utf8"), "fake-png-bytes");

        const aliasEqRes = await execFileAsync(cmd, [...baseArgs, "ui", "screenshot", `--output=${aliasEqPath}`], { env });
        const aliasEqJson = JSON.parse(aliasEqRes.stdout) as { path: string };
        assert.equal(aliasEqJson.path, path.resolve(aliasEqPath));
        assert.equal(fs.readFileSync(aliasEqPath, "utf8"), "fake-png-bytes");

        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "screenshot", "--bogus", "val"], { env }),
          /Unknown flag '--bogus'/
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "screenshot", "--output"], { env }),
          /Missing value for flag '--output'/
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "screenshot", "-o", aliasPath], { env }),
          /Unknown flag '-o'/
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "screenshot", "--out", aliasPath, "--output", aliasEqPath], { env }),
          /Conflicting values/
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "inspect", "--bogus", "1"], { env }),
          /Unknown flag '--bogus'/
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "locate", "--note", "Crew Test/Mission Board.md", "--line", "1", "--bogus", "1"], { env }),
          /Unknown flag '--bogus'/
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "click", "--x", "10", "--y", "20", "--bogus", "1"], { env }),
          /Unknown flag '--bogus'/
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "insert-line", "--note", "Crew Test/Mission Board.md", "--heading", "h", "--text", "t", "--bogus", "1"], { env }),
          /Unknown flag '--bogus'/
        );

        // Round 6 P2-4: Node & Python numeric flag validation parity
        useNativeLocate = true;
        for (const badLine of ["0", "01", "+1", "1.0", "1e2", "0x1", "-1", "abc", ""]) {
          await assert.rejects(
            execFileAsync(cmd, [...baseArgs, "ui", "locate", "--note", "Crew Test/Mission Board.md", "--line", badLine], { env }),
            /--line must be a positive integer\./,
            `${cmd} ui locate should reject noncanonical --line=${JSON.stringify(badLine)}`
          );
        }
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "drag", "--from-note", "Crew Test/Mission Board.md", "--from-line", "01", "--to-selector", ".cm-content"], { env }),
          /--from-line must be a positive integer\./
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "drag", "--from-selector", ".cm-content", "--to-note", "Crew Test/Mission Board.md", "--to-line", "1.0"], { env }),
          /--to-line must be a positive integer\./
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "inspect", "--limit", "01"], { env }),
          /--limit must be a positive integer\./
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "click", "--x", "10", "--y", "20", "--count", "0"], { env }),
          /--count must be a positive integer\./
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "drag", "--from-x", "10", "--from-y", "20", "--to-x", "30", "--to-y", "40", "--steps", "01"], { env }),
          /--steps must be a positive integer\./
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "screenshot", "--max-width", "1e2"], { env }),
          /--max-width must be a positive integer\./
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "wait", "Target", "--timeout", "-1"], { env }),
          /--timeout must be a non-negative integer\./
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "wait", "Target", "--timeout", "01"], { env }),
          /--timeout must be a non-negative integer\./
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "scroll", "--x", "abc", "--y", "10"], { env }),
          /--x must be a finite number\./
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "scroll", "--x", "10", "--y", "10", "--dy", "NaN"], { env }),
          /--dy must be a finite number\./
        );
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "workspace", "open", "Crew Test/Mission Board.md", "--line", "01"], { env }),
          /--line must be a positive integer\./
        );

        // Canonical forms succeed identically in Node and Python
        const waitZero = JSON.parse((await execFileAsync(cmd, [...baseArgs, "ui", "wait", "Target", "--timeout", "0"], { env })).stdout) as { params: { timeoutMs: number } };
        assert.equal(waitZero.params.timeoutMs, 0);
        const scrollNeg = JSON.parse((await execFileAsync(cmd, [...baseArgs, "ui", "scroll", "--x", "10.5", "--y", "20", "--dx", "-2.5", "--dy", "120"], { env })).stdout) as { target: { x: number; y: number }; deltaX: number; deltaY: number };
        assert.deepEqual(scrollNeg.target, { x: 10.5, y: 20 });
        assert.equal(scrollNeg.deltaX, -2.5);
        assert.equal(scrollNeg.deltaY, 120);
        const canonicalSteps = JSON.parse((await execFileAsync(cmd, [...baseArgs, "ui", "drag", "--from-note", "Crew Test/Mission Board.md", "--from-line", "5", "--to-selector", ".cm-content", "--steps", "4"], { env })).stdout) as { params: { from: { note: string; line: number }; steps: number } };
        assert.equal(canonicalSteps.params.from.line, 5);
        assert.equal(canonicalSteps.params.steps, 4);

        // Round 6 P2-5: help/skill text uses real insert-line proof field names (path, pane, line, text, heading) and documents protected areas + typing speed
        const skillText = (await execFileAsync(cmd, [...baseArgs, "--skill"], { env })).stdout;
        assert.ok(!skillText.includes("returns proof (text, line, heading, notePath)"), `${cmd} --skill must not cite stale notePath proof field`);
        assert.ok(skillText.includes("returns proof (path, pane, line, text, heading, durationMs)"), `${cmd} --skill must cite real insert-line proof fields`);
        assert.ok(skillText.includes("allowUiInProtectedAreas") && skillText.includes("uiTypingSpeed"), `${cmd} --skill must mention protected-area and typing-speed settings`);
        const insertLineHelpText = (await execFileAsync(cmd, [...baseArgs, "ui", "insert-line", "--help"], { env })).stdout;
        assert.ok(insertLineHelpText.includes("path, pane, line, text, heading, durationMs"), `${cmd} ui insert-line --help must cite exact proof fields`);
      }

      const readme = fs.readFileSync(path.resolve("README.md"), "utf8");
      assert.ok(readme.includes("obs-herdr mcp   # stdio MCP server, 26 tools"), "README.md must list 26 MCP tools");
      assert.ok(!readme.includes("24 tools"), "README.md must not contain stale 24 tools count");
      assert.ok(readme.includes("allowUiInProtectedAreas") || readme.includes("protected areas"), "README.md must document protected-area limits");
      assert.ok(readme.includes("uiTypingSpeed") || readme.includes("Visible") && readme.includes("Fast"), "README.md must document typing speed setting");
      assert.ok(readme.includes("insert-line") && readme.includes("path") && readme.includes("pane") && readme.includes("heading"), "README.md must document insert-line proof fields");
    } finally {
      await server.stop();
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("serves fresh live-editor vault.read_note buffers and enforces ui.locate/ui.insert_line/waitFor tiers and caller labels", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "obs-herdr-freshness-routing-"));
    const vaultDir = path.join(tmpBase, "vault");
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, "Shared.md"), "disk copy α", "utf8");
    fs.writeFileSync(path.join(vaultDir, "DiskOnly.md"), "only on disk β", "utf8");

    const mockApp = createMockObsidianApp(vaultDir, "FreshVault");
    const sharedFile = mockApp.vault.getAbstractFileByPath("Shared.md");
    const diskOnlyFile = mockApp.vault.getAbstractFileByPath("DiskOnly.md");

    const activeSourceView = Object.assign(new MarkdownView(), {
      file: sharedFile,
      getMode: () => "source",
      editor: {
        ...new MarkdownView().editor,
        getValue: () => "active split edit γ",
      },
    });
    const staleSplitView = Object.assign(new MarkdownView(), {
      file: sharedFile,
      getMode: () => "source",
      editor: {
        ...new MarkdownView().editor,
        getValue: () => "older split buffer",
      },
    });
    const previewOnlyView = Object.assign(new MarkdownView(), {
      file: diskOnlyFile,
      getMode: () => "preview",
      editor: {
        ...new MarkdownView().editor,
        getValue: () => "ignored preview buffer",
      },
    });

    (mockApp.workspace as unknown as {
      getActiveViewOfType: () => MarkdownView | null;
      iterateAllLeaves: (cb: (leaf: { view: unknown }) => void) => void;
    }).getActiveViewOfType = () => activeSourceView;
    (mockApp.workspace as unknown as {
      iterateAllLeaves: (cb: (leaf: { view: unknown }) => void) => void;
    }).iterateAllLeaves = (cb) => {
      cb({ view: staleSplitView });
      cb({ view: activeSourceView });
      cb({ view: previewOnlyView });
    };

    const recordedCalls: Array<{ method: string; caller?: string; params: Record<string, unknown> }> = [];
    const pointCalls: Array<{ caller: string; target: Record<string, unknown>; label: string }> = [];
    const uiStub = {
      isAvailable: () => true,
      locate: async (params: Record<string, unknown>, caller?: string) => {
        recordedCalls.push({ method: "ui.locate", caller, params });
        return { found: true, caller };
      },
      insertLine: async (params: Record<string, unknown>, caller?: string) => {
        recordedCalls.push({ method: "ui.insert_line", caller, params });
        return { inserted: true, caller };
      },
      waitFor: async (params: Record<string, unknown>, caller?: string) => {
        recordedCalls.push({ method: "ui.wait_for", caller, params });
        return { matched: true, caller };
      },
      pointAtResult: async (caller: string, target: Record<string, unknown>, label: string) => {
        pointCalls.push({ caller, target, label });
        return { shown: true, label };
      },
    };

    let mode: VaultPermissionMode = "read-only";
    let allowUiControl = true;
    const vaultOps = new VaultOpsService({
      app: mockApp as unknown as App,
      getPermissionMode: () => mode,
      getAllowHiddenReads: () => false,
      uiControl: uiStub as unknown as UiControlService,
      getAllowUiControl: () => allowUiControl,
    });
    const kit = computeRuntimePaths(vaultDir, path.join(tmpBase, "runtime"));
    const server = new VaultBridgeServer({
      socketPath: kit.socketPath,
      dispatcher: (method, params, caller) => vaultOps.dispatch(method, params, caller),
    });
    await server.start();

    try {
      provisionRuntimeKit({
        kit,
        token: server.getAuthToken(),
        vaultName: "FreshVault",
        vaultPath: vaultDir,
      });
      const env = {
        ...process.env,
        ...buildBridgeEnvForPanes({
          kit,
          token: server.getAuthToken(),
          vaultName: "FreshVault",
          vaultPath: vaultDir,
        }),
        HERDR_PANE_ID: "pane-cli",
      };
      const corePyPath = path.join(kit.binDir, "obs-herdr-core.py");

      const liveRead = (await vaultOps.dispatch("vault.read_note", { path: "Shared.md" }, "agy2")) as {
        content: string;
        size: number;
        source: string;
        conflictingBuffers: boolean;
        metadataSource: string;
      };
      assert.equal(liveRead.content, "active split edit γ");
      assert.equal(liveRead.source, "editor");
      assert.equal(liveRead.conflictingBuffers, true);
      assert.equal(liveRead.metadataSource, "cache");
      assert.equal(liveRead.size, Buffer.byteLength("active split edit γ", "utf8"));

      const previewFallback = (await vaultOps.dispatch("vault.read_note", { path: "DiskOnly.md" }, "agy2")) as {
        content: string;
        source: string;
        conflictingBuffers: boolean;
      };
      assert.equal(previewFallback.content, "only on disk β");
      assert.equal(previewFallback.source, "vault");
      assert.equal(previewFallback.conflictingBuffers, false);

      // Real permission dispatcher + runtime CLI end-to-end (R1-2): ui locate succeeds natively at read-only tier
      for (const [cmd, baseArgs] of [
        [kit.cliScriptPath, []],
        ["python3", [corePyPath]],
      ] as Array<[string, string[]]>) {
        const cliLocate = await execFileAsync(cmd, [...baseArgs, "ui", "locate", "--note", "Shared.md", "--line", "1"], { env });
        const cliLocateJson = JSON.parse(cliLocate.stdout) as { found: boolean; caller: string };
        assert.equal(cliLocateJson.found, true);
        assert.equal(cliLocateJson.caller, "herdr:pane-cli");
      }

      // Disabled UI control must fail honestly without silently entering locate fallback
      allowUiControl = false;
      for (const [cmd, baseArgs] of [
        [kit.cliScriptPath, []],
        ["python3", [corePyPath]],
      ] as Array<[string, string[]]>) {
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "locate", "--note", "Shared.md", "--line", "1"], { env }),
          /ui_control_disabled/
        );
      }
      allowUiControl = true;

      await vaultOps.dispatch("ui.locate", { note: "Shared.md", line: 1 }, "agy2-pane");
      await vaultOps.dispatch("ui.wait_for", { text: "gamma" }, "agy2-wait");

      mode = "read-write";
      await assert.rejects(
        () => vaultOps.dispatch("ui.insert_line", { target: { note: "Shared.md", line: 1 }, text: "x" }, "agy2"),
        /requires a higher Vault Control Bridge permission tier/
      );

      mode = "full";
      await vaultOps.dispatch("ui.insert_line", { target: { note: "Shared.md", line: 1 }, text: "ok" }, "agy2-writer");
      assert.deepEqual(recordedCalls, [
        { method: "ui.locate", caller: "herdr:pane-cli", params: { note: "Shared.md", path: "Shared.md", line: 1 } },
        { method: "ui.locate", caller: "herdr:pane-cli", params: { note: "Shared.md", path: "Shared.md", line: 1 } },
        { method: "ui.locate", caller: "agy2-pane", params: { note: "Shared.md", line: 1 } },
        { method: "ui.wait_for", caller: "agy2-wait", params: { text: "gamma" } },
        { method: "ui.insert_line", caller: "agy2-writer", params: { target: { note: "Shared.md", line: 1 }, text: "ok" } },
      ]);

      await vaultOps.dispatch("workspace.open_note", { path: "Shared.md", pane: "split" }, "orchestrator");
      assert.equal(pointCalls.length, 1);
      assert.equal(pointCalls[0].caller, "orchestrator");
      assert.equal(pointCalls[0].label, "open");
      assert.equal(pointCalls[0].target.notePath, "Shared.md");
      assert.equal(pointCalls[0].target.prefer, "editor");
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

interface MockCursorElement {
  cls: string;
  classes: Set<string>;
  textContent: string;
  style: {
    transform: string;
    props: Record<string, string>;
    setProperty(name: string, val: string): void;
  };
  children: MockCursorElement[];
  parent: MockCursorElement[] | null;
  removed: boolean;
  readonly isConnected: boolean;
  classList: {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    toggle(name: string, force?: boolean): boolean;
    contains(name: string): boolean;
  };
  createDiv(opts?: { cls?: string; text?: string }): MockCursorElement;
  createSpan(opts?: { cls?: string; text?: string }): MockCursorElement;
  appendChild(child: MockCursorElement): MockCursorElement;
  setAttribute(name: string, val: string): void;
  remove(): void;
}

function makeCursorMockEl(opts?: { cls?: string; text?: string }): MockCursorElement {
  const classes = new Set((opts?.cls ?? "").split(/\s+/).filter(Boolean));
  const children: MockCursorElement[] = [];
  const props: Record<string, string> = {};
  const el: MockCursorElement = {
    cls: opts?.cls ?? "",
    classes,
    textContent: opts?.text ?? "",
    style: {
      transform: "",
      props,
      setProperty(name: string, val: string) {
        props[name] = val;
      },
    },
    children,
    parent: null,
    removed: false,
    get isConnected() {
      return !el.removed;
    },
    classList: {
      add(...names: string[]) {
        for (const n of names) {
          classes.add(n);
        }
      },
      remove(...names: string[]) {
        for (const n of names) {
          classes.delete(n);
        }
      },
      toggle(name: string, force?: boolean) {
        const shouldAdd = force !== undefined ? force : !classes.has(name);
        if (shouldAdd) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return shouldAdd;
      },
      contains(name: string) {
        return classes.has(name);
      },
    },
    createDiv(childOpts?: { cls?: string; text?: string }) {
      const child = makeCursorMockEl(childOpts);
      child.parent = children;
      children.push(child);
      return child;
    },
    createSpan(childOpts?: { cls?: string; text?: string }) {
      const child = makeCursorMockEl(childOpts);
      child.parent = children;
      children.push(child);
      return child;
    },
    appendChild(child: MockCursorElement) {
      child.parent = children;
      children.push(child);
      return child;
    },
    setAttribute() {
      // No-op stub for SVG attributes in Node tests
    },
    remove() {
      el.removed = true;
      if (el.parent) {
        const idx = el.parent.indexOf(el);
        if (idx >= 0) {
          el.parent.splice(idx, 1);
        }
      }
    },
  };
  return el;
}

function makeCursorMockWin(reducedMotion = true) {
  const body = makeCursorMockEl({ cls: "body" });
  return {
    body,
    win: {
      innerWidth: 1280,
      innerHeight: 800,
      document: {
        body,
        createElementNS: () => makeCursorMockEl({ cls: "svg" }),
      },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: (cb: (t: number) => void) =>
        globalThis.setTimeout(() => cb(Date.now()), 8) as unknown as number,
      cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id),
      matchMedia: () => ({ matches: reducedMotion }),
    } as unknown as Window,
  };
}

describe("AgentCursorOverlay: Round 3 collaborator presence, honest state, and lifecycle", () => {
  it("keeps parked agent dimmed at its note caret and re-anchors when lines are inserted above", async () => {
    const { win, body } = makeCursorMockWin(true);
    const overlay = new AgentCursorOverlay({ win, idleAfterMs: 30 });

    let docText = "# Title\nLine one here\nLine two here\n";
    let scrollOffset = 0;
    const listeners = new Map<string, Array<() => void>>();
    const scrollDom = {
      addEventListener(type: string, fn: () => void) {
        const arr = listeners.get(type) ?? [];
        arr.push(fn);
        listeners.set(type, arr);
      },
      removeEventListener(type: string, fn: () => void) {
        const arr = listeners.get(type) ?? [];
        listeners.set(
          type,
          arr.filter((item) => item !== fn)
        );
      },
      getBoundingClientRect() {
        return { top: 100, bottom: 320, left: 0, right: 900, width: 900, height: 220 };
      },
    } as unknown as HTMLElement;

    const lineCoordsForPos = (pos: number) => {
      const before = docText.slice(0, pos);
      const lineIndex = before.split("\n").length - 1;
      const top = 120 + lineIndex * 24 - scrollOffset;
      return { left: 260, right: 262, top, bottom: top + 20 };
    };

    const cm: CursorCodeMirrorLike = {
      state: {
        doc: {
          toString: () => docText,
          get length() {
            return docText.length;
          },
        },
      },
      coordsAtPos: lineCoordsForPos,
      scrollDOM: scrollDom,
    };

    try {
      const lineTwoStart = docText.indexOf("Line two here");
      const startCoords = lineCoordsForPos(lineTwoStart);

      overlay.setTyping("herdr:w1:p4#agy2", "agy2 (w1:p4)", startCoords.left, startCoords.top, {
        notePath: "Notes/Plan.md",
        pane: "w1:p4",
        pos: lineTwoStart,
        cm,
      });

      const layer = body.children[0];
      const cursorEl = layer.children[0];
      const pillEl = cursorEl.children[2];
      const labelEl = pillEl.children[0];
      const actionEl = pillEl.children[1];

      assert.equal(labelEl.textContent, "agy2");
      assert.equal(actionEl.textContent, "typing");
      assert.equal(cursorEl.classes.has("is-typing"), true);

      overlay.finishTyping("herdr:w1:p4#agy2");
      assert.equal(actionEl.textContent, "");
      assert.equal(actionEl.classes.has("is-visible"), false);
      assert.equal(cursorEl.classes.has("is-typing"), false);
      assert.equal(cursorEl.classes.has("is-idle"), true);
      assert.equal(cursorEl.style.transform, `translate3d(260px, ${Math.round((startCoords.top + startCoords.bottom) / 2)}px, 0)`);

      // Wait beyond idleAfterMs and verify long-idle parked presence persists across turns
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(overlay.getActiveCount(), 1);
      assert.equal(cursorEl.classes.has("is-idle"), true);

      // Another agent inserts two lines above agy2's caret
      docText = "# Title\nInserted line A\nInserted line B\nLine one here\nLine two here\n";
      overlay.notifyNoteUpdated("Notes/Plan.md");

      const expectedNewPos = docText.indexOf("Line two here");
      const expectedCoords = lineCoordsForPos(expectedNewPos);
      assert.equal(
        cursorEl.style.transform,
        `translate3d(260px, ${Math.round((expectedCoords.top + expectedCoords.bottom) / 2)}px, 0)`,
        "Parked cursor should follow its anchored text line down when lines are inserted above"
      );
      // Re-anchoring must not falsely mark the idle collaborator as typing
      assert.equal(cursorEl.classes.has("is-idle"), true);
      assert.equal(cursorEl.classes.has("is-typing"), false);
      assert.equal(actionEl.textContent, "");

      // Scrolling anchored caret out of view adds is-offscreen, scrolling back removes it
      scrollOffset = 400;
      for (const fn of listeners.get("scroll") ?? []) {
        fn();
      }
      assert.equal(cursorEl.classes.has("is-offscreen"), true);

      scrollOffset = 0;
      for (const fn of listeners.get("scroll") ?? []) {
        fn();
      }
      assert.equal(cursorEl.classes.has("is-offscreen"), false);
    } finally {
      overlay.dispose();
    }
  });

  it("shows honest transient state labels: clicking/key briefly, typing only during insertion, otherwise name only", async () => {
    const { win, body } = makeCursorMockWin(true);
    const overlay = new AgentCursorOverlay({ win, idleAfterMs: 120, hideAfterMs: 5000 });

    try {
      overlay.pulseClick("herdr:w1:p1#agy1", "agy1 (w1:p1)", 100, 140, "click");
      const cursorEl = body.children[0].children[0];
      const pillEl = cursorEl.children[2];
      const actionEl = pillEl.children[1];

      assert.equal(actionEl.textContent, "clicking");
      assert.equal(actionEl.classes.has("is-visible"), true);

      // Key action appears briefly then clears back to name only
      overlay.moveTo("herdr:w1:p1#agy1", "agy1 (w1:p1)", 110, 140, "Enter");
      assert.equal(actionEl.textContent, "Enter");
      assert.equal(actionEl.classes.has("is-visible"), true);

      await new Promise((r) => setTimeout(r, 145));
      assert.equal(actionEl.textContent, "");
      assert.equal(actionEl.classes.has("is-visible"), false);
      assert.equal(cursorEl.classes.has("is-idle"), true);

      // Silent move actions (hover/scroll) leave just the agent name
      overlay.moveTo("herdr:w1:p1#agy1", "agy1 (w1:p1)", 150, 180, "scroll");
      assert.equal(actionEl.textContent, "");
      assert.equal(actionEl.classes.has("is-visible"), false);
      assert.equal(cursorEl.classes.has("is-typing"), false);

      overlay.moveTo("herdr:w1:p1#agy1", "agy1 (w1:p1)", 160, 190, "hover");
      assert.equal(actionEl.textContent, "");
      assert.equal(actionEl.classes.has("is-visible"), false);
    } finally {
      overlay.dispose();
    }
  });

  it("fades out exited agents and closed panes via exitAgent and reconcileLiveCallers", async () => {
    const { win, body } = makeCursorMockWin(false);
    const overlay = new AgentCursorOverlay({ win, idleAfterMs: 1000, hideAfterMs: 10000 });

    try {
      overlay.moveTo("herdr:w1:p4#agy2", "agy2 (w1:p4)", 200, 220);
      overlay.moveTo("herdr:w1:p6#agy1", "agy1 (w1:p6)", 400, 260);
      assert.equal(overlay.getActiveCount(), 2);

      const layer = body.children[0];
      const cursorAgy2 = layer.children[0];
      const cursorAgy1 = layer.children[1];

      // Both are live right now
      overlay.reconcileLiveCallers(["w1:p4", "agy2", "w1:p6", "agy1"]);
      assert.equal(overlay.getActiveCount(), 2);

      // Pane w1:p4 closes / agy2 exits
      overlay.reconcileLiveCallers(["w1:p6", "agy1"]);
      assert.equal(overlay.getActiveCount(), 1);
      assert.equal(cursorAgy2.classes.has("is-exiting"), true);
      assert.equal(cursorAgy1.classes.has("is-exiting"), false);

      // Re-activating the same caller clears any stale fading node without waiting
      overlay.moveTo("herdr:w1:p4#agy2", "agy2 (w1:p4)", 240, 240);
      assert.equal(overlay.getActiveCount(), 2);
      assert.equal(cursorAgy2.removed, true);

      // Explicit exitAgent fades and removes the element after transition delay
      const replacementEl = layer.children.find((child) => !child.removed && child !== cursorAgy1)!;
      overlay.exitAgent("herdr:w1:p4#agy2");
      assert.equal(overlay.getActiveCount(), 1);
      assert.equal(replacementEl.classes.has("is-exiting"), true);
      assert.equal(replacementEl.removed, false);

      await new Promise((r) => setTimeout(r, 275));
      assert.equal(replacementEl.removed, true);
    } finally {
      overlay.dispose();
    }
  });

  it("defines CSS states for typing, exiting, offscreen, and dimmed idle cursors in styles.css", () => {
    const css = fs.readFileSync(path.resolve("styles.css"), "utf8");
    assert.ok(css.includes(".herdr-cursor.is-typing"));
    assert.ok(css.includes(".herdr-cursor.is-exiting"));
    assert.ok(css.includes(".herdr-cursor.is-offscreen"));
    assert.ok(css.includes(".herdr-cursor.is-idle"));
  });

  it("recomputes parked cursor immediately via ResizeObserver and MutationObserver and keeps pill inside pane/above status bar", () => {
    const resizeCallbacks: Array<(entries: Array<{ target: unknown }>) => void> = [];
    const mutationCallbacks: Array<() => void> = [];
    const observedResizeTargets = new Set<unknown>();
    const observedMutationTargets = new Set<unknown>();

    class FakeResizeObserver {
      constructor(cb: (entries: Array<{ target: unknown }>) => void) {
        resizeCallbacks.push(cb);
      }
      observe(target: unknown) {
        observedResizeTargets.add(target);
      }
      unobserve(target: unknown) {
        observedResizeTargets.delete(target);
      }
      disconnect() {
        observedResizeTargets.clear();
      }
    }

    class FakeMutationObserver {
      constructor(cb: () => void) {
        mutationCallbacks.push(cb);
      }
      observe(target: unknown) {
        observedMutationTargets.add(target);
      }
      disconnect() {
        observedMutationTargets.clear();
      }
    }

    const body = makeCursorMockEl({ cls: "body" });
    const statusBar = {
      getBoundingClientRect: () => ({ left: 0, top: 760, right: 1280, bottom: 790, width: 1280, height: 30 }),
    };
    const win = {
      innerWidth: 1280,
      innerHeight: 800,
      document: {
        body,
        createElementNS: () => makeCursorMockEl({ cls: "svg" }),
        querySelector: (sel: string) => (sel === ".status-bar" ? statusBar : null),
      },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: (cb: (t: number) => void) =>
        globalThis.setTimeout(() => cb(Date.now()), 8) as unknown as number,
      cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id),
      matchMedia: () => ({ matches: false }),
      ResizeObserver: FakeResizeObserver,
      MutationObserver: FakeMutationObserver,
    } as unknown as Window;

    const overlay = new AgentCursorOverlay({ win, idleAfterMs: 5000, hideAfterMs: 30000 });
    let docText = "Line A\nLine B anchored\n";
    let paneRight = 820;
    let wrappedExtraPx = 0;

    const scrollDom = {
      isConnected: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getBoundingClientRect: () => ({
        left: 200,
        top: 100,
        right: paneRight,
        bottom: 780,
        width: paneRight - 200,
        height: 680,
      }),
    } as unknown as HTMLElement;

    const contentDom = {
      isConnected: true,
    } as unknown as HTMLElement;

    const coordsForPos = (pos: number) => {
      const before = docText.slice(0, pos);
      const lineIdx = before.split("\n").length - 1;
      const top = 735 + wrappedExtraPx + (lineIdx - 1) * 24;
      const left = Math.min(paneRight - 20, 770);
      return { left, right: left + 2, top, bottom: top + 18 };
    };

    const cm: CursorCodeMirrorLike = {
      scrollDOM: scrollDom,
      contentDOM: contentDom,
      state: {
        doc: {
          toString: () => docText,
          get length() {
            return docText.length;
          },
        },
      },
      coordsAtPos: coordsForPos,
    };

    try {
      const pos = docText.indexOf("Line B anchored");
      const initialCoords = coordsForPos(pos);
      overlay.setTyping("herdr:w1:p4#agy2", "agy2 (w1:p4)", initialCoords.left, initialCoords.top, {
        notePath: "Notes/Plan.md",
        pane: "w1:p4",
        pos,
        cm,
      });
      overlay.finishTyping("herdr:w1:p4#agy2");

      const cursorEl = body.children[0].children[0];
      const pillEl = cursorEl.children[2];

      assert.equal(observedResizeTargets.has(scrollDom), true);
      assert.equal(observedResizeTargets.has(contentDom), true);
      assert.equal(observedMutationTargets.has(contentDom), true);

      // Pill sits near bottom-right corner above .status-bar (top=760): must flip UP and LEFT inside pane
      const pillX1 = Number.parseFloat(pillEl.style.props["--herdr-pill-x"]);
      const pillY1 = Number.parseFloat(pillEl.style.props["--herdr-pill-y"]);
      assert.ok(pillY1 < 0, `Expected pill above pointer near status bar, got ${pillY1}`);
      assert.ok(pillX1 < 0, `Expected pill shifted left inside pane edge, got ${pillX1}`);

      // Sidebar opens -> pane narrows & line wraps down; ResizeObserver snaps transform immediately even with reducedMotion=false
      paneRight = 680;
      wrappedExtraPx = -60;
      for (const cb of resizeCallbacks) {
        cb([{ target: scrollDom }]);
      }
      const afterResizeCoords = coordsForPos(pos);
      const afterResizeMidY = Math.round((afterResizeCoords.top + afterResizeCoords.bottom) / 2);
      assert.equal(cursorEl.style.transform, `translate3d(${afterResizeCoords.left}px, ${afterResizeMidY}px, 0)`);
      assert.equal(cursorEl.classes.has("is-offscreen"), false);

      // CodeMirror DOM mutates with a line inserted above without calling notifyNoteUpdated
      docText = "Inserted top line\nLine A\nLine B anchored\n";
      for (const cb of mutationCallbacks) {
        cb();
      }
      const afterMutCoords = coordsForPos(docText.indexOf("Line B anchored"));
      const afterMutMidY = Math.round((afterMutCoords.top + afterMutCoords.bottom) / 2);
      assert.equal(cursorEl.style.transform, `translate3d(${afterMutCoords.left}px, ${afterMutMidY}px, 0)`);
      assert.equal(cursorEl.classes.has("is-idle"), true);
    } finally {
      overlay.dispose();
    }
  });

  it("binds parked cursors to one note leaf and hides them when closed, collapsed, or switched to another note", () => {
    const resizeCallbacks: Array<(entries: Array<{ target: unknown }>) => void> = [];
    const mutationCallbacks: Array<() => void> = [];
    class FakeResizeObserver {
      constructor(cb: (entries: Array<{ target: unknown }>) => void) {
        resizeCallbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    class FakeMutationObserver {
      constructor(cb: () => void) {
        mutationCallbacks.push(cb);
      }
      observe() {}
      disconnect() {}
    }
    const baseWin = makeCursorMockWin(true);
    const body = baseWin.body;
    const win = Object.assign(baseWin.win as unknown as Record<string, unknown>, {
      ResizeObserver: FakeResizeObserver,
      MutationObserver: FakeMutationObserver,
    }) as unknown as Window;
    const overlay = new AgentCursorOverlay({ win, idleAfterMs: 1000, hideAfterMs: 30000 });

    let viewPath = "Notes/A.md";
    let leafConnected = true;
    let paneWidth = 600;
    const scrollDom = {
      get isConnected() {
        return leafConnected;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getBoundingClientRect: () => ({
        left: 100,
        top: 80,
        right: 100 + paneWidth,
        bottom: 680,
        width: paneWidth,
        height: 600,
      }),
    } as unknown as HTMLElement;

    let docText = "First\nSecond line in A\n";
    const cm: CursorCodeMirrorLike = {
      scrollDOM: scrollDom,
      state: {
        doc: {
          toString: () => docText,
          get length() {
            return docText.length;
          },
        },
      },
      coordsAtPos: (pos: number) => ({ left: 220, right: 222, top: 180 + Math.min(pos, 40), bottom: 200 + Math.min(pos, 40) }),
    };

    try {
      const view = {
        get file() {
          return { path: viewPath };
        },
      };

      overlay.setTyping("herdr:w1:p4#agy2", "agy2 (w1:p4)", 220, 186, {
        notePath: "Notes/A.md",
        pane: "w1:p4",
        leafId: "leaf-1",
        pos: 6,
        cm,
        view,
      });
      overlay.finishTyping("herdr:w1:p4#agy2");

      const cursorEl = body.children[0].children[0];
      assert.equal(cursorEl.classes.has("is-offscreen"), false);

      // Collapsed/background tab (zero box width) must stay hidden, never clear is-offscreen
      paneWidth = 0;
      for (const cb of resizeCallbacks) {
        cb([{ target: scrollDom }]);
      }
      assert.equal(cursorEl.classes.has("is-offscreen"), true);

      // Restored tab becomes visible again via ResizeObserver
      paneWidth = 600;
      for (const cb of resizeCallbacks) {
        cb([{ target: scrollDom }]);
      }
      assert.equal(cursorEl.classes.has("is-offscreen"), false);

      // Virtualized offscreen line returning null from coordsAtPos must hide stale marker
      const origCoordsAtPos = cm.coordsAtPos;
      cm.coordsAtPos = () => null;
      overlay.notifyNoteUpdated("Notes/A.md");
      assert.equal(cursorEl.classes.has("is-offscreen"), true);
      cm.coordsAtPos = origCoordsAtPos;
      for (const cb of resizeCallbacks) {
        cb([{ target: scrollDom }]);
      }
      assert.equal(cursorEl.classes.has("is-offscreen"), false);

      // Leaf switches in-place from Notes/A.md to Notes/B.md: cursor must hide and never redraw in B
      viewPath = "Notes/B.md";
      docText = "Completely different note B\n";
      overlay.notifyNoteUpdated("Notes/A.md");
      assert.equal(cursorEl.classes.has("is-offscreen"), true);
      for (const cb of mutationCallbacks) {
        cb();
      }
      assert.equal(cursorEl.classes.has("is-offscreen"), true);

      // When Notes/A.md leaf closes (isConnected=false), observer detects disconnect and clears cursor
      viewPath = "Notes/A.md";
      leafConnected = false;
      for (const cb of resizeCallbacks) {
        cb([{ target: scrollDom }]);
      }
      assert.equal(overlay.getActiveCount(), 0);
    } finally {
      overlay.dispose();
    }
  });

  it("clears typing immediately and snaps parked caret on finishTyping even with reducedMotion=false (R3-3) and hides when coords are null then recovers (R3-4)", () => {
    const { win, body } = makeCursorMockWin(false);
    const overlay = new AgentCursorOverlay({ win, idleAfterMs: 1500, hideAfterMs: 60000 });

    const scrollDom = {
      isConnected: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getBoundingClientRect: () => ({ left: 50, top: 50, right: 900, bottom: 700, width: 850, height: 650 }),
    } as unknown as HTMLElement;

    let docText = "Hello world\n";
    let coordsReturn: { left: number; right: number; top: number; bottom: number } | null = {
      left: 200,
      right: 202,
      top: 160,
      bottom: 180,
    };
    const cm: CursorCodeMirrorLike = {
      scrollDOM: scrollDom,
      state: {
        doc: {
          toString: () => docText,
          get length() {
            return docText.length;
          },
        },
      },
      coordsAtPos: () => coordsReturn,
    };

    try {
      overlay.setTyping("herdr:w1:p6#agy1", "agy1 (w1:p6)", 200, 160, {
        notePath: "Notes/R3.md",
        pane: "w1:p6",
        pos: 5,
        cm,
      });

      const cursorEl = body.children[0].children[0];
      const actionEl = cursorEl.children[2].children[1];
      assert.equal(actionEl.textContent, "typing");
      assert.equal(cursorEl.classes.has("is-typing"), true);

      docText = "Hello world updated!\n";
      coordsReturn = { left: 264, right: 266, top: 184, bottom: 204 };
      overlay.finishTyping("herdr:w1:p6#agy1", {
        notePath: "Notes/R3.md",
        pane: "w1:p6",
        pos: docText.length - 1,
        cm,
      });

      assert.equal(actionEl.textContent, "");
      assert.equal(actionEl.classes.has("is-visible"), false);
      assert.equal(cursorEl.classes.has("is-typing"), false);
      assert.equal(cursorEl.classes.has("is-idle"), true);
      assert.equal(cursorEl.style.transform, "translate3d(264px, 194px, 0)");

      // R3-4: projection returns null -> marker hides cleanly without clearing anchor, then recovers when coords return
      coordsReturn = null;
      overlay.notifyNoteUpdated("Notes/R3.md");
      assert.equal(cursorEl.classes.has("is-offscreen"), true);

      coordsReturn = { left: 264, right: 266, top: 210, bottom: 230 };
      overlay.notifyNoteUpdated("Notes/R3.md");
      assert.equal(cursorEl.classes.has("is-offscreen"), false);
      assert.equal(cursorEl.style.transform, "translate3d(264px, 220px, 0)");
    } finally {
      overlay.dispose();
    }
  });

  it("shows only agent name when known and falls back to pane id (Round 5 item 3)", () => {
    assert.equal(formatCursorDisplayLabel("herdr:w1:p6", "agy1 (w1:p6)"), "agy1");
    assert.equal(formatCursorDisplayLabel("herdr:w1:p4#agy2", "agy2 (w1:p4)"), "agy2");
    assert.equal(formatCursorDisplayLabel("herdr:w1:p1", "claude (herdr:w1:p1)"), "claude");
    assert.equal(formatCursorDisplayLabel("herdr:w1:p7#agy2", ""), "agy2");
    assert.equal(formatCursorDisplayLabel("herdr:w1:p7#agy2", "herdr:w1:p7#agy2"), "agy2");
    assert.equal(formatCursorDisplayLabel("herdr:w1:p7", "w1:p7"), "w1:p7");
    assert.equal(formatCursorDisplayLabel("herdr:w1:p7", "herdr:w1:p7"), "w1:p7");
    assert.equal(formatCursorDisplayLabel("herdr:w1:p7", ""), "w1:p7");
    assert.equal(formatCursorDisplayLabel("custom", "Agent (beta)"), "Agent (beta)");

    const { win, body } = makeCursorMockWin(true);
    const overlay = new AgentCursorOverlay({ win, idleAfterMs: 1500, hideAfterMs: 60000 });
    try {
      overlay.pulseClick("herdr:w1:p6", "agy1 (w1:p6)", 120, 140, "click");
      overlay.pulseClick("herdr:w1:p9", "w1:p9", 220, 140, "click");
      const layer = body.children[0];
      assert.equal(layer.children[0].children[2].children[0].textContent, "agy1");
      assert.equal(layer.children[1].children[2].children[0].textContent, "w1:p9");
    } finally {
      overlay.dispose();
    }
  });

  it("strips alphanumeric pane ids like w1:pA, manages their lifecycle, and drops unused overlay helpers (Round 6 P2-3)", () => {
    assert.equal(formatCursorDisplayLabel("sol3", "sol3 (w1:pA)"), "sol3");
    assert.equal(formatCursorDisplayLabel("herdr:sol3", "sol3 (w1:pA)"), "sol3");
    assert.equal(formatCursorDisplayLabel("herdr:w1:pA", "w1:pA"), "w1:pA");
    assert.equal(formatCursorDisplayLabel("w1:pA", ""), "w1:pA");
    assert.equal(formatCursorDisplayLabel("custom", "Agent (beta)"), "Agent (beta)");
    assert.equal("setDocumentAnchor" in AgentCursorOverlay.prototype, false);
    assert.equal("reconcileVisibleNotes" in AgentCursorOverlay.prototype, false);

    const { win, body } = makeCursorMockWin(false);
    const overlay = new AgentCursorOverlay({ win, idleAfterMs: 1500, hideAfterMs: 60000 });
    try {
      overlay.pulseClick("w1:pA", "w1:pA", 140, 160, "click");
      const layer = body.children[0];
      assert.equal(layer.children.length, 1);
      assert.equal(layer.children[0].children[2].children[0].textContent, "w1:pA");
      overlay.reconcileLiveCallers([]);
      assert.equal(overlay.getActiveCount(), 0);
      assert.equal(layer.children[0].classes.has("is-exiting"), true);
    } finally {
      overlay.dispose();
    }
  });

  it("places arrow tip rect within 1px of caret midpoint without CSS translate/margin offsets and keeps pill tight", () => {
    const css = fs.readFileSync(path.resolve("styles.css"), "utf8");
    const pointerRuleMatch = /\.herdr-cursor-pointer\s*\{([^}]*)\}/.exec(css);
    assert.ok(pointerRuleMatch, ".herdr-cursor-pointer rule must exist in styles.css");
    const pointerRule = pointerRuleMatch[1];
    assert.equal(/translate\s*\(/i.test(pointerRule), false, ".herdr-cursor-pointer must not use translate()");
    assert.equal(/margin\s*:(?!\s*0(?:px|em|rem)?\s*;)/i.test(pointerRule), false, ".herdr-cursor-pointer must not have non-zero margin");
    assert.ok(/transform-origin\s*:\s*0\s+0/i.test(pointerRule), ".herdr-cursor-pointer must scale from transform-origin 0 0");

    const svgAttrs: Record<string, string> = {};
    const pathAttrs: Record<string, string> = {};
    const baseWin = makeCursorMockWin(true);
    let svgElCreated: ReturnType<typeof makeCursorMockEl> | null = null;
    const win = {
      ...(baseWin.win as unknown as Record<string, unknown>),
      document: {
        body: baseWin.body,
        createElementNS: (_ns: string, tag: string) => {
          const mock = makeCursorMockEl({ cls: tag });
          mock.setAttribute = (k: string, v: string) => {
            if (tag === "svg") svgAttrs[k] = v;
            if (tag === "path") pathAttrs[k] = v;
          };
          if (tag === "svg") {
            svgElCreated = mock;
          }
          return mock;
        },
      },
    } as unknown as Window;

    const overlay = new AgentCursorOverlay({ win, idleAfterMs: 1500, hideAfterMs: 60000 });
    try {
      const targetCaret = { left: 312.51, right: 314.51, top: 200.51, bottom: 224.51 };
      const expectedTargetX = targetCaret.left;
      const expectedTargetY = (targetCaret.top + targetCaret.bottom) / 2;
      const docText = "Focus test line: agent typing.";
      const cm: CursorCodeMirrorLike = {
        state: {
          doc: {
            toString: () => docText,
            get length() {
              return docText.length;
            },
          },
        },
        coordsAtPos: () => targetCaret,
      };

      overlay.setTyping("herdr:w1:pA#sol3", "sol3 (w1:pA)", expectedTargetX, expectedTargetY, {
        notePath: "Notes/Test.md",
        pane: "w1:pA",
        pos: docText.length,
        cm,
      });
      overlay.finishTyping("herdr:w1:pA#sol3");

      const cursorEl = baseWin.body.children[0].children[0];
      assert.ok(svgElCreated, "SVG pointer element should be created");
      const m = /translate3d\(\s*(-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px,\s*0\)/.exec(cursorEl.style.transform);
      assert.ok(m, `Expected translate3d transform, got ${cursorEl.style.transform}`);
      const containerX = Number(m[1]);
      const containerY = Number(m[2]);

      const vbParts = (svgAttrs.viewBox || "").trim().split(/\s+/).map(Number);
      assert.equal(vbParts.length, 4, `Expected valid SVG viewBox, got ${svgAttrs.viewBox}`);
      const [vbMinX, vbMinY, vbW, vbH] = vbParts;
      const svgW = Number(svgAttrs.width || vbW);
      const svgH = Number(svgAttrs.height || vbH);
      const scaleX = svgW / vbW;
      const scaleY = svgH / vbH;

      const pathMove = /^M\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/.exec(pathAttrs.d || "");
      assert.ok(pathMove, `Expected M x y start in pointer path d, got ${pathAttrs.d}`);
      const apexVbX = Number(pathMove[1]);
      const apexVbY = Number(pathMove[2]);

      // Exact rendered hotspot: apex vertex / stroke join center in viewport coordinates (no bounding-box corner subtraction)
      const renderedHotspotX = containerX + (apexVbX - vbMinX) * scaleX;
      const renderedHotspotY = containerY + (apexVbY - vbMinY) * scaleY;

      assert.ok(
        Math.abs(renderedHotspotX - expectedTargetX) < 0.02 && Math.abs(renderedHotspotY - expectedTargetY) < 0.02,
        `Rendered SVG tip hotspot (${renderedHotspotX}, ${renderedHotspotY}) must match fractional caret midpoint (${expectedTargetX}, ${expectedTargetY}) within 0.02px`
      );
      assert.equal(apexVbX, 0, "SVG pointer apex hotspot must sit at viewBox X=0");
      assert.equal(apexVbY, 0, "SVG pointer apex hotspot must sit at viewBox Y=0");

      const pillEl = cursorEl.children[2];
      const pillX = Number.parseFloat(pillEl.style.props["--herdr-pill-x"]);
      const pillY = Number.parseFloat(pillEl.style.props["--herdr-pill-y"]);
      assert.ok(pillX > 0 && pillX <= 12, `Pill X offset (${pillX}) must be tight to lower-right of arrow`);
      assert.ok(pillY > 0 && pillY <= 8, `Pill Y offset (${pillY}) must be tight so it does not cover next line`);
    } finally {
      overlay.dispose();
    }
  });

  it("follows inserted text via CodeMirror transactions during visible typing without focus", () => {
    const { win, body } = makeCursorMockWin(true);
    const overlay = new AgentCursorOverlay({ win, idleAfterMs: 1500, hideAfterMs: 60000 });

    let docText = "Line one\n- inserted: ";
    const userHeadPos = 0; // Terminal/user selection elsewhere; CM never takes focus
    const cm: CursorCodeMirrorLike = {
      state: {
        doc: {
          toString: () => docText,
          get length() {
            return docText.length;
          },
        },
        selection: {
          main: {
            get head() {
              return userHeadPos;
            },
          },
        },
      },
      coordsAtPos: (pos: number) => {
        const before = docText.slice(0, pos);
        const lines = before.split("\n");
        const lineIdx = lines.length - 1;
        const col = lines[lineIdx].length;
        const top = 140 + lineIdx * 24;
        return { left: 100 + col * 8, right: 102 + col * 8, top, bottom: top + 20 };
      },
    };

    try {
      let insertPos = docText.length;
      const chunk1 = "hello";
      docText = docText.slice(0, insertPos) + chunk1 + docText.slice(insertPos);
      const afterChunk1Pos = insertPos + chunk1.length;
      const c1 = cm.coordsAtPos!(afterChunk1Pos)!;
      overlay.setTyping("herdr:w1:pA#sol3", "sol3", c1.left, Math.round((c1.top + c1.bottom!) / 2), {
        notePath: "Notes/Tx.md",
        pane: "w1:pA",
        pos: afterChunk1Pos,
        cm,
      });
      overlay.notifyNoteUpdated("Notes/Tx.md", { from: insertPos, to: insertPos, insertLength: chunk1.length });
      insertPos = afterChunk1Pos;

      const cursorEl = body.children[0].children[0];
      assert.equal(cursorEl.style.transform, `translate3d(${c1.left}px, ${Math.round((c1.top + c1.bottom!) / 2)}px, 0)`);
      assert.equal(userHeadPos, 0);

      const chunk2 = " world";
      docText = docText.slice(0, insertPos) + chunk2 + docText.slice(insertPos);
      overlay.notifyNoteUpdated("Notes/Tx.md", { from: insertPos, to: insertPos, insertLength: chunk2.length });
      insertPos += chunk2.length;

      const c2 = cm.coordsAtPos!(insertPos)!;
      assert.equal(cursorEl.style.transform, `translate3d(${c2.left}px, ${Math.round((c2.top + c2.bottom!) / 2)}px, 0)`);

      overlay.finishTyping("herdr:w1:pA#sol3");
      assert.equal(cursorEl.classes.has("is-idle"), true);
      assert.equal(cursorEl.style.transform, `translate3d(${c2.left}px, ${Math.round((c2.top + c2.bottom!) / 2)}px, 0)`);
    } finally {
      overlay.dispose();
    }
  });

  it("switches to window-clamped screen mode on non-note actions and re-enters doc mode on next note action", () => {
    const { win, body } = makeCursorMockWin(true);
    const overlay = new AgentCursorOverlay({ win, idleAfterMs: 1500, hideAfterMs: 60000 });

    const scrollDom = {
      isConnected: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getBoundingClientRect: () => ({ left: 44, top: 40, right: 900, bottom: 700, width: 856, height: 660 }),
    } as unknown as HTMLElement;
    const mcLeafEl = {
      isConnected: true,
      getBoundingClientRect: () => ({ left: 950, top: 40, right: 1280, bottom: 760, width: 330, height: 720 }),
    } as unknown as HTMLElement;

    let docText = "Line 1\nLine 2\n";
    let lineTop = 140;
    const cm: CursorCodeMirrorLike = {
      scrollDOM: scrollDom,
      state: {
        doc: {
          toString: () => docText,
          get length() {
            return docText.length;
          },
        },
      },
      coordsAtPos: () => ({ left: 180, right: 182, top: lineTop, bottom: lineTop + 20 }),
    };

    try {
      const caller = "herdr:w1:p7#agy2";
      overlay.setTyping(caller, "agy2", 180, 150, {
        notePath: "Notes/A.md",
        pane: "w1:p7",
        pos: 7,
        cm,
      });
      const cursorEl = body.children[0].children[0];
      assert.equal(cursorEl.classes.has("is-offscreen"), false);

      // Clicking a tab header outside the note pane (no docContext) drops old docAnchor and shows cursor.
      overlay.pulseClick(caller, "agy2", 552, 23, "click");
      assert.equal(cursorEl.classes.has("is-offscreen"), false, "Tab header click above paneBounds.top must not be marked offscreen");
      assert.equal(cursorEl.style.transform, "translate3d(552px, 23px, 0)");

      // Clicking a non-note leaf (sidebar/Mission Control with containerEl only) stays in screen mode.
      overlay.pulseClick(caller, "agy2", 21, 120, "click", { containerEl: mcLeafEl });
      assert.equal(cursorEl.classes.has("is-offscreen"), false, "Ribbon/sidebar click must stay visible in screen mode");
      assert.equal(cursorEl.style.transform, "translate3d(21px, 120px, 0)");

      // Stale note update from Notes/A.md must not hide or pull back the screen-mode cursor.
      lineTop = 10;
      overlay.notifyNoteUpdated("Notes/A.md");
      assert.equal(cursorEl.classes.has("is-offscreen"), false);
      assert.equal(cursorEl.style.transform, "translate3d(21px, 120px, 0)");

      // Next note action re-enters doc mode cleanly.
      lineTop = 200;
      overlay.setTyping(caller, "agy2", 180, 210, {
        notePath: "Notes/A.md",
        pane: "w1:p7",
        pos: 7,
        cm,
      });
      lineTop = 230;
      docText = "Above\nLine 1\nLine 2\n";
      overlay.notifyNoteUpdated("Notes/A.md", { from: 0, to: 0, insertLength: 6 });
      assert.equal(cursorEl.style.transform, "translate3d(180px, 240px, 0)");
    } finally {
      overlay.dispose();
    }
  });

  it("caps long jumps to <= 180ms glide and resolves whenSettled(caller) on arrival", async () => {
    const body = makeCursorMockEl({ cls: "body" });
    let nowMs = 1000;
    const rafQueue: Array<(t: number) => void> = [];
    const win = {
      innerWidth: 1920,
      innerHeight: 1080,
      document: {
        body,
        createElementNS: () => makeCursorMockEl({ cls: "svg" }),
      },
      performance: { now: () => nowMs },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: (cb: (t: number) => void) => {
        rafQueue.push(cb);
        return rafQueue.length;
      },
      cancelAnimationFrame: () => undefined,
      matchMedia: () => ({ matches: false }),
    } as unknown as Window;

    const overlay = new AgentCursorOverlay({ win, idleAfterMs: 1500, hideAfterMs: 60000 });
    try {
      const caller = "herdr:w1:p7#agy2";
      assert.equal(typeof (overlay as unknown as { whenSettled?: unknown }).whenSettled, "function");
      await overlay.whenSettled(caller);

      overlay.pulseClick(caller, "agy2", 60, 80, "click");
      await overlay.whenSettled(caller);
      const cursorEl = body.children[0].children[0];
      assert.equal(cursorEl.style.transform, "translate3d(60px, 80px, 0)");

      // Long jump (> 1400px diagonal) must finish within 180ms of RAF time and resolve whenSettled.
      overlay.pulseClick(caller, "agy2", 1420, 820, "click");
      let settledResolved = false;
      const settlePromise = overlay.whenSettled(caller, 500).then(() => {
        settledResolved = true;
      });

      for (let i = 0; i < 12; i += 1) {
        nowMs += 16;
        const batch = rafQueue.splice(0, rafQueue.length);
        for (const cb of batch) {
          cb(nowMs);
        }
      }
      await settlePromise;
      assert.equal(settledResolved, true, "Long jump must settle within <= 180ms RAF steps");
      assert.equal(cursorEl.style.transform, "translate3d(1420px, 820px, 0)");

      // Mid-glide exit/clear must also resolve whenSettled without waiting for timeout.
      overlay.pulseClick(caller, "agy2", 100, 120, "click");
      const abortWait = overlay.whenSettled(caller, 5000);
      overlay.clearAgent(caller);
      await abortWait;

      // Throttled/stalled RAF (e.g. unfocused Electron window): cap timeout snaps cursor to target.
      overlay.pulseClick(caller, "agy2", 40, 50, "click");
      overlay.pulseClick(caller, "agy2", 800, 500, "click");
      await overlay.whenSettled(caller, 25);
      const snappedEl = body.children[0].children[0];
      assert.equal(snappedEl.style.transform, "translate3d(800px, 500px, 0)");
    } finally {
      overlay.dispose();
    }
  });

  it("hides anchor if its host element belongs to another window ownerDocument", () => {
    const { win, body } = makeCursorMockWin(true);
    const overlay = new AgentCursorOverlay({ win, idleAfterMs: 1500, hideAfterMs: 60000 });
    const foreignDoc = {} as Document;
    let currentOwnerDoc: Document = win.document;
    const scrollDom = {
      isConnected: true,
      get ownerDocument() {
        return currentOwnerDoc;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getBoundingClientRect: () => ({ left: 44, top: 40, right: 900, bottom: 700, width: 856, height: 660 }),
    } as unknown as HTMLElement;
    const cm: CursorCodeMirrorLike = {
      scrollDOM: scrollDom,
      state: { doc: { toString: () => "Popout line\n", get length() { return 12; } } },
      coordsAtPos: () => ({ left: 160, right: 162, top: 140, bottom: 160 }),
    };
    try {
      overlay.setTyping("herdr:w1:p7#agy2", "agy2", 160, 150, {
        notePath: "Notes/Pop.md",
        pane: "w1:p7",
        pos: 0,
        cm,
      });
      const cursorEl = body.children[0].children[0];
      assert.equal(cursorEl.classes.has("is-offscreen"), false);

      currentOwnerDoc = foreignDoc;
      overlay.notifyNoteUpdated("Notes/Pop.md");
      assert.equal(cursorEl.classes.has("is-offscreen"), true);
    } finally {
      overlay.dispose();
    }
  });

  it("keeps cursor visible when clicked task checkbox or Mission Control row re-renders", () => {
    const mutationCallbacks: Array<() => void> = [];
    class FakeMutationObserver {
      constructor(cb: () => void) {
        mutationCallbacks.push(cb);
      }
      observe() {}
      disconnect() {}
    }
    const baseWin = makeCursorMockWin(true);
    const body = baseWin.body;
    const win = Object.assign(baseWin.win as unknown as Record<string, unknown>, {
      MutationObserver: FakeMutationObserver,
    }) as unknown as Window;
    const overlay = new AgentCursorOverlay({ win, idleAfterMs: 1500, hideAfterMs: 60000 });

    const scrollDom = {
      isConnected: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getBoundingClientRect: () => ({ left: 44, top: 40, right: 1200, bottom: 760, width: 1156, height: 720 }),
    } as unknown as HTMLElement;
    const contentDom = { isConnected: true } as unknown as HTMLElement;
    const docText = "# Heading\n\n- [ ] Unchecked task\n";
    const cm: CursorCodeMirrorLike = {
      scrollDOM: scrollDom,
      contentDOM: contentDom,
      state: {
        doc: {
          toString: () => docText,
          get length() {
            return docText.length;
          },
        },
        selection: { main: { head: 0 } },
      },
      // Selection head at line 1 is virtualized/scrolled offscreen (null) while checkbox is on screen.
      coordsAtPos: () => null,
    };

    try {
      const caller = "herdr:w1:pA#agy3";
      // Clicking task checkbox inside pane when selection.head is offscreen must not hide cursor on re-render.
      overlay.pulseClick(caller, "agy3", 641, 578, "click", {
        notePath: "Notes/Lists.md",
        pane: "w1:pA",
        pos: 0,
        cm,
      });
      const cursorEl = body.children[0].children[0];
      assert.equal(cursorEl.classes.has("is-offscreen"), false);

      for (const cb of mutationCallbacks) {
        cb();
      }
      overlay.notifyNoteUpdated("Notes/Lists.md");
      assert.equal(overlay.getActiveCount(), 1, "Checkbox re-render must not remove cursor");
      assert.equal(cursorEl.classes.has("is-offscreen"), false, "Checkbox re-render must not hide cursor");
      assert.equal(cursorEl.style.transform, "translate3d(641px, 578px, 0)");

      // Clicking Mission Control row whose containerEl later detaches on re-render stays visible in screen mode.
      let mcLeafConnected = true;
      const mcLeaf = {
        get isConnected() {
          return mcLeafConnected;
        },
        getBoundingClientRect: () => ({ left: 1000, top: 40, right: 1280, bottom: 760, width: 280, height: 720 }),
      } as unknown as HTMLElement;
      overlay.pulseClick(caller, "agy3", 1180, 612, "click", { containerEl: mcLeaf });
      mcLeafConnected = false;
      overlay.notifyNoteUpdated();
      assert.equal(overlay.getActiveCount(), 1, "Mission Control row re-render must not clear cursor");
      assert.equal(cursorEl.classes.has("is-offscreen"), false);
      assert.equal(cursorEl.style.transform, "translate3d(1180px, 612px, 0)");
    } finally {
      overlay.dispose();
    }
  });

  it("does not pull a checkbox click cursor to an unrelated caret on the same visual row (P2-2)", () => {
    const mutationCallbacks: Array<() => void> = [];
    class FakeMutationObserver {
      constructor(cb: () => void) {
        mutationCallbacks.push(cb);
      }
      observe() {}
      disconnect() {}
    }
    const baseWin = makeCursorMockWin(true);
    const body = baseWin.body;
    const win = Object.assign(baseWin.win as unknown as Record<string, unknown>, {
      MutationObserver: FakeMutationObserver,
    }) as unknown as Window;
    const overlay = new AgentCursorOverlay({ win, idleAfterMs: 1500, hideAfterMs: 60000 });

    const scrollDom = {
      isConnected: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getBoundingClientRect: () => ({ left: 44, top: 40, right: 1200, bottom: 760, width: 1156, height: 720 }),
    } as unknown as HTMLElement;
    const contentDom = { isConnected: true } as unknown as HTMLElement;
    let docText = "- [ ] Unchecked task with text to the right\n";
    const selectionPos = docText.length - 1;
    const cm: CursorCodeMirrorLike = {
      scrollDOM: scrollDom,
      contentDOM: contentDom,
      state: {
        doc: {
          toString: () => docText,
          get length() {
            return docText.length;
          },
        },
        selection: { main: { head: selectionPos } },
      },
      // Unrelated caret on the exact same row (y=578) far to the right (x=900) of checkbox (x=641).
      coordsAtPos: () => ({ left: 900, right: 902, top: 568, bottom: 588 }),
    };

    try {
      const caller = "herdr:w1:pA#agy3";
      overlay.pulseClick(caller, "agy3", 641, 578, "click", {
        notePath: "Notes/Lists.md",
        pane: "w1:pA",
        pos: selectionPos,
        cm,
      });
      const cursorEl = body.children[0].children[0];
      assert.equal(cursorEl.style.transform, "translate3d(641px, 578px, 0)");

      docText = "- [x] Unchecked task with text to the right\n";
      for (const cb of mutationCallbacks) {
        cb();
      }
      overlay.notifyNoteUpdated("Notes/Lists.md");
      assert.equal(cursorEl.classes.has("is-offscreen"), false);
      assert.equal(
        cursorEl.style.transform,
        "translate3d(641px, 578px, 0)",
        "Checkbox click cursor must not jump horizontally to unrelated same-row caret"
      );
    } finally {
      overlay.dispose();
    }
  });

  it("lands rename-abort cursor on the current partial streamed line in the renamed note", () => {
    const { win, body } = makeCursorMockWin(true);
    const overlay = new AgentCursorOverlay({ win, idleAfterMs: 1500, hideAfterMs: 60000 });

    const scrollDom = {
      isConnected: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getBoundingClientRect: () => ({ left: 44, top: 40, right: 1200, bottom: 760, width: 1156, height: 720 }),
    } as unknown as HTMLElement;

    let viewPath = "Crew Test/Audit/agy5 renamed.md";
    const docText = "# Heading\n## Section 1\n- Initial\nLong streaming rerun line designed";
    const sectionPos = docText.indexOf("## Section 1");
    const partialPos = docText.length;
    const cm: CursorCodeMirrorLike = {
      scrollDOM: scrollDom,
      state: {
        doc: {
          toString: () => docText,
          get length() {
            return docText.length;
          },
        },
        selection: { main: { head: sectionPos } },
      },
      coordsAtPos: (pos: number) =>
        pos >= docText.indexOf("Long streaming")
          ? { left: 420, right: 422, top: 335, bottom: 355 }
          : { left: 180, right: 182, top: 190, bottom: 210 },
    };
    const view = {
      get file() {
        return { path: viewPath };
      },
    };

    try {
      const caller = "herdr:w1:pA#agy4";
      overlay.setTyping(caller, "agy4", 420, 345, {
        notePath: "Crew Test/Audit/agy5 renamed.md",
        pane: "w1:pA",
        pos: partialPos,
        cm,
        view,
      });

      // Rename occurs mid-write; insert_line aborts and finishes typing with old path.
      viewPath = "Crew Test/Audit/agy5 renamed2.md";
      overlay.finishTyping(caller, {
        notePath: "Crew Test/Audit/agy5 renamed.md",
        pane: "w1:pA",
        pos: partialPos,
        cm,
        view,
      });
      const abortedEl = body.children[0].children[0];
      assert.equal(abortedEl.classes.has("is-offscreen"), false, "Cross-caller rename abort must keep partial line visible");
      assert.equal(abortedEl.style.transform, "translate3d(420px, 345px, 0)");

      // Same-caller vault.rename_note clears old marker then calls pointAtResult ("rename") with stale selection.head.
      overlay.clearAgent(caller);
      overlay.moveTo(caller, "agy4", 180, 200, "rename", {
        notePath: "Crew Test/Audit/agy5 renamed2.md",
        pane: "w1:pA",
        cm,
        view,
      });
      const renamedEl = body.children[0].children[0];
      assert.equal(renamedEl.classes.has("is-offscreen"), false);
      assert.equal(
        renamedEl.style.transform,
        "translate3d(420px, 345px, 0)",
        "Rename result cursor must sit on partial streamed line, not previous selection line"
      );
    } finally {
      overlay.dispose();
    }
  });

  it("exposes uiTypingSpeed and allowUiInProtectedAreas in HerdrSettingTab settings UI", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-herdr-settings-test-"));
    try {
      const stubPath = path.join(tmpDir, "obsidian-settings-stub.js");
      fs.writeFileSync(
        stubPath,
        [
          "exports.Notice = class Notice { constructor(m) { this.message = m; } };",
          "exports.PluginSettingTab = class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } update() {} };",
          "exports.Modal = class Modal { constructor(app) { this.app = app; } open() {} close() {} };",
        ].join("\n"),
        "utf8"
      );
      const outPath = path.join(tmpDir, "settings-tab.cjs");
      const runnerScript = [
        'const esbuild = require("esbuild");',
        `esbuild.buildSync({ entryPoints: [${JSON.stringify(path.resolve("src/ui/settings-tab.ts"))}], bundle: true, format: "cjs", platform: "node", target: "es2022", outfile: ${JSON.stringify(outPath)}, alias: { obsidian: ${JSON.stringify(stubPath)} } });`,
        `const { HerdrSettingTab } = require(${JSON.stringify(outPath)});`,
        "const saved = [];",
        'const settings = { profiles: [{ id: "herdr-vault", name: "Herdr", kind: "herdr-vault", cwdMode: "vault-root" }], uiTypingSpeed: "visible", allowUiInProtectedAreas: false };',
        "const tab = new HerdrSettingTab({}, { settings, async saveAndApplySettings(patch) { Object.assign(settings, patch); saved.push(patch); } });",
        "const defs = tab.getSettingDefinitions();",
        'const group = defs.find((d) => d.heading === "Vault Control Bridge and notifications");',
        'const speedItem = group.items.find((i) => i.control && i.control.key === "uiTypingSpeed");',
        'const protItem = group.items.find((i) => i.control && i.control.key === "allowUiInProtectedAreas");',
        "Promise.all([tab.setControlValue('uiTypingSpeed', 'fast'), tab.setControlValue('allowUiInProtectedAreas', true)]).then(() => {",
        "  process.stdout.write(JSON.stringify({ speedItem, protItem, settings, saved }));",
        "});",
      ].join("\n");
      const out = await execFileAsync(process.execPath, ["-e", runnerScript], { cwd: process.cwd() });
      const parsed = JSON.parse(out.stdout) as {
        speedItem?: { control?: { type: string; key: string; options: Record<string, string> } };
        protItem?: { control?: { type: string; key: string } };
        settings: { uiTypingSpeed: string; allowUiInProtectedAreas: boolean };
      };
      assert.equal(parsed.speedItem?.control?.type, "dropdown");
      assert.deepEqual(Object.keys(parsed.speedItem?.control?.options ?? {}), ["visible", "fast"]);
      assert.equal(parsed.protItem?.control?.type, "toggle");
      assert.equal(parsed.settings.uiTypingSpeed, "fast");
      assert.equal(parsed.settings.allowUiInProtectedAreas, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("renders HerdrSettingTab.display() cleanly against a DOM mock with full migrated settings", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-herdr-settings-dom-"));
    try {
      const stubPath = path.join(tmpDir, "obsidian-dom-stub.js");
      fs.writeFileSync(
        stubPath,
        [
          "function makeEl(tag) {",
          "  const el = {",
          "    tagName: tag.toUpperCase(),",
          "    children: [],",
          "    textContent: '',",
          "    empty() { this.children = []; this.textContent = ''; },",
          "    createEl(childTag, opts) { const c = makeEl(childTag); if (opts && opts.text) c.textContent = opts.text; this.children.push(c); return c; },",
          "    createDiv(opts) { return this.createEl('div', opts); },",
          "    addClass() {},",
          "  };",
          "  return el;",
          "}",
          "class SettingMock {",
          "  constructor(containerEl) { this.containerEl = containerEl; this.row = containerEl.createDiv(); this.buttons = []; }",
          "  setName(name) { this.name = name; return this; }",
          "  setDesc(desc) { this.desc = desc; return this; }",
          "  addButton(cb) { const btn = { setButtonText(t) { this.text = t; return this; }, onClick(fn) { this.click = fn; return this; } }; cb(btn); this.buttons.push(btn); return this; }",
          "}",
          "exports.Notice = class Notice { constructor(m) { this.message = m; } };",
          "exports.Modal = class Modal { constructor(app) { this.app = app; } open() {} close() {} };",
          "exports.PluginSettingTab = class PluginSettingTab {",
          "  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.id = plugin.manifest?.id || 'herdr-obs'; this.name = plugin.manifest?.name || 'Herdr'; this.containerEl = makeEl('div'); }",
          "  update() { this.settingItems = this.getSettingDefinitions(); }",
          "  display() {",
          "    this.containerEl.empty();",
          "    const defs = this.getSettingDefinitions();",
          "    this.settingItems = defs;",
          "    const renderItem = (item) => {",
          "      if (item.visible === false || (typeof item.visible === 'function' && !item.visible())) return;",
          "      if (item.items) { for (const child of item.items) renderItem(child); return; }",
          "      const setting = new SettingMock(this.containerEl);",
          "      if (item.render) { item.render(setting, this.containerEl); return; }",
          "      setting.setName(item.name); if (item.desc) setting.setDesc(item.desc);",
          "      if (item.control) {",
          "        const val = this.getControlValue(item.control.key);",
          "        if (item.control.type === 'dropdown' && !(String(val) in item.control.options)) {",
          "          throw new Error(`Invalid dropdown value ${String(val)} for ${item.control.key}`);",
          "        }",
          "      }",
          "    };",
          "    for (const def of defs) renderItem(def);",
          "  }",
          "};",
        ].join("\n"),
        "utf8"
      );
      const typesOut = path.join(tmpDir, "types.cjs");
      const tabOut = path.join(tmpDir, "tab.cjs");
      const runnerScript = [
        'const esbuild = require("esbuild");',
        `esbuild.buildSync({ entryPoints: [${JSON.stringify(path.resolve("src/domain/types.ts"))}], bundle: true, format: "cjs", platform: "node", target: "es2022", outfile: ${JSON.stringify(typesOut)} });`,
        `esbuild.buildSync({ entryPoints: [${JSON.stringify(path.resolve("src/ui/settings-tab.ts"))}], bundle: true, format: "cjs", platform: "node", target: "es2022", outfile: ${JSON.stringify(tabOut)}, alias: { obsidian: ${JSON.stringify(stubPath)} } });`,
        `const { migrateSettings } = require(${JSON.stringify(typesOut)});`,
        `const { HerdrSettingTab } = require(${JSON.stringify(tabOut)});`,
        'const settings = migrateSettings({ vaultPermissionMode: "full", allowUiControl: true, showAgentCursors: true });',
        'const plugin = { manifest: { id: "herdr-obs", name: "Herdr Mission Control" }, settings, async saveAndApplySettings(patch) { Object.assign(settings, patch); } };',
        "const tab = new HerdrSettingTab({}, plugin);",
        "tab.update();",
        "tab.display();",
        "const values = {",
        '  uiTypingSpeed: tab.getControlValue("uiTypingSpeed"),',
        '  allowUiInProtectedAreas: tab.getControlValue("allowUiInProtectedAreas"),',
        '  showAgentCursors: tab.getControlValue("showAgentCursors"),',
        "};",
        "Promise.resolve(tab.setControlValue('showAgentCursors', false)).then(() => {",
        "  process.stdout.write(JSON.stringify({ renderedRows: tab.containerEl.children.length, defCount: tab.settingItems.length, values, updatedShowAgentCursors: settings.showAgentCursors, icon: tab.icon }));",
        "});",
      ].join("\n");
      const out = await execFileAsync(process.execPath, ["-e", runnerScript], { cwd: process.cwd() });
      const parsed = JSON.parse(out.stdout) as {
        renderedRows: number;
        defCount: number;
        values: { uiTypingSpeed: string; allowUiInProtectedAreas: boolean; showAgentCursors: boolean };
        updatedShowAgentCursors: boolean;
        icon: string;
      };
      assert.equal(parsed.icon, "cpu");
      assert.equal(parsed.defCount, 4);
      assert.ok(parsed.renderedRows >= 20);
      assert.deepEqual(parsed.values, {
        uiTypingSpeed: "visible",
        allowUiInProtectedAreas: false,
        showAgentCursors: true,
      });
      assert.equal(parsed.updatedShowAgentCursors, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
