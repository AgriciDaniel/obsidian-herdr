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

  it("C2: ui.select chooses <select> option by value or label, dispatches input+change, honors protected areas & cursor, works in ui.batch, CLI (Node+Python), and MCP", async () => {
    const events: string[] = [];
    const cursorEvents: Array<{ action: string; label?: string }> = [];

    const makeOption = (value: string, text: string, disabled = false) => ({
      tagName: "OPTION",
      value,
      label: text,
      textContent: text,
      disabled,
      selected: false,
    });

    const makeSelect = (opts: {
      id: string;
      options: ReturnType<typeof makeOption>[];
      initialValue: string;
      rect?: { x: number; y: number; width: number; height: number };
      parent?: Record<string, unknown> | null;
    }) => {
      let currentValue = opts.initialValue;
      for (const o of opts.options) o.selected = o.value === currentValue;
      const el = makeFakeElement({
        tag: "select",
        label: opts.id,
        text: opts.options.map((o) => o.textContent).join(" "),
        classes: ["dropdown"],
        rect: opts.rect,
        parent: opts.parent ?? null,
      });
      Object.defineProperty(el, "value", {
        get: () => currentValue,
        set: (v: string) => {
          currentValue = String(v);
          for (const o of opts.options) o.selected = o.value === currentValue;
        },
        enumerable: true,
      });
      el.options = opts.options;
      el.selectedIndex = 0;
      el.dispatchEvent = (ev: { type?: string }) => {
        events.push(`${opts.id}:${ev?.type ?? "unknown"}`);
        return true;
      };
      return el;
    };

    const normalSelect = makeSelect({
      id: "runtime-select",
      options: [
        makeOption("claude", "Claude Code"),
        makeOption("codex", "Codex CLI"),
        makeOption("agy", "Antigravity"),
      ],
      initialValue: "claude",
      rect: { x: 10, y: 10, width: 120, height: 28 },
    });

    const settingsModal = makeFakeElement({ tag: "div", classes: ["modal", "mod-settings"] });
    const protectedSelect = makeSelect({
      id: "protected-select",
      options: [makeOption("a", "Alpha"), makeOption("b", "Beta")],
      initialValue: "a",
      rect: { x: 10, y: 100, width: 120, height: 28 },
      parent: settingsModal,
    });

    const plainBtn = makeFakeElement({
      tag: "button",
      label: "Not a select",
      text: "Click",
      rect: { x: 10, y: 200, width: 120, height: 28 },
    });

    const allTestEls = [normalSelect, protectedSelect, plainBtn];
    const bySelector: Record<string, unknown[]> = {
      "#runtime-select": [normalSelect],
      "#protected-select": [protectedSelect],
      "#plain-btn": [plainBtn],
    };

    const win = {
      innerWidth: 1280,
      innerHeight: 800,
      devicePixelRatio: 1,
      setTimeout,
      clearTimeout,
      Event: class FakeEvent {
        readonly type: string;
        readonly bubbles: boolean;
        constructor(type: string, init?: { bubbles?: boolean }) {
          this.type = type;
          this.bubbles = Boolean(init?.bubbles);
        }
      },
      document: {
        body: { innerText: "" },
        querySelectorAll: (sel: string) => bySelector[sel] ?? [],
        elementFromPoint: (x: number, y: number) =>
          allTestEls.find((e) => {
            const r = (e.getBoundingClientRect as () => { left: number; right: number; top: number; bottom: number })();
            return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
          }) ?? null,
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    } as unknown as Window;

    const fakeOverlay = {
      pulseClick: (
        _caller: string,
        label: string,
        _x: number,
        _y: number,
        action = "clicking"
      ) => {
        cursorEvents.push({ action, label });
      },
      moveTo: (
        _caller: string,
        label: string,
        _x: number,
        _y: number,
        action = "moving"
      ) => {
        cursorEvents.push({ action, label });
      },
      whenSettled: () => Promise.resolve(),
      exitAgent: () => undefined,
    };

    const svc = new UiControlService({
      win,
      getWebContents: () => ({
        capturePage: async () => ({ toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 1, height: 1 }) }),
        sendInputEvent: () => undefined,
        insertText: async () => undefined,
      }),
      sleep: async () => undefined,
      cursorOverlay: fakeOverlay as unknown as never,
    });

    const selectFn = (
      svc as unknown as {
        select?: (params: Record<string, unknown>, caller?: string) => Promise<Record<string, unknown>>;
      }
    ).select;
    assert.equal(typeof selectFn, "function", "UiControlService.select must exist");

    // 1. Select by value
    const res1 = await selectFn!.call(
      svc,
      { target: { selector: "#runtime-select" }, value: "codex" },
      "test-c2"
    );
    assert.equal(res1.selected, true);
    assert.equal(res1.value, "codex");
    assert.equal(res1.label, "Codex CLI");
    assert.equal(res1.previousValue, "claude");
    assert.equal(normalSelect.value, "codex");
    assert.deepEqual(events, ["runtime-select:input", "runtime-select:change"]);
    assert.ok(cursorEvents.length > 0, "select must move/show the cursor overlay");

    // 2. Select by label
    events.length = 0;
    const res2 = await selectFn!.call(
      svc,
      { target: { selector: "#runtime-select" }, label: "Antigravity" },
      "test-c2"
    );
    assert.equal(res2.value, "agy");
    assert.equal(res2.label, "Antigravity");
    assert.deepEqual(events, ["runtime-select:input", "runtime-select:change"]);

    // 3. Batch step {"action": "select", ...}
    events.length = 0;
    const batchRes = (await svc.batch(
      {
        steps: [
          { action: "select", target: { selector: "#runtime-select" }, value: "claude" },
        ],
      },
      "test-c2"
    )) as { completed: boolean; results: Array<Record<string, unknown>> };
    assert.equal(batchRes.completed, true);
    assert.equal(batchRes.results[0].value, "claude");
    assert.deepEqual(events, ["runtime-select:input", "runtime-select:change"]);

    // 4. Protected <select> refused with ui_protected_area
    events.length = 0;
    await assert.rejects(
      () => selectFn!.call(svc, { target: { selector: "#protected-select" }, value: "b" }, "test-c2"),
      (err: { code?: string }) => err?.code === "ui_protected_area"
    );
    assert.equal(protectedSelect.value, "a");
    assert.deepEqual(events, []);

    // 5. Non-<select> target fails clearly
    await assert.rejects(
      () => selectFn!.call(svc, { target: { selector: "#plain-btn" }, value: "x" }, "test-c2"),
      /select/i
    );

    // 6. CLI (Node + Python) and MCP exposure
    const tmpDir = makeTempDir("fix-c2-");
    let server: net.Server | null = null;
    try {
      const kit = runtimeKit.computeRuntimePaths(path.join(tmpDir, "v"), tmpDir);
      runtimeKit.provisionRuntimeKit({
        kit,
        token: "b".repeat(64),
        vaultName: "SelectVault",
        vaultPath: tmpDir,
        pluginVersion: "0.3.2",
      });
      const seenRpc: Array<{ method: string; params: Record<string, unknown> }> = [];
      server = net.createServer((sock) => {
        let buf = "";
        sock.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl === -1) return;
          const req = JSON.parse(buf.slice(0, nl)) as {
            id: string;
            method: string;
            params: Record<string, unknown>;
          };
          seenRpc.push({ method: req.method, params: req.params });
          sock.end(
            JSON.stringify({
              id: req.id,
              ok: true,
              result: { selected: true, value: req.params.value ?? "codex", label: req.params.label ?? "Codex CLI" },
            }) + "\n"
          );
        });
      });
      await new Promise<void>((resolve) => server!.listen(kit.socketPath, resolve));

      const coreMjs = path.join(kit.binDir, "obs-herdr-core.mjs");
      const corePy = path.join(kit.binDir, "obs-herdr-core.py");
      const baseEnv = { ...process.env, OBSIDIAN_HERDR_CONNECTION_FILE: kit.connectionFilePath };

      for (const [label, bin, args] of [
        ["node", process.execPath, [coreMjs]],
        ["python", "python3", [corePy]],
      ] as Array<[string, string, string[]]>) {
        const help = await execFileAsync(bin, [...args, "ui", "select", "--help"], { env: baseEnv });
        assert.ok(help.stdout.includes("obs-herdr ui select"), `${label} ui select --help`);

        const outVal = await execFileAsync(
          bin,
          [...args, "ui", "select", "--selector", "#runtime-select", "--value", "codex"],
          { env: baseEnv }
        );
        assert.equal(JSON.parse(outVal.stdout).value, "codex");

        const outLabel = await execFileAsync(
          bin,
          [...args, "ui", "select", "--selector", "#runtime-select", "--label", "Codex CLI"],
          { env: baseEnv }
        );
        assert.equal(JSON.parse(outLabel.stdout).label, "Codex CLI");

        // MCP exposes obsidian_select
        const mcpTools = await new Promise<Array<{ name: string }>>((resolve, reject) => {
          const child = spawn(bin, [...args, "mcp"], { env: baseEnv });
          let rem = "";
          let tools: Array<{ name: string }> = [];
          child.stdout.on("data", (d) => {
            rem += d.toString("utf8");
            let idx = rem.indexOf("\n");
            while (idx !== -1) {
              const ln = rem.slice(0, idx).trim();
              rem = rem.slice(idx + 1);
              if (ln) {
                const msg = JSON.parse(ln) as { id?: number; result?: { tools?: Array<{ name: string }> } };
                if (msg.id === 2 && msg.result?.tools) tools = msg.result.tools;
              }
              idx = rem.indexOf("\n");
            }
          });
          child.on("error", reject);
          child.on("close", () => resolve(tools));
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
          child.stdin.end();
        });
        assert.ok(
          mcpTools.some((t) => t.name === "obsidian_select"),
          `${label} MCP must expose obsidian_select`
        );
      }

      assert.equal(seenRpc.filter((r) => r.method === "ui.select").length, 4);
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Part 2 (Enter quirk): ui.batch with press_key Enter between type steps inserts newlines and never swallows subsequent text in a textarea", async () => {
    const docListeners = new Map<string, Set<(ev: unknown) => void>>();
    const dispatchDocEvent = (ev: Record<string, unknown>): boolean => {
      let prevented = false;
      const fullEv = {
        isTrusted: true,
        ...ev,
        preventDefault: () => {
          prevented = true;
        },
        stopImmediatePropagation: () => undefined,
        stopPropagation: () => undefined,
      };
      for (const fn of Array.from(docListeners.get(String(ev.type)) ?? [])) {
        fn(fullEv);
      }
      return !prevented;
    };

    const modal = makeFakeElement({ tag: "div", classes: ["modal"] });
    const textarea = makeFakeElement({
      tag: "textarea",
      label: "Initial prompt",
      rect: { x: 20, y: 20, width: 300, height: 100 },
      parent: modal,
    });
    textarea.value = "";
    textarea.selectionStart = 0;
    textarea.selectionEnd = 0;
    textarea.focus = () => {
      (win.document as unknown as { activeElement: unknown }).activeElement = textarea;
    };

    const prevHost = makeFakeElement({ tag: "div", classes: ["workspace"] });

    const win = {
      innerWidth: 1280,
      innerHeight: 800,
      devicePixelRatio: 1,
      setTimeout,
      clearTimeout,
      document: {
        activeElement: prevHost,
        body: { innerText: "" },
        querySelectorAll: (sel: string) => (sel === "#prompt-area" ? [textarea] : []),
        elementFromPoint: () => textarea,
        addEventListener: (type: string, fn: (ev: unknown) => void) => {
          if (!docListeners.has(type)) docListeners.set(type, new Set());
          docListeners.get(type)!.add(fn);
        },
        removeEventListener: (type: string, fn: (ev: unknown) => void) => {
          docListeners.get(type)?.delete(fn);
        },
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    } as unknown as Window;

    const svc = new UiControlService({
      win,
      getWebContents: () => ({
        capturePage: async () => ({ toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 1, height: 1 }) }),
        sendInputEvent: (ev: Record<string, unknown>) => {
          if (ev.type === "mouseDown") {
            (textarea.focus as () => void)();
          } else if (ev.type === "keyDown" && ev.keyCode === "Return") {
            dispatchDocEvent({ type: "keydown", key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
          } else if (ev.type === "char" && ev.keyCode === "\r") {
            const kpOk = dispatchDocEvent({ type: "keypress", key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
            if (kpOk) {
              const biOk = dispatchDocEvent({ type: "beforeinput", inputType: "insertLineBreak", data: null });
              if (biOk) {
                textarea.value = String(textarea.value) + "\n";
                textarea.selectionStart = String(textarea.value).length;
                textarea.selectionEnd = String(textarea.value).length;
              }
            }
          }
        },
        insertText: async (chunk: string) => {
          const ok = dispatchDocEvent({ type: "beforeinput", inputType: "insertText", data: chunk });
          if (ok) {
            textarea.value = String(textarea.value) + chunk;
            textarea.selectionStart = String(textarea.value).length;
            textarea.selectionEnd = String(textarea.value).length;
          }
        },
      }),
      sleep: async () => undefined,
      getUiTypingSpeed: () => "fast",
    });

    await svc.batch(
      {
        steps: [
          { action: "click", target: { selector: "#prompt-area" } },
          { action: "type", text: "Line one." },
          { action: "press_key", key: "Enter" },
          { action: "type", text: "Line two." },
          { action: "press_key", key: "Enter" },
          { action: "type", text: "Reply else." },
        ],
      },
      "test-enter"
    );

    assert.equal(textarea.value, "Line one.\nLine two.\nReply else.");
  });

  it("R3-B1: concurrent vault.rename_note calls ref-count alwaysUpdateLinks so original value restores only after last finishes", async () => {
    const tmpDir = makeTempDir("fix-r3b1-");
    try {
      const mockApp = createMockObsidianApp(tmpDir, "ConcurrentRenameVault");
      await mockApp.vault.create("a.md", "# A");
      await mockApp.vault.create("b.md", "# B");

      const vaultAny = mockApp.vault as unknown as { config: Record<string, unknown> };
      vaultAny.config = { alwaysUpdateLinks: false };

      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((r) => {
        releaseFirst = r;
      });
      let firstStarted!: () => void;
      const firstEntered = new Promise<void>((r) => {
        firstStarted = r;
      });
      let releaseSecond!: () => void;
      const secondGate = new Promise<void>((r) => {
        releaseSecond = r;
      });
      let secondStarted!: () => void;
      const secondEntered = new Promise<void>((r) => {
        secondStarted = r;
      });
      let observedAfterFirstFinished: unknown = "unset";

      const origRename = mockApp.fileManager.renameFile;
      mockApp.fileManager.renameFile = async (file: TFile, newPath: string) => {
        if (file.path === "a.md") {
          firstStarted();
          await firstGate;
        } else if (file.path === "b.md") {
          secondStarted();
          await secondGate;
          observedAfterFirstFinished = vaultAny.config.alwaysUpdateLinks;
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

      const p1 = ops.dispatch("vault.rename_note", { path: "a.md", newPath: "a2.md" }, "test");
      await firstEntered;
      const p2 = ops.dispatch("vault.rename_note", { path: "b.md", newPath: "b2.md" }, "test");
      await secondEntered;
      releaseFirst();
      await p1;
      releaseSecond();
      await p2;

      assert.equal(
        observedAfterFirstFinished,
        true,
        "alwaysUpdateLinks must stay true while second concurrent rename is still running"
      );
      assert.equal(
        vaultAny.config.alwaysUpdateLinks,
        false,
        "alwaysUpdateLinks must restore to original value once all renames finish"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("R3-B2: trashFileVerified catches throwing fileManager.trashFile, falls back to vault.trash, fixes audit summary, and includes original error on trash_failed", async () => {
    const tmpDir = makeTempDir("fix-r3b2-");
    try {
      const mockApp = createMockObsidianApp(tmpDir, "TrashThrowVault");
      await mockApp.vault.create("throw-fallback.md", "body");
      await mockApp.vault.create("throw-both.md", "body");

      mockApp.fileManager.trashFile = async () => {
        throw new Error("XDG_TRASH_BROKEN");
      };

      const ops = new VaultOpsService({
        app: mockApp as unknown as App,
        getPermissionMode: () => "full",
        getAllowUiControl: () => false,
        getAllowUiInProtectedAreas: () => false,
        getAllowHiddenReads: () => false,
        onAuditChanged: () => undefined,
      });

      const res = (await ops.dispatch(
        "vault.trash_note",
        { path: "throw-fallback.md" },
        "test-r3b2"
      )) as { trashed: boolean; method: string };
      assert.equal(res.trashed, true);
      assert.equal(res.method, "local");
      const lastAudit = ops.getAuditLog()[0];
      assert.match(lastAudit.summary, /Vault\.trash/i, "local fallback audit summary must name Vault.trash");

      (mockApp.vault as unknown as { trash: () => Promise<void> }).trash = async () => {
        throw new Error("LOCAL_TRASH_DENIED");
      };
      await assert.rejects(
        () => ops.dispatch("vault.trash_note", { path: "throw-both.md" }, "test-r3b2"),
        (err: unknown) =>
          err instanceof BridgeRpcError &&
          err.code === "trash_failed" &&
          /XDG_TRASH_BROKEN/.test(err.message)
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("R3-B3: UiControlService rejects both queued and newly invoked actions after dispose()", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let secondRan = false;

    const btn = makeFakeElement({ tag: "button", label: "Go", rect: { x: 10, y: 10, width: 60, height: 24 } });
    const win = {
      innerWidth: 1280,
      innerHeight: 800,
      devicePixelRatio: 1,
      setTimeout,
      clearTimeout,
      document: {
        body: { innerText: "" },
        querySelectorAll: () => [btn],
        elementFromPoint: () => btn,
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    } as unknown as Window;

    let clickCalls = 0;
    const svc = new UiControlService({
      win,
      getWebContents: () => ({
        capturePage: async () => ({ toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 1, height: 1 }) }),
        sendInputEvent: (ev: Record<string, unknown>) => {
          if (ev.type === "mouseDown") {
            clickCalls += 1;
            if (clickCalls >= 2) secondRan = true;
          }
        },
        insertText: async () => undefined,
      }),
      sleep: async () => {
        if (clickCalls === 1) await firstGate;
      },
    });

    const p1 = svc.click({ target: { selector: "#go" } }, "a1");
    const p2 = svc.click({ target: { selector: "#go" } }, "a2");
    svc.dispose();
    releaseFirst();

    await p1.catch(() => undefined);
    await assert.rejects(() => p2, (err: { code?: string }) => err?.code === "ui_unavailable");
    assert.equal(secondRan, false, "queued action must not execute after dispose()");

    await assert.rejects(
      () => svc.click({ target: { selector: "#go" } }, "a3"),
      (err: { code?: string }) => err?.code === "ui_unavailable"
    );
  });

  it("R3-B4, R3-B5, R3-B6: prune probes connection.json socketPath, timeout clamps to [1000, 600000] ms, Python pipe uses timed thread", async () => {
    const tmpBase = makeTempDir("fix-r3b4-");
    let liveSrv: net.Server | null = null;
    try {
      // R3-B4: live socket referenced via connection.json socketPath (not b.sock) keeps kit alive
      const customSockPath = path.join(tmpBase, "alt-live.sock");
      liveSrv = net.createServer();
      await new Promise<void>((resolve) => liveSrv!.listen(customSockPath, resolve));

      const kitDir = path.join(tmpBase, "1234567890ab");
      fs.mkdirSync(kitDir);
      fs.writeFileSync(
        path.join(kitDir, "connection.json"),
        JSON.stringify({ socketPath: customSockPath, vaultPath: path.join(tmpBase, "gone-vault") })
      );

      const pruned = await runtimeKit.pruneStaleRuntimeKits({
        baseDir: tmpBase,
        keepDigest: "ffffffffffff",
      });
      assert.deepEqual(pruned.removed, [], "kit with live connection.json socketPath must not be pruned");
      assert.equal(fs.existsSync(kitDir), true);

      // R3-B5 & R3-B6: timeout clamping to >= 1000ms (and <= 600000ms) + Python threading timeout for Windows pipes
      const kit = runtimeKit.computeRuntimePaths(path.join(tmpBase, "v"), tmpBase);
      runtimeKit.provisionRuntimeKit({
        kit,
        token: "c".repeat(64),
        vaultName: "ClampVault",
        vaultPath: tmpBase,
        pluginVersion: "0.3.2",
      });
      const pySrc = fs.readFileSync(path.join(kit.binDir, "obs-herdr-core.py"), "utf8");
      assert.ok(pySrc.includes("threading.Thread") && pySrc.includes(".join("), "Python Windows pipe read must enforce timeout via thread join");

      const hangSocks = new Set<net.Socket>();
      const hangSrv = net.createServer((sock) => {
        hangSocks.add(sock);
        sock.on("close", () => hangSocks.delete(sock));
      });
      await new Promise<void>((resolve) => hangSrv.listen(kit.socketPath, resolve));
      try {
        const coreMjs = path.join(kit.binDir, "obs-herdr-core.mjs");
        const corePy = path.join(kit.binDir, "obs-herdr-core.py");
        const env = { ...process.env, OBSIDIAN_HERDR_CONNECTION_FILE: kit.connectionFilePath, OBS_HERDR_TIMEOUT_MS: "50" };
        for (const [bin, args] of [
          [process.execPath, [coreMjs]],
          ["python3", [corePy]],
        ] as Array<[string, string[]]>) {
          await assert.rejects(
            () => execFileAsync(bin, [...args, "rpc", "test.hang", "{}"], { env, timeout: 4000 }),
            (err: { stderr?: string }) => /1000 ms/.test(String(err.stderr ?? ""))
          );
        }
      } finally {
        for (const s of hangSocks) s.destroy();
        hangSrv.closeAllConnections?.();
        await new Promise<void>((resolve) => hangSrv.close(() => resolve()));
      }
    } finally {
      if (liveSrv) {
        liveSrv.closeAllConnections?.();
        await new Promise<void>((resolve) => liveSrv!.close(() => resolve()));
      }
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("R3-B7: ui.select refuses an option inside a disabled <optgroup>", async () => {
    const optgroup = makeFakeElement({ tag: "optgroup" });
    optgroup.disabled = true;
    const disabledGroupOpt = {
      tagName: "OPTION",
      value: "blocked-opt",
      label: "Blocked Opt",
      textContent: "Blocked Opt",
      disabled: false,
      selected: false,
      parentElement: optgroup,
      closest: (sel: string) => (sel.includes("optgroup") && sel.includes("disabled") ? optgroup : null),
    };
    const selectEl = makeFakeElement({
      tag: "select",
      rect: { x: 10, y: 10, width: 120, height: 28 },
    });
    selectEl.value = "ok";
    selectEl.options = [
      { tagName: "OPTION", value: "ok", label: "OK", textContent: "OK", disabled: false, selected: true },
      disabledGroupOpt,
    ];
    selectEl.dispatchEvent = () => true;

    const win = {
      innerWidth: 1280,
      innerHeight: 800,
      devicePixelRatio: 1,
      setTimeout,
      clearTimeout,
      document: {
        body: { innerText: "" },
        querySelectorAll: () => [selectEl],
        elementFromPoint: () => selectEl,
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    } as unknown as Window;

    const svc = new UiControlService({
      win,
      getWebContents: () => ({
        capturePage: async () => ({ toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 1, height: 1 }) }),
        sendInputEvent: () => undefined,
        insertText: async () => undefined,
      }),
      sleep: async () => undefined,
    });

    await assert.rejects(
      () => svc.select({ target: { selector: "#s" }, value: "blocked-opt" }, "test-r3b7"),
      (err: { code?: string }) => err?.code === "ui_option_disabled"
    );
  });

  it("MC redesign: confirmAction resolves true on confirm (with danger warning), false on cancel, and false on Escape/close", async () => {
    const tmpDir = makeTempDir("fix-mc-confirm-");
    try {
      const stubPath = path.join(tmpDir, "obsidian-modal-stub.js");
      fs.writeFileSync(
        stubPath,
        [
          "const instances = (globalThis.__mcModalInstances = globalThis.__mcModalInstances || []);",
          "exports.__instances = instances;",
          "class FakeEl {",
          "  constructor() { this.classes = []; this.children = []; this.text = ''; }",
          "  empty() { this.children = []; }",
          "  addClass(...cls) { this.classes.push(...cls); }",
          "  createEl(tag, opts) { const el = { tag, ...(opts || {}) }; this.children.push(el); return el; }",
          "}",
          "class Modal {",
          "  constructor(app) {",
          "    this.app = app;",
          "    this.contentEl = new FakeEl();",
          "    this.scopeHandlers = {};",
          "    this.scope = { register: (_mods, key, cb) => { this.scopeHandlers[key] = cb; } };",
          "    instances.push(this);",
          "  }",
          "  open() { this.onOpen(); }",
          "  close() { this.onClose(); }",
          "  onOpen() {}",
          "  onClose() {}",
          "}",
          "class Setting {",
          "  constructor(containerEl) { this.containerEl = containerEl; this.buttons = []; containerEl.children.push(this); }",
          "  setName(n) { this.name = n; return this; }",
          "  setDesc(d) { this.desc = d; return this; }",
          "  setHeading() { this.heading = true; return this; }",
          "  addButton(cb) {",
          "    const btn = {",
          "      text: '', classes: [], cta: false, handler: null,",
          "      setButtonText(t) { this.text = t; return this; },",
          "      setClass(c) { this.classes.push(c); return this; },",
          "      setCta() { this.cta = true; return this; },",
          "      onClick(fn) { this.handler = fn; return this; },",
          "    };",
          "    cb(btn);",
          "    this.buttons.push(btn);",
          "    return this;",
          "  }",
          "}",
          "exports.Modal = Modal;",
          "exports.Setting = Setting;",
          "exports.Notice = class Notice { constructor(m) { this.message = m; } };",
        ].join("\n"),
        "utf8"
      );
      const outPath = path.join(tmpDir, "modals.cjs");
      const runnerScript = [
        'const esbuild = require("esbuild");',
        `esbuild.buildSync({ entryPoints: [${JSON.stringify(path.resolve("src/ui/modals.ts"))}], bundle: true, format: "cjs", platform: "node", target: "es2022", outfile: ${JSON.stringify(outPath)}, alias: { obsidian: ${JSON.stringify(stubPath)} } });`,
        `const stub = require(${JSON.stringify(stubPath)});`,
        `const { confirmAction } = require(${JSON.stringify(outPath)});`,
        "(async () => {",
        "  // 1. Confirm with danger: true",
        '  const p1 = confirmAction({}, { title: "Stop session?", body: "All agents stop.", confirmText: "Stop session", danger: true });',
        "  const m1 = stub.__instances[0];",
        "  const btnSetting1 = m1.contentEl.children.find((c) => Array.isArray(c.buttons) && c.buttons.length > 0);",
        '  const confirmBtn1 = btnSetting1.buttons.find((b) => b.text === "Stop session");',
        "  const dangerFlag = confirmBtn1.classes.includes('mod-warning');",
        "  confirmBtn1.handler();",
        "  const r1 = await p1;",
        "  // 2. Cancel button",
        '  const p2 = confirmAction({}, { title: "Confirm", body: "Proceed?", confirmText: "OK" });',
        "  const m2 = stub.__instances[1];",
        "  const btnSetting2 = m2.contentEl.children.find((c) => Array.isArray(c.buttons) && c.buttons.length > 0);",
        '  const cancelBtn2 = btnSetting2.buttons.find((b) => b.text === "Cancel");',
        "  cancelBtn2.handler();",
        "  const r2 = await p2;",
        "  // 3. Escape key",
        '  const p3 = confirmAction({}, { title: "Escape test", body: "Close with Esc", confirmText: "Yes" });',
        "  const m3 = stub.__instances[2];",
        '  m3.scopeHandlers["Escape"]();',
        "  const r3 = await p3;",
        "  process.stdout.write(JSON.stringify({ r1, dangerFlag, r2, r3 }));",
        "})();",
      ].join("\n");
      const out = await execFileAsync(process.execPath, ["-e", runnerScript], { cwd: process.cwd() });
      const parsed = JSON.parse(out.stdout) as {
        r1: boolean;
        dangerFlag: boolean;
        r2: boolean;
        r3: boolean;
      };
      assert.equal(parsed.r1, true, "confirm button must resolve true");
      assert.equal(parsed.dangerFlag, true, "danger: true must apply warning style (mod-warning)");
      assert.equal(parsed.r2, false, "cancel button must resolve false");
      assert.equal(parsed.r3, false, "Escape key must resolve false");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Polish 3: press_key Escape closes an open Obsidian .menu even when Electron sendInputEvent alone does not dismiss it", async () => {
    let menuOpen = true;
    const menuEl = makeFakeElement({
      tag: "div",
      classes: ["menu"],
      rect: { x: 100, y: 100, width: 180, height: 140 },
    });
    menuEl.dispatchEvent = (ev: { type?: string; key?: string }) => {
      if (ev?.type === "keydown" && ev?.key === "Escape") {
        menuOpen = false;
        menuEl.isConnected = false;
      }
      return true;
    };

    const bodyEl = makeFakeElement({
      tag: "body",
      rect: { x: 0, y: 0, width: 1280, height: 800 },
    });
    bodyEl.dispatchEvent = (ev: { type?: string }) => {
      if (ev?.type === "mousedown" || ev?.type === "pointerdown") {
        menuOpen = false;
        menuEl.isConnected = false;
      }
      return true;
    };

    const win = {
      innerWidth: 1280,
      innerHeight: 800,
      devicePixelRatio: 1,
      setTimeout,
      clearTimeout,
      KeyboardEvent: class FakeKeyboardEvent {
        readonly type: string;
        readonly key: string;
        readonly code: string;
        readonly keyCode: number;
        readonly which: number;
        readonly bubbles: boolean;
        readonly cancelable: boolean;
        constructor(type: string, init?: Record<string, unknown>) {
          this.type = type;
          this.key = String(init?.key ?? "");
          this.code = String(init?.code ?? "");
          this.keyCode = Number(init?.keyCode ?? 0);
          this.which = Number(init?.which ?? 0);
          this.bubbles = Boolean(init?.bubbles);
          this.cancelable = Boolean(init?.cancelable);
        }
      },
      MouseEvent: class FakeMouseEvent {
        readonly type: string;
        readonly bubbles: boolean;
        constructor(type: string, init?: Record<string, unknown>) {
          this.type = type;
          this.bubbles = Boolean(init?.bubbles);
        }
      },
      document: {
        activeElement: bodyEl,
        body: bodyEl,
        querySelectorAll: (sel: string) =>
          menuOpen && (sel.includes(".menu") || sel.includes('[role="menu"]')) ? [menuEl] : [],
        elementFromPoint: () => (menuOpen ? menuEl : bodyEl),
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    } as unknown as Window;

    const svc = new UiControlService({
      win,
      getWebContents: () => ({
        capturePage: async () => ({ toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 1, height: 1 }) }),
        // Simulate Electron sendInputEvent not closing the Obsidian Menu on its own
        sendInputEvent: () => undefined,
        insertText: async () => undefined,
      }),
      sleep: async () => undefined,
    });

    await svc.pressKey({ key: "Escape" }, "test-polish3");
    assert.equal(menuOpen, false, "press_key Escape must close an open Obsidian .menu");
  });
});
