import * as path from "node:path";
import {
  ItemView,
  Menu,
  Notice,
  setIcon,
  type ViewStateResult,
  type WorkspaceLeaf,
} from "obsidian";
import type {
  AgentInfo,
  HerdrPluginSettings,
  VaultPermissionMode,
} from "../domain/types";
import { buildHostNormalizedEnv } from "../herdr/cli-client";
import type { CoordinatorState, HerdrCoordinator } from "../services/herdr-coordinator";
import { applyLayoutFromActiveNote, saveTabLayoutToNote } from "../services/layout-notes";
import { renderAgentsTab } from "./dashboard/agents-tab";
import { renderDoctorTab } from "./dashboard/doctor-tab";
import {
  DOCTOR_CLI_RUNTIMES,
  findExecutableInDirsAsync,
  normalizeTabId,
  resolveActiveTabForWorkspace,
  resolveActiveWorkspaceId,
  resolveAgentDisplayLabel,
  shortenPathTail,
  tierLabelFor,
  wireRovingKeyboardNav,
  type DashboardTabHost,
  type DashboardTabId,
} from "./dashboard/types";
import { renderVaultTab } from "./dashboard/vault-tab";
import {
  CreateWorktreeModal,
  DispatchNoteModal,
  SpawnAgentModal,
  confirmAction,
} from "./modals";

export const VIEW_TYPE_HERDR_DASHBOARD = "herdr-view";

export class HerdrDashboardView extends ItemView implements DashboardTabHost {
  readonly coordinator: HerdrCoordinator;
  readonly getSettings: () => HerdrPluginSettings;
  readonly updateSettings: (patch: Partial<HerdrPluginSettings>) => Promise<void>;
  readonly openTerminalLeaf: (options?: {
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
  private liveTailAgentId = "";
  private liveTailGen = 0;
  private liveTailAutoScroll = false;
  private promptDraft = "";
  readonly promptDrafts = new Map<string, string>();
  private readonly openDetails = new Set<string>();
  readonly sendingPromptTargets = new Set<string>();
  private showAllActivity = false;

  private unsubCoord: (() => void) | null = null;
  private unsubAudit: (() => void) | null = null;
  private auditRenderTimer: number | null = null;
  private bodyHostEl: HTMLElement | null = null;
  private statusLineEl: HTMLElement | null = null;
  readonly renderedPromptInputs = new Map<string, HTMLTextAreaElement>();
  readonly renderedAgentPills = new Map<string, HTMLElement>();
  readonly renderedAgentRows = new Map<string, HTMLElement>();
  readonly renderedAgentSubs = new Map<string, HTMLElement>();
  readonly renderedLayoutPanes = new Map<
    string,
    { el: HTMLElement; dotEl?: HTMLElement; subEl?: HTMLElement; focused: boolean }
  >();
  private renderedTabDots = new Map<DashboardTabId, HTMLElement>();
  private lastAgentsStructureKey = "";
  private rendering = false;
  private cachedCliChecks: Array<{ label: string; found: boolean; detail: string }> | null = null;
  private cachedCliChecksAt = 0;
  private cliChecksInFlight = false;
  private cliChecksGen = 0;

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
      if (this.activeTab !== "vault" || this.auditRenderTimer !== null) {
        return;
      }
      const win = this.contentEl.win ?? (typeof window !== "undefined" ? window : null);
      if (!win) {
        this.renderDashboard();
        return;
      }
      this.auditRenderTimer = win.setTimeout(() => {
        this.auditRenderTimer = null;
        if (this.activeTab === "vault" && this.bodyHostEl) {
          this.renderDashboard();
        }
      }, 100);
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
    if (this.auditRenderTimer !== null) {
      const win = this.contentEl.win ?? (typeof window !== "undefined" ? window : null);
      win?.clearTimeout(this.auditRenderTimer);
      this.auditRenderTimer = null;
    }
    this.cliChecksGen += 1;
    this.cliChecksInFlight = false;
    this.renderedPromptInputs.clear();
    this.renderedAgentPills.clear();
    this.renderedAgentRows.clear();
    this.renderedAgentSubs.clear();
    this.renderedLayoutPanes.clear();
    this.renderedTabDots.clear();
    this.statusLineEl = null;
    this.bodyHostEl = null;
    this.lastAgentsStructureKey = "";
    this.contentEl.empty();
    return Promise.resolve();
  }

  getSelectedWorkspaceId(): string {
    return this.selectedWorkspaceId;
  }

  setSelectedWorkspaceId(id: string): void {
    this.selectedWorkspaceId = id;
  }

  getSelectedAgentKey(): string {
    return this.selectedAgentKey;
  }

  setSelectedAgentKey(key: string): void {
    this.selectedAgentKey = key;
  }

  getPromptDraft(): string {
    return this.promptDraft;
  }

  setPromptDraft(draft: string): void {
    this.promptDraft = draft;
  }

  getLiveTailTarget(): string {
    return this.liveTailTarget;
  }

  getLiveTailText(): string {
    return this.liveTailText;
  }

  getLiveTailAgentId(): string {
    return this.liveTailAgentId;
  }

  consumeLiveTailAutoScroll(): boolean {
    const pending = this.liveTailAutoScroll;
    this.liveTailAutoScroll = false;
    return pending;
  }

  clearLiveTail(): void {
    this.liveTailGen += 1;
    this.liveTailTarget = "";
    this.liveTailText = "";
    this.liveTailAgentId = "";
    this.liveTailAutoScroll = false;
  }

  getShowAllActivity(): boolean {
    return this.showAllActivity;
  }

  setShowAllActivity(show: boolean): void {
    this.showAllActivity = show;
  }

  openSpawnModal(defaultKind?: string, switchToAgents = false): void {
    new SpawnAgentModal(
      this.app,
      this.coordinator,
      defaultKind || this.getSettings().defaultAgentKind,
      () => {
        if (switchToAgents) {
          this.activeTab = "agents";
        }
        this.renderDashboard();
      }
    ).open();
  }

  renderDashboard(): void {
    const host = this.bodyHostEl;
    if (!host || this.rendering) {
      return;
    }
    this.rendering = true;
    try {
      const doc = host.ownerDocument ?? (typeof document !== "undefined" ? document : null);
      const activeEl = doc?.activeElement ?? null;
      let savedFocus: {
        agentKey: string;
        selectionStart: number | null;
        selectionEnd: number | null;
      } | null = null;
      let savedFocusId = "";

      if (activeEl && typeof host.contains === "function" && host.contains(activeEl)) {
        if (
          (activeEl.tagName === "TEXTAREA" || activeEl.tagName === "INPUT") &&
          activeEl.classList?.contains("herdr-prompt-input")
        ) {
          const focusedInput = activeEl as HTMLTextAreaElement;
          const agentKey = focusedInput.getAttribute("data-agent-target") || "";
          if (agentKey) {
            this.promptDrafts.set(agentKey, focusedInput.value);
            this.selectedAgentKey = agentKey;
            this.promptDraft = focusedInput.value;
            savedFocus = {
              agentKey,
              selectionStart: focusedInput.selectionStart,
              selectionEnd: focusedInput.selectionEnd,
            };
          }
        } else if (typeof activeEl.getAttribute === "function") {
          savedFocusId = activeEl.getAttribute("data-herdr-focus-id") || "";
        }
      }

      const state = this.coordinator.getState();

      if (!state.serverRunning) {
        this.promptDrafts.clear();
        this.promptDraft = "";
        if (this.liveTailTarget) {
          this.clearLiveTail();
        }
      }

      if (
        this.activeTab === "agents" &&
        state.serverRunning &&
        state.snapshot &&
        this.statusLineEl
      ) {
        const nextStructureKey = this.computeAgentsStructureKey(state);
        if (nextStructureKey === this.lastAgentsStructureKey) {
          this.updateAgentsViewInPlace(state);
          return;
        }
      }

      this.renderedPromptInputs.clear();
      this.renderedAgentPills.clear();
      this.renderedAgentRows.clear();
      this.renderedAgentSubs.clear();
      this.renderedLayoutPanes.clear();
      this.renderedTabDots.clear();
      this.statusLineEl = null;
      host.empty();

      const crown = host.createDiv({ cls: "herdr-mc-crown" });
      this.renderHeader(crown, state);
      this.renderStatusLine(crown, state);
      this.renderAttentionBanner(host, state);
      this.renderTabs(host, state);

      const panel = host.createDiv({
        cls: "herdr-tab-panel",
        attr: {
          role: "tabpanel",
          id: `herdr-mc-panel-${this.activeTab}`,
          "aria-labelledby": `herdr-mc-tab-${this.activeTab}`,
        },
      });
      switch (this.activeTab) {
        case "agents":
          renderAgentsTab(this, panel, state);
          break;
        case "vault":
          renderVaultTab(this, panel, state);
          break;
        case "doctor":
          renderDoctorTab(this, panel, state);
          break;
      }

      this.lastAgentsStructureKey =
        this.activeTab === "agents" && state.serverRunning && state.snapshot
          ? this.computeAgentsStructureKey(state)
          : "";

      if (savedFocus) {
        const nextInput = this.renderedPromptInputs.get(savedFocus.agentKey);
        if (nextInput) {
          if (typeof nextInput.focus === "function") {
            nextInput.focus({ preventScroll: true });
          }
          if (
            savedFocus.selectionStart !== null &&
            savedFocus.selectionEnd !== null &&
            typeof nextInput.setSelectionRange === "function"
          ) {
            try {
              nextInput.setSelectionRange(savedFocus.selectionStart, savedFocus.selectionEnd);
            } catch {
              // Ignore selection restore failure on unsupported input states
            }
          }
        }
      } else if (savedFocusId) {
        const restored = this.findElementByFocusId(host, savedFocusId);
        if (restored && typeof restored.focus === "function") {
          restored.focus({ preventScroll: true });
        }
      }
    } finally {
      this.rendering = false;
    }
  }

  private findElementByFocusId(root: HTMLElement, focusId: string): HTMLElement | null {
    const stack: HTMLElement[] = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (typeof node.getAttribute === "function" && node.getAttribute("data-herdr-focus-id") === focusId) {
        return node;
      }
      const children = node.children;
      if (children && children.length > 0) {
        for (let i = children.length - 1; i >= 0; i -= 1) {
          stack.push(children[i] as HTMLElement);
        }
      }
    }
    return null;
  }

  private computeAgentsStructureKey(state: CoordinatorState): string {
    const snap = state.snapshot;
    if (!snap) {
      return "";
    }
    const activeWsId = resolveActiveWorkspaceId(snap, this.selectedWorkspaceId);
    const activeTab = resolveActiveTabForWorkspace(snap, activeWsId);
    const activeLayout = activeTab
      ? snap.layouts.find((l) => l.tab_id === activeTab.tab_id)
      : snap.layouts[0];

    const blockedSig = snap.agents
      .filter((a) => a.agent_status === "blocked")
      .map((a) => `${a.name || a.pane_id}:${resolveAgentDisplayLabel(a, snap.panes)}`)
      .join(",");
    const wsSig = snap.workspaces.map((w) => `${w.workspace_id}:${w.label || ""}`).join(",");
    const layoutSig = activeLayout
      ? activeLayout.panes
          .map(
            (lp) =>
              `${lp.pane_id}:${lp.focused ? "1" : "0"}:${lp.rect.x},${lp.rect.y},${lp.rect.width},${lp.rect.height}`
          )
          .join(";")
      : "";
    const agentSig = snap.agents
      .map((a) => {
        const targetId = a.name || a.pane_id;
        const label = resolveAgentDisplayLabel(a, snap.panes);
        return `${targetId}:${a.pane_id}:${label}:${a.agent || ""}:${a.cwd || ""}:${this.sendingPromptTargets.has(targetId) ? "1" : "0"}`;
      })
      .join(";");
    const wtSig = state.worktrees
      .map(
        (wt) =>
          `${wt.path}:${wt.branch || wt.label || ""}:${wt.open_workspace_id || wt.workspace_id || ""}`
      )
      .join(";");

    return [
      state.activeSessionName,
      state.protocolWarning || "",
      state.bridgeRunning ? "1" : "0",
      this.getSettings().vaultPermissionMode,
      activeWsId,
      blockedSig,
      wsSig,
      layoutSig,
      agentSig,
      this.liveTailTarget,
      String(this.liveTailText.length),
      wtSig,
    ].join("|");
  }

  private updateAgentsViewInPlace(state: CoordinatorState): void {
    const snap = state.snapshot;
    if (!snap || !this.statusLineEl) {
      return;
    }
    this.populateStatusLine(this.statusLineEl, state);

    const agents = snap.agents;
    const hasBlocked = agents.some((a) => a.agent_status === "blocked");
    const hasWorking = agents.some((a) => a.agent_status === "working");
    const agentsTabDot = this.renderedTabDots.get("agents");
    if (agentsTabDot) {
      const nextDotCls = hasBlocked ? "is-blocked" : hasWorking ? "is-working" : "";
      agentsTabDot.className = nextDotCls
        ? `herdr-mc-tab-dot ${nextDotCls}`
        : "herdr-mc-tab-dot herdr-is-hidden";
    }

    for (const agent of agents) {
      const targetId = agent.name || agent.pane_id;
      const paneMeta = snap.panes.find((p) => p.pane_id === agent.pane_id);
      const pill = this.renderedAgentPills.get(targetId);
      if (pill) {
        pill.className = `herdr-mc-pill is-${agent.agent_status}`;
        pill.setText(agent.agent_status);
      }
      const row = this.renderedAgentRows.get(targetId);
      if (row) {
        const isHighlighted = this.selectedAgentKey === targetId;
        row.className = `herdr-mc-agent-row is-${agent.agent_status}${isHighlighted ? " is-highlighted" : ""}`;
      }
      const subEl = this.renderedAgentSubs.get(targetId);
      if (subEl) {
        const liveSub =
          paneMeta?.terminal_title_stripped?.trim() ||
          paneMeta?.terminal_title?.trim() ||
          shortenPathTail(agent.cwd || paneMeta?.cwd, 52);
        subEl.setText(liveSub);
        subEl.classList?.toggle("herdr-is-hidden", !liveSub);
      }
    }

    for (const [paneId, entry] of this.renderedLayoutPanes) {
      const paneMeta = snap.panes.find((p) => p.pane_id === paneId);
      const agentMeta = snap.agents.find((a) => a.pane_id === paneId);
      const status = agentMeta?.agent_status || paneMeta?.agent_status || "idle";
      const targetId = agentMeta?.name || paneId;
      const isSelected = this.selectedAgentKey === targetId;
      entry.el.className = `herdr-mc-layoutmap-pane is-${status}${entry.focused ? " is-focused" : ""}${isSelected ? " is-selected" : ""}`;
      if (entry.dotEl) {
        entry.dotEl.className = `herdr-mc-pane-dot is-${status}`;
      }
      if (entry.subEl) {
        const subtitleText =
          paneMeta?.terminal_title_stripped?.trim() ||
          paneMeta?.terminal_title?.trim() ||
          shortenPathTail(paneMeta?.cwd, 34);
        entry.subEl.setText(subtitleText);
        entry.subEl.classList?.toggle("herdr-is-hidden", !subtitleText);
      }
    }
  }

  createTrackedDetails(
    parent: HTMLElement,
    sectionId: string,
    cls = "herdr-mc-details"
  ): HTMLDetailsElement {
    const details = parent.createEl("details", { cls });
    if (this.openDetails.has(sectionId)) {
      details.open = true;
    }
    details.addEventListener("toggle", () => {
      if (details.open) {
        this.openDetails.add(sectionId);
      } else {
        this.openDetails.delete(sectionId);
      }
    });
    return details;
  }

  private showMenuAtEvent(menu: Menu, ev: MouseEvent): void {
    if (
      ev.clientX === 0 &&
      ev.clientY === 0 &&
      ev.currentTarget &&
      typeof (ev.currentTarget as HTMLElement).getBoundingClientRect === "function"
    ) {
      const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
      menu.showAtPosition({ x: Math.round(rect.left), y: Math.round(rect.bottom + 4) });
      return;
    }
    menu.showAtMouseEvent(ev);
  }

  private renderHeader(parent: HTMLElement, state: CoordinatorState): void {
    const header = parent.createDiv({ cls: "herdr-mc-header" });
    header.createDiv({ cls: "herdr-mc-title", text: "Herdr Mission Control" });

    const actions = header.createDiv({ cls: "herdr-mc-actions" });
    const spawnBtn = actions.createEl("button", {
      text: "Spawn agent",
      cls: "mod-cta herdr-btn-compact",
      attr: {
        type: "button",
        "data-herdr-focus-id": "crown-spawn",
        ...(state.binaryPath ? {} : { title: "Install Herdr to spawn agents" }),
      },
    });
    spawnBtn.disabled = !state.binaryPath;
    spawnBtn.addEventListener("click", () => {
      this.openSpawnModal(undefined, true);
    });

    const moreBtn = actions.createEl("button", {
      cls: "clickable-icon herdr-mc-more",
      attr: {
        "aria-label": "More actions",
        title: "More actions",
        type: "button",
        "data-herdr-focus-id": "crown-more",
      },
    });
    setIcon(moreBtn, "more-horizontal");
    moreBtn.addEventListener("click", (ev: MouseEvent) => {
      this.openHeaderMenu(ev, state);
    });
  }

  private openHeaderMenu(ev: MouseEvent, state: CoordinatorState): void {
    const snap = state.serverRunning ? state.snapshot : null;
    const activeWsId = resolveActiveWorkspaceId(snap, this.selectedWorkspaceId);
    const activeWs = snap?.workspaces.find((w) => w.workspace_id === activeWsId);
    const activeTab = resolveActiveTabForWorkspace(snap, activeWsId);

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
          void applyLayoutFromActiveNote(this.app, this.coordinator, activeWsId || undefined);
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("Save layout to note")
        .setIcon("save")
        .setDisabled(!state.serverRunning || !activeTab)
        .onClick(() => {
          if (activeTab) {
            void saveTabLayoutToNote(
              this.app,
              this.coordinator,
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

    this.showMenuAtEvent(menu, ev);
  }

  private renderStatusLine(parent: HTMLElement, state: CoordinatorState): void {
    const line = parent.createDiv({ cls: "herdr-mc-status" });
    this.statusLineEl = line;
    this.populateStatusLine(line, state);
  }

  private populateStatusLine(line: HTMLElement, state: CoordinatorState): void {
    const snap = state.serverRunning ? state.snapshot : null;
    const agents = snap?.agents ?? [];
    const working = agents.filter((a) => a.agent_status === "working").length;
    const blocked = agents.filter((a) => a.agent_status === "blocked").length;
    const done = agents.filter((a) => a.agent_status === "done").length;

    const version =
      state.snapshot?.version || state.statusPayload?.client?.version || "not detected";
    const tooltip = `Session: ${state.activeSessionName} | Herdr ${version}`;

    line.empty();
    line.setAttr("title", tooltip);

    const dotState = !state.serverRunning
      ? "is-offline"
      : blocked > 0 || Boolean(state.protocolWarning)
        ? "is-warn"
        : "is-live";
    line.createSpan({
      cls: `herdr-mc-status-dot ${dotState}`,
      attr: { "aria-hidden": "true" },
    });

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
    const blockedAgents = state.snapshot.agents.filter((a) => a.agent_status === "blocked");
    if (blockedAgents.length === 0) {
      return;
    }

    const banner = parent.createDiv({
      cls: "herdr-mc-attention",
      attr: { role: "alert" },
    });
    for (const agent of blockedAgents) {
      const displayName = resolveAgentDisplayLabel(agent, state.snapshot.panes);
      const paneMeta = state.snapshot.panes.find((p) => p.pane_id === agent.pane_id);
      const targetId = agent.name || agent.pane_id;
      const row = banner.createDiv({ cls: "herdr-blocked-bar" });
      const head = row.createDiv({ cls: "herdr-blocked-head" });
      head.createSpan({
        cls: "herdr-blocked-label",
        text: `${displayName} needs input`,
      });
      const ctxHint =
        paneMeta?.terminal_title_stripped?.trim() ||
        paneMeta?.terminal_title?.trim() ||
        shortenPathTail(agent.cwd || paneMeta?.cwd, 48);
      if (ctxHint) {
        head.createSpan({ cls: "herdr-blocked-context", text: ctxHint });
      }

      const actions = row.createDiv({ cls: "herdr-action-row" });
      const peekBtn = actions.createEl("button", {
        text: "Peek",
        cls: "herdr-btn-compact",
        attr: { type: "button" },
      });
      peekBtn.addEventListener("click", () => {
        void this.loadAgentTail(targetId);
      });
      for (const keySpec of [
        { label: "Approve (y + Enter)", keys: ["y", "enter"] },
        { label: "Enter", keys: ["enter"] },
        { label: "Esc", keys: ["esc"] },
        { label: "Cancel (Ctrl+C)", keys: ["ctrl+c"] },
      ]) {
        const kBtn = actions.createEl("button", {
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

  private renderTabs(parent: HTMLElement, state: CoordinatorState): void {
    const nav = parent.createDiv({
      cls: "herdr-mc-tabs",
      attr: { role: "tablist" },
    });

    const agents = state.serverRunning ? (state.snapshot?.agents ?? []) : [];
    const hasBlocked = agents.some((a) => a.agent_status === "blocked");
    const hasWorking = agents.some((a) => a.agent_status === "working");
    const hasDoctorWarn = Boolean(
      state.protocolWarning || state.statusPayload?.server?.restart_needed
    );

    const tabs: Array<{ id: DashboardTabId; label: string; dotClass?: string }> = [
      {
        id: "agents",
        label: "Agents",
        dotClass: hasBlocked ? "is-blocked" : hasWorking ? "is-working" : undefined,
      },
      {
        id: "vault",
        label: "Vault",
        dotClass: state.bridgeRunning ? "is-live" : undefined,
      },
      {
        id: "doctor",
        label: "Doctor",
        dotClass: hasDoctorWarn ? "is-blocked" : undefined,
      },
    ];

    const buttons: HTMLButtonElement[] = [];
    for (const item of tabs) {
      const isActive = this.activeTab === item.id;
      const btn = nav.createEl("button", {
        text: item.label,
        cls: `herdr-mc-tab ${isActive ? "is-active" : ""}`,
        attr: {
          id: `herdr-mc-tab-${item.id}`,
          role: "tab",
          "aria-selected": isActive ? "true" : "false",
          "aria-controls": `herdr-mc-panel-${item.id}`,
          tabindex: isActive ? "0" : "-1",
          type: "button",
          "data-herdr-focus-id": `tab:${item.id}`,
        },
      });
      const dot = btn.createSpan({
        cls: item.dotClass
          ? `herdr-mc-tab-dot ${item.dotClass}`
          : "herdr-mc-tab-dot herdr-is-hidden",
        attr: { "aria-hidden": "true" },
      });
      this.renderedTabDots.set(item.id, dot);
      btn.addEventListener("click", () => {
        this.activeTab = item.id;
        this.renderDashboard();
      });
      buttons.push(btn);
    }
    wireRovingKeyboardNav(buttons);
  }

  openAgentMenu(
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
    this.appendPaneSplitMenuItems(menu, agent.pane_id);
    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle("Why this status?")
        .setIcon("help-circle")
        .onClick(() => {
          void this.loadAgentExplain(targetId);
        })
    );

    this.showMenuAtEvent(menu, ev);
  }

  openPaneMenu(
    ev: MouseEvent,
    paneId: string,
    agent: AgentInfo | undefined,
    sessionName: string
  ): void {
    if (agent) {
      this.openAgentMenu(ev, agent, agent.name || agent.pane_id, sessionName);
      return;
    }
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Read output")
        .setIcon("file-text")
        .onClick(() => {
          void this.loadAgentTail(paneId);
        })
    );
    menu.addItem((item) =>
      item
        .setTitle("Attach in terminal")
        .setIcon("terminal")
        .onClick(() => {
          void this.openTerminalLeaf({
            agentTarget: paneId,
            sessionName,
            split: true,
          }).catch((err: unknown) => {
            new Notice(err instanceof Error ? err.message : String(err));
          });
        })
    );
    menu.addSeparator();
    this.appendPaneSplitMenuItems(menu, paneId);
    this.showMenuAtEvent(menu, ev);
  }

  private appendPaneSplitMenuItems(menu: Menu, paneId: string): void {
    const cwd = this.coordinator.vaultOps.getVaultBasePath() || undefined;
    menu.addItem((item) =>
      item
        .setTitle("Split right")
        .setIcon("columns-2")
        .onClick(() => {
          void this.coordinator.socket
            .splitPane({
              targetPaneId: paneId,
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
              targetPaneId: paneId,
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
            .zoomPane(paneId, "toggle")
            .then(() => this.coordinator.refreshAll(false))
            .catch((err: unknown) => {
              new Notice(err instanceof Error ? err.message : String(err));
            });
        })
    );
  }

  getCachedCliChecks(
    state: CoordinatorState
  ): Array<{ label: string; status: "ready" | "missing" | "off" | "Checking..."; detail: string }> {
    const now = Date.now();
    const isStale = !this.cachedCliChecks || now - this.cachedCliChecksAt > 60000;
    if (isStale) {
      this.triggerAsyncCliChecks();
    }

    const settings = this.getSettings();
    const bridgeDisabledByUser =
      !settings.vaultBridgeEnabled || settings.vaultPermissionMode === "off";
    const baseChecks: Array<{
      label: string;
      status: "ready" | "missing" | "off" | "Checking...";
      detail: string;
    }> = [
      {
        label: "herdr",
        status: state.binaryPath ? "ready" : "missing",
        detail: state.binaryPath || "",
      },
      {
        label: "obs-herdr",
        status: state.bridgeRunning ? "ready" : bridgeDisabledByUser ? "off" : "missing",
        detail: state.cliScriptPath,
      },
    ];

    if (!this.cachedCliChecks) {
      return [
        ...baseChecks,
        ...DOCTOR_CLI_RUNTIMES.map((cliName) => ({
          label: cliName,
          status: "Checking..." as const,
          detail: "",
        })),
      ];
    }

    return [
      ...baseChecks,
      ...this.cachedCliChecks.map((item) => ({
        label: item.label,
        status: item.found ? ("ready" as const) : ("missing" as const),
        detail: item.detail,
      })),
    ];
  }

  private triggerAsyncCliChecks(): void {
    if (this.cliChecksInFlight) {
      return;
    }
    this.cliChecksInFlight = true;
    const gen = ++this.cliChecksGen;

    void (async () => {
      try {
        const norm = buildHostNormalizedEnv(process.env);
        const dirs = (norm.PATH || "").split(path.delimiter).filter(Boolean);
        const scanned = await Promise.all(
          DOCTOR_CLI_RUNTIMES.map(async (cliName) => {
            const resolved = await findExecutableInDirsAsync(cliName, dirs);
            return {
              label: cliName,
              found: Boolean(resolved),
              detail: resolved || "",
            };
          })
        );
        if (gen === this.cliChecksGen && this.bodyHostEl) {
          this.cachedCliChecks = scanned;
          this.cachedCliChecksAt = Date.now();
          if (this.activeTab === "doctor") {
            this.renderDashboard();
          }
        }
      } catch (err) {
        console.warn("[herdr-obs] Async CLI check failed:", err);
      } finally {
        if (gen === this.cliChecksGen) {
          this.cliChecksInFlight = false;
        }
      }
    })();
  }

  async handleStartSession(): Promise<void> {
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
    const gen = ++this.liveTailGen;
    try {
      const payload = await this.coordinator.socket.explainAgent(target);
      if (gen !== this.liveTailGen) {
        return;
      }
      this.activeTab = "agents";
      this.liveTailTarget = `Why this status (${target})`;
      this.liveTailAgentId = "";
      this.liveTailText = JSON.stringify(payload, null, 2);
      this.liveTailAutoScroll = true;
      this.renderDashboard();
    } catch (err) {
      if (gen !== this.liveTailGen) {
        return;
      }
      new Notice(`Explain failed: ${err instanceof Error ? err.message : String(err)}`);
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

  async promptSingleAgent(target: string, prompt: string): Promise<boolean> {
    try {
      await this.coordinator.socket.promptAgent(target, prompt);
      this.promptDrafts.delete(target);
      if (this.selectedAgentKey === target) {
        this.promptDraft = "";
      }
      this.sendingPromptTargets.delete(target);
      new Notice(`Sent message to '${target}'.`);
      await this.coordinator.refreshAll(false);
      return true;
    } catch (err) {
      new Notice(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async loadAgentTail(target: string): Promise<void> {
    const gen = ++this.liveTailGen;
    const nextLabel = `Output (${target})`;
    try {
      const text = await this.coordinator.socket.readAgent(target, "recent_unwrapped", 60);
      if (gen !== this.liveTailGen) {
        return;
      }
      this.activeTab = "agents";
      this.liveTailTarget = nextLabel;
      this.liveTailAgentId = target;
      this.liveTailText = text;
      this.liveTailAutoScroll = true;
      this.renderDashboard();
    } catch {
      try {
        const fallback = await this.coordinator.socket.readPane(
          target,
          "recent_unwrapped",
          60
        );
        if (gen !== this.liveTailGen) {
          return;
        }
        this.activeTab = "agents";
        this.liveTailTarget = nextLabel;
        this.liveTailAgentId = target;
        this.liveTailText = fallback;
        this.liveTailAutoScroll = true;
        this.renderDashboard();
      } catch (err) {
        if (gen !== this.liveTailGen) {
          return;
        }
        new Notice(`Could not read output: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async runBridgeSelfTest(): Promise<void> {
    try {
      const res = (await this.coordinator.vaultOps.dispatch(
        "vault.info",
        {},
        "mission-control-selftest"
      )) as { vaultName: string; markdownCount: number; permissionMode: string };
      const label = tierLabelFor(res.permissionMode as VaultPermissionMode, true);
      new Notice(
        `Vault access OK: '${res.vaultName}' (${res.markdownCount} Markdown notes, level: ${label}).`
      );
      this.renderDashboard();
    } catch (err) {
      new Notice(`Self-test failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
