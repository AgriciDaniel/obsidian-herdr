import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import type { App } from "obsidian";
import { VaultBridgeServer } from "../src/bridge/vault-bridge-server";
import { VaultOpsService } from "../src/bridge/vault-ops";
import {
  buildBridgeEnvForPanes,
  computeRuntimePaths,
  provisionRuntimeKit,
  pruneOldScreenshots,
} from "../src/bridge/runtime-kit";
import { HerdrCliClient } from "../src/herdr/cli-client";
import { cliInvocation, makeShortTmpDir, PYTHON } from "./helpers/portable";
import { createMockObsidianApp } from "./obsidian-mock";

const execFileAsync = promisify(execFile);

async function callMcpBatch(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  messages: Array<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const responses: Array<Record<string, unknown>> = [];
    let buf = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          responses.push(JSON.parse(line) as Record<string, unknown>);
        }
        nl = buf.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    for (const msg of messages) {
      child.stdin.write(JSON.stringify(msg) + "\n");
    }
    child.stdin.end();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP batch timed out (${responses.length}/${messages.length}). stderr: ${stderr}`));
    }, 15000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(responses);
    });
  });
}

describe("Phase 2 & 3 Regressions: Context Thrift, MCP Gating, Parity, and Hygiene", () => {
  it("gates UI MCP tools when uiControlEnabled=false, emits compact JSON, and returns isError=true on operational RPC errors in Node and Python", async () => {
    const tmpBase = makeShortTmpDir("oh-gate-");
    const vaultDir = path.join(tmpBase, "vault");
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, "Alpha.md"), "# Alpha\nHello world\n", "utf8");
    const mockApp = createMockObsidianApp(vaultDir, "GateVault");
    const vaultOps = new VaultOpsService({
      app: mockApp as unknown as App,
      getPermissionMode: () => "read-only",
      getAllowHiddenReads: () => false,
    });
    const kit = computeRuntimePaths(vaultDir, path.join(tmpBase, "runtime"));
    const server = new VaultBridgeServer({
      socketPath: kit.socketPath,
      kitDir: kit.runtimeDir,
      dispatcher: (method, params, caller) => vaultOps.dispatch(method, params, caller),
    });

    try {
      provisionRuntimeKit({
        kit,
        token: server.getAuthToken(),
        vaultName: "GateVault",
        vaultPath: vaultDir,
        uiControlEnabled: false,
      });
      await server.start();
      const env = {
        ...process.env,
        ...buildBridgeEnvForPanes({
          kit,
          token: server.getAuthToken(),
          vaultName: "GateVault",
          vaultPath: vaultDir,
        }),
      };
      const corePyPath = path.join(kit.binDir, "obs-herdr-core.py");

      for (const [cmd, baseArgs] of [
        cliInvocation(kit, ["mcp"]),
        [PYTHON, [corePyPath, "mcp"]],
      ] as Array<[string, string[]]>) {
        const res = await callMcpBatch(cmd, baseArgs, env, [
          { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "obsidian_vault_info", arguments: {} } },
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "obsidian_read_note", arguments: { path: "DoesNotExist.md" } },
          },
        ]);
        assert.equal(res.length, 3);
        const tools = (res[0].result as { tools: Array<{ name: string }> }).tools;
        assert.equal(tools.length, 16, `${cmd} must omit all 11 UI tools when uiControlEnabled=false`);
        assert.ok(
          tools.every((t) => !t.name.startsWith("obsidian_ui_") && t.name !== "obsidian_click" && t.name !== "obsidian_type"),
          `${cmd} must not advertise UI tools when disabled`
        );

        const infoText = (res[1].result as { content: Array<{ text: string }> }).content[0].text;
        assert.ok(!infoText.includes("\n  "), `${cmd} MCP response must be compact JSON without pretty indentation`);
        const parsedInfo = JSON.parse(infoText) as { vaultName: string };
        assert.equal(parsedInfo.vaultName, "GateVault");

        const errResult = res[2].result as { isError?: boolean; content: Array<{ text: string }> } | undefined;
        assert.equal(errResult?.isError, true, `${cmd} must return MCP isError=true for operational bridge errors`);
        assert.ok(
          errResult?.content[0]?.text.includes("not_found") || errResult?.content[0]?.text.includes("Note not found"),
          `${cmd} isError payload must describe the error`
        );
      }
    } finally {
      await server.stop();
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("bounds vault.list_files, vault.read_note, and commands.list outputs with pagination metadata", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "obs-herdr-bounds-"));
    const vaultDir = path.join(tmpBase, "vault");
    fs.mkdirSync(vaultDir, { recursive: true });
    for (let i = 0; i < 65; i += 1) {
      fs.writeFileSync(path.join(vaultDir, `Note-${String(i).padStart(2, "0")}.md`), `# Note ${i}\n`, "utf8");
    }
    const bigLines = Array.from({ length: 500 }, (_, idx) => `Line ${idx + 1}: content here`).join("\n");
    fs.writeFileSync(path.join(vaultDir, "Big.md"), bigLines, "utf8");
    // Over the old 32,000 character default cap, to prove full reads are the default.
    const hugeBody = "x".repeat(40_000);
    fs.writeFileSync(path.join(vaultDir, "Huge.md"), hugeBody, "utf8");
    fs.writeFileSync(path.join(vaultDir, "Crlf.md"), "one\r\ntwo\r\nthree\r\n", "utf8");

    const mockApp = createMockObsidianApp(vaultDir, "BoundsVault");
    const vaultOps = new VaultOpsService({
      app: mockApp as unknown as App,
      getPermissionMode: () => "read-only",
      getAllowHiddenReads: () => false,
    });

    try {
      // Default listing keeps the 0.2.x size (250), so 68 notes fit in one call.
      const all = (await vaultOps.dispatch("vault.list_files", {}, "agent")) as {
        count: number;
        total: number;
        truncated: boolean;
      };
      assert.equal(all.count, 68);
      assert.equal(all.truncated, false);

      const listed = (await vaultOps.dispatch("vault.list_files", { limit: 50 }, "agent")) as {
        count: number;
        total: number;
        truncated: boolean;
        files: Array<{ path: string }>;
      };
      assert.equal(listed.count, 50);
      assert.equal(listed.total, 68);
      assert.equal(listed.truncated, true);

      const page2 = (await vaultOps.dispatch("vault.list_files", { offset: 50, limit: 50 }, "agent")) as {
        count: number;
        total: number;
        truncated: boolean;
      };
      assert.equal(page2.count, 18);
      assert.equal(page2.truncated, false);

      const readWindow = (await vaultOps.dispatch(
        "vault.read_note",
        { path: "Big.md", offsetLine: 10, maxLines: 5 },
        "agent"
      )) as { content: string; truncated: boolean };
      assert.equal(readWindow.truncated, true);
      assert.ok(readWindow.content.startsWith("Line 11:"));
      // Line endings are kept, so consecutive windows join back into the note exactly.
      assert.ok(readWindow.content.endsWith("Line 15: content here\n"));

      const huge = (await vaultOps.dispatch("vault.read_note", { path: "Huge.md" }, "agent")) as {
        content: string;
        truncated: boolean;
      };
      assert.equal(huge.content.length, 40_000);
      assert.equal(huge.truncated, false);

      const nullLimits = (await vaultOps.dispatch(
        "vault.read_note",
        { path: "Big.md", offsetLine: null, maxLines: null, maxChars: null },
        "agent"
      )) as { content: string; truncated: boolean };
      assert.equal(nullLimits.content, bigLines);
      assert.equal(nullLimits.truncated, false);

      const crlf = (await vaultOps.dispatch(
        "vault.read_note",
        { path: "Crlf.md", offsetLine: 1, maxLines: 1 },
        "agent"
      )) as { content: string };
      assert.equal(crlf.content, "two\r\n");
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("handles --help inside flag values, empty --set keys, missing Python positional args, and empty --steps-json consistently", async () => {
    const tmpBase = makeShortTmpDir("oh-parity-");
    const vaultDir = path.join(tmpBase, "vault");
    fs.mkdirSync(vaultDir, { recursive: true });
    const kit = computeRuntimePaths(vaultDir, path.join(tmpBase, "runtime"));
    const received: Array<{ method: string; params: Record<string, unknown> }> = [];
    const server = new VaultBridgeServer({
      socketPath: kit.socketPath,
      kitDir: kit.runtimeDir,
      dispatcher: async (method, params) => {
        received.push({ method, params });
        return { ok: true, method, params };
      },
    });
    try {
      provisionRuntimeKit({ kit, token: server.getAuthToken(), vaultName: "ParityVault", vaultPath: vaultDir });
      await server.start();
      const env = {
        ...process.env,
        ...buildBridgeEnvForPanes({ kit, token: server.getAuthToken(), vaultName: "ParityVault", vaultPath: vaultDir }),
      };
      const corePyPath = path.join(kit.binDir, "obs-herdr-core.py");

      for (const [cmd, baseArgs] of [
        cliInvocation(kit),
        [PYTHON, [corePyPath]],
      ] as Array<[string, string[]]>) {
        // --help as a flag value must NOT print help
        const out = await execFileAsync(cmd, [...baseArgs, "note", "create", "H.md", "--content", "--help"], { env });
        const parsed = JSON.parse(out.stdout) as { ok: boolean; params: { content: string } };
        assert.equal(parsed.ok, true);
        assert.equal(parsed.params.content, "--help");

        // Empty --set key must fail cleanly in both Node and Python
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "note", "frontmatter", "H.md", "--set", "=val"], { env }),
          /key|empty/i
        );

        // Missing positional arg must fail with usage error (never Python IndexError traceback)
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "note", "read"], { env }),
          (err: unknown) => {
            const msg = String((err as { stderr?: string; message?: string })?.stderr || (err as Error)?.message || err);
            return !msg.includes("IndexError") && /path|missing|usage/i.test(msg);
          }
        );

        // Empty --steps-json "" must fail cleanly
        await assert.rejects(
          execFileAsync(cmd, [...baseArgs, "ui", "batch", "--steps-json", ""], { env }),
          /steps|json|empty/i
        );
      }
    } finally {
      await server.stop();
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("prunes excess screenshots and caches HerdrCliClient binary resolution", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "obs-herdr-hygiene-"));
    try {
      const shotsDir = path.join(tmpBase, "screenshots");
      fs.mkdirSync(shotsDir, { recursive: true });
      const now = Date.now();
      for (let i = 0; i < 60; i += 1) {
        const p = path.join(shotsDir, `shot-${String(i).padStart(2, "0")}.png`);
        fs.writeFileSync(p, "png", "utf8");
        const t = new Date(now - (60 - i) * 1000);
        fs.utimesSync(p, t, t);
      }
      const removed = await pruneOldScreenshots(tmpBase, { maxKeep: 50, maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
      assert.equal(removed, 10);
      assert.equal(fs.readdirSync(shotsDir).length, 50);

      const cli = new HerdrCliClient();
      const first = cli.getBinaryPath();
      const second = cli.getBinaryPath();
      assert.equal(first, second);
      cli.invalidateBinaryCache();
      assert.equal(cli.getBinaryPath(), first);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
