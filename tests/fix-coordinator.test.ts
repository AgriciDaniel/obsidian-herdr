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
import { HerdrCoordinator } from "../src/services/herdr-coordinator";
import * as ptyHost from "../src/terminal/pty-host";
import { PtySession } from "../src/terminal/pty-host";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  (globalThis as { window?: unknown }).window = globalThis;
}

describe("fix-coordinator: agyA review fixes (A1-A10)", () => {
  it("A1: VaultBridgeServer.stop() never unlinks a socket owned by a newer server", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-a1-"));
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

  it("A2: VaultBridgeServer removes stray non-socket/dangling symlink only inside kitDir and handles post-listen errors", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-a2-"));
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

  it("A4: HerdrCoordinator self-heals deleted socket/CLI while bridgeServer thinks it is running, keeping the same token", async () => {
    if (process.platform === "win32") {
      return;
    }
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-a4-"));
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
      assert.ok(elapsed < 350, `expected prompt abort (<350ms), took ${elapsed}ms`);
      assert.deepEqual(prompts, []);
    } finally {
      clearTimeout(abortTimer);
    }
  });

  it("A10: HerdrCoordinator calls pruneStaleRuntimeKits once per load after bridge start and ignores errors", async () => {
    if (process.platform === "win32") {
      return;
    }
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-a10-"));
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

  it("Follow-up 1: HerdrCoordinator passes manifest pluginVersion into provisionRuntimeKit", async () => {
    if (process.platform === "win32") {
      return;
    }
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-fu1-"));
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
});
