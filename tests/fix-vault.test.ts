import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import type { App, TFile } from "obsidian";
import * as runtimeKit from "../src/bridge/runtime-kit";
import { BridgeRpcError, VaultOpsService } from "../src/bridge/vault-ops";
import { UiControlService, type InspectedElement } from "../src/control/ui-control";
import { createMockObsidianApp } from "./obsidian-mock";

const execFileAsync = promisify(execFile);

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeElement(opts: {
  tag?: string;
  label?: string;
  text?: string;
  classes?: string[];
  rect?: { x: number; y: number; width: number; height: number };
  parent?: Record<string, unknown> | null;
}) {
  const classes = new Set(opts.classes ?? []);
  const attrs: Record<string, string> = {};
  if (opts.label) attrs["aria-label"] = opts.label;
  const tag = (opts.tag ?? "div").toUpperCase();
  const rect = opts.rect ?? { x: 10, y: 10, width: 80, height: 28 };
  const el: Record<string, unknown> = {
    tagName: tag,
    innerText: opts.text ?? "",
    textContent: opts.text ?? "",
    disabled: false,
    isConnected: true,
    parentElement: opts.parent ?? null,
    children: [],
    getAttribute: (name: string) => attrs[name] ?? null,
    getBoundingClientRect: () => ({
      ...rect,
      top: rect.y,
      left: rect.x,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
    }),
    matches: (sel: string) => {
      for (const part of sel.split(",").map((s) => s.trim())) {
        if (part.startsWith(".") && classes.has(part.slice(1))) return true;
        if (part.toLowerCase() === tag.toLowerCase()) return true;
        if (part === "[aria-label]" && Boolean(attrs["aria-label"])) return true;
      }
      return false;
    },
    closest: (sel: string): unknown => {
      let cur: Record<string, unknown> | null = el;
      while (cur) {
        if ((cur.matches as (s: string) => boolean)(sel)) return cur;
        cur = (cur.parentElement as Record<string, unknown> | null) ?? null;
      }
      return null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: (other: unknown) => other === el,
    focus: () => undefined,
  };
  return el;
}

describe("Fix round 2026-11-20 (fix-vault: B1-B8)", () => {
  it("B1: vault.trash_note verifies deletion, falls back to vault.trash(file, false), and throws trash_failed on failure", async () => {
    const tmpDir = makeTempDir("fix-b1-");
    try {
      const mockApp = createMockObsidianApp(tmpDir, "TrashVault");
      await mockApp.vault.create("fallback.md", "fallback body");
      await mockApp.vault.create("stuck.md", "stuck body");
      await mockApp.vault.create("undo-fallback.md", "undo body");

      // Simulate Flatpak system trash silently doing nothing
      mockApp.fileManager.trashFile = async () => Promise.resolve();

      const ops = new VaultOpsService({
        app: mockApp as unknown as App,
        getPermissionMode: () => "full",
        getAllowUiControl: () => false,
        getAllowUiInProtectedAreas: () => false,
        getAllowHiddenReads: () => false,
        onAuditChanged: () => undefined,
      });

      // 1. Falls back to local .trash via vault.trash(file, false)
      const res = (await ops.dispatch(
        "vault.trash_note",
        { path: "fallback.md" },
        "test-b1"
      )) as { trashed: boolean; path: string; method?: string };
      assert.equal(res.trashed, true);
      assert.equal(res.method, "local");
      assert.equal(mockApp.vault.getAbstractFileByPath("fallback.md"), null);

      // 2. When both trashFile and vault.trash fail to delete, throws trash_failed and records no success audit
      (mockApp.vault as unknown as { trash?: (f: TFile, s: boolean) => Promise<void> }).trash =
        async () => Promise.resolve();
      const auditCountBefore = ops.getAuditLog().length;
      await assert.rejects(
        () => ops.dispatch("vault.trash_note", { path: "stuck.md" }, "test-b1"),
        (err: unknown) => err instanceof BridgeRpcError && err.code === "trash_failed"
      );
      const newAudits = ops.getAuditLog().slice(0, ops.getAuditLog().length - auditCountBefore);
      assert.equal(
        newAudits.some((e) => e.allowed && e.method === "vault.trash_note"),
        false,
        "must not record a success audit when trash fails"
      );
      assert.notEqual(mockApp.vault.getAbstractFileByPath("stuck.md"), null);

      // 3. undoMutation for a created note also verifies deletion and throws trash_failed if file stays
      await ops.dispatch(
        "vault.create_note",
        { path: "created-stuck.md", content: "hello" },
        "test-b1"
      );
      const createAudit = ops.getAuditLog().find((e) => e.targetPath === "created-stuck.md");
      assert.ok(createAudit);
      await assert.rejects(
        () => ops.undoMutation(createAudit.id),
        (err: unknown) => err instanceof BridgeRpcError && err.code === "trash_failed"
      );
      assert.notEqual(createAudit.undone, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("B2: vault.rename_note sets in-memory alwaysUpdateLinks without disk write, restores in finally, and supports updateLinks=false", async () => {
    const tmpDir = makeTempDir("fix-b2-");
    try {
      const mockApp = createMockObsidianApp(tmpDir, "RenameVault");
      await mockApp.vault.create("source.md", "# Source");
      await mockApp.vault.create("linker.md", "See [[source]].");

      let setConfigCalls = 0;
      let observedAlwaysUpdateLinks: unknown = "not-called";
      const vaultAny = mockApp.vault as unknown as {
        config?: Record<string, unknown>;
        setConfig?: (k: string, v: unknown) => void;
      };
      vaultAny.config = {};
      vaultAny.setConfig = () => {
        setConfigCalls += 1;
      };

      const origRename = mockApp.fileManager.renameFile;
      mockApp.fileManager.renameFile = async (file: TFile, newPath: string) => {
        observedAlwaysUpdateLinks = vaultAny.config?.alwaysUpdateLinks;
        if (observedAlwaysUpdateLinks !== true) {
          throw new Error("Simulated Update links modal hang");
        }
        return origRename(file, newPath);
      };

      const ops = new VaultOpsService({
        app: mockApp as unknown as App,
        getPermissionMode: () => "full",
        getAllowUiControl: () => false,
        getAllowUiInProtectedAreas: () => false,
        getAllowHiddenReads: () => false,
        onAuditChanged: () => undefined,
      });

      await ops.dispatch(
        "vault.rename_note",
        { path: "source.md", newPath: "renamed.md" },
        "test-b2"
      );

      assert.equal(observedAlwaysUpdateLinks, true);
      assert.equal(setConfigCalls, 0, "must not call setConfig / write settings to disk");
      assert.equal(
        Object.prototype.hasOwnProperty.call(vaultAny.config, "alwaysUpdateLinks"),
        false,
        "must restore absent alwaysUpdateLinks key in finally"
      );
      const linkerBody = fs.readFileSync(path.join(tmpDir, "linker.md"), "utf8");
      assert.ok(linkerBody.includes("[[renamed]]"));

      // updateLinks: false must rename without touching links
      await ops.dispatch(
        "vault.rename_note",
        { path: "renamed.md", newPath: "renamed-nolinks.md", updateLinks: false },
        "test-b2"
      );
      const linkerAfter = fs.readFileSync(path.join(tmpDir, "linker.md"), "utf8");
      assert.ok(
        linkerAfter.includes("[[renamed]]"),
        "updateLinks=false must not rewrite links"
      );
      assert.notEqual(mockApp.vault.getAbstractFileByPath("renamed-nolinks.md"), null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("B3 & B4: obs-herdr Node & Python clients enforce timeout, early close, invalid JSON, MCP error recovery, and real plugin version", async () => {
    const tmpDir = makeTempDir("fix-b34-");
    let server: net.Server | null = null;
    try {
      const kit = runtimeKit.computeRuntimePaths(path.join(tmpDir, "v"), tmpDir);
      const provision = runtimeKit.provisionRuntimeKit as (opts: {
        kit: runtimeKit.ProvisionedRuntimeKit;
        token: string;
        vaultName: string;
        vaultPath: string | null;
        pluginVersion?: string;
      }) => void;
      provision({
        kit,
        token: "a".repeat(64),
        vaultName: "TimeoutVault",
        vaultPath: tmpDir,
        pluginVersion: "0.3.1",
      });

      // B4: herdr-plugin.toml uses real pluginVersion
      const toml = fs.readFileSync(kit.herdrPluginManifestPath, "utf8");
      assert.ok(toml.includes('version = "0.3.1"'), `Expected 0.3.1 in toml, got:\n${toml}`);

      // Mock bridge server with controllable modes per method
      let vaultInfoCalls = 0;
      server = net.createServer((sock) => {
        let buf = "";
        sock.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl === -1) return;
          const req = JSON.parse(buf.slice(0, nl)) as { id: string; method: string };
          if (req.method === "test.hang") {
            // Never respond
          } else if (req.method === "test.early_close") {
            sock.write('{"partial":');
            sock.end();
          } else if (req.method === "test.bad_json") {
            sock.end("not-json-at-all\n");
          } else if (req.method === "vault.info") {
            vaultInfoCalls += 1;
            if (vaultInfoCalls % 2 === 1) {
              // First call per MCP engine hangs to verify JSON-RPC error + recovery
              return;
            }
            sock.end(JSON.stringify({ id: req.id, ok: true, result: { pong: true } }) + "\n");
          } else {
            sock.end(JSON.stringify({ id: req.id, ok: true, result: { pong: true } }) + "\n");
          }
        });
      });
      await new Promise<void>((resolve) => server!.listen(kit.socketPath, resolve));

      const coreMjs = path.join(kit.binDir, "obs-herdr-core.mjs");
      const corePy = path.join(kit.binDir, "obs-herdr-core.py");
      const baseEnv = {
        ...process.env,
        OBSIDIAN_HERDR_CONNECTION_FILE: kit.connectionFilePath,
        OBS_HERDR_TIMEOUT_MS: "250",
      };

      for (const [label, bin, args] of [
        ["node", process.execPath, [coreMjs]],
        ["python", "python3", [corePy]],
      ] as Array<[string, string, string[]]>) {
        // Timeout -> non-zero exit + clear error
        await assert.rejects(
          () => execFileAsync(bin, [...args, "rpc", "test.hang", "{}"], { env: baseEnv, timeout: 4000 }),
          (err: { code?: number; stderr?: string }) =>
            err.code !== 0 && /timed out/i.test(String(err.stderr ?? ""))
        );

        // Early close -> non-zero exit + clear error
        await assert.rejects(
          () => execFileAsync(bin, [...args, "rpc", "test.early_close", "{}"], { env: baseEnv, timeout: 4000 }),
          (err: { code?: number; stderr?: string }) =>
            err.code !== 0 && /closed|incomplete/i.test(String(err.stderr ?? ""))
        );

        // Invalid JSON -> non-zero exit + clear error
        await assert.rejects(
          () => execFileAsync(bin, [...args, "rpc", "test.bad_json", "{}"], { env: baseEnv, timeout: 4000 }),
          (err: { code?: number; stderr?: string }) =>
            err.code !== 0 && /json/i.test(String(err.stderr ?? ""))
        );

        // MCP mode: real version in initialize, JSON-RPC error on timeout, server stays alive
        const mcpOut = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
          const child = spawn(bin, [...args, "mcp"], { env: baseEnv });
          const lines: Array<Record<string, unknown>> = [];
          let rem = "";
          child.stdout.on("data", (d) => {
            rem += d.toString("utf8");
            let idx = rem.indexOf("\n");
            while (idx !== -1) {
              const ln = rem.slice(0, idx).trim();
              rem = rem.slice(idx + 1);
              if (ln) lines.push(JSON.parse(ln) as Record<string, unknown>);
              idx = rem.indexOf("\n");
            }
          });
          child.on("error", reject);
          child.on("close", () => resolve(lines));
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n"
          );
          child.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "obsidian_vault_info", arguments: {} },
            }) + "\n"
          );
          child.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: { name: "obsidian_vault_info", arguments: {} },
            }) + "\n"
          );
          child.stdin.end();
        });
        assert.equal(mcpOut.length, 3, `${label} MCP must return 3 responses`);
        const initRes = mcpOut[0].result as { serverInfo?: { version?: string } };
        assert.equal(initRes?.serverInfo?.version, "0.3.1", `${label} MCP serverInfo.version`);
        const errObj = mcpOut[1].error as { code?: number; message?: string } | undefined;
        assert.ok(errObj && /timed out/i.test(String(errObj.message ?? "")), `${label} MCP call 1 must return timeout JSON-RPC error`);
        const okRes = mcpOut[2].result as { content?: Array<{ text?: string }> } | undefined;
        assert.ok(okRes?.content?.[0]?.text?.includes("pong"), `${label} MCP call 2 must succeed after timeout`);
      }
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("B5: metadata.graph_neighbors excludes node_modules, .git, configDir, and user-ignored paths", async () => {
    const tmpDir = makeTempDir("fix-b5-");
    try {
      const mockApp = createMockObsidianApp(tmpDir, "GraphVault");
      await mockApp.vault.create("README.md", "# Readme");
      await mockApp.vault.create("good.md", "# Good");

      // Override metadataCache with ignored outgoing & incoming links
      Object.defineProperty(mockApp.metadataCache, "resolvedLinks", {
        get: () => ({
          "README.md": {
            "good.md": 1,
            "node_modules/ms/license.md": 1,
            ".git/HEAD": 1,
            ".obsidian/plugins/herdr-obs/README.md": 1,
            "ignored-dir/secret.md": 1,
          },
          "good.md": { "README.md": 1 },
          "node_modules/pkg/doc.md": { "README.md": 2 },
          ".obsidian/workspace.md": { "README.md": 1 },
          "ignored-dir/other.md": { "README.md": 1 },
        }),
      });
      (mockApp.metadataCache as unknown as { isUserIgnored?: (p: string) => boolean }).isUserIgnored =
        (p: string) => p.startsWith("ignored-dir/");

      const ops = new VaultOpsService({
        app: mockApp as unknown as App,
        getPermissionMode: () => "read-only",
        getAllowUiControl: () => false,
        getAllowUiInProtectedAreas: () => false,
        getAllowHiddenReads: () => false,
        onAuditChanged: () => undefined,
      });

      const graph = (await ops.dispatch(
        "metadata.graph_neighbors",
        { path: "README.md" },
        "test-b5"
      )) as {
        outgoing: Array<{ path: string }>;
        incoming: Array<{ sourcePath: string }>;
      };

      assert.deepEqual(
        graph.outgoing.map((x) => x.path),
        ["good.md"]
      );
      assert.deepEqual(
        graph.incoming.map((x) => x.sourcePath),
        ["good.md"]
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("B6: UiControlService.dispose() detaches active focus shield and cancels in-flight waitFor immediately", async () => {
    let shieldDetached = false;
    const win = {
      innerWidth: 1280,
      innerHeight: 800,
      devicePixelRatio: 1,
      setTimeout,
      clearTimeout,
      document: {
        body: { innerText: "" },
        querySelectorAll: () => [],
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    } as unknown as Window;

    const svc = new UiControlService({
      win,
      getWebContents: () => null,
    });

    // Attach a mock active focus shield directly to verify immediate teardown
    (svc as unknown as { activeShield: { detach: (() => void) | null } | null }).activeShield = {
      detach: () => {
        shieldDetached = true;
      },
    };

    const started = Date.now();
    const waitPromise = svc.waitFor({ text: "never-appears", timeoutMs: 15000 }, "test-b6");
    setTimeout(() => {
      (svc as unknown as { dispose?: () => void }).dispose?.();
    }, 30);

    await assert.rejects(
      () => waitPromise,
      (err: unknown) => err instanceof Error && /dispos/i.test(err.message)
    );
    const elapsed = Date.now() - started;
    assert.equal(shieldDetached, true, "dispose() must detach active focus shield");
    assert.ok(elapsed < 1500, `dispose() must cancel waitFor promptly, took ${elapsed}ms`);
  });

  it("B7: ui inspect marks protected elements with protected: true and sorts them after normal elements", () => {
    const titlebar = makeFakeElement({ tag: "div", classes: ["titlebar"] });
    const closeBtn = makeFakeElement({
      tag: "div",
      label: "Close window",
      classes: ["titlebar-button", "mod-close"],
      parent: titlebar,
    });
    const normalBtn = makeFakeElement({
      tag: "button",
      label: "New note",
      text: "New note",
    });

    const win = {
      innerWidth: 1280,
      innerHeight: 800,
      devicePixelRatio: 1,
      document: {
        body: { innerText: "New note" },
        querySelectorAll: () => [closeBtn, normalBtn],
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    } as unknown as Window;

    const svc = new UiControlService({
      win,
      getWebContents: () => null,
    });

    const res = svc.inspect({ limit: 10 }) as {
      elements: Array<InspectedElement & { protected?: boolean }>;
    };
    assert.equal(res.elements.length, 2);
    assert.equal(res.elements[0].label, "New note");
    assert.equal(res.elements[0].protected, undefined);
    assert.equal(res.elements[1].label, "Close window");
    assert.equal(res.elements[1].protected, true);
  });

  it("B8: pruneStaleRuntimeKits removes only dead/stale kits and preserves keepDigest, live sockets, valid vaults, recent empties, and symlinks", async () => {
    const tmpBase = makeTempDir("fix-b8-base-");
    const validVault = makeTempDir("fix-b8-vault-");
    const symlinkTarget = makeTempDir("fix-b8-target-");
    let liveServer: net.Server | null = null;
    try {
      // 1. keepDigest (even with missing vaultPath -> must keep)
      const keepDir = path.join(tmpBase, "aaaaaaaaaaaa");
      fs.mkdirSync(keepDir);
      fs.writeFileSync(
        path.join(keepDir, "connection.json"),
        JSON.stringify({ vaultPath: path.join(tmpBase, "gone-keep") })
      );

      // 2. Stale missing vaultPath, no live socket -> must remove
      const staleMissing = path.join(tmpBase, "bbbbbbbbbbbb");
      fs.mkdirSync(staleMissing);
      fs.writeFileSync(
        path.join(staleMissing, "connection.json"),
        JSON.stringify({ vaultPath: path.join(tmpBase, "does-not-exist") })
      );

      // 3. Stale kit dir with bin/ signature, no connection.json, older than 7 days -> must remove
      const staleOldWithBin = path.join(tmpBase, "cccccccccccc");
      fs.mkdirSync(path.join(staleOldWithBin, "bin"), { recursive: true });
      fs.writeFileSync(path.join(staleOldWithBin, "bin", "obs-herdr-core.mjs"), "// stub\n");
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      fs.utimesSync(staleOldWithBin, tenDaysAgo, tenDaysAgo);

      // 3b. Unrelated old folder with a 12-hex name and NO kit signature under tmpBase -> must survive
      const unrelatedOldHex = path.join(tmpBase, "deadbeef1234");
      fs.mkdirSync(unrelatedOldHex);
      fs.utimesSync(unrelatedOldHex, tenDaysAgo, tenDaysAgo);

      // 3c. Non-hex old folder (even if old) -> must survive
      const unrelatedOldNonHex = path.join(tmpBase, "unrelated-old-dir");
      fs.mkdirSync(unrelatedOldNonHex);
      fs.utimesSync(unrelatedOldNonHex, tenDaysAgo, tenDaysAgo);

      // 4. Recent dir (< 7 days) with bin/ signature and no connection.json -> must keep
      const recentEmpty = path.join(tmpBase, "dddddddddddd");
      fs.mkdirSync(path.join(recentEmpty, "bin"), { recursive: true });
      fs.writeFileSync(path.join(recentEmpty, "bin", "obs-herdr-core.py"), "# stub\n");

      // 5. Valid existing vaultPath -> must keep
      const validKit = path.join(tmpBase, "eeeeeeeeeeee");
      fs.mkdirSync(validKit);
      fs.writeFileSync(
        path.join(validKit, "connection.json"),
        JSON.stringify({ vaultPath: validVault })
      );

      // 6. Missing vaultPath BUT live b.sock listening -> must keep
      const liveKit = path.join(tmpBase, "ffffffffffff");
      fs.mkdirSync(liveKit);
      fs.writeFileSync(
        path.join(liveKit, "connection.json"),
        JSON.stringify({ vaultPath: path.join(tmpBase, "gone-but-live") })
      );
      const liveSockPath = path.join(liveKit, "b.sock");
      liveServer = net.createServer();
      await new Promise<void>((resolve) => liveServer!.listen(liveSockPath, resolve));

      // 7. Symlinked directory -> must NEVER follow or delete
      const linkDir = path.join(tmpBase, "111111111111");
      fs.symlinkSync(symlinkTarget, linkDir);

      const pruneFn = (
        runtimeKit as unknown as {
          pruneStaleRuntimeKits?: (opts: {
            baseDir?: string;
            keepDigest: string;
          }) => Promise<{ removed: string[] }>;
        }
      ).pruneStaleRuntimeKits;
      assert.equal(typeof pruneFn, "function", "pruneStaleRuntimeKits must be exported");

      const result = await pruneFn!({ baseDir: tmpBase, keepDigest: "aaaaaaaaaaaa" });
      assert.deepEqual(result.removed.sort(), ["bbbbbbbbbbbb", "cccccccccccc"]);
      assert.equal(fs.existsSync(staleMissing), false);
      assert.equal(fs.existsSync(staleOldWithBin), false);
      assert.equal(fs.existsSync(unrelatedOldHex), true, "12-hex old dir without kit signature must survive");
      assert.equal(fs.existsSync(unrelatedOldNonHex), true, "non-hex old dir must survive");
      assert.equal(fs.existsSync(keepDir), true);
      assert.equal(fs.existsSync(recentEmpty), true);
      assert.equal(fs.existsSync(validKit), true);
      assert.equal(fs.existsSync(liveKit), true);
      assert.equal(fs.lstatSync(linkDir).isSymbolicLink(), true);
      assert.equal(fs.existsSync(symlinkTarget), true);
    } finally {
      if (liveServer) {
        await new Promise<void>((resolve) => liveServer!.close(() => resolve()));
      }
      fs.rmSync(tmpBase, { recursive: true, force: true });
      fs.rmSync(validVault, { recursive: true, force: true });
      fs.rmSync(symlinkTarget, { recursive: true, force: true });
    }
  });
});
