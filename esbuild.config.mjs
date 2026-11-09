import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";

const RAW_HTML_SINK_RE =
  /(\.\s*(?:innerHTML|outerHTML)\s*=|\binsertAdjacentHTML\s*\(|\bdangerouslySetInnerHTML\b)/;

const DASH_GUARD_RE = /[\u2013\u2014]/;

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

// Print only bundle size and external import names; never source text or note content.
const output = result.metafile.outputs["main.js"];
console.log(JSON.stringify({ bytes: output.bytes, imports: output.imports }, null, 2));
