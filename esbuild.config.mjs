import { build } from "esbuild";
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import * as path from "node:path";

const RAW_HTML_SINK_RE =
  /(\.\s*(?:innerHTML|outerHTML)\s*=|\binsertAdjacentHTML\s*\(|\bdangerouslySetInnerHTML\b)/;

const DASH_GUARD_RE = /[\u2013\u2014]/;
const CSS_HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const CSS_IMPORTANT_RE = /!\s*important\b/i;

const rawAssetPlugin = {
  name: "raw-asset-text",
  setup(buildApi) {
    buildApi.onResolve({ filter: /\?raw$/ }, (args) => {
      const cleanPath = args.path.slice(0, -4);
      return {
        path: path.resolve(args.resolveDir, cleanPath),
        namespace: "raw-asset",
      };
    });
    buildApi.onLoad({ filter: /.*/, namespace: "raw-asset" }, async (args) => ({
      contents: await readFile(args.path, "utf8"),
      loader: "text",
    }));
  },
};

const result = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  outfile: "main.js",
  sourcemap: false,
  minify: true,
  metafile: true,
  loader: {
    ".py": "text",
    ".cs": "text",
  },
  plugins: [rawAssetPlugin],
  banner: {
    js: "/*! Herdr for Obsidian. MIT License, Copyright (c) 2026 Daniel Agrici. Includes the UI control module (src/control), Copyright 2026 Daniel Agrici, licensed under the Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0). NOTICE: https://github.com/AgriciDaniel/obsidian-herdr/blob/main/NOTICE */",
  },
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    "node:*",
    ...builtinModules,
  ],
  logLevel: "warning",
});

const builtBundle = await readFile("main.js", "utf8");
const strippedComments = builtBundle.replace(/\/\*[\s\S]*?\*\//g, "");
if (RAW_HTML_SINK_RE.test(strippedComments)) {
  throw new Error("Build gate failed: raw HTML injection sink detected in main.js");
}
if (builtBundle.length > 2 * 1024 * 1024) {
  throw new Error(`Build gate failed: main.js (${builtBundle.length} bytes) exceeds 2 MiB review limit`);
}
if (DASH_GUARD_RE.test(builtBundle)) {
  throw new Error("Build gate failed: em or en dash detected in main.js");
}

// Apache-2.0 SPDX gate for all TypeScript sources under src/control/
const controlEntries = await readdir("src/control", { withFileTypes: true });
for (const entry of controlEntries) {
  if (!entry.isFile() || !entry.name.endsWith(".ts")) {
    continue;
  }
  const srcText = await readFile(path.join("src/control", entry.name), "utf8");
  if (!srcText.includes("SPDX-License-Identifier: Apache-2.0")) {
    throw new Error(`Build gate failed: src/control/${entry.name} is missing Apache-2.0 SPDX header`);
  }
}

// Stylesheet hygiene gate: zero hardcoded #hex colors, zero !important, zero em/en dashes
const cssText = await readFile("styles.css", "utf8");
const cssWithoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
if (CSS_HEX_RE.test(cssWithoutComments)) {
  throw new Error("Build gate failed: hardcoded #hex color detected in styles.css");
}
if (CSS_IMPORTANT_RE.test(cssWithoutComments)) {
  throw new Error("Build gate failed: !important detected in styles.css");
}
if (DASH_GUARD_RE.test(cssText)) {
  throw new Error("Build gate failed: em or en dash detected in styles.css");
}

// Print only bundle size and external import names; never source text or note content.
const output = result.metafile.outputs["main.js"];
console.log(JSON.stringify({ bytes: output.bytes, imports: output.imports }, null, 2));
