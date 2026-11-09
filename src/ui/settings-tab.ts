import {
  type App,
  Notice,
  PluginSettingTab,
  type SettingDefinitionItem,
} from "obsidian";
import type { HerdrPluginSettings } from "../domain/types";
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
    await this.host.saveAndApplySettings({
      [key]: value,
    });
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const profileOptions: Record<string, string> = {};
    for (const profile of this.host.settings.profiles) {
      profileOptions[profile.id] = profile.name;
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
              options: {
                claude: "Claude Code",
                codex: "Codex",
                agy: "Antigravity",
                gemini: "Gemini",
                opencode: "OpenCode",
                cursor: "Cursor CLI",
                copilot: "GitHub Copilot CLI",
                grok: "Grok",
                pi: "Pi",
              },
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
        items: this.host.settings.profiles.map((profile, idx) => ({
          name: profile.name,
          desc: `Mode: ${profile.kind} (${profile.cwdMode})`,
          render: (setting) => {
            setting
              .setName(profile.name)
              .setDesc(`Mode: ${profile.kind} (${profile.cwdMode})`)
              .addButton((btn) =>
                btn.setButtonText("Edit").onClick(() => {
                  new EditProfileModal(this.app, profile, (updated) => {
                    const next = [...this.host.settings.profiles];
                    next[idx] = updated;
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
            name: "Enable local Vault Control Bridge",
            desc: "Start a mode-0600 authenticated local socket and inject obs-herdr into panes.",
            control: {
              type: "toggle",
              key: "vaultBridgeEnabled",
            },
          },
          {
            name: "Vault permission tier",
            desc: "Controls whether agents can only inspect notes, mutate notes via safe APIs, or invoke non-restricted commands.",
            control: {
              type: "dropdown",
              key: "vaultPermissionMode",
              options: {
                "read-only": "Read-only (inspect and search)",
                "read-write": "Read-write (atomic note, frontmatter, and link-safe rename)",
                full: "Full (adds allowed workspace commands)",
                off: "Disabled",
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
            desc: "Agents can take screenshots of this window and inspect it. With Full permission they can also click, type, press keys, scroll, and drag. Screenshots can show any open note.",
            control: {
              type: "toggle",
              key: "allowUiControl",
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
