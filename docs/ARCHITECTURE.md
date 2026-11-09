# Architecture

[practitioner] `HerdrPlugin` (`src/main.ts`) owns Obsidian registration boundaries while delegating domain coordination, socket/CLI IPC, PTY lifecycle, and Vault Control Bridge dispatch to isolated, testable modules with zero view references stored on the `Plugin` instance.

## Module map

- `src/main.ts`: Plugin lifecycle (`onload`, `onunload`), view registrations (`herdr-view`, `herdr-terminal-view`, `herdr-agent-board` guarded by `requireApiVersion("1.10.0")`), `herdr` Markdown codeblock processor, `obsidian://herdr` protocol handler, `registerCliHandler("herdr", ...)` guarded by `requireApiVersion("1.12.2")`, ribbon icons, status bar, context menus, and 9 unprefixed commands without default hotkeys.
- `src/domain/`:
  - `types.ts`: Protocol-20 Herdr types, Vault Bridge RPC contracts, terminal profiles, and `migrateSettings()` (`schemaVersion: 1`).
  - `osc-parser.ts`: Streaming parser for OSC 0/2 terminal titles, OSC 7 working-directory URIs, and Herdr OSC `7501` status/title/percent-encoded messages across arbitrary chunk splits.
  - `path-guard.ts`: `guardVaultRelativePath()` and `resolveTerminalPathInsideVault()`, blocking `..`, NUL bytes, absolute paths, `Vault#configDir`, `.git`, and `.env*` secrets.
  - `shell-quote.ts`: POSIX single-quote and Windows PowerShell quoting for drag-and-drop vault paths.
  - `demo-fixture.ts`: Labeled offline preview topology shown only when no live Herdr daemon is running and `showOfflinePreviewWhenStopped` is enabled.
- `src/herdr/`:
  - `cli-client.ts`: Shell-free `execFile` and detached `spawn` client for `herdr`, including `buildHostNormalizedEnv()` so Linux Flatpak Obsidian shares `~/.config/herdr` and `~/.local/bin` with the host.
  - `socket-client.ts`: NDJSON Unix domain socket / Windows named pipe RPC client for Herdr protocol `20` plus auto-reconnecting `events.subscribe` stream using `window.setTimeout` / `window.clearTimeout`.
- `src/terminal/`:
  - `pty-host.ts`: `PtySession` spawning a zero-native-ABI POSIX Python 3 `pty.openpty()` bridge with file-descriptor-3 `TIOCSWINSZ` resize + `SIGWINCH` (falling back cleanly to standard pipes when Python 3 or POSIX PTYs are unavailable).
  - `theme-palette.ts`: Resolves live Obsidian dark/light CSS variables into an `ITheme` palette for `@xterm/xterm`.
  - `link-provider.ts`: Custom `ILinkProvider` resolving `[[WikiLinks]]`, `obsidian://` URIs, and `path/to/note.md:line:col` inside terminal lines.
- `src/bridge/`:
  - `vault-ops.ts`: `VaultOpsService` implementing 29 permission-gated (21 vault plus 8 `ui.*`) Vault, FileManager, MetadataCache, Workspace, Canvas, Editor, and Command RPC methods with reversible pre-mutation snapshots.
  - `vault-bridge-server.ts`: Mode-`0600` local NDJSON socket server verifying per-session 256-bit bearer tokens with `crypto.timingSafeEqual`.
  - `runtime-kit.ts`: Provisions `~/.cache/obs-herdr/<12-hex>/` (`0700`) with `connection.json` (`0600`), dual-engine `obs-herdr` (`obs-herdr-core.mjs` for Node.js + `obs-herdr-core.py` for Flatpak/Python 3 environments), JSON-RPC 2.0 `obs-herdr mcp` stdio server, and `herdr-plugin.toml` (`id = "obsidian.vault"`).
- `src/control/` (Apache-2.0, see `src/control/LICENSE` and `NOTICE`; ported from Obsidian Control Center):
  - `ui-control.ts`: `UiControlService` with `screenshot`, `inspect`, `waitFor`, `click`, `type`, `pressKey`, `scroll`, and `drag`. Uses Electron `webContents.capturePage()`, `sendInputEvent()`, and `insertText()` from inside the renderer, so it needs no official CLI or remote debugging port. Targets must match exactly one visible, enabled, uncovered element; password fields are refused; input calls are serialized and always release pressed buttons and keys.
  - `keys.ts`: `buildKeyPress()` maps named keys, letters, digits, and `Mod`/`Ctrl`/`Alt`/`Shift`/`Meta` to Electron input (`Mod` is Cmd on macOS, Ctrl elsewhere).
  - `electron-host.ts`: `getObsidianWebContents()` reads `electron.remote.getCurrentWebContents()` and returns `null` when the host lacks it, so UI tools fail with `ui_unavailable` instead of breaking the plugin.
  - Bridge gating (`src/bridge/vault-ops.ts`): `ui.screenshot`, `ui.inspect`, `ui.wait_for` need any bridge tier plus `allowUiControl`; `ui.click`, `ui.type`, `ui.press_key`, `ui.scroll`, `ui.drag` need `full` plus `allowUiControl`. Input that changes the active Markdown editor records a `modified` snapshot so Mission Control Undo restores it.
- `src/services/herdr-coordinator.ts`: Central state coordinator uniting `HerdrCliClient`, `HerdrSocketClient`, `VaultBridgeServer`, `VaultOpsService`, debounced snapshot refreshes, and agent transition notices.
- `src/ui/`:
  - `terminal-view.ts`: `HerdrTerminalView` (`ItemView`) managing `@xterm/xterm` v6, `FitAddon`, `SearchAddon`, `WebLinksAddon`, `ResizeObserver`, visibility guards, drag-and-drop vault paths, and `PtySession` disposal on `onClose()`.
  - `dashboard-view.ts`: `HerdrDashboardView` (`ItemView`) rendering Agents, proportional Topology (`originX`/`originY` normalized) & Git Worktrees, Vault Bridge controls & Undo audit log, and Context Dispatch.
  - `bases-view.ts`: `HerdrBasesView` (`BasesView`) rendering live task cards inside `.base` files.
  - `markdown-widget.ts`: `HerdrCodeblockWidget` (`MarkdownRenderChild`) rendering interactive ```` ```herdr ```` playbook cards.
  - `modals.ts`: `SpawnAgentModal`, `DispatchNoteModal`, `CreateWorktreeModal`, and `SelectProfileModal`.
  - `settings-tab.ts`: `HerdrSettingTab` (`PluginSettingTab`) using Obsidian 1.13+/1.14+ declarative `getSettingDefinitions()`.

## Lifecycle & cleanup guarantees

- `onunload()` disposes `HerdrCoordinator` (closing `HerdrSocketClient`, stopping `VaultBridgeServer`, unlinking socket files, and clearing timers) without calling `workspace.detachLeavesOfType()` (`OB-REV-003`).
- Every `HerdrTerminalView` disposes its `ResizeObserver`, `Terminal`, and `PtySession` (`SIGTERM` -> `SIGKILL` escalation) in `onClose()`.
- All CSS rules in `styles.css` are scoped to `.herdr-*`, contain `0` `!important` declarations, and contain `0` hardcoded `#hex` colors (`OB-REV-014`).
