import { BasesView, Notice, type QueryController, type TFile } from "obsidian";
import type { HerdrCoordinator } from "../services/herdr-coordinator";

export const VIEW_TYPE_HERDR_BASES = "herdr-agent-board";

export class HerdrBasesView extends BasesView {
  readonly type = VIEW_TYPE_HERDR_BASES;
  private readonly rootEl: HTMLElement;
  private readonly coordinator: HerdrCoordinator;
  private readonly openTerminal: () => Promise<void>;
  private unsubCoord: (() => void) | null = null;

  constructor(
    controller: QueryController,
    containerEl: HTMLElement,
    coordinator: HerdrCoordinator,
    openTerminal: () => Promise<void>
  ) {
    super(controller);
    this.coordinator = coordinator;
    this.openTerminal = openTerminal;
    this.rootEl = containerEl.createDiv({ cls: "herdr-root herdr-bases-board" });
  }

  override onload(): void {
    super.onload();
    this.unsubCoord = this.coordinator.onChange(() => {
      if (this.data?.groupedData) {
        this.onDataUpdated();
      }
    });
  }

  override onunload(): void {
    this.unsubCoord?.();
    this.unsubCoord = null;
    super.onunload();
  }

  onDataUpdated(): void {
    this.rootEl.empty();
    if (!this.data?.groupedData) {
      return;
    }

    const groups = this.data.groupedData;
    const totalCount = groups.reduce((acc, g) => acc + g.entries.length, 0);
    const state = this.coordinator.getState();
    const liveAgents = state.snapshot?.agents ?? [];

    const bar = this.rootEl.createDiv({ cls: "herdr-bases-header" });
    bar.createSpan({
      cls: "herdr-card-title",
      text: `Herdr task board (${totalCount} matching notes)`,
    });

    const termBtn = bar.createEl("button", {
      text: "Open Herdr terminal",
      cls: "herdr-btn-compact",
    });
    termBtn.addEventListener("click", () => {
      void this.openTerminal();
    });

    if (totalCount === 0) {
      this.rootEl.createDiv({
        cls: "herdr-empty-card",
        text: "No vault notes match this Base filter.",
      });
      return;
    }

    const boardGrid = this.rootEl.createDiv({ cls: "herdr-bases-grid" });
    for (const group of groups) {
      for (const entry of group.entries.slice(0, 120)) {
        const file = entry.file;
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter ?? {};
        const assignedAgent =
          typeof fm.agent === "string" && fm.agent.trim() ? fm.agent.trim() : "";
        const noteStatus =
          typeof fm.status === "string" && fm.status.trim() ? fm.status.trim() : "backlog";

        const card = boardGrid.createDiv({ cls: "herdr-bases-card" });
        const top = card.createDiv({ cls: "herdr-card-header" });
        const linkBtn = top.createEl("button", {
          text: file.basename,
          cls: "herdr-note-link-btn",
        });
        linkBtn.addEventListener("click", () => {
          void this.app.workspace.getLeaf(false).openFile(file);
        });

        top.createSpan({
          cls: "herdr-mono-badge",
          text: noteStatus,
        });

        const matchedLive = assignedAgent
          ? liveAgents.find(
              (a) =>
                a.name === assignedAgent ||
                a.pane_id === assignedAgent ||
                a.agent === assignedAgent
            )
          : undefined;
        if (matchedLive) {
          top.createSpan({
            cls: `herdr-status-pill herdr-status-${matchedLive.agent_status}`,
            text: `${matchedLive.name || matchedLive.pane_id}: ${matchedLive.agent_status}`,
          });
        }

        card.createDiv({ cls: "herdr-muted-copy", text: file.path });

        const targetAgent =
          assignedAgent || liveAgents[0]?.name || liveAgents[0]?.pane_id || "";

        const row = card.createDiv({ cls: "herdr-action-row" });
        if (targetAgent) {
          const dispatchBtn = row.createEl("button", {
            text: `Dispatch to ${targetAgent}`,
            cls: "mod-cta herdr-btn-compact",
          });
          dispatchBtn.disabled = !state.serverRunning;
          dispatchBtn.addEventListener("click", () => {
            void this.dispatchFileToAgent(file, targetAgent);
          });
        }
      }
    }
  }

  private async dispatchFileToAgent(file: TFile, agentTarget: string): Promise<void> {
    try {
      const content = await this.app.vault.cachedRead(file);
      const clipped = content.length > 8000 ? content.slice(0, 8000) : content;
      const prompt = [
        `Work on Obsidian vault note '${file.path}' (use obs-herdr to read/update notes):`,
        "",
        clipped,
      ].join("\n");
      await this.coordinator.socket.promptAgent(agentTarget, prompt);
      new Notice(`Dispatched '${file.basename}' to Herdr agent '${agentTarget}'.`);
    } catch (err) {
      new Notice(`Dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
