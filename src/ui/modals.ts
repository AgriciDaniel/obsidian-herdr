import { type App, FuzzySuggestModal, MarkdownView, Modal, Notice, Setting } from "obsidian";
import {
  SUPPORTED_AGENT_RUNTIMES,
  type SplitDirection,
  type TerminalProfile,
  type TerminalProfileKind,
} from "../domain/types";
import type { HerdrCoordinator } from "../services/herdr-coordinator";

function tokenizeShellArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\" && i + 1 < raw.length && (raw[i + 1] === '"' || raw[i + 1] === "\\")) {
        i += 1;
        current += raw[i];
      } else {
        current += ch;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        args.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < raw.length) {
      i += 1;
      current += raw[i];
      inToken = true;
      continue;
    }
    current += ch;
    inToken = true;
  }

  if (inToken) {
    args.push(current);
  }
  return args;
}

function formatShellArgs(args?: string[]): string {
  if (!args || args.length === 0) {
    return "";
  }
  return args
    .map((arg) =>
      arg === "" || /[\s"'\\]/.test(arg)
        ? `"${arg.replace(/([\\"])/g, "\\$1")}"`
        : arg
    )
    .join(" ");
}

export interface ConfirmActionOptions {
  title: string;
  body: string;
  confirmText: string;
  danger?: boolean;
}

class ConfirmActionModal extends Modal {
  private readonly opts: ConfirmActionOptions;
  private readonly resolve: (confirmed: boolean) => void;
  private settled = false;

  constructor(
    app: App,
    opts: ConfirmActionOptions,
    resolve: (confirmed: boolean) => void
  ) {
    super(app);
    this.opts = opts;
    this.resolve = resolve;
  }

  private settle(confirmed: boolean): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolve(confirmed);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("herdr-modal", "herdr-confirm-modal");

    new Setting(contentEl).setName(this.opts.title).setHeading();
    contentEl.createEl("p", {
      cls: "herdr-confirm-body",
      text: this.opts.body,
    });

    this.scope?.register([], "Escape", () => {
      this.settle(false);
      this.close();
      return false;
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.settle(false);
          this.close();
        })
      )
      .addButton((btn) => {
        btn.setButtonText(this.opts.confirmText);
        if (this.opts.danger) {
          btn.setClass("mod-warning");
        } else {
          btn.setCta();
        }
        btn.onClick(() => {
          this.settle(true);
          this.close();
        });
      });
  }

  onClose(): void {
    this.settle(false);
    this.contentEl.empty();
  }
}

export function confirmAction(
  app: App,
  opts: ConfirmActionOptions
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    new ConfirmActionModal(app, opts, resolve).open();
  });
}

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
  private abortController: AbortController | null = null;

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
      .addDropdown((dd) => {
        const installedIds = new Set(
          this.coordinator
            .getState()
            .integrations.filter((i) => i.installed)
            .map((i) => i.target.toLowerCase())
        );
        const installedFirst = SUPPORTED_AGENT_RUNTIMES.filter((r) =>
          installedIds.has(r.id.toLowerCase())
        );
        const others = SUPPORTED_AGENT_RUNTIMES.filter(
          (r) => !installedIds.has(r.id.toLowerCase())
        );
        for (const runtime of installedFirst) {
          dd.addOption(runtime.id, `${runtime.label} (installed)`);
        }
        for (const runtime of others) {
          dd.addOption(runtime.id, runtime.label);
        }
        const validKind = SUPPORTED_AGENT_RUNTIMES.some((r) => r.id === this.agentKind)
          ? this.agentKind
          : SUPPORTED_AGENT_RUNTIMES[0].id;
        this.agentKind = validKind;
        dd.setValue(validKind).onChange((val) => {
          this.agentKind = val;
          if (!this.nameEditedManually) {
            this.agentName = this.suggestUniqueHandle(val);
            if (nameInputEl) {
              nameInputEl.value = this.agentName;
            }
          }
        });
      });

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
        "Auto-register the vault MCP tools when launching an agent that supports them (Codex, Claude Code)."
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
    this.scope?.register(["Mod"], "Enter", () => {
      void this.submit(spawnBtnEl);
      return false;
    });
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.abortController?.abort();
          this.close();
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
    const controller = new AbortController();
    this.abortController = controller;
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
        signal: controller.signal,
      });
      new Notice(`Started Herdr agent '${this.agentName}' (${this.agentKind}).`);
      this.onSpawned?.();
      this.close();
    } catch (err) {
      this.submitting = false;
      if (controller.signal.aborted) {
        const msg =
          err instanceof Error && err.message.trim()
            ? err.message
            : `Cancelled waiting for '${this.agentName}'.`;
        new Notice(msg);
        return;
      }
      if (spawnBtnEl) {
        spawnBtnEl.disabled = false;
        spawnBtnEl.setText("Spawn agent");
      }
      new Notice(`Could not start agent: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  onClose(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.contentEl.empty();
  }
}

export class CreateWorktreeModal extends Modal {
  private readonly coordinator: HerdrCoordinator;
  private branchName = "";
  private focusAfter = true;
  private submitting = false;

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

    let createBtnEl: HTMLButtonElement | null = null;
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.close();
        })
      )
      .addButton((btn) => {
        createBtnEl = btn.buttonEl;
        btn
          .setButtonText("Create worktree")
          .setCta()
          .onClick(() => {
            void this.submit(createBtnEl);
          });
      });
  }

  private async submit(createBtnEl: HTMLButtonElement | null): Promise<void> {
    if (this.submitting) {
      return;
    }
    if (!this.branchName) {
      new Notice("Enter a Git branch name.");
      return;
    }
    this.submitting = true;
    if (createBtnEl) {
      createBtnEl.disabled = true;
      createBtnEl.setText("Creating...");
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
      this.submitting = false;
      if (createBtnEl) {
        createBtnEl.disabled = false;
        createBtnEl.setText("Create worktree");
      }
      new Notice(`Worktree creation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface DispatchNoteModalOptions {
  defaultTarget?: string;
  selectionOnly?: boolean;
}

export class DispatchNoteModal extends Modal {
  private readonly coordinator: HerdrCoordinator;
  private target = "";
  private instruction = "Review this note context and apply requested updates via obs-herdr.";
  private selectionOnly = false;
  private includeBacklinks = true;
  private submitting = false;

  constructor(
    app: App,
    coordinator: HerdrCoordinator,
    options?: string | DispatchNoteModalOptions
  ) {
    super(app);
    this.coordinator = coordinator;
    if (typeof options === "string") {
      this.target = options;
    } else if (options) {
      this.target = options.defaultTarget || "";
      if (typeof options.selectionOnly === "boolean") {
        this.selectionOnly = options.selectionOnly;
      }
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("herdr-modal");

    new Setting(contentEl).setName("Dispatch vault context to Herdr").setHeading();

    const activeFile = this.app.workspace.getActiveFile();
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const selectionText = mdView?.editor.getSelection() || "";
    const noteLengthLabel = activeFile
      ? mdView && mdView.file?.path === activeFile.path
        ? `${mdView.editor.getValue().length} chars`
        : `${activeFile.stat.size} bytes`
      : "";
    const contextSummary = activeFile
      ? selectionText.length > 0
        ? `Active note: ${activeFile.path} (${noteLengthLabel}) | Selection: ${selectionText.length} chars`
        : `Active note: ${activeFile.path} (${noteLengthLabel}) | No active selection`
      : selectionText.length > 0
        ? `No active note | Selection: ${selectionText.length} chars`
        : "No active note or editor selection detected.";
    contentEl.createDiv({
      cls: "herdr-mc-hint",
      text: contextSummary,
    });

    const snap = this.coordinator.getState().snapshot;
    const agents = snap?.agents ?? [];
    const panes = snap?.panes ?? [];

    new Setting(contentEl)
      .setName("Target agent or pane")
      .setDesc("Select a live Herdr agent handle or pane ID.")
      .addDropdown((dd) => {
        const optionKeys: string[] = [];
        for (const ag of agents) {
          const id = ag.name || ag.pane_id;
          const key = `agent:${id}`;
          const label = `${ag.display_agent || ag.name || ag.agent || ag.pane_id} (${ag.agent_status})`;
          dd.addOption(key, `Agent: ${label}`);
          optionKeys.push(key);
        }
        for (const p of panes) {
          const key = `pane:${p.pane_id}`;
          dd.addOption(key, `Pane: ${p.pane_id} (${p.label || p.cwd || "shell"})`);
          optionKeys.push(key);
        }
        if (optionKeys.length === 0) {
          dd.addOption("", "No active Herdr targets found");
          dd.setValue("");
          this.target = "";
        } else {
          const candidates = [
            this.target,
            this.target ? `agent:${this.target}` : "",
            this.target ? `pane:${this.target}` : "",
            optionKeys[0],
          ].filter(Boolean);
          const initialKey =
            candidates.find((key) => optionKeys.includes(key)) ?? optionKeys[0];
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

    let sendBtnEl: HTMLButtonElement | null = null;
    this.scope?.register(["Mod"], "Enter", () => {
      void this.submit(sendBtnEl);
      return false;
    });
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.close();
        })
      )
      .addButton((btn) => {
        sendBtnEl = btn.buttonEl;
        btn
          .setButtonText("Send context")
          .setCta()
          .onClick(() => {
            void this.submit(sendBtnEl);
          });
      });
  }

  private async submit(sendBtnEl: HTMLButtonElement | null): Promise<void> {
    if (this.submitting) {
      return;
    }
    if (!this.target) {
      new Notice("Start a Herdr session or select a target pane first.");
      return;
    }
    this.submitting = true;
    if (sendBtnEl) {
      sendBtnEl.disabled = true;
      sendBtnEl.setText("Sending...");
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
      this.submitting = false;
      if (sendBtnEl) {
        sendBtnEl.disabled = false;
        sendBtnEl.setText("Send context");
      }
      new Notice(`Context dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class SelectProfileModal extends FuzzySuggestModal<TerminalProfile> {
  private readonly profiles: TerminalProfile[];
  private readonly onChoose: (profile: TerminalProfile) => void;

  constructor(app: App, profiles: TerminalProfile[], onChoose: (profile: TerminalProfile) => void) {
    super(app);
    this.profiles = profiles;
    this.onChoose = onChoose;
    this.setPlaceholder("Choose a terminal profile...");
  }

  getItems(): TerminalProfile[] {
    return this.profiles;
  }

  getItemText(profile: TerminalProfile): string {
    return `${profile.name} (${profile.kind})`;
  }

  onChooseItem(profile: TerminalProfile): void {
    this.onChoose(profile);
  }
}

export class EditProfileModal extends Modal {
  private readonly isNew: boolean;
  private readonly onSave: (profile: TerminalProfile) => void;
  private draft: TerminalProfile;
  private shellArgsRaw: string;
  private sessionFieldEl: HTMLElement | null = null;
  private agentTargetFieldEl: HTMLElement | null = null;
  private remoteTargetFieldEl: HTMLElement | null = null;
  private shellFieldsEl: HTMLElement | null = null;
  private customCwdFieldEl: HTMLElement | null = null;

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
    this.shellArgsRaw = formatShellArgs(this.draft.shellArgs);
  }

  onOpen(): void {
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
            this.syncFieldVisibility();
          })
      );

    const sessionSetting = new Setting(contentEl)
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
    this.sessionFieldEl = sessionSetting.settingEl;

    const agentSetting = new Setting(contentEl)
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
    this.agentTargetFieldEl = agentSetting.settingEl;

    const remoteSetting = new Setting(contentEl)
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
    this.remoteTargetFieldEl = remoteSetting.settingEl;

    const shellContainer = contentEl.createDiv();
    this.shellFieldsEl = shellContainer;

    new Setting(shellContainer)
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

    new Setting(shellContainer)
      .setName("Shell arguments")
      .setDesc("Space-separated flags passed to the shell; quotes preserve spaces.")
      .addText((text) =>
        text
          .setPlaceholder("-i")
          .setValue(this.shellArgsRaw)
          .onChange((val) => {
            this.shellArgsRaw = val;
          })
      );

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
            this.syncFieldVisibility();
          })
      );

    const customCwdSetting = new Setting(contentEl)
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
    this.customCwdFieldEl = customCwdSetting.settingEl;

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

    this.syncFieldVisibility();
  }

  private syncFieldVisibility(): void {
    this.sessionFieldEl?.toggleClass("herdr-is-hidden", this.draft.kind === "shell");
    this.agentTargetFieldEl?.toggleClass(
      "herdr-is-hidden",
      this.draft.kind !== "herdr-agent"
    );
    this.remoteTargetFieldEl?.toggleClass(
      "herdr-is-hidden",
      this.draft.kind !== "herdr-remote"
    );
    this.shellFieldsEl?.toggleClass("herdr-is-hidden", this.draft.kind !== "shell");
    this.customCwdFieldEl?.toggleClass(
      "herdr-is-hidden",
      this.draft.cwdMode !== "custom"
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
    if (this.draft.cwdMode === "custom" && !this.draft.customCwd?.trim()) {
      new Notice("Enter a custom directory path or choose another working directory mode.");
      return;
    }
    const parsedArgs = tokenizeShellArgs(this.shellArgsRaw);

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
    this.sessionFieldEl = null;
    this.agentTargetFieldEl = null;
    this.remoteTargetFieldEl = null;
    this.shellFieldsEl = null;
    this.customCwdFieldEl = null;
    this.contentEl.empty();
  }
}
