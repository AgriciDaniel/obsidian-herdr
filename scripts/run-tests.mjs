import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { builtinModules } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-herdr-test-bundle-"));
const outfile = path.join(tmpDir, "all.test.cjs");

try {
  await build({
    entryPoints: ["tests/all.test.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "es2022",
    outfile,
    alias: {
      obsidian: path.resolve("tests/obsidian-mock.ts"),
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
