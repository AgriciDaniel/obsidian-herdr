import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import obsHerdrCoreMjsTemplate from "./client/obs-herdr-core.mjs?raw";
import obsHerdrCorePyTemplate from "./client/obs-herdr-core.py";
import type { ProvisionedRuntimeKit } from "./kit-paths";
import {
  SHARED_COMMAND_HELP,
  SHARED_MCP_TOOLS,
  SHARED_SKILL_TEXT,
  SHARED_UI_ALLOWED_FLAGS,
} from "./mcp-schema";

function writeFileAtomic(targetPath: string, content: string, mode?: number): void {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(
    dir,
    `.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
  );
  try {
    fs.writeFileSync(tmpPath, content, mode !== undefined ? { encoding: "utf8", mode } : "utf8");
    if (process.platform !== "win32" && mode !== undefined) {
      try {
        fs.chmodSync(tmpPath, mode);
      } catch {
        // Ignore chmod on unsupported filesystems
      }
    }
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore temp cleanup failure
    }
    throw err;
  }
}

function quotePosixPath(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function buildHerdrPluginManifestToml(cliScriptPath: string, pluginVersion: string): string {
  const cliEsc = JSON.stringify(cliScriptPath);
  const verEsc = JSON.stringify(pluginVersion);
  return [
    'id = "obsidian.vault"',
    'name = "Obsidian Vault Bridge"',
    `version = ${verEsc}`,
    'min_herdr_version = "0.8.0"',
    'description = "Control the live Obsidian vault, notes, backlinks, and editor from Herdr"',
    'platforms = ["linux", "macos", "windows"]',
    "",
    "[[actions]]",
    'id = "vault-status"',
    'title = "Show connected Obsidian vault status"',
    'contexts = ["workspace", "pane"]',
    `command = [${cliEsc}, "plugin-action", "vault-status"]`,
    "",
    "[[actions]]",
    'id = "capture-pane-to-note"',
    'title = "Save focused Herdr pane transcript into Obsidian vault"',
    'contexts = ["pane"]',
    `command = [${cliEsc}, "plugin-action", "capture-pane"]`,
    "",
    "[[actions]]",
    'id = "open-active-note-info"',
    'title = "Notify Herdr with active Obsidian note"',
    'contexts = ["workspace"]',
    `command = [${cliEsc}, "plugin-action", "active-note"]`,
    "",
  ].join("\n");
}

function renderObsHerdrCoreMjs(defaultConnFile: string, pluginVersion: string): string {
  return obsHerdrCoreMjsTemplate
    .replace('"__OBS_HERDR_CONN_FILE__"', () => JSON.stringify(defaultConnFile))
    .replace('"__OBS_HERDR_PLUGIN_VERSION__"', () => JSON.stringify(pluginVersion))
    .replace('"__OBS_HERDR_SKILL_TEXT__"', () => JSON.stringify(SHARED_SKILL_TEXT))
    .replace("/*__OBS_HERDR_COMMAND_HELP__*/ {}", () => JSON.stringify(SHARED_COMMAND_HELP))
    .replace("/*__OBS_HERDR_UI_ALLOWED_FLAGS__*/ {}", () => JSON.stringify(SHARED_UI_ALLOWED_FLAGS))
    .replace("/*__OBS_HERDR_MCP_TOOLS__*/ []", () => JSON.stringify(SHARED_MCP_TOOLS));
}

function renderObsHerdrCorePy(defaultConnFile: string, pluginVersion: string): string {
  return obsHerdrCorePyTemplate
    .replace('"__OBS_HERDR_CONN_FILE__"', () => JSON.stringify(defaultConnFile))
    .replace('"__OBS_HERDR_PLUGIN_VERSION__"', () => JSON.stringify(pluginVersion))
    .replace('"__OBS_HERDR_SKILL_TEXT__"', () => JSON.stringify(SHARED_SKILL_TEXT))
    .replace(
      "{}  # __OBS_HERDR_COMMAND_HELP__",
      () => `json.loads(${JSON.stringify(JSON.stringify(SHARED_COMMAND_HELP))})`
    )
    .replace(
      "{}  # __OBS_HERDR_UI_ALLOWED_FLAGS__",
      () => `json.loads(${JSON.stringify(JSON.stringify(SHARED_UI_ALLOWED_FLAGS))})`
    )
    .replace(
      "[]  # __OBS_HERDR_MCP_TOOLS__",
      () => `json.loads(${JSON.stringify(JSON.stringify(SHARED_MCP_TOOLS))})`
    );
}

/**
 * Provisions a private mode-0700 runtime folder outside the user's vault containing:
 * 1. The Unix socket path and mode-0600 connection discovery file
 * 2. The standalone `obs-herdr` CLI + MCP stdio server + `--skill` helper (Node + Python 3 fallback)
 * 3. A linkable `herdr-plugin.toml` (`obsidian.vault`) package for native Herdr actions
 */
function ensurePrivateDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    return;
  }
  const st = fs.lstatSync(dirPath);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`Refused unsafe runtime directory '${dirPath}' (symlink or non-directory).`);
  }
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (expectedUid !== null && st.uid !== expectedUid) {
    throw new Error(`Refused runtime directory '${dirPath}' owned by another user.`);
  }
  if ((st.mode & 0o077) !== 0) {
    fs.chmodSync(dirPath, 0o700);
    const verified = fs.lstatSync(dirPath);
    if ((verified.mode & 0o077) !== 0) {
      throw new Error(`Refused runtime directory '${dirPath}' with group/world permissions.`);
    }
  }
}

export function provisionRuntimeKit(options: {
  kit: ProvisionedRuntimeKit;
  token: string;
  vaultName: string;
  vaultPath: string | null;
  pluginVersion?: string;
  uiControlEnabled?: boolean;
}): void {
  const { kit, token, vaultName, vaultPath } = options;
  const pluginVersion = options.pluginVersion?.trim() || "0.3.2";

  ensurePrivateDir(kit.runtimeDir);
  ensurePrivateDir(kit.binDir);
  ensurePrivateDir(kit.herdrPluginDir);

  const connectionPayload: Record<string, unknown> = {
    socketPath: kit.socketPath,
    token,
    vaultName,
    vaultPath,
    ...(typeof options.uiControlEnabled === "boolean"
      ? { uiControlEnabled: options.uiControlEnabled }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  writeFileAtomic(kit.connectionFilePath, JSON.stringify(connectionPayload, null, 2) + "\n", 0o600);

  const coreMjsPath = path.join(kit.binDir, "obs-herdr-core.mjs");
  writeFileAtomic(coreMjsPath, renderObsHerdrCoreMjs(kit.connectionFilePath, pluginVersion), 0o700);

  const corePyPath = path.join(kit.binDir, "obs-herdr-core.py");
  writeFileAtomic(corePyPath, renderObsHerdrCorePy(kit.connectionFilePath, pluginVersion), 0o700);

  if (process.platform === "win32") {
    const cmdWrapper = [
      "@echo off",
      "where node >nul 2>nul",
      "if errorlevel 1 goto try_python",
      'node "%~dp0obs-herdr-core.mjs" %*',
      "exit /b %ERRORLEVEL%",
      ":try_python",
      "where python3 >nul 2>nul",
      "if errorlevel 1 goto try_py",
      'python3 "%~dp0obs-herdr-core.py" %*',
      "exit /b %ERRORLEVEL%",
      ":try_py",
      'py -3 "%~dp0obs-herdr-core.py" %*',
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
    writeFileAtomic(kit.cliScriptPath, cmdWrapper);
  } else {
    const shWrapper = [
      "#!/usr/bin/env sh",
      "if command -v node >/dev/null 2>&1; then",
      `  exec node ${quotePosixPath(coreMjsPath)} "$@"`,
      "elif command -v python3 >/dev/null 2>&1; then",
      `  exec python3 ${quotePosixPath(corePyPath)} "$@"`,
      "else",
      '  echo "obs-herdr requires node or python3 on PATH" >&2',
      "  exit 127",
      "fi",
      "",
    ].join("\n");
    writeFileAtomic(kit.cliScriptPath, shWrapper, 0o700);
  }

  writeFileAtomic(
    kit.herdrPluginManifestPath,
    buildHerdrPluginManifestToml(kit.cliScriptPath, pluginVersion),
    0o600
  );

  const mcpConfigPayload = {
    mcpServers: {
      obsidian_vault: {
        command: kit.cliScriptPath,
        args: ["mcp"],
      },
    },
  };
  writeFileAtomic(
    kit.mcpConfigFilePath,
    JSON.stringify(mcpConfigPayload, null, 2) + "\n",
    0o600
  );
}
