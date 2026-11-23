import { Notice, setIcon } from "obsidian";
import type {
  AgentInfo,
  PaneLayoutSnapshot,
  SessionSnapshot,
} from "../../domain/types";
import type { CoordinatorState } from "../../services/herdr-coordinator";
import { DispatchNoteModal, confirmAction } from "../modals";
import {
  resolveActiveTabForWorkspace,
  resolveActiveWorkspaceId,
  resolveAgentDisplayLabel,
  shortenPathTail,
  type DashboardTabHost,
} from "./types";

function autoSizeTextarea(el: HTMLTextAreaElement): void {
  if (typeof el.setCssProps !== "function") {
    return;
  }
  el.setCssProps({ height: "auto" });
  const scrollH = typeof el.scrollHeight === "number" ? el.scrollHeight : 0;
  if (scrollH > 0) {
    el.setCssProps({ height: `${Math.min(120, Math.max(30, scrollH))}px` });
  }
}

export function renderAgentsTab(
  host: DashboardTabHost,
  parent: HTMLElement,
  state: CoordinatorState
): void {
  if (!state.serverRunning || !state.snapshot) {
    const empty = parent.createDiv({ cls: "herdr-mc-empty herdr-mc-halftone-card" });
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
        void host.handleStartSession();
      });
    }
    const termBtn = row.createEl("button", {
      text: "Open terminal",
      cls: "herdr-btn-compact",
      attr: { type: "button" },
    });
    termBtn.addEventListener("click", () => {
      void host.openTerminalLeaf({ split: false }).catch((err: unknown) => {
        new Notice(err instanceof Error ? err.message : String(err));
      });
    });
    return;
  }

  const snap = state.snapshot;
  const activeWsId = resolveActiveWorkspaceId(snap, host.getSelectedWorkspaceId());

  if (snap.workspaces.length > 1) {
    const wsRow = parent.createDiv({ cls: "herdr-workspace-chips" });
    for (const ws of snap.workspaces) {
      const isSelected = ws.workspace_id === activeWsId;
      const chip = wsRow.createEl("button", {
        cls: `herdr-ws-chip ${isSelected ? "is-selected" : ""}`,
        text: ws.label || ws.workspace_id,
        attr: {
          title: `${ws.label} (${ws.workspace_id})`,
          type: "button",
          "aria-pressed": isSelected ? "true" : "false",
          "data-herdr-focus-id": `ws:${ws.workspace_id}`,
        },
      });
      chip.addEventListener("click", () => {
        host.setSelectedWorkspaceId(ws.workspace_id);
        void host.coordinator.socket
          .focusWorkspace(ws.workspace_id)
          .then(() => host.coordinator.refreshAll(false))
          .catch((err: unknown) => {
            new Notice(err instanceof Error ? err.message : String(err));
          });
      });
    }
  }

  const activeTab = resolveActiveTabForWorkspace(snap, activeWsId);
  const activeLayout = activeTab
    ? snap.layouts.find((l) => l.tab_id === activeTab.tab_id)
    : snap.layouts[0];
  if (activeLayout && activeLayout.panes.length > 0) {
    renderSpatialLayoutBoard(host, parent, activeLayout, state, snap);
  }

  const agents = snap.agents ?? [];
  if (agents.length === 0) {
    const empty = parent.createDiv({ cls: "herdr-mc-empty herdr-mc-halftone-card" });
    empty.createEl("p", { text: "No coding agents are running in this session." });
    const spawnBtn = empty.createEl("button", {
      text: "Spawn agent",
      cls: "mod-cta herdr-btn-compact",
      attr: { type: "button" },
    });
    spawnBtn.addEventListener("click", () => {
      host.openSpawnModal();
    });
  } else {
    for (const agent of agents) {
      renderAgentRow(host, parent, agent, state, snap);
    }
  }

  renderLiveTailDrawer(host, parent);
  renderWorktreesSection(host, parent, state);
}

function renderSpatialLayoutBoard(
  host: DashboardTabHost,
  parent: HTMLElement,
  layout: PaneLayoutSnapshot,
  state: CoordinatorState,
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

  const boardWrap = parent.createDiv({ cls: "herdr-mc-board-wrap" });
  const canvas = boardWrap.createDiv({ cls: "herdr-mc-layoutmap" });

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
    const targetId = agentMeta?.name || lp.pane_id;
    const isSelected = host.getSelectedAgentKey() === targetId;

    const relX = Math.max(0, lp.rect.x - originX);
    const relY = Math.max(0, lp.rect.y - originY);
    const cell = canvas.createDiv({
      cls: `herdr-mc-layoutmap-pane is-${status}${lp.focused ? " is-focused" : ""}${isSelected ? " is-selected" : ""}`,
      attr: {
        role: "group",
        "aria-label": `${label} (${status})`,
        "data-pane-id": lp.pane_id,
      },
    });
    cell.style.left = `${((relX / totalW) * 100).toFixed(2)}%`;
    cell.style.top = `${((relY / totalH) * 100).toFixed(2)}%`;
    cell.style.width = `${((lp.rect.width / totalW) * 100).toFixed(2)}%`;
    cell.style.height = `${((lp.rect.height / totalH) * 100).toFixed(2)}%`;

    const selectBtn = cell.createEl("button", {
      cls: "herdr-mc-pane-select",
      attr: {
        type: "button",
        "data-pane-id": lp.pane_id,
        "data-herdr-focus-id": `pane:${lp.pane_id}`,
        title: `${label} (${lp.pane_id}) · ${status}${paneMeta?.cwd ? ` · ${paneMeta.cwd}` : ""}`,
      },
    });
    selectBtn.createSpan({ cls: "herdr-mc-pane-title", text: label });

    const metaRow = selectBtn.createDiv({ cls: "herdr-mc-pane-meta" });
    const dotEl = metaRow.createSpan({
      cls: `herdr-mc-pane-dot is-${status}`,
      attr: { "aria-hidden": "true" },
    });
    const runtimeTag = agentMeta?.agent || paneMeta?.display_agent || paneMeta?.agent || "";
    if (runtimeTag) {
      metaRow.createSpan({ cls: "herdr-mc-pane-tag", text: runtimeTag });
    }
    metaRow.createSpan({ cls: "herdr-mc-pane-id", text: lp.pane_id });

    const subtitleText =
      paneMeta?.terminal_title_stripped?.trim() ||
      paneMeta?.terminal_title?.trim() ||
      shortenPathTail(paneMeta?.cwd, 34);
    const subEl = selectBtn.createDiv({
      cls: "herdr-mc-pane-sub",
      text: subtitleText,
    });
    if (!subtitleText) {
      subEl.addClass("herdr-is-hidden");
    }

    const dock = cell.createDiv({ cls: "herdr-mc-pane-dock" });
    const attachAction = dock.createEl("button", {
      cls: "herdr-mc-dock-btn",
      attr: {
        type: "button",
        "aria-label": `Attach ${label} in terminal`,
        title: "Attach in terminal",
        "data-herdr-focus-id": `pane-attach:${lp.pane_id}`,
      },
    });
    setIcon(attachAction, "terminal");
    attachAction.addEventListener("click", (ev: MouseEvent) => {
      ev.stopPropagation();
      void host
        .openTerminalLeaf({
          agentTarget: targetId,
          sessionName: state.activeSessionName,
          split: true,
        })
        .catch((err: unknown) => {
          new Notice(err instanceof Error ? err.message : String(err));
        });
    });

    const peekAction = dock.createEl("button", {
      cls: "herdr-mc-dock-btn",
      attr: {
        type: "button",
        "aria-label": `Peek output for ${label}`,
        title: "Peek output",
        "data-herdr-focus-id": `pane-peek:${lp.pane_id}`,
      },
    });
    setIcon(peekAction, "eye");
    peekAction.addEventListener("click", (ev: MouseEvent) => {
      ev.stopPropagation();
      void host.loadAgentTail(targetId);
    });

    const zoomAction = dock.createEl("button", {
      cls: "herdr-mc-dock-btn",
      attr: {
        type: "button",
        "aria-label": `Toggle zoom for ${label}`,
        title: "Toggle zoom",
        "data-herdr-focus-id": `pane-zoom:${lp.pane_id}`,
      },
    });
    setIcon(zoomAction, "maximize-2");
    zoomAction.addEventListener("click", (ev: MouseEvent) => {
      ev.stopPropagation();
      void host.coordinator.socket
        .zoomPane(lp.pane_id, "toggle")
        .then(() => host.coordinator.refreshAll(false))
        .catch((err: unknown) => {
          new Notice(err instanceof Error ? err.message : String(err));
        });
    });

    host.renderedLayoutPanes.set(lp.pane_id, { el: cell, dotEl, subEl, focused: lp.focused });

    selectBtn.addEventListener("click", () => {
      host.setSelectedAgentKey(targetId);
      const card = host.renderedAgentRows.get(targetId);
      if (card) {
        for (const [k, rowEl] of host.renderedAgentRows) {
          rowEl.classList?.toggle("is-highlighted", k === targetId);
        }
        card.scrollIntoView?.({ block: "nearest" });
      }
      for (const [pid, entry] of host.renderedLayoutPanes) {
        entry.el.classList?.toggle("is-selected", pid === lp.pane_id);
      }
      void host.coordinator.socket
        .focusPane(lp.pane_id)
        .catch((err: unknown) => {
          new Notice(err instanceof Error ? err.message : String(err));
        });
    });

    selectBtn.addEventListener("dblclick", () => {
      void host
        .openTerminalLeaf({
          agentTarget: targetId,
          sessionName: state.activeSessionName,
          split: true,
        })
        .catch((err: unknown) => {
          new Notice(err instanceof Error ? err.message : String(err));
        });
    });

    cell.addEventListener("contextmenu", (ev: MouseEvent) => {
      ev.preventDefault();
      host.openPaneMenu(ev, lp.pane_id, agentMeta, state.activeSessionName);
    });
  }
}

function renderAgentRow(
  host: DashboardTabHost,
  parent: HTMLElement,
  agent: AgentInfo,
  state: CoordinatorState,
  snap: SessionSnapshot
): void {
  const label = resolveAgentDisplayLabel(agent, snap.panes);
  const paneMeta = snap.panes.find((p) => p.pane_id === agent.pane_id);
  const targetId = agent.name || agent.pane_id;
  const tooltipParts = [`Pane: ${agent.pane_id}`, `Runtime: ${agent.agent || "shell"}`];
  if (agent.cwd) {
    tooltipParts.push(`CWD: ${agent.cwd}`);
  }
  const isHighlighted = host.getSelectedAgentKey() === targetId;

  const row = parent.createDiv({
    cls: `herdr-mc-agent-row is-${agent.agent_status}${isHighlighted ? " is-highlighted" : ""}`,
  });
  host.renderedAgentRows.set(targetId, row);

  const top = row.createDiv({ cls: "herdr-card-header" });
  const identity = top.createDiv({ cls: "herdr-mc-agent-identity" });
  identity.createSpan({
    cls: "herdr-mc-agent-name",
    text: label,
    attr: { title: tooltipParts.join(" | ") },
  });
  if (agent.agent) {
    identity.createSpan({ cls: "herdr-mc-runtime-chip", text: agent.agent });
  }
  identity.createSpan({ cls: "herdr-mc-pane-chip", text: agent.pane_id });

  const right = top.createDiv({ cls: "herdr-mc-actions" });
  const statusPill = right.createSpan({
    cls: `herdr-mc-pill is-${agent.agent_status}`,
    text: agent.agent_status,
  });
  host.renderedAgentPills.set(targetId, statusPill);

  const attachBtn = right.createEl("button", {
    cls: "clickable-icon herdr-mc-icon-action",
    attr: {
      "aria-label": `Attach ${label} in terminal`,
      title: "Attach in terminal",
      type: "button",
    },
  });
  setIcon(attachBtn, "terminal");
  attachBtn.addEventListener("click", () => {
    void host
      .openTerminalLeaf({
        agentTarget: targetId,
        sessionName: state.activeSessionName,
        split: true,
      })
      .catch((err: unknown) => {
        new Notice(err instanceof Error ? err.message : String(err));
      });
  });

  const isPeeking = host.getLiveTailAgentId() === targetId;
  const peekBtn = right.createEl("button", {
    cls: `clickable-icon herdr-mc-icon-action${isPeeking ? " is-active" : ""}`,
    attr: {
      "aria-label": isPeeking ? `Hide live output for ${label}` : `Read live output for ${label}`,
      "aria-pressed": isPeeking ? "true" : "false",
      title: isPeeking ? "Hide live output" : "Peek live output",
      type: "button",
      "data-herdr-focus-id": `agent-peek:${targetId}`,
    },
  });
  setIcon(peekBtn, "file-text");
  peekBtn.addEventListener("click", () => {
    if (host.getLiveTailAgentId() === targetId) {
      host.clearLiveTail();
      host.renderDashboard();
    } else {
      void host.loadAgentTail(targetId);
    }
  });

  const moreBtn = right.createEl("button", {
    cls: "clickable-icon herdr-mc-more",
    attr: {
      "aria-label": `Actions for ${label}`,
      title: `Actions for ${label}`,
      type: "button",
      "data-herdr-focus-id": `agent-more:${targetId}`,
    },
  });
  setIcon(moreBtn, "more-horizontal");
  moreBtn.addEventListener("click", (ev: MouseEvent) => {
    host.openAgentMenu(ev, agent, targetId, state.activeSessionName);
  });

  const liveSub =
    paneMeta?.terminal_title_stripped?.trim() ||
    paneMeta?.terminal_title?.trim() ||
    shortenPathTail(agent.cwd || paneMeta?.cwd, 52);
  const subEl = row.createDiv({ cls: "herdr-mc-agent-sub", text: liveSub });
  if (!liveSub) {
    subEl.addClass("herdr-is-hidden");
  }
  host.renderedAgentSubs.set(targetId, subEl);

  const promptRow = row.createDiv({ cls: "herdr-mc-agent-prompt" });
  const input = promptRow.createEl("textarea", {
    cls: "herdr-prompt-input",
    placeholder: `Message ${label}... (Enter to send, Shift+Enter for newline)`,
    attr: {
      rows: "1",
      "aria-label": `Message ${label}`,
      "data-agent-target": targetId,
    },
  });
  host.renderedPromptInputs.set(targetId, input);

  const existingDraft =
    host.promptDrafts.get(targetId) ??
    (host.getSelectedAgentKey() === targetId ? host.getPromptDraft() : "");
  if (existingDraft) {
    input.value = existingDraft;
    autoSizeTextarea(input);
  }
  input.addEventListener("input", () => {
    host.setSelectedAgentKey(targetId);
    host.setPromptDraft(input.value);
    if (input.value) {
      host.promptDrafts.set(targetId, input.value);
    } else {
      host.promptDrafts.delete(targetId);
    }
    autoSizeTextarea(input);
  });

  const noteBtn = promptRow.createEl("button", {
    cls: "clickable-icon herdr-mc-icon-action",
    attr: {
      "aria-label": `Send active note to ${label}`,
      title: "Send active note or selection",
      type: "button",
    },
  });
  setIcon(noteBtn, "paperclip");
  noteBtn.addEventListener("click", () => {
    new DispatchNoteModal(host.app, host.coordinator, targetId).open();
  });

  const isSending = host.sendingPromptTargets.has(targetId);
  const sendBtn = promptRow.createEl("button", {
    text: isSending ? "Sending..." : "Send",
    cls: "mod-cta herdr-btn-compact",
    attr: { type: "button" },
  });
  sendBtn.disabled = isSending;
  input.disabled = isSending;

  const submitPrompt = async (): Promise<void> => {
    const val = input.value.trim();
    if (!val || host.sendingPromptTargets.has(targetId)) {
      return;
    }
    const originalDraft = input.value;
    host.sendingPromptTargets.add(targetId);
    sendBtn.disabled = true;
    sendBtn.setText("Sending...");
    input.disabled = true;
    try {
      const ok = await host.promptSingleAgent(targetId, val);
      if (ok) {
        if (input.isConnected) {
          input.value = "";
          autoSizeTextarea(input);
        }
      } else {
        host.promptDrafts.set(targetId, originalDraft);
        if (host.getSelectedAgentKey() === targetId) {
          host.setPromptDraft(originalDraft);
        }
        if (input.isConnected) {
          input.value = originalDraft;
          autoSizeTextarea(input);
        }
      }
    } finally {
      host.sendingPromptTargets.delete(targetId);
      if (sendBtn.isConnected) {
        sendBtn.disabled = false;
        sendBtn.setText("Send");
      }
      if (input.isConnected) {
        input.disabled = false;
      }
      if (!sendBtn.isConnected || !input.isConnected) {
        host.renderDashboard();
      }
    }
  };
  sendBtn.addEventListener("click", () => {
    void submitPrompt();
  });
  input.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void submitPrompt();
    }
  });
}

function renderLiveTailDrawer(host: DashboardTabHost, parent: HTMLElement): void {
  const targetLabel = host.getLiveTailTarget();
  if (!targetLabel) {
    return;
  }
  const tailSection = parent.createDiv({ cls: "herdr-mc-section herdr-mc-tail-drawer" });
  const head = tailSection.createDiv({ cls: "herdr-card-header" });
  head.createSpan({
    cls: "herdr-mc-section-title",
    text: targetLabel,
  });
  const tailActions = head.createDiv({ cls: "herdr-mc-actions" });
  const agentId = host.getLiveTailAgentId();
  if (agentId) {
    const refreshBtn = tailActions.createEl("button", {
      text: "Refresh",
      cls: "herdr-btn-compact",
      attr: { type: "button" },
    });
    refreshBtn.addEventListener("click", () => {
      void host.loadAgentTail(agentId);
    });
  }
  const copyBtn = tailActions.createEl("button", {
    text: "Copy",
    cls: "herdr-btn-compact",
    attr: { type: "button" },
  });
  copyBtn.addEventListener("click", () => {
    void navigator.clipboard.writeText(host.getLiveTailText()).catch((err: unknown) => {
      console.warn("[herdr-obs] Clipboard write failed:", err);
    });
    new Notice("Copied output to clipboard.");
  });
  const closeBtn = tailActions.createEl("button", {
    text: "Close",
    cls: "herdr-btn-compact",
    attr: { type: "button" },
  });
  closeBtn.addEventListener("click", () => {
    host.clearLiveTail();
    host.renderDashboard();
  });

  const pre = tailSection.createEl("pre", { cls: "herdr-terminal-tail" });
  pre.setText(host.getLiveTailText() || "(empty terminal output)");
  if (host.consumeLiveTailAutoScroll()) {
    if (typeof pre.scrollHeight === "number") {
      pre.scrollTop = pre.scrollHeight;
    }
    tailSection.scrollIntoView?.({ block: "nearest" });
  }
}

function renderWorktreesSection(
  host: DashboardTabHost,
  parent: HTMLElement,
  state: CoordinatorState
): void {
  if (state.worktrees.length === 0) {
    return;
  }
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
        void host.coordinator.socket
          .openWorktree({
            path: wt.path,
            branch: wt.branch || undefined,
            focus: true,
          })
          .then(() => host.coordinator.refreshAll(true))
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
        const wtLabel = wt.branch || wt.label || wt.path;
        void confirmAction(host.app, {
          title: `Remove worktree '${wtLabel}'?`,
          body: `This will remove the linked Git worktree at ${wt.path} and close its Herdr workspace.`,
          confirmText: "Remove worktree",
          danger: true,
        })
          .then((confirmed) => {
            if (!confirmed) {
              return;
            }
            return host.coordinator.socket
              .removeWorktree(openWsId, false)
              .then(() => host.coordinator.refreshAll(true));
          })
          .catch((err: unknown) => {
            new Notice(err instanceof Error ? err.message : String(err));
          });
      });
    }
  }
}
