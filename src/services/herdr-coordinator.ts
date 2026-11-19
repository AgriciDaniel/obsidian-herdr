import * as os from "node:os";
import * as path from "node:path";
import { type App, MarkdownView, Notice, TFile } from "obsidian";
import {
  buildBridgeEnvForPanes,
  computeRuntimePaths,
  provisionRuntimeKit,
  readExistingBridgeToken,
  type ProvisionedRuntimeKit,
} from "../bridge/runtime-kit";
import { VaultBridgeServer } from "../bridge/vault-bridge-server";
import { BridgeRpcError, VaultOpsService, type VaultTextChange } from "../bridge/vault-ops";
import { AgentCursorOverlay } from "../control/agent-cursor";
import { getObsidianWebContents } from "../control/electron-host";
import { resolveTopLevelElement } from "../control/nested-editors";
import {
  UiControlService,
  type CodeMirrorViewLike,
  type ElementLeafContext,
  type NoteLeafContext,
  type UiMutationContext,
} from "../control/ui-control";
import { buildOfflinePreviewSnapshot } from "../domain/demo-fixture";
import { deriveVaultSessionSlug } from "../domain/shell-quote";
import type {
  AgentInfo,
  AgentStatus,
  HerdrIntegrationRow,
  HerdrNamedSession,
  HerdrPluginSettings,
  HerdrStatusPayload,
  InstalledHerdrPlugin,
  PaneInfo,
  SessionSnapshot,
  SplitDirection,
  TerminalProfile,
  WorktreeRecord,
} from "../domain/types";
import { HerdrCliClient } from "../herdr/cli-client";
import { HerdrSocketClient } from "../herdr/socket-client";
import { deliverToTerminal, resolveDefaultShell } from "../terminal/pty-host";

export interface CoordinatorState {
  binaryPath: string | null;
  activeSessionName: string;
  socketPath: string;
  serverRunning: boolean;
  socketSubscribed: boolean;
  usingOfflinePreview: boolean;
  snapshot: SessionSnapshot | null;
  statusPayload: HerdrStatusPayload | null;
  sessions: HerdrNamedSession[];
  integrations: HerdrIntegrationRow[];
  installedPlugins: InstalledHerdrPlugin[];
  worktrees: WorktreeRecord[];
  bridgeRunning: boolean;
  bridgeSocketPath: string;
  cliScriptPath: string;
  herdrPluginManifestPath: string;
  lastError: string | null;
  lastUpdated: number;
}

export class HerdrCoordinator {
  readonly app: App;
  readonly vaultOps: VaultOpsService;
  readonly cli: HerdrCliClient;
  readonly socket: HerdrSocketClient;

  private getSettings: () => HerdrPluginSettings;
  private bridgeServer: VaultBridgeServer | null = null;
  private runtimeKit: ProvisionedRuntimeKit;
  private snapshot: SessionSnapshot | null = null;
  private statusPayload: HerdrStatusPayload | null = null;
  private socketReachable = false;
  private sessions: HerdrNamedSession[] = [];
  private integrations: HerdrIntegrationRow[] = [];
  private installedPlugins: InstalledHerdrPlugin[] = [];
  private worktrees: WorktreeRecord[] = [];
  private lastError: string | null = null;
  private lastUpdated = 0;
  private refreshInFlight: Promise<void> | null = null;
  private sessionStartInFlight: Promise<void> | null = null;
  private bridgeStartInFlight: Promise<void> | null = null;
  private debounceTimer: number | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly previousAgentStates = new Map<string, AgentStatus>();
  private unsubSocketEvent: (() => void) | null = null;
  private unsubSocketConn: (() => void) | null = null;
  private readonly cursorOverlay: AgentCursorOverlay;
  private readonly notePaneIds = new WeakMap<MarkdownView, string>();
  private notePaneSeq = 0;
  private disposed = false;

  constructor(options: { app: App; getSettings: () => HerdrPluginSettings }) {
    this.app = options.app;
    this.getSettings = options.getSettings;

    this.cursorOverlay = new AgentCursorOverlay({
      win: window,
      enabled: this.getSettings().showAgentCursors,
    });

    this.vaultOps = new VaultOpsService({
      app: this.app,
      getPermissionMode: () =>
        this.getSettings().vaultBridgeEnabled
          ? this.getSettings().vaultPermissionMode
          : "off",
      getAllowHiddenReads: () => this.getSettings().allowHiddenConfigReads,
      uiControl: new UiControlService({
        win: window,
        getWebContents: getObsidianWebContents,
        getUiTypingSpeed: () => this.getSettings().uiTypingSpeed,
        getAllowUiInProtectedAreas: () => this.getSettings().allowUiInProtectedAreas,
        cursorOverlay: this.cursorOverlay,
        resolveAgentLabel: (caller) => this.resolveCallerLabel(caller),
        resolveElementContext: (el) => this.resolveEditorContext(el),
        resolveNoteLeaf: (notePath) => this.resolveOpenNoteLeaf(notePath),
        beforeMutation: (context) => this.captureUiMutation(context),
        deliverToTerminal: (element, data) => this.deliverCapturedTerminalInput(element, data),
      }),
      getAllowUiControl: () => this.getSettings().allowUiControl,
      getAllowUiInProtectedAreas: () => this.getSettings().allowUiInProtectedAreas,
      onAgentActivity: (caller, targetPath, action, change) =>
        this.notifyVaultCursorActivity(caller, targetPath, action, change),
    });

    const vaultKey =
      this.vaultOps.getVaultBasePath() || this.app.vault.getName() || "obsidian-vault";
    this.runtimeKit = computeRuntimePaths(vaultKey);

    const initialSettings = this.getSettings();
    this.cli = new HerdrCliClient(initialSettings.herdrBinaryPath);
    const initialSocket = this.resolveTargetSocketPath();
    this.socket = new HerdrSocketClient(initialSocket);

    this.unsubSocketEvent = this.socket.onEvent(() => {
      this.scheduleDebouncedRefresh(120);
    });
    this.unsubSocketConn = this.socket.onConnectionState(() => {
      this.emitChange();
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getRuntimeKit(): ProvisionedRuntimeKit {
    return this.runtimeKit;
  }

  getActiveSessionName(): string {
    const configured = this.getSettings().defaultSessionName.trim();
    if (configured) {
      return configured;
    }
    return deriveVaultSessionSlug(this.app.vault.getName());
  }

  resolveTargetSocketPath(): string {
    const settings = this.getSettings();
    if (settings.customSocketPath.trim()) {
      return settings.customSocketPath.trim();
    }
    if (this.statusPayload?.server?.socket) {
      return this.statusPayload.server.socket;
    }
    if (process.env.HERDR_SOCKET_PATH) {
      return process.env.HERDR_SOCKET_PATH;
    }
    if (process.platform === "win32") {
      // Herdr's own folder on Windows is under %APPDATA%; the socket client adds the pipe prefix.
      return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "herdr", "herdr.sock");
    }
    return path.join(os.homedir(), ".config", "herdr", "herdr.sock");
  }

  getBridgeEnv(): Record<string, string> {
    const token = this.bridgeServer?.getAuthToken() || "";
    if (!token || !this.bridgeServer?.isRunning()) {
      return {};
    }
    return buildBridgeEnvForPanes({
      kit: this.runtimeKit,
      token,
      vaultName: this.app.vault.getName(),
      vaultPath: this.vaultOps.getVaultBasePath(),
    });
  }

  async initialize(): Promise<void> {
    const settings = this.getSettings();
    this.cli.setConfiguredBinary(settings.herdrBinaryPath);

    if (settings.vaultBridgeEnabled && settings.vaultPermissionMode !== "off") {
      await this.startVaultBridge();
    }

    await this.refreshAll(true);
  }

  async applySettingsUpdate(): Promise<void> {
    const settings = this.getSettings();
    this.cli.setConfiguredBinary(settings.herdrBinaryPath);
    this.cursorOverlay.setEnabled(settings.showAgentCursors);

    if (settings.vaultBridgeEnabled && settings.vaultPermissionMode !== "off") {
      if (!this.bridgeServer?.isRunning()) {
        await this.startVaultBridge();
      }
    } else if (this.bridgeServer?.isRunning()) {
      await this.stopVaultBridge();
    }

    await this.refreshAll(false);
  }

  async startVaultBridge(): Promise<void> {
    if (this.bridgeServer?.isRunning()) {
      return;
    }
    if (this.bridgeStartInFlight) {
      return this.bridgeStartInFlight;
    }
    this.bridgeStartInFlight = this.doStartVaultBridge().finally(() => {
      this.bridgeStartInFlight = null;
    });
    return this.bridgeStartInFlight;
  }

  /**
   * Starts the bridge when settings enable it, so a Herdr daemon or PTY spawned right after
   * inherits the obs-herdr PATH and bridge variables. Failures leave the session usable
   * without the bridge.
   */
  async ensureBridgeReady(): Promise<void> {
    const settings = this.getSettings();
    if (!settings.vaultBridgeEnabled || settings.vaultPermissionMode === "off") {
      return;
    }
    try {
      await this.startVaultBridge();
    } catch {
      // The session still starts; panes simply lack the bridge.
    }
  }

  private async doStartVaultBridge(): Promise<void> {
    if (this.bridgeServer?.isRunning()) {
      return;
    }
    const existingToken = readExistingBridgeToken(this.runtimeKit.connectionFilePath);
    const srv = new VaultBridgeServer({
      socketPath: this.runtimeKit.socketPath,
      authToken: existingToken,
      dispatcher: (method, params, caller) => this.vaultOps.dispatch(method, params, caller),
    });
    await srv.start();
    this.bridgeServer = srv;

    provisionRuntimeKit({
      kit: this.runtimeKit,
      token: srv.getAuthToken(),
      vaultName: this.app.vault.getName(),
      vaultPath: this.vaultOps.getVaultBasePath(),
    });

    this.cli.setCustomEnv(this.getBridgeEnv());
    this.emitChange();
  }

  async stopVaultBridge(): Promise<void> {
    if (!this.bridgeServer) {
      return;
    }
    const srv = this.bridgeServer;
    this.bridgeServer = null;
    await srv.stop();
    this.emitChange();
  }

  getState(): CoordinatorState {
    const settings = this.getSettings();
    const serverRunning = Boolean(
      (this.statusPayload?.server?.running || this.socketReachable) && this.snapshot
    );
    const usingOfflinePreview =
      !serverRunning && Boolean(settings.showOfflinePreviewWhenStopped);
    const effectiveSnapshot = serverRunning
      ? this.snapshot
      : usingOfflinePreview
        ? buildOfflinePreviewSnapshot(this.app.vault.getName())
        : null;

    return {
      binaryPath: this.cli.getBinaryPath(),
      activeSessionName: this.getActiveSessionName(),
      socketPath: this.socket.getSocketPath(),
      serverRunning,
      socketSubscribed: this.socket.isSubscribed(),
      usingOfflinePreview,
      snapshot: effectiveSnapshot,
      statusPayload: this.statusPayload,
      sessions: this.sessions,
      integrations: this.integrations,
      installedPlugins: this.installedPlugins,
      worktrees: this.worktrees,
      bridgeRunning: Boolean(this.bridgeServer?.isRunning()),
      bridgeSocketPath: this.runtimeKit.socketPath,
      cliScriptPath: this.runtimeKit.cliScriptPath,
      herdrPluginManifestPath: this.runtimeKit.herdrPluginManifestPath,
      lastError: this.lastError,
      lastUpdated: this.lastUpdated,
    };
  }

  scheduleDebouncedRefresh(delayMs = 150): void {
    if (this.disposed) {
      return;
    }
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.refreshAll(false);
    }, delayMs);
  }

  async refreshAll(includeDiagnostics = false): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.doRefresh(includeDiagnostics).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(includeDiagnostics: boolean): Promise<void> {
    try {
      const settings = this.getSettings();
      const sessionName = this.getActiveSessionName();
      let status = await this.cli.getStatus(sessionName);
      if (!status?.server?.running && !settings.defaultSessionName.trim()) {
        const defaultStatus = await this.cli.getStatus();
        if (defaultStatus?.server?.running) {
          status = defaultStatus;
        }
      }
      this.statusPayload = status;

      const resolvedSocket = settings.customSocketPath.trim()
        ? settings.customSocketPath.trim()
        : status?.server?.socket || this.resolveTargetSocketPath();

      this.socket.setSocketPath(resolvedSocket);

      if (includeDiagnostics) {
        const [sessions, integrations] = await Promise.all([
          this.cli.listSessions(),
          this.cli.getIntegrationStatuses(),
        ]);
        this.sessions = sessions;
        this.integrations = integrations;
      }

      if (status?.server?.running || this.socket.isSocketPresent()) {
        const snap = await this.socket.getSnapshot();
        this.detectAgentStateTransitions(snap.agents);
        const openPanes = new Set(snap.panes.map((pane) => pane.pane_id));
        this.cursorOverlay.reconcileLiveCallers(
          snap.agents
            .filter((agent) => openPanes.has(agent.pane_id))
            .flatMap((agent) => agent.name ? [agent.pane_id, agent.name] : [agent.pane_id])
        );
        this.snapshot = snap;
        this.socketReachable = true;
        this.lastError = null;

        if (settings.autoConnectSocket && !this.socket.isSubscribed()) {
          this.socket.startSubscription();
        }

        if (includeDiagnostics) {
          try {
            this.installedPlugins = await this.socket.listPlugins();
          } catch {
            this.installedPlugins = [];
          }
          try {
            const vaultBase = this.vaultOps.getVaultBasePath();
            this.worktrees = await this.socket.listWorktrees(
              snap.focused_workspace_id || undefined,
              vaultBase || undefined
            );
          } catch {
            this.worktrees = [];
          }
        }

        if (settings.autoReportVaultMetadata && snap.focused_workspace_id) {
          const activeFile = this.app.workspace.getActiveFile();
          void this.socket
            .reportWorkspaceMetadata(snap.focused_workspace_id, {
              vault: this.app.vault.getName().slice(0, 32),
              note: activeFile ? activeFile.basename.slice(0, 32) : null,
            })
            .catch(() => undefined);
        }
      } else {
        this.snapshot = null;
        this.socketReachable = false;
        this.socket.stopSubscription();
        if (status?.server?.running === false) {
          this.cursorOverlay.reconcileLiveCallers([]);
        }
      }
    } catch (err) {
      this.snapshot = null;
      this.socketReachable = false;
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.lastUpdated = Date.now();
      this.emitChange();
    }
  }

  async startVaultHerdrSession(): Promise<void> {
    if (this.sessionStartInFlight) {
      return this.sessionStartInFlight;
    }
    this.sessionStartInFlight = this.doStartVaultHerdrSession().finally(() => {
      this.sessionStartInFlight = null;
    });
    return this.sessionStartInFlight;
  }

  private async doStartVaultHerdrSession(): Promise<void> {
    await this.ensureBridgeReady();
    const cwd = this.vaultOps.getVaultBasePath() || os.homedir();
    const sessionName = this.getActiveSessionName();
    const status = await this.cli.ensureHeadlessServer({
      sessionName,
      cwd,
      bridgeEnv: this.getBridgeEnv(),
    });
    if (status?.server?.socket && !this.getSettings().customSocketPath.trim()) {
      this.socket.setSocketPath(status.server.socket);
    }
    try {
      const snap = await this.socket.getSnapshot();
      if (snap.workspaces.length === 0) {
        await this.socket.createWorkspace({
          label: this.app.vault.getName(),
          cwd,
          focus: true,
          env: this.getBridgeEnv(),
        });
      }
    } catch {
      // Ignore if snapshot is still initializing
    }
    await this.refreshAll(true);
  }

  async stopVaultHerdrSession(): Promise<void> {
    const sessionName = this.getActiveSessionName();
    let stopped = false;
    try {
      await this.socket.stopServer();
      stopped = true;
    } catch {
      // Fall back to CLI session stop if socket RPC failed
    }
    if (!stopped) {
      await this.cli.stopNamedSession(sessionName);
    }
    this.socket.stopSubscription();
    this.socketReachable = false;
    this.snapshot = null;
    this.cursorOverlay.reconcileLiveCallers([]);
    await new Promise((r) => window.setTimeout(r, 150));
    await this.refreshAll(true);
  }

  async createVaultWorkspace(label?: string): Promise<void> {
    const cwd = this.vaultOps.getVaultBasePath() || os.homedir();
    await this.socket.createWorkspace({
      label: label || this.app.vault.getName(),
      cwd,
      focus: true,
      env: this.getBridgeEnv(),
    });
    await this.refreshAll(false);
  }

  buildAgentSpawnArgs(agentKind: string, attachVaultMcp = true, paneId?: string): string[] {
    if (!this.bridgeServer?.isRunning()) {
      return [];
    }
    if (agentKind === "codex") {
      const args = attachVaultMcp
        ? [
            "-c",
            `mcp_servers.obsidian_vault.command=${JSON.stringify(this.runtimeKit.cliScriptPath)}`,
            "-c",
            'mcp_servers.obsidian_vault.args=["mcp"]',
          ]
        : [];
      // Codex can replace the pane environment with a core set and its own PATH.
      // Restore only bridge discovery paths and identity, never tokens or all inherited variables.
      const bridgeEnv = this.getBridgeEnv();
      const shellEnv: Record<string, string> = {};
      for (const key of [
        "PATH",
        "OBSIDIAN_HERDR_CLI",
        "OBSIDIAN_HERDR_CONNECTION_FILE",
        "OBSIDIAN_HERDR_MCP_CONFIG",
        "OBSIDIAN_VAULT_NAME",
        "OBSIDIAN_VAULT_PATH",
      ]) {
        if (bridgeEnv[key]) {
          shellEnv[key] = bridgeEnv[key];
        }
      }
      if (paneId) {
        shellEnv.HERDR_PANE_ID = paneId;
      }
      for (const [key, value] of Object.entries(shellEnv)) {
        args.push("-c", `shell_environment_policy.set.${key}=${JSON.stringify(value)}`);
      }
      return args;
    }
    if (agentKind === "claude" && attachVaultMcp) {
      return ["--mcp-config", this.runtimeKit.mcpConfigFilePath];
    }
    return [];
  }

  private async waitForPaneShellReady(paneId: string): Promise<void> {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      try {
        const text = await this.socket.readPane(paneId, "recent_unwrapped", 20);
        if (text.trim().length > 0) {
          await new Promise((r) => window.setTimeout(r, 120));
          return;
        }
      } catch {
        // Ignore transient read error while pane initializes
      }
      await new Promise((r) => window.setTimeout(r, 120));
    }
  }

  async splitAndStartAgent(options: {
    agentName: string;
    agentKind: string;
    direction: SplitDirection;
    targetPaneId?: string;
    initialPrompt?: string;
    attachVaultMcp?: boolean;
    extraArgs?: string[];
  }): Promise<AgentInfo> {
    await this.ensureBridgeReady();
    if (this.sessionStartInFlight) {
      await this.sessionStartInFlight;
    } else if (!this.socketReachable && !this.socket.isSocketPresent()) {
      await this.startVaultHerdrSession();
    }

    const cwd = this.vaultOps.getVaultBasePath() || os.homedir();
    let pane: PaneInfo;
    const currentSnap = this.snapshot ?? (await this.socket.getSnapshot());
    if (currentSnap.workspaces.length === 0 || currentSnap.panes.length === 0) {
      const created = await this.socket.createWorkspace({
        label: this.app.vault.getName(),
        cwd,
        focus: true,
        env: this.getBridgeEnv(),
      });
      pane = created.root_pane;
    } else {
      pane = await this.socket.splitPane({
        targetPaneId: options.targetPaneId,
        direction: options.direction,
        cwd,
        focus: true,
        env: this.getBridgeEnv(),
      });
    }

    await this.waitForPaneShellReady(pane.pane_id);

    const spawnArgs = [
      ...this.buildAgentSpawnArgs(options.agentKind, options.attachVaultMcp !== false, pane.pane_id),
      ...(options.extraArgs || []),
    ];

    let agent: AgentInfo;
    try {
      agent = await this.socket.startAgent({
        name: options.agentName,
        kind: options.agentKind,
        paneId: pane.pane_id,
        args: spawnArgs,
        timeoutMs: 45000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/prompt|ready/i.test(msg)) {
        await new Promise((r) => window.setTimeout(r, 450));
        agent = await this.socket.startAgent({
          name: options.agentName,
          kind: options.agentKind,
          paneId: pane.pane_id,
          args: spawnArgs,
          timeoutMs: 45000,
        });
      } else {
        throw err;
      }
    }

    if (options.initialPrompt && options.initialPrompt.trim()) {
      // An agent waiting at a question (Claude Code's first-run folder trust check, where Enter
      // picks "No, exit") must not get the prompt: its Enter would answer the question.
      if (!(await this.waitWhileBlocked(agent))) {
        await this.refreshAll(false);
        throw new Error(
          `Started '${options.agentName}', but it was waiting at a question (for example Claude Code's folder trust check), so the initial prompt was not sent. Answer it in the agent's terminal, then send the prompt.`
        );
      }
      await this.socket.promptAgent(options.agentName, options.initialPrompt.trim());
    }

    await this.refreshAll(false);
    return agent;
  }

  /**
   * Waits, at most two minutes, while a just started agent is blocked at a question, and tells
   * the member once to answer it. True once it is ready (or was never blocked); false when it
   * stayed blocked, left, or the plugin closed.
   */
  private async waitWhileBlocked(agent: AgentInfo): Promise<boolean> {
    if (agent.agent_status !== "blocked") {
      return true;
    }
    new Notice(
      `'${agent.name || agent.pane_id}' is asking a question first (for example Claude Code's folder trust check). Answer it in its terminal; the initial prompt is sent once the agent is ready.`,
      15000
    );
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !this.disposed) {
      await new Promise((r) => window.setTimeout(r, 500));
      let now: AgentInfo | undefined;
      try {
        now = (await this.socket.listAgents()).find((a) => a.pane_id === agent.pane_id && a.name === agent.name);
      } catch {
        continue;
      }
      if (!now) {
        return false;
      }
      if (now.agent_status !== "blocked" && now.interactive_ready) {
        return true;
      }
    }
    return false;
  }

  async buildActiveNoteContextPack(options: {
    includeSelectionOnly?: boolean;
    includeBacklinks?: boolean;
    customInstruction?: string;
  }): Promise<{ title: string; payload: string; file: TFile | null }> {
    const activeFile = this.app.workspace.getActiveFile();
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const selection = mdView ? mdView.editor.getSelection() : "";

    const lines: string[] = [];
    if (options.customInstruction?.trim()) {
      lines.push(options.customInstruction.trim(), "");
    }

    lines.push(
      `[Obsidian Vault Context - Vault: "${this.app.vault.getName()}"]`,
      "Tip: Use `obs-herdr --skill` in your terminal to read, search, update, or open vault notes directly."
    );

    if (!activeFile) {
      if (selection) {
        lines.push("", "## Editor selection", "```markdown", selection, "```");
      }
      return {
        title: "Workspace selection",
        payload: lines.join("\n"),
        file: null,
      };
    }

    lines.push(`Active note path: ${activeFile.path}`);
    const cache = this.app.metadataCache.getFileCache(activeFile);
    if (cache?.frontmatter) {
      const fmCopy = { ...cache.frontmatter };
      delete fmCopy.position;
      lines.push("Frontmatter: " + JSON.stringify(fmCopy));
    }

    if (options.includeBacklinks) {
      const resolved = this.app.metadataCache.resolvedLinks;
      const incoming: string[] = [];
      for (const [src, targets] of Object.entries(resolved)) {
        if (targets[activeFile.path]) {
          incoming.push(src);
        }
      }
      if (incoming.length > 0) {
        lines.push(`Backlinks (${incoming.length}): ${incoming.slice(0, 15).join(", ")}`);
      }
    }

    if (options.includeSelectionOnly && selection.trim()) {
      lines.push("", "## Selected passage", "```markdown", selection, "```");
    } else {
      const body = await this.app.vault.cachedRead(activeFile);
      const clipped = body.length > 12000 ? `${body.slice(0, 12000)}\n...[truncated]` : body;
      lines.push("", "## Note content", "```markdown", clipped, "```");
    }

    return {
      title: activeFile.basename,
      payload: lines.join("\n"),
      file: activeFile,
    };
  }

  async linkObsidianHerdrPlugin(): Promise<InstalledHerdrPlugin> {
    const linked = await this.socket.linkPlugin(this.runtimeKit.herdrPluginDir, true);
    await this.refreshAll(true);
    return linked;
  }

  async unlinkObsidianHerdrPlugin(): Promise<boolean> {
    const removed = await this.socket.unlinkPlugin("obsidian.vault");
    await this.refreshAll(true);
    return removed;
  }

  resolveSpawnCommandForProfile(
    profile: TerminalProfile,
    cwdOverride?: string
  ): {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  } {
    const vaultRoot = this.vaultOps.getVaultBasePath() || os.homedir();
    const activeFile = this.app.workspace.getActiveFile();
    let cwd = vaultRoot;

    if (cwdOverride && cwdOverride.trim()) {
      cwd = cwdOverride.trim();
    } else if (profile.cwdMode === "active-note-folder" && activeFile?.parent?.path) {
      cwd = path.join(vaultRoot, activeFile.parent.path);
    } else if (profile.cwdMode === "custom" && profile.customCwd?.trim()) {
      cwd = profile.customCwd.trim();
    }

    const env = this.getBridgeEnv();
    const herdrBin = this.cli.getBinaryPath() || "herdr";

    if (profile.kind === "herdr-vault") {
      const session = profile.sessionName?.trim() || this.getActiveSessionName();
      return {
        command: herdrBin,
        args: ["--session", session],
        cwd,
        env,
      };
    }

    if (profile.kind === "herdr-agent" && profile.agentTarget?.trim()) {
      const session = profile.sessionName?.trim() || this.getActiveSessionName();
      return {
        command: herdrBin,
        args: ["--session", session, "agent", "attach", profile.agentTarget.trim()],
        cwd,
        env,
      };
    }

    if (profile.kind === "herdr-remote" && profile.remoteTarget?.trim()) {
      const args = ["--remote", profile.remoteTarget.trim()];
      if (profile.sessionName?.trim()) {
        args.push("--session", profile.sessionName.trim());
      }
      return {
        command: herdrBin,
        args,
        cwd,
        env,
      };
    }

    const shellCmd = profile.shellPath?.trim() || resolveDefaultShell();
    const shellArgs =
      profile.shellArgs && profile.shellArgs.length > 0
        ? profile.shellArgs
        : process.platform === "win32"
          ? []
          : ["-i"];

    return {
      command: shellCmd,
      args: shellArgs,
      cwd,
      env,
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.unsubSocketEvent?.();
    this.unsubSocketConn?.();
    this.socket.dispose();
    this.cursorOverlay.dispose();
    await this.stopVaultBridge();
    this.listeners.clear();
  }

  private resolveCallerLabel(caller: string): string {
    const identity = caller.startsWith("herdr:") ? caller.slice(6) : caller;
    const agent = this.snapshot?.agents.find((candidate) => candidate.pane_id === identity)
      ?? this.snapshot?.agents.find((candidate) => candidate.name === identity);
    if (agent) {
      const name = agent.name || agent.display_agent || agent.agent || "agent";
      return `${name} (${agent.pane_id})`;
    }
    const pane = this.snapshot?.panes.find((candidate) => candidate.pane_id === identity);
    const label = pane?.label || pane?.display_agent || pane?.agent;
    return label ? `${label} (${pane.pane_id})` : identity || caller;
  }

  private getNotePaneId(view: MarkdownView, leafId?: string): string {
    if (leafId) {
      return leafId;
    }
    let paneId = this.notePaneIds.get(view);
    if (!paneId) {
      paneId = `markdown-pane-${++this.notePaneSeq}`;
      this.notePaneIds.set(view, paneId);
    }
    return paneId;
  }

  private resolveEditorContext(el: Element): ElementLeafContext | null {
    const hostElement = resolveTopLevelElement(el) ?? el;
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    let context: ElementLeafContext | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view.containerEl.contains(hostElement)) {
        const file = (view as unknown as { file?: TFile | null }).file;
        if (!file) return;
        context = {
          notePath: file.path,
          pane: view instanceof MarkdownView ? this.getNotePaneId(view, (leaf as unknown as { id?: string }).id)
            : (leaf as unknown as { id?: string }).id,
          activePane: view === activeView,
        };
      }
    });
    return context;
  }

  private deliverCapturedTerminalInput(element: Element, data: string): boolean {
    const leaves: Array<{ view: unknown }> = [];
    this.app.workspace.iterateAllLeaves((leaf) => { leaves.push(leaf); });
    return deliverToTerminal(element, data, leaves);
  }

  private resolveBasesRowPath(element: Element | null, targetView: unknown): string | undefined {
    if (!element) return undefined;
    const view = targetView as {
      file?: TFile | null;
      controller?: { view?: { getCellFromDom?: (element: Element) => unknown } };
    } | null;
    const table = view?.controller?.view;
    const cellElement = element.closest(".bases-td");
    if (table?.getCellFromDom && cellElement) {
      const cell = table.getCellFromDom(element) as {
        el?: Element; renderer?: { entry?: { file?: TFile } };
      } | null;
      const file = cell?.renderer?.entry?.file;
      // The live cell lookup also works when the filename column is virtualized away.
      if (cell?.el === cellElement && file instanceof TFile && file.extension === "md" &&
        this.app.vault.getAbstractFileByPath(file.path) === file) return file.path;
      return undefined;
    }
    let row = element.closest(".bases-tr, .bases-table-row, [role='row']");
    for (let current: Element | null = element, depth = 0; !row && current && depth < 20; current = current.parentElement, depth++) {
      if (current.parentElement?.classList?.contains("bases-tbody")) row = current;
    }
    if (!row) return undefined;
    const nameCell = row.querySelector?.('.bases-td[data-property="file.name"]') ?? row.querySelector?.(".bases-td");
    const paths = new Set<string>();
    const nodes = [row, ...Array.from(nameCell?.querySelectorAll("[data-href], a.internal-link") ?? []),
      ...Array.from(row.querySelectorAll("[data-path], [data-file], [data-file-path]"))];
    for (const node of nodes) {
      for (const attribute of ["data-path", "data-file", "data-file-path", "data-href"]) {
        const path = node.getAttribute(attribute);
        if (!path) continue;
        const file = this.app.vault.getAbstractFileByPath(path) ?? (attribute === "data-href"
          ? this.app.metadataCache.getFirstLinkpathDest(path, view?.file?.path ?? "") : null);
        if (file instanceof TFile && file.extension === "md") paths.add(file.path);
      }
    }
    return paths.size === 1 ? [...paths][0] : undefined;
  }

  private captureUiMutation(context: UiMutationContext): ReturnType<VaultOpsService["captureUiMutation"]> {
    const element = context.targetElement;
    const hostElement = resolveTopLevelElement(element);
    if (!context.notePath && !element && !context.targetView) return this.vaultOps.captureUiMutation(context);
    let targetView: unknown = context.targetView;
    const suppliedFile = (targetView as { file?: TFile | null } | null)?.file;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      const file = (view as unknown as { file?: TFile | null }).file;
      // Card editors can be temporary MarkdownViews with no owning file.
      if (hostElement && file?.extension === "canvas" &&
        (file.path === context.notePath || (!context.notePath && !suppliedFile)) && view.containerEl?.contains(hostElement)) {
        targetView = view;
        return;
      }
      if (targetView) return;
      if (hostElement && view.containerEl?.contains(hostElement)) targetView = view;
      else if (!element && view instanceof MarkdownView && view.file?.path === context.notePath &&
        (!context.paneId || this.getNotePaneId(view, (leaf as unknown as { id?: string }).id) === context.paneId)) {
        targetView = view;
      }
    });
    const fileView = targetView as { file?: TFile | null; getViewType?: () => string } | undefined;
    const bound = { ...context, ...(targetView ? { targetView } : {}) };
    const isBases = fileView?.file?.extension === "base" || fileView?.getViewType?.() === "bases";
    const rowPath = isBases ? this.resolveBasesRowPath(element ?? null, targetView) : undefined;
    if (rowPath && bound.targetFilePath && rowPath !== bound.targetFilePath) {
      throw new BridgeRpcError("ui_snapshot_unavailable", "The Bases cell no longer belongs to the requested row note.");
    }
    if (fileView?.file) {
      bound.notePath ??= fileView.file.path;
      if (isBases && !bound.targetFilePath) bound.targetFilePath = rowPath;
    }
    // Only a Delete confirmation inside a modal establishes an expected deletion.
    const button = element?.closest("button, [role='button']");
    const modal = button?.closest(".modal");
    if (!bound.expectedFileOperation && modal && /^(delete|move to trash)$/i.test(button?.textContent?.trim() ?? "")) {
      const text = modal.textContent ?? "";
      const names = [...text.matchAll(/["“]([^"”]+)["”]/g)].map((match) => match[1]);
      const files = this.app.vault.getFiles().filter((file) => names.includes(file.path) || names.includes(file.name));
      if (files.length !== 1) {
        throw new BridgeRpcError("ui_snapshot_unavailable", "Cannot uniquely verify the file named by this Delete confirmation.");
      }
      bound.expectedFileOperation = { kind: "trash", path: files[0].path };
    }
    const captured = this.vaultOps.captureUiMutation(bound, targetView);
    if (!rowPath) return captured;
    return Promise.resolve(captured).then(async (complete) => {
      if (this.resolveBasesRowPath(element ?? null, targetView) !== rowPath) {
        await complete({ ok: false, errorCode: "ui_snapshot_unavailable" });
        throw new BridgeRpcError("ui_snapshot_unavailable", "The Bases row changed while its preimage was being captured.");
      }
      return complete;
    });
  }

  private resolveOpenNoteLeaf(notePath: string): (NoteLeafContext & { view: MarkdownView }) | null {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    let resolved: (NoteLeafContext & { view: MarkdownView }) | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file?.path !== notePath || view.getMode() !== "source") {
        return;
      }
      // This input host operates the main window, never a pop-out's coordinates.
      if (view.containerEl.ownerDocument !== window.document) {
        return;
      }
      const rect = view.containerEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || (resolved && view !== activeView)) {
        return;
      }
      resolved = {
        view,
        path: notePath,
        pane: this.getNotePaneId(view, (leaf as unknown as { id?: string }).id),
        activePane: view === activeView,
        containerEl: view.containerEl,
        cm: (view.editor as unknown as { cm?: CodeMirrorViewLike }).cm ?? null,
        contentText: view.editor.getValue(),
      };
    });
    return resolved;
  }

  private notifyVaultCursorActivity(
    caller: string,
    targetPath: string | undefined,
    _action: string,
    change?: VaultTextChange
  ): void {
    if (!this.getSettings().showAgentCursors) {
      return;
    }
    // Remove any old document marker before attempting to attribute a new edit.
    this.cursorOverlay.clearAgent(caller);
    if (!targetPath || !change) {
      return;
    }
    const leaf = this.resolveOpenNoteLeaf(targetPath);
    const cm = leaf?.cm;
    // Vault writes can precede the editor update. Never invent coordinates from stale text.
    if (!leaf || !cm?.coordsAtPos || cm.state?.doc?.toString() !== change.after) {
      return;
    }
    this.cursorOverlay.notifyNoteUpdated(targetPath);
    let pos = change.from + change.insertLength;
    if (!Number.isInteger(pos) || pos < 0 || pos > change.after.length) {
      return;
    }
    // Show the last written text rather than the blank line after an appended newline.
    while (pos > change.from && /[\r\n]/.test(change.after[pos - 1] ?? "")) {
      pos--;
    }
    const caret = cm.coordsAtPos(pos);
    if (!caret || !Number.isFinite(caret.left) || !Number.isFinite(caret.top) || !Number.isFinite(caret.bottom)) {
      return;
    }
    const bounds = (cm.scrollDOM ?? leaf.containerEl).getBoundingClientRect();
    const containerBounds = leaf.containerEl.getBoundingClientRect();
    const left = Math.max(0, bounds.left, containerBounds.left);
    const right = Math.min(window.innerWidth, bounds.right, containerBounds.right);
    const top = Math.max(0, bounds.top, containerBounds.top);
    const bottom = Math.min(window.innerHeight, bounds.bottom, containerBounds.bottom);
    const caretRight = caret.right ?? caret.left;
    const caretBottom = caret.bottom ?? caret.top;
    if (caret.left < left || caretRight > right || caret.top < top || caretBottom > bottom) {
      return;
    }
    const statusBar = window.document.querySelector<HTMLElement>(".status-bar")?.getBoundingClientRect();
    if (
      statusBar && statusBar.width > 0 && statusBar.height > 0 &&
      caretRight >= statusBar.left && caret.left <= statusBar.right &&
      caretBottom > statusBar.top && caret.top < statusBar.bottom
    ) {
      return;
    }
    const context = {
      notePath: targetPath,
      pane: leaf.pane,
      leafId: leaf.pane,
      pos,
      cm,
      containerEl: leaf.view.containerEl,
      view: leaf.view,
      getLeafNotePath: () => leaf.view.file?.path ?? null,
    };
    this.cursorOverlay.moveTo(caller, this.resolveCallerLabel(caller), caret.left, (caret.top + caretBottom) / 2, "note_update", context);
    this.cursorOverlay.parkAgent(caller, context);
  }

  private detectAgentStateTransitions(agents: AgentInfo[]): void {
    const settings = this.getSettings();
    const currentKeys = new Set<string>();

    for (const ag of agents) {
      const key = `${ag.pane_id}:${ag.name || ag.agent || "agent"}`;
      currentKeys.add(key);
      const prev = this.previousAgentStates.get(key);
      const curr = ag.agent_status;
      this.previousAgentStates.set(key, curr);

      if (prev && prev !== curr) {
        const label = ag.display_agent || ag.name || ag.agent || ag.pane_id;
        if (curr === "blocked" && settings.notifyOnAgentBlocked) {
          new Notice(`Herdr agent '${label}' is blocked and needs input (${ag.pane_id}).`, 6000);
        } else if (curr === "done" && settings.notifyOnAgentDone) {
          new Notice(`Herdr agent '${label}' finished background work (${ag.pane_id}).`, 4500);
        }
      }
    }

    for (const oldKey of Array.from(this.previousAgentStates.keys())) {
      if (!currentKeys.has(oldKey)) {
        this.previousAgentStates.delete(oldKey);
      }
    }
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
