# Sources

Official contracts and upstream specifications, paraphrased and applied as practitioner guidance. Multiple entries from one upstream are not independent corroboration. Refresh before public release.

## Obsidian official developer contracts

- `SRC-01-001`: [Obsidian plugin guidelines](https://github.com/obsidianmd/obsidian-developer-docs/blob/1c26772ac13d6e9870c865936d389fdfe694e742/en/Plugins/Releasing/Plugin%20guidelines.md), retrieved 2026-11-01.
- `SRC-01-002`: [Obsidian public TypeScript API declarations (`obsidian.d.ts`)](https://github.com/obsidianmd/obsidian-api/blob/9abd9605ce081383674aae1ed111c456edde0688/obsidian.d.ts), retrieved 2026-11-01 (verified locally against `obsidian@1.14.4`).
- `SRC-01-003`: [Obsidian manifest specification](https://github.com/obsidianmd/obsidian-developer-docs/blob/1c26772ac13d6e9870c865936d389fdfe694e742/en/Reference/Manifest.md), retrieved 2026-11-01.
- `SRC-01-004`: [Submit a plugin to the Obsidian Community directory](https://github.com/obsidianmd/obsidian-developer-docs/blob/1c26772ac13d6e9870c865936d389fdfe694e742/en/Plugins/Releasing/Submit%20your%20plugin.md), retrieved 2026-11-01.
- `SRC-01-005`: [Obsidian Community directory developer policies](https://github.com/obsidianmd/obsidian-developer-docs/blob/1c26772ac13d6e9870c865936d389fdfe694e742/en/Community%20directory/Developer%20policies.md), retrieved 2026-11-01.
- `SRC-01-006`: [Official Obsidian ESLint configuration guide (`eslint-plugin-obsidianmd`)](https://github.com/obsidianmd/eslint-plugin/blob/837b01dc1647cb3f0c532becb60ea83bec137656/docs/configuration.md), retrieved 2026-11-01 (verified locally against `eslint-plugin-obsidianmd@0.4.2`).
- `SRC-01-007`: [Official sample plugin esbuild configuration](https://github.com/obsidianmd/obsidian-sample-plugin/blob/07ceb81d1fb3384af611ebf665a1ec42a7e5926d/esbuild.config.mjs), retrieved 2026-11-01.
- `SRC-01-008`: [Obsidian mobile development and desktop-only boundaries](https://github.com/obsidianmd/obsidian-developer-docs/blob/1c26772ac13d6e9870c865936d389fdfe694e742/en/Plugins/Getting%20started/Mobile%20development.md), retrieved 2026-11-01.
- `SRC-02-001`: [Obsidian custom ItemView interfaces](https://github.com/obsidianmd/obsidian-developer-docs/blob/1c26772ac13d6e9870c865936d389fdfe694e742/en/Plugins/User%20interface/Views.md), retrieved 2026-11-01.
- `SRC-02-002`: [Obsidian deferred view lifecycle](https://github.com/obsidianmd/obsidian-developer-docs/blob/1c26772ac13d6e9870c865936d389fdfe694e742/en/Plugins/Guides/Defer%20views.md), retrieved 2026-11-01.
- `SRC-02-006`: [Obsidian CSS variables and styling](https://github.com/obsidianmd/obsidian-developer-docs/blob/1c26772ac13d6e9870c865936d389fdfe694e742/en/Reference/CSS%20variables/About%20styling.md), retrieved 2026-11-01.
- `SRC-04-023`: [Obsidian `FileManager` API (`processFrontMatter`, `renameFile`, `trashFile`)](https://docs.obsidian.md/Reference/TypeScript+API/FileManager), retrieved 2026-11-01.

## Upstream ecosystem and protocol specifications

- `SRC-HERDR-001`: [herdrdev/herdr repository and documentation (`Apache-2.0`)](https://github.com/herdrdev/herdr), retrieved 2026-11-08, corroborated against a local `~/.local/bin/herdr` `v0.8.2` (`herdr --skill`, `herdr api methods`, socket protocol `20`, OSC `7501`).
- `SRC-TERM-REF-001`: [Obsidian Community Directory Terminal plugin page](https://community.obsidian.md/plugins/terminal) ([polyipseity/obsidian-terminal](https://github.com/polyipseity/obsidian-terminal), `AGPL-3.0-or-later`), inspected 2026-11-08 for public feature surface only; zero source code or CSS copied.
- `SRC-XTERM-001`: [xtermjs/xterm.js (`@xterm/xterm@6.0.0`, MIT)](https://github.com/xtermjs/xterm.js), retrieved 2026-11-08.
- `SRC-MCP-001`: [Model Context Protocol JSON-RPC 2.0 stdio transport (`2024-11-05`)](https://modelcontextprotocol.io/specification/2024-11-05), retrieved 2026-11-08.
