import {
  type App,
  Notice,
  PluginSettingTab,
  type SettingDefinitionItem,
} from "obsidian";
import {
  SUPPORTED_AGENT_RUNTIMES,
  type HerdrPluginSettings,
} from "../domain/types";
import { EditProfileModal } from "./modals";

export interface HerdrSettingsHost {
  settings: HerdrPluginSettings;
  saveAndApplySettings(patch?: Partial<HerdrPluginSettings>): Promise<void>;
}

export class HerdrSettingTab extends PluginSettingTab {
  override icon = "cpu" as const;
  private readonly hostRef: HerdrSettingsHost;

  constructor(
    app: App,
    plugin: HerdrSettingsHost & ConstructorParameters<typeof PluginSettingTab>[1]
  ) {
    super(app, plugin);
    this.hostRef = plugin;
  }

  private get host(): HerdrSettingsHost {
    return (
      this.hostRef ??
      (this as unknown as { plugin: HerdrSettingsHost }).plugin
    );
  }

  override getControlValue(key: string): unknown {
    return this.host.settings[key as keyof HerdrPluginSettings];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const patch: Partial<HerdrPluginSettings> = {
      [key]: value,
    };
    let needsFullUpdate = false;

    if (key === "vaultPermissionMode") {
      patch.vaultBridgeEnabled = value !== "off";
      needsFullUpdate = true;
    } else if (key === "vaultBridgeEnabled") {
      if (value === true && this.host.settings.vaultPermissionMode === "off") {
        patch.vaultPermissionMode = "read-write";
        needsFullUpdate = true;
      } else if (value === false && this.host.settings.vaultPermissionMode !== "off") {
        patch.vaultPermissionMode = "off";
        needsFullUpdate = true;
      }
    }

    await this.host.saveAndApplySettings(patch);

    if (needsFullUpdate) {
      this.update();
    } else if (key === "allowUiControl") {
      const refreshable = this as unknown as { refreshDomState?: () => void };
      if (typeof refreshable.refreshDomState === "function") {
        refreshable.refreshDomState();
      } else {
        this.update();
      }
    }
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const profileOptions: Record<string, string> = {};
    for (const profile of this.host.settings.profiles) {
      profileOptions[profile.id] = profile.name;
    }

    const agentRuntimeOptions: Record<string, string> = {};
    for (const runtime of SUPPORTED_AGENT_RUNTIMES) {
      agentRuntimeOptions[runtime.id] = runtime.label;
    }

    return [
      {
        type: "group",
        heading: "Daemon and sessions",
        items: [
          {
            name: "Binary path",
            desc: "Leave blank to auto-detect the executable in standard bin directories.",
            control: {
              type: "text",
              key: "herdrBinaryPath",
              placeholder: "Auto-detect binary",
            },
          },
          {
            name: "Default persistent session",
            desc: "Leave blank to derive a deterministic session name from this vault.",
            control: {
              type: "text",
              key: "defaultSessionName",
              placeholder: "Derived from vault name",
            },
          },
          {
            name: "Custom socket path",
            desc: "Optional local Unix socket or named pipe path override.",
            control: {
              type: "text",
              key: "customSocketPath",
              placeholder: "Default session socket",
            },
          },
          {
            name: "Subscribe to live socket events",
            desc: "Maintain a push event subscription when a daemon is running.",
            control: {
              type: "toggle",
              key: "autoConnectSocket",
            },
          },
          {
            name: "Report active vault and note metadata",
            desc: "Publish the active vault and open note name to the focused workspace sidebar.",
            control: {
              type: "toggle",
              key: "autoReportVaultMetadata",
            },
          },
          {
            name: "Show offline preview when daemon is stopped",
            desc: "Display a labeled sample topology in Mission Control until a session starts.",
            control: {
              type: "toggle",
              key: "showOfflinePreviewWhenStopped",
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Embedded PTY terminal",
        items: [
          {
            name: "Default terminal profile",
            desc: "Profile opened by default when launching a terminal tab.",
            control: {
              type: "dropdown",
              key: "defaultProfileId",
              options: profileOptions,
            },
          },
          {
            name: "Default coding agent runtime",
            desc: "Preselected CLI agent in the spawn modal.",
            control: {
              type: "dropdown",
              key: "defaultAgentKind",
              options: agentRuntimeOptions,
            },
          },
          {
            name: "Terminal font family",
            desc: "Leave blank to match the active Obsidian monospace font automatically.",
            control: {
              type: "text",
              key: "terminalFontFamily",
              placeholder: "Match Obsidian font",
            },
          },
          {
            name: "Terminal font size",
            desc: "Font size in pixels for xterm.js terminal panes (9 to 28).",
            control: {
              type: "slider",
              key: "terminalFontSize",
              min: 9,
              max: 28,
              step: 1,
            },
          },
          {
            name: "Terminal scrollback lines",
            desc: "Maximum scrollback buffer lines retained per embedded terminal (500 to 50000).",
            control: {
              type: "slider",
              key: "terminalScrollback",
              min: 500,
              max: 50000,
              step: 500,
            },
          },
          {
            name: "Blinking terminal cursor",
            control: {
              type: "toggle",
              key: "terminalCursorBlink",
            },
          },
        ],
      },
      {
        type: "list",
        heading: "Terminal profiles",
        emptyState: "No terminal profiles configured.",
        addItem: {
          name: "Add terminal profile",
          action: () => {
            new EditProfileModal(this.app, null, (created) => {
              const next = [...this.host.settings.profiles, created];
              void this.host.saveAndApplySettings({ profiles: next }).then(() => {
                this.update();
              });
            }).open();
          },
        },
        onReorder: (oldIndex, newIndex) => {
          const next = [...this.host.settings.profiles];
          const [moved] = next.splice(oldIndex, 1);
          if (!moved) {
            return;
          }
          next.splice(newIndex, 0, moved);
          void this.host.saveAndApplySettings({ profiles: next }).then(() => {
            this.update();
          });
        },
        onDelete: (index) => {
          if (this.host.settings.profiles.length <= 1) {
            new Notice("At least one terminal profile must remain.");
            return;
          }
          const next = [...this.host.settings.profiles];
          const [removed] = next.splice(index, 1);
          const nextDefault =
            removed && this.host.settings.defaultProfileId === removed.id
              ? next[0].id
              : this.host.settings.defaultProfileId;
          void this.host
            .saveAndApplySettings({
              profiles: next,
              defaultProfileId: nextDefault,
            })
            .then(() => {
              this.update();
            });
        },
        items: this.host.settings.profiles.map((profile) => ({
          name: profile.name,
          desc: `Mode: ${profile.kind} (${profile.cwdMode})`,
          render: (setting) => {
            setting
              .setName(profile.name)
              .setDesc(`Mode: ${profile.kind} (${profile.cwdMode})`)
              .addButton((btn) =>
                btn.setButtonText("Edit").onClick(() => {
                  const current =
                    this.host.settings.profiles.find((p) => p.id === profile.id) ??
                    profile;
                  new EditProfileModal(this.app, current, (updated) => {
                    const next = this.host.settings.profiles.map((p) =>
                      p.id === profile.id ? updated : p
                    );
                    void this.host
                      .saveAndApplySettings({ profiles: next })
                      .then(() => {
                        this.update();
                      });
                  }).open();
                })
              );
          },
        })),
      },
      {
        type: "group",
        heading: "Vault Control Bridge and notifications",
        items: [
          {
            name: "Enable vault access for agents",
            desc: "Let Herdr panes and coding agents access this vault through obs-herdr.",
            control: {
              type: "toggle",
              key: "vaultBridgeEnabled",
            },
          },
          {
            name: "Vault access level",
            desc: "Off blocks vault access. Read only allows reading and searching. Edit notes allows creating, editing, renaming, and trashing notes. Full control adds Obsidian commands and window control.",
            control: {
              type: "dropdown",
              key: "vaultPermissionMode",
              options: {
                off: "Off: agents cannot access vault notes",
                "read-only": "Read only: agents can read and search notes",
                "read-write": "Edit notes: agents can create, edit, rename, and trash notes",
                full: "Full control: adds Obsidian commands and window control",
              },
            },
          },
          {
            name: "Allow read-only inspection of hidden config files",
            desc: "Permit read-only bridge queries inside the vault config folder while keeping writes blocked.",
            control: {
              type: "toggle",
              key: "allowHiddenConfigReads",
            },
          },
          {
            name: "Let agents see and operate Obsidian",
            desc: "Agents can take screenshots of this window and inspect it. With Full control they can also click, type, press keys, scroll, and drag. Screenshots can show any open note; Herdr terminals, Mission Control and the Settings window are blanked out.",
            control: {
              type: "toggle",
              key: "allowUiControl",
            },
          },
          {
            name: "Allow UI actions in protected areas",
            desc: "Permit agent clicks, typing, keys, scrolling, and dragging inside Herdr terminals, Mission Control, Herdr code block widgets, Bases boards, the Settings window and community plugin toggles, and show these areas in screenshots.",
            visible: () => this.host.settings.allowUiControl,
            control: {
              type: "toggle",
              key: "allowUiInProtectedAreas",
            },
          },
          {
            name: "UI typing speed",
            desc: "Visible animates agent typing word by word; Fast inserts text immediately with minimal action delays.",
            visible: () => this.host.settings.allowUiControl,
            control: {
              type: "dropdown",
              key: "uiTypingSpeed",
              options: {
                visible: "Visible (word by word)",
                fast: "Fast (single insert, minimal delays)",
              },
            },
          },
          {
            name: "Show live agent cursors",
            desc: "Display color-coded animated cursors when agents click, type, drag, or edit visible notes in parallel.",
            control: {
              type: "toggle",
              key: "showAgentCursors",
            },
          },
          {
            name: "Notify when an agent becomes blocked",
            desc: "Show a notice when an agent stops for approval or a user answer.",
            control: {
              type: "toggle",
              key: "notifyOnAgentBlocked",
            },
          },
          {
            name: "Notify when background agent work finishes",
            control: {
              type: "toggle",
              key: "notifyOnAgentDone",
            },
          },
        ],
      },
    ];
  }
}
