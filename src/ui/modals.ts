import { type App, Modal, Notice, Setting } from "obsidian";
import type {
  SplitDirection,
  TerminalProfile,
  TerminalProfileKind,
} from "../domain/types";
import type { HerdrCoordinator } from "../services/herdr-coordinator";

export class SpawnAgentModal extends Modal {
  private readonly coordinator: HerdrCoordinator;
  private readonly onSpawned?: () => void;
  private agentName: string;
  private nameEditedManually = false;
  private agentKind: string;
  private direction: SplitDirection = "right";
  private attachVaultMcp = true;
  private initialPrompt = "";
  private submitting = false;

  constructor(app: App, coordinator: HerdrCoordinator, defaultKind: string, onSpawned?: () => void) {
    super(app);
    this.coordinator = coordinator;
    this.agentKind = defaultKind || "codex";
    this.agentName = this.suggestUniqueHandle(this.agentKind);
    this.onSpawned = onSpawned;
  }

  private suggestUniqueHandle(baseKind: string): string {
    const cleanBase = baseKind.replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "assistant";
    const existing = new Set(
      (this.coordinator.getState().snapshot?.agents ?? [])
        .map((a) => (a.name || "").toLowerCase())
        .filter(Boolean)
    );
    if (!existing.has(cleanBase)) {
      return cleanBase;
    }
    for (let idx = 2; idx <= 99; idx += 1) {
      const candidate = `${cleanBase}-${idx}`;
      if (!existing.has(candidate)) {
        return candidate;
      }
    }
    return `${cleanBase}-${Date.now().toString(36).slice(-4)}`;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("herdr-modal");

    new Setting(contentEl).setName("Spawn coding agent in Herdr").setHeading();

    let nameInputEl: HTMLInputElement | null = null;

    new Setting(contentEl)
      .setName("Agent handle")
      .setDesc("Unique lowercase name using letters, digits, underscores, or hyphens.")
      .addText((text) => {
        nameInputEl = text.inputEl;
        text.setValue(this.agentName).onChange((value) => {
          this.nameEditedManually = true;
          this.agentName = value.trim().toLowerCase();
        });
      });

    new Setting(contentEl)
      .setName("Agent runtime")
      .setDesc("Supported CLI agent installed on this machine.")
      .addDropdown((dd) =>
        dd
          .addOption("claude", "Claude Code")
          .addOption("codex", "Codex")
          .addOption("agy", "Antigravity")
          .addOption("gemini", "Gemini")
          .addOption("opencode", "OpenCode")
          .addOption("cursor", "Cursor CLI")
          .addOption("copilot", "GitHub Copilot CLI")
          .addOption("grok", "Grok")
          .addOption("pi", "Pi")
          .setValue(this.agentKind)
          .onChange((val) => {
            this.agentKind = val;
            if (!this.nameEditedManually) {
              this.agentName = this.suggestUniqueHandle(val);
              if (nameInputEl) {
                nameInputEl.value = this.agentName;
              }
            }
          })
      );

    new Setting(contentEl)
      .setName("Split direction")
      .setDesc("Split the active Herdr pane right or down.")
      .addDropdown((dd) =>
        dd
          .addOption("right", "Split right")
          .addOption("down", "Split down")
          .setValue(this.direction)
          .onChange((val) => {
            this.direction = val === "down" ? "down" : "right";
          })
      );

    new Setting(contentEl)
      .setName("Attach live vault MCP tools")
      .setDesc(
        "Auto-register the 16-tool vault stdio MCP server when launching Codex or Claude Code."
      )
      .addToggle((tog) =>
        tog.setValue(this.attachVaultMcp).onChange((val) => {
          this.attachVaultMcp = val;
        })
      );

    new Setting(contentEl)
      .setClass("herdr-modal-stacked-setting")
      .setName("Initial prompt (optional)")
      .setDesc("Sent once Herdr confirms the agent is ready for interactive input.")
      .addTextArea((area) => {
        area
          .setPlaceholder("Inspect the active note with obs-herdr and summarize open action items.")
          .setValue(this.initialPrompt)
          .onChange((val) => {
            this.initialPrompt = val;
          });
        area.inputEl.rows = 3;
      });

    let spawnBtnEl: HTMLButtonElement | null = null;
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          if (!this.submitting) {
            this.close();
          }
        })
      )
      .addButton((btn) => {
        spawnBtnEl = btn.buttonEl;
        btn
          .setButtonText("Spawn agent")
          .setCta()
          .onClick(() => {
            void this.submit(spawnBtnEl);
          });
      });
  }

  private async submit(spawnBtnEl: HTMLButtonElement | null): Promise<void> {
    if (this.submitting) {
      return;
    }
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(this.agentName)) {
      new Notice("Agent handle must start with a lowercase letter and use only a-z, 0-9, _, or -.");
      return;
    }
    this.submitting = true;
    if (spawnBtnEl) {
      spawnBtnEl.disabled = true;
      spawnBtnEl.setText(`Starting ${this.agentKind}...`);
    }
    try {
      await this.coordinator.splitAndStartAgent({
        agentName: this.agentName,
        agentKind: this.agentKind,
        direction: this.direction,
        attachVaultMcp: this.attachVaultMcp,
        initialPrompt: this.initialPrompt,
      });
      new Notice(`Started Herdr agent '${this.agentName}' (${this.agentKind}).`);
      this.onSpawned?.();
      this.close();
    } catch (err) {
      this.submitting = false;
      if (spawnBtnEl) {
        spawnBtnEl.disabled = false;
        spawnBtnEl.setText("Spawn agent");
      }
      new Notice(`Could not start agent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class CreateWorktreeModal extends Modal {
  private readonly coordinator: HerdrCoordinator;
  private branchName = "";
  private focusAfter = true;

  constructor(app: App, coordinator: HerdrCoordinator) {
    super(app);
    this.coordinator = coordinator;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("herdr-modal");

    new Setting(contentEl).setName("Create Git worktree workspace").setHeading();

    new Setting(contentEl)
      .setName("Branch name")
      .setDesc("Creates or checks out this branch in a linked Herdr workspace.")
      .addText((text) =>
        text
          .setPlaceholder("Enter branch name")
          .setValue(this.branchName)
          .onChange((val) => {
            this.branchName = val.trim();
          })
      );

    new Setting(contentEl)
      .setName("Focus new workspace")
      .addToggle((tog) =>
        tog.setValue(this.focusAfter).onChange((val) => {
          this.focusAfter = val;
        })
      );

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.close();
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Create worktree")
          .setCta()
          .onClick(() => {
            void this.submit();
          })
      );
  }

  private async submit(): Promise<void> {
    if (!this.branchName) {
      new Notice("Enter a Git branch name.");
      return;
    }
    try {
      const vaultRoot = this.coordinator.vaultOps.getVaultBasePath() || undefined;
      await this.coordinator.socket.createWorktree({
        branch: this.branchName,
        cwd: vaultRoot,
        focus: this.focusAfter,
      });
      await this.coordinator.refreshAll(true);
      new Notice(`Opened worktree workspace for '${this.branchName}'.`);
      this.close();
    } catch (err) {
      new Notice(`Worktree creation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class DispatchNoteModal extends Modal {
  private readonly coordinator: HerdrCoordinator;
  private target = "";
  private instruction = "Review this note context and apply requested updates via obs-herdr.";
  private selectionOnly = false;
  private includeBacklinks = true;

  constructor(app: App, coordinator: HerdrCoordinator, defaultTarget = "") {
    super(app);
    this.coordinator = coordinator;
    this.target = defaultTarget;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("herdr-modal");

    new Setting(contentEl).setName("Dispatch vault context to Herdr").setHeading();

    const snap = this.coordinator.getState().snapshot;
    const agents = snap?.agents ?? [];
    const panes = snap?.panes ?? [];

    if (!this.target) {
      this.target =
        agents[0]?.name || agents[0]?.pane_id || panes[0]?.pane_id || "";
    }

    new Setting(contentEl)
      .setName("Target agent or pane")
      .setDesc("Select a live Herdr agent handle or pane ID.")
      .addDropdown((dd) => {
        for (const ag of agents) {
          const id = ag.name || ag.pane_id;
          const label = `${ag.display_agent || ag.name || ag.agent || ag.pane_id} (${ag.agent_status})`;
          dd.addOption(`agent:${id}`, `Agent: ${label}`);
        }
        for (const p of panes) {
          dd.addOption(`pane:${p.pane_id}`, `Pane: ${p.pane_id} (${p.label || p.cwd || "shell"})`);
        }
        if (agents.length === 0 && panes.length === 0) {
          dd.addOption("", "No active Herdr targets found");
        } else {
          const initialKey = agents.length > 0 ? `agent:${this.target}` : `pane:${this.target}`;
          dd.setValue(initialKey);
          this.target = initialKey;
        }
        dd.onChange((val) => {
          this.target = val;
        });
      });

    new Setting(contentEl)
      .setClass("herdr-modal-stacked-setting")
      .setName("Instruction")
      .addTextArea((area) => {
        area
          .setValue(this.instruction)
          .onChange((val) => {
            this.instruction = val;
          });
        area.inputEl.rows = 3;
      });

    new Setting(contentEl)
      .setName("Send current editor selection only")
      .addToggle((tog) =>
        tog.setValue(this.selectionOnly).onChange((val) => {
          this.selectionOnly = val;
        })
      );

    new Setting(contentEl)
      .setName("Include backlinks summary")
      .addToggle((tog) =>
        tog.setValue(this.includeBacklinks).onChange((val) => {
          this.includeBacklinks = val;
        })
      );

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.close();
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Send context")
          .setCta()
          .onClick(() => {
            void this.submit();
          })
      );
  }

  private async submit(): Promise<void> {
    if (!this.target) {
      new Notice("Start a Herdr session or select a target pane first.");
      return;
    }
    try {
      const pack = await this.coordinator.buildActiveNoteContextPack({
        includeSelectionOnly: this.selectionOnly,
        includeBacklinks: this.includeBacklinks,
        customInstruction: this.instruction,
      });

      if (this.target.startsWith("agent:")) {
        const agentTarget = this.target.slice("agent:".length);
        await this.coordinator.socket.promptAgent(agentTarget, pack.payload);
        new Notice(`Dispatched '${pack.title}' to Herdr agent '${agentTarget}'.`);
      } else {
        const paneId = this.target.replace(/^pane:/, "");
        await this.coordinator.socket.sendPaneText(paneId, pack.payload + "\n");
        new Notice(`Sent '${pack.title}' to Herdr pane '${paneId}'.`);
      }
      this.close();
    } catch (err) {
      new Notice(`Context dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class SelectProfileModal extends Modal {
  private readonly profiles: TerminalProfile[];
  private readonly onChoose: (profile: TerminalProfile) => void;

  constructor(app: App, profiles: TerminalProfile[], onChoose: (profile: TerminalProfile) => void) {
    super(app);
    this.profiles = profiles;
    this.onChoose = onChoose;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("herdr-modal");

    new Setting(contentEl).setName("Open terminal profile").setHeading();

    for (const profile of this.profiles) {
      new Setting(contentEl)
        .setName(profile.name)
        .setDesc(`Mode: ${profile.kind} (${profile.cwdMode})`)
        .addButton((btn) =>
          btn
            .setButtonText("Open")
            .setCta()
            .onClick(() => {
              this.onChoose(profile);
              this.close();
            })
        );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class EditProfileModal extends Modal {
  private readonly isNew: boolean;
  private readonly onSave: (profile: TerminalProfile) => void;
  private draft: TerminalProfile;
  private shellArgsRaw: string;

  constructor(
    app: App,
    initial: TerminalProfile | null,
    onSave: (profile: TerminalProfile) => void
  ) {
    super(app);
    this.isNew = !initial;
    this.onSave = onSave;
    this.draft = initial
      ? {
          ...initial,
          shellArgs: initial.shellArgs ? [...initial.shellArgs] : undefined,
        }
      : {
          id: `profile-${Date.now().toString(36)}`,
          name: "Custom profile",
          kind: "shell",
          cwdMode: "vault-root",
        };
    this.shellArgsRaw = (this.draft.shellArgs || []).join(" ");
  }

  onOpen(): void {
    this.renderForm();
  }

  private renderForm(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("herdr-modal");

    new Setting(contentEl)
      .setName(this.isNew ? "Add terminal profile" : "Edit terminal profile")
      .setHeading();

    new Setting(contentEl)
      .setName("Profile name")
      .setDesc("Display label shown in the terminal toolbar and command palette.")
      .addText((text) =>
        text
          .setPlaceholder("Custom profile")
          .setValue(this.draft.name)
          .onChange((val) => {
            this.draft.name = val;
          })
      );

    new Setting(contentEl)
      .setName("Profile mode")
      .setDesc(
        "Choose whether this profile opens a Herdr session, attaches to an agent, connects over SSH, or launches a local shell."
      )
      .addDropdown((dd) =>
        dd
          .addOption("herdr-vault", "Herdr vault session")
          .addOption("herdr-agent", "Herdr agent attach")
          .addOption("herdr-remote", "Herdr remote SSH")
          .addOption("shell", "Interactive shell")
          .setValue(this.draft.kind)
          .onChange((val) => {
            this.draft.kind = val as TerminalProfileKind;
            this.renderForm();
          })
      );

    if (this.draft.kind !== "shell") {
      new Setting(contentEl)
        .setName("Session override")
        .setDesc("Optional named session override (leave blank for vault default).")
        .addText((text) =>
          text
            .setPlaceholder("Default vault session")
            .setValue(this.draft.sessionName || "")
            .onChange((val) => {
              this.draft.sessionName = val.trim() || undefined;
            })
        );
    }

    if (this.draft.kind === "herdr-agent") {
      new Setting(contentEl)
        .setName("Agent target")
        .setDesc("Agent handle or pane ID to attach to.")
        .addText((text) =>
          text
            .setPlaceholder("Enter agent handle")
            .setValue(this.draft.agentTarget || "")
            .onChange((val) => {
              this.draft.agentTarget = val.trim() || undefined;
            })
        );
    }

    if (this.draft.kind === "herdr-remote") {
      new Setting(contentEl)
        .setName("Remote SSH target")
        .setDesc("User and host passed to --remote (for example dev@server).")
        .addText((text) =>
          text
            .setPlaceholder("Enter user@host")
            .setValue(this.draft.remoteTarget || "")
            .onChange((val) => {
              this.draft.remoteTarget = val.trim() || undefined;
            })
        );
    }

    if (this.draft.kind === "shell") {
      new Setting(contentEl)
        .setName("Shell executable")
        .setDesc("Optional shell binary path (leave blank for system default shell).")
        .addText((text) =>
          text
            .setPlaceholder("System default shell")
            .setValue(this.draft.shellPath || "")
            .onChange((val) => {
              this.draft.shellPath = val.trim() || undefined;
            })
        );

      new Setting(contentEl)
        .setName("Shell arguments")
        .setDesc("Space-separated flags passed to the shell (for example -i).")
        .addText((text) =>
          text
            .setPlaceholder("-i")
            .setValue(this.shellArgsRaw)
            .onChange((val) => {
              this.shellArgsRaw = val;
            })
        );
    }

    new Setting(contentEl)
      .setName("Working directory")
      .setDesc("Initial directory used when spawning the PTY process.")
      .addDropdown((dd) =>
        dd
          .addOption("vault-root", "Vault root")
          .addOption("active-note-folder", "Active note folder")
          .addOption("custom", "Custom directory")
          .setValue(this.draft.cwdMode)
          .onChange((val) => {
            this.draft.cwdMode =
              val === "active-note-folder" || val === "custom" ? val : "vault-root";
            this.renderForm();
          })
      );

    if (this.draft.cwdMode === "custom") {
      new Setting(contentEl)
        .setName("Custom directory path")
        .setDesc("Absolute directory path used when starting the terminal.")
        .addText((text) =>
          text
            .setPlaceholder("/path/to/folder")
            .setValue(this.draft.customCwd || "")
            .onChange((val) => {
              this.draft.customCwd = val.trim() || undefined;
            })
        );
    }

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.close();
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Save profile")
          .setCta()
          .onClick(() => {
            this.submit();
          })
      );
  }

  private submit(): void {
    const trimmedName = this.draft.name.trim();
    if (!trimmedName) {
      new Notice("Enter a profile name.");
      return;
    }
    if (this.draft.kind === "herdr-agent" && !this.draft.agentTarget?.trim()) {
      new Notice("Enter an agent handle or pane ID for agent attach mode.");
      return;
    }
    if (this.draft.kind === "herdr-remote" && !this.draft.remoteTarget?.trim()) {
      new Notice("Enter a remote SSH target for remote mode.");
      return;
    }
    const parsedArgs = this.shellArgsRaw
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const saved: TerminalProfile = {
      ...this.draft,
      name: trimmedName,
      shellArgs:
        this.draft.kind === "shell" && parsedArgs.length > 0 ? parsedArgs : undefined,
    };
    this.onSave(saved);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
