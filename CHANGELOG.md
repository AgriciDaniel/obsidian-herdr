# Changelog

## 0.3.1 (2026-11-19)

Windows fixes from member reports on the AIMH home repository (issues #73, #74, #76 and pull request #78), the same as in AIMH Team 0.3.29. Not run on a Windows computer by the maintainer: the member reports and tests that set up Windows' platform and environment are the evidence.

- The socket path Herdr 0.9.5 reports on Windows is reached through its named pipe (`\\.\pipe\` in front); the pointer file at that path counts as a running server; the fallback is Herdr's own folder under `%APPDATA%` instead of `\\.\pipe\herdr` (#73).
- The environment copy keeps one `PATH`, read from Windows' `Path`, so agent programs are found and new panes get the full search path; npm's `.cmd` shims (Codex, Claude Code) are found too (#78, #76).
- The embedded terminal takes typing on Windows 10 1809 or later through a small pseudoconsole (ConPTY) driver run by Windows PowerShell; without it the old plain pipes are used. Linux and macOS are unchanged (#76).
- An agent waiting at a question when it starts (Claude Code's first-run folder trust check) no longer gets the initial prompt typed into it; a notice asks the member to answer, and the prompt is sent once the agent is ready, waiting up to two minutes (#74).
- Herdr commands and the detached Herdr server no longer open console windows on Windows.

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
