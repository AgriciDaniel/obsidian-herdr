# Acceptance Record

Recorded on `2026-11-09` (release `0.2.0`) on `Linux 7.2.7-200.fc44.x86_64` (Aurora Kinoite), Node.js `v24.22.1`, npm `11.21.1`, TypeScript `5.8.3`, ESLint `v10.14.0` (`eslint-plugin-obsidianmd@0.4.2`), `herdr 0.8.2` (protocol `20`), `codex-cli 0.167.0`, and Flatpak Obsidian `1.15.0` (Electron host `1.14.5`).

## Evidence summary matrix

| Evidence class | Status | Recorded result |
|---|---|---|
| Product acceptance | Verified (local desktop) | All 14 criteria in `docs/PRODUCT_BRIEF.md` implemented and exercised across unit, live `herdr 0.8.2`, live `codex-cli 0.167.0`, headless Obsidian `1.15.0` CDP, and live Wayland desktop Obsidian `1.15.0` via `Obsidian Control Center` (`obsidian-cli`) |
| TypeScript | Verified (`exit 0`) | `npm run check` (`tsc --noEmit`, TypeScript `5.8.3`, `0` errors) |
| Bundle | Verified (`exit 0`) | `npm run build` (`esbuild 0.28.2`, `main.js` `743,492` bytes, SHA-256 `388eb5994d1bcd5ba614752cd59e1d71d94962796f48c64b7bc01df960c3683e`, `obsidian` and `node:*` externalized, `0` raw HTML sinks, `0` em/en dashes) |
| Official lint | Verified (`exit 0`) | `npm run lint` (`eslint src --max-warnings=0` with `eslint-plugin-obsidianmd@0.4.2`, `0` errors, `0` warnings) |
| Automated unit + live daemon tests | Verified (`exit 0`) | `npm test` (`7/7` tests across `4` suites in `1796.12` ms: OSC parser, path guard, shell quoting, settings migration, `obsidian://` URI parser, Canvas-safe Obsidian terminal font resolution + Flatpak `PATH`/`SHELL` normalization, live POSIX `PtySession` `TIOCSWINSZ` resize, live `VaultBridgeServer` + `node_modules`/`.git` scan exclusion + persistent token continuity + `obs-herdr` Node & Python 3 CLI + `16`-tool annotated stdio MCP parity + `canvas upsert` + undo, and live isolated `herdr 0.8.2` daemon session + JSON `session list` for long names + split pane + `obsidian.vault` plugin link/unlink + `layout.export` + `layout.apply` + `agent.view.set`/`clear` + `server.stop`) |
| Static review audit | Verified (`exit 0`) | `plugin_review_audit.py --strict` (`100/100`, `gate_status: "static-signals-clear"`, `10` pass, `0` critical/warning/info/unknown, `css_hardcoded_hex_count: 0`; saved in `docs/STATIC_REVIEW.md`) |
| Desktop runtime + live Codex CLI (Linux Flatpak Obsidian + Obsidian Control Center) | Verified (`exit 0`) | Verified in both isolated headless Flatpak Obsidian `1.15.0` over CDP and live Wayland desktop Obsidian `1.15.0` (`vault=f4b597348be087bf`, `3440x1396`) driven via `Obsidian Control Center` (`obsidian-cli`): official `obsidian-cli herdr` handler verified, Command Palette + `Doctor & sessions` runtime detection + `Vault Bridge` live self-test verified, `SpawnAgentModal` full-width prompt inputs verified, and `codex-cli 0.167.0` executed `obsidian_vault.obsidian_vault_info` over stdio MCP reporting the exact `14` vault Markdown notes (`node_modules/` excluded) |
| Lifecycle | Verified (`exit 0`) | Split leaves (`herdr-view` + `herdr-terminal-view`, `Agent Board.base` + `Welcome.md`), leaf `detachLeavesOfType` teardown during test switching, persistent bridge token across plugin reloads (`readExistingBridgeToken`), and plugin hot-reload (`disablePlugin("herdr")` + `enablePlugin("herdr")`) with `0` console errors and `0` exceptions |
| Rendering | Verified (Linux desktop dark + light) | Verified in Obsidian dark theme (`obsidian`) and light theme (`moonstone`), `styles.css` (`0` `!important`, `0` `#hex`), `@container herdr-pane` rules, wrapped narrow-sidebar tabs and cards, and standalone Obsidian `1.15.0` Settings window (`01..05` screenshots) |
| Physical iOS/Android | Not applicable (by design) | `manifest.json` sets `"isDesktopOnly": true` because local PTY spawning, Unix domain sockets, and `herdr` CLI execution require desktop OS capabilities; mobile platforms are not advertised |
| Native macOS & Windows physical hardware | Unverified | Cross-platform paths, PowerShell quoting, Windows named pipes, and non-Python pipe fallback are implemented in code and unit-tested where portable, but have not been executed on physical macOS or Windows machines |
| Security and privacy | Verified (local code + runtime tests) | `0` `fetch`/`requestUrl`/external WebSocket calls; mode-`0700` runtime dir + mode-`0600` socket/connection/MCP config files; 256-bit random token checked with `crypto.timingSafeEqual`; invalid token, `read-only` write attempts, `..` traversal, NUL bytes, absolute paths, `Vault#configDir`, `.git`, and `.env*` blocked in tests |
| UI control module (`src/control`, Apache-2.0) | Verified (Linux desktop) | Unit + bridge + CLI + MCP tests (`3` new tests) and a live run in Wayland desktop Flatpak Obsidian `1.15.0` through the real `obs-herdr` CLI and both MCP engines; see section 4 |
| Directory acceptance | Unverified | Requires owner approval, public GitHub release `0.1.0`, and manual human review by the Obsidian team in `obsidianmd/obsidian-releases` |

## Exact command outputs

### 1. TypeScript, bundle, strict lint, and automated integration tests

```text
$ npm run check && npm run build && npm run lint && npm test

> herdr@0.1.0 check
> tsc --noEmit

> herdr@0.1.0 build
> tsc --noEmit && node esbuild.config.mjs

{
  "bytes": 742895,
  "externalImports": ["obsidian", "node:child_process", "node:crypto", "node:fs", "node:net", "node:os", "node:path"]
}

> herdr@0.1.0 lint
> eslint src --max-warnings=0

> herdr@0.1.0 test
> node scripts/run-tests.mjs

✔ Domain: OSC stream observer, path guard, shell quoting, and settings migration (2.204375ms)
✔ Terminal: Live POSIX PtySession with resize over control FD (174.021078ms)
✔ Vault Control Bridge: Authenticated socket, permission tiers, obs-herdr CLI, undo, and stdio MCP (293.25917ms)
✔ Live Herdr 0.8.2 Daemon Integration (isolated config & session) (1292.738929ms)
ℹ tests 7 | suites 4 | pass 7 | fail 0 | duration_ms 1796.122752
```

### 2. Live Wayland desktop (`Obsidian Control Center`) + isolated Flatpak Obsidian `1.15.0` + `codex-cli 0.167.0` E2E telemetry

```json
{
  "obsidianControlCenterDesktopRun": {
    "vault": "f4b597348be087bf",
    "viewport": { "width": 3440, "height": 1396, "devicePixelRatio": 1 },
    "officialCliHandler": {
      "session": "vault-obsidian-herdr",
      "serverRunning": true,
      "bridgeRunning": true,
      "permissionMode": "read-write"
    },
    "codexMcpVaultInfoReport": "The vault is Obsidian-herdr and contains 14 Markdown notes."
  },
  "headlessCdpCodexRun": {
    "spawnedAgent": {
      "name": "codex",
      "agent": "codex",
      "status": "idle",
      "interactiveReady": true,
      "paneId": "w1:p2"
    },
    "promptFinalStatus": "done",
    "pane1ShellAndBinsVerified": true,
    "noteCreatedByCodex": true,
    "createdBody": "Created by Codex CLI over the Herdr Obsidian MCP bridge.",
    "auditCount": 1,
    "consoleErrors": [],
    "exceptions": []
  }
}
```

### 3. Live retest and fixes (2026-11-09, Claude Code driving Obsidian Control Center 0.3.0)

Live Wayland desktop Flatpak Obsidian `1.15.0`, `herdr 0.8.2`, dev vault and a separate demo vault. Exercised: embedded Herdr TUI, Mission Control (Live, Agents, Vault Bridge, Doctor), Stop session and offline preview fallback, `app:reload` with the Herdr daemon and agents surviving and the terminal reattaching, split panes, `obs-herdr` `vault info`, `note list/search/create/update/frontmatter/trash`, `workspace open/notice`, the live bridge self-test (`Bridge OK ... mode=read-write`), the audit log with Undo, the Bases `herdr-agent-board` view with live agent matching, and the `herdr` codeblock. Four real agents (`claude`, `codex`, `agy`, `opencode`) were launched without prompts and reported by Mission Control as `4 agents`.

Defects found and fixed:

| Defect | Cause | Fix |
|---|---|---|
| `obs-herdr: command not found` inside Herdr panes after Obsidian restored a terminal tab | The restored terminal started the Herdr daemon before the Vault Bridge was up, so the daemon and every pane inherited no bridge `PATH` or env | `HerdrCoordinator.ensureBridgeReady()` starts the bridge (single-flight) before any daemon start or PTY spawn (`src/services/herdr-coordinator.ts`, `src/ui/terminal-view.ts`). Verified: restarted daemon env carries `OBSIDIAN_HERDR_CLI` and the bin dir first on `PATH`; `which obs-herdr` resolves in panes |
| Live Herdr daemon test failed when `TMPDIR` is deep | Herdr session socket path exceeded the 107 byte Unix socket limit | Test uses a short `/tmp/ohd-*` root and session name (`tests/all.test.ts`) |
| Status bar and codeblock said `1 agents` | Missing singular form | Pluralized (`src/main.ts`, `src/ui/markdown-widget.ts`) |

Final run (`npm run check && npm run build && npm run lint && npm test`): exit `0`, `7/7` tests across `4` suites in `2254.83` ms, `main.js` `743,492` bytes. This remains a single Linux desktop result; macOS and Windows are still unverified.

### 4. UI control module (2026-11-09, ported from Obsidian Control Center into `src/control`)

Feasibility probe before the port, run inside the live Obsidian `1.15.0` renderer (Electron `43.8.3`, Chrome `150.0.7871.250`) in the Herdr Demo Vault: `electron.remote.getCurrentWebContents()` present; `capturePage()` returned a non-empty `1920x1080` PNG (`182,446` bytes); `sendInputEvent` mouse and key events on a temporary overlay arrived as trusted DOM events (`mousedown`, `mouseup`, `click`, `keydown`, `input`, `keyup`, all `isTrusted: true`) while the window did not have focus; `insertText` inserted Unicode; the overlay was removed and focus restored.

Gates on the final source:

```text
$ npm run check   -> tsc --noEmit, exit 0
$ npm run build   -> exit 0, main.js 767,667 bytes (2 MiB budget), "electron" external, 0 raw HTML sinks, 0 em/en dashes
$ npm run lint    -> eslint src --max-warnings=0, exit 0, 0 warnings
$ npm test        -> exit 0
✔ UI control: keys, Electron input, permission gating, CLI, and MCP images (206.021556ms)
✔ Domain: OSC stream observer, path guard, shell quoting, and settings migration (2.546984ms)
✔ Terminal: Live POSIX PtySession with resize over control FD (175.963258ms)
✔ Vault Control Bridge: Authenticated socket, permission tiers, obs-herdr CLI, undo, and stdio MCP (490.894168ms)
✔ Live Herdr 0.8.2 Daemon Integration (isolated config & session) (1140.569157ms)
ℹ tests 10 | suites 5 | pass 10 | fail 0 | duration_ms 2072.916479
```

Live desktop run (Wayland, Flatpak Obsidian `1.15.0`, Herdr Demo Vault, built `main.js` installed and hot-reloaded, `allowUiControl` and `full` set in memory only, no `data.json` written), all through the generated `obs-herdr` CLI:

| Check | Result |
|---|---|
| `vault info` | `uiControl.available: true` from the bundled plugin; `enabled: false` by default |
| `ui screenshot --max-width 1280` | `1280x682` PNG of the real window, `cssPixelsPerImagePixel` `1.466` for a `1876x1000` viewport |
| `ui inspect` | `52` visible controls with labels, selectors, and CSS bounds |
| `ui click` (editor of a scratch note), `ui key Mod+End`, `ui key Enter`, `ui type` with `ünïcödé ✓ 🐑` | Text typed and saved to disk by Obsidian; `ui wait` found it in `1` ms |
| Audit and Undo | `ui.type` and `ui.press_key Enter` recorded with caller `obs-herdr-cli` and `modified` snapshots; `undoMutation` restored the note exactly |
| `ui key Mod+P`, `ui key Escape` | Command palette `.prompt` count `1`, then `0` |
| `ui scroll --dy 400` then `--dy -400` | Editor `scrollTop` `2203` to `2603` to `2203` (positive scrolls down) |
| `ui drag` on the right sidebar resize handle | Width `200` to `301` and back to `200` |
| `obs-herdr mcp` (Node) and `obs-herdr-core.py mcp` (Python) | `24` tools; `obsidian_screenshot` returned `image/png` content (`83,440` bytes, valid PNG signature) plus JSON text |
| Refusals | Ambiguous selector `ui_target_ambiguous` (`162` matches); `ui.click` under `read-write` `permission_denied`; screenshot with the setting off `ui_control_disabled` |
| Final bundle smoke | SHA-256 of installed `main.js` equals the repo build; screenshot `1876x1000` with the setting on; setting returned to off |

Cleanup: scratch note trashed and removed from the demo vault trash, test screenshots deleted, demo vault back on default settings. Not verified: macOS, Windows, HiDPI scaling, Obsidian zoom other than `1`, pop-out windows, and native dialogs.

### 5. Multi-agent visual cursor overlay and parallel execution (2026-11-15, historical capture)

- Added `AgentCursorOverlay` (`src/control/agent-cursor.ts`) with per-agent spring physics, fade-in on spawn, click ripple rings, typing/action badges, `1500 ms` idle dimming, `8000 ms` initial auto-hide default (later raised to `60000 ms` in Section 6), `prefers-reduced-motion` support, and full `dispose()` cleanup.
- Added atomic `ui.batch` (`src/control/ui-control.ts`, `src/bridge/vault-ops.ts`, `src/bridge/runtime-kit.ts`, `25` MCP tools, `SHARED_SKILL_TEXT` help) and per-path async locking (`withPathLock`) in `VaultOpsService` for parallel note and Canvas writes, plus `ui.press_key` cursor feedback.
- Gates after final edit (`npm run check && npm run build && npm run lint && npm test`): exit `0`, `11/11` tests across `5` suites in `2560.67` ms, `0` ESLint warnings/errors, `main.js` `778,961` bytes, `plugin_review_audit.py --strict` `100/100` (`gate_status: "static-signals-clear"`, `css_hardcoded_hex_count: 0`).
- Live isolated Flatpak Obsidian `1.14.5` desktop run (`/tmp/ohd-live-test`, cleaned up afterward): opened `NoteA.md` and `NoteB.md` in split panes, ran `HERDR_PANE_ID=claude:w1:p1 obs-herdr ui batch` (click + type `"Typed atomically by Claude!"`) in parallel with `HERDR_PANE_ID=codex:w1:p2 obs-herdr note update NoteB.md --mode append`, and visually verified via `ui screenshot` (`1280x1039` PNG) that both color-coded cursors (`claude:w1:p1 typing`, `codex:w1:p2 edit` with ripple ring) and idle dimming (`claude-w1:p1 click`) rendered cleanly over their respective panes. Updated `.herdr-cursor-pill` lightness to `34%` afterward for higher text contrast across all hues.

#### Section 5 dependency and artifact SHA-256 hashes (2026-11-15 capture)
| File | Bytes | SHA-256 |
|---|---:|---|
| `main.js` | `778961` | `2a7137510ef2de924036e66a27a68ebf2e6fd6e45637fb6c24c78c02f3ba0b3d` |
| `manifest.json` | `404` | `56ca321ad6f89b0ff90e851c8b9e7b801ee7fbb33b0fce4d3f6d2ab7487214e6` |
| `styles.css` | `22286` | `0dcef1824634af1a6ca86f0c2d86d0e6467385a59732c11bdcf65a75b5936cc7` |
| `versions.json` | `45` | `ca324faefba6fbffcd9d622e46d2c07f3fd2740ff1140dce026a087c34a62937` |
| `package.json` | `1148` | `7f5d5ebc1a69c541206d19cf78eebc56012a22aed150776f474680ac8d1f7bbd` |
| `package-lock.json` | `191923` | `7b37af04a258548b249052bd035d86afa6e95e1ddd37f3f4347e5378aa41323c` |
| `LICENSE` | `1070` | `fe617d451da04ca0ed4ccbcc054574429712fa3e99fcea05d205b2c6a6573f13` |
| `src/control/LICENSE` | `11358` | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| `NOTICE` | `697` | `2da6936fb0e557bb5a919962e85b902a0707e7f8a98081d1f277e4e753323919` |
| `THIRD_PARTY_NOTICES.md` | `1752` | `b9a795457258171354ba15ac8e9a6a78458b9d2ebb755c5612828d1a2286d65c` |
| `README.md` | `7162` | `a18cef7f974c7690af49ab98dc50fb85873f639c961a862a9be952a25a065308` |

### 6. Release `0.3.0`: Audit fixes, drag/nested editors, screen-mode cursors, and current gates (2026-11-16)

- Release bump (`4280903` + `0.3.0` prep and post-commit audit/final fixes): `manifest.json`, `package.json`, `package-lock.json`, and `versions.json` (`"0.3.0": "1.14.4"`) updated to `0.3.0`.
- Visual cursors (`src/control/agent-cursor.ts`, `styles.css`): screen mode for targets outside note panes (tab headers, ribbon, sidebars, status bar, menus, modals, Mission Control) re-entering doc mode on the next note action, time-bounded glide (`max 180 ms`) with `whenSettled(caller)` and stalled-RAF deadline snap, widget anchoring across DOM re-renders (x/y match tolerances so same-row carets do not pull checkbox cursors away), cross-window `ownerDocument` guard, rename-abort cursor preservation on the current partial streamed line, and `.herdr-cursor-layer` compositing isolation above modals/notices.
- Drag, nested editors, UI safety, and per-file Undo (`src/control/ui-control.ts`, `src/control/keys.ts`, `src/control/html-drag.ts`, `src/control/nested-editors.ts`, `src/bridge/vault-ops.ts`, `src/services/herdr-coordinator.ts`):
  - Protected window controls (`.titlebar`, `.titlebar-button-container`, `.mod-close`, quit shortcuts/palette actions) and agent Settings opening/input refused with `ui_protected_area` (with `Mod+,` accelerator dropped for agents while user `Ctrl+,` / `Ctrl+P` stays unaffected).
  - Punctuation keys and zoom accelerators (`Mod+=`, `Mod+-`, `Mod+0`) mapped with visible cursors; `ui.hover` and note-only `ui.scroll` added; HTML5 draggable drag-and-drop and Canvas pointer drags (`html-drag.ts`); Canvas card and Bases row editing (`nested-editors.ts`) with file/row snapshots and honest trash deletion failure (`ui_effect_failed`); Phase 1 raw-key/modal replay fixes (`raw-key-regressions.test.ts`); and per-file command tracking for Mission Control Undo.
- Bridge CLI/docs parity (`src/bridge/runtime-kit.ts`, `README.md`): unified strict lexical parsing across Node and Python, `SHARED_MCP_TOOLS.length` (`25` tools) aligned in CLI help and `README.md`, and documented `insert-line` proof fields, protected-area refusals, and typing speed.

Acceptance and runtime status for `0.3.0`:
- Automated verification on the current build: `89/89` tests passing across `9` suites (`7172.62` ms), TypeScript check exit `0`, esbuild bundle exit `0` (`main.js` `974470` bytes), strict ESLint exit `0` (`0` warnings), zero em/en dashes.
- Live Obsidian `1.15` on Linux (reported by the orchestrator on `2026-11-16`):
  - Full Obsidian live audit by 4 agents, followed by installed rerun `41/45 PASS`, followed by the final fix round (`89/89` unit/integration gates passing on the current build; live rerun of the final-fix items awaits install/retest).
  - Verified live: anchored `insert-line` under concurrent user terminal input; cursor tip on the caret mid-typing; offscreen anchored insert scrolls and returns proof; parked cursor follows text; Canvas card move, HTML5/pointer drag-and-drop, cursor rendering on tabs/sidebars/menus/modals/Mission Control, Mission Control Undo, and protected window controls/quit/Settings (agent-opened Settings refused with `ui_protected_area`; agent-opened Settings previously wedged Obsidian modals, addressed in the final-fix build; user path `Ctrl+,` then `Ctrl+P` works).
- Known limits:
  - Pop-out windows are outside the main window host and return clear `ui_target_not_found`.
  - Graph view exposes `<canvas>` pixel coordinates only (no semantic per-node DOM targets).
  - Flatpak system trash fails in this environment and is reported honestly via `ui_effect_failed`.
  - Agent Settings access is blocked by design unless `allowUiInProtectedAreas` is enabled.
- Still pending: installed-build verification of the final-fix round; physical macOS and Windows hardware verification; Obsidian team directory review.

```text
> herdr-obs@0.3.0 build
> tsc --noEmit && node esbuild.config.mjs
-> exit 0, main.js 974470 bytes ("obsidian", "@codemirror/view", "electron", and "node:*" externalized)

> herdr-obs@0.3.0 check
> tsc --noEmit
-> exit 0

> herdr-obs@0.3.0 lint
> eslint src --max-warnings=0
-> exit 0, 0 warnings

> herdr-obs@0.3.0 test
> node scripts/run-tests.mjs
-> exit 0
✔ UI control: keys, Electron input, permission gating, CLI, and MCP images (1234.368289ms)
✔ Domain: OSC stream observer, path guard, shell quoting, and settings migration (1.412114ms)
✔ Terminal: Live POSIX PtySession with resize over control FD (172.927721ms)
✔ Vault Control Bridge: Authenticated socket, permission tiers, obs-herdr CLI, undo, and stdio MCP (3405.463294ms)
✔ Live Herdr 0.8.2 Daemon Integration (isolated config & session) (1671.377444ms)
✔ AgentCursorOverlay: Round 3 collaborator presence, honest state, and lifecycle (615.77557ms)
✔ Raw key regressions: delayed agent input and modal replay (7.606303ms)
✔ html-drag: HTML5 drag-and-drop and pointer-event drags (1.869999ms)
✔ nested-editors helpers (4.511018ms)
ℹ tests 89 | suites 9 | pass 89 | fail 0 | cancelled 0 | skipped 0 | todo 0 | duration_ms 7172.620672
```

#### Exact dependency and artifact SHA-256 hashes (release `0.3.0`)
| File | Bytes | SHA-256 |
|---|---:|---|
| `main.js` | `974470` | `e793e4246abc0a51115fb11ba98a4fe99be0d32af213f6d04503335c9ecd4031` |
| `manifest.json` | `374` | `3e051ddfee910ae813fe61b9837cf22eacb995b7fb4d8244219c12ebba848604` |
| `styles.css` | `23943` | `8ff0988373c4a3d3aa797622d1a8b04464d55cdefd2402f0f812559d7ffc524e` |
| `versions.json` | `129` | `b88f1f7e1da12420a84ae56c0f1f14a5af160df9e7f6f7b2949145d71291f5b4` |
| `package.json` | `1152` | `09ec870fb2edec3011895b8c5d380e1d67b3fa4d80fb6787da71b6dbb403c4ac` |
| `package-lock.json` | `191939` | `ebb483bdfe82db2e0b761b420a0f85674462304614ae4c200bb02b3a98369c3e` |
| `LICENSE` | `1070` | `fe617d451da04ca0ed4ccbcc054574429712fa3e99fcea05d205b2c6a6573f13` |
| `src/control/LICENSE` | `11358` | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| `NOTICE` | `697` | `2da6936fb0e557bb5a919962e85b902a0707e7f8a98081d1f277e4e753323919` |
| `THIRD_PARTY_NOTICES.md` | `1752` | `b9a795457258171354ba15ac8e9a6a78458b9d2ebb755c5612828d1a2286d65c` |
| `README.md` | `8977` | `44a2c3fee9d708e3e2236d22bdc6ac7873ddf7fe658e4e22cb0caba84049ebe9` |

### 7. Release `0.3.2`: reliability fixes from a full review, live tests, and a cross-review (2026-11-20)

Work: one read-only review by two agents (code and live), three fix rounds with strict file ownership, a cross-review of each agent's code by the other, and orchestrator verification. Commits on top of `0.3.1` (`8895352`): `7a00784`, `5191d70`, the round 3 commit, and the Mission Control redesign commit. Change list: `CHANGELOG.md`, section `0.3.2`. Review and fix reports: `.agent/review-2026-11-20/`, `.agent/fix-2026-11-20/`, `.agent/round3-2026-11-20/` (local only).

Automated verification on the current build: `143/143` tests across `17` suites, TypeScript check exit `0`, esbuild bundle exit `0` (`main.js` `1018779` bytes), strict ESLint exit `0` (`0` warnings), zero em or en dashes in the diff. The installed `.obsidian/plugins/herdr-obs/main.js` is byte-identical to the build.

Live Obsidian `1.15.1` on Linux (Flatpak, Wayland), Herdr `0.8.2` protocol `20`, verified by the orchestrator on `2026-11-20` after installing and reloading:
- Trash: system trash fails in the Flatpak; `note trash` returns `method: local` and the note moves to the vault `.trash`.
- Rename with `alwaysUpdateLinks` unset: links updated, no "Update links" prompt, `app.json` unchanged; two concurrent renames updated both links and left `app.json` unchanged.
- `obs-herdr` against a socket that never answers exits `1` after `OBS_HERDR_TIMEOUT_MS`; a reload mid-command reports "Bridge connection closed before a complete response was received".
- Cache self-heal: the kit folder moved away while running was rebuilt in about 8 s with the same token.
- Stale kit cleanup on load: `255` to `118` folders in `~/.cache/obs-herdr`.
- MCP `serverInfo.version` `0.3.2`, `26` tools; `ui inspect` lists protected controls last with `protected: true`.
- Spawn window, driven through UI control with `ui select`: Codex and Claude Code initial prompts delivered exactly once (one `agent.prompt` call each in the Herdr server log), including a three-line prompt typed with `press_key Enter`.
- Mission Control redesign (Agents, Vault, Doctor; status line; menus): every tab, the header menu with a red Stop session, the Stop session confirmation (Cancel kept the session and all panes), and agent Escape closing an open menu, checked by screenshots after install.
- Panes `w2:p1` to `w2:p3` survived every reload. One unexplained renderer freeze and self-reload happened once (15:47) while testing the new panel; not reproduced; the Doctor tab PATH scan on every refresh was removed as a likely cause.

Not verified live: the Herdr protocol mismatch warning (Herdr matches), the Windows paths (no Windows machine), and Spawn cancel during a blocked start (Codex and Claude Code already trust the vault, so no start question appears). These are covered by automated tests only.

```text
> herdr-obs@0.3.2 check -> exit 0
> herdr-obs@0.3.2 lint (eslint src --max-warnings=0) -> exit 0, 0 warnings
> herdr-obs@0.3.2 build (tsc --noEmit && node esbuild.config.mjs) -> exit 0, main.js 1018779 bytes
> herdr-obs@0.3.2 test (node scripts/run-tests.mjs) -> exit 0
✔ UI control: keys, Electron input, permission gating, CLI, and MCP images (1239.858114ms)
✔ Windows: the environment copy keeps one PATH on Windows (#78, #76 second half) (1.469223ms)
✔ Windows: Herdr's socket path on Windows is a named pipe (#73) (0.815661ms)
✔ Windows: the Windows terminal driver is chosen only where it can run (#76) (0.674542ms)
✔ Windows: no initial prompt into an agent waiting at a question (#74) (2505.80024ms)
✔ Windows: Herdr commands and the session server open no console window (152.175675ms)
✔ Windows terminal: only an absolute .exe is started, through a job, with a bounded size (security review) (23.784969ms)
✔ Domain: OSC stream observer, path guard, shell quoting, and settings migration (1.239775ms)
✔ Terminal: Live POSIX PtySession with resize over control FD (172.094218ms)
✔ Vault Control Bridge: Authenticated socket, permission tiers, obs-herdr CLI, undo, and stdio MCP (3113.990697ms)
✔ Live Herdr 0.8.2 Daemon Integration (isolated config & session) (792.938259ms)
✔ AgentCursorOverlay: Round 3 collaborator presence, honest state, and lifecycle (626.608616ms)
✔ Raw key regressions: delayed agent input and modal replay (6.882031ms)
✔ html-drag: HTML5 drag-and-drop and pointer-event drags (1.891048ms)
✔ nested-editors helpers (3.45013ms)
✔ fix-coordinator: agyA review fixes (A1-A10) (483.863833ms)
✔ Fix round 2026-11-20 (fix-vault: B1-B8) (6561.887025ms)
ℹ tests 143
ℹ suites 17
ℹ pass 143
ℹ fail 0
ℹ duration_ms 15746.422728
```

#### Exact dependency and artifact SHA-256 hashes (release `0.3.2`)
| File | Bytes | SHA-256 |
|---|---:|---|
| `main.js` | `1018779` | `a3a682ca53175ac296148fa41866df6743d47f444358f72b287071ff2de3b98e` |
| `manifest.json` | `374` | `d8fee1b6c9b906da72060a0d6e8cdc600f9b87e5da8bff7f284b75732059e6f7` |
| `styles.css` | `28268` | `0c9868b1498538e2c0c16d18d630f7bfdb514896cadee9b1ed14398b75875c37` |
| `versions.json` | `171` | `c5ffd21975dbb3f5c305ebb7a129266b4b1e73fb05c8e79bea2bd5ef95740b16` |
| `package.json` | `1152` | `cdef2ffe8ca7f01f94d45b8c36260ed9326adc2981dcf4a1949dbc275252ecac` |
| `package-lock.json` | `191939` | `859618cf72fec431765f4ee1d5a82e7236f5baad76872b22459ae2e08501081a` |
| `LICENSE` | `1070` | `fe617d451da04ca0ed4ccbcc054574429712fa3e99fcea05d205b2c6a6573f13` |
| `src/control/LICENSE` | `11358` | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| `NOTICE` | `697` | `2da6936fb0e557bb5a919962e85b902a0707e7f8a98081d1f277e4e753323919` |
| `THIRD_PARTY_NOTICES.md` | `1752` | `b9a795457258171354ba15ac8e9a6a78458b9d2ebb755c5612828d1a2286d65c` |
| `README.md` | `9925` | `a6f0137282cc5b5eddb9534bf2a9210edc2d77ddf34b0a64ed641e6f4de81d14` |
| `CHANGELOG.md` | `7707` | `64ff781a5097df3590451d0173a5a850a37e982654c7f143b4bd37f3625498a1` |
