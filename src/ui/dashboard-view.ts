import {
  ItemView,
  Notice,
  TFile,
  setIcon,
  type ViewStateResult,
  type WorkspaceLeaf,
} from "obsidian";
import type {
  AgentInfo,
  HerdrLayoutNode,
  HerdrPluginSettings,
  PaneLayoutSnapshot,
  SessionSnapshot,
  VaultPermissionMode,
} from "../domain/types";
import type { CoordinatorState, HerdrCoordinator } from "../services/herdr-coordinator";
import { resolveExecutableOnNormalizedPath } from "../herdr/cli-client";
import { CreateWorktreeModal, DispatchNoteModal, SpawnAgentModal } from "./modals";

export const VIEW_TYPE_HERDR_DASHBOARD = "herdr-view";

type DashboardTabId = "agents" | "topology" | "bridge" | "dispatch" | "doctor";

export class HerdrDashboardView extends ItemView {
  private readonly coordinator: HerdrCoordinator;
  private readonly getSettings: () => HerdrPluginSettings;
  private readonly updateSettings: (
    patch: Partial<HerdrPluginSettings>
  ) => Promise<void>;
  private readonly openTerminalLeaf: (options?: {
    profileId?: string;
    agentTarget?: string;
    sessionName?: string;
    split?: boolean;
  }) => Promise<void>;

  private activeTab: DashboardTabId = "agents";
  private selectedWorkspaceId = "";
  private selectedAgentKey = "";
  private liveTailText = "";
  private liveTailTarget = "";
  private promptDraft = "";

  private unsubCoord: (() => void) | null = null;
  private unsubAudit: (() => void) | null = null;
  private bodyHostEl: HTMLElement | null = null;

  constructor(options: {
    leaf: WorkspaceLeaf;
    coordinator: HerdrCoordinator;
    getSettings: () => HerdrPluginSettings;
    updateSettings: (patch: Partial<HerdrPluginSettings>) => Promise<void>;
    openTerminalLeaf: (opts?: {
      profileId?: string;
      agentTarget?: string;
      sessionName?: string;
      split?: boolean;
    }) => Promise<void>;
  }) {
    super(options.leaf);
    this.coordinator = options.coordinator;
    this.getSettings = options.getSettings;
    this.updateSettings = options.updateSettings;
    this.openTerminalLeaf = options.openTerminalLeaf;
  }

  getViewType(): string {
    return VIEW_TYPE_HERDR_DASHBOARD;
  }

  getDisplayText(): string {
    return "Herdr Mission Control";
  }

  getIcon(): string {
    return "cpu";
  }

  getState(): Record<string, unknown> {
    return {
      activeTab: this.activeTab,
      selectedWorkspaceId: this.selectedWorkspaceId,
    };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    if (state && typeof state === "object") {
      const s = state as { activeTab?: string; selectedWorkspaceId?: string };
      if (
        s.activeTab === "agents" ||
        s.activeTab === "topology" ||
        s.activeTab === "bridge" ||
        s.activeTab === "dispatch" ||
        s.activeTab === "doctor"
      ) {
        this.activeTab = s.activeTab;
      }
      if (typeof s.selectedWorkspaceId === "string") {
        this.selectedWorkspaceId = s.selectedWorkspaceId;
      }
    }
    await super.setState(state, result);
    this.renderDashboard();
  }

  onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("herdr-root", "herdr-dashboard-pane");

    this.bodyHostEl = root.createDiv({ cls: "herdr-dashboard-shell" });
    this.renderDashboard();

    this.unsubCoord = this.coordinator.onChange(() => {
      this.renderDashboard();
    });
    this.unsubAudit = this.coordinator.vaultOps.onAuditUpdated(() => {
      if (this.activeTab === "bridge") {
        this.renderDashboard();
      }
    });

    void this.coordinator.refreshAll(true);
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    this.unsubCoord?.();
    this.unsubCoord = null;
    this.unsubAudit?.();
    this.unsubAudit = null;
    this.contentEl.empty();
    return Promise.resolve();
  }

  private renderDashboard(): void {
    const host = this.bodyHostEl;
    if (!host) {
      return;
    }
    host.empty();

    const state = this.coordinator.getState();
    this.renderTopBar(host, state);
    this.renderSummaryStrip(host, state);
    this.renderTabNav(host, state);

    if (state.usingOfflinePreview) {
      this.renderOfflinePreviewBanner(host, state);
    }

    const panel = host.createDiv({ cls: "herdr-tab-panel" });
    switch (this.activeTab) {
      case "agents":
        this.renderAgentsTab(panel, state);
        break;
      case "topology":
        this.renderTopologyTab(panel, state);
        break;
      case "bridge":
        this.renderBridgeTab(panel, state);
        break;
      case "dispatch":
        this.renderDispatchTab(panel, state);
        break;
      case "doctor":
        this.renderDoctorTab(panel, state);
        break;
    }
  }

  private renderTopBar(parent: HTMLElement, state: CoordinatorState): void {
    const top = parent.createDiv({ cls: "herdr-topbar" });

    const titleWrap = top.createDiv({ cls: "herdr-topbar-brand" });
    const iconSpan = titleWrap.createSpan({ cls: "herdr-brand-icon" });
    setIcon(iconSpan, "cpu");
    const textWrap = titleWrap.createDiv({ cls: "herdr-brand-text" });
    textWrap.createDiv({ cls: "herdr-topbar-title", text: "Herdr Mission Control" });
    textWrap.createDiv({
      cls: "herdr-topbar-subtitle",
      text: state.serverRunning
        ? `Connected to session '${state.activeSessionName}' (${state.snapshot?.version || "live"})`
        : state.binaryPath
          ? `Session '${state.activeSessionName}' is idle`
          : "Herdr binary not detected on PATH",
    });

    const actions = top.createDiv({ cls: "herdr-topbar-actions" });

    if (!state.serverRunning && state.binaryPath) {
      const startBtn = actions.createEl("button", {
        text: "Start session",
        cls: "mod-cta herdr-btn-compact",
      });
      startBtn.addEventListener("click", () => {
        void this.handleStartSession();
      });
    } else if (state.serverRunning) {
      const stopBtn = actions.createEl("button", {
        text: "Stop session",
        cls: "herdr-btn-compact",
      });
      stopBtn.addEventListener("click", () => {
        void this.handleStopSession();
      });
    }

    const termBtn = actions.createEl("button", {
      text: "Open terminal",
      cls: state.serverRunning ? "mod-cta herdr-btn-compact" : "herdr-btn-compact",
    });
    termBtn.addEventListener("click", () => {
      void this.openTerminalLeaf({ split: false });
    });

    const spawnBtn = actions.createEl("button", {
      text: "Spawn agent",
      cls: "herdr-btn-compact",
    });
    spawnBtn.addEventListener("click", () => {
      new SpawnAgentModal(
        this.app,
        this.coordinator,
        this.getSettings().defaultAgentKind,
        () => {
          this.renderDashboard();
        }
      ).open();
    });

    const refreshBtn = actions.createEl("button", {
      cls: "clickable-icon herdr-icon-btn",
      attr: { "aria-label": "Refresh runtime snapshot", title: "Refresh runtime snapshot" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => {
      void this.coordinator.refreshAll(true);
    });
  }

  private renderSummaryStrip(parent: HTMLElement, state: CoordinatorState): void {
    const strip = parent.createDiv({ cls: "herdr-kpi-strip" });
    const snap = state.snapshot;
    const agents = snap?.agents ?? [];
    const workingCount = agents.filter((a) => a.agent_status === "working").length;
    const blockedCount = agents.filter((a) => a.agent_status === "blocked").length;
    const doneCount = agents.filter((a) => a.agent_status === "done").length;

    this.createKpiCard(
      strip,
      "Daemon",
      state.serverRunning ? "Live" : state.usingOfflinePreview ? "Preview" : "Stopped",
      state.serverRunning ? "working" : "idle"
    );
    this.createKpiCard(
      strip,
      "Workspaces / panes",
      snap ? `${snap.workspaces.length} / ${snap.panes.length}` : "0 / 0",
      "idle"
    );
    this.createKpiCard(
      strip,
      "Working / done",
      `${workingCount} / ${doneCount}`,
      workingCount > 0 ? "working" : doneCount > 0 ? "done" : "idle"
    );
    this.createKpiCard(
      strip,
      "Blocked",
      String(blockedCount),
      blockedCount > 0 ? "blocked" : "idle"
    );
    this.createKpiCard(
      strip,
      "Vault Bridge",
      state.bridgeRunning ? this.getSettings().vaultPermissionMode : "off",
      state.bridgeRunning ? "done" : "idle"
    );
  }

  private createKpiCard(
    parent: HTMLElement,
    label: string,
    value: string,
    tone: string
  ): void {
    const card = parent.createDiv({ cls: `herdr-kpi-card herdr-tone-${tone}` });
    card.createDiv({ cls: "herdr-kpi-label", text: label });
    card.createDiv({ cls: "herdr-kpi-value", text: value });
  }

  private renderTabNav(parent: HTMLElement, state: CoordinatorState): void {
    const nav = parent.createDiv({
      cls: "herdr-tab-nav",
      attr: { role: "tablist", "aria-label": "Mission Control sections" },
    });
    const auditCount = this.coordinator.vaultOps.getAuditLog().length;
    const agentCount = state.snapshot?.agents.length ?? 0;

    const tabs: Array<{ id: DashboardTabId; label: string }> = [
      { id: "agents", label: `Agents (${agentCount})` },
      { id: "topology", label: "Topology & worktrees" },
      { id: "bridge", label: `Vault Bridge (${auditCount})` },
      { id: "dispatch", label: "Context dispatch" },
      { id: "doctor", label: "Doctor & sessions" },
    ];

    for (const item of tabs) {
      const btn = nav.createEl("button", {
        text: item.label,
        cls: `herdr-nav-tab ${this.activeTab === item.id ? "is-active" : ""}`,
        attr: {
          role: "tab",
          "aria-selected": this.activeTab === item.id ? "true" : "false",
          type: "button",
        },
      });
      btn.addEventListener("click", () => {
        this.activeTab = item.id;
        this.renderDashboard();
      });
    }
  }

  private renderOfflinePreviewBanner(parent: HTMLElement, state: CoordinatorState): void {
    const banner = parent.createDiv({ cls: "herdr-preview-banner" });
    const msg = banner.createDiv({ cls: "herdr-preview-text" });
    msg.createEl("strong", { text: "Offline preview snapshot: " });
    msg.createSpan({
      text: state.binaryPath
        ? "Showing sample Herdr layout until you start or attach to a live Herdr session."
        : "Install Herdr from herdr.dev or use Open terminal for interactive local shells with Vault Control Bridge.",
    });

    if (state.binaryPath) {
      const btn = banner.createEl("button", {
        text: "Start live vault session",
        cls: "mod-cta herdr-btn-compact",
      });
      btn.addEventListener("click", () => {
        void this.handleStartSession();
      });
    }
  }

  private renderAgentsTab(parent: HTMLElement, state: CoordinatorState): void {
    const snap = state.snapshot;
    const agents = snap?.agents ?? [];

    if (agents.length === 0) {
      const empty = parent.createDiv({ cls: "herdr-empty-card" });
      empty.createEl("p", {
        text: state.serverRunning
          ? "No coding agents are currently active in this Herdr session."
          : "No active Herdr session is connected.",
      });
      const row = empty.createDiv({ cls: "herdr-action-row" });
      if (state.serverRunning) {
        const spawnBtn = row.createEl("button", {
          text: "Spawn agent in split pane",
          cls: "mod-cta",
        });
        spawnBtn.addEventListener("click", () => {
          new SpawnAgentModal(
            this.app,
            this.coordinator,
            this.getSettings().defaultAgentKind
          ).open();
        });
      } else if (state.binaryPath) {
        const startBtn = row.createEl("button", {
          text: "Start vault Herdr session",
          cls: "mod-cta",
        });
        startBtn.addEventListener("click", () => {
          void this.handleStartSession();
        });
      }
      const shellBtn = row.createEl("button", { text: "Open embedded terminal" });
      shellBtn.addEventListener("click", () => {
        void this.openTerminalLeaf({});
      });
      return;
    }

    const grid = parent.createDiv({ cls: "herdr-agent-grid" });
    for (const agent of agents) {
      this.renderAgentCard(grid, agent, state);
    }

    if (this.liveTailTarget) {
      const tailCard = parent.createDiv({ cls: "herdr-section-card" });
      const head = tailCard.createDiv({ cls: "herdr-card-header" });
      head.createSpan({
        cls: "herdr-card-title",
        text: `Terminal output tail: ${this.liveTailTarget}`,
      });
      const closeBtn = head.createEl("button", {
        text: "Close preview",
        cls: "herdr-btn-compact",
      });
      closeBtn.addEventListener("click", () => {
        this.liveTailTarget = "";
        this.liveTailText = "";
        this.renderDashboard();
      });

      const pre = tailCard.createEl("pre", { cls: "herdr-terminal-tail" });
      pre.setText(this.liveTailText || "(empty terminal output)");
    }
  }

  private renderAgentCard(
    parent: HTMLElement,
    agent: AgentInfo,
    state: CoordinatorState
  ): void {
    const card = parent.createDiv({
      cls: `herdr-agent-card herdr-border-${agent.agent_status}`,
    });

    const header = card.createDiv({ cls: "herdr-card-header" });
    const titleGroup = header.createDiv({ cls: "herdr-card-title-group" });
    titleGroup.createSpan({
      cls: "herdr-card-title",
      text: agent.display_agent || agent.name || agent.agent || agent.pane_id,
    });
    titleGroup.createSpan({
      cls: "herdr-mono-badge",
      text: agent.pane_id,
    });

    header.createSpan({
      cls: `herdr-status-pill herdr-status-${agent.agent_status}`,
      text: agent.agent_status,
    });

    if (agent.terminal_title_stripped) {
      card.createDiv({
        cls: "herdr-agent-subtitle",
        text: agent.terminal_title_stripped,
      });
    }

    const meta = card.createDiv({ cls: "herdr-agent-meta" });
    meta.createSpan({ text: `Runtime: ${agent.agent || "shell"}` });
    if (agent.cwd) {
      meta.createSpan({ text: `CWD: ${agent.cwd}` });
    }

    const targetId = agent.name || agent.pane_id;

    if (agent.agent_status === "blocked") {
      const quickBar = card.createDiv({ cls: "herdr-blocked-bar" });
      quickBar.createSpan({
        cls: "herdr-blocked-label",
        text: "Agent needs input:",
      });
      for (const keySpec of [
        { label: "Approve (y + Enter)", keys: ["y", "enter"] },
        { label: "Enter", keys: ["enter"] },
        { label: "Esc", keys: ["esc"] },
        { label: "Cancel (Ctrl+C)", keys: ["ctrl+c"] },
      ]) {
        const kBtn = quickBar.createEl("button", {
          text: keySpec.label,
          cls: "herdr-btn-compact",
        });
        kBtn.disabled = state.usingOfflinePreview;
        kBtn.addEventListener("click", () => {
          void this.sendAgentQuickKeys(targetId, keySpec.keys);
        });
      }
    }

    const promptRow = card.createDiv({ cls: "herdr-prompt-row" });
    const input = promptRow.createEl("input", {
      type: "text",
      cls: "herdr-prompt-input",
      placeholder: state.usingOfflinePreview
        ? "Start live session to prompt agent..."
        : `Prompt ${targetId}...`,
      attr: { "aria-label": `Prompt ${targetId}` },
    });
    input.disabled = state.usingOfflinePreview;
    if (this.selectedAgentKey === targetId && this.promptDraft) {
      input.value = this.promptDraft;
    }
    input.addEventListener("input", () => {
      this.selectedAgentKey = targetId;
      this.promptDraft = input.value;
    });

    const sendBtn = promptRow.createEl("button", {
      text: "Send",
      cls: "mod-cta herdr-btn-compact",
    });
    sendBtn.disabled = state.usingOfflinePreview;
    const submitPrompt = () => {
      const val = input.value.trim();
      if (!val) {
        return;
      }
      input.value = "";
      this.promptDraft = "";
      void this.promptSingleAgent(targetId, val);
    };
    sendBtn.addEventListener("click", submitPrompt);
    input.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submitPrompt();
      }
    });

    const actions = card.createDiv({ cls: "herdr-action-row" });
    const tailBtn = actions.createEl("button", {
      text: "Read output",
      cls: "herdr-btn-compact",
    });
    tailBtn.addEventListener("click", () => {
      void this.loadAgentTail(targetId, state.usingOfflinePreview);
    });

    const explainBtn = actions.createEl("button", {
      text: "Explain state",
      cls: "herdr-btn-compact",
    });
    explainBtn.disabled = state.usingOfflinePreview;
    explainBtn.addEventListener("click", () => {
      void this.loadAgentExplain(targetId);
    });

    const attachBtn = actions.createEl("button", {
      text: "Attach in terminal",
      cls: "herdr-btn-compact",
    });
    attachBtn.disabled = state.usingOfflinePreview;
    attachBtn.addEventListener("click", () => {
      void this.openTerminalLeaf({
        agentTarget: targetId,
        sessionName: state.activeSessionName,
        split: true,
      });
    });

    const sendNoteBtn = actions.createEl("button", {
      text: "Send active note",
      cls: "herdr-btn-compact",
    });
    sendNoteBtn.disabled = state.usingOfflinePreview;
    sendNoteBtn.addEventListener("click", () => {
      new DispatchNoteModal(this.app, this.coordinator, targetId).open();
    });
  }

  private renderTopologyTab(parent: HTMLElement, state: CoordinatorState): void {
    const snap = state.snapshot;
    const toolbar = parent.createDiv({ cls: "herdr-section-toolbar" });

    const newWsBtn = toolbar.createEl("button", {
      text: "New vault workspace",
      cls: "mod-cta herdr-btn-compact",
    });
    newWsBtn.disabled = !state.serverRunning;
    newWsBtn.addEventListener("click", () => {
      void this.coordinator.createVaultWorkspace().catch((err: unknown) => {
        new Notice(err instanceof Error ? err.message : String(err));
      });
    });

    const wtBtn = toolbar.createEl("button", {
      text: "New Git worktree",
      cls: "herdr-btn-compact",
    });
    wtBtn.disabled = !state.serverRunning;
    wtBtn.addEventListener("click", () => {
      new CreateWorktreeModal(this.app, this.coordinator).open();
    });

    const applyLayoutBtn = toolbar.createEl("button", {
      text: "Apply layout from note",
      cls: "herdr-btn-compact",
    });
    applyLayoutBtn.disabled = !state.serverRunning;
    applyLayoutBtn.addEventListener("click", () => {
      const targetWsId =
        (this.selectedWorkspaceId &&
          snap?.workspaces.some((w) => w.workspace_id === this.selectedWorkspaceId)
          ? this.selectedWorkspaceId
          : snap?.focused_workspace_id || snap?.workspaces[0]?.workspace_id) || undefined;
      void this.applyLayoutFromActiveNote(targetWsId);
    });

    const filterViewBtn = toolbar.createEl("button", {
      text: "Filter TUI to workspace",
      cls: "herdr-btn-compact",
    });
    filterViewBtn.disabled = !state.serverRunning || !snap?.workspaces.length;
    filterViewBtn.addEventListener("click", () => {
      const targetWsId =
        this.selectedWorkspaceId &&
        snap?.workspaces.some((w) => w.workspace_id === this.selectedWorkspaceId)
          ? this.selectedWorkspaceId
          : snap?.focused_workspace_id || snap?.workspaces[0]?.workspace_id || "";
      if (targetWsId) {
        void this.setWorkspaceTuiFilter(targetWsId);
      }
    });

    const clearViewBtn = toolbar.createEl("button", {
      text: "Clear TUI filter",
      cls: "herdr-btn-compact",
    });
    clearViewBtn.disabled = !state.serverRunning;
    clearViewBtn.addEventListener("click", () => {
      void this.clearWorkspaceTuiFilter();
    });

    if (!snap || snap.workspaces.length === 0) {
      parent.createDiv({
        cls: "herdr-empty-card",
        text: "No Herdr workspaces are available. Start a session to inspect workspaces, tabs, and split panes.",
      });
      return;
    }

    const activeWsId =
      this.selectedWorkspaceId &&
      snap.workspaces.some((w) => w.workspace_id === this.selectedWorkspaceId)
        ? this.selectedWorkspaceId
        : snap.focused_workspace_id || snap.workspaces[0].workspace_id;

    const wsRow = parent.createDiv({ cls: "herdr-workspace-chips" });
    for (const ws of snap.workspaces) {
      const chip = wsRow.createEl("button", {
        cls: `herdr-ws-chip ${ws.workspace_id === activeWsId ? "is-selected" : ""}`,
        text: `${ws.label} (${ws.workspace_id})`,
      });
      chip.addEventListener("click", () => {
        this.selectedWorkspaceId = ws.workspace_id;
        if (state.serverRunning) {
          void this.coordinator.socket.focusWorkspace(ws.workspace_id).then(() =>
            this.coordinator.refreshAll(false)
          );
        } else {
          this.renderDashboard();
        }
      });
    }

    const selectedWs = snap.workspaces.find((w) => w.workspace_id === activeWsId);
    if (selectedWs?.worktree) {
      const wtBanner = parent.createDiv({ cls: "herdr-worktree-chip" });
      wtBanner.setText(
        `Git worktree: ${selectedWs.worktree.repo_name} -> ${selectedWs.worktree.checkout_path}`
      );
    }

    const wsTabs = snap.tabs.filter((t) => t.workspace_id === activeWsId);
    for (const tab of wsTabs) {
      const tabCard = parent.createDiv({ cls: "herdr-section-card" });
      const head = tabCard.createDiv({ cls: "herdr-card-header" });
      head.createSpan({
        cls: "herdr-card-title",
        text: `Tab ${tab.number}: ${tab.label} (${tab.tab_id})`,
      });
      const headRight = head.createDiv({ cls: "herdr-action-row" });
      headRight.createSpan({
        cls: `herdr-status-pill herdr-status-${tab.agent_status}`,
        text: tab.agent_status,
      });
      const saveLayoutBtn = headRight.createEl("button", {
        text: "Save layout to note",
        cls: "herdr-btn-compact",
      });
      saveLayoutBtn.disabled = !state.serverRunning;
      saveLayoutBtn.addEventListener("click", () => {
        void this.saveTabLayoutToNote(
          selectedWs?.label || activeWsId,
          tab.tab_id,
          tab.label
        );
      });

      const layout = snap.layouts.find((l) => l.tab_id === tab.tab_id);
      if (layout && layout.panes.length > 0) {
        this.renderLayoutMap(tabCard, layout, snap, state.serverRunning);
      }

      const panesInTab = snap.panes.filter(
        (p) =>
          p.tab_id === tab.tab_id ||
          Boolean(layout?.panes.some((lp) => lp.pane_id === p.pane_id))
      );

      const list = tabCard.createDiv({ cls: "herdr-pane-list" });
      for (const pane of panesInTab) {
        const row = list.createDiv({ cls: "herdr-pane-row" });
        const info = row.createDiv({ cls: "herdr-pane-info" });
        info.createSpan({ cls: "herdr-mono-badge", text: pane.pane_id });
        info.createSpan({
          text:
            pane.display_agent ||
            pane.label ||
            pane.terminal_title_stripped ||
            pane.cwd ||
            "shell",
        });
        info.createSpan({
          cls: `herdr-status-pill herdr-status-${pane.agent_status}`,
          text: pane.agent_status,
        });

        const controls = row.createDiv({ cls: "herdr-pane-controls" });
        for (const act of [
          {
            label: "Split right",
            fn: () =>
              this.coordinator.socket.splitPane({
                targetPaneId: pane.pane_id,
                direction: "right",
                cwd: this.coordinator.vaultOps.getVaultBasePath() || undefined,
                env: this.coordinator.getBridgeEnv(),
              }),
          },
          {
            label: "Split down",
            fn: () =>
              this.coordinator.socket.splitPane({
                targetPaneId: pane.pane_id,
                direction: "down",
                cwd: this.coordinator.vaultOps.getVaultBasePath() || undefined,
                env: this.coordinator.getBridgeEnv(),
              }),
          },
          {
            label: "Zoom",
            fn: () => this.coordinator.socket.zoomPane(pane.pane_id, "toggle"),
          },
        ]) {
          const b = controls.createEl("button", {
            text: act.label,
            cls: "herdr-btn-compact",
          });
          b.disabled = !state.serverRunning;
          b.addEventListener("click", () => {
            void act
              .fn()
              .then(() => this.coordinator.refreshAll(false))
              .catch((err: unknown) => {
                new Notice(err instanceof Error ? err.message : String(err));
              });
          });
        }
      }
    }

    if (state.worktrees.length > 0) {
      const wtCard = parent.createDiv({ cls: "herdr-section-card" });
      wtCard.createDiv({
        cls: "herdr-card-title",
        text: `Git worktrees (${state.worktrees.length})`,
      });
      const wtList = wtCard.createDiv({ cls: "herdr-pane-list" });
      for (const wt of state.worktrees) {
        const row = wtList.createDiv({ cls: "herdr-pane-row" });
        const info = row.createDiv({ cls: "herdr-pane-info" });
        info.createSpan({
          cls: "herdr-mono-badge",
          text: wt.branch || wt.label || "worktree",
        });
        info.createSpan({ cls: "herdr-muted-copy", text: wt.path });
        const openWsId = wt.open_workspace_id || wt.workspace_id || "";
        if (openWsId) {
          info.createSpan({
            cls: "herdr-status-pill herdr-status-working",
            text: openWsId,
          });
        }

        const controls = row.createDiv({ cls: "herdr-pane-controls" });
        if (!openWsId) {
          const openBtn = controls.createEl("button", {
            text: "Open worktree",
            cls: "herdr-btn-compact",
          });
          openBtn.disabled = !state.serverRunning;
          openBtn.addEventListener("click", () => {
            void this.coordinator.socket
              .openWorktree({
                path: wt.path,
                branch: wt.branch || undefined,
                focus: true,
              })
              .then(() => this.coordinator.refreshAll(true))
              .catch((err: unknown) => {
                new Notice(err instanceof Error ? err.message : String(err));
              });
          });
        } else if (wt.is_linked_worktree !== false && !wt.is_main) {
          const rmBtn = controls.createEl("button", {
            text: "Remove worktree",
            cls: "herdr-btn-compact",
          });
          rmBtn.disabled = !state.serverRunning;
          rmBtn.addEventListener("click", () => {
            void this.coordinator.socket
              .removeWorktree(openWsId, false)
              .then(() => this.coordinator.refreshAll(true))
              .catch((err: unknown) => {
                new Notice(err instanceof Error ? err.message : String(err));
              });
          });
        }
      }
    }
  }

  private renderLayoutMap(
    parent: HTMLElement,
    layout: PaneLayoutSnapshot,
    snap: SessionSnapshot,
    live: boolean
  ): void {
    const originX =
      typeof layout.area.x === "number"
        ? layout.area.x
        : Math.min(...layout.panes.map((p) => p.rect.x));
    const originY =
      typeof layout.area.y === "number"
        ? layout.area.y
        : Math.min(...layout.panes.map((p) => p.rect.y));
    const totalW = Math.max(1, layout.area.width);
    const totalH = Math.max(1, layout.area.height);
    const canvas = parent.createDiv({ cls: "herdr-layout-map" });

    for (const lp of layout.panes) {
      const paneMeta = snap.panes.find((p) => p.pane_id === lp.pane_id);
      const relX = Math.max(0, lp.rect.x - originX);
      const relY = Math.max(0, lp.rect.y - originY);
      const leftPct = ((relX / totalW) * 100).toFixed(2) + "%";
      const topPct = ((relY / totalH) * 100).toFixed(2) + "%";
      const widthPct = ((lp.rect.width / totalW) * 100).toFixed(2) + "%";
      const heightPct = ((lp.rect.height / totalH) * 100).toFixed(2) + "%";

      const cell = canvas.createEl("button", {
        cls: `herdr-layout-cell ${lp.focused ? "is-focused" : ""} herdr-border-${paneMeta?.agent_status || "idle"}`,
        attr: { type: "button" },
      });
      cell.style.setProperty("--herdr-rect-left", leftPct);
      cell.style.setProperty("--herdr-rect-top", topPct);
      cell.style.setProperty("--herdr-rect-width", widthPct);
      cell.style.setProperty("--herdr-rect-height", heightPct);

      cell.createSpan({ cls: "herdr-mono-badge", text: lp.pane_id });
      cell.createSpan({
        cls: "herdr-cell-title",
        text: paneMeta?.display_agent || paneMeta?.label || paneMeta?.agent || "shell",
      });

      if (live) {
        cell.addEventListener("click", () => {
          void this.coordinator.socket
            .focusPane(lp.pane_id)
            .then(() => this.coordinator.refreshAll(false));
        });
      }
    }
  }

  private renderBridgeTab(parent: HTMLElement, state: CoordinatorState): void {
    const card = parent.createDiv({ cls: "herdr-section-card" });
    const head = card.createDiv({ cls: "herdr-card-header" });
    head.createSpan({
      cls: "herdr-card-title",
      text: "Obsidian Vault Control Bridge",
    });
    head.createSpan({
      cls: `herdr-status-pill ${state.bridgeRunning ? "herdr-status-done" : "herdr-status-idle"}`,
      text: state.bridgeRunning ? "Active (authenticated)" : "Stopped",
    });

    card.createEl("p", {
      cls: "herdr-muted-copy",
      text: "Lets Herdr panes and AI coding agents read, search, edit frontmatter, link-safe rename, trash, and open vault notes through native Obsidian APIs over a mode-0600 local socket.",
    });

    const permRow = card.createDiv({ cls: "herdr-permission-row" });
    permRow.createSpan({ cls: "herdr-field-label", text: "Permission tier:" });

    const currentMode = this.getSettings().vaultPermissionMode;
    const modes: Array<{ id: VaultPermissionMode; label: string }> = [
      { id: "read-only", label: "Read-only" },
      { id: "read-write", label: "Read-write (safe APIs)" },
      { id: "full", label: "Full (+ commands)" },
      { id: "off", label: "Off" },
    ];
    for (const m of modes) {
      const btn = permRow.createEl("button", {
        text: m.label,
        cls: `herdr-btn-compact ${currentMode === m.id ? "mod-cta" : ""}`,
      });
      btn.addEventListener("click", () => {
        void this.updateSettings({
          vaultBridgeEnabled: m.id !== "off",
          vaultPermissionMode: m.id,
        });
      });
    }

    const pathGrid = card.createDiv({ cls: "herdr-kv-grid" });
    this.addKvRow(pathGrid, "Bridge socket", state.bridgeSocketPath);
    this.addKvRow(pathGrid, "CLI & MCP binary", state.cliScriptPath);
    this.addKvRow(pathGrid, "Herdr plugin manifest", state.herdrPluginManifestPath);

    const actions = card.createDiv({ cls: "herdr-action-row" });

    const selfTestBtn = actions.createEl("button", {
      text: "Run live bridge self-test",
      cls: "herdr-btn-compact",
    });
    selfTestBtn.addEventListener("click", () => {
      void this.runBridgeSelfTest();
    });

    const copyCliBtn = actions.createEl("button", {
      text: "Copy obs-herdr CLI path",
      cls: "herdr-btn-compact",
    });
    copyCliBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(state.cliScriptPath);
      new Notice("Copied obs-herdr CLI path to clipboard.");
    });

    const copyMcpBtn = actions.createEl("button", {
      text: "Copy MCP JSON config",
      cls: "herdr-btn-compact",
    });
    copyMcpBtn.addEventListener("click", () => {
      const mcpJson = JSON.stringify(
        {
          mcpServers: {
            "obsidian-vault": {
              command: state.cliScriptPath,
              args: ["mcp"],
            },
          },
        },
        null,
        2
      );
      void navigator.clipboard.writeText(mcpJson);
      new Notice("Copied stdio MCP server configuration to clipboard.");
    });

    if (state.serverRunning) {
      const isLinked = state.installedPlugins.some(
        (p) =>
          p.plugin_id === "obsidian.vault" ||
          p.id === "obsidian.vault" ||
          p.manifest_path === state.herdrPluginManifestPath
      );
      const linkBtn = actions.createEl("button", {
        text: isLinked ? "Unlink obsidian.vault Herdr plugin" : "Link obsidian.vault into Herdr",
        cls: "herdr-btn-compact",
      });
      linkBtn.addEventListener("click", () => {
        void (isLinked
          ? this.coordinator.unlinkObsidianHerdrPlugin()
          : this.coordinator.linkObsidianHerdrPlugin()
        )
          .then(() => {
            new Notice(
              isLinked
                ? "Unlinked obsidian.vault from Herdr."
                : "Linked obsidian.vault native actions into Herdr."
            );
          })
          .catch((err: unknown) => {
            new Notice(err instanceof Error ? err.message : String(err));
          });
      });
    }

    // Audit Log
    const auditCard = parent.createDiv({ cls: "herdr-section-card" });
    const auditHead = auditCard.createDiv({ cls: "herdr-card-header" });
    auditHead.createSpan({
      cls: "herdr-card-title",
      text: "Vault Control Audit Log",
    });

    const entries = this.coordinator.vaultOps.getAuditLog();
    if (entries.length > 0) {
      const clearBtn = auditHead.createEl("button", {
        text: "Clear log",
        cls: "herdr-btn-compact",
      });
      clearBtn.addEventListener("click", () => {
        this.coordinator.vaultOps.clearAuditLog();
      });
    }

    if (entries.length === 0) {
      auditCard.createDiv({
        cls: "herdr-muted-copy",
        text: "No vault bridge requests recorded in this session yet.",
      });
      return;
    }

    const list = auditCard.createDiv({ cls: "herdr-audit-list" });
    for (const item of entries.slice(0, 40)) {
      const row = list.createDiv({
        cls: `herdr-audit-row ${item.allowed ? "is-allowed" : "is-denied"}`,
      });
      const main = row.createDiv({ cls: "herdr-audit-main" });
      main.createSpan({
        cls: "herdr-mono-badge",
        text: new Date(item.timestamp).toLocaleTimeString(),
      });
      main.createSpan({ cls: "herdr-mono-badge", text: item.method });
      main.createSpan({ text: item.summary });

      const rowBtns = row.createDiv({ cls: "herdr-audit-actions" });
      if (item.targetPath) {
        const af = this.app.vault.getAbstractFileByPath(item.targetPath);
        if (af instanceof TFile) {
          const openBtn = rowBtns.createEl("button", {
            text: "Open note",
            cls: "herdr-btn-compact",
          });
          openBtn.addEventListener("click", () => {
            void this.app.workspace.getLeaf(false).openFile(af);
          });
        }
      }
      if (item.snapshot && !item.undone) {
        const undoBtn = rowBtns.createEl("button", {
          text: "Undo",
          cls: "herdr-btn-compact",
        });
        undoBtn.addEventListener("click", () => {
          void this.coordinator.vaultOps
            .undoMutation(item.id)
            .then((msg) => {
              new Notice(msg);
              this.renderDashboard();
            })
            .catch((err: unknown) => {
              new Notice(err instanceof Error ? err.message : String(err));
            });
        });
      } else if (item.undone) {
        rowBtns.createSpan({ cls: "herdr-muted-copy", text: "Undone" });
      }
    }
  }

  private renderDispatchTab(parent: HTMLElement, state: CoordinatorState): void {
    const card = parent.createDiv({ cls: "herdr-section-card" });
    card.createDiv({
      cls: "herdr-card-title",
      text: "Send vault note context to Herdr",
    });

    const activeFile = this.app.workspace.getActiveFile();
    card.createEl("p", {
      cls: "herdr-muted-copy",
      text: activeFile
        ? `Active note: ${activeFile.path} (${activeFile.stat.size} bytes)`
        : "Open any Markdown note to bundle its frontmatter, backlinks, and body for a Herdr agent.",
    });

    const row = card.createDiv({ cls: "herdr-action-row" });
    const modalBtn = row.createEl("button", {
      text: "Open context dispatcher",
      cls: "mod-cta",
    });
    modalBtn.disabled = !state.serverRunning;
    modalBtn.addEventListener("click", () => {
      new DispatchNoteModal(this.app, this.coordinator).open();
    });

    const copyPackBtn = row.createEl("button", {
      text: "Copy active note context pack",
    });
    copyPackBtn.addEventListener("click", () => {
      void this.coordinator
        .buildActiveNoteContextPack({ includeBacklinks: true })
        .then((pack) => {
          void navigator.clipboard.writeText(pack.payload);
          new Notice(`Copied context pack for '${pack.title}'.`);
        });
    });
  }

  private renderDoctorTab(parent: HTMLElement, state: CoordinatorState): void {
    const diagCard = parent.createDiv({ cls: "herdr-section-card" });
    diagCard.createDiv({ cls: "herdr-card-title", text: "Runtime diagnostics" });

    const kv = diagCard.createDiv({ cls: "herdr-kv-grid" });
    this.addKvRow(kv, "Herdr binary", state.binaryPath || "Not found on PATH");
    this.addKvRow(
      kv,
      "Client version / protocol",
      state.statusPayload?.client?.version
        ? `${state.statusPayload.client.version} (protocol ${state.statusPayload.client.protocol ?? "?"})`
        : "No data"
    );
    this.addKvRow(kv, "Target session", state.activeSessionName);
    this.addKvRow(kv, "Herdr socket", state.socketPath);
    this.addKvRow(kv, "IPC transport", state.socketTransport);
    this.addKvRow(kv, "Connection endpoint", state.connectionPath);
    this.addKvRow(
      kv,
      "Event stream subscription",
      state.socketSubscribed ? "Subscribed (live push)" : "Disconnected"
    );
    if (state.lastError) {
      this.addKvRow(kv, "Last diagnostic message", state.lastError);
    }

    const sessionsCard = parent.createDiv({ cls: "herdr-section-card" });
    sessionsCard.createDiv({ cls: "herdr-card-title", text: "Named Herdr sessions" });

    if (state.sessions.length === 0) {
      sessionsCard.createDiv({
        cls: "herdr-muted-copy",
        text: "No named sessions reported by herdr session list.",
      });
    } else {
      const sList = sessionsCard.createDiv({ cls: "herdr-pane-list" });
      for (const s of state.sessions) {
        const row = sList.createDiv({ cls: "herdr-pane-row" });
        const info = row.createDiv({ cls: "herdr-pane-info" });
        info.createSpan({ cls: "herdr-mono-badge", text: s.name });
        info.createSpan({
          cls: `herdr-status-pill ${s.status === "running" ? "herdr-status-working" : "herdr-status-idle"}`,
          text: s.status,
        });
        info.createSpan({ cls: "herdr-muted-copy", text: s.socket });

        const attachBtn = row.createEl("button", {
          text: "Attach terminal",
          cls: "herdr-btn-compact",
        });
        attachBtn.addEventListener("click", () => {
          void this.openTerminalLeaf({ sessionName: s.name });
        });
      }
    }

    const cliCard = parent.createDiv({ cls: "herdr-section-card" });
    cliCard.createDiv({
      cls: "herdr-card-title",
      text: "Detected CLI runtimes",
    });
    const cliGrid = cliCard.createDiv({ cls: "herdr-integration-grid" });
    const cliChecks: Array<{ label: string; found: boolean; detail: string }> = [
      { label: "herdr", found: Boolean(state.binaryPath), detail: state.binaryPath || "" },
      { label: "obs-herdr", found: state.bridgeRunning, detail: state.cliScriptPath },
    ];
    for (const cliName of ["codex", "claude", "agy", "gemini", "opencode"]) {
      const resolved = resolveExecutableOnNormalizedPath(cliName);
      cliChecks.push({ label: cliName, found: Boolean(resolved), detail: resolved || "" });
    }
    for (const check of cliChecks) {
      const pill = cliGrid.createDiv({
        cls: "herdr-integration-item",
        attr: check.detail ? { title: check.detail } : {},
      });
      pill.createSpan({ text: check.label });
      pill.createSpan({
        cls: `herdr-status-pill ${check.found ? "herdr-status-done" : "herdr-status-idle"}`,
        text: check.found ? "detected" : "not found",
      });
    }

    const intCard = parent.createDiv({ cls: "herdr-section-card" });
    intCard.createDiv({
      cls: "herdr-card-title",
      text: "Optional Herdr lifecycle hooks (read-only)",
    });
    intCard.createEl("p", {
      cls: "herdr-muted-copy",
      text: "Optional shell hooks from Herdr. CLI agents still launch and run inside Herdr panes without them.",
    });

    if (state.integrations.length === 0) {
      intCard.createDiv({
        cls: "herdr-muted-copy",
        text: "Run refresh with Herdr installed to inspect agent hook statuses.",
      });
    } else {
      const grid = intCard.createDiv({ cls: "herdr-integration-grid" });
      for (const item of state.integrations) {
        const pill = grid.createDiv({ cls: "herdr-integration-item" });
        pill.createSpan({ text: item.target });
        pill.createSpan({
          cls: `herdr-status-pill ${item.installed ? "herdr-status-done" : "herdr-status-idle"}`,
          text: item.installed ? "hook active" : "optional",
        });
      }
    }
  }

  private addKvRow(parent: HTMLElement, key: string, value: string): void {
    const row = parent.createDiv({ cls: "herdr-kv-row" });
    row.createSpan({ cls: "herdr-kv-key", text: key });
    row.createSpan({ cls: "herdr-kv-val", text: value });
  }

  private async handleStartSession(): Promise<void> {
    try {
      await this.coordinator.startVaultHerdrSession();
      new Notice(`Started Herdr session '${this.coordinator.getActiveSessionName()}'.`);
    } catch (err) {
      new Notice(`Failed to start session: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleStopSession(): Promise<void> {
    const sessionName = this.coordinator.getActiveSessionName();
    try {
      await this.coordinator.stopVaultHerdrSession();
      new Notice(`Stopped Herdr session '${sessionName}'.`);
    } catch (err) {
      new Notice(`Failed to stop session: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async loadAgentExplain(target: string): Promise<void> {
    try {
      const payload = await this.coordinator.socket.explainAgent(target);
      this.liveTailTarget = `Agent state explain (${target})`;
      this.liveTailText = JSON.stringify(payload, null, 2);
      this.renderDashboard();
    } catch (err) {
      new Notice(`Explain failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async saveTabLayoutToNote(
    wsLabel: string,
    tabId: string,
    tabLabel: string
  ): Promise<void> {
    try {
      const exported = await this.coordinator.socket.exportLayout({ tabId });
      const safeWs = wsLabel.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
      const safeTab = tabLabel.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || tabId.replace(/[^A-Za-z0-9_-]+/g, "-");
      const notePath = `Herdr Layouts/${safeWs}-${safeTab}.md`;
      const content = [
        "---",
        "type: herdr-layout",
        `workspace: "${wsLabel.replace(/"/g, "'")}"`,
        `tab: "${tabLabel.replace(/"/g, "'")}"`,
        "---",
        "",
        `# Herdr Layout: ${wsLabel} / ${tabLabel}`,
        "",
        "Open Mission Control -> Topology & worktrees -> **Apply layout from note** while viewing this note to recreate this split tree.",
        "",
        "```json",
        JSON.stringify(exported, null, 2),
        "```",
        "",
      ].join("\n");

      await this.coordinator.vaultOps.dispatch(
        "vault.create_note",
        { path: notePath, content, overwrite: true },
        "mission-control-layout"
      );
      const created = this.app.vault.getAbstractFileByPath(notePath);
      if (created instanceof TFile) {
        await this.app.workspace.getLeaf(false).openFile(created);
      }
      new Notice(`Saved Herdr layout to '${notePath}'.`);
    } catch (err) {
      new Notice(`Layout export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async applyLayoutFromActiveNote(workspaceId?: string): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("Open a Markdown layout note first.");
      return;
    }
    try {
      const raw = await this.app.vault.cachedRead(activeFile);
      const fenceMatch = /```json\s*([\s\S]*?)```/i.exec(raw);
      const jsonBody = fenceMatch ? fenceMatch[1].trim() : raw.trim();
      const parsed = JSON.parse(jsonBody) as {
        root?: HerdrLayoutNode;
        type?: string;
      };
      const rootNode =
        parsed.root ??
        (parsed.type === "pane" || parsed.type === "split"
          ? (parsed as unknown as HerdrLayoutNode)
          : undefined);
      if (!rootNode) {
        new Notice("Active note does not contain a valid Herdr layout JSON root node.");
        return;
      }
      await this.coordinator.socket.applyLayout({
        root: rootNode,
        workspaceId,
        tabLabel: activeFile.basename.slice(0, 32),
        focus: true,
      });
      await this.coordinator.refreshAll(false);
      new Notice(`Applied Herdr layout from '${activeFile.basename}'.`);
    } catch (err) {
      new Notice(`Layout apply failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async setWorkspaceTuiFilter(workspaceId: string): Promise<void> {
    try {
      await this.coordinator.socket.setAgentView({
        source: "user:obsidian-herdr",
        label: `Vault: ${this.app.vault.getName()}`,
        filter: {
          op: "eq",
          field: "workspace_id",
          value: workspaceId,
        },
      });
      new Notice(`Filtered Herdr TUI agent view to workspace '${workspaceId}'.`);
    } catch (err) {
      new Notice(`Could not set TUI filter: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async clearWorkspaceTuiFilter(): Promise<void> {
    try {
      await this.coordinator.socket.clearAgentView("user:obsidian-herdr");
      new Notice("Cleared Herdr TUI agent view filter.");
    } catch (err) {
      new Notice(`Could not clear TUI filter: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async sendAgentQuickKeys(target: string, keys: string[]): Promise<void> {
    try {
      await this.coordinator.socket.sendAgentKeys(target, keys);
      await this.coordinator.refreshAll(false);
    } catch (err) {
      new Notice(`Key send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async promptSingleAgent(target: string, prompt: string): Promise<void> {
    try {
      await this.coordinator.socket.promptAgent(target, prompt);
      new Notice(`Sent prompt to '${target}'.`);
      await this.coordinator.refreshAll(false);
    } catch (err) {
      new Notice(`Prompt failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async loadAgentTail(target: string, isPreview: boolean): Promise<void> {
    this.liveTailTarget = target;
    if (isPreview) {
      this.liveTailText = [
        "$ obs-herdr vault info",
        `{"vaultName":"${this.app.vault.getName()}","permissionMode":"${this.getSettings().vaultPermissionMode}"}`,
        "$ obs-herdr note search roadmap",
        "Found 3 matching notes. Ready to update frontmatter on approval.",
      ].join("\n");
      this.renderDashboard();
      return;
    }

    try {
      const text = await this.coordinator.socket.readAgent(target, "recent_unwrapped", 60);
      this.liveTailText = text;
      this.renderDashboard();
    } catch {
      try {
        const fallback = await this.coordinator.socket.readPane(
          target,
          "recent_unwrapped",
          60
        );
        this.liveTailText = fallback;
        this.renderDashboard();
      } catch (err) {
        new Notice(`Could not read output: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async runBridgeSelfTest(): Promise<void> {
    try {
      const res = (await this.coordinator.vaultOps.dispatch(
        "vault.info",
        {},
        "mission-control-selftest"
      )) as { vaultName: string; markdownCount: number; permissionMode: string };
      new Notice(
        `Bridge OK: '${res.vaultName}' (${res.markdownCount} Markdown notes, mode=${res.permissionMode}).`
      );
      this.renderDashboard();
    } catch (err) {
      new Notice(`Bridge self-test failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
