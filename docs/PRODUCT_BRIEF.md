# Product Brief

Purpose: Run Herdr persistent agent workspaces and interactive PTY terminals inside your vault while letting coding agents inspect, edit, and navigate notes safely over a local Vault Control Bridge.

Owner: Daniel Agrici. Surface: Workspace dashboard, embedded PTY terminal view, Obsidian Bases task board, Markdown codeblock processor, and local Vault Control Bridge. Intended platforms: desktop (`isDesktopOnly: true`).

## Definition of done

- [x] Provide embedded interactive PTY terminal views powered by xterm.js and a zero-native-ABI PTY bridge that attach to Herdr persistent sessions, remote SSH sessions, or local shells (`src/ui/terminal-view.ts`, `src/terminal/pty-host.ts`).
- [x] Connect directly to the Herdr Unix socket and CLI to inspect and control live sessions, workspaces, Git worktrees, tabs, split panes, layouts, and coding agents in real time (`src/herdr/socket-client.ts`, `src/herdr/cli-client.ts`, `src/services/herdr-coordinator.ts`).
- [x] Subscribe to Herdr runtime events so agent lifecycle transitions across working, blocked, done, and idle states update Mission Control, tab badges, and optional desktop notices immediately (`HerdrSocketClient.startSubscription`, `HerdrCoordinator.detectAgentStateTransitions`).
- [x] Render a responsive Mission Control dashboard with live agent output previews, prompt dispatch, blocked-agent quick keys, workspace topology maps, and offline preview diagnostics (`src/ui/dashboard-view.ts`, `src/domain/demo-fixture.ts`).
- [x] Host an authenticated local Vault Control Bridge socket server with Read-Only, Read-Write, and Full permission tiers, vault path sandboxing, and a reversible mutation audit log (`src/bridge/vault-bridge-server.ts`, `src/bridge/vault-ops.ts`, `src/domain/path-guard.ts`).
- [x] Provision the standalone obs-herdr CLI and stdio MCP server plus environment variables into Herdr workspaces and terminal panes so coding agents can read, search, edit, and navigate the live vault (`src/bridge/runtime-kit.ts`).
- [x] Perform vault note mutations exclusively through safe Obsidian APIs including `Vault.process`, `FileManager.processFrontMatter`, `FileManager.renameFile` for link updates, and `FileManager.trashFile` (`src/bridge/vault-ops.ts`).
- [x] Provide an optional linkable `herdr-plugin.toml` workflow package so Herdr native actions and event hooks can open notes, capture pane transcripts, and query vault context (`src/bridge/runtime-kit.ts`, `HerdrCoordinator.linkVaultPluginInHerdr`).
- [x] Synchronize terminal palettes, typography, and dashboard surfaces automatically with Obsidian dark and light CSS custom properties and container queries with zero important overrides (`styles.css`, `src/terminal/theme-palette.ts`).
- [x] Detect wiki links, `obsidian://` URIs, and vault file paths with line numbers inside terminal output and open the target note directly in an Obsidian editor leaf (`src/terminal/link-provider.ts`).
- [x] Dispatch active note content, editor selections, frontmatter, and backlink neighborhoods to any Herdr agent or pane in one action from commands, menus, or Mission Control (`src/main.ts`, `src/ui/modals.ts`, `src/ui/dashboard-view.ts`).
- [x] Render `herdr` Markdown codeblock widgets and an Obsidian Bases agent board view with full lifecycle cleanup across split leaves and workspace reloads (`src/ui/markdown-widget.ts`, `src/ui/bases-view.ts`).
- [x] Pass strict TypeScript checks, esbuild bundle verification with zero raw HTML sinks, `eslint-plugin-obsidianmd` with zero warnings, automated integration tests against `herdr`, and `100/100` static review.
- [x] Verify real desktop execution in an isolated headless Obsidian `1.15.0` instance with an active `herdr 0.8.2` session and live Vault Control Bridge round-trips.

## Completed product decisions

- **Primary user and recurring task**: Desktop developers, technical writers, and AI workflow builders running Claude Code, Codex, Gemini CLI, Cursor CLI, OpenCode, or Amp inside `herdr` sessions while maintaining specs, architecture docs, roadmaps, and knowledge graphs inside an Obsidian vault.
- **Input format, representative vault size, and edge cases**: Markdown notes (`.md`), Canvas boards (`.canvas`), and Bases views (`.base`); bounded search/list limits (`limit` capped at `200` / `2000`), path traversal and dot-directory sandboxing (`guardVaultRelativePath`), POSIX `sun_path` socket length cap (`~/.cache/obs-herdr/<12-hex>/b.sock` ~60 chars), and Flatpak `XDG_CONFIG_HOME` / Python 3 fallback support.
- **Loading, empty, error, narrow-pane, keyboard, and theme behavior**: Labeled offline preview topology when daemon is stopped (`showOfflinePreviewWhenStopped`), explicit error cards without stack-trace secret leakage, `@container herdr-pane (max-width: 560px)` single-column collapse, native `<button>` focus rings, and dynamic dark/light palette rebuilds on `css-change`.
- **Data schema, migrations, backup, and recovery**: Versioned `HerdrPluginSettings` (`schemaVersion: 1`) migrated idempotently via `migrateSettings()`; in-memory reversible mutation snapshots (`created`, `modified`, `renamed`) with one-click `undoMutation()` in Mission Control.
- **Network services, secret handling, and paid accounts**: Zero external network requests, zero telemetry, zero persisted credentials. Per-session 256-bit random bearer token lives only in memory and a mode-`0600` local connection file inside a mode-`0700` user-owned runtime directory.
- **Measured performance budgets and supported app versions**: `minAppVersion: "1.14.4"` (verified against `obsidian@1.14.4` TypeScript declarations and runtime tested in Obsidian `1.15.0`); bundle `710,462` bytes (`< 2 MiB` budget); measured plugin enable + initialization `69.2` ms in headless Obsidian `1.15.0`.
- **License and public release channel**: MIT License (`LICENSE`, `THIRD_PARTY_NOTICES.md`); clean-room terminal implementation with zero `AGPL-3.0` code from `polyipseity/obsidian-terminal`. Public GitHub release and Community Directory PR remain gated on explicit owner authorization.
