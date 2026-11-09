# Release Preparation

1. **Product & runtime criteria**: All 14 product acceptance criteria (`docs/PRODUCT_BRIEF.md`), automated unit/integration suites (`npm test`), strict official ESLint checks (`npm run lint -- --max-warnings=0`), static review (`100/100` in `docs/STATIC_REVIEW.md`), and isolated headless Obsidian `1.15.0` E2E runtime checks (`docs/ACCEPTANCE.md`) have been executed and recorded.
2. **Official policies & disclosures**: Reviewed against `docs/SOURCES.md` (`SRC-01-001` through `SRC-01-008`). Desktop-only process spawning (`node:child_process`), local IPC sockets (`herdr` socket + mode-`0600` Vault Control Bridge), vault mutation permission tiers, and zero external network/telemetry behavior are explicitly disclosed in `README.md`.
3. **License & third-party notices**: MIT License in `LICENSE` for the plugin, except the UI control module `src/control/`, which is Apache 2.0 (`src/control/LICENSE`, attribution in `NOTICE`, banner at the top of `main.js`); bundled `@xterm/*` MIT notices and clean-room boundaries recorded in `THIRD_PARTY_NOTICES.md`; `package.json` `"license": "MIT AND Apache-2.0"`. Releases attach `LICENSE`, `LICENSE-Apache-2.0.txt`, and `NOTICE` next to the plugin files.
4. **Version & compatibility alignment**:
   - `manifest.json`: `"id": "herdr"`, `"name": "Herdr"`, `"version": "0.2.0"`, `"minAppVersion": "1.14.4"`, `"isDesktopOnly": true`
   - `package.json`: `"name": "herdr"`, `"version": "0.2.0"`
   - `versions.json`: `{ "0.1.0": "1.14.4", "0.2.0": "1.14.4" }`
   - Release assets required for GitHub Release (`0.2.0` tag, without `v` prefix per `SRC-01-004`): `main.js`, `manifest.json`, `styles.css`.
5. **Artifact hashes & rollback**: Exact byte sizes and SHA-256 digests are recorded in `docs/ACCEPTANCE.md`. Rollback means restoring the previous tested `main.js`, `manifest.json`, and `styles.css` (plus `data.json` if `schemaVersion` ever increments beyond `1`).
6. **Owner approval gate**: Do **not** initialize/push a public repository, create a GitHub release tag, submit a PR to `obsidianmd/obsidian-releases`, or copy build artifacts into an active personal vault without explicit authorization from Daniel Agrici.
