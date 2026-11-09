# Architecture Decision

Decision owner and date: Daniel Agrici, 2026-11-08.

## Problem and constraints

Users orchestrating multiple AI coding agents (`claude`, `codex`, `gemini`, `agent`, `opencode`, `amp`) in `herdr` need:
1. Interactive terminal panes inside Obsidian desktop that attach directly to persistent `herdr` sessions or vault shells without breaking across Electron ABI upgrades.
2. Live visibility and control over `herdr` protocol-20 workspaces, Git worktrees, split-pane layouts, and agent states (`working`, `blocked`, `done`, `idle`).
3. A safe, authenticated local mechanism allowing coding agents running inside `herdr` panes to read, search, create, update, patch YAML frontmatter, link-safe rename, trash, and open vault notes through Obsidian's own live APIs rather than raw unindexed filesystem writes.
4. Full compatibility with MIT licensing and Linux Flatpak Obsidian sandboxes (`md.obsidian.Obsidian`), targeting desktop (`minAppVersion: "1.14.4"`, `isDesktopOnly: true`, `< 2 MiB` bundle budget).

## Alternatives and decision

1. **PTY Backend**:
   - *Alternative A*: Bundle `node-pty` native C++ addon. Rejected because native Electron N-API/ABI binaries break across Obsidian Electron updates and require platform-specific prebuilds.
   - *Alternative B*: Copy `polyipseity/obsidian-terminal` Python helper. Rejected because `obsidian-terminal` is `AGPL-3.0-or-later`, which conflicts with MIT licensing.
   - *Selected Decision*: Clean-room MIT `PtySession` (`src/terminal/pty-host.ts`) using a compact inline Python 3 `pty.openpty()` bridge with file-descriptor-3 `TIOCSWINSZ` resize + `SIGWINCH`, plus standard-pipe fallback when Python 3 is absent. Works identically on host Linux/macOS and inside Flatpak `md.obsidian.Obsidian` (`/usr/bin/python3` `3.14.8` is preinstalled in the Flatpak runtime).
2. **Vault Control Transport & Agent Tooling**:
   - *Alternative A*: Loopback HTTP TCP server on `127.0.0.1`. Rejected because any local process or browser tab could probe loopback ports, and port collisions occur across multiple open vaults.
   - *Selected Decision*: Per-vault mode-`0600` Unix domain socket (`~/.cache/obs-herdr/<12-hex>/b.sock`, ~60 bytes, shared across host and Flatpak `filesystems=home` while staying well below the 104/108-byte `sun_path` limit; Windows named pipe on `win32`) protected by a per-session 256-bit bearer token checked via `crypto.timingSafeEqual`. Provision dual Node.js (`obs-herdr-core.mjs`) and Python 3 (`obs-herdr-core.py`) engines behind a single `obs-herdr` CLI + `obs-herdr mcp` stdio MCP server + `herdr-plugin.toml`.
3. **Settings Surface**:
   - *Selected Decision*: Declarative `PluginSettingTab.getSettingDefinitions()` (`@since 1.13.0`, compatible with `minAppVersion: "1.14.4"`), indexing all 16 settings in Obsidian's global Settings search bar.

## Contracts

| Boundary | Owner | API and source | Failure and cleanup |
|---|---|---|---|
| Domain state | `HerdrCoordinator` (`src/services/herdr-coordinator.ts`) | Herdr socket RPC protocol `20` + CLI JSON (`herdr --skill`) | Falls back to labeled offline preview or empty state; `dispose()` clears timers and closes sockets |
| Per-leaf UI | `HerdrDashboardView`, `HerdrTerminalView`, `HerdrBasesView`, `HerdrCodeblockWidget` | `ItemView`, `BasesView`, `MarkdownRenderChild` (`SRC-01-002`, `SRC-02-001`, `SRC-02-002`) | Unsubscribes listeners, disconnects `ResizeObserver`, disposes xterm.js and kills child PTY in `onClose()` / `onunload()` |
| Vault/metadata access | `VaultOpsService` (`src/bridge/vault-ops.ts`) | `Vault.process`, `FileManager.processFrontMatter`, `FileManager.renameFile`, `FileManager.trashFile`, `MetadataCache` (`SRC-04-023`, `SRC-04-025`) | Rejects restricted methods by permission tier, blocks dot/config/traversal paths, records pre-mutation undo snapshots |
| Settings and storage | `HerdrPlugin` + `HerdrSettingTab` (`src/ui/settings-tab.ts`) | `loadData`, `saveData`, `getSettingDefinitions` (`SRC-01-002`) | `migrateSettings()` validates and clamps every field idempotently |
| Background resources | `VaultBridgeServer`, `HerdrSocketClient`, `PtySession` | `node:net`, `node:child_process`, `window.setTimeout` | Socket unlinked on stop; reconnect timer cancelled on dispose; child PID terminated on pane close |
| External services | None | Zero `fetch` / `requestUrl` / external WebSockets (`SRC-01-005`) | N/A (strictly local IPC) |

## Verification and change

Verified via `npm run check` (`tsc 5.8.3`), `npm run build` (`main.js` `710,462` bytes, SHA-256 `444a0ba99f3a3fc3d5e16563c128283a8c7f8fe895b93831c9eddd37c15b84f4`), `npm run lint -- --max-warnings=0` (`0` warnings), `npm test` (`6/6` unit + live `herdr 0.8.2` + PTY + MCP tests), `plugin_review_audit.py --strict` (`100/100`), and headless Obsidian `1.15.0` E2E verification (`docs/ACCEPTANCE.md`).
