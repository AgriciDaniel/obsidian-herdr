# UI State Specification

Primary task and starting trigger: Open **Herdr Mission Control** (`herdr-view`) or **Herdr terminal** (`herdr-terminal-view`) via left ribbon icons (`cpu`, `terminal`), Command Palette, `obsidian://herdr` URI, `.base` task board, or ```` ```herdr ```` Markdown embed.

| State | Visible information | Available action | Focus/announcement | Acceptance evidence |
|---|---|---|---|---|
| Loading | Mission Control header and current cached/initial metrics while async socket/CLI probe completes | Refresh button, Open terminal | Preserves active leaf focus without stealing editor cursor | Verified in headless Obsidian `1.15.0` (`loadMs: 69.2` ms) |
| Populated | Live `Daemon: Live` pill, workspace/pane counts, working/done/blocked counters, proportional pane layout map, live terminal tail, Vault Bridge status, and audit rows | Focus/split/zoom panes, send prompt/keys, open terminal, copy CLI/MCP config, link Herdr plugin, Undo audit mutation | Native `<button>` focus order and `Notice` feedback on explicit actions | Verified (`01_mission_control_and_terminal_dark.png`, `02_vault_bridge_audit_and_note.png`) |
| Empty | When `serverRunning` is `true` with `0` agents, explains how agents appear and offers one-click spawn | `Spawn agent in split pane` (`mod-cta`), `Open embedded terminal` | Action buttons keyboard-reachable inside `.herdr-empty-card` | Verified (`Agents (0)` tab and live E2E) |
| Invalid input | Inline validation `Notice` when required modal fields (agent name, branch name, note target) or Vault Bridge paths fail validation | Edit field and resubmit or press `Esc` to close modal | Focus remains in active modal input | Verified in unit tests (`guardVaultRelativePath`) and modal guards |
| Partial/missing data | Unknown pane statuses render neutral `unknown` badge; missing frontmatter fields in Bases default to `backlog` / unassigned | Refresh state or dispatch note manually | Labels unknowns explicitly rather than hiding panes | Verified (`01_mission_control_and_terminal_dark.png`, `03_bases_and_markdown_embed_light.png`) |
| Offline/failure | When `herdr` daemon is stopped, displays either `Offline preview` banner with labeled sample topology or stopped empty state, plus any socket error string without tokens | `Start session` (`Start vault Herdr session`), `Open terminal`, toggle offline preview | Status bar shows `Herdr: idle` | Verified in initial offline check and unit fixtures |
| Cancelled | Closing any modal or terminal leaf aborts pending UI flow cleanly and kills only that leaf's `PtySession` while keeping persistent `herdr` background sessions intact | Reopen modal or reattach to persistent session | Workspace returns focus to remaining active leaf | Verified across leaf detach and plugin hot-reload |

## Layout and interaction

- **Light and dark themes**: Zero hardcoded hex colors (`css_hardcoded_hex_count: 0`) and zero `!important` rules in `styles.css`. `buildObsidianXtermTheme()` recomputes terminal foreground, background, cursor, selection, and ANSI colors whenever `workspace.on("css-change")` fires.
- **Narrow split panes**: `.herdr-root` declares `container-type: inline-size; container-name: herdr-pane;`. Below `560px`, `.herdr-agent-grid` and `.herdr-kv-grid` collapse cleanly to single-column layouts with wrapped action rows.
- **Readable visual alternative**: Every proportional `.herdr-layout-map` canvas is paired immediately underneath with `.herdr-pane-list` text rows listing `pane_id`, agent/shell title, status badge, and `Split right` / `Split down` / `Zoom` `<button>` controls.
- **Declarative settings**: `HerdrSettingTab` renders 16 settings across 3 groups via `getSettingDefinitions()` in Obsidian 1.15.0's Settings window (`04_declarative_settings_tab.png`).

## Evidence

- App / OS: Headless Obsidian `1.15.0` (Flatpak `md.obsidian.Obsidian` Electron host `1.14.5`) on Linux `7.2.7-200.fc44.x86_64` with live `herdr 0.8.2`.
- Bundle: `main.js` (`710,462` bytes, SHA-256 `444a0ba99f3a3fc3d5e16563c128283a8c7f8fe895b93831c9eddd37c15b84f4`), `styles.css` (`19,357` bytes, SHA-256 `94e36c50451c4b0ddce3b2512a760673228a0cdf51addce351a8ab47746898cd`).
- Captured screenshots: `01_mission_control_and_terminal_dark.png`, `02_vault_bridge_audit_and_note.png`, `03_bases_and_markdown_embed_light.png`, `04_declarative_settings_tab.png`.
- Remaining gap: Visual screenshots and headless DOM probes do not substitute for human screen-reader (Orca / VoiceOver / NVDA) usability testing.
