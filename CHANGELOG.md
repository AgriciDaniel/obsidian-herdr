# Changelog

## 0.3.2 (2026-11-23)

Reliability fixes from a full code and live review. The aim: agents keep working, and when something fails they are told so instead of being left hanging.

- Mission Control is simpler: one status line instead of five tiles, three tabs (Agents, Vault, Doctor) instead of five, a compact layout map with one row per agent under its pane name, and the less used tools in `⋯` menus. Nothing was removed; see the header menu and each agent's menu.
- Stop session now asks first and names the session, since it stops every agent in it.
- The Vault tab uses plain permission names (Off, Read only, Edit notes, Full control, also in Settings), shows note edits by default with "Show all activity" for the rest, and folds the connection paths under "Connection details". The Doctor tab wraps long values and folds stopped sessions and optional hooks away.
- Agents pressing Escape now close Obsidian menus. The Doctor tab no longer scans PATH on every refresh (cached for a minute), which could slow Obsidian down.
- Deleting a note through the bridge now checks that the note is really gone. If system trash is not available (common in the Flatpak), it falls back to Obsidian's own `.trash` folder in the vault; if that fails too, it reports `trash_failed` instead of a false success. Undo of a created note uses the same check.
- Renaming a linked note no longer stops at Obsidian's "Update links" question. Links are updated without a prompt and without changing your settings; pass `updateLinks: false` to rename without touching links.
- The `obs-herdr` command and its MCP server time out (60 seconds by default, `OBS_HERDR_TIMEOUT_MS` to change it) and report an error when Obsidian closes the connection early, instead of hanging or exiting as if it had worked.
- Reloading or turning the plugin off and on can no longer delete the new bridge socket, which used to cut agents off while Mission Control still showed the bridge as active.
- If the runtime folder in `~/.cache/obs-herdr/` is deleted while Obsidian runs, the bridge rebuilds it with the same token. Old runtime folders of vaults that no longer exist are cleaned up once per start.
- A bridge start failure no longer leaves Mission Control half loaded; it shows the error and carries on.
- Mission Control's Doctor tab warns when Herdr reports a protocol other than the tested one (20), or when the Herdr client and server disagree, and suggests `herdr update --handoff`.
- New panes from saved layouts get the vault command on PATH too. The Herdr agent and remote terminal profiles fall back to a shell when Herdr is missing, and the terminal says so when full-screen apps cannot work because Python 3 is missing.
- While a new agent waits at a question, the Spawn window can be cancelled; the initial prompt is then not sent.
- One failing view no longer stops the others from updating, and UI control stops cleanly when the plugin unloads.
- The initial prompt typed in the Spawn window is sent only once the agent has settled and is ready for input, and the plugin checks it arrived (its text, a pasted-text marker, or the agent starting work), sending once more at most. Before, a prompt sent while Codex was still starting could be lost.
- New `obs-herdr ui select` (and a `select` batch step) chooses an option in a dropdown by value or label, with the same protections as a click. The MCP server now has 27 tools, including `obsidian_ui_insert_line` for placing a line by note heading or line number.
- Agents pressing Enter, Tab, Backspace or Delete in a text box no longer lose the text they type next (the keyboard shield did not recognise these agent keys and held back about half a second of input).
- Hardening from a cross-review: the initial prompt is sent again only when nothing at all changed after the first send, and never into an agent waiting at a question; two renames at once restore the link setting correctly; system trash that throws an error still falls back to the vault `.trash`; UI actions queued at unload are refused; a self-repair keeps the bridge token, also when two run at once; the kit check covers `connection.json` and the core scripts; on Windows the cleanup checks the bridge pipe before removing a kit, and the Python client times out on the pipe too; timeouts are kept between 1 second and 10 minutes.
- Safer by default: agents can no longer run Obsidian's delete-file or developer tools commands, and UI control now also treats Mission Control, Bases boards and Herdr code block widgets as protected areas. `ui inspect` and `ui wait_for` no longer read text out of protected areas or password fields.
- Prompts that come from a `herdr` code block or an `obsidian://herdr` link, applying a saved layout, and stopping a session from the command palette now ask you first.
- The bridge limits how many requests one connection can queue and disconnects a client after repeated failed sign-ins. Paths such as `C:note.md` and symlinks that point out of the vault are refused, also in search.
- Long notes and big vaults: `vault.read_note` can return part of a note (`offsetLine`, `maxLines`, `maxChars`) and says `truncated: true` when it does; without them you still get the whole note. Listings take `offset` and `limit` and report `total`. The `obs-herdr` command passes these through in both its Node and Python versions.
- Mission Control works better with the keyboard and screen readers: tabs and options keep focus and scroll position across refreshes, menus open where the keyboard is, the layout map no longer nests buttons, and narrow panes and light themes read better. The Vault tab's activity rows wrap instead of overlapping.
- Text you send to a terminal while it is still starting is dropped if the start fails, instead of being typed into a later session.
- UI actions wait up to 5 minutes by default (other commands 1 minute; `OBS_HERDR_TIMEOUT_MS` overrides both), and the bridge no longer drops a connection while it is still working on its request. A UI action whose agent gave up before its turn is skipped instead of running late.
- Works with Herdr 0.9.5 (protocol 22) as well as 0.8.x. After an event stream falls behind, Mission Control reconnects at once.
- Agents can no longer run commands of plugins that run code, shell commands or other programs (Templater, Shell Commands, QuickAdd, Execute Code, Open with default app, Terminal, Commander macros, CustomJS, RunJS, JS Engine, Python Scripter, User Plugins). Screenshots blank out Herdr terminals, Mission Control and the Settings window, the same areas `ui inspect` hides.
- Upgrading from 0.2.x: on Windows the runtime folder moved from your temp folder to `%LOCALAPPDATA%\obs-herdr`; the bridge keeps the old token, so MCP configs copied earlier keep working. If an agent's MCP connection stops working after the update on any system, copy the MCP config again from Mission Control (Vault tab, Connection details).
- Backlinks, graph neighbours and tag lists return everything again unless you pass `limit`, and `obs-herdr command list` takes `--limit` and `--offset`.
- Smaller: the note graph and backlinks skip `node_modules`, `.git` and the settings folder; `ui inspect` marks protected elements such as window controls and lists them last; the MCP server reports the real plugin version.

## 0.3.1 (2026-11-19)

Windows fixes from user reports. Thanks to [CeeDeelux](https://github.com/CeeDeelux), who found and proposed the named pipe and npm command fixes in [pull request #1](https://github.com/AgriciDaniel/obsidian-herdr/pull/1). Not run on a Windows computer by the maintainer: the user reports and tests that set up Windows' platform and environment are the evidence.

- The socket path Herdr 0.9.5 reports on Windows is reached through its named pipe (`\\.\pipe\` in front); the pointer file at that path counts as a running server; the fallback is Herdr's own folder under `%APPDATA%` instead of `\\.\pipe\herdr`.
- The environment copy keeps one `PATH`, read from Windows' `Path`, so agent programs are found and new panes get the full search path; npm's `.cmd` shims (Codex, Claude Code) are found too.
- The embedded terminal takes typing on Windows 10 1809 or later through a small pseudoconsole (ConPTY) driver run by Windows PowerShell; without it the old plain pipes are used. Linux and macOS are unchanged.
- An agent waiting at a question when it starts (Claude Code's first-run folder trust check) no longer gets the initial prompt typed into it; a notice asks the user to answer, and the prompt is sent once the agent is ready, waiting up to two minutes.
- Herdr commands and the detached Herdr server no longer open console windows on Windows.
- On Windows the terminal starts only a .exe given as a full path or found in a folder named in full on PATH, never one in the vault folder, and never a .cmd or .bat file (those run through cmd.exe); otherwise it says why and starts nothing. The program runs in a Windows job that ends it when the terminal closes, so it is not left running, and a resize is capped at 1000 columns and rows.
- The initial prompt of a new agent is sent only while its Herdr session is still the active one, so it never reaches an agent of the same name in another session.

## 0.3.0 (2026-11-16)

Multi-agent UI control and full Obsidian coverage. See `docs/ACCEPTANCE.md`, section 6, for the gates and live results.

- Named, colour-coded agent cursors on the exact caret, shown everywhere (tabs, ribbon, sidebars, status bar, menus, modals, Mission Control); actions wait until the cursor arrives.
- Note anchors: `ui insert-line` and `ui locate` by heading, line text or number, with proof of where the line landed; anchored edits never move the user's focus or selection.
- Drag and drop the way Obsidian expects (HTML5 for the file explorer and tabs, pointer drags for Canvas); nested editors (table cells, properties, inline title, rename boxes, Canvas cards, Bases cells) with file-level Undo.
- Keyboard safety: raw keys only inside a shielded window, user keys typed meanwhile go back to the user; protected areas (the Herdr terminal, Settings, plugin toggles, window controls, quit).
- Undo per caller and per file, refusing with `undo_conflict` rather than erase another agent's edit; honest failure reporting (dispatched is not success).
- Typing speed setting (visible or fast); punctuation keys, zoom accelerators, `ui hover`, note-only `ui scroll`.
- Codex panes get the vault CLI on PATH through per-launch config overrides.

Known limits: pop-out windows and graph view nodes are not targetable.
