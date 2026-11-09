# Third-Party Notices

This plugin (`herdr`) is licensed under the MIT License (see `LICENSE`).

## Bundled runtime dependencies (`main.js`)

The compiled `main.js` bundle incorporates the following MIT-licensed packages:

### `@xterm/xterm` (`6.0.0`)
- Upstream: https://github.com/xtermjs/xterm.js
- License: MIT
- Copyright (c) 2017-2026, The xterm.js authors
- Copyright (c) 2014-2016, SourceLair, Private Company (https://www.sourcelair.com)
- Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

### `@xterm/addon-fit` (`0.11.0`)
- Upstream: https://github.com/xtermjs/xterm.js
- License: MIT
- Copyright (c) 2019, The xterm.js authors

### `@xterm/addon-search` (`0.16.0`)
- Upstream: https://github.com/xtermjs/xterm.js
- License: MIT
- Copyright (c) 2017, The xterm.js authors

### `@xterm/addon-web-links` (`0.12.0`)
- Upstream: https://github.com/xtermjs/xterm.js
- License: MIT
- Copyright (c) 2019, The xterm.js authors

## External binaries and clean-room boundary

- **`herdrdev/herdr`** (https://github.com/herdrdev/herdr, licensed under `Apache-2.0`): Invoked externally over the local CLI and protocol-20 Unix domain socket / named pipe when installed on the user's machine. No `herdr` source code or binary is bundled into `main.js`.
- **Clean-room terminal integration**: All terminal view, PTY host (`pty.openpty()` Python 3 bridge), OSC stream observer, link provider, and CSS code in this repository was authored from scratch under the MIT License. No code, CSS, or assets were copied from `polyipseity/obsidian-terminal` (`AGPL-3.0-or-later`).
