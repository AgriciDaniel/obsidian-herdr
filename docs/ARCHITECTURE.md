# Architecture

[practitioner] `HerdrPlugin` (`src/main.ts`) owns Obsidian registration boundaries while delegating domain coordination, socket/CLI IPC, PTY lifecycle, Vault Control Bridge dispatch, UI control, and Mission Control rendering to isolated, testable deep modules with zero view references stored on the `Plugin` instance.

## Module map

- `src/main.ts`: Plugin lifecycle (`onload`, `onunload`), view registrations (`herdr-view`, `herdr-terminal-view`, `herdr-agent-board` guarded by `requireApiVersion("1.10.0")`), `herdr` Markdown codeblock processor, `obsidian://herdr` protocol handler, `registerCliHandler("herdr", ...)` guarded by `requireApiVersion("1.12.2")`, ribbon icons, status bar, context menus, and 9 unprefixed commands without default hotkeys.
- `src/domain/`:
  - `types.ts`: Protocol-20 Herdr types, shared `SUPPORTED_AGENT_RUNTIMES` (22 runtimes), Vault Bridge RPC contracts, terminal profiles, and `migrateSettings()` (`schemaVersion: 1`).
  - `osc-parser.ts`: Streaming parser for OSC 0/2 terminal titles, OSC 7 working-directory URIs, and Herdr OSC `7501` status/title/percent-encoded messages across arbitrary chunk splits.
  - `path-guard.ts`: `guardVaultRelativePath()`, `assertNoSymlinkEscape()`, and `resolveTerminalPathInsideVault()`, blocking `..`, NUL bytes, absolute paths, `.git` at any depth, nested dot-directories on writes, `Vault#configDir`, `.env*` secrets, and symlink escapes outside the vault root.
  - `shell-quote.ts`: POSIX single-quote and Windows PowerShell quoting for drag-and-drop vault paths.
  - `demo-fixture.ts`: Sample topology fixture (isolated from live `getState().snapshot` so offline demo agents never leak into live dispatch modals).
- `src/herdr/`:
  - `cli-client.ts`: Shell-free `execFile` and detached `spawn` client for `herdr`, with 60s cached binary/PATH resolution and `buildHostNormalizedEnv()` so Linux Flatpak Obsidian shares `~/.config/herdr` and `~/.local/bin` with the host.
  - `socket-client.ts`: NDJSON Unix domain socket / Windows named pipe RPC client for Herdr protocol `20` plus auto-reconnecting `events.subscribe` stream using `window.setTimeout` / `window.clearTimeout`.
- `src/terminal/`:
  - `pty-host.ts` + `drivers/pty-bridge.py` + `drivers/conpty-bridge.cs`: `PtySession` with pause/resume backpressure hooks, POSIX Python 3 `pty.openpty()` bridge (with FD-3 `TIOCSWINSZ` resize, `write_all`, `SIGHUP -> SIGTERM -> SIGKILL` cleanup), and Windows ConPTY driver (kill-on-close job object, `try/finally` handle/memory cleanup, locked resize/close).
  - `theme-palette.ts`: Pop-out-window-safe resolver converting Obsidian dark/light CSS variables (including recursive `var(...)` and `--text-selection`) into an `ITheme` palette for `@xterm/xterm`.
  - `link-provider.ts`: Custom `ILinkProvider` resolving existing `[[WikiLinks]]`, `obsidian://` URIs (with cross-vault/non-open confirmation), and `path/to/note.md:line:col` inside terminal lines, opening files in new tabs.
- `src/bridge/`:
  - `policy.ts`: Permission tier matrices, `BridgeRpcError`, command allow/denylist, scan exclusions, Canvas URL validation, and fenced-code-aware heading insertion.
  - `mutation-ledger.ts`: `MutationLedger` managing the audit ring buffer, bounded undo snapshot storage (512 KiB single / 16 MiB total caps), revision counters, and per-path async write locks.
  - `vault-ops.ts`: `VaultOpsService` implementing permission-gated Vault, FileManager, MetadataCache, Workspace, Canvas, Editor, Command, and UI RPC methods with bounded pagination and reversible pre-mutation snapshots.
  - `vault-bridge-server.ts`: Mode-`0600` local NDJSON socket server using byte-safe `Buffer` framing, live-socket probe before unlink, `maxConnections = 64`, 60s client idle timeout, and constant-time 256-bit bearer token verification.
  - `kit-paths.ts`, `mcp-schema.ts`, `provisioner.ts`, `runtime-kit.ts` + `client/obs-herdr-core.mjs` + `client/obs-herdr-core.py`: Atomically provisions private runtime folders (`~/.cache/obs-herdr/<12-hex>/` on POSIX, `%LOCALAPPDATA%\obs-herdr\<12-hex>\` on Windows) with `connection.json` (`0600`), dual-engine `obs-herdr` CLI, dynamic-gated 27-tool JSON-RPC 2.0 MCP stdio server (compact JSON, MCP `isError: true`, omitting 11 UI tools when `uiControlEnabled` is false), screenshot pruning, and `herdr-plugin.toml`.
- `src/control/` (Apache-2.0, see `src/control/LICENSE` and `NOTICE`; every `.ts` file verified for SPDX header by `esbuild.config.mjs`):
  - `types.ts`, `keys.ts`, `safety-guard.ts`, `cursor-anchor.ts`, `electron-host.ts`, `html-drag.ts`, `nested-editors.ts`, `agent-cursor.ts`, `ui-control.ts`: Cohesive deep modules powering Electron-native screenshots, `TreeWalker` waits, protected-area & DevTools/password enforcement, inspect redaction, focus-shielded input replay, HTML5/pointer drag, nested editor commits, and rAF-coalesced multi-agent visual cursors.
- `src/services/`:
  - `herdr-coordinator.ts`: Central state coordinator uniting `HerdrCliClient`, `HerdrSocketClient`, `VaultBridgeServer`, `VaultOpsService`, socket-first debounced refreshes, single-flight self-heal, and agent transition notices.
  - `obsidian-ui-adapter.ts`: Bridges Obsidian `MarkdownView`, Bases, Canvas, and terminal leaves with `UiControlService`, `VaultOpsService`, and `AgentCursorOverlay`.
  - `layout-notes.ts`: Export/apply Herdr split layouts to and from Markdown vault notes.
- `src/ui/`:
  - `dashboard-view.ts` + `dashboard/{types,agents-tab,vault-tab,doctor-tab}.ts`: Interactive halftone Mission Control dashboard with focus/draft-preserving reconciliation, spatial pane board with hover action dock & context menu, multi-line prompt composer, live output drawer, tactile 4-tier Vault permission rail, keyboard-accessible activity log, and click-to-spawn Doctor runtime grid.
  - `terminal-view.ts`: `HerdrTerminalView` (`ItemView`) managing `@xterm/xterm` v6, single-spawn PTY lifecycle, queued writes, high/low-watermark backpressure, tracked last-active `MarkdownView` selection send, and full disposal in `onClose()`.
  - `bases-view.ts`: `HerdrBasesView` (`BasesView`) rendering grouped live task cards inside `.base` files with agent-status diffing.
  - `markdown-widget.ts`: `HerdrCodeblockWidget` (`MarkdownRenderChild`) rendering interactive ```` ```herdr ```` playbook cards with explicit command confirmation.
  - `modals.ts`: `SpawnAgentModal` (installed runtimes grouped first, `Mod+Enter`), `DispatchNoteModal` (note/selection size summary, `Mod+Enter`), `CreateWorktreeModal`, `SelectProfileModal` (`FuzzySuggestModal`), `EditProfileModal`, and `confirmAction`.
  - `settings-tab.ts`: `HerdrSettingTab` (`PluginSettingTab`) using Obsidian 1.13+/1.14+ declarative `getSettingDefinitions()` with synchronized bridge settings and conditional UI-control sub-options.

## Lifecycle & build gates

- `onunload()` disposes `HerdrCoordinator` without calling `workspace.detachLeavesOfType()` (`OB-REV-003`).
- Every `HerdrTerminalView` disposes its `ResizeObserver`, `Terminal`, and `PtySession` (`SIGHUP` -> `SIGTERM` -> `SIGKILL`) in `onClose()`.
- `esbuild.config.mjs` enforces: zero raw HTML sinks in `main.js`, `main.js` under 2 MiB, zero em/en dashes in `main.js` and `styles.css`, Apache-2.0 SPDX headers on every `src/control/*.ts`, zero hardcoded `#hex` colors and zero `!important` declarations in `styles.css`.
