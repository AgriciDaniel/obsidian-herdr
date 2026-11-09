# Acceptance Record

Recorded on `2026-11-09` on `Linux 7.2.7-200.fc44.x86_64` (Aurora Kinoite), Node.js `v24.22.1`, npm `11.21.1`, TypeScript `5.8.3`, ESLint `v10.14.0` (`eslint-plugin-obsidianmd@0.4.2`), `herdr 0.8.2` (protocol `20`), `codex-cli 0.167.0`, and Flatpak Obsidian `1.15.0` (Electron host `1.14.5`).

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

## Exact dependency and artifact SHA-256 hashes

| File | Bytes | SHA-256 |
|---|---:|---|
| `main.js` | `743492` | `388eb5994d1bcd5ba614752cd59e1d71d94962796f48c64b7bc01df960c3683e` |
| `manifest.json` | `404` | `24c85f42902a7d886e5f6e04b9d700752a5883e73f851ee9131c318dfbee9149` |
| `styles.css` | `19993` | `c03211dd7dd3df1cb03f578205f2805ad66dbb67d886907ab8bb48d484ac3387` |
| `versions.json` | `24` | `10e610588c8dfa10061be2f25ab5d38bd91179cb1a31cbee7d58e35e357ecded` |
| `package.json` | `1133` | `204fcb1ccc90ce182cae828e2a4b3de7fd7a1f46f67475ccb919ae6077379a90` |
| `package-lock.json` | `191923` | `ac58c393ac362328702e9c97b5d4b4c99ea930f41319ac43ff8202bcae6ade20` |
| `LICENSE` | `1070` | `fe617d451da04ca0ed4ccbcc054574429712fa3e99fcea05d205b2c6a6573f13` |
| `THIRD_PARTY_NOTICES.md` | `1588` | `de2bd754530faf0393ecdef057092087b9e39a8807cc23cc9587b626cffc3644` |
| `README.md` | `7489` | `fcc90d74bd0e246157930e1dd9cd631c06142da2d97ecdd80aff4c6af9e31e5b` |
