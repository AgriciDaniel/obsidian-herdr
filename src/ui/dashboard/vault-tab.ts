import { Notice, TFile } from "obsidian";
import type { VaultPermissionMode } from "../../domain/types";
import type { CoordinatorState } from "../../services/herdr-coordinator";
import { confirmAction } from "../modals";
import {
  VAULT_TIERS,
  addKvRow,
  isEditActivity,
  wireRovingKeyboardNav,
  type DashboardTabHost,
} from "./types";

export function renderVaultTab(
  host: DashboardTabHost,
  parent: HTMLElement,
  state: CoordinatorState
): void {
  const settings = host.getSettings();
  const allEntries = host.coordinator.vaultOps.getAuditLog();
  const editCount = allEntries.filter(isEditActivity).length;

  const summaryBar = parent.createDiv({ cls: "herdr-mc-vault-chips" });
  summaryBar.createSpan({
    cls: `herdr-mc-stat-chip ${state.bridgeRunning ? "is-live" : "is-muted"}`,
    text: state.bridgeRunning ? "Bridge live" : "Bridge off",
  });
  summaryBar.createSpan({
    cls: `herdr-mc-stat-chip ${settings.allowUiControl ? "is-accent" : "is-muted"}`,
    text: settings.allowUiControl ? "UI control on" : "UI control off",
  });
  summaryBar.createSpan({
    cls: "herdr-mc-stat-chip",
    text: `${editCount} ${editCount === 1 ? "edit" : "edits"}`,
  });

  const accessSection = parent.createDiv({ cls: "herdr-mc-section herdr-mc-halftone-card" });
  accessSection.createDiv({
    cls: "herdr-mc-section-title",
    text: state.bridgeRunning ? "Vault access: active" : "Vault access: off",
  });

  const currentMode: VaultPermissionMode = state.bridgeRunning
    ? settings.vaultPermissionMode
    : "off";

  const seg = accessSection.createDiv({
    cls: "herdr-mc-segmented",
    attr: { role: "radiogroup", "aria-label": "Vault permission level" },
  });
  const radioBtns: HTMLButtonElement[] = [];
  for (const tier of VAULT_TIERS) {
    const isChecked = currentMode === tier.id;
    const btn = seg.createEl("button", {
      text: tier.label,
      cls: isChecked ? "is-active" : "",
      attr: {
        type: "button",
        role: "radio",
        "aria-checked": isChecked ? "true" : "false",
        tabindex: isChecked ? "0" : "-1",
        "data-herdr-focus-id": `vault-tier:${tier.id}`,
      },
    });
    btn.addEventListener("click", () => {
      void host
        .updateSettings({
          vaultBridgeEnabled: tier.id !== "off",
          vaultPermissionMode: tier.id,
        })
        .catch((err: unknown) => {
          new Notice(err instanceof Error ? err.message : String(err));
        });
    });
    radioBtns.push(btn);
  }
  wireRovingKeyboardNav(radioBtns);

  const activeTier = VAULT_TIERS.find((t) => t.id === currentMode) ?? VAULT_TIERS[0];
  accessSection.createDiv({
    cls: "herdr-mc-hint",
    text: activeTier.description,
  });

  const quickBar = accessSection.createDiv({ cls: "herdr-action-row" });
  const copyMcpQuick = quickBar.createEl("button", {
    text: "Copy MCP config",
    cls: "herdr-btn-compact",
    attr: { type: "button" },
  });
  copyMcpQuick.addEventListener("click", () => {
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

  const copyCliQuick = quickBar.createEl("button", {
    text: "Copy CLI path",
    cls: "herdr-btn-compact",
    attr: { type: "button" },
  });
  copyCliQuick.addEventListener("click", () => {
    void navigator.clipboard.writeText(state.cliScriptPath).catch((err: unknown) => {
      console.warn("[herdr-obs] Clipboard write failed:", err);
    });
    new Notice("Copied obs-herdr CLI path to clipboard.");
  });

  const testQuick = quickBar.createEl("button", {
    text: "Run self-test",
    cls: "herdr-btn-compact",
    attr: { type: "button" },
  });
  testQuick.addEventListener("click", () => {
    void host.runBridgeSelfTest();
  });

  // Activity list
  const activitySection = parent.createDiv({ cls: "herdr-mc-section" });
  const actHead = activitySection.createDiv({ cls: "herdr-card-header" });
  actHead.createSpan({ cls: "herdr-mc-section-title", text: "Activity" });

  const filterRow = actHead.createDiv({ cls: "herdr-mc-log-filter" });
  const toggleBtn = filterRow.createEl("button", {
    text: host.getShowAllActivity() ? "Edits only" : "Show all activity",
    cls: "herdr-btn-compact",
    attr: { type: "button" },
  });
  toggleBtn.addEventListener("click", () => {
    host.setShowAllActivity(!host.getShowAllActivity());
    host.renderDashboard();
  });

  if (allEntries.length > 0) {
    const clearBtn = filterRow.createEl("button", {
      text: "Clear log",
      cls: "herdr-btn-compact",
      attr: { type: "button", "data-herdr-focus-id": "vault-clear-log" },
    });
    clearBtn.addEventListener("click", () => {
      const undoableCount = allEntries.filter((e) => Boolean(e.snapshot) && !e.undone).length;
      if (undoableCount > 0) {
        void confirmAction(host.app, {
          title: "Clear activity log?",
          body: `Clearing the log discards ${undoableCount} reversible undo ${undoableCount === 1 ? "snapshot" : "snapshots"} from this session.`,
          confirmText: "Clear log",
          danger: true,
        }).then((ok) => {
          if (ok) {
            host.coordinator.vaultOps.clearAuditLog();
          }
        });
      } else {
        host.coordinator.vaultOps.clearAuditLog();
      }
    });
  }

  const visibleEntries = host.getShowAllActivity()
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
    const MAX_RENDERED_LOG_ROWS = 40;
    const list = activitySection.createDiv({ cls: "herdr-mc-log" });
    for (const item of visibleEntries.slice(0, MAX_RENDERED_LOG_ROWS)) {
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
      const af = item.targetPath ? host.app.vault.getAbstractFileByPath(item.targetPath) : null;
      if (af instanceof TFile) {
        const summaryBtn = row.createEl("button", {
          cls: "herdr-mc-log-text herdr-mc-log-link",
          text: item.summary,
          attr: { type: "button", title: `Open ${item.targetPath}` },
        });
        summaryBtn.addEventListener("click", () => {
          void host.app.workspace
            .getLeaf("tab")
            .openFile(af)
            .catch((err: unknown) => {
              new Notice(err instanceof Error ? err.message : String(err));
            });
        });
      } else {
        row.createSpan({
          cls: "herdr-mc-log-text",
          text: item.summary,
        });
      }
      if (item.snapshot && !item.undone) {
        const undoBtn = row.createEl("button", {
          text: "Undo",
          cls: "herdr-mc-log-undo",
          attr: {
            type: "button",
            "aria-label": `Undo: ${item.summary}`,
            "data-herdr-focus-id": `vault-undo:${item.id}`,
          },
        });
        let undoing = false;
        undoBtn.addEventListener("click", () => {
          if (undoing) {
            return;
          }
          undoing = true;
          undoBtn.disabled = true;
          undoBtn.setText("Undoing...");
          void host.coordinator.vaultOps
            .undoMutation(item.id)
            .then((msg) => {
              new Notice(msg);
            })
            .catch((err: unknown) => {
              undoing = false;
              if (undoBtn.isConnected) {
                undoBtn.disabled = false;
                undoBtn.setText("Undo");
              }
              new Notice(err instanceof Error ? err.message : String(err));
            });
        });
      } else if (item.undone) {
        row.createSpan({ cls: "herdr-mc-hint", text: "Undone" });
      }
    }
    if (visibleEntries.length > MAX_RENDERED_LOG_ROWS) {
      activitySection.createDiv({
        cls: "herdr-mc-hint",
        text: `Showing latest ${MAX_RENDERED_LOG_ROWS} of ${visibleEntries.length} recorded entries.`,
      });
    }
  }

  // Connection details (collapsed)
  const details = host.createTrackedDetails(parent, "vault-connection-details");
  details.createEl("summary", { text: "Connection details" });

  const kv = details.createDiv({ cls: "herdr-mc-kv" });
  addKvRow(kv, "Socket", state.bridgeSocketPath);
  addKvRow(kv, "CLI script", state.cliScriptPath);
  addKvRow(kv, "Plugin manifest", state.herdrPluginManifestPath);

  if (state.serverRunning) {
    const actions = details.createDiv({ cls: "herdr-action-row" });
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
        ? host.coordinator.unlinkObsidianHerdrPlugin()
        : host.coordinator.linkObsidianHerdrPlugin()
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
