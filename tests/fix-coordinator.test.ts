// Tests for the 2026-11-20 review fixes (fix-coordinator). Owned by agyA; see .agent/fix-2026-11-20/.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { computeRuntimePaths, provisionRuntimeKit } from "../src/bridge/runtime-kit";
import { VaultBridgeServer } from "../src/bridge/vault-bridge-server";
import type { AgentInfo, HerdrLayoutNode, HerdrStatusPayload } from "../src/domain/types";
import { HerdrSocketClient } from "../src/herdr/socket-client";
import * as coordModule from "../src/services/herdr-coordinator";
import { HerdrCoordinator } from "../src/services/herdr-coordinator";
import * as ptyHost from "../src/terminal/pty-host";
import { PtySession } from "../src/terminal/pty-host";
import { HerdrDashboardView } from "../src/ui/dashboard-view";
import { findAllNodes, type FakeDomNode } from "./helpers/fake-dom";
import { makeShortTmpDir, skipOnWindows } from "./helpers/portable";
import { __mockMenus, resetObsidianUiMocks } from "./obsidian-mock";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  (globalThis as { window?: unknown }).window = globalThis;
}

// These tests listen on Unix socket files and rely on POSIX file semantics; Windows uses named pipes.
const SKIP_POSIX_SOCKETS = skipOnWindows("Unix socket files and POSIX file semantics");

describe("fix-coordinator: agyA review fixes (A1-A10)", () => {
  it("A1: VaultBridgeServer.stop() never unlinks a socket owned by a newer server", { skip: SKIP_POSIX_SOCKETS }, async () => {
    const dir = makeShortTmpDir("herdr-a1-");
    const sockPath = path.join(dir, "b.sock");
    let srv1: VaultBridgeServer | null = null;
    let srv2: VaultBridgeServer | null = null;
    try {
      srv1 = new VaultBridgeServer({
        socketPath: sockPath,
        dispatcher: async () => ({ ok: true }),
      });
      await srv1.start();

      // Simulate plugin reload: old onunload() fires stop() without awaiting while new onload() starts srv2.
      const stop1 = srv1.stop();
      srv2 = new VaultBridgeServer({
        socketPath: sockPath,
        dispatcher: async () => ({ ok: true }),
      });
      await srv2.start();
      await stop1;

      assert.equal(srv2.isRunning(), true);
      assert.equal(fs.existsSync(sockPath), true, "old stop() must not delete srv2's live socket");
    } finally {
      await srv2?.stop().catch(() => undefined);
      await srv1?.stop().catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A2: VaultBridgeServer removes stray non-socket/dangling symlink only inside kitDir and handles post-listen errors", { skip: SKIP_POSIX_SOCKETS }, async () => {
    const dir = makeShortTmpDir("herdr-a2-");
    const kitDir = path.join(dir, "kit");
    const outsideDir = path.join(dir, "outside");
    fs.mkdirSync(kitDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    const servers: VaultBridgeServer[] = [];

    try {
      // 1. Stray regular file inside kitDir is removed and server starts.
      const strayInside = path.join(kitDir, "b.sock");
      fs.writeFileSync(strayInside, "stray", "utf8");
      const srvInside = new VaultBridgeServer({
        socketPath: strayInside,
        kitDir,
        dispatcher: async () => ({}),
      });
      servers.push(srvInside);
      await srvInside.start();
      assert.equal(srvInside.isRunning(), true);

      // 2. Post-listen error does not crash and marks server not running.
      const internalSrv = (srvInside as unknown as { server: net.Server | null }).server;
      assert.ok(internalSrv, "expected live net.Server");
      const origWarn = console.warn;
      const warnings: unknown[] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args);
      };
      try {
        internalSrv.emit("error", new Error("simulated EMFILE"));
      } finally {
        console.warn = origWarn;
      }
      assert.equal(srvInside.isRunning(), false, "post-listen error should mark bridge not running");
      assert.ok(warnings.length > 0, "post-listen error should log a warning");
      await srvInside.stop();

      // 3. Dangling symlink inside kitDir is removed and server starts.
      const danglingInside = path.join(kitDir, "b-link.sock");
      fs.symlinkSync(path.join(kitDir, "does-not-exist"), danglingInside);
      const srvLink = new VaultBridgeServer({
        socketPath: danglingInside,
        kitDir,
        dispatcher: async () => ({}),
      });
      servers.push(srvLink);
      await srvLink.start();
      assert.equal(srvLink.isRunning(), true);
      await srvLink.stop();

      // 4. Stray non-socket file outside kitDir is NOT removed and fails clearly.
      const strayOutside = path.join(outsideDir, "important.txt");
      fs.writeFileSync(strayOutside, "keep-me", "utf8");
      const srvOutside = new VaultBridgeServer({
        socketPath: strayOutside,
        kitDir,
        dispatcher: async () => ({}),
      });
      servers.push(srvOutside);
      await assert.rejects(srvOutside.start(), /non-socket|kit/i);
      assert.equal(fs.readFileSync(strayOutside, "utf8"), "keep-me");
    } finally {
      for (const s of servers) {
        await s.stop().catch(() => undefined);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A3: HerdrCoordinator.initialize() records lastError and still runs refreshAll(true) when bridge start fails", async () => {
    const refreshCalls: boolean[] = [];
    const coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
    Object.assign(coord as unknown as Record<string, unknown>, {
      disposed: false,
      lastError: null,
      bridgeLastError: null,
      getSettings: () => ({
        herdrBinaryPath: "",
        vaultBridgeEnabled: true,
        vaultPermissionMode: "read-write",
      }),
      cli: { setConfiguredBinary: () => undefined },
      startVaultBridge: async () => {
        throw new Error("simulated bridge EACCES");
      },
      refreshAll: async (diag: boolean) => {
        refreshCalls.push(diag);
      },
      emitChange: () => undefined,
    });

    await coord.initialize();
    assert.deepEqual(refreshCalls, [true], "initialize() must still run refreshAll(true)");
    assert.match(
      String((coord as unknown as { lastError: string | null }).lastError || ""),
      /simulated bridge EACCES/
    );
  });

  it("A4: HerdrCoordinator self-heals deleted socket/CLI while bridgeServer thinks it is running, keeping the same token", { skip: SKIP_POSIX_SOCKETS }, async () => {
    const baseDir = makeShortTmpDir("herdr-a4-");
    let srv: VaultBridgeServer | null = null;
    let coord: HerdrCoordinator | null = null;
    try {
      const kit = computeRuntimePaths("/vault/a4-test", baseDir);
      srv = new VaultBridgeServer({
        socketPath: kit.socketPath,
        kitDir: kit.runtimeDir,
        dispatcher: async () => ({ ok: true }),
      });
      await srv.start();
      const originalToken = srv.getAuthToken();
      provisionRuntimeKit({
        kit,
        token: originalToken,
        vaultName: "A4Vault",
        vaultPath: "/vault/a4-test",
      });

      coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
      Object.assign(coord as unknown as Record<string, unknown>, {
        disposed: false,
        runtimeKit: kit,
        bridgeServer: srv,
        bridgeStartInFlight: null,
        bridgeLastError: null,
        prunedStaleKits: true,
        app: { vault: { getName: () => "A4Vault" } },
        vaultOps: {
          getVaultBasePath: () => "/vault/a4-test",
          dispatch: async () => ({ ok: true }),
        },
        cli: { setCustomEnv: () => undefined },
        getSettings: () => ({
          vaultBridgeEnabled: true,
          vaultPermissionMode: "read-write",
        }),
        listeners: new Set(),
      });

      // Wipe kit files and socket while bridgeServer still reports isRunning() === true.
      fs.unlinkSync(kit.socketPath);
      fs.unlinkSync(kit.cliScriptPath);
      fs.unlinkSync(kit.connectionFilePath);
      assert.equal(srv.isRunning(), true);

      await coord.ensureBridgeReady();

      assert.equal(fs.existsSync(kit.socketPath), true, "socket must be recreated");
      assert.equal(fs.existsSync(kit.cliScriptPath), true, "obs-herdr CLI must be recreated");
      assert.equal(fs.existsSync(kit.connectionFilePath), true, "connection.json must be recreated");
      const activeSrv = (coord as unknown as { bridgeServer: VaultBridgeServer | null }).bridgeServer;
      assert.ok(activeSrv?.isRunning());
      assert.equal(activeSrv?.getAuthToken(), originalToken, "self-heal must preserve the auth token");
    } finally {
      await coord?.stopVaultBridge().catch(() => undefined);
      await srv?.stop().catch(() => undefined);
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("A5: Herdr protocol check warns on unsupported or mismatched protocol without blocking", async () => {
    let statusToReturn: HerdrStatusPayload = {
      client: { version: "0.8.2", channel: "stable", protocol: 20, binary: "/usr/bin/herdr", session: "s" },
      server: { status: "running", running: true, version: "0.9.0", protocol: 21, socket: "/tmp/none.sock", session: "s", restart_needed: true },
    };

    const coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
    Object.assign(coord as unknown as Record<string, unknown>, {
      disposed: false,
      refreshInFlight: null,
      statusPayload: null,
      snapshot: null,
      socketReachable: false,
      sessions: [],
      integrations: [],
      installedPlugins: [],
      worktrees: [],
      lastError: null,
      bridgeLastError: null,
      protocolWarning: null,
      warnedProtocolKey: null,
      lastUpdated: 0,
      bridgeServer: null,
      runtimeKit: computeRuntimePaths("/vault/a5", os.tmpdir()),
      listeners: new Set(),
      previousAgentStates: new Map(),
      app: { vault: { getName: () => "A5Vault" }, workspace: { getActiveFile: () => null } },
      vaultOps: { getVaultBasePath: () => "/vault/a5" },
      cursorOverlay: { reconcileLiveCallers: () => undefined },
      getSettings: () => ({
        defaultSessionName: "s",
        customSocketPath: "",
        autoConnectSocket: false,
        autoReportVaultMetadata: false,
        showOfflinePreviewWhenStopped: false,
        vaultBridgeEnabled: false,
        vaultPermissionMode: "off",
      }),
      cli: {
        getBinaryPath: () => "/usr/bin/herdr",
        getStatus: async () => statusToReturn,
        listSessions: async () => [],
        getIntegrationStatuses: async () => [],
      },
      socket: {
        getSocketPath: () => "/tmp/none.sock",
        setSocketPath: () => undefined,
        isSocketPresent: () => false,
        isSubscribed: () => false,
        stopSubscription: () => undefined,
        getSnapshot: async () => ({
          version: "0.9.0",
          protocol: 21,
          focused_workspace_id: null,
          focused_tab_id: null,
          focused_pane_id: null,
          workspaces: [],
          tabs: [],
          panes: [],
          layouts: [],
          agents: [],
        }),
      },
    });

    await coord.refreshAll(false);
    const stateMismatch = coord.getState() as unknown as { protocolWarning?: string | null };
    assert.ok(stateMismatch.protocolWarning, "expected protocol warning on client/server disagreement");
    assert.match(stateMismatch.protocolWarning, /herdr update --handoff/);
    assert.match(stateMismatch.protocolWarning, /20/);
    assert.match(stateMismatch.protocolWarning, /21/);

    // Matching supported protocol 20 clears the warning.
    statusToReturn = {
      client: { version: "0.8.2", channel: "stable", protocol: 20, binary: "/usr/bin/herdr", session: "s" },
      server: { status: "running", running: true, version: "0.8.2", protocol: 20, socket: "/tmp/none.sock", session: "s", restart_needed: false },
    };
    await coord.refreshAll(false);
    const stateOk = coord.getState() as unknown as { protocolWarning?: string | null };
    assert.equal(stateOk.protocolWarning, null, "supported matching protocol 20 should clear warning");
  });

  it("A6: HerdrCoordinator.emitChange() catches listener errors so subsequent listeners still run", () => {
    const coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
    Object.assign(coord as unknown as Record<string, unknown>, {
      listeners: new Set<() => void>(),
    });

    let secondCalled = false;
    coord.onChange(() => {
      throw new Error("listener exploded");
    });
    coord.onChange(() => {
      secondCalled = true;
    });

    const origWarn = console.warn;
    console.warn = () => undefined;
    try {
      (coord as unknown as { emitChange: () => void }).emitChange();
    } finally {
      console.warn = origWarn;
    }

    assert.equal(secondCalled, true, "second listener must still run after first throws");
  });

  it("A7: HerdrSocketClient.applyLayout() injects bridge env into every leaf pane node", async () => {
    const captured: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = new HerdrSocketClient("/tmp/unused.sock");
    (client as unknown as { request: (m: string, p: Record<string, unknown>) => Promise<unknown> }).request = async (
      method,
      params
    ) => {
      captured.push({ method, params });
      return { layout: { workspace_id: "w1", tab_id: "t1", zoomed: false, focused_pane_id: "w1:p1", root: params.root } };
    };

    const root: HerdrLayoutNode = {
      type: "split",
      direction: "right",
      ratio: 0.5,
      first: { type: "pane", label: "left" },
      second: { type: "pane", label: "right", env: { CUSTOM: "keep", OBSIDIAN_VAULT_NAME: "override" } },
    };

    await (client as unknown as {
      applyLayout: (opts: { root: HerdrLayoutNode; env?: Record<string, string> }) => Promise<unknown>;
    }).applyLayout({
      root,
      env: { PATH: "/kit/bin:/usr/bin", OBSIDIAN_VAULT_NAME: "VaultA" },
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "layout.apply");
    const sentRoot = captured[0].params.root as Extract<HerdrLayoutNode, { type: "split" }>;
    const first = sentRoot.first as Extract<HerdrLayoutNode, { type: "pane" }>;
    const second = sentRoot.second as Extract<HerdrLayoutNode, { type: "pane" }>;
    assert.equal(first.env?.PATH, "/kit/bin:/usr/bin");
    assert.equal(first.env?.OBSIDIAN_VAULT_NAME, "VaultA");
    assert.equal(second.env?.PATH, "/kit/bin:/usr/bin");
    assert.equal(second.env?.CUSTOM, "keep");
    assert.equal(second.env?.OBSIDIAN_VAULT_NAME, "override");
  });

  it("A8: PtySession warns on plain-pipe fallback and HerdrTerminalView falls back for herdr-agent/herdr-remote", async () => {
    if (process.platform !== "win32") {
      const chunks: string[] = [];
      let pty: PtySession | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("PtySession plain-pipe test timed out")), 5000);
          pty = new PtySession({
            command: "/bin/sh",
            args: ["-c", "echo hi"],
            cwd: os.tmpdir(),
            cols: 80,
            rows: 24,
            python3Path: null,
            onData: (chunk) => chunks.push(chunk),
            onExit: () => resolve(),
          });
        });
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
        pty?.dispose();
      }
      const combined = chunks.join("");
      assert.match(combined, /python3|plain pipes|full-screen/i, "expected visible warning when falling back to plain pipes");
    }

    // Check missing-binary fallback helper used by HerdrTerminalView for herdr-vault/herdr-agent/herdr-remote.
    assert.equal(ptyHost.shouldFallbackMissingHerdr("herdr-vault", null), true);
    assert.equal(ptyHost.shouldFallbackMissingHerdr("herdr-agent", null), true);
    assert.equal(ptyHost.shouldFallbackMissingHerdr("herdr-remote", null), true);
    assert.equal(ptyHost.shouldFallbackMissingHerdr("shell", null), false);
    assert.equal(ptyHost.shouldFallbackMissingHerdr("herdr-agent", "/usr/bin/herdr"), false);
  });

  it("A9: splitAndStartAgent aborts waitWhileBlocked promptly via AbortSignal without sending initialPrompt", async () => {
    const prompts: string[] = [];
    let listCalls = 0;
    const blockedAgent = {
      pane_id: "w1:p9",
      name: "claude-a9",
      agent: "claude",
      agent_status: "blocked",
      interactive_ready: false,
      launch_pending: true,
      focused: false,
    } as AgentInfo;

    const coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
    Object.assign(coord as unknown as Record<string, unknown>, {
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
      getActiveSessionName: () => "vault",
      socket: {
        getSocketPath: () => "/sock",
        splitPane: async () => ({ pane_id: "w1:p9" }),
        startAgent: async () => blockedAgent,
        listAgents: async () => {
          listCalls += 1;
          // Exit on 2nd poll if unpatched so pre-fix test fails quickly instead of hanging 120s.
          return listCalls >= 2 ? [] : [blockedAgent];
        },
        promptAgent: async (_t: string, text: string) => {
          prompts.push(text);
        },
      },
    });

    const ac = new AbortController();
    const startedAt = Date.now();
    const abortTimer = setTimeout(() => ac.abort(), 30);

    try {
      await assert.rejects(
        coord.splitAndStartAgent({
          agentName: "claude-a9",
          agentKind: "claude",
          direction: "right",
          initialPrompt: "Do not send me",
          signal: ac.signal,
        }),
        /cancelled/i
      );
      const elapsed = Date.now() - startedAt;
      // Linux keeps the tight bound (an unpatched build waits a full 400 ms settle poll).
      // Shared macOS and Windows CI runners can delay a 30 ms timer by hundreds of ms.
      const abortBoundMs = process.platform === "linux" ? 350 : 1000;
      assert.ok(elapsed < abortBoundMs, `expected prompt abort (<${abortBoundMs}ms), took ${elapsed}ms`);
      assert.deepEqual(prompts, []);
    } finally {
      clearTimeout(abortTimer);
    }
  });

  it("A10: HerdrCoordinator calls pruneStaleRuntimeKits once per load after bridge start and ignores errors", { skip: SKIP_POSIX_SOCKETS }, async () => {
    const baseDir = makeShortTmpDir("herdr-a10-");
    let coord: HerdrCoordinator | null = null;
    try {
      const kit = computeRuntimePaths("/vault/a10-test", baseDir);
      const pruneCalls: Array<{ baseDir?: string; keepDigest: string }> = [];
      coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
      Object.assign(coord as unknown as Record<string, unknown>, {
        disposed: false,
        runtimeKit: kit,
        bridgeServer: null,
        bridgeStartInFlight: null,
        bridgeLastError: null,
        prunedStaleKits: false,
        pruneStaleKitsFn: async (opts: { baseDir?: string; keepDigest: string }) => {
          pruneCalls.push(opts);
          throw new Error("non-fatal prune failure");
        },
        app: { vault: { getName: () => "A10Vault" } },
        vaultOps: {
          getVaultBasePath: () => "/vault/a10-test",
          dispatch: async () => ({}),
        },
        cli: { setCustomEnv: () => undefined },
        listeners: new Set(),
      });

      const origWarn = console.warn;
      console.warn = () => undefined;
      try {
        await coord.startVaultBridge();
        await new Promise((r) => setTimeout(r, 20));
        await coord.stopVaultBridge();
        await coord.startVaultBridge();
        await new Promise((r) => setTimeout(r, 20));
        await coord.stopVaultBridge();
      } finally {
        console.warn = origWarn;
      }

      assert.equal(pruneCalls.length, 1, "pruneStaleRuntimeKits must be called exactly once per plugin load");
      assert.equal(pruneCalls[0].baseDir, path.dirname(kit.runtimeDir));
      assert.equal(pruneCalls[0].keepDigest, path.basename(kit.runtimeDir));
    } finally {
      await coord?.stopVaultBridge().catch(() => undefined);
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("Follow-up 1: HerdrCoordinator passes manifest pluginVersion into provisionRuntimeKit", { skip: SKIP_POSIX_SOCKETS }, async () => {
    const baseDir = makeShortTmpDir("herdr-fu1-");
    let coord: HerdrCoordinator | null = null;
    try {
      const kit = computeRuntimePaths("/vault/fu1-test", baseDir);
      coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
      Object.assign(coord as unknown as Record<string, unknown>, {
        disposed: false,
        pluginVersion: "9.8.7",
        runtimeKit: kit,
        bridgeServer: null,
        bridgeStartInFlight: null,
        bridgeLastError: null,
        prunedStaleKits: true,
        app: { vault: { getName: () => "FU1Vault" } },
        vaultOps: {
          getVaultBasePath: () => "/vault/fu1-test",
          dispatch: async () => ({}),
        },
        cli: { setCustomEnv: () => undefined },
        listeners: new Set(),
      });

      await coord.startVaultBridge();
      const coreMjs = fs.readFileSync(path.join(kit.binDir, "obs-herdr-core.mjs"), "utf8");
      const corePy = fs.readFileSync(path.join(kit.binDir, "obs-herdr-core.py"), "utf8");
      assert.match(coreMjs, /9\.8\.7/, "obs-herdr-core.mjs must embed the real pluginVersion");
      assert.match(corePy, /9\.8\.7/, "obs-herdr-core.py must embed the real pluginVersion");
    } finally {
      await coord?.stopVaultBridge().catch(() => undefined);
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("Follow-up 2: HerdrCoordinator.dispose() calls uiControl.dispose() before stopVaultBridge()", async () => {
    const order: string[] = [];
    const coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
    Object.assign(coord as unknown as Record<string, unknown>, {
      disposed: false,
      debounceTimer: null,
      unsubSocketEvent: null,
      unsubSocketConn: null,
      socket: { dispose: () => order.push("socket.dispose") },
      cursorOverlay: { dispose: () => order.push("cursorOverlay.dispose") },
      uiControl: { dispose: () => order.push("uiControl.dispose") },
      stopVaultBridge: async () => {
        order.push("stopVaultBridge");
      },
      listeners: new Set(),
    });

    await coord.dispose();
    const uiIdx = order.indexOf("uiControl.dispose");
    const bridgeIdx = order.indexOf("stopVaultBridge");
    assert.ok(uiIdx >= 0, "expected uiControl.dispose() to be called");
    assert.ok(bridgeIdx >= 0, "expected stopVaultBridge() to be called");
    assert.ok(uiIdx < bridgeIdx, `expected uiControl.dispose() before stopVaultBridge(), got ${JSON.stringify(order)}`);
  });

  it("C1: splitAndStartAgent waits for settled interactive_ready status, retries once on missed delivery, and errors if undelivered", async () => {
    const makeAgent = (over: Partial<AgentInfo>): AgentInfo =>
      ({
        pane_id: "w1:p5",
        name: "codex-c1",
        agent: "codex",
        agent_status: "unknown",
        interactive_ready: false,
        launch_pending: true,
        focused: false,
        ...over,
      }) as AgentInfo;

    // 1. Waits through unknown -> working -> done before sending prompt, then confirms in pane.
    {
      const timeline: string[] = [];
      let polls = 0;
      let paneText = "codex booting...";
      const coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
      Object.assign(coord as unknown as Record<string, unknown>, {
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
        getActiveSessionName: () => "vault",
        promptSettlePollMs: 10,
        promptConfirmPollMs: 10,
        promptConfirmTimeoutMs: 60,
        socket: {
          getSocketPath: () => "/sock",
          splitPane: async () => ({ pane_id: "w1:p5" }),
          startAgent: async () => {
            timeline.push("start:unknown");
            return makeAgent({ agent_status: "unknown", interactive_ready: false });
          },
          listAgents: async () => {
            polls += 1;
            if (polls === 1) {
              timeline.push("poll:working");
              return [makeAgent({ agent_status: "working", interactive_ready: true, launch_pending: false })];
            }
            timeline.push("poll:done");
            return [makeAgent({ agent_status: "done", interactive_ready: true, launch_pending: false })];
          },
          promptAgent: async (_t: string, text: string) => {
            timeline.push(`prompt:${text}`);
            paneText = `codex> ${text}`;
          },
          readPane: async () => paneText,
        },
      });

      await coord.splitAndStartAgent({
        agentName: "codex-c1",
        agentKind: "codex",
        direction: "right",
        initialPrompt: "PING-OK",
      });
      assert.deepEqual(
        timeline,
        ["start:unknown", "poll:working", "poll:done", "prompt:PING-OK"],
        "must wait for settled status (idle/done) before sending initialPrompt"
      );
    }

    // 2. Retries once when first prompt does not appear in pane, and succeeds when retry appears.
    {
      let promptCount = 0;
      let paneText = "codex> ";
      const coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
      Object.assign(coord as unknown as Record<string, unknown>, {
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
        getActiveSessionName: () => "vault",
        promptSettlePollMs: 10,
        promptConfirmPollMs: 10,
        promptConfirmTimeoutMs: 50,
        socket: {
          getSocketPath: () => "/sock",
          splitPane: async () => ({ pane_id: "w1:p5" }),
          startAgent: async () => makeAgent({ agent_status: "idle", interactive_ready: true, launch_pending: false }),
          listAgents: async () => [makeAgent({ agent_status: "idle", interactive_ready: true, launch_pending: false })],
          promptAgent: async (_t: string, text: string) => {
            promptCount += 1;
            if (promptCount === 2) {
              paneText = `codex> ${text}`;
            }
          },
          readPane: async () => paneText,
        },
      });

      await coord.splitAndStartAgent({
        agentName: "codex-c1",
        agentKind: "codex",
        direction: "right",
        initialPrompt: "RETRY-TOKEN-42",
      });
      assert.equal(promptCount, 2, "must retry promptAgent once when first delivery is not seen in pane");
    }

    // 3. Throws clear error when prompt never appears in pane even after retry.
    {
      let promptCount = 0;
      const coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
      Object.assign(coord as unknown as Record<string, unknown>, {
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
        getActiveSessionName: () => "vault",
        promptSettlePollMs: 10,
        promptConfirmPollMs: 10,
        promptConfirmTimeoutMs: 50,
        socket: {
          getSocketPath: () => "/sock",
          splitPane: async () => ({ pane_id: "w1:p5" }),
          startAgent: async () => makeAgent({ agent_status: "done", interactive_ready: true, launch_pending: false }),
          listAgents: async () => [makeAgent({ agent_status: "done", interactive_ready: true, launch_pending: false })],
          promptAgent: async () => {
            promptCount += 1;
          },
          readPane: async () => "codex> (composer stayed empty)",
        },
      });

      await assert.rejects(
        coord.splitAndStartAgent({
          agentName: "codex-c1",
          agentKind: "codex",
          direction: "right",
          initialPrompt: "NEVER-LANDED",
        }),
        /not delivered/i
      );
      assert.equal(promptCount, 2, "must attempt initial send plus one retry before throwing");
    }

    // 4. Multi-line prompt collapsed to '[Pasted text #1 +3 lines]' and status -> working sends exactly once.
    {
      let promptCount = 0;
      let status: AgentInfo["agent_status"] = "idle";
      let paneText = "claude> ";
      const coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
      Object.assign(coord as unknown as Record<string, unknown>, {
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
        getActiveSessionName: () => "vault",
        promptSettlePollMs: 10,
        promptConfirmPollMs: 10,
        promptConfirmTimeoutMs: 60,
        socket: {
          getSocketPath: () => "/sock",
          splitPane: async () => ({ pane_id: "w1:p5" }),
          startAgent: async () => makeAgent({ name: "claude-c1", agent: "claude", agent_status: "idle", interactive_ready: true, launch_pending: false }),
          listAgents: async () => [makeAgent({ name: "claude-c1", agent: "claude", agent_status: status, interactive_ready: true, launch_pending: false })],
          promptAgent: async () => {
            promptCount += 1;
            paneText = "claude> [Pasted text #1 +3 lines]";
            status = "working";
          },
          readPane: async () => paneText,
        },
      });

      await coord.splitAndStartAgent({
        agentName: "claude-c1",
        agentKind: "claude",
        direction: "right",
        initialPrompt: "Line 1\nLine 2\nLine 3\nLine 4",
      });
      assert.equal(promptCount, 1, "collapsed pasted prompt with working status must send exactly once");
    }

    // 5. Prompt that never shows in pane and status stays idle retries once then errors.
    {
      let promptCount = 0;
      const coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
      Object.assign(coord as unknown as Record<string, unknown>, {
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
        getActiveSessionName: () => "vault",
        promptSettlePollMs: 10,
        promptConfirmPollMs: 10,
        promptConfirmTimeoutMs: 50,
        socket: {
          getSocketPath: () => "/sock",
          splitPane: async () => ({ pane_id: "w1:p5" }),
          startAgent: async () => makeAgent({ name: "claude-idle", agent: "claude", agent_status: "idle", interactive_ready: true, launch_pending: false }),
          listAgents: async () => [makeAgent({ name: "claude-idle", agent: "claude", agent_status: "idle", interactive_ready: true, launch_pending: false })],
          promptAgent: async () => {
            promptCount += 1;
          },
          readPane: async () => "claude> ",
        },
      });

      await assert.rejects(
        coord.splitAndStartAgent({
          agentName: "claude-idle",
          agentKind: "claude",
          direction: "right",
          initialPrompt: "Still never delivered",
        }),
        /not delivered/i
      );
      assert.equal(promptCount, 2, "undelivered prompt with idle status must retry once then throw");
    }
  });

  it("R3-1: self-heal is single-flight and preserves lastKnownBridgeToken even after connection.json is wiped", { skip: SKIP_POSIX_SOCKETS }, async () => {
    const baseDir = makeShortTmpDir("herdr-r3-1-");
    let coord: HerdrCoordinator | null = null;
    try {
      const kit = computeRuntimePaths("/vault/r3-1", baseDir);
      coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
      Object.assign(coord as unknown as Record<string, unknown>, {
        disposed: false,
        runtimeKit: kit,
        bridgeServer: null,
        bridgeStartInFlight: null,
        bridgeHealInFlight: null,
        lastKnownBridgeToken: undefined,
        bridgeLastError: null,
        prunedStaleKits: true,
        app: { vault: { getName: () => "R3-1Vault" } },
        vaultOps: {
          getVaultBasePath: () => "/vault/r3-1",
          dispatch: async () => ({}),
        },
        cli: { setCustomEnv: () => undefined },
        getSettings: () => ({
          vaultBridgeEnabled: true,
          vaultPermissionMode: "read-write",
        }),
        listeners: new Set(),
      });

      await coord.startVaultBridge();
      const firstToken = (coord as unknown as { bridgeServer: VaultBridgeServer | null }).bridgeServer?.getAuthToken();
      assert.ok(firstToken);

      // Wipe connection.json and stop bridgeServer, then restart: must still keep lastKnownBridgeToken.
      fs.unlinkSync(kit.connectionFilePath);
      await coord.stopVaultBridge();
      await coord.startVaultBridge();
      const secondToken = (coord as unknown as { bridgeServer: VaultBridgeServer | null }).bridgeServer?.getAuthToken();
      assert.equal(secondToken, firstToken, "must prefer lastKnownBridgeToken over minting a new token");

      // Concurrent ensureBridgeReady() calls while kit is missing must share one single-flight heal.
      fs.unlinkSync(kit.socketPath);
      let stopCalls = 0;
      const origStop = coord.stopVaultBridge.bind(coord);
      (coord as unknown as { stopVaultBridge: () => Promise<void> }).stopVaultBridge = async () => {
        stopCalls += 1;
        await new Promise((r) => setTimeout(r, 25));
        await origStop();
      };
      await Promise.all([coord.ensureBridgeReady(), coord.ensureBridgeReady()]);
      assert.equal(stopCalls, 1, "concurrent self-heal must be single-flight");
    } finally {
      await coord?.stopVaultBridge().catch(() => undefined);
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("R3-2+3: delivery confirmation sends exactly once for blocked-after-send, boxed composer, fast idle->working->done, and [Pasted text]", async () => {
    const makeAgent = (over: Partial<AgentInfo>): AgentInfo =>
      ({
        pane_id: "w1:p7",
        name: "agent-r3",
        agent: "claude",
        agent_status: "idle",
        interactive_ready: true,
        launch_pending: false,
        focused: false,
        revision: 1,
        state_change_seq: 10,
        ...over,
      }) as AgentInfo;

    const runScenario = async (opts: {
      prompt: string;
      initialPane: string;
      afterSendPane: string;
      initialAgent: AgentInfo;
      afterSendAgent: AgentInfo;
    }): Promise<number> => {
      let promptCount = 0;
      let sent = false;
      const coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
      Object.assign(coord as unknown as Record<string, unknown>, {
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
        getActiveSessionName: () => "vault",
        promptSettlePollMs: 10,
        promptConfirmPollMs: 10,
        promptConfirmTimeoutMs: 60,
        socket: {
          getSocketPath: () => "/sock",
          splitPane: async () => ({ pane_id: "w1:p7" }),
          startAgent: async () => opts.initialAgent,
          listAgents: async () => [sent ? opts.afterSendAgent : opts.initialAgent],
          promptAgent: async () => {
            promptCount += 1;
            sent = true;
          },
          readPane: async () => (sent ? opts.afterSendPane : opts.initialPane),
        },
      });
      await coord.splitAndStartAgent({
        agentName: "agent-r3",
        agentKind: "claude",
        direction: "right",
        initialPrompt: opts.prompt,
      });
      return promptCount;
    };

    // (a) Agent becomes blocked right after send (e.g. tool approval) -> never retry into blocked agent.
    assert.equal(
      await runScenario({
        prompt: "Run checks",
        initialPane: "claude> ",
        afterSendPane: "claude> ",
        initialAgent: makeAgent({ agent_status: "idle" }),
        afterSendAgent: makeAgent({ agent_status: "blocked" }),
      }),
      1,
      "must send once when agent becomes blocked after send"
    );

    // (b) Boxed composer redraws pane without verbatim first-line probe -> pane text changed, send once.
    assert.equal(
      await runScenario({
        prompt: "Long prompt that gets boxed and truncated in the TUI composer",
        initialPane: "┌──────────┐\n│ >        │\n└──────────┘",
        afterSendPane: "┌──────────┐\n│ > Long p…│\n└──────────┘",
        initialAgent: makeAgent({ agent_status: "idle" }),
        afterSendAgent: makeAgent({ agent_status: "idle" }),
      }),
      1,
      "must send once when boxed composer pane text changes"
    );

    // (c) Fast idle -> working -> done between polls (pane unchanged, status left idle -> done and seq moved).
    assert.equal(
      await runScenario({
        prompt: "Quick check",
        initialPane: "codex> ",
        afterSendPane: "codex> ",
        initialAgent: makeAgent({ agent_status: "idle", state_change_seq: 10, revision: 1 }),
        afterSendAgent: makeAgent({ agent_status: "done", state_change_seq: 12, revision: 2 }),
      }),
      1,
      "must send once on fast idle -> working -> done transition"
    );

    // (d) [Pasted text #1 +3 lines] marker without status change -> pane text changed, send once.
    assert.equal(
      await runScenario({
        prompt: "Line 1\nLine 2\nLine 3\nLine 4",
        initialPane: "claude> ",
        afterSendPane: "claude> [Pasted text #1 +3 lines]",
        initialAgent: makeAgent({ agent_status: "idle" }),
        afterSendAgent: makeAgent({ agent_status: "idle" }),
      }),
      1,
      "must send once when [Pasted text] marker appears"
    );
  });

  it("R3-4: isRuntimeKitIntact detects missing connection.json, obs-herdr-core.mjs, or obs-herdr-core.py", { skip: SKIP_POSIX_SOCKETS }, async () => {
    const baseDir = makeShortTmpDir("herdr-r3-4-");
    let coord: HerdrCoordinator | null = null;
    try {
      const kit = computeRuntimePaths("/vault/r3-4", baseDir);
      coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
      Object.assign(coord as unknown as Record<string, unknown>, {
        disposed: false,
        runtimeKit: kit,
        bridgeServer: null,
        bridgeStartInFlight: null,
        bridgeHealInFlight: null,
        lastKnownBridgeToken: undefined,
        bridgeLastError: null,
        prunedStaleKits: true,
        app: { vault: { getName: () => "R3-4Vault" } },
        vaultOps: { getVaultBasePath: () => "/vault/r3-4", dispatch: async () => ({}) },
        cli: { setCustomEnv: () => undefined },
        getSettings: () => ({ vaultBridgeEnabled: true, vaultPermissionMode: "read-write" }),
        listeners: new Set(),
      });

      await coord.startVaultBridge();
      const checkIntact = () => (coord as unknown as { isRuntimeKitIntact: () => boolean }).isRuntimeKitIntact();
      assert.equal(checkIntact(), true);

      // Delete only connection.json -> must detect not intact and self-heal.
      fs.unlinkSync(kit.connectionFilePath);
      assert.equal(checkIntact(), false, "missing connection.json must make kit not intact");
      await coord.ensureBridgeReady();
      assert.equal(fs.existsSync(kit.connectionFilePath), true);

      // Delete only bin/obs-herdr-core.mjs -> must detect not intact and self-heal.
      const coreMjs = path.join(kit.binDir, "obs-herdr-core.mjs");
      fs.unlinkSync(coreMjs);
      assert.equal(checkIntact(), false, "missing obs-herdr-core.mjs must make kit not intact");
      await coord.ensureBridgeReady();
      assert.equal(fs.existsSync(coreMjs), true);

      // Delete only bin/obs-herdr-core.py -> must detect not intact and self-heal.
      const corePy = path.join(kit.binDir, "obs-herdr-core.py");
      fs.unlinkSync(corePy);
      assert.equal(checkIntact(), false, "missing obs-herdr-core.py must make kit not intact");
      await coord.ensureBridgeReady();
      assert.equal(fs.existsSync(corePy), true);
    } finally {
      await coord?.stopVaultBridge().catch(() => undefined);
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("R3-5: post-listen error closes server & clients, and doStartVaultBridge stops a non-running old server", { skip: SKIP_POSIX_SOCKETS }, async () => {
    const dir = makeShortTmpDir("herdr-r3-5-");
    const sockPath = path.join(dir, "b.sock");
    let srv: VaultBridgeServer | null = null;
    let client: net.Socket | null = null;
    let coord: HerdrCoordinator | null = null;
    try {
      srv = new VaultBridgeServer({
        socketPath: sockPath,
        kitDir: dir,
        dispatcher: async () => ({}),
      });
      await srv.start();
      client = net.createConnection({ path: sockPath });
      await new Promise<void>((r) => client!.once("connect", r));
      const clientClosed = new Promise<void>((r) => client!.once("close", r));

      const internalSrv = (srv as unknown as { server: net.Server | null }).server;
      assert.ok(internalSrv);
      const origWarn = console.warn;
      console.warn = () => undefined;
      try {
        internalSrv.emit("error", new Error("simulated post-listen error"));
      } finally {
        console.warn = origWarn;
      }

      await Promise.race([
        clientClosed,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("client was not closed on server error")), 500)),
      ]);
      assert.equal(srv.isRunning(), false);
      assert.equal((srv as unknown as { server: net.Server | null }).server, null, "server must be closed on post-listen error");

      // doStartVaultBridge stops a non-running old bridgeServer before replacing it.
      let oldStopped = false;
      const kit = computeRuntimePaths("/vault/r3-5", dir);
      coord = Object.create(HerdrCoordinator.prototype) as HerdrCoordinator;
      Object.assign(coord as unknown as Record<string, unknown>, {
        disposed: false,
        runtimeKit: kit,
        bridgeServer: {
          isRunning: () => false,
          getAuthToken: () => "a".repeat(64),
          stop: async () => {
            oldStopped = true;
          },
        },
        bridgeStartInFlight: null,
        bridgeHealInFlight: null,
        lastKnownBridgeToken: undefined,
        bridgeLastError: null,
        prunedStaleKits: true,
        app: { vault: { getName: () => "R3-5Vault" } },
        vaultOps: { getVaultBasePath: () => "/vault/r3-5", dispatch: async () => ({}) },
        cli: { setCustomEnv: () => undefined },
        listeners: new Set(),
      });
      await coord.startVaultBridge();
      assert.equal(oldStopped, true, "doStartVaultBridge must stop a non-running old server before replacing it");
    } finally {
      client?.destroy();
      await coord?.stopVaultBridge().catch(() => undefined);
      await srv?.stop().catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R3-6: SpawnAgentModal abort notice preserves coordinator's own pre-send vs post-send error message", () => {
    const mod = HerdrCoordinator as unknown as {
      formatSpawnAbortNotice?: (agentName: string, err: unknown) => string;
    };
    const helper =
      (coordModule as unknown as { formatSpawnAbortNotice?: (agentName: string, err: unknown) => string })
        .formatSpawnAbortNotice ?? mod.formatSpawnAbortNotice;
    assert.equal(typeof helper, "function", "expected formatSpawnAbortNotice helper");
    const preSend = new Error("Started 'claude', but waiting for it was cancelled, so the initial prompt was not sent.");
    const postSend = new Error("Started 'claude', but waiting for prompt delivery was cancelled.");
    assert.equal(helper!("claude", preSend), preSend.message);
    assert.equal(helper!("claude", postSend), postSend.message);
  });

  it("MC: redesigned HerdrDashboardView renders 3 tabs, layout map, attention banner, Vault Edits filter, Doctor sessions, and confirms Stop session", async () => {
    resetObsidianUiMocks();
    let stopCalls = 0;
    const state = {
      binaryPath: "/usr/bin/herdr",
      activeSessionName: "vault-test",
      socketPath: "/tmp/herdr.sock",
      serverRunning: true,
      socketSubscribed: true,
      usingOfflinePreview: false,
      protocolWarning: "Protocol mismatch test",
      snapshot: {
        version: "0.8.2",
        protocol: 20,
        focused_workspace_id: "w1",
        focused_tab_id: "w1:t1",
        focused_pane_id: "w1:p1",
        workspaces: [{ workspace_id: "w1", number: 1, label: "Vault", focused: true, pane_count: 2, tab_count: 1, active_tab_id: "w1:t1", agent_status: "blocked" }],
        tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "Main", focused: true, pane_count: 2, agent_status: "blocked" }],
        panes: [
          { pane_id: "w1:p1", tab_id: "w1:t1", label: "agyA", focused: true, agent_status: "working", revision: 1 },
          { pane_id: "w1:p2", tab_id: "w1:t1", label: "agyB", focused: false, agent_status: "blocked", revision: 1 },
        ],
        layouts: [{
          workspace_id: "w1", tab_id: "w1:t1", zoomed: false, focused_pane_id: "w1:p1",
          area: { x: 0, y: 0, width: 100, height: 100 },
          panes: [
            { pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 50, height: 100 } },
            { pane_id: "w1:p2", focused: false, rect: { x: 50, y: 0, width: 50, height: 100 } },
          ],
          splits: [],
        }],
        agents: [
          { pane_id: "w1:p1", name: "agy-1", agent: "agy", agent_status: "working", interactive_ready: true, launch_pending: false, focused: true, revision: 1, state_change_seq: 1 },
          { pane_id: "w1:p2", name: "agy-2", agent: "agy", agent_status: "blocked", interactive_ready: true, launch_pending: false, focused: false, revision: 1, state_change_seq: 1 },
        ],
      },
      statusPayload: { client: { version: "0.8.2", protocol: 20 }, server: { running: true, version: "0.8.2", protocol: 20 } },
      sessions: [
        { name: "vault-test", status: "running", directory: "/v", socket: "/tmp/herdr.sock" },
        { name: "old-session", status: "stopped", directory: "/old", socket: "/tmp/old.sock" },
      ],
      integrations: [],
      installedPlugins: [],
      worktrees: [],
      bridgeRunning: true,
      bridgeSocketPath: "/tmp/b.sock",
      cliScriptPath: "/tmp/obs-herdr",
      herdrPluginManifestPath: "/tmp/herdr-plugin.toml",
      lastError: null,
      lastUpdated: Date.now(),
    };

    const audit = [
      { id: "1", timestamp: Date.now(), method: "vault.info", caller: "a", allowed: true, summary: "Read info" },
      { id: "2", timestamp: Date.now(), method: "vault.update_note", caller: "a", allowed: true, summary: "Edited note.md", snapshot: { kind: "modified", path: "note.md", previousContent: "" } },
    ];

    const coord = {
      getState: () => state,
      onChange: () => () => undefined,
      refreshAll: async () => undefined,
      stopVaultHerdrSession: async () => { stopCalls += 1; },
      vaultOps: { onAuditUpdated: () => () => undefined, getAuditLog: () => audit, clearAuditLog: () => undefined, getVaultBasePath: () => "/v" },
      socket: {},
      getBridgeEnv: () => ({}),
    } as unknown as HerdrCoordinator;

    const view = new HerdrDashboardView({
      leaf: { app: { vault: { getAbstractFileByPath: () => null } } } as unknown as never,
      coordinator: coord,
      getSettings: () => ({ vaultPermissionMode: "full", defaultAgentKind: "claude", allowUiControl: true } as unknown as never),
      updateSettings: async () => undefined,
      openTerminalLeaf: async () => undefined,
    });

    await view.onOpen();
    const root = view.contentEl as unknown as FakeDomNode;
    const tabLabels = findAllNodes(root, (n) => n.classList.contains("herdr-mc-tab")).map((n) => n.textContent);
    const attentionText = findAllNodes(root, (n) => n.classList.contains("herdr-mc-attention")).map((n) =>
      findAllNodes(n, (x) => Boolean(x.textContent)).map((x) => x.textContent).join(" ")
    );
    const mapPanes = findAllNodes(root, (n) => n.classList.contains("herdr-mc-layoutmap-pane")).map((n) => ({
      text: findAllNodes(n, (x) => x.classList.contains("herdr-mc-pane-title"))[0]?.textContent || n.textContent,
      left: n.style.left,
      width: n.style.width,
    }));
    const agentNames = findAllNodes(root, (n) => n.classList.contains("herdr-mc-agent-name")).map((n) => n.textContent);

    const vaultTab = findAllNodes(root, (n) => n.classList.contains("herdr-mc-tab") && n.textContent === "Vault")[0];
    vaultTab.click();
    const editsCount = findAllNodes(root, (n) => n.classList.contains("herdr-mc-log-row")).length;
    const showAllBtn = findAllNodes(root, (n) => n.tagName === "BUTTON" && n.textContent === "Show all activity")[0];
    showAllBtn.click();
    const allCount = findAllNodes(root, (n) => n.classList.contains("herdr-mc-log-row")).length;
    const tierLabels = findAllNodes(root, (n) => n.classList.contains("herdr-mc-segmented"))[0].children.map((c) => c.textContent);

    const tabsBar = findAllNodes(root, (n) => n.classList.contains("herdr-mc-tabs"))[0];
    const tabsAriaLabel = tabsBar.getAttr("aria-label") || null;
    const doctorTab = findAllNodes(root, (n) => n.classList.contains("herdr-mc-tab") && n.textContent === "Doctor")[0];
    doctorTab.click();
    const doctorSummaries = findAllNodes(root, (n) => n.tagName === "SUMMARY").map((n) => n.textContent);
    const sessionTitles = findAllNodes(root, (n) => n.classList.contains("herdr-mc-session-row")).map((n) => n.getAttr("title"));

    const headerMore = findAllNodes(root, (n) => n.classList.contains("herdr-mc-more"))[0];
    headerMore.click();
    const lastMenuItems = __mockMenus[__mockMenus.length - 1].items;
    const menuTitles = lastMenuItems.filter((i) => !i.sep).map((i) => i.title);
    const stopWarning = Boolean(lastMenuItems.find((i) => i.title === "Stop session")?.warning);

    assert.deepEqual(tabLabels, ["Agents", "Vault", "Doctor"]);
    assert.equal(tabsAriaLabel, null, "tabs row must not have aria-label hover tooltip");
    assert.ok(attentionText[0]?.includes("agyB needs input"));
    assert.deepEqual(mapPanes, [
      { text: "agyA", left: "0.00%", width: "50.00%" },
      { text: "agyB", left: "50.00%", width: "50.00%" },
    ]);
    assert.deepEqual(agentNames, ["agyA", "agyB"]);
    assert.equal(editsCount, 1, "Vault tab defaults to Edits filter");
    assert.equal(allCount, 2, "Show all activity reveals read entries");
    assert.deepEqual(tierLabels, ["Off", "Read only", "Edit notes", "Full control"]);
    assert.deepEqual(doctorSummaries, ["Stopped sessions (1)", "Optional agent hooks (0)"]);
    assert.ok(sessionTitles[0]?.startsWith("vault-test"), "session row tooltip must start with full session name");
    assert.ok(menuTitles.includes("Stop session"));
    assert.equal(stopWarning, true, "Stop session menu item must be marked warning");
    assert.ok(menuTitles.includes("Open terminal"));
    assert.equal(stopCalls, 0);
    await view.onClose();
  });
});
