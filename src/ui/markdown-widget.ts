import { MarkdownRenderChild, Notice } from "obsidian";
import type { HerdrCoordinator } from "../services/herdr-coordinator";

interface ParsedHerdrBlock {
  session?: string;
  agent?: string;
  prompt?: string;
  command?: string;
  title?: string;
}

function parseBlockConfig(source: string): ParsedHerdrBlock {
  const cfg: ParsedHerdrBlock = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key === "session") {
      cfg.session = val;
    } else if (key === "agent") {
      cfg.agent = val;
    } else if (key === "prompt") {
      cfg.prompt = val;
    } else if (key === "command") {
      cfg.command = val;
    } else if (key === "title") {
      cfg.title = val;
    }
  }
  return cfg;
}

export class HerdrCodeblockWidget extends MarkdownRenderChild {
  private readonly source: string;
  private readonly coordinator: HerdrCoordinator;
  private readonly openMissionControl: () => Promise<void>;
  private readonly openTerminal: (sessionName?: string) => Promise<void>;
  private readonly runInTerminal?: (
    commandText: string,
    sessionName?: string
  ) => Promise<void>;
  private unsub: (() => void) | null = null;

  constructor(options: {
    containerEl: HTMLElement;
    source: string;
    coordinator: HerdrCoordinator;
    openMissionControl: () => Promise<void>;
    openTerminal: (sessionName?: string) => Promise<void>;
    runInTerminal?: (commandText: string, sessionName?: string) => Promise<void>;
  }) {
    super(options.containerEl);
    this.source = options.source;
    this.coordinator = options.coordinator;
    this.openMissionControl = options.openMissionControl;
    this.openTerminal = options.openTerminal;
    this.runInTerminal = options.runInTerminal;
  }

  onload(): void {
    this.render();
    this.unsub = this.coordinator.onChange(() => {
      this.render();
    });
  }

  onunload(): void {
    this.unsub?.();
    this.unsub = null;
    this.containerEl.empty();
  }

  private render(): void {
    const el = this.containerEl;
    el.empty();
    el.addClass("herdr-root", "herdr-embed-card");

    const cfg = parseBlockConfig(this.source);
    const state = this.coordinator.getState();
    const snap = state.snapshot;
    const agents = snap?.agents ?? [];

    const header = el.createDiv({ cls: "herdr-card-header" });
    header.createSpan({
      cls: "herdr-card-title",
      text: cfg.title || `Herdr runtime (${cfg.session || state.activeSessionName})`,
    });
    header.createSpan({
      cls: `herdr-status-pill ${state.serverRunning ? "herdr-status-working" : "herdr-status-idle"}`,
      text: state.serverRunning
        ? `${agents.length} ${agents.length === 1 ? "agent" : "agents"} live`
        : state.usingOfflinePreview
          ? "Preview"
          : "Stopped",
    });

    if (agents.length > 0) {
      const strip = el.createDiv({ cls: "herdr-embed-agents" });
      for (const ag of agents.slice(0, 6)) {
        const badge = strip.createDiv({ cls: "herdr-embed-agent-chip" });
        badge.createSpan({
          text: ag.display_agent || ag.name || ag.agent || ag.pane_id,
        });
        badge.createSpan({
          cls: `herdr-status-pill herdr-status-${ag.agent_status}`,
          text: ag.agent_status,
        });
      }
    }

    if (cfg.prompt || cfg.command) {
      el.createDiv({
        cls: "herdr-muted-copy",
        text: cfg.prompt ? `Task prompt: ${cfg.prompt}` : `Command: ${cfg.command}`,
      });
    }

    const actions = el.createDiv({ cls: "herdr-action-row" });

    const termBtn = actions.createEl("button", {
      text: "Open terminal",
      cls: "mod-cta herdr-btn-compact",
    });
    termBtn.addEventListener("click", () => {
      void this.openTerminal(cfg.session);
    });

    const dashBtn = actions.createEl("button", {
      text: "Mission Control",
      cls: "herdr-btn-compact",
    });
    dashBtn.addEventListener("click", () => {
      void this.openMissionControl();
    });

    if (cfg.prompt && cfg.agent) {
      const runBtn = actions.createEl("button", {
        text: `Prompt ${cfg.agent}`,
        cls: "herdr-btn-compact",
      });
      runBtn.disabled = !state.serverRunning;
      runBtn.addEventListener("click", () => {
        void this.coordinator.socket
          .promptAgent(cfg.agent as string, cfg.prompt as string)
          .then(() => {
            new Notice(`Sent playbook prompt to '${cfg.agent}'.`);
          })
          .catch((err: unknown) => {
            new Notice(err instanceof Error ? err.message : String(err));
          });
      });
    }

    if (cfg.command) {
      const cmdBtn = actions.createEl("button", {
        text: "Run command",
        cls: "herdr-btn-compact",
      });
      cmdBtn.addEventListener("click", () => {
        const commandText = cfg.command as string;
        const targetPaneId =
          state.serverRunning && snap
            ? snap.focused_pane_id || snap.panes[0]?.pane_id
            : undefined;
        if (targetPaneId) {
          void this.coordinator.socket
            .sendPaneText(targetPaneId, `${commandText}\n`)
            .then(() => {
              new Notice(`Sent command to Herdr pane '${targetPaneId}'.`);
            })
            .catch((err: unknown) => {
              new Notice(err instanceof Error ? err.message : String(err));
            });
          return;
        }
        if (this.runInTerminal) {
          void this.runInTerminal(commandText, cfg.session);
        } else {
          void this.openTerminal(cfg.session);
        }
      });
    }
  }
}
