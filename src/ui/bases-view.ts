import { BasesView, Notice, type QueryController, type TFile } from "obsidian";
import type { HerdrCoordinator } from "../services/herdr-coordinator";

export const VIEW_TYPE_HERDR_BASES = "herdr-agent-board";

const MAX_BOARD_CARDS = 120;
const MAX_DISPATCH_CHARS = 8000;

export class HerdrBasesView extends BasesView {
  readonly type = VIEW_TYPE_HERDR_BASES;
  private readonly rootEl: HTMLElement;
  private readonly coordinator: HerdrCoordinator;
  private readonly openTerminal: () => Promise<void>;
  private unsubCoord: (() => void) | null = null;
  private lastAgentSignature = "";

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
      if (!this.data?.groupedData) {
        return;
      }
      const nextSignature = this.computeAgentSignature();
      if (nextSignature !== this.lastAgentSignature) {
        this.onDataUpdated();
      }
    });
  }

  override onunload(): void {
    this.unsubCoord?.();
    this.unsubCoord = null;
    this.rootEl.empty();
    super.onunload();
  }

  private computeAgentSignature(): string {
    const state = this.coordinator.getState();
    const agents = state.snapshot?.agents ?? [];
    const agentPart = agents
      .map((a) => `${a.pane_id}:${a.name || ""}:${a.agent || ""}:${a.agent_status}`)
      .join("|");
    return `${state.serverRunning ? "1" : "0"}|${agentPart}`;
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
    this.lastAgentSignature = this.computeAgentSignature();

    const bar = this.rootEl.createDiv({ cls: "herdr-bases-header" });
    bar.createSpan({
      cls: "herdr-card-title",
      text: `Herdr task board (${totalCount} matching notes)`,
    });

    const termBtn = bar.createEl("button", {
      text: "Open Herdr terminal",
      cls: "herdr-btn-compact",
      attr: { type: "button" },
    });
    termBtn.addEventListener("click", () => {
      void this.openTerminal().catch((err: unknown) => {
        new Notice(err instanceof Error ? err.message : String(err));
      });
    });

    if (totalCount === 0) {
      this.rootEl.createDiv({
        cls: "herdr-empty-card",
        text: "No vault notes match this Base filter.",
      });
      return;
    }

    const hasNamedGroups = groups.some((g) => g.hasKey() || Boolean(g.key));
    let renderedCount = 0;

    for (const group of groups) {
      if (renderedCount >= MAX_BOARD_CARDS) {
        break;
      }
      if (group.entries.length === 0) {
        continue;
      }

      if (hasNamedGroups) {
        const rawKey = group.hasKey() && group.key ? group.key.toString().trim() : "";
        const groupLabel = rawKey || "Ungrouped";
        this.rootEl.createDiv({
          cls: "herdr-mc-section-title",
          text: `${groupLabel} (${group.entries.length})`,
        });
      }

      const boardGrid = this.rootEl.createDiv({ cls: "herdr-bases-grid" });
      const remaining = MAX_BOARD_CARDS - renderedCount;
      const slice = group.entries.slice(0, remaining);
      renderedCount += slice.length;

      for (const entry of slice) {
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
          attr: { type: "button" },
        });
        linkBtn.addEventListener("click", () => {
          void this.app.workspace
            .getLeaf("tab")
            .openFile(file)
            .catch((err: unknown) => {
              new Notice(err instanceof Error ? err.message : String(err));
            });
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
            attr: { type: "button" },
          });
          dispatchBtn.disabled = !state.serverRunning;
          dispatchBtn.addEventListener("click", () => {
            void this.dispatchFileToAgent(file, targetAgent).catch((err: unknown) => {
              new Notice(err instanceof Error ? err.message : String(err));
            });
          });
        }
      }
    }

    if (totalCount > MAX_BOARD_CARDS) {
      this.rootEl.createDiv({
        cls: "herdr-mc-hint",
        text: `Showing first ${MAX_BOARD_CARDS} of ${totalCount} matching notes. Refine the Base filter to view remaining cards.`,
      });
    }
  }

  private async dispatchFileToAgent(file: TFile, agentTarget: string): Promise<void> {
    try {
      const content = await this.app.vault.cachedRead(file);
      const isTruncated = content.length > MAX_DISPATCH_CHARS;
      const clipped = isTruncated
        ? `${content.slice(0, MAX_DISPATCH_CHARS)}\n\n[Truncated: showing first ${MAX_DISPATCH_CHARS} of ${content.length} characters. Use obs-herdr to read the full note.]`
        : content;
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
