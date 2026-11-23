import { Notice } from "obsidian";
import type { CoordinatorState } from "../../services/herdr-coordinator";
import { DOCTOR_CLI_RUNTIMES, addKvRow, type DashboardTabHost } from "./types";

const SPAWNABLE_RUNTIMES = new Set<string>(DOCTOR_CLI_RUNTIMES);

export function renderDoctorTab(
  host: DashboardTabHost,
  parent: HTMLElement,
  state: CoordinatorState
): void {
  if (state.protocolWarning) {
    const warn = parent.createDiv({
      cls: "herdr-mc-attention",
      attr: { role: "alert" },
    });
    warn.createEl("strong", { text: "Herdr protocol warning: " });
    warn.createSpan({ text: state.protocolWarning });
  }

  if (state.statusPayload?.server?.restart_needed) {
    const restartWarn = parent.createDiv({
      cls: "herdr-mc-attention",
      attr: { role: "alert" },
    });
    restartWarn.createEl("strong", { text: "Herdr server restart recommended: " });
    restartWarn.createSpan({
      text: "The running daemon is older than the installed CLI. Run `herdr update --handoff` to upgrade without losing panes.",
    });
  }

  const diagSection = parent.createDiv({ cls: "herdr-mc-section herdr-mc-halftone-card" });
  diagSection.createDiv({ cls: "herdr-mc-section-title", text: "Diagnostics" });

  const kv = diagSection.createDiv({ cls: "herdr-mc-kv" });
  addKvRow(kv, "Herdr binary", state.binaryPath || "Not found on PATH");
  addKvRow(
    kv,
    "Version",
    state.statusPayload?.client?.version
      ? `${state.statusPayload.client.version} (protocol ${state.statusPayload.client.protocol ?? "?"})`
      : "No data"
  );
  addKvRow(kv, "Session", state.activeSessionName);
  addKvRow(kv, "Socket", state.socketPath);
  addKvRow(kv, "Live updates", state.socketSubscribed ? "Connected" : "Disconnected");
  if (state.lastError) {
    addKvRow(kv, "Last error", state.lastError);
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
        void host.openTerminalLeaf({ sessionName: s.name }).catch((err: unknown) => {
          new Notice(err instanceof Error ? err.message : String(err));
        });
      });
    }

    if (stoppedSessions.length > 0) {
      const stoppedDetails = host.createTrackedDetails(
        sessionsSection,
        "doctor-stopped-sessions"
      );
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

  // Interactive detected CLI runtimes (asynchronous, cached for 60s)
  const cliSection = parent.createDiv({ cls: "herdr-mc-section" });
  cliSection.createDiv({ cls: "herdr-mc-section-title", text: "Detected runtimes" });
  const cliGrid = cliSection.createDiv({ cls: "herdr-integration-grid" });
  const cliChecks = host.getCachedCliChecks(state);
  for (const check of cliChecks) {
    const canQuickSpawn =
      Boolean(state.binaryPath) &&
      check.status === "ready" &&
      SPAWNABLE_RUNTIMES.has(check.label);
    if (canQuickSpawn) {
      const btn = cliGrid.createEl("button", {
        cls: "herdr-integration-item is-spawnable",
        attr: {
          type: "button",
          "aria-label": `Spawn ${check.label} agent`,
          title: check.detail
            ? `Click to spawn ${check.label} (${check.detail})`
            : `Click to spawn ${check.label}`,
          "data-herdr-focus-id": `doctor-runtime:${check.label}`,
        },
      });
      const left = btn.createSpan({ cls: "herdr-mc-runtime-label" });
      left.createSpan({ cls: "herdr-mc-runtime-cue", text: "+", attr: { "aria-hidden": "true" } });
      left.createSpan({ text: check.label });
      btn.createSpan({ cls: "herdr-mc-pill is-done", text: check.status });
      btn.addEventListener("click", () => {
        host.openSpawnModal(check.label, true);
      });
    } else {
      const pill = cliGrid.createDiv({
        cls: "herdr-integration-item",
        attr: check.detail ? { title: check.detail } : {},
      });
      pill.createSpan({ text: check.label });
      pill.createSpan({
        cls: `herdr-mc-pill ${check.status === "ready" ? "is-done" : "is-idle"}`,
        text: check.status,
      });
    }
  }

  // Optional hooks (collapsed)
  const hookDetails = host.createTrackedDetails(parent, "doctor-optional-hooks");
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
