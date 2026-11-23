import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

const TEST_FILES = [
  "tests/all.test.ts",
  "tests/raw-key-regressions.test.ts",
  "tests/html-drag.test.ts",
  "tests/nested-editors.test.ts",
  "tests/fix-coordinator.test.ts",
  "tests/fix-vault.test.ts",
  "tests/security-hardening.test.ts",
  "tests/phase2-3-regressions.test.ts",
  "tests/ui-views.test.ts",
  "tests/release-hardening.test.ts",
];

const filters = process.argv.slice(2).filter((arg) => arg !== "--");
const selected =
  filters.length === 0
    ? TEST_FILES
    : TEST_FILES.filter((file) => filters.some((pattern) => file.includes(pattern)));

if (selected.length === 0) {
  console.error(`No test files matched filter(s): ${filters.join(", ")}`);
  process.exit(1);
}

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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-herdr-test-bundle-"));
const outfile = path.join(tmpDir, "all.test.cjs");

try {
  await build({
    stdin: {
      contents: selected.map((file) => `import "./${file}";`).join("\n"),
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "es2022",
    outfile,
    loader: {
      ".py": "text",
      ".cs": "text",
    },
    plugins: [rawAssetPlugin],
    alias: {
      obsidian: path.resolve("tests/obsidian-mock.ts"),
      electron: path.resolve("tests/electron-mock.ts"),
    },
    external: ["node:*", ...builtinModules],
    logLevel: "warning",
  });

  const run = spawnSync(process.execPath, ["--test", outfile], {
    stdio: "inherit",
    env: process.env,
  });

  process.exitCode = run.status ?? 1;
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
