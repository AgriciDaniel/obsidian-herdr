import * as path from "node:path";
import {
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  TFolder,
  requireApiVersion,
  type WorkspaceLeaf,
} from "obsidian";
import {
  DEFAULT_PROFILES,
  migrateSettings,
  type HerdrPluginSettings,
  type TerminalProfile,
} from "./domain/types";
import { HerdrCoordinator } from "./services/herdr-coordinator";
import { HerdrBasesView, VIEW_TYPE_HERDR_BASES } from "./ui/bases-view";
import { HerdrDashboardView, VIEW_TYPE_HERDR_DASHBOARD } from "./ui/dashboard-view";
import { HerdrCodeblockWidget } from "./ui/markdown-widget";
import {
  CreateWorktreeModal,
  DispatchNoteModal,
  SelectProfileModal,
  SpawnAgentModal,
  confirmAction,
} from "./ui/modals";
import { HerdrSettingTab, type HerdrSettingsHost } from "./ui/settings-tab";
import {
  HerdrTerminalView,
  VIEW_TYPE_HERDR_TERMINAL,
  type HerdrTerminalViewState,
} from "./ui/terminal-view";

export default class HerdrPlugin extends Plugin implements HerdrSettingsHost {
  settings: HerdrPluginSettings = migrateSettings(null);
  coordinator!: HerdrCoordinator;

  private statusBarEl: HTMLElement | null = null;
  private unsubCoord: (() => void) | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.coordinator = new HerdrCoordinator({
      app: this.app,
      getSettings: () => this.settings,
      pluginVersion: this.manifest.version,
    });

    this.registerView(
      VIEW_TYPE_HERDR_DASHBOARD,
      (leaf) =>
        new HerdrDashboardView({
          leaf,
          coordinator: this.coordinator,
          getSettings: () => this.settings,
          updateSettings: (patch) => this.saveAndApplySettings(patch),
          openTerminalLeaf: (opts) => this.activateTerminalView(opts),
        })
    );

    this.registerView(
      VIEW_TYPE_HERDR_TERMINAL,
      (leaf) => new HerdrTerminalView(leaf, this.coordinator, () => this.settings)
    );

    if (requireApiVersion("1.10.0")) {
      this.registerBasesView(VIEW_TYPE_HERDR_BASES, {
        name: "Herdr task board",
        icon: "cpu",
        factory: (controller, containerEl) =>
          new HerdrBasesView(controller, containerEl, this.coordinator, () =>
            this.activateTerminalView({ split: true })
          ),
      });
    }

    this.registerMarkdownCodeBlockProcessor("herdr", (source, el, ctx) => {
      const widget = new HerdrCodeblockWidget({
        containerEl: el,
        source,
        coordinator: this.coordinator,
        openMissionControl: () => this.activateMissionControl(),
        openTerminal: (sessionName) =>
          this.activateTerminalView({ sessionName, split: true }),
        runInTerminal: async (commandText, sessionName) => {
          await this.activateTerminalView({
            profileId: "shell-vault",
            sessionName,
            split: true,
          });
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_HERDR_TERMINAL);
          const activeLeaf = leaves[leaves.length - 1];
          if (activeLeaf?.view instanceof HerdrTerminalView) {
            activeLeaf.view.sendTextToPty(`${commandText}\n`);
          }
        },
      });
      ctx.addChild(widget);
    });

    this.registerObsidianProtocolHandler("herdr", (params) => {
      const safeId = (raw: unknown): string | undefined => {
        if (typeof raw !== "string") return undefined;
        const trimmed = raw.trim();
        if (!trimmed) return undefined;
        if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/.test(trimmed)) {
          return undefined;
        }
        return trimmed;
      };
      const view = params.view || "";
      if (view === "terminal") {
        const sessionName = safeId(params.session);
        const agentTarget = safeId(params.agent);
        if ((params.session && !sessionName) || (params.agent && !agentTarget)) {
          new Notice("Ignored protocol link with invalid session or agent identifier.");
          return;
        }
        const desc = agentTarget
          ? `agent '${agentTarget}'${sessionName ? ` in session '${sessionName}'` : ""}`
          : sessionName
            ? `session '${sessionName}'`
            : "default vault terminal";
        void confirmAction(this.app, {
          title: "Open Herdr terminal from link?",
          body: `An external protocol link requested opening ${desc}.`,
          confirmText: "Open terminal",
        }).then((confirmed) => {
          if (!confirmed) return;
          void this.activateTerminalView({
            sessionName,
            agentTarget,
          });
        });
        return;
      }
      if (params.note) {
        const target = this.app.vault.getAbstractFileByPath(params.note);
        if (target instanceof TFile) {
          void this.app.workspace.getLeaf(false).openFile(target);
          return;
        }
      }
      void this.activateMissionControl();
    });

    if (requireApiVersion("1.12.2") && typeof this.registerCliHandler === "function") {
      try {
        this.registerCliHandler(
          "herdr",
          "Inspect Herdr runtime and Vault Control Bridge state",
          null,
          () => {
            const state = this.coordinator.getState();
            return JSON.stringify(
              {
                session: state.activeSessionName,
                serverRunning: state.serverRunning,
                agents: state.snapshot?.agents.length ?? 0,
                bridgeRunning: state.bridgeRunning,
                permissionMode: this.settings.vaultPermissionMode,
                cliScriptPath: state.cliScriptPath,
              },
              null,
              2
            );
          }
        );
      } catch {
        // Ignore duplicate CLI registration during hot reload
      }
    }

    this.addRibbonIcon("cpu", "Open Herdr Mission Control", () => {
      void this.activateMissionControl();
    });

    this.addRibbonIcon("terminal", "Open Herdr interactive terminal", () => {
      void this.activateTerminalView({ split: false });
    });

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("herdr-statusbar-item", "mod-clickable");
    this.statusBarEl.setAttr("aria-label", "Open Herdr Mission Control");
    this.registerDomEvent(this.statusBarEl, "click", () => {
      void this.activateMissionControl();
    });
    this.updateStatusBar();

    this.unsubCoord = this.coordinator.onChange(() => {
      this.updateStatusBar();
    });

    this.registerCommands();
    this.registerContextMenus();
    this.addSettingTab(new HerdrSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      void this.coordinator.initialize().catch((err: unknown) => {
        console.warn("[herdr-obs] Coordinator initialization failed:", err);
      });
      this.registerInterval(
        window.setInterval(() => {
          void this.coordinator.refreshAll(false).catch((err: unknown) => {
            console.warn("[herdr-obs] Periodic refresh failed:", err);
          });
        }, 8000)
      );
    });
  }

  onunload(): void {
    this.unsubCoord?.();
    this.unsubCoord = null;
    void this.coordinator?.dispose().catch((err: unknown) => {
      console.warn("[herdr-obs] Coordinator dispose failed:", err);
    });
  }

  async loadSettings(): Promise<void> {
    const raw: unknown = await this.loadData();
    this.settings = migrateSettings(raw);
  }

  async saveAndApplySettings(patch?: Partial<HerdrPluginSettings>): Promise<void> {
    if (patch) {
      this.settings = migrateSettings({ ...this.settings, ...patch });
    }
    await this.saveData(this.settings);
    await this.coordinator.applySettingsUpdate();
    this.updateStatusBar();
  }

  async activateMissionControl(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_HERDR_DASHBOARD);
    let leaf: WorkspaceLeaf | null = existing[0] ?? null;

    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({
        type: VIEW_TYPE_HERDR_DASHBOARD,
        active: true,
      });
    }

    await workspace.revealLeaf(leaf);
  }

  async activateTerminalView(options?: {
    profileId?: string;
    agentTarget?: string;
    sessionName?: string;
    cwdOverride?: string;
    split?: boolean;
  }): Promise<void> {
    const { workspace } = this.app;
    const hasCustomTarget = Boolean(
      options?.profileId ||
        options?.agentTarget ||
        options?.sessionName ||
        options?.cwdOverride
    );
    const existing = workspace.getLeavesOfType(VIEW_TYPE_HERDR_TERMINAL);
    let leaf: WorkspaceLeaf | null =
      !options?.split && !hasCustomTarget ? existing[0] ?? null : null;

    const viewState: HerdrTerminalViewState = {
      profileId: options?.agentTarget
        ? "__agent_attach__"
        : options?.profileId || this.settings.defaultProfileId,
      customAgentTarget: options?.agentTarget || "",
      sessionOverride: options?.sessionName || "",
      cwdOverride: options?.cwdOverride || "",
    };

    if (!leaf) {
      leaf = options?.split ? workspace.getLeaf("split", "vertical") : workspace.getLeaf("tab");
      await leaf.setViewState({
        type: VIEW_TYPE_HERDR_TERMINAL,
        active: true,
        state: viewState,
      });
    } else if (hasCustomTarget) {
      await leaf.setViewState({
        type: VIEW_TYPE_HERDR_TERMINAL,
        active: true,
        state: viewState,
      });
    }

    await workspace.revealLeaf(leaf);
    if (leaf.view instanceof HerdrTerminalView) {
      leaf.view.focusTerminal();
    }
  }

  private registerCommands(): void {
    this.addCommand({
      id: "open-mission-control",
      name: "Open Mission Control",
      callback: () => {
        void this.activateMissionControl();
      },
    });

    this.addCommand({
      id: "open-interactive-terminal",
      name: "Open interactive terminal",
      callback: () => {
        void this.activateTerminalView({ split: false });
      },
    });

    this.addCommand({
      id: "open-terminal-split",
      name: "Open interactive terminal in split",
      callback: () => {
        void this.activateTerminalView({ split: true });
      },
    });

    this.addCommand({
      id: "open-terminal-profile",
      name: "Open terminal with profile",
      callback: () => {
        const profiles: TerminalProfile[] =
          this.settings.profiles.length > 0 ? this.settings.profiles : DEFAULT_PROFILES;
        new SelectProfileModal(this.app, profiles, (chosen) => {
          void this.activateTerminalView({ profileId: chosen.id, split: false });
        }).open();
      },
    });

    this.addCommand({
      id: "start-persistent-session",
      name: "Start persistent session for this vault",
      callback: () => {
        void this.coordinator
          .startVaultHerdrSession()
          .then(() => {
            new Notice(
              `Started Herdr session '${this.coordinator.getActiveSessionName()}'.`
            );
          })
          .catch((err: unknown) => {
            new Notice(err instanceof Error ? err.message : String(err));
          });
      },
    });

    this.addCommand({
      id: "stop-persistent-session",
      name: "Stop persistent session for this vault",
      callback: () => {
        const sessionName = this.coordinator.getActiveSessionName();
        void confirmAction(this.app, {
          title: `Stop session '${sessionName}'?`,
          body: `All running agents and terminals in '${sessionName}' will stop immediately.`,
          confirmText: "Stop session",
          danger: true,
        })
          .then((confirmed) => {
            if (!confirmed) {
              return;
            }
            return this.coordinator.stopVaultHerdrSession().then(() => {
              new Notice(`Stopped Herdr session '${sessionName}'.`);
            });
          })
          .catch((err: unknown) => {
            new Notice(err instanceof Error ? err.message : String(err));
          });
      },
    });

    this.addCommand({
      id: "spawn-coding-agent",
      name: "Spawn coding agent in split pane",
      callback: () => {
        new SpawnAgentModal(
          this.app,
          this.coordinator,
          this.settings.defaultAgentKind
        ).open();
      },
    });

    this.addCommand({
      id: "dispatch-note-context",
      name: "Send active note or selection to agent",
      callback: () => {
        new DispatchNoteModal(this.app, this.coordinator).open();
      },
    });

    this.addCommand({
      id: "create-git-worktree",
      name: "Create Git worktree workspace",
      callback: () => {
        new CreateWorktreeModal(this.app, this.coordinator).open();
      },
    });

    this.addCommand({
      id: "refresh-runtime-state",
      name: "Refresh runtime state",
      callback: () => {
        void this.coordinator
          .refreshAll(true)
          .then(() => {
            new Notice("Refreshed Herdr runtime snapshot.");
          })
          .catch((err: unknown) => {
            new Notice(err instanceof Error ? err.message : String(err));
          });
      },
    });
  }

  private registerContextMenus(): void {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, abstractFile) => {
        if (abstractFile instanceof TFile && abstractFile.extension === "md") {
          menu.addItem((item) => {
            item
              .setTitle("Send note to Herdr agent")
              .setIcon("cpu")
              .onClick(() => {
                void this.app.workspace
                  .getLeaf(false)
                  .openFile(abstractFile)
                  .then(() => {
                    new DispatchNoteModal(this.app, this.coordinator).open();
                  })
                  .catch((err: unknown) => {
                    new Notice(err instanceof Error ? err.message : String(err));
                  });
              });
          });
        }
        if (abstractFile instanceof TFolder || abstractFile instanceof TFile) {
          menu.addItem((item) => {
            item
              .setTitle("Open Herdr terminal here")
              .setIcon("terminal")
              .onClick(() => {
                const vaultBase = this.coordinator.vaultOps.getVaultBasePath();
                let cwdOverride: string | undefined;
                if (vaultBase) {
                  if (abstractFile instanceof TFolder) {
                    const rel = abstractFile.path === "/" ? "" : abstractFile.path;
                    cwdOverride = rel ? path.join(vaultBase, rel) : vaultBase;
                  } else {
                    const parentRel =
                      abstractFile.parent && abstractFile.parent.path !== "/"
                        ? abstractFile.parent.path
                        : "";
                    cwdOverride = parentRel ? path.join(vaultBase, parentRel) : vaultBase;
                  }
                }
                void this.activateTerminalView({
                  profileId: "shell-note",
                  cwdOverride,
                  split: true,
                });
              });
          });
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        if (info instanceof MarkdownView) {
          menu.addItem((item) => {
            item
              .setTitle(
                editor.somethingSelected()
                  ? "Send selection to Herdr agent"
                  : "Send note to Herdr agent"
              )
              .setIcon("cpu")
              .onClick(() => {
                new DispatchNoteModal(this.app, this.coordinator, {
                  selectionOnly: editor.somethingSelected(),
                }).open();
              });
          });
        }
      })
    );
  }

  private updateStatusBar(): void {
    if (!this.statusBarEl) {
      return;
    }
    const state = this.coordinator.getState();
    const bridgeLabel = state.bridgeRunning ? this.settings.vaultPermissionMode : "off";

    if (!state.serverRunning) {
      this.statusBarEl.setText(`Herdr: idle | Bridge: ${bridgeLabel}`);
      this.statusBarEl.toggleClass("is-blocked", false);
      return;
    }

    const agents = state.snapshot?.agents ?? [];
    const working = agents.filter((a) => a.agent_status === "working").length;
    const blocked = agents.filter((a) => a.agent_status === "blocked").length;
    const done = agents.filter((a) => a.agent_status === "done").length;

    const summary =
      blocked > 0
        ? `${blocked} blocked, ${working} working`
        : working > 0
          ? `${working} working, ${done} done`
          : `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`;

    this.statusBarEl.setText(`Herdr: ${summary} | Bridge: ${bridgeLabel}`);
    this.statusBarEl.toggleClass("is-blocked", blocked > 0);
  }
}
