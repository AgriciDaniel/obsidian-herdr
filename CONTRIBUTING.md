# Contributing

Thanks for helping make Herdr Mission Control better.

## Report a bug

Open an [issue](https://github.com/AgriciDaniel/obsidian-herdr/issues) and include:

- Your operating system, Obsidian version and Herdr version (`herdr --version`).
- The plugin version (Settings, Community plugins).
- What you did, what you expected, and what happened instead.
- Any errors from the developer console (`Ctrl+Shift+I`, Console tab).

Please remove anything private from screenshots and logs, such as note contents, paths or tokens.

## Suggest a feature

Open an issue that describes the problem you want solved. A short example of how you would use it helps a lot.

## Send a pull request

1. Fork the repo and create a branch from `main`.
2. Install and check everything:

   ```bash
   npm ci
   npm run check && npm run lint && npm run build && npm test
   ```

3. Try your change in a test vault: copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/herdr-obs/` and reload the plugin.
4. Keep the change focused, and describe what it does and how you tested it.

Code in `src/control/` is Apache 2.0 and must keep its SPDX header. Everything else is MIT. By sending a pull request you agree your change is released under the license of the files it touches.

## Security

If you find a security problem, such as a way for an agent to reach files it should not, please do not post the details publicly. Open an issue that only says you have a security report, and I will reply with a private way to share it.
