import {
  ItemView,
  Menu,
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
  PaneInfo,
  PaneLayoutSnapshot,
  SessionSnapshot,
  VaultAuditEntry,
  VaultPermissionMode,
} from "../domain/types";
import { resolveExecutableOnNormalizedPath } from "../herdr/cli-client";
import type { CoordinatorState, HerdrCoordinator } from "../services/herdr-coordinator";
import {
  CreateWorktreeModal,
  DispatchNoteModal,
  SpawnAgentModal,
  confirmAction,
} from "./modals";

export const VIEW_TYPE_HERDR_DASHBOARD = "herdr-view";

type DashboardTabId = "agents" | "vault" | "doctor";

interface TierMeta {
  id: VaultPermissionMode;
  label: string;
  description: string;
}

const VAULT_TIERS: readonly TierMeta[] = [
  {
    id: "off",
    label: "Off",
    description: "Agents cannot read or change anything in this vault.",
  },
  {
    id: "read-only",
    label: "Read only",
    description: "Agents can read and search notes, but cannot change files or control Obsidian.",
  },
  {
    id: "read-write",
    label: "Edit notes",
    description: "Agents can create, edit, rename, and trash notes with undo, but cannot run commands or click the UI.",
  },
  {
    id: "full",
    label: "Full control",
    description: "Agents can edit notes, run Obsidian commands, and control the window when UI control is enabled.",
  },
];

const EDIT_ACTIVITY_METHODS = new Set<string>([
  "vault.create_note",
  "vault.update_note",
  "vault.patch_frontmatter",
  "vault.rename_note",
  "vault.trash_note",
  "canvas.upsert_node",
  "editor.insert_at_cursor",
  "editor.replace_selection",
]);

function tierLabelFor(mode: VaultPermissionMode, bridgeRunning: boolean): string {
  if (!bridgeRunning || mode === "off") {
    return "Off";
  }
  return VAULT_TIERS.find((t) => t.id === mode)?.label ?? mode;
}

function isEditActivity(entry: VaultAuditEntry): boolean {
  return Boolean(entry.snapshot) || EDIT_ACTIVITY_METHODS.has(entry.method);
}

function normalizeTabId(raw: unknown): DashboardTabId | null {
  if (raw === "agents" || raw === "topology" || raw === "dispatch") {
    return "agents";
  }
  if (raw === "vault" || raw === "bridge") {
    return "vault";
  }
  if (raw === "doctor") {
    return "doctor";
  }
  return null;
}

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
  private showAllActivity = false;

  private unsubCoord: (() => void) | null = null;
  private unsubAudit: (() => void) | null = null;
  private bodyHostEl: HTMLElement | null = null;
  private rendering = false;
  private cachedCliChecks: Array<{ label: string; found: boolean; detail: string }> | null = null;
  private cachedCliChecksAt = 0;

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
      const s = state as { activeTab?: unknown; selectedWorkspaceId?: unknown };
      const normalized = normalizeTabId(s.activeTab);
      if (normalized) {
        this.activeTab = normalized;
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
      if (this.activeTab === "vault") {
        this.renderDashboard();
      }
    });

    void this.coordinator.refreshAll(true).catch((err: unknown) => {
      console.warn("[herdr-obs] Initial Mission Control refresh failed:", err);
    });
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
    if (!host || this.rendering) {
      return;
    }
    this.rendering = true;
    try {
      host.empty();

      const state = this.coordinator.getState();
      this.renderHeader(host, state);
      this.renderStatusLine(host, state);
      this.renderAttentionBanner(host, state);
      this.renderTabs(host);

      const panel = host.createDiv({ cls: "herdr-tab-panel" });
      switch (this.activeTab) {
        case "agents":
          this.renderAgentsTab(panel, state);
          break;
        case "vault":
          this.renderVaultTab(panel, state);
          break;
        case "doctor":
          this.renderDoctorTab(panel, state);
          break;
      }
    } finally {
      this.rendering = false;
    }
  }

  private renderHeader(parent: HTMLElement, state: CoordinatorState): void {
    const header = parent.createDiv({ cls: "herdr-mc-header" });
    header.createDiv({ cls: "herdr-mc-title", text: "Herdr Mission Control" });

    const actions = header.createDiv({ cls: "herdr-mc-actions" });
    const spawnBtn = actions.createEl("button", {
      text: "Spawn agent",
      cls: "mod-cta herdr-btn-compact",
      attr: { type: "button" },
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

    const moreBtn = actions.createEl("button", {
      cls: "clickable-icon herdr-mc-more",
      attr: { "aria-label": "More actions", title: "More actions", type: "button" },
    });
    setIcon(moreBtn, "more-horizontal");
    moreBtn.addEventListener("click", (ev: MouseEvent) => {
      this.openHeaderMenu(ev, state);
    });
  }

  private openHeaderMenu(ev: MouseEvent, state: CoordinatorState): void {
    const snap = state.serverRunning ? state.snapshot : null;
    const activeWsId = this.resolveActiveWorkspaceId(snap);
    const activeWs = snap?.workspaces.find((w) => w.workspace_id === activeWsId);
    const activeTab = this.resolveActiveTabForWorkspace(snap, activeWsId);

    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle("Open terminal")
        .setIcon("terminal")
        .onClick(() => {
          void this.openTerminalLeaf({ split: false }).catch((err: unknown) => {
            new Notice(err instanceof Error ? err.message : String(err));
          });
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("Refresh")
        .setIcon("refresh-cw")
        .onClick(() => {
          this.cachedCliChecks = null;
          void this.coordinator.refreshAll(true).catch((err: unknown) => {
            new Notice(err instanceof Error ? err.message : String(err));
          });
        })
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle("New vault workspace")
        .setIcon("folder-plus")
        .setDisabled(!state.serverRunning)
        .onClick(() => {
          void this.coordinator.createVaultWorkspace().catch((err: unknown) => {
            new Notice(err instanceof Error ? err.message : String(err));
          });
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("New Git worktree")
        .setIcon("git-branch")
        .setDisabled(!state.serverRunning)
        .onClick(() => {
          new CreateWorktreeModal(this.app, this.coordinator).open();
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("Apply layout from note")
        .setIcon("layout")
        .setDisabled(!state.serverRunning)
        .onClick(() => {
          void this.applyLayoutFromActiveNote(activeWsId || undefined);
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("Save layout to note")
        .setIcon("save")
        .setDisabled(!state.serverRunning || !activeTab)
        .onClick(() => {
          if (activeTab) {
            void this.saveTabLayoutToNote(
              activeWs?.label || activeWsId || "workspace",
              activeTab.tab_id,
              activeTab.label
            );
          }
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("Filter TUI to workspace")
        .setIcon("filter")
        .setDisabled(!state.serverRunning || !activeWsId)
        .onClick(() => {
          if (activeWsId) {
            void this.setWorkspaceTuiFilter(activeWsId);
          }
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("Clear TUI filter")
        .setIcon("x")
        .setDisabled(!state.serverRunning)
        .onClick(() => {
          void this.clearWorkspaceTuiFilter();
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("Copy active note context pack")
        .setIcon("copy")
        .onClick(() => {
          void this.coordinator
            .buildActiveNoteContextPack({ includeBacklinks: true })
            .then((pack) => {
              void navigator.clipboard.writeText(pack.payload).catch((err: unknown) => {
                console.warn("[herdr-obs] Clipboard write failed:", err);
              });
              new Notice(`Copied context pack for '${pack.title}'.`);
            })
            .catch((err: unknown) => {
              new Notice(err instanceof Error ? err.message : String(err));
            });
        })
    );

    menu.addSeparator();

    if (state.serverRunning) {
      menu.addItem((item) => {
        item
          .setTitle("Stop session")
          .setIcon("square")
          .onClick(() => {
            void this.confirmAndStopSession(state.activeSessionName);
          });
        const warnItem = item as unknown as { setWarning?: (isWarning: boolean) => unknown };
        warnItem.setWarning?.(true);
      });
    } else if (state.binaryPath) {
      menu.addItem((item) =>
        item
          .setTitle("Start session")
          .setIcon("play")
          .onClick(() => {
            void this.handleStartSession();
          })
      );
    }

    menu.showAtMouseEvent(ev);
  }

  private renderStatusLine(parent: HTMLElement, state: CoordinatorState): void {
    const snap = state.serverRunning ? state.snapshot : null;
    const agents = snap?.agents ?? [];
    const working = agents.filter((a) => a.agent_status === "working").length;
    const blocked = agents.filter((a) => a.agent_status === "blocked").length;
    const done = agents.filter((a) => a.agent_status === "done").length;

    const version =
      state.snapshot?.version || state.statusPayload?.client?.version || "not detected";
    const tooltip = `Session: ${state.activeSessionName} | Herdr ${version}`;

    const line = parent.createDiv({
      cls: "herdr-mc-status",
      attr: { title: tooltip },
    });

    const dotState = !state.serverRunning
      ? "is-offline"
      : blocked > 0 || Boolean(state.protocolWarning)
        ? "is-warn"
        : "is-live";
    line.createSpan({ cls: `herdr-mc-status-dot ${dotState}` });

    const parts: string[] = [state.serverRunning ? "Live" : "Offline"];
    if (state.serverRunning) {
      const noun = agents.length === 1 ? "agent" : "agents";
      const breakdown: string[] = [];
      if (working > 0) breakdown.push(`${working} working`);
      if (done > 0) breakdown.push(`${done} done`);
      if (blocked > 0) breakdown.push(`${blocked} blocked`);
      parts.push(
        breakdown.length > 0
          ? `${agents.length} ${noun} (${breakdown.join(", ")})`
          : `${agents.length} ${noun}`
      );
    }
    const tierLabel = tierLabelFor(
      this.getSettings().vaultPermissionMode,
      state.bridgeRunning
    );
    parts.push(`Vault: ${tierLabel}`);

    line.createSpan({ text: parts.join(" · ") });
  }

  private renderAttentionBanner(parent: HTMLElement, state: CoordinatorState): void {
    if (!state.serverRunning || !state.snapshot) {
      return;
    }
    const blockedAgents = state.snapshot.agents.filter(
      (a) => a.agent_status === "blocked"
    );
    if (blockedAgents.length === 0) {
      return;
    }

    const banner = parent.createDiv({ cls: "herdr-mc-attention" });
    for (const agent of blockedAgents) {
      const displayName = this.resolveAgentDisplayLabel(agent, state.snapshot.panes);
      const targetId = agent.name || agent.pane_id;
      const row = banner.createDiv({ cls: "herdr-blocked-bar" });
      row.createSpan({
        cls: "herdr-blocked-label",
        text: `${displayName} needs input`,
      });
      for (const keySpec of [
        { label: "Approve (y + Enter)", keys: ["y", "enter"] },
        { label: "Enter", keys: ["enter"] },
        { label: "Esc", keys: ["esc"] },
        { label: "Cancel (Ctrl+C)", keys: ["ctrl+c"] },
      ]) {
        const kBtn = row.createEl("button", {
          text: keySpec.label,
          cls: "herdr-btn-compact",
          attr: { type: "button" },
        });
        kBtn.addEventListener("click", () => {
          void this.sendAgentQuickKeys(targetId, keySpec.keys);
        });
      }
    }
  }

  private renderTabs(parent: HTMLElement): void {
    const nav = parent.createDiv({
      cls: "herdr-mc-tabs",
      attr: { role: "tablist" },
    });

    const tabs: Array<{ id: DashboardTabId; label: string }> = [
      { id: "agents", label: "Agents" },
      { id: "vault", label: "Vault" },
      { id: "doctor", label: "Doctor" },
    ];

    for (const item of tabs) {
      const btn = nav.createEl("button", {
        text: item.label,
        cls: `herdr-mc-tab ${this.activeTab === item.id ? "is-active" : ""}`,
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

  private renderAgentsTab(parent: HTMLElement, state: CoordinatorState): void {
    if (!state.serverRunning || !state.snapshot) {
      const empty = parent.createDiv({ cls: "herdr-mc-empty" });
      empty.createEl("p", {
        text: state.binaryPath
          ? "No Herdr session is running for this vault."
          : "Herdr was not found on PATH. Install Herdr from herdr.dev, or open a local terminal below.",
      });
      const row = empty.createDiv({ cls: "herdr-action-row" });
      if (state.binaryPath) {
        const startBtn = row.createEl("button", {
          text: "Start session",
          cls: "mod-cta herdr-btn-compact",
          attr: { type: "button" },
        });
        startBtn.addEventListener("click", () => {
          void this.handleStartSession();
        });
      }
      const termBtn = row.createEl("button", {
        text: "Open terminal",
        cls: "herdr-btn-compact",
        attr: { type: "button" },
      });
      termBtn.addEventListener("click", () => {
        void this.openTerminalLeaf({ split: false }).catch((err: unknown) => {
          new Notice(err instanceof Error ? err.message : String(err));
        });
      });
      return;
    }

    const snap = state.snapshot;
    const activeWsId = this.resolveActiveWorkspaceId(snap);

    if (snap.workspaces.length > 1) {
      const wsRow = parent.createDiv({ cls: "herdr-workspace-chips" });
      for (const ws of snap.workspaces) {
        const chip = wsRow.createEl("button", {
          cls: `herdr-ws-chip ${ws.workspace_id === activeWsId ? "is-selected" : ""}`,
          text: ws.label || ws.workspace_id,
          attr: { title: `${ws.label} (${ws.workspace_id})`, type: "button" },
        });
        chip.addEventListener("click", () => {
          this.selectedWorkspaceId = ws.workspace_id;
          void this.coordinator.socket
            .focusWorkspace(ws.workspace_id)
            .then(() => this.coordinator.refreshAll(false))
            .catch((err: unknown) => {
              new Notice(err instanceof Error ? err.message : String(err));
            });
        });
      }
    }

    const activeTab = this.resolveActiveTabForWorkspace(snap, activeWsId);
    const activeLayout = activeTab
      ? snap.layouts.find((l) => l.tab_id === activeTab.tab_id)
      : snap.layouts[0];
    if (activeLayout && activeLayout.panes.length > 0) {
      this.renderCompactLayoutMap(parent, activeLayout, snap);
    }

    const agents = snap.agents ?? [];
    if (agents.length === 0) {
      const empty = parent.createDiv({ cls: "herdr-mc-empty" });
      empty.createEl("p", { text: "No coding agents are running in this session." });
      const spawnBtn = empty.createEl("button", {
        text: "Spawn agent",
        cls: "mod-cta herdr-btn-compact",
        attr: { type: "button" },
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
    } else {
      for (const agent of agents) {
        this.renderAgentRow(parent, agent, state, snap);
      }
    }

    if (this.liveTailTarget) {
      const tailSection = parent.createDiv({ cls: "herdr-mc-section" });
      const head = tailSection.createDiv({ cls: "herdr-card-header" });
      head.createSpan({
        cls: "herdr-mc-section-title",
        text: this.liveTailTarget,
      });
      const closeBtn = head.createEl("button", {
        text: "Close",
        cls: "herdr-btn-compact",
        attr: { type: "button" },
      });
      closeBtn.addEventListener("click", () => {
        this.liveTailTarget = "";
        this.liveTailText = "";
        this.renderDashboard();
      });
      const pre = tailSection.createEl("pre", { cls: "herdr-terminal-tail" });
      pre.setText(this.liveTailText || "(empty terminal output)");
    }

    if (state.worktrees.length > 0) {
      const wtSection = parent.createDiv({ cls: "herdr-mc-section" });
      wtSection.createDiv({
        cls: "herdr-mc-section-title",
        text: "Git worktrees",
      });
      for (const wt of state.worktrees) {
        const row = wtSection.createDiv({
          cls: "herdr-mc-session-row",
          attr: { title: wt.path },
        });
        row.createSpan({
          text: wt.branch || wt.label || wt.path,
        });
        const openWsId = wt.open_workspace_id || wt.workspace_id || "";
        if (!openWsId) {
          const openBtn = row.createEl("button", {
            text: "Open",
            cls: "herdr-btn-compact",
            attr: { type: "button" },
          });
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
          const rmBtn = row.createEl("button", {
            text: "Remove",
            cls: "herdr-btn-compact",
            attr: { type: "button" },
          });
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

  private renderCompactLayoutMap(
    parent: HTMLElement,
    layout: PaneLayoutSnapshot,
    snap: SessionSnapshot
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
    const canvas = parent.createDiv({ cls: "herdr-mc-layoutmap" });

    for (const lp of layout.panes) {
      const paneMeta = snap.panes.find((p) => p.pane_id === lp.pane_id);
      const agentMeta = snap.agents.find((a) => a.pane_id === lp.pane_id);
      const status = agentMeta?.agent_status || paneMeta?.agent_status || "idle";
      const label =
        paneMeta?.label ||
        agentMeta?.name ||
        paneMeta?.display_agent ||
        paneMeta?.agent ||
        lp.pane_id;

      const relX = Math.max(0, lp.rect.x - originX);
      const relY = Math.max(0, lp.rect.y - originY);
      const cell = canvas.createEl("button", {
        cls: `herdr-mc-layoutmap-pane is-${status}${lp.focused ? " is-focused" : ""}`,
        text: label,
        attr: {
          type: "button",
          title: `${label} (${lp.pane_id}) · ${status}${paneMeta?.cwd ? ` · ${paneMeta.cwd}` : ""}`,
        },
      });
      cell.style.left = `${((relX / totalW) * 100).toFixed(2)}%`;
      cell.style.top = `${((relY / totalH) * 100).toFixed(2)}%`;
      cell.style.width = `${((lp.rect.width / totalW) * 100).toFixed(2)}%`;
      cell.style.height = `${((lp.rect.height / totalH) * 100).toFixed(2)}%`;

      cell.addEventListener("click", () => {
        void this.coordinator.socket
          .focusPane(lp.pane_id)
          .then(() => this.coordinator.refreshAll(false))
          .catch((err: unknown) => {
            new Notice(err instanceof Error ? err.message : String(err));
          });
      });
    }
  }

  private renderAgentRow(
    parent: HTMLElement,
    agent: AgentInfo,
    state: CoordinatorState,
    snap: SessionSnapshot
  ): void {
    const label = this.resolveAgentDisplayLabel(agent, snap.panes);
    const targetId = agent.name || agent.pane_id;
    const tooltipParts = [`Pane: ${agent.pane_id}`, `Runtime: ${agent.agent || "shell"}`];
    if (agent.cwd) {
      tooltipParts.push(`CWD: ${agent.cwd}`);
    }

    const row = parent.createDiv({
      cls: "herdr-mc-agent-row",
      attr: { title: tooltipParts.join(" | ") },
    });

    const top = row.createDiv({ cls: "herdr-card-header" });
    top.createSpan({ cls: "herdr-mc-agent-name", text: label });

    const right = top.createDiv({ cls: "herdr-mc-actions" });
    right.createSpan({
      cls: `herdr-mc-pill is-${agent.agent_status}`,
      text: agent.agent_status,
    });

    const moreBtn = right.createEl("button", {
      cls: "clickable-icon herdr-mc-more",
      attr: { "aria-label": `Actions for ${label}`, title: `Actions for ${label}`, type: "button" },
    });
    setIcon(moreBtn, "more-horizontal");
    moreBtn.addEventListener("click", (ev: MouseEvent) => {
      this.openAgentMenu(ev, agent, targetId, state.activeSessionName);
    });

    const promptRow = row.createDiv({ cls: "herdr-mc-agent-prompt" });
    const input = promptRow.createEl("input", {
      type: "text",
      cls: "herdr-prompt-input",
      placeholder: `Message ${label}...`,
      attr: { "aria-label": `Message ${label}` },
    });
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
      attr: { type: "button" },
    });
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
  }

  private openAgentMenu(
    ev: MouseEvent,
    agent: AgentInfo,
    targetId: string,
    sessionName: string
  ): void {
    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle("Read output")
        .setIcon("file-text")
        .onClick(() => {
          void this.loadAgentTail(targetId);
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("Attach in terminal")
        .setIcon("terminal")
        .onClick(() => {
          void this.openTerminalLeaf({
            agentTarget: targetId,
            sessionName,
            split: true,
          }).catch((err: unknown) => {
            new Notice(err instanceof Error ? err.message : String(err));
          });
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("Send active note")
        .setIcon("send")
        .onClick(() => {
          new DispatchNoteModal(this.app, this.coordinator, targetId).open();
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("Open context dispatcher")
        .setIcon("share")
        .onClick(() => {
          new DispatchNoteModal(this.app, this.coordinator).open();
        })
    );

    menu.addSeparator();

    const cwd = this.coordinator.vaultOps.getVaultBasePath() || undefined;
    menu.addItem((item) =>
      item
        .setTitle("Split right")
        .setIcon("columns-2")
        .onClick(() => {
          void this.coordinator.socket
            .splitPane({
              targetPaneId: agent.pane_id,
              direction: "right",
              cwd,
              env: this.coordinator.getBridgeEnv(),
            })
            .then(() => this.coordinator.refreshAll(false))
            .catch((err: unknown) => {
              new Notice(err instanceof Error ? err.message : String(err));
            });
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("Split down")
        .setIcon("rows-2")
        .onClick(() => {
          void this.coordinator.socket
            .splitPane({
              targetPaneId: agent.pane_id,
              direction: "down",
              cwd,
              env: this.coordinator.getBridgeEnv(),
            })
            .then(() => this.coordinator.refreshAll(false))
            .catch((err: unknown) => {
              new Notice(err instanceof Error ? err.message : String(err));
            });
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("Zoom")
        .setIcon("maximize-2")
        .onClick(() => {
          void this.coordinator.socket
            .zoomPane(agent.pane_id, "toggle")
            .then(() => this.coordinator.refreshAll(false))
            .catch((err: unknown) => {
              new Notice(err instanceof Error ? err.message : String(err));
            });
        })
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle("Why this status?")
        .setIcon("help-circle")
        .onClick(() => {
          void this.loadAgentExplain(targetId);
        })
    );

    menu.showAtMouseEvent(ev);
  }

  private renderVaultTab(parent: HTMLElement, state: CoordinatorState): void {
    const accessSection = parent.createDiv({ cls: "herdr-mc-section" });
    accessSection.createDiv({
      cls: "herdr-mc-section-title",
      text: state.bridgeRunning ? "Vault access: active" : "Vault access: off",
    });

    const currentMode: VaultPermissionMode = state.bridgeRunning
      ? this.getSettings().vaultPermissionMode
      : "off";

    const seg = accessSection.createDiv({
      cls: "herdr-mc-segmented",
      attr: { role: "radiogroup", "aria-label": "Vault permission level" },
    });
    for (const tier of VAULT_TIERS) {
      const btn = seg.createEl("button", {
        text: tier.label,
        cls: currentMode === tier.id ? "is-active" : "",
        attr: {
          type: "button",
          role: "radio",
          "aria-checked": currentMode === tier.id ? "true" : "false",
        },
      });
      btn.addEventListener("click", () => {
        void this.updateSettings({
          vaultBridgeEnabled: tier.id !== "off",
          vaultPermissionMode: tier.id,
        }).catch((err: unknown) => {
          new Notice(err instanceof Error ? err.message : String(err));
        });
      });
    }

    const activeTier = VAULT_TIERS.find((t) => t.id === currentMode) ?? VAULT_TIERS[0];
    accessSection.createDiv({
      cls: "herdr-mc-hint",
      text: activeTier.description,
    });

    // Activity list
    const activitySection = parent.createDiv({ cls: "herdr-mc-section" });
    const actHead = activitySection.createDiv({ cls: "herdr-card-header" });
    actHead.createSpan({ cls: "herdr-mc-section-title", text: "Activity" });

    const filterRow = actHead.createDiv({ cls: "herdr-mc-log-filter" });
    const toggleBtn = filterRow.createEl("button", {
      text: this.showAllActivity ? "Edits only" : "Show all activity",
      cls: "herdr-btn-compact",
      attr: { type: "button" },
    });
    toggleBtn.addEventListener("click", () => {
      this.showAllActivity = !this.showAllActivity;
      this.renderDashboard();
    });

    const allEntries = this.coordinator.vaultOps.getAuditLog();
    if (allEntries.length > 0) {
      const clearBtn = filterRow.createEl("button", {
        text: "Clear log",
        cls: "herdr-btn-compact",
        attr: { type: "button" },
      });
      clearBtn.addEventListener("click", () => {
        this.coordinator.vaultOps.clearAuditLog();
      });
    }

    const visibleEntries = this.showAllActivity
      ? allEntries
      : allEntries.filter(isEditActivity);

    if (visibleEntries.length === 0) {
      activitySection.createDiv({
        cls: "herdr-mc-hint",
        text:
          allEntries.length === 0
            ? "No vault activity recorded in this session yet."
            : "No note edits recorded yet. Switch to 'Show all activity' to view reads and UI actions.",
      });
    } else {
      const list = activitySection.createDiv({ cls: "herdr-mc-log" });
      for (const item of visibleEntries.slice(0, 40)) {
        const row = list.createDiv({
          cls: "herdr-mc-log-row",
          attr: { title: `${item.method} (${item.caller})` },
        });
        row.createSpan({
          cls: "herdr-mc-log-time",
          text: new Date(item.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
        });
        const summaryEl = row.createSpan({
          cls: "herdr-mc-log-text",
          text: item.summary,
        });
        if (item.targetPath) {
          const af = this.app.vault.getAbstractFileByPath(item.targetPath);
          if (af instanceof TFile) {
            summaryEl.addClass("mod-clickable");
            summaryEl.setAttr("title", `Click to open ${item.targetPath}`);
            summaryEl.addEventListener("click", () => {
              void this.app.workspace
                .getLeaf(false)
                .openFile(af)
                .catch((err: unknown) => {
                  new Notice(err instanceof Error ? err.message : String(err));
                });
            });
          }
        }
        if (item.snapshot && !item.undone) {
          const undoBtn = row.createEl("button", {
            text: "Undo",
            cls: "herdr-mc-log-undo",
            attr: { type: "button" },
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
          row.createSpan({ cls: "herdr-mc-hint", text: "Undone" });
        }
      }
    }

    // Connection details (collapsed)
    const details = parent.createEl("details", { cls: "herdr-mc-details" });
    details.createEl("summary", { text: "Connection details" });

    const kv = details.createDiv({ cls: "herdr-mc-kv" });
    this.addKvRow(kv, "Socket", state.bridgeSocketPath);
    this.addKvRow(kv, "CLI script", state.cliScriptPath);
    this.addKvRow(kv, "Plugin manifest", state.herdrPluginManifestPath);

    const actions = details.createDiv({ cls: "herdr-action-row" });

    const selfTestBtn = actions.createEl("button", {
      text: "Run self-test",
      cls: "herdr-btn-compact",
      attr: { type: "button" },
    });
    selfTestBtn.addEventListener("click", () => {
      void this.runBridgeSelfTest();
    });

    const copyCliBtn = actions.createEl("button", {
      text: "Copy CLI path",
      cls: "herdr-btn-compact",
      attr: { type: "button" },
    });
    copyCliBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(state.cliScriptPath).catch((err: unknown) => {
        console.warn("[herdr-obs] Clipboard write failed:", err);
      });
      new Notice("Copied obs-herdr CLI path to clipboard.");
    });

    const copyMcpBtn = actions.createEl("button", {
      text: "Copy MCP config",
      cls: "herdr-btn-compact",
      attr: { type: "button" },
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
      void navigator.clipboard.writeText(mcpJson).catch((err: unknown) => {
        console.warn("[herdr-obs] Clipboard write failed:", err);
      });
      new Notice("Copied MCP configuration to clipboard.");
    });

    if (state.serverRunning) {
      const isLinked = state.installedPlugins.some(
        (p) =>
          p.plugin_id === "obsidian.vault" ||
          p.id === "obsidian.vault" ||
          p.manifest_path === state.herdrPluginManifestPath
      );
      const linkBtn = actions.createEl("button", {
        text: isLinked ? "Unlink from Herdr" : "Link into Herdr",
        cls: "herdr-btn-compact",
        attr: { type: "button" },
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
                : "Linked obsidian.vault actions into Herdr."
            );
          })
          .catch((err: unknown) => {
            new Notice(err instanceof Error ? err.message : String(err));
          });
      });
    }
  }

  private renderDoctorTab(parent: HTMLElement, state: CoordinatorState): void {
    if (state.protocolWarning) {
      const warn = parent.createDiv({ cls: "herdr-mc-attention" });
      warn.createEl("strong", { text: "Herdr protocol warning: " });
      warn.createSpan({ text: state.protocolWarning });
    }

    const diagSection = parent.createDiv({ cls: "herdr-mc-section" });
    diagSection.createDiv({ cls: "herdr-mc-section-title", text: "Diagnostics" });

    const kv = diagSection.createDiv({ cls: "herdr-mc-kv" });
    this.addKvRow(kv, "Herdr binary", state.binaryPath || "Not found on PATH");
    this.addKvRow(
      kv,
      "Version",
      state.statusPayload?.client?.version
        ? `${state.statusPayload.client.version} (protocol ${state.statusPayload.client.protocol ?? "?"})`
        : "No data"
    );
    this.addKvRow(kv, "Session", state.activeSessionName);
    this.addKvRow(kv, "Socket", state.socketPath);
    this.addKvRow(
      kv,
      "Live updates",
      state.socketSubscribed ? "Connected" : "Disconnected"
    );
    if (state.lastError) {
      this.addKvRow(kv, "Last error", state.lastError);
    }

    // Named sessions: running first, stopped collapsed
    const sessionsSection = parent.createDiv({ cls: "herdr-mc-section" });
    sessionsSection.createDiv({ cls: "herdr-mc-section-title", text: "Sessions" });

    const runningSessions = state.sessions.filter((s) => s.status === "running");
    const stoppedSessions = state.sessions.filter((s) => s.status !== "running");

    if (runningSessions.length === 0 && stoppedSessions.length === 0) {
      sessionsSection.createDiv({
        cls: "herdr-mc-hint",
        text: "No named Herdr sessions found.",
      });
    } else {
      for (const s of runningSessions) {
        const tooltip = s.socket ? `${s.name} (${s.socket})` : s.name;
        const row = sessionsSection.createDiv({
          cls: "herdr-mc-session-row",
          attr: { title: tooltip },
        });
        row.createSpan({ text: s.name });
        row.createSpan({ cls: "herdr-mc-pill is-working", text: "running" });
        const attachBtn = row.createEl("button", {
          text: "Attach",
          cls: "herdr-btn-compact",
          attr: { type: "button" },
        });
        attachBtn.addEventListener("click", () => {
          void this.openTerminalLeaf({ sessionName: s.name }).catch((err: unknown) => {
            new Notice(err instanceof Error ? err.message : String(err));
          });
        });
      }

      if (stoppedSessions.length > 0) {
        const stoppedDetails = sessionsSection.createEl("details", {
          cls: "herdr-mc-details",
        });
        stoppedDetails.createEl("summary", {
          text: `Stopped sessions (${stoppedSessions.length})`,
        });
        for (const s of stoppedSessions) {
          const tooltip = s.socket ? `${s.name} (${s.socket})` : s.name;
          const row = stoppedDetails.createDiv({
            cls: "herdr-mc-session-row",
            attr: { title: tooltip },
          });
          row.createSpan({ text: s.name });
          row.createSpan({ cls: "herdr-mc-pill is-idle", text: s.status || "stopped" });
        }
      }
    }

    // Detected CLI runtimes (cached for 60s to avoid repeated sync filesystem scans per refresh)
    const cliSection = parent.createDiv({ cls: "herdr-mc-section" });
    cliSection.createDiv({ cls: "herdr-mc-section-title", text: "Detected runtimes" });
    const cliGrid = cliSection.createDiv({ cls: "herdr-integration-grid" });
    const cliChecks = this.getCachedCliChecks(state);
    for (const check of cliChecks) {
      const pill = cliGrid.createDiv({
        cls: "herdr-integration-item",
        attr: check.detail ? { title: check.detail } : {},
      });
      pill.createSpan({ text: check.label });
      pill.createSpan({
        cls: `herdr-mc-pill ${check.found ? "is-done" : "is-idle"}`,
        text: check.found ? "ready" : "missing",
      });
    }

    // Optional hooks (collapsed)
    const hookDetails = parent.createEl("details", { cls: "herdr-mc-details" });
    hookDetails.createEl("summary", {
      text: `Optional agent hooks (${state.integrations.length})`,
    });
    if (state.integrations.length === 0) {
      hookDetails.createDiv({
        cls: "herdr-mc-hint",
        text: "Refresh with Herdr installed to check optional shell hooks.",
      });
    } else {
      const grid = hookDetails.createDiv({ cls: "herdr-integration-grid" });
      for (const item of state.integrations) {
        const pill = grid.createDiv({ cls: "herdr-integration-item" });
        pill.createSpan({ text: item.target });
        pill.createSpan({
          cls: `herdr-mc-pill ${item.installed ? "is-done" : "is-idle"}`,
          text: item.installed ? "active" : "optional",
        });
      }
    }
  }

  private getCachedCliChecks(
    state: CoordinatorState
  ): Array<{ label: string; found: boolean; detail: string }> {
    const now = Date.now();
    if (!this.cachedCliChecks || now - this.cachedCliChecksAt > 60000) {
      const scanned: Array<{ label: string; found: boolean; detail: string }> = [];
      for (const cliName of ["codex", "claude", "agy", "gemini", "opencode"]) {
        const resolved = resolveExecutableOnNormalizedPath(cliName);
        scanned.push({ label: cliName, found: Boolean(resolved), detail: resolved || "" });
      }
      this.cachedCliChecks = scanned;
      this.cachedCliChecksAt = now;
    }
    return [
      { label: "herdr", found: Boolean(state.binaryPath), detail: state.binaryPath || "" },
      { label: "obs-herdr", found: state.bridgeRunning, detail: state.cliScriptPath },
      ...this.cachedCliChecks,
    ];
  }

  private addKvRow(parent: HTMLElement, key: string, value: string): void {
    parent.createSpan({ cls: "herdr-mc-kv-key", text: key });
    parent.createSpan({ cls: "herdr-mc-kv-val", text: value });
  }

  private resolveActiveWorkspaceId(snap: SessionSnapshot | null): string {
    if (!snap || snap.workspaces.length === 0) {
      return "";
    }
    if (
      this.selectedWorkspaceId &&
      snap.workspaces.some((w) => w.workspace_id === this.selectedWorkspaceId)
    ) {
      return this.selectedWorkspaceId;
    }
    return snap.focused_workspace_id || snap.workspaces[0].workspace_id;
  }

  private resolveActiveTabForWorkspace(
    snap: SessionSnapshot | null,
    workspaceId: string
  ): SessionSnapshot["tabs"][number] | null {
    if (!snap || snap.tabs.length === 0) {
      return null;
    }
    const wsTabs = workspaceId
      ? snap.tabs.filter((t) => t.workspace_id === workspaceId)
      : snap.tabs;
    if (wsTabs.length === 0) {
      return snap.tabs[0];
    }
    return (
      wsTabs.find((t) => t.tab_id === snap.focused_tab_id) ||
      wsTabs.find((t) => t.focused) ||
      wsTabs[0]
    );
  }

  private resolveAgentDisplayLabel(agent: AgentInfo, panes: PaneInfo[]): string {
    const pane = panes.find((p) => p.pane_id === agent.pane_id);
    if (pane?.label && pane.label.trim()) {
      return pane.label.trim();
    }
    return agent.name || agent.display_agent || agent.agent || agent.pane_id;
  }

  private async handleStartSession(): Promise<void> {
    try {
      await this.coordinator.startVaultHerdrSession();
      new Notice(`Started Herdr session '${this.coordinator.getActiveSessionName()}'.`);
    } catch (err) {
      new Notice(`Failed to start session: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async confirmAndStopSession(sessionName: string): Promise<void> {
    const confirmed = await confirmAction(this.app, {
      title: `Stop session '${sessionName}'?`,
      body: `All running agents and terminals in '${sessionName}' will stop immediately.`,
      confirmText: "Stop session",
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    await this.handleStopSession();
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
      this.liveTailTarget = `Why this status (${target})`;
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
      const safeTab =
        tabLabel.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
        tabId.replace(/[^A-Za-z0-9_-]+/g, "-");
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
        "Open Mission Control -> More actions -> **Apply layout from note** while viewing this note to recreate this split tree.",
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
        env: this.coordinator.getBridgeEnv(),
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
      new Notice(`Sent message to '${target}'.`);
      await this.coordinator.refreshAll(false);
    } catch (err) {
      new Notice(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async loadAgentTail(target: string): Promise<void> {
    this.liveTailTarget = `Output (${target})`;
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
      const label = tierLabelFor(
        res.permissionMode as VaultPermissionMode,
        true
      );
      new Notice(
        `Vault access OK: '${res.vaultName}' (${res.markdownCount} Markdown notes, level: ${label}).`
      );
      this.renderDashboard();
    } catch (err) {
      new Notice(`Self-test failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
