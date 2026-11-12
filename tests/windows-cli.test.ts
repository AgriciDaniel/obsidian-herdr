import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import {
  buildHostNormalizedEnv,
  resolveExecutableOnNormalizedPath,
} from "../src/herdr/cli-client";
it(
  "Windows CLI discovery supports npm shims and stale GUI PATH",
  { skip: process.platform !== "win32" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-cli-"));
    const old = { ...process.env };
    try {
      fs.mkdirSync(path.join(root, "npm"));
      fs.writeFileSync(
        path.join(root, "npm", "test-herdr-cli.cmd"),
        "@echo test",
      );
      for (const key of Object.keys(process.env))
        if (key.toUpperCase() === "PATH") delete process.env[key];
      process.env.Path = "C:\\missing-bin";
      process.env.APPDATA = root;
      const env = buildHostNormalizedEnv(process.env);
      assert.equal(
        Object.keys(env).filter((k) => k.toUpperCase() === "PATH").length,
        1,
      );
      assert.ok(env.PATH?.startsWith("C:\\missing-bin;"));
      assert.equal(
        resolveExecutableOnNormalizedPath("test-herdr-cli"),
        path.join(root, "npm", "test-herdr-cli.cmd"),
      );
      assert.equal(
        resolveExecutableOnNormalizedPath("test-herdr-cli.exe"),
        null,
      );
      const nativeExe = path.join(root, "npm", "test-herdr-cli.exe");
      fs.writeFileSync(nativeExe, "fixture");
      assert.equal(
        resolveExecutableOnNormalizedPath("test-herdr-cli"),
        nativeExe,
      );
      assert.equal(
        resolveExecutableOnNormalizedPath("test-herdr-cli.exe"),
        nativeExe,
      );
      const base = { Path: "old" };
      const override = buildHostNormalizedEnv(base, { PATH: "new" });
      assert.deepEqual(base, { Path: "old" });
      const normalizedAgain = buildHostNormalizedEnv(env);
      assert.equal(normalizedAgain.PATH, env.PATH);
      assert.ok(override.PATH?.startsWith("new;"));
      assert.equal(override.Path, undefined);
    } finally {
      for (const key of Object.keys(process.env))
        if (!(key in old)) delete process.env[key];
      Object.assign(process.env, old);
      fs.rmSync(root, { recursive: true });
    }
  },
);
