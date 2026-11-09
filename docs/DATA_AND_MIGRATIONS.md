# Data, Migrations, and Integrations

## Inventory

| Data | Location | Schema/version | Sensitivity | Lifetime and recovery |
|---|---|---|---|---|
| User settings | `<Vault>/.obsidian/plugins/herdr/data.json` | `HerdrPluginSettings` (`schemaVersion: 1`) | Low (paths, session slug, UI preferences; zero secrets) | Persisted via `Plugin.saveData()`; validated and recovered via `migrateSettings()`. `allowUiControl` (added after 0.1.0) is additive: missing or non-boolean values become `false`, so `schemaVersion` stays `1` |
| Runtime bridge kit | `~/.cache/obs-herdr/<12-hex-vault-hash>/` (or OS fallback dir, mode `0700`) | Ephemeral runtime files (`b.sock`, `connection.json`, `bin/obs-herdr`, `herdr-plugin/herdr-plugin.toml`) | Ephemeral 256-bit bearer token in mode-`0600` `connection.json` | Recreated on plugin load with a fresh random token; socket unlinked on plugin unload |
| UI control screenshots | `<runtime dir>/screenshots/` (CLI `obs-herdr ui screenshot`; MCP returns the PNG inline and writes nothing) | PNG files, mode `0600` in a mode `0700` folder | High (can show any open note) | Created only on request while `allowUiControl` is on; never deleted automatically, remove by hand |
| Credentials | None | N/A | N/A | Zero API keys or account credentials stored anywhere |
| Network payloads | None | N/A | N/A | Zero external HTTP/HTTPS/WebSocket requests |
| Vault note mutations | User vault Markdown (`.md`) and Canvas (`.canvas`) files | User vault content | High (user notes) | Gated by permission tier (`off`, `read-only`, `read-write`, `full`); executed via `Vault.process` and `FileManager`; reversible via in-memory `VaultAuditEntry.snapshot` (`undoMutation`) and Obsidian File Recovery / system trash |

## Migration contract

- `migrateSettings(raw: unknown)` (`src/domain/types.ts`) accepts `null`, `undefined`, non-objects, partial objects, or out-of-range fields without throwing.
- Unknown or invalid `vaultPermissionMode` values default safely to `"read-write"`; `terminalFontSize` is clamped to `[9, 28]`; `terminalScrollback` is clamped to `[500, 50000]`; missing or malformed `profiles` fall back to `DEFAULT_PROFILES`.
- Idempotent across repeated calls (`migrateSettings(migrateSettings(x))` equals `migrateSettings(x)`), verified in `tests/all.test.ts`.

## Concurrency and cache

- `HerdrCoordinator.refreshAll()` coalesces overlapping refreshes via `this.refreshInFlight` and debounces bursty `events.subscribe` notifications (`120` ms) via `window.setTimeout`.
- Note mutations over `VaultOpsService` use `Vault.process(file, fn)` and `FileManager.processFrontMatter(file, fn)` so concurrent open editor buffers in Obsidian merge atomically instead of clobbering unsaved editor state.
- Link-safe renames use `FileManager.renameFile(file, newPath)` so Obsidian updates inbound `[[WikiLinks]]` across the vault automatically.
- Unknown pane statuses remain `"unknown"` (never coerced to `"done"` or `"working"`), and stopped daemons remain distinct from running 0-agent sessions.

## Network and cost

- **Zero external network services and zero cost**: The plugin makes no internet requests, loads no remote scripts or fonts, and incurs no API billing. All communication occurs strictly over user-owned local Unix domain sockets (or Windows named pipes) and local child processes (`herdr`, user shell, Python 3 PTY helper).
