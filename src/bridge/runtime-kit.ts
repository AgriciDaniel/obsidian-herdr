import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { buildHostNormalizedEnv } from "../herdr/cli-client";

export interface ProvisionedRuntimeKit {
  runtimeDir: string;
  binDir: string;
  cliScriptPath: string;
  connectionFilePath: string;
  mcpConfigFilePath: string;
  herdrPluginDir: string;
  herdrPluginManifestPath: string;
  socketPath: string;
}

function selectWritableRuntimeBase(digest: string): string {
  if (process.platform !== "win32") {
    const homeCache = path.join(os.homedir(), ".cache", "obs-herdr");
    const candidateSock = path.join(homeCache, digest, "b.sock");
    if (candidateSock.length <= 98) {
      try {
        fs.mkdirSync(homeCache, { recursive: true, mode: 0o700 });
        fs.accessSync(homeCache, fs.constants.W_OK);
        return homeCache;
      } catch {
        // Fall back to os.tmpdir()
      }
    }
  }
  return os.tmpdir();
}

/**
 * Provisions a private mode-0700 runtime folder outside the user's vault containing:
 * 1. The Unix socket path and mode-0600 connection discovery file
 * 2. The standalone `obs-herdr` CLI + MCP stdio server + `--skill` helper (Node + Python 3 fallback)
 * 3. A linkable `herdr-plugin.toml` (`obsidian.vault`) package for native Herdr actions
 */
export function computeRuntimePaths(
  vaultKey: string,
  overrideBaseDir?: string
): ProvisionedRuntimeKit {
  const digest = crypto.createHash("sha256").update(vaultKey).digest("hex").slice(0, 12);
  const baseRuntime = overrideBaseDir || selectWritableRuntimeBase(digest);

  const runtimeDir = overrideBaseDir
    ? path.join(baseRuntime, `oh-${digest}`)
    : path.join(baseRuntime, digest);
  const binDir = path.join(runtimeDir, "bin");
  const herdrPluginDir = path.join(runtimeDir, "herdr-plugin");
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\obsidian-herdr-${digest}`
      : path.join(runtimeDir, "b.sock");

  return {
    runtimeDir,
    binDir,
    cliScriptPath: path.join(
      binDir,
      process.platform === "win32" ? "obs-herdr.cmd" : "obs-herdr"
    ),
    connectionFilePath: path.join(runtimeDir, "connection.json"),
    mcpConfigFilePath: path.join(runtimeDir, "mcp-config.json"),
    herdrPluginDir,
    herdrPluginManifestPath: path.join(herdrPluginDir, "herdr-plugin.toml"),
    socketPath,
  };
}

export function readExistingBridgeToken(connectionFilePath: string): string | undefined {
  try {
    if (!fs.existsSync(connectionFilePath)) {
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(connectionFilePath, "utf8")) as {
      token?: unknown;
    };
    if (typeof parsed.token === "string" && /^[0-9a-f]{64}$/i.test(parsed.token)) {
      return parsed.token;
    }
  } catch {
    // Ignore unreadable or legacy connection metadata
  }
  return undefined;
}

export function provisionRuntimeKit(options: {
  kit: ProvisionedRuntimeKit;
  token: string;
  vaultName: string;
  vaultPath: string | null;
  pluginVersion?: string;
}): void {
  const { kit, token, vaultName, vaultPath } = options;
  const pluginVersion = options.pluginVersion?.trim() || "0.3.1";

  fs.mkdirSync(kit.runtimeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(kit.binDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(kit.herdrPluginDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(kit.runtimeDir, 0o700);
    } catch {
      // Ignore chmod error on non-POSIX filesystems
    }
  }

  const connectionPayload = {
    socketPath: kit.socketPath,
    token,
    vaultName,
    vaultPath,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(kit.connectionFilePath, JSON.stringify(connectionPayload, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });

  const coreMjsPath = path.join(kit.binDir, "obs-herdr-core.mjs");
  fs.writeFileSync(coreMjsPath, buildObsHerdrCoreMjs(kit.connectionFilePath, pluginVersion), {
    encoding: "utf8",
    mode: 0o700,
  });

  const corePyPath = path.join(kit.binDir, "obs-herdr-core.py");
  fs.writeFileSync(corePyPath, buildObsHerdrCorePy(kit.connectionFilePath, pluginVersion), {
    encoding: "utf8",
    mode: 0o700,
  });

  if (process.platform === "win32") {
    const cmdWrapper = [
      "@echo off",
      `where node >nul 2>nul && (node "${coreMjsPath}" %* & exit /b %ERRORLEVEL%)`,
      `python3 "${corePyPath}" %*`,
      "",
    ].join("\r\n");
    fs.writeFileSync(kit.cliScriptPath, cmdWrapper, "utf8");
  } else {
    const shWrapper = [
      "#!/usr/bin/env sh",
      "if command -v node >/dev/null 2>&1; then",
      `  exec node "${coreMjsPath}" "$@"`,
      "elif command -v python3 >/dev/null 2>&1; then",
      `  exec python3 "${corePyPath}" "$@"`,
      "else",
      '  echo "obs-herdr requires node or python3 on PATH" >&2',
      "  exit 127",
      "fi",
      "",
    ].join("\n");
    fs.writeFileSync(kit.cliScriptPath, shWrapper, { encoding: "utf8", mode: 0o700 });
    fs.chmodSync(kit.cliScriptPath, 0o700);
  }

  fs.writeFileSync(
    kit.herdrPluginManifestPath,
    buildHerdrPluginManifestToml(kit.cliScriptPath, pluginVersion),
    {
      encoding: "utf8",
      mode: 0o600,
    }
  );

  const mcpConfigPayload = {
    mcpServers: {
      obsidian_vault: {
        command: kit.cliScriptPath,
        args: ["mcp"],
      },
    },
  };
  fs.writeFileSync(
    kit.mcpConfigFilePath,
    JSON.stringify(mcpConfigPayload, null, 2) + "\n",
    {
      encoding: "utf8",
      mode: 0o600,
    }
  );
}

export function buildBridgeEnvForPanes(options: {
  kit: ProvisionedRuntimeKit;
  token: string;
  vaultName: string;
  vaultPath: string | null;
}): Record<string, string> {
  const normalizedHost = buildHostNormalizedEnv(process.env);
  const existingPath = normalizedHost.PATH || "";
  const pathParts = existingPath.split(path.delimiter).filter(Boolean);
  const dedupedParts = [
    options.kit.binDir,
    ...pathParts.filter((entry) => entry !== options.kit.binDir),
  ];

  const envOut: Record<string, string> = {
    OBSIDIAN_HERDR_BRIDGE_SOCKET: options.kit.socketPath,
    OBSIDIAN_HERDR_BRIDGE_TOKEN: options.token,
    OBSIDIAN_HERDR_CONNECTION_FILE: options.kit.connectionFilePath,
    OBSIDIAN_HERDR_MCP_CONFIG: options.kit.mcpConfigFilePath,
    OBSIDIAN_HERDR_CLI: options.kit.cliScriptPath,
    OBSIDIAN_VAULT_NAME: options.vaultName,
    ...(options.vaultPath ? { OBSIDIAN_VAULT_PATH: options.vaultPath } : {}),
    PATH: dedupedParts.join(path.delimiter),
  };

  if (normalizedHost.SHELL) {
    envOut.SHELL = normalizedHost.SHELL;
  }
  if (normalizedHost.XDG_CONFIG_HOME) {
    envOut.XDG_CONFIG_HOME = normalizedHost.XDG_CONFIG_HOME;
  }

  return envOut;
}

const STALE_EMPTY_KIT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const KIT_DIR_NAME_RE = /^(?:oh-)?[0-9a-f]{12}$/;

function isRealFile(filePath: string): boolean {
  try {
    const st = fs.lstatSync(filePath);
    return !st.isSymbolicLink() && st.isFile();
  } catch {
    return false;
  }
}

function hasKitBinSignature(entryPath: string): boolean {
  const binPath = path.join(entryPath, "bin");
  try {
    const binStat = fs.lstatSync(binPath);
    if (binStat.isSymbolicLink() || !binStat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }
  return (
    isRealFile(path.join(binPath, "obs-herdr-core.mjs")) ||
    isRealFile(path.join(binPath, "obs-herdr-core.py"))
  );
}

function isSocketLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (live: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(live);
    };
    const sock = net.createConnection({ path: socketPath });
    sock.setTimeout(250, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export async function pruneStaleRuntimeKits(opts: {
  baseDir?: string;
  keepDigest: string;
}): Promise<{ removed: string[] }> {
  const homeCacheBase = path.resolve(path.join(os.homedir(), ".cache", "obs-herdr"));
  const defaultBase =
    process.platform !== "win32" ? homeCacheBase : os.tmpdir();
  const baseDir = path.resolve(opts.baseDir || defaultBase);
  const isHomeCacheBase = baseDir === homeCacheBase;
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return { removed };
  }
  const keepNames = new Set([opts.keepDigest, `oh-${opts.keepDigest}`]);
  const now = Date.now();

  for (const entry of entries) {
    if (!KIT_DIR_NAME_RE.test(entry.name) || keepNames.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(baseDir, entry.name);
    if (path.dirname(entryPath) !== baseDir) {
      continue;
    }
    let dirStat: fs.Stats;
    try {
      dirStat = fs.lstatSync(entryPath);
    } catch {
      continue;
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      continue;
    }

    const sockPath = path.join(entryPath, "b.sock");
    let hasLiveSocket = false;
    try {
      const sockStat = fs.lstatSync(sockPath);
      if (!sockStat.isSymbolicLink()) {
        hasLiveSocket = await isSocketLive(sockPath);
      }
    } catch {
      hasLiveSocket = false;
    }
    if (hasLiveSocket) {
      continue;
    }

    const connPath = path.join(entryPath, "connection.json");
    let stale = false;
    let hasConnFile = false;
    let hasConnSignature = false;
    try {
      const connStat = fs.lstatSync(connPath);
      if (!connStat.isSymbolicLink() && connStat.isFile()) {
        hasConnFile = true;
        const parsed = JSON.parse(fs.readFileSync(connPath, "utf8")) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "vaultPath")) {
          hasConnSignature = true;
          if (typeof parsed.vaultPath === "string" && parsed.vaultPath.trim().length > 0) {
            stale = !fs.existsSync(parsed.vaultPath);
          }
        }
      }
    } catch {
      hasConnFile = false;
    }

    const hasBinSig = hasKitBinSignature(entryPath);
    const isOld = now - dirStat.mtimeMs > STALE_EMPTY_KIT_MAX_AGE_MS;

    if (!hasConnFile && isOld) {
      if (hasBinSig) {
        stale = true;
      } else if (isHomeCacheBase && /^[0-9a-f]{12}$/.test(entry.name)) {
        stale = true;
      }
    }

    if (stale && (hasConnSignature || hasBinSig || (isHomeCacheBase && /^[0-9a-f]{12}$/.test(entry.name)))) {
      try {
        fs.rmSync(entryPath, { recursive: true, force: true });
        removed.push(entry.name);
      } catch {
        // Ignore removal errors on busy/protected entries
      }
    }
  }

  return { removed };
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

const UI_TARGET_SCHEMA = {
  type: "object",
  description:
    "Target a note anchor {note, line?, after?, heading?, at?:\"start\"|\"end\"}, CSS selector {selector}, or CSS pixels {x, y}.",
  properties: {
    note: { type: "string" },
    path: { type: "string" },
    line: { type: "number" },
    after: { type: "string" },
    heading: { type: "string" },
    at: { type: "string", enum: ["start", "end"] },
    selector: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
  },
};

const SHARED_MCP_TOOLS = [
  {
    name: "obsidian_vault_info",
    description: "Get live Obsidian vault metadata and active note.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    rpc: "vault.info",
  },
  {
    name: "obsidian_list_files",
    description: "List files in the Obsidian vault with optional folder, tag, or extension filter.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string" },
        tag: { type: "string" },
        extension: { type: "string" },
        limit: { type: "number" },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    rpc: "vault.list_files",
  },
  {
    name: "obsidian_read_note",
    description: "Read a vault note along with frontmatter, headings, tags, and backlinks.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    rpc: "vault.read_note",
  },
  {
    name: "obsidian_search_notes",
    description: "Search Markdown notes across the Obsidian vault.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    rpc: "vault.search",
  },
  {
    name: "obsidian_create_note",
    description: "Create a new Markdown note safely in the vault.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        overwrite: { type: "boolean" },
      },
      required: ["path", "content"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    rpc: "vault.create_note",
  },
  {
    name: "obsidian_update_note",
    description:
      "Atomically update a vault note (append, prepend, replace, under_heading, search_replace).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        mode: { type: "string" },
        content: { type: "string" },
        heading: { type: "string" },
        search: { type: "string" },
      },
      required: ["path", "content"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    rpc: "vault.update_note",
  },
  {
    name: "obsidian_patch_frontmatter",
    description: "Atomically update YAML frontmatter via FileManager.processFrontMatter.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        set: { type: "object" },
        unset: { type: "array", items: { type: "string" } },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    rpc: "vault.patch_frontmatter",
  },
  {
    name: "obsidian_rename_note",
    description: "Rename or move a note via FileManager.renameFile while updating all wiki links.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, newPath: { type: "string" } },
      required: ["path", "newPath"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    rpc: "vault.rename_note",
  },
  {
    name: "obsidian_trash_note",
    description: "Move a note to trash via FileManager.trashFile.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    rpc: "vault.trash_note",
  },
  {
    name: "obsidian_backlinks",
    description: "List resolved backlinks pointing to a vault note.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    rpc: "metadata.backlinks",
  },
  {
    name: "obsidian_graph_neighbors",
    description: "Inspect outgoing links, incoming backlinks, unresolved links, and orphan status.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    rpc: "metadata.graph_neighbors",
  },
  {
    name: "obsidian_upsert_canvas_node",
    description: "Create or update a node inside an Obsidian .canvas file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        id: { type: "string" },
        nodeType: { type: "string" },
        text: { type: "string" },
        file: { type: "string" },
        url: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        color: { type: "string" },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    rpc: "canvas.upsert_node",
  },
  {
    name: "obsidian_workspace_state",
    description: "Inspect active note, open Markdown tabs, cursor position, and selection.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    rpc: "workspace.get_state",
  },
  {
    name: "obsidian_open_note",
    description: "Open and focus a note in the live Obsidian workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "number" },
        pane: { type: "string" },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    rpc: "workspace.open_note",
  },
  {
    name: "obsidian_editor_selection",
    description: "Read the current selection and cursor coordinates in the active Markdown editor.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    rpc: "editor.selection",
  },
  {
    name: "obsidian_editor_insert",
    description: "Insert text at the current cursor position in the active Markdown editor.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    rpc: "editor.insert_at_cursor",
  },
  {
    name: "obsidian_screenshot",
    description:
      "Capture the Obsidian window as a PNG image only on failure or when asked. Needs UI control enabled in Herdr settings. Use cssPixelsPerImagePixel to map image pixels to CSS pixels for other UI tools.",
    inputSchema: {
      type: "object",
      properties: { maxWidth: { type: "number", description: "Downscale to this width in pixels (320 or more)." } },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    rpc: "ui.screenshot",
  },
  {
    name: "obsidian_inspect",
    description:
      "List visible interface elements with labels, text, CSS selectors, and CSS pixel bounds. Not needed before anchored note actions. Optional selector and text filters.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        limit: { type: "number" },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    rpc: "ui.inspect",
  },
  {
    name: "obsidian_wait_for",
    description: "Wait until text is visible in the Obsidian window (optionally inside a selector). Timeout up to 20000 ms.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        selector: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["text"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    rpc: "ui.wait_for",
  },
  {
    name: "obsidian_click",
    description:
      "Click in the Obsidian window. Target is {selector} matching exactly one visible element, or {x, y} in CSS pixels. Needs UI control and Full permission.",
    inputSchema: {
      type: "object",
      properties: {
        target: UI_TARGET_SCHEMA,
        button: { type: "string", enum: ["left", "right", "middle"] },
        count: { type: "number" },
      },
      required: ["target"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    rpc: "ui.click",
  },
  {
    name: "obsidian_type",
    description:
      "Type text into the focused editable field, or click a target first. Password fields are refused. Needs UI control and Full permission.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, target: UI_TARGET_SCHEMA },
      required: ["text"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    rpc: "ui.type",
  },
  {
    name: "obsidian_press_key",
    description:
      "Press one key with optional modifiers (Mod is Cmd on macOS, Ctrl elsewhere). Keys: letters, digits, Enter, Tab, Escape, Backspace, Delete, Arrow keys, Home, End, PageUp, PageDown, Space.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        modifiers: { type: "array", items: { type: "string" } },
      },
      required: ["key"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    rpc: "ui.press_key",
  },
  {
    name: "obsidian_scroll",
    description: "Scroll at a target. Positive deltaY scrolls down, positive deltaX scrolls right.",
    inputSchema: {
      type: "object",
      properties: {
        target: UI_TARGET_SCHEMA,
        deltaX: { type: "number" },
        deltaY: { type: "number" },
      },
      required: ["target"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    rpc: "ui.scroll",
  },
  {
    name: "obsidian_drag",
    description: "Drag with the left mouse button from one target to another, for example to resize panels or move items.",
    inputSchema: {
      type: "object",
      properties: {
        from: UI_TARGET_SCHEMA,
        to: UI_TARGET_SCHEMA,
        steps: { type: "number" },
      },
      required: ["from", "to"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    rpc: "ui.drag",
  },
  {
    name: "obsidian_select",
    description:
      "Choose an option in a visible <select> dropdown by value or label, dispatching input and change events. Refuses protected areas.",
    inputSchema: {
      type: "object",
      properties: {
        target: UI_TARGET_SCHEMA,
        value: { type: "string", description: "Exact option value attribute to select." },
        label: { type: "string", description: "Visible option label text to select." },
      },
      required: ["target"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    rpc: "ui.select",
  },
  {
    name: "obsidian_ui_batch",
    description:
      "Run up to 20 UI steps (click, select, type, press_key, scroll, drag, wait_for, insert_line) atomically inside the serialized UI lock so parallel agents do not interleave.",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["click", "select", "type", "press_key", "scroll", "drag", "wait_for", "insert_line"],
              },
              target: UI_TARGET_SCHEMA,
              value: { type: "string" },
              label: { type: "string" },
              text: { type: "string" },
              key: { type: "string" },
              modifiers: { type: "array", items: { type: "string" } },
              deltaX: { type: "number" },
              deltaY: { type: "number" },
              from: UI_TARGET_SCHEMA,
              to: UI_TARGET_SCHEMA,
              steps: { type: "number" },
              selector: { type: "string" },
              timeoutMs: { type: "number" },
              button: { type: "string", enum: ["left", "right", "middle"] },
              count: { type: "number" },
            },
            required: ["action"],
          },
        },
      },
      required: ["steps"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    rpc: "ui.batch",
  },
];

const UI_BATCH_SCHEMA_LINES = [
  'Target (<target>): {"note":"<path>","line"?:<n>,"after"?:"<exact line>","heading"?:"<heading>","at"?:"end"|"start"} | {"selector":"<css>"} | {"x":<n>,"y":<n>}',
  "Steps (max 20, executed inside one serialized lock):",
  '  insert_line: {"action":"insert_line","target":<anchor>,"text":"<line>"}',
  '  click:       {"action":"click","target":<target>,"button"?:"left"|"right"|"middle","count"?:<n>}',
  '  select:      {"action":"select","target":<target>,"value"?:"<v>","label"?:"<text>"}',
  '  type:        {"action":"type","text":"<text>","target"?:<target>}',
  '  press_key:   {"action":"press_key","key":"<Key>","modifiers"?:["Mod"|"Ctrl"|"Alt"|"Shift"|"Meta"]}',
  '  scroll:      {"action":"scroll","target":<target>,"deltaX"?:<n>,"deltaY"?:<n>}',
  '  drag:        {"action":"drag","from":<target>,"to":<target>,"steps"?:<n>}',
  '  wait_for:    {"action":"wait_for","text":"<text>","selector"?:<css>,"timeoutMs"?:<n>}',
  "",
  "Example (anchor + insert_line, recommended for shared notes):",
  "  obs-herdr ui batch --steps-json '[{\"action\":\"insert_line\",\"target\":{\"note\":\"Crew Test/Mission Board.md\",\"heading\":\"agy2: How agents share one note\"},\"text\":\"- Added safely at section end\"}]'",
  "Example (click at a point, press End, Enter, and type a line):",
  "  obs-herdr ui batch --steps-json '[{\"action\":\"click\",\"target\":{\"x\":1200,\"y\":360}},{\"action\":\"press_key\",\"key\":\"End\"},{\"action\":\"press_key\",\"key\":\"Enter\"},{\"action\":\"type\",\"text\":\"- New bullet line\"}]'",
];

const SHARED_SKILL_TEXT = [
  "---",
  "name: obsidian-vault-bridge",
  'description: "Inspect, search, create, edit, link-safe rename, and navigate notes in the live Obsidian vault via obs-herdr."',
  "---",
  "",
  "# Obsidian Vault Control Bridge (obs-herdr)",
  "",
  "Use `obs-herdr` inside Herdr panes to interact with the live Obsidian app and vault safely through Obsidian's native Vault, FileManager, MetadataCache, and Workspace APIs.",
  "Run `obs-herdr <group> --help` or `obs-herdr <group> <cmd> --help` for per-command usage.",
  "",
  "## Commands",
  "",
  "  obs-herdr vault info",
  "  obs-herdr note list [--folder <dir>] [--tag <tag>] [--extension <ext>] [--limit <n>]",
  "  obs-herdr note read <vault-rel-path>",
  "  obs-herdr note search <query> [--limit <n>]",
  "  obs-herdr note create <vault-rel-path> [--content <text> | --stdin] [--overwrite]",
  "  obs-herdr note update <vault-rel-path> [--mode append|prepend|replace|under_heading|search_replace] [--heading <h>] [--search <s>] [--content <text> | --stdin]",
  "  obs-herdr note frontmatter <vault-rel-path> [--set key=value | --set '{json}'] [--unset key ...]",
  "  obs-herdr note rename <old-path> <new-path>",
  "  obs-herdr note trash <vault-rel-path>",
  "  obs-herdr note backlinks <vault-rel-path>",
  "  obs-herdr note graph <vault-rel-path>",
  "  obs-herdr canvas upsert <canvas-path> [--type text|file|link|group] [--text <t>] [--file <p>] [--url <u>] [--id <id>] [--x <n>] [--y <n>] [--width <n>] [--height <n>] [--color <c>]",
  "  obs-herdr workspace state",
  "  obs-herdr workspace open <vault-rel-path> [--line <n>] [--pane current|tab|split]",
  "  obs-herdr workspace notice <message>",
  "  obs-herdr editor selection",
  "  obs-herdr editor insert [<text> | --stdin]",
  "  obs-herdr command list [--query <q>]",
  "  obs-herdr command run <command-id>",
  "  obs-herdr rpc <method> ['{json-params}']",
  `  obs-herdr mcp   # Run JSON-RPC 2.0 MCP server over stdio (${SHARED_MCP_TOOLS.length} tools)`,
  "",
  "## See and operate the Obsidian window",
  "",
  "Needs 'Let agents see and operate Obsidian' in Herdr settings. Clicking, typing, keys, scrolling, and dragging also need the Full permission tier, honor `uiTypingSpeed` (`visible` or `fast`), and fail with `ui_protected_area` inside Herdr terminal views, Obsidian Settings, or community plugin toggles unless `allowUiInProtectedAreas` is enabled. Check `obs-herdr vault info` (uiControl) first.",
  "",
  "  obs-herdr ui screenshot [--out <file.png> | --output <file.png>] [--max-width <px>] # screenshot only on failure or when asked",
  "  obs-herdr ui inspect [--selector <css>] [--text <t>] [--limit <n>]   # inspect non-note UI only; skip before anchored actions",
  "  obs-herdr ui locate --note <path> (--line <n> | --after <text> | --heading <h> | --text <t>) [--at end|start]   # scrolls into view and returns CSS point",
  "  obs-herdr ui insert-line --note <path> (--line <n> | --after <text> | --heading <h>) [--at end|start] (--text <t> | --stdin)   # atomic anchor + insert inside UI lock; returns proof (path, pane, line, text, heading, durationMs)",
  "  obs-herdr ui wait <text> [--selector <css>] [--timeout <ms>]",
  "  obs-herdr ui click (--note <path> (--line <n> | --after <t> | --heading <h>) [--at start|end] | --selector <css> | --x <n> --y <n>) [--button left|right|middle] [--count <n>]",
  "  obs-herdr ui select --selector <css> (--value <v> | --label <text>)",
  "  obs-herdr ui type [<text> | --text <t> | --stdin] [--note <path> (--line <n> | --after <t> | --heading <h>) [--at start|end] | --selector <css> | --x <n> --y <n>]",
  "  obs-herdr ui key <Key|Mod+Key>   # e.g. Enter, Escape, Mod+P, Mod+Shift+F",
  "  obs-herdr ui scroll (--note <path> ... | --selector <css> | --x <n> --y <n>) [--dy <n>] [--dx <n>]   # positive dy scrolls down",
  "  obs-herdr ui drag (--from-selector <css> | --from-x <n> --from-y <n> | --from-note <p> ...) (--to-selector <css> | --to-x <n> --to-y <n> | --to-note <p> ...) [--steps <n>]",
  "  obs-herdr ui batch (--steps-json '<json>' | --stdin)   # run up to 20 UI steps atomically without interleaving",
  "",
  "### ui batch step schema",
  "",
  ...UI_BATCH_SCHEMA_LINES.map((line) => (line ? "  " + line : "")),
  "",
  "### Multi-agent shared-note recipe",
  "",
  "  1. Read the shared chat note and target note once at the start (`obs-herdr note read <chat-note>` and `obs-herdr note read <target-note>`).",
  "  2. Coordinate turns and section ownership in the chat note (`obs-herdr note update <chat-note> --mode append --content \"<agent> -> all: ...\"`).",
  "  3. Edit directly with note anchors (`--note` + `--heading`, `--after`, or `--line`) via `obs-herdr ui insert-line` (or `ui batch` with `insert_line`). Do not run `ui inspect` or `ui locate` before anchored actions, and never use pixel coordinates for shared notes.",
  "  4. Use the proof returned by `insert-line` (`path`, `pane`, `line`, `text`, `heading`, `durationMs`) instead of a separate `note read` back. Take `ui screenshot` only on failure or when asked.",
  "",
  "Tips: anchor targets resolve inside the serialized UI lock at execution time and fail clearly if the note is not open. Skip `ui inspect` before anchored actions, trust the proof returned by `insert-line` instead of extra read-backs, and screenshot only on failure or when asked. Prefer `note` commands for silent vault edits; use UI control (`insert-line`, `batch`) when live cursors or interface actions are needed. Typing that changes the active note is logged and can be undone in Mission Control.",
].join("\n");

const SHARED_COMMAND_HELP = {
  groups: {
    vault: [
      "Usage: obs-herdr vault <command>",
      "",
      "Commands:",
      "  obs-herdr vault info   # Show vault metadata, active note, permission tier, and uiControl status",
    ].join("\n"),
    note: [
      "Usage: obs-herdr note <command> [args]",
      "",
      "Commands:",
      "  obs-herdr note list [--folder <dir>] [--tag <tag>] [--extension <ext>] [--limit <n>]",
      "  obs-herdr note read <vault-rel-path>",
      "  obs-herdr note search <query> [--limit <n>]",
      "  obs-herdr note create <vault-rel-path> [--content <text> | --stdin] [--overwrite]",
      "  obs-herdr note update <vault-rel-path> [--mode append|prepend|replace|under_heading|search_replace] [--heading <h>] [--search <s>] [--content <text> | --stdin]",
      "  obs-herdr note frontmatter <vault-rel-path> [--set key=value | --set '{json}'] [--unset key ...]",
      "  obs-herdr note rename <old-path> <new-path>",
      "  obs-herdr note trash <vault-rel-path>",
      "  obs-herdr note backlinks <vault-rel-path>",
      "  obs-herdr note graph <vault-rel-path>",
    ].join("\n"),
    canvas: [
      "Usage: obs-herdr canvas upsert <canvas-path> [flags]",
      "",
      "  obs-herdr canvas upsert <canvas-path> [--type text|file|link|group] [--text <t>] [--file <p>] [--url <u>] [--id <id>] [--x <n>] [--y <n>] [--width <n>] [--height <n>] [--color <c>]",
    ].join("\n"),
    workspace: [
      "Usage: obs-herdr workspace <command> [args]",
      "",
      "Commands:",
      "  obs-herdr workspace state",
      "  obs-herdr workspace open <vault-rel-path> [--line <n>] [--pane current|tab|split]",
      "  obs-herdr workspace notice <message>",
    ].join("\n"),
    editor: [
      "Usage: obs-herdr editor <command> [args]",
      "",
      "Commands:",
      "  obs-herdr editor selection",
      "  obs-herdr editor insert [<text> | --stdin]",
    ].join("\n"),
    command: [
      "Usage: obs-herdr command <command> [args]",
      "",
      "Commands:",
      "  obs-herdr command list [--query <q>]",
      "  obs-herdr command run <command-id>",
    ].join("\n"),
    ui: [
      "Usage: obs-herdr ui <command> [args]",
      "",
      "Commands:",
      "  obs-herdr ui screenshot [--out <file.png> | --output <file.png>] [--max-width <px>]",
      "  obs-herdr ui inspect [--selector <css>] [--text <t>] [--limit <n>]",
      "  obs-herdr ui locate --note <path> (--line <n> | --after <text> | --heading <h> | --text <t>) [--at end|start]",
      "  obs-herdr ui insert-line --note <path> (--line <n> | --after <text> | --heading <h>) [--at end|start] (--text <t> | --stdin)",
      "  obs-herdr ui wait <text> [--selector <css>] [--timeout <ms>]",
      "  obs-herdr ui click (--note <path> ... | --selector <css> | --x <n> --y <n>) [--button left|right|middle] [--count <n>]",
      "  obs-herdr ui select --selector <css> (--value <v> | --label <text>)",
      "  obs-herdr ui type [<text> | --text <t> | --stdin] [--note <path> ... | --selector <css> | --x <n> --y <n>]",
      "  obs-herdr ui key <Key|Mod+Key>",
      "  obs-herdr ui scroll (--note <path> ... | --selector <css> | --x <n> --y <n>) [--dy <n>] [--dx <n>]",
      "  obs-herdr ui drag (--from-selector <css> | --from-x <n> --from-y <n> | --from-note <p> ...) (--to-selector <css> | --to-x <n> --to-y <n> | --to-note <p> ...) [--steps <n>]",
      "  obs-herdr ui batch (--steps-json '<json>' | --stdin)",
      "",
      "Recipe: skip `ui inspect` before anchored actions, use the proof returned by `ui insert-line` instead of a separate read-back, and run `ui screenshot` only on failure or when asked.",
      "Run 'obs-herdr ui <command> --help' for anchor options, step schemas, and examples.",
    ].join("\n"),
    rpc: [
      "Usage: obs-herdr rpc <method> ['{json-params}']",
      "",
      "Calls a raw Vault Control Bridge JSON-RPC method.",
    ].join("\n"),
    mcp: [
      "Usage: obs-herdr mcp",
      "",
      `Runs the JSON-RPC 2.0 MCP stdio server exposing ${SHARED_MCP_TOOLS.length} tools.`,
    ].join("\n"),
  } as Record<string, string>,
  commands: {
    "vault info": "Usage: obs-herdr vault info\n\nReturn vault metadata, active note, permission tier, and uiControl status.",
    "note list": "Usage: obs-herdr note list [--folder <dir>] [--tag <tag>] [--extension <ext>] [--limit <n>]",
    "note read": "Usage: obs-herdr note read <vault-rel-path>",
    "note search": "Usage: obs-herdr note search <query> [--limit <n>]",
    "note create": "Usage: obs-herdr note create <vault-rel-path> [--content <text> | --stdin] [--overwrite]",
    "note update": "Usage: obs-herdr note update <vault-rel-path> [--mode append|prepend|replace|under_heading|search_replace] [--heading <h>] [--search <s>] [--content <text> | --stdin]",
    "note frontmatter": "Usage: obs-herdr note frontmatter <vault-rel-path> [--set key=value | --set '{json}'] [--unset key ...]",
    "note rename": "Usage: obs-herdr note rename <old-path> <new-path>",
    "note trash": "Usage: obs-herdr note trash <vault-rel-path>",
    "note backlinks": "Usage: obs-herdr note backlinks <vault-rel-path>",
    "note graph": "Usage: obs-herdr note graph <vault-rel-path>",
    "canvas upsert": "Usage: obs-herdr canvas upsert <canvas-path> [--type text|file|link|group] [--text <t>] [--file <p>] [--url <u>] [--id <id>] [--x <n>] [--y <n>] [--width <n>] [--height <n>] [--color <c>]",
    "workspace state": "Usage: obs-herdr workspace state",
    "workspace open": "Usage: obs-herdr workspace open <vault-rel-path> [--line <n>] [--pane current|tab|split]",
    "workspace notice": "Usage: obs-herdr workspace notice <message>",
    "editor selection": "Usage: obs-herdr editor selection",
    "editor insert": "Usage: obs-herdr editor insert [<text> | --stdin]",
    "command list": "Usage: obs-herdr command list [--query <q>]",
    "command run": "Usage: obs-herdr command run <command-id>",
    "ui screenshot": "Usage: obs-herdr ui screenshot [--out <file.png> | --output <file.png>] [--max-width <px>]\n\nCaptures the Obsidian window as a PNG and prints its path and viewport scale. Use only on failure or when asked.",
    "ui inspect": "Usage: obs-herdr ui inspect [--selector <css>] [--text <t>] [--limit <n>]\n\nLists visible UI elements in CSS pixels. When --text is given without --selector, editor lines (.cm-line) are also searched and include notePath and pane. Do not run before anchored note actions.",
    "ui locate": "Usage: obs-herdr ui locate --note <path> (--line <n> | --after <text> | --heading <h> | --text <t>) [--at end|start]\n       obs-herdr ui locate <vault-rel-path> (--line <n> | --after <text> | --heading <h> | --text <t>) [--at end|start]\n\nResolves the anchor inside the open note, scrolls it into view if needed, and returns its CSS pixel point.",
    "ui insert-line": "Usage: obs-herdr ui insert-line --note <path> (--line <n> | --after <text> | --heading <h>) [--at end|start] (--text <t> | --stdin)\n\nAtomically resolves the anchor inside the serialized UI lock, places the caret, and inserts a newline plus text without list double-bullets. Returns proof (path, pane, line, text, heading, durationMs) so no separate read-back is needed.",
    "ui wait": "Usage: obs-herdr ui wait <text> [--selector <css>] [--timeout <ms>]\n\nWaits up to 20000 ms for visible text.",
    "ui click": "Usage: obs-herdr ui click (--note <path> (--line <n> | --after <t> | --heading <h>) [--at end|start] | --selector <css> | --x <n> --y <n>) [--button left|right|middle] [--count <n>]",
    "ui select": "Usage: obs-herdr ui select --selector <css> (--value <v> | --label <text>)\n\nSelects an option in a <select> dropdown by value or label and dispatches input and change events.",
    "ui type": "Usage: obs-herdr ui type [<text> | --text <t> | --stdin] [--note <path> (--line <n> | --after <t> | --heading <h>) [--at end|start] | --selector <css> | --x <n> --y <n>]",
    "ui key": "Usage: obs-herdr ui key <Key|Mod+Key>\n\nExamples: Enter, End, Escape, Mod+P, Mod+Shift+F",
    "ui scroll": "Usage: obs-herdr ui scroll (--note <path> ... | --selector <css> | --x <n> --y <n>) [--dy <n>] [--dx <n>]\n\nPositive dy scrolls down; positive dx scrolls right.",
    "ui drag": "Usage: obs-herdr ui drag (--from-selector <css> | --from-x <n> --from-y <n> | --from-note <p> ...) (--to-selector <css> | --to-x <n> --to-y <n> | --to-note <p> ...) [--steps <n>]",
    "ui batch": [
      "Usage: obs-herdr ui batch (--steps-json '<json>' | --stdin | '<json>')",
      "",
      ...UI_BATCH_SCHEMA_LINES,
    ].join("\n"),
  } as Record<string, string>,
};

const UI_TARGET_FLAGS = ["note", "path", "line", "after", "heading", "at", "selector", "x", "y"];
function prefixUiTargetFlags(prefix: string): string[] {
  return UI_TARGET_FLAGS.map((name) => `${prefix}${name}`);
}

const SHARED_UI_ALLOWED_FLAGS: Record<string, string[]> = {
  screenshot: ["out", "output", "max-width"],
  inspect: ["selector", "text", "limit"],
  locate: ["note", "path", "line", "after", "heading", "at", "text"],
  "insert-line": ["note", "path", "line", "after", "heading", "at", "text", "stdin"],
  wait: ["selector", "timeout"],
  click: [...prefixUiTargetFlags(""), "button", "count"],
  select: [...prefixUiTargetFlags(""), "value", "label"],
  type: [...prefixUiTargetFlags(""), "text", "stdin"],
  key: [],
  scroll: [...prefixUiTargetFlags(""), "dx", "dy"],
  drag: [...prefixUiTargetFlags("from-"), ...prefixUiTargetFlags("to-"), "steps"],
  batch: ["steps-json", "stdin"],
};

function buildObsHerdrCoreMjs(defaultConnFile: string, pluginVersion: string): string {
  return `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as readline from "node:readline";

const DEFAULT_CONN_FILE = ${JSON.stringify(defaultConnFile)};
const PLUGIN_VERSION = ${JSON.stringify(pluginVersion)};

const SKILL_TEXT = ${JSON.stringify(SHARED_SKILL_TEXT)};

const COMMAND_HELP = ${JSON.stringify(SHARED_COMMAND_HELP)};

const UI_ALLOWED_FLAGS = ${JSON.stringify(SHARED_UI_ALLOWED_FLAGS)};

function resolveConnection() {
  const connFile = process.env.OBSIDIAN_HERDR_CONNECTION_FILE || DEFAULT_CONN_FILE;
  if (connFile && fs.existsSync(connFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(connFile, "utf8"));
      if (raw && raw.socketPath && raw.token) {
        return { socketPath: raw.socketPath, token: raw.token };
      }
    } catch {
      // Fall back to environment variables
    }
  }
  if (process.env.OBSIDIAN_HERDR_BRIDGE_SOCKET && process.env.OBSIDIAN_HERDR_BRIDGE_TOKEN) {
    return {
      socketPath: process.env.OBSIDIAN_HERDR_BRIDGE_SOCKET,
      token: process.env.OBSIDIAN_HERDR_BRIDGE_TOKEN,
    };
  }
  const raw = JSON.parse(fs.readFileSync(connFile, "utf8"));
  return { socketPath: raw.socketPath, token: raw.token };
}

function resolveTimeoutMs(method, params) {
  const envRaw = process.env.OBS_HERDR_TIMEOUT_MS;
  const envNum = envRaw !== undefined && envRaw !== "" ? Number(envRaw) : NaN;
  const base = Number.isFinite(envNum) && envNum > 0 ? Math.round(envNum) : 60000;
  if (method === "ui.wait_for") {
    const p = params && typeof params === "object" ? params : {};
    const waitMs = Number.isFinite(Number(p.timeoutMs)) && Number(p.timeoutMs) >= 0 ? Number(p.timeoutMs) : 5000;
    return Math.max(base, Math.round(waitMs) + 30000);
  }
  if (method === "ui.batch") {
    const p = params && typeof params === "object" ? params : {};
    let totalWait = Number.isFinite(Number(p.timeoutMs)) && Number(p.timeoutMs) >= 0 ? Number(p.timeoutMs) : 0;
    if (Array.isArray(p.steps)) {
      for (const s of p.steps) {
        if (s && s.action === "wait_for") {
          const sw = Number.isFinite(Number(s.timeoutMs)) && Number(s.timeoutMs) >= 0 ? Number(s.timeoutMs) : 5000;
          totalWait += sw;
        }
      }
    }
    if (totalWait > 0) {
      return Math.max(base, Math.round(totalWait) + 30000);
    }
  }
  return base;
}

function callBridge(method, params = {}) {
  const { socketPath, token } = resolveConnection();
  const id = "cli_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const caller = process.env.HERDR_PANE_ID ? "herdr:" + process.env.HERDR_PANE_ID : "obs-herdr-cli";
  const timeoutMs = resolveTimeoutMs(method, params);
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const sock = net.createConnection({ path: socketPath });
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) {
        reject(err);
      } else {
        resolve(val);
      }
    };
    const timer = setTimeout(() => {
      finish(new Error("Bridge request timed out after " + timeoutMs + " ms (" + method + ")."));
    }, timeoutMs);
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id, token, method, params, caller }) + "\\n", "utf8");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\\n");
      if (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        let res;
        try {
          res = JSON.parse(line);
        } catch (parseErr) {
          finish(new Error("Invalid JSON response from Obsidian bridge: " + (parseErr instanceof Error ? parseErr.message : String(parseErr))));
          return;
        }
        if (!res || !res.ok) {
          finish(new Error((res?.error?.code || "error") + ": " + (res?.error?.message || "Bridge error")));
        } else {
          finish(null, res.result);
        }
      }
    });
    sock.on("end", () => {
      finish(new Error("Bridge connection closed before a complete response was received (" + method + ")."));
    });
    sock.on("close", () => {
      finish(new Error("Bridge connection closed before a complete response was received (" + method + ")."));
    });
    sock.on("error", (err) => finish(err));
  });
}

function parseSetFlags(rawSets) {
  const out = {};
  for (const item of rawSets) {
    const trimmed = String(item).trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      Object.assign(out, JSON.parse(trimmed));
    } else {
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
      }
    }
  }
  return out;
}

function parseFlags(args, opts) {
  const strict = !opts || opts.strict !== false;
  const pos = [];
  const flags = { set: [], unset: [] };
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (afterDoubleDash) {
      pos.push(a);
      continue;
    }
    if (a === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (a === "--stdin" || a === "--overwrite" || a === "--help" || a === "-h") {
      flags[a === "-h" ? "help" : a.slice(2)] = true;
    } else if (a.startsWith("--")) {
      const eqIdx = a.indexOf("=");
      if (eqIdx >= 0) {
        const key = a.slice(2, eqIdx);
        const val = a.slice(eqIdx + 1);
        if (!key) {
          if (strict) throw new Error("Invalid flag '" + a + "'.");
          continue;
        }
        if (key === "set" || key === "unset") {
          flags[key].push(val);
        } else {
          flags[key] = val;
        }
      } else if (args[i + 1] !== undefined) {
        const key = a.slice(2);
        if (key === "set" || key === "unset") {
          flags[key].push(args[++i]);
        } else {
          flags[key] = args[++i];
        }
      } else if (strict) {
        throw new Error("Missing value for flag '" + a + "'.");
      }
    } else if (/^-[A-Za-z]/.test(a)) {
      if (strict) {
        throw new Error("Unknown flag '" + a + "'. Run 'obs-herdr --help' for usage.");
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function validateUiFlags(sub, flags) {
  const allowedList = UI_ALLOWED_FLAGS[sub];
  if (!allowedList) {
    return;
  }
  const allowed = new Set(allowedList);
  if (Array.isArray(flags.set) && flags.set.length > 0 && !allowed.has("set")) {
    throw new Error("Unknown flag '--set' for 'obs-herdr ui " + sub + "'. Run 'obs-herdr ui " + sub + " --help' for usage.");
  }
  if (Array.isArray(flags.unset) && flags.unset.length > 0 && !allowed.has("unset")) {
    throw new Error("Unknown flag '--unset' for 'obs-herdr ui " + sub + "'. Run 'obs-herdr ui " + sub + " --help' for usage.");
  }
  for (const key of Object.keys(flags)) {
    if (key === "set" || key === "unset" || key === "help") {
      continue;
    }
    if (!allowed.has(key)) {
      throw new Error("Unknown flag '--" + key + "' for 'obs-herdr ui " + sub + "'. Run 'obs-herdr ui " + sub + " --help' for usage.");
    }
  }
}

function resolveHelpText(argv) {
  if (argv.length === 0 || argv[0] === "--skill") {
    return SKILL_TEXT;
  }
  const hasHelpFlag = argv.includes("--help") || argv.includes("-h");
  const isHelpCmd = argv[0] === "help";
  if (!hasHelpFlag && !isHelpCmd) {
    return null;
  }
  const { pos } = parseFlags(isHelpCmd ? argv.slice(1) : argv, { strict: false });
  const group = pos[0];
  const sub = pos[1];
  if (!group) {
    return SKILL_TEXT;
  }
  if (!sub || group === "mcp" || group === "rpc") {
    if (COMMAND_HELP.groups[group]) {
      return COMMAND_HELP.groups[group];
    }
    throw new Error("Unknown obs-herdr command '" + group + "'. Run 'obs-herdr --help' for usage.");
  }
  const key = group + " " + sub;
  if (COMMAND_HELP.commands[key]) {
    return COMMAND_HELP.commands[key];
  }
  throw new Error("Unknown obs-herdr command '" + key + "'. Run 'obs-herdr --help' for usage.");
}

const MCP_TOOLS = ${JSON.stringify(SHARED_MCP_TOOLS)};

function toMcpContent(out) {
  if (out && typeof out === "object" && out.image && typeof out.image.data === "string") {
    const { image, ...rest } = out;
    return [
      { type: "image", data: image.data, mimeType: image.mimeType || "image/png" },
      { type: "text", text: JSON.stringify(rest, null, 2) },
    ];
  }
  return [{ type: "text", text: JSON.stringify(out, null, 2) }];
}

function parsePositiveInt(raw, flagName) {
  if (raw === undefined) return undefined;
  const s = String(raw).trim();
  if (!/^[1-9][0-9]*$/.test(s)) {
    throw new Error("--" + flagName + " must be a positive integer.");
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error("--" + flagName + " must be a positive integer.");
  }
  return n;
}

function parseNonNegativeInt(raw, flagName) {
  if (raw === undefined) return undefined;
  const s = String(raw).trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(s)) {
    throw new Error("--" + flagName + " must be a non-negative integer.");
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error("--" + flagName + " must be a non-negative integer.");
  }
  return n;
}

function parseFiniteNumber(raw, flagName) {
  if (raw === undefined) return undefined;
  const s = String(raw).trim();
  if (!/^-?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)$/.test(s)) {
    throw new Error("--" + flagName + " must be a finite number.");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) {
    throw new Error("--" + flagName + " must be a finite number.");
  }
  return n;
}

function parseAtPosition(raw, flagName) {
  if (raw === undefined) return undefined;
  const val = String(raw).trim();
  if (val !== "start" && val !== "end") {
    throw new Error("--" + flagName + " must be 'start' or 'end'.");
  }
  return val;
}

function uiTarget(flags, prefix) {
  const noteVal = flags[prefix + "note"] ?? flags[prefix + "path"];
  const hasLine = flags[prefix + "line"] !== undefined;
  const hasAfter = flags[prefix + "after"] !== undefined;
  const hasHeading = flags[prefix + "heading"] !== undefined;
  const hasAt = flags[prefix + "at"] !== undefined;
  if (noteVal !== undefined) {
    const note = String(noteVal).trim();
    if (!note) {
      throw new Error("--" + prefix + "note cannot be empty.");
    }
    const target = { note };
    if (hasLine) target.line = parsePositiveInt(flags[prefix + "line"], prefix + "line");
    if (hasAfter) target.after = String(flags[prefix + "after"]);
    if (hasHeading) target.heading = String(flags[prefix + "heading"]);
    if (hasAt) target.at = parseAtPosition(flags[prefix + "at"], prefix + "at");
    return target;
  }
  if (hasLine || hasAfter || hasHeading || hasAt) {
    throw new Error("--" + prefix + "line/--after/--heading/--at requires --" + prefix + "note <path>.");
  }
  const sel = flags[prefix + "selector"];
  if (sel) return { selector: sel };
  if (flags[prefix + "x"] !== undefined && flags[prefix + "y"] !== undefined) {
    return {
      x: parseFiniteNumber(flags[prefix + "x"], prefix + "x"),
      y: parseFiniteNumber(flags[prefix + "y"], prefix + "y"),
    };
  }
  return undefined;
}

function saveScreenshot(shot, outFlag) {
  const connFile = process.env.OBSIDIAN_HERDR_CONNECTION_FILE || DEFAULT_CONN_FILE;
  let outPath = outFlag;
  if (!outPath) {
    const dir = path.join(path.dirname(connFile), "screenshots");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    outPath = path.join(dir, "obsidian-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png");
  }
  fs.writeFileSync(outPath, Buffer.from(shot.image.data, "base64"), { mode: 0o600 });
  const { image, ...rest } = shot;
  return { path: path.resolve(outPath), ...rest };
}

async function runMcpServer() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;
    try {
      if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "obsidian-herdr-bridge", version: PLUGIN_VERSION } } }) + "\\n");
      } else if (msg.method === "tools/list") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: MCP_TOOLS.map(({ rpc, ...rest }) => rest) } }) + "\\n");
      } else if (msg.method === "tools/call") {
        const tool = MCP_TOOLS.find((t) => t.name === msg.params?.name);
        if (!tool) throw new Error("Unknown tool: " + msg.params?.name);
        const out = await callBridge(tool.rpc, msg.params?.arguments || {});
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: toMcpContent(out) } }) + "\\n");
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
      }
    } catch (err) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } }) + "\\n");
    }
  }
}

async function runPluginAction(action) {
  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  if (action === "vault-status") {
    const info = await callBridge("vault.info", {});
    execFileSync(herdrBin, ["notification", "show", "Vault: " + info.vaultName, "--body", info.markdownCount + " notes (" + info.permissionMode + ")"]);
  } else if (action === "active-note") {
    const st = await callBridge("workspace.get_state", {});
    execFileSync(herdrBin, ["notification", "show", "Active note", "--body", st.activeFile || "No active note"]);
  } else if (action === "capture-pane" && process.env.HERDR_PANE_ID) {
    const text = execFileSync(herdrBin, ["pane", "read", process.env.HERDR_PANE_ID, "--source", "recent-unwrapped", "--lines", "120"], { encoding: "utf8" });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const notePath = "Herdr Captures/Pane " + process.env.HERDR_PANE_ID.replace(/[:%]/g, "-") + " " + stamp + ".md";
    await callBridge("vault.create_note", { path: notePath, content: "# Herdr Pane Capture (" + process.env.HERDR_PANE_ID + ")\\n\\n\`\`\`text\\n" + text.trim() + "\\n\`\`\`\\n" });
    await callBridge("workspace.open_note", { path: notePath });
    execFileSync(herdrBin, ["notification", "show", "Saved pane to vault", "--body", notePath]);
  }
}

function stripHeadingPrefix(line) {
  return String(line || "").replace(/^#{1,6}[ \\t]+/, "");
}

function lineMatches(elText, expected) {
  const a = String(elText || "").trim();
  const b = String(expected || "").trim();
  return a === b || a.includes(b);
}

async function resolvePaneDescriptors() {
  let state = { activeFile: null, openNotes: [] };
  try {
    state = await callBridge("workspace.get_state", {});
  } catch {
    // Ignore workspace lookup error
  }
  const openNotes = Array.isArray(state.openNotes) ? state.openNotes : [];
  let titles = [];
  let breadcrumbs = [];
  try {
    const tRes = await callBridge("ui.inspect", { selector: ".view-header-title", limit: 30 });
    titles = Array.isArray(tRes.elements) ? tRes.elements : [];
  } catch {
    titles = [];
  }
  if (titles.length > 1) {
    try {
      const bRes = await callBridge("ui.inspect", { selector: ".view-header-breadcrumb", limit: 30 });
      breadcrumbs = Array.isArray(bRes.elements) ? bRes.elements : [];
    } catch {
      breadcrumbs = [];
    }
  }
  const rawPanes = titles.map((h, idx) => {
    const title = String(h.text || "").trim();
    const candidates = openNotes.filter((p) => {
      const base = path.posix.basename(p, ".md");
      return base === title || p === title;
    });
    let matchedPath = candidates.length === 1 ? candidates[0] : null;
    if (!matchedPath && candidates.length > 1) {
      const bc = breadcrumbs.find(
        (b) => b.rect && h.rect && Math.abs(b.rect.x - h.rect.x) < 120 && Math.abs(b.rect.y - h.rect.y) < 60
      );
      if (bc && bc.text) {
        const folder = String(bc.text).trim();
        matchedPath = candidates.find((p) => path.posix.dirname(p) === folder) || null;
      }
    }
    if (!matchedPath && candidates.length === 0 && state.activeFile && path.posix.basename(state.activeFile, ".md") === title) {
      matchedPath = state.activeFile;
    }
    const r = h.rect || { x: 0, y: 0, width: 400, height: 30 };
    return {
      pane: "pane-" + (idx + 1),
      notePath: matchedPath,
      candidates,
      xMin: r.x - 40,
      xMax: r.x + r.width + 40,
      headerY: r.y,
      centerX: Math.round(r.x + r.width / 2),
    };
  });
  const panes = rawPanes.map((p) => {
    const belowYs = rawPanes
      .filter((other) => other !== p && other.headerY > p.headerY + 20 && other.xMin <= p.xMax && p.xMin <= other.xMax)
      .map((other) => other.headerY);
    const yMin = p.headerY - 4;
    const yMax = belowYs.length > 0 ? Math.min(...belowYs) - 4 : Number.POSITIVE_INFINITY;
    const targetMidY = Number.isFinite(yMax) ? (p.headerY + yMax) / 2 : p.headerY + 220;
    return {
      pane: p.pane,
      notePath: p.notePath,
      candidates: p.candidates,
      xMin: p.xMin,
      xMax: p.xMax,
      yMin,
      yMax,
      centerX: p.centerX,
      centerY: Math.round(Math.min(Math.max(targetMidY, p.headerY + 40), Number.isFinite(yMax) ? yMax - 12 : 600)),
    };
  });
  return { panes, activeFile: state.activeFile || null, openNotes };
}

function annotateEditorElements(elements, paneInfo) {
  return elements.map((el) => {
    if (el.notePath && el.pane) {
      return el;
    }
    const r = el.rect;
    if (r && paneInfo.panes.length > 0) {
      const match = paneInfo.panes.find(
        (p) => r.x >= p.xMin && r.x <= p.xMax && r.y >= p.yMin && r.y < p.yMax
      );
      if (match) {
        return {
          ...el,
          ...(el.notePath ? {} : match.notePath ? { notePath: match.notePath } : {}),
          ...(el.pane ? {} : { pane: match.pane }),
        };
      }
    }
    if (paneInfo.panes.length === 0) {
      const single = paneInfo.openNotes.length === 1 ? paneInfo.openNotes[0] : paneInfo.activeFile;
      if (single) {
        return {
          ...el,
          ...(el.notePath ? {} : { notePath: single }),
          ...(el.pane ? {} : { pane: "active" }),
        };
      }
    }
    return el;
  });
}

async function runUiInspect(flags) {
  const limit = parsePositiveInt(flags.limit, "limit");
  const base = await callBridge("ui.inspect", {
    selector: flags.selector,
    text: flags.text,
    limit,
  });
  let elements = Array.isArray(base.elements) ? base.elements : [];
  let total = typeof base.total === "number" ? base.total : elements.length;
  let truncated = Boolean(base.truncated);

  if (!flags.selector && flags.text) {
    const hasAnnotatedEditor = elements.some((e) => typeof e.notePath === "string" || typeof e.pane === "string");
    if (!hasAnnotatedEditor) {
      const cm = await callBridge("ui.inspect", {
        selector: ".cm-line",
        text: flags.text,
        limit,
      });
      const cmEls = Array.isArray(cm.elements) ? cm.elements : [];
      if (cmEls.length > 0) {
        const seen = new Set(elements.map((e) => e.selector + "|" + (e.rect?.x ?? 0) + "|" + (e.rect?.y ?? 0)));
        const maxOut = limit || 80;
        let added = 0;
        for (const el of cmEls) {
          const key = el.selector + "|" + (el.rect?.x ?? 0) + "|" + (el.rect?.y ?? 0);
          if (!seen.has(key)) {
            seen.add(key);
            if (elements.length < maxOut) {
              elements.push(el);
            }
            added += 1;
          }
        }
        total += added;
        truncated = truncated || Boolean(cm.truncated) || total > elements.length;
      }
    }
  }

  const looksLikeEditor = Boolean(flags.selector && flags.selector.includes(".cm-line")) || (!flags.selector && Boolean(flags.text));
  if (looksLikeEditor && elements.some((e) => !e.notePath || !e.pane)) {
    const paneInfo = await resolvePaneDescriptors();
    elements = annotateEditorElements(elements, paneInfo);
  }
  return { ...base, total, truncated, elements };
}

async function runUiLocate(pos, flags) {
  const notePath = flags.note !== undefined
    ? String(flags.note).trim()
    : (flags.path !== undefined ? String(flags.path).trim() : (pos[0] || ""));
  if (!notePath) {
    throw new Error("Usage: obs-herdr ui locate (--note <path> | <vault-rel-path>) (--line <n> | --after <text> | --heading <h> | --text <t>) [--at start|end]");
  }
  const lineNum = parsePositiveInt(flags.line, "line");
  const searchText = flags.text !== undefined ? String(flags.text) : undefined;
  const afterText = flags.after !== undefined ? String(flags.after) : undefined;
  const headingText = flags.heading !== undefined ? String(flags.heading) : undefined;
  const atPos = parseAtPosition(flags.at, "at");
  if (lineNum === undefined && !searchText && !afterText && !headingText) {
    throw new Error("ui locate requires --line <n>, --after <text>, --heading <h>, or --text <t>.");
  }

  try {
    return await callBridge("ui.locate", {
      note: notePath,
      path: notePath,
      line: lineNum,
      text: searchText,
      after: afterText,
      heading: headingText,
      at: atPos,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.startsWith("unknown_method:")) {
      throw err;
    }
  }

  const note = await callBridge("vault.read_note", { path: notePath });
  const lines = String(note.content || "").split(/\\r?\\n/);
  let expectedText = searchText || "";
  let resolvedLine = lineNum;
  let blankOffset = 0;

  if (resolvedLine === undefined && headingText) {
    const needle = stripHeadingPrefix(headingText).trim().toLowerCase();
    const rawNeedle = headingText.trim().toLowerCase();
    const hIdx = lines.findIndex((l) => {
      if (!/^#{1,6}\\s+/.test(l.trim())) return false;
      return l.trim().toLowerCase() === rawNeedle || stripHeadingPrefix(l).trim().toLowerCase() === needle;
    });
    if (hIdx < 0) {
      throw new Error("Heading " + JSON.stringify(headingText) + " not found in '" + notePath + "'.");
    }
    resolvedLine = hIdx + 1;
    expectedText = stripHeadingPrefix(lines[hIdx]);
  } else if (resolvedLine === undefined && afterText) {
    let aIdx = lines.findIndex((l) => l.trim() === afterText.trim() || stripHeadingPrefix(l).trim() === afterText.trim());
    if (aIdx < 0) aIdx = lines.findIndex((l) => l.includes(afterText));
    if (aIdx < 0) {
      throw new Error("Anchor text " + JSON.stringify(afterText) + " not found in '" + notePath + "'.");
    }
    resolvedLine = aIdx + 1;
    expectedText = stripHeadingPrefix(lines[aIdx]);
  }

  if (resolvedLine !== undefined && !headingText && !afterText) {
    if (resolvedLine > lines.length) {
      throw new Error("Line " + resolvedLine + " is out of range (1.." + lines.length + ") for '" + notePath + "'.");
    }
    expectedText = stripHeadingPrefix(lines[resolvedLine - 1]);
    if (expectedText.trim() === "") {
      for (let i = resolvedLine - 2; i >= 0; i -= 1) {
        const cand = stripHeadingPrefix(lines[i]);
        if (cand.trim() !== "") {
          expectedText = cand;
          blankOffset = (resolvedLine - 1) - i;
          break;
        }
      }
      if (expectedText.trim() === "") {
        for (let i = resolvedLine; i < lines.length; i += 1) {
          const cand = stripHeadingPrefix(lines[i]);
          if (cand.trim() !== "") {
            expectedText = cand;
            blankOffset = (resolvedLine - 1) - i;
            break;
          }
        }
      }
    }
  } else if (resolvedLine === undefined && searchText) {
    const idx = lines.findIndex((l) => l.includes(searchText));
    if (idx >= 0) {
      resolvedLine = idx + 1;
    }
  }

  if (resolvedLine !== undefined && expectedText.trim() !== "") {
    const dupMatches = lines.filter((l) => {
      const cand = stripHeadingPrefix(l).trim();
      return cand !== "" && lineMatches(cand, expectedText);
    });
    if (dupMatches.length > 1) {
      throw new Error(
        "Line " + resolvedLine + " text matches multiple lines in '" + notePath + "'; native ui.locate on an updated Vault Bridge is required for duplicate-line targeting."
      );
    }
  }

  const paneInfo = await resolvePaneDescriptors();
  const targetPane = paneInfo.panes.find((p) => p.notePath === notePath) || null;
  if (!targetPane && paneInfo.panes.some((p) => Array.isArray(p.candidates) && p.candidates.includes(notePath))) {
    throw new Error(
      "Pane identity for '" + notePath + "' is ambiguous across multiple open notes with the same title; native ui.locate on an updated Vault Bridge is required."
    );
  }
  if (!targetPane && paneInfo.panes.length > 0) {
    throw new Error("Note '" + notePath + "' is not open in any visible Obsidian pane.");
  }
  if (!targetPane && paneInfo.activeFile && paneInfo.activeFile !== notePath && !paneInfo.openNotes.includes(notePath)) {
    throw new Error("Note '" + notePath + "' is not open in any visible Obsidian pane.");
  }

  const filterPaneElements = (els) => {
    const annotated = annotateEditorElements(els, paneInfo);
    if (annotated.some((e) => e.notePath === notePath)) {
      return annotated.filter((e) => e.notePath === notePath);
    }
    if (targetPane) {
      return annotated.filter(
        (e) => e.rect && e.rect.x >= targetPane.xMin && e.rect.x <= targetPane.xMax && e.rect.y >= targetPane.yMin && e.rect.y < targetPane.yMax
      );
    }
    return annotated;
  };

  const findMatch = (paneEls) => {
    if (!expectedText.trim()) {
      return null;
    }
    let matchIdxs = paneEls
      .map((e, i) => (String(e.text || "").trim() === expectedText.trim() ? i : -1))
      .filter((i) => i >= 0);
    if (matchIdxs.length === 0) {
      matchIdxs = paneEls
        .map((e, i) => (lineMatches(e.text, expectedText) ? i : -1))
        .filter((i) => i >= 0);
    }
    if (matchIdxs.length === 0) {
      return null;
    }
    if (matchIdxs.length > 1) {
      throw new Error(
        "Multiple visible lines match " + (resolvedLine !== undefined ? "line " + resolvedLine : "anchor") + " in '" + notePath + "'; native ui.locate on an updated Vault Bridge is required."
      );
    }
    const idx = matchIdxs[0];
    if (blankOffset !== 0) {
      const targetIdx = idx + blankOffset;
      if (targetIdx < 0 || targetIdx >= paneEls.length) {
        return null;
      }
      if (String(paneEls[targetIdx].text || "").trim() !== "") {
        return null;
      }
      return paneEls[targetIdx];
    }
    return paneEls[idx];
  };

  let cmRes = await callBridge("ui.inspect", { selector: ".cm-line", limit: 200 });
  let paneEls = filterPaneElements(Array.isArray(cmRes.elements) ? cmRes.elements : []);
  let match = findMatch(paneEls);
  let scrolled = false;

  if (!match && paneEls.length > 0) {
    const firstVisibleText = paneEls.find((e) => String(e.text || "").trim() !== "")?.text || "";
    const firstVisibleIdx = firstVisibleText
      ? lines.findIndex((l) => lineMatches(stripHeadingPrefix(l), firstVisibleText))
      : -1;
    const preferUp = resolvedLine !== undefined && firstVisibleIdx >= 0 && resolvedLine - 1 < firstVisibleIdx;
    const scrollTarget = targetPane
      ? { x: targetPane.centerX, y: targetPane.centerY }
      : {
          x: Math.round(paneEls[0].rect.x + Math.min(paneEls[0].rect.width * 0.5, 160)),
          y: Math.round(Math.min(Math.max(paneEls[0].rect.y + 100, 200), 600)),
        };

    const dirs = preferUp ? [-360, 360] : [360, -360];
    for (const dy of dirs) {
      let prevSig = "";
      for (let step = 0; step < 8; step += 1) {
        await callBridge("ui.scroll", { target: scrollTarget, deltaX: 0, deltaY: dy });
        scrolled = true;
        cmRes = await callBridge("ui.inspect", { selector: ".cm-line", limit: 200 });
        paneEls = filterPaneElements(Array.isArray(cmRes.elements) ? cmRes.elements : []);
        match = findMatch(paneEls);
        if (match) break;
        const sig = paneEls.slice(0, 3).map((e) => e.text).join("|");
        if (sig === prevSig) break;
        prevSig = sig;
      }
      if (match) break;
    }
  }

  if (!match || !match.rect) {
    const what = resolvedLine !== undefined ? "line " + resolvedLine : JSON.stringify(headingText || afterText || searchText || "");
    throw new Error("Could not locate " + what + " in '" + notePath + "'.");
  }
  const r = match.rect;
  const pointX = atPos === "start" ? Math.round(r.x + 8) : Math.round(r.x + Math.max(4, r.width - 12));
  return {
    found: true,
    path: notePath,
    pane: match.pane || (targetPane ? targetPane.pane : "active"),
    line: resolvedLine ?? null,
    text: match.text,
    point: {
      x: pointX,
      y: Math.round(r.y + Math.max(r.height / 2, r.height - 12)),
    },
    rect: r,
    selector: match.selector,
    scrolled,
  };
}

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

async function runUiInsertLine(pos, flags) {
  const anchor = uiTarget(flags, "");
  if (!anchor || !anchor.note) {
    throw new Error("Usage: obs-herdr ui insert-line --note <path> (--line <n> | --after <text> | --heading <h>) [--at end|start] (--text <t> | --stdin)");
  }
  if (anchor.line === undefined && !anchor.after && !anchor.heading) {
    throw new Error("ui insert-line requires --line <n>, --after <text>, or --heading <h>.");
  }
  let text;
  if (flags.stdin) {
    text = readStdin();
  } else if (flags.text !== undefined) {
    text = String(flags.text);
  } else if (pos.length > 0) {
    text = pos.join(" ");
  } else {
    throw new Error("ui insert-line requires --text <t> or --stdin.");
  }
  try {
    return await callBridge("ui.insert_line", { target: anchor, text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.startsWith("unknown_method:")) {
      throw err;
    }
    return await callBridge("ui.batch", {
      steps: [{ action: "insert_line", target: anchor, text }],
    });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const helpText = resolveHelpText(argv);
  if (helpText !== null) {
    process.stdout.write(helpText + "\\n");
    return;
  }
  if (argv[0] === "mcp") {
    await runMcpServer();
    return;
  }
  if (argv[0] === "plugin-action") {
    await runPluginAction(argv[1] || "vault-status");
    return;
  }

  const [group, sub, ...rest] = argv;
  const { pos, flags } = parseFlags(rest);
  if (group === "ui") {
    validateUiFlags(sub, flags);
  }
  let result;

  if (group === "vault" && sub === "info") {
    result = await callBridge("vault.info", {});
  } else if (group === "note" && sub === "list") {
    result = await callBridge("vault.list_files", { folder: flags.folder, tag: flags.tag, extension: flags.extension, limit: parsePositiveInt(flags.limit, "limit") });
  } else if (group === "note" && sub === "read") {
    result = await callBridge("vault.read_note", { path: pos[0] });
  } else if (group === "note" && sub === "search") {
    result = await callBridge("vault.search", { query: pos[0], limit: parsePositiveInt(flags.limit, "limit") });
  } else if (group === "note" && sub === "create") {
    const content = flags.stdin ? readStdin() : (flags.content || "");
    result = await callBridge("vault.create_note", { path: pos[0], content, overwrite: Boolean(flags.overwrite) });
  } else if (group === "note" && sub === "update") {
    const content = flags.stdin ? readStdin() : (flags.content || "");
    result = await callBridge("vault.update_note", { path: pos[0], mode: flags.mode || "append", heading: flags.heading, search: flags.search, content });
  } else if (group === "note" && sub === "frontmatter") {
    result = await callBridge("vault.patch_frontmatter", { path: pos[0], set: parseSetFlags(flags.set), unset: flags.unset });
  } else if (group === "note" && sub === "rename") {
    result = await callBridge("vault.rename_note", { path: pos[0], newPath: pos[1] });
  } else if (group === "note" && sub === "trash") {
    result = await callBridge("vault.trash_note", { path: pos[0] });
  } else if (group === "note" && sub === "backlinks") {
    result = await callBridge("metadata.backlinks", { path: pos[0] });
  } else if (group === "note" && sub === "graph") {
    result = await callBridge("metadata.graph_neighbors", { path: pos[0] });
  } else if (group === "canvas" && sub === "upsert") {
    result = await callBridge("canvas.upsert_node", {
      path: pos[0],
      id: flags.id,
      nodeType: flags.type || flags.nodeType || "text",
      text: flags.stdin ? readStdin() : flags.text,
      file: flags.file,
      url: flags.url,
      x: parseFiniteNumber(flags.x, "x"),
      y: parseFiniteNumber(flags.y, "y"),
      width: parseFiniteNumber(flags.width, "width"),
      height: parseFiniteNumber(flags.height, "height"),
      color: flags.color,
    });
  } else if (group === "workspace" && sub === "state") {
    result = await callBridge("workspace.get_state", {});
  } else if (group === "workspace" && sub === "open") {
    result = await callBridge("workspace.open_note", { path: pos[0], line: parsePositiveInt(flags.line, "line"), pane: flags.pane || "current" });
  } else if (group === "workspace" && sub === "notice") {
    result = await callBridge("workspace.notice", { message: pos.join(" ") });
  } else if (group === "editor" && sub === "selection") {
    result = await callBridge("editor.selection", {});
  } else if (group === "editor" && sub === "insert") {
    result = await callBridge("editor.insert_at_cursor", { text: flags.stdin ? readStdin() : pos.join(" ") });
  } else if (group === "command" && sub === "list") {
    result = await callBridge("commands.list", { query: flags.query || pos[0] || "" });
  } else if (group === "command" && sub === "run") {
    result = await callBridge("commands.execute", { commandId: pos[0] });
  } else if (group === "ui" && sub === "screenshot") {
    if (flags.out !== undefined && flags.output !== undefined && String(flags.out) !== String(flags.output)) {
      throw new Error("Conflicting values passed for --out and --output.");
    }
    const outFlag = flags.out !== undefined ? flags.out : flags.output;
    if (outFlag !== undefined && String(outFlag).trim() === "") {
      throw new Error("--out/--output path cannot be empty.");
    }
    const shot = await callBridge("ui.screenshot", { maxWidth: parsePositiveInt(flags["max-width"], "max-width") });
    result = saveScreenshot(shot, outFlag);
  } else if (group === "ui" && sub === "inspect") {
    result = await runUiInspect(flags);
  } else if (group === "ui" && sub === "locate") {
    result = await runUiLocate(pos, flags);
  } else if (group === "ui" && sub === "insert-line") {
    result = await runUiInsertLine(pos, flags);
  } else if (group === "ui" && sub === "wait") {
    result = await callBridge("ui.wait_for", { text: pos.join(" "), selector: flags.selector, timeoutMs: parseNonNegativeInt(flags.timeout, "timeout") });
  } else if (group === "ui" && sub === "click") {
    result = await callBridge("ui.click", { target: uiTarget(flags, ""), button: flags.button, count: parsePositiveInt(flags.count, "count") });
  } else if (group === "ui" && sub === "select") {
    result = await callBridge("ui.select", {
      target: uiTarget(flags, ""),
      ...(flags.value !== undefined ? { value: String(flags.value) } : {}),
      ...(flags.label !== undefined ? { label: String(flags.label) } : {}),
    });
  } else if (group === "ui" && sub === "type") {
    const typeText = flags.stdin ? readStdin() : (flags.text !== undefined ? String(flags.text) : pos.join(" "));
    result = await callBridge("ui.type", { text: typeText, target: uiTarget(flags, "") });
  } else if (group === "ui" && sub === "key") {
    const parts = String(pos[0] || "").split("+").filter(Boolean);
    result = await callBridge("ui.press_key", { key: parts.pop() || "", modifiers: parts });
  } else if (group === "ui" && sub === "scroll") {
    result = await callBridge("ui.scroll", {
      target: uiTarget(flags, ""),
      deltaX: flags.dx !== undefined ? parseFiniteNumber(flags.dx, "dx") : 0,
      deltaY: flags.dy !== undefined ? parseFiniteNumber(flags.dy, "dy") : 0,
    });
  } else if (group === "ui" && sub === "drag") {
    result = await callBridge("ui.drag", { from: uiTarget(flags, "from-"), to: uiTarget(flags, "to-"), steps: parsePositiveInt(flags.steps, "steps") });
  } else if (group === "ui" && sub === "batch") {
    const rawSteps = flags["steps-json"] ? String(flags["steps-json"]) : (flags.stdin ? readStdin() : pos[0] || "[]");
    result = await callBridge("ui.batch", { steps: JSON.parse(rawSteps) });
  } else if (group === "rpc") {
    result = await callBridge(sub, pos[0] ? JSON.parse(pos[0]) : {});
  } else {
    throw new Error("Unknown obs-herdr command. Run 'obs-herdr --help' for usage.");
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\\n");
}

main().catch((err) => {
  process.stderr.write((err instanceof Error ? err.message : String(err)) + "\\n");
  process.exit(1);
});
`;
}

function buildObsHerdrCorePy(defaultConnFile: string, pluginVersion: string): string {
  return `#!/usr/bin/env python3
import datetime, json, math, os, posixpath, re, socket, subprocess, sys, time

DEFAULT_CONN_FILE = ${JSON.stringify(defaultConnFile)}
PLUGIN_VERSION = ${JSON.stringify(pluginVersion)}

SKILL_TEXT = ${JSON.stringify(SHARED_SKILL_TEXT)}

COMMAND_HELP = json.loads(${JSON.stringify(JSON.stringify(SHARED_COMMAND_HELP))})

UI_ALLOWED_FLAGS = json.loads(${JSON.stringify(JSON.stringify(SHARED_UI_ALLOWED_FLAGS))})

MCP_TOOLS = json.loads(${JSON.stringify(JSON.stringify(SHARED_MCP_TOOLS))})

def resolve_conn():
    cf = os.environ.get("OBSIDIAN_HERDR_CONNECTION_FILE") or DEFAULT_CONN_FILE
    if cf and os.path.exists(cf):
        try:
            with open(cf, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if data.get("socketPath") and data.get("token"):
                return data["socketPath"], data["token"]
        except Exception:
            pass
    if os.environ.get("OBSIDIAN_HERDR_BRIDGE_SOCKET") and os.environ.get("OBSIDIAN_HERDR_BRIDGE_TOKEN"):
        return os.environ["OBSIDIAN_HERDR_BRIDGE_SOCKET"], os.environ["OBSIDIAN_HERDR_BRIDGE_TOKEN"]
    with open(cf, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return data["socketPath"], data["token"]

def resolve_timeout_ms(method, params):
    env_raw = os.environ.get("OBS_HERDR_TIMEOUT_MS", "")
    base = 60000
    if env_raw != "":
        try:
            env_num = float(env_raw)
            if math.isfinite(env_num) and env_num > 0:
                base = int(round(env_num))
        except Exception:
            pass
    p = params if isinstance(params, dict) else {}
    if method == "ui.wait_for":
        try:
            w = float(p.get("timeoutMs")) if p.get("timeoutMs") is not None else 5000.0
            if not math.isfinite(w) or w < 0:
                w = 5000.0
        except Exception:
            w = 5000.0
        return max(base, int(round(w)) + 30000)
    if method == "ui.batch":
        total_wait = 0.0
        if p.get("timeoutMs") is not None:
            try:
                tw = float(p.get("timeoutMs"))
                if math.isfinite(tw) and tw >= 0:
                    total_wait += tw
            except Exception:
                pass
        steps = p.get("steps")
        if isinstance(steps, list):
            for s in steps:
                if isinstance(s, dict) and s.get("action") == "wait_for":
                    try:
                        sw = float(s.get("timeoutMs")) if s.get("timeoutMs") is not None else 5000.0
                        if not math.isfinite(sw) or sw < 0:
                            sw = 5000.0
                    except Exception:
                        sw = 5000.0
                    total_wait += sw
        if total_wait > 0:
            return max(base, int(round(total_wait)) + 30000)
    return base

def call_bridge(method, params=None):
    sock_path, token = resolve_conn()
    caller = f"herdr:{os.environ['HERDR_PANE_ID']}" if os.environ.get("HERDR_PANE_ID") else "obs-herdr-py"
    clean_params = {k: v for k, v in (params or {}).items() if v is not None}
    timeout_ms = resolve_timeout_ms(method, clean_params)
    req = {"id": f"py_{int(time.time()*1000)}", "token": token, "method": method, "params": clean_params, "caller": caller}
    payload = (json.dumps(req) + "\\n").encode("utf-8")
    buf = b""
    if os.name == "nt" and sock_path.startswith("\\\\\\\\.\\\\pipe\\\\"):
        with open(sock_path, "r+b", buffering=0) as pipe_fh:
            pipe_fh.write(payload)
            while b"\\n" not in buf:
                chunk = pipe_fh.read(65536)
                if not chunk:
                    break
                buf += chunk
    else:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(timeout_ms / 1000.0)
            try:
                s.connect(sock_path)
                s.sendall(payload)
                while b"\\n" not in buf:
                    chunk = s.recv(65536)
                    if not chunk:
                        break
                    buf += chunk
            except (socket.timeout, TimeoutError):
                raise RuntimeError(f"Bridge request timed out after {timeout_ms} ms ({method}).")
    if b"\\n" not in buf:
        raise RuntimeError(f"Bridge connection closed before a complete response was received ({method}).")
    try:
        res = json.loads(buf.split(b"\\n", 1)[0].decode("utf-8"))
    except Exception as exc:
        raise RuntimeError(f"Invalid JSON response from Obsidian bridge: {exc}")
    if not isinstance(res, dict) or not res.get("ok"):
        err = res.get("error") if isinstance(res, dict) and isinstance(res.get("error"), dict) else {}
        raise RuntimeError(f"{err.get('code', 'error')}: {err.get('message', 'Bridge error')}")
    return res.get("result")

def parse_flags(args, strict=True):
    pos, flags = [], {"set": [], "unset": []}
    i = 0
    after_double_dash = False
    while i < len(args):
        a = args[i]
        if after_double_dash:
            pos.append(a)
            i += 1
            continue
        if a == "--":
            after_double_dash = True
            i += 1
            continue
        if a in ("--stdin", "--overwrite", "--help", "-h"):
            flags["help" if a == "-h" else a[2:]] = True
        elif a.startswith("--"):
            if "=" in a:
                key, val = a[2:].split("=", 1)
                if not key:
                    if strict:
                        raise RuntimeError(f"Invalid flag '{a}'.")
                    i += 1
                    continue
                if key in ("set", "unset"):
                    flags[key].append(val)
                else:
                    flags[key] = val
            elif i + 1 < len(args):
                key = a[2:]
                i += 1
                if key in ("set", "unset"):
                    flags[key].append(args[i])
                else:
                    flags[key] = args[i]
            elif strict:
                raise RuntimeError(f"Missing value for flag '{a}'.")
        elif re.match(r"^-[A-Za-z]", a):
            if strict:
                raise RuntimeError(f"Unknown flag '{a}'. Run 'obs-herdr --help' for usage.")
        else:
            pos.append(a)
        i += 1
    return pos, flags

def validate_ui_flags(sub, flags):
    allowed = UI_ALLOWED_FLAGS.get(sub)
    if allowed is None:
        return
    allowed_set = set(allowed)
    if flags.get("set") and "set" not in allowed_set:
        raise RuntimeError(f"Unknown flag '--set' for 'obs-herdr ui {sub}'. Run 'obs-herdr ui {sub} --help' for usage.")
    if flags.get("unset") and "unset" not in allowed_set:
        raise RuntimeError(f"Unknown flag '--unset' for 'obs-herdr ui {sub}'. Run 'obs-herdr ui {sub} --help' for usage.")
    for key in flags.keys():
        if key in ("set", "unset", "help"):
            continue
        if key not in allowed_set:
            raise RuntimeError(f"Unknown flag '--{key}' for 'obs-herdr ui {sub}'. Run 'obs-herdr ui {sub} --help' for usage.")

def resolve_help_text(argv):
    if not argv or argv[0] == "--skill":
        return SKILL_TEXT
    has_help_flag = "--help" in argv or "-h" in argv
    is_help_cmd = argv[0] == "help"
    if not has_help_flag and not is_help_cmd:
        return None
    pos, _ = parse_flags(argv[1:] if is_help_cmd else argv, strict=False)
    group = pos[0] if len(pos) > 0 else ""
    sub = pos[1] if len(pos) > 1 else ""
    if not group:
        return SKILL_TEXT
    if not sub or group in ("mcp", "rpc"):
        if group in COMMAND_HELP["groups"]:
            return COMMAND_HELP["groups"][group]
        raise RuntimeError(f"Unknown obs-herdr command '{group}'. Run 'obs-herdr --help' for usage.")
    key = f"{group} {sub}"
    if key in COMMAND_HELP["commands"]:
        return COMMAND_HELP["commands"][key]
    raise RuntimeError(f"Unknown obs-herdr command '{key}'. Run 'obs-herdr --help' for usage.")

def parse_set(items):
    out = {}
    for item in items:
        t = str(item).strip()
        if t.startswith("{") and t.endswith("}"):
            out.update(json.loads(t))
        elif "=" in t:
            k, v = t.split("=", 1)
            out[k] = v
    return out

def run_plugin_action(action):
    herdr_bin = os.environ.get("HERDR_BIN_PATH") or "herdr"
    if action == "vault-status":
        info = call_bridge("vault.info", {})
        subprocess.run([herdr_bin, "notification", "show", f"Vault: {info.get('vaultName', '')}", "--body", f"{info.get('markdownCount', 0)} notes ({info.get('permissionMode', 'off')})"], check=True)
    elif action == "active-note":
        st = call_bridge("workspace.get_state", {})
        subprocess.run([herdr_bin, "notification", "show", "Active note", "--body", st.get("activeFile") or "No active note"], check=True)
    elif action == "capture-pane" and os.environ.get("HERDR_PANE_ID"):
        pane_id = os.environ["HERDR_PANE_ID"]
        proc = subprocess.run([herdr_bin, "pane", "read", pane_id, "--source", "recent-unwrapped", "--lines", "120"], capture_output=True, text=True, check=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
        safe_id = pane_id.replace(":", "-").replace("%", "-")
        note_path = f"Herdr Captures/Pane {safe_id} {stamp}.md"
        body = f"# Herdr Pane Capture ({pane_id})\\n\\n\`\`\`text\\n{proc.stdout.strip()}\\n\`\`\`\\n"
        call_bridge("vault.create_note", {"path": note_path, "content": body})
        call_bridge("workspace.open_note", {"path": note_path})
        subprocess.run([herdr_bin, "notification", "show", "Saved pane to vault", "--body", note_path], check=True)

def to_mcp_content(res):
    if isinstance(res, dict) and isinstance(res.get("image"), dict) and isinstance(res["image"].get("data"), str):
        rest = {k: v for k, v in res.items() if k != "image"}
        return [
            {"type": "image", "data": res["image"]["data"], "mimeType": res["image"].get("mimeType") or "image/png"},
            {"type": "text", "text": json.dumps(rest, indent=2)},
        ]
    return [{"type": "text", "text": json.dumps(res, indent=2)}]

def parse_positive_int(raw, flag_name):
    if raw is None:
        return None
    s = str(raw).strip()
    if not re.fullmatch(r"[1-9][0-9]*", s):
        raise RuntimeError(f"--{flag_name} must be a positive integer.")
    n = int(s)
    if n < 1 or n > 9007199254740991:
        raise RuntimeError(f"--{flag_name} must be a positive integer.")
    return n

def parse_non_negative_int(raw, flag_name):
    if raw is None:
        return None
    s = str(raw).strip()
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)", s):
        raise RuntimeError(f"--{flag_name} must be a non-negative integer.")
    n = int(s)
    if n < 0 or n > 9007199254740991:
        raise RuntimeError(f"--{flag_name} must be a non-negative integer.")
    return n

def parse_finite_number(raw, flag_name):
    if raw is None:
        return None
    s = str(raw).strip()
    if not re.fullmatch(r"-?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)", s):
        raise RuntimeError(f"--{flag_name} must be a finite number.")
    n = float(s)
    if not math.isfinite(n):
        raise RuntimeError(f"--{flag_name} must be a finite number.")
    return n

def parse_at_position(raw, flag_name):
    if raw is None:
        return None
    val = str(raw).strip()
    if val not in ("start", "end"):
        raise RuntimeError(f"--{flag_name} must be 'start' or 'end'.")
    return val

def ui_target(flags, prefix):
    note_key = (prefix + "note") if (prefix + "note") in flags else ((prefix + "path") if (prefix + "path") in flags else None)
    has_line = (prefix + "line") in flags
    has_after = (prefix + "after") in flags
    has_heading = (prefix + "heading") in flags
    has_at = (prefix + "at") in flags
    if note_key is not None:
        note = str(flags[note_key]).strip()
        if not note:
            raise RuntimeError(f"--{prefix}note cannot be empty.")
        target = {"note": note}
        if has_line:
            target["line"] = parse_positive_int(flags[prefix + "line"], prefix + "line")
        if has_after:
            target["after"] = str(flags[prefix + "after"])
        if has_heading:
            target["heading"] = str(flags[prefix + "heading"])
        if has_at:
            target["at"] = parse_at_position(flags[prefix + "at"], prefix + "at")
        return target
    if has_line or has_after or has_heading or has_at:
        raise RuntimeError(f"--{prefix}line/--after/--heading/--at requires --{prefix}note <path>.")
    if flags.get(prefix + "selector"):
        return {"selector": flags[prefix + "selector"]}
    if (prefix + "x") in flags and (prefix + "y") in flags:
        return {
            "x": parse_finite_number(flags[prefix + "x"], prefix + "x"),
            "y": parse_finite_number(flags[prefix + "y"], prefix + "y"),
        }
    return None

def save_screenshot(shot, out_flag):
    import base64
    conn_file = os.environ.get("OBSIDIAN_HERDR_CONNECTION_FILE") or DEFAULT_CONN_FILE
    out_path = out_flag
    if not out_path:
        shot_dir = os.path.join(os.path.dirname(conn_file), "screenshots")
        os.makedirs(shot_dir, mode=0o700, exist_ok=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%f")
        out_path = os.path.join(shot_dir, f"obsidian-{stamp}.png")
    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(base64.b64decode(shot["image"]["data"]))
    rest = {k: v for k, v in shot.items() if k != "image"}
    return {"path": os.path.abspath(out_path), **rest}

def run_mcp():
    rpc_by_name = {t["name"]: t["rpc"] for t in MCP_TOOLS}
    public_tools = [{k: v for k, v in t.items() if k != "rpc"} for t in MCP_TOOLS]
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        mid = msg.get("id")
        if mid is None:
            continue
        m = msg.get("method")
        try:
            if m == "initialize":
                out = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "obsidian-herdr-bridge", "version": PLUGIN_VERSION}}
            elif m == "tools/list":
                out = {"tools": public_tools}
            elif m == "tools/call":
                params = msg.get("params") or {}
                name = params.get("name")
                if name not in rpc_by_name:
                    raise RuntimeError(f"Unknown tool: {name}")
                res = call_bridge(rpc_by_name[name], params.get("arguments") or {})
                out = {"content": to_mcp_content(res)}
            else:
                out = {}
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "result": out}) + "\\n")
            sys.stdout.flush()
        except Exception as exc:
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "error": {"code": -32000, "message": str(exc)}}) + "\\n")
            sys.stdout.flush()

def strip_heading_prefix(line):
    return re.sub(r"^#{1,6}[ \\t]+", "", str(line or ""))

def line_matches(el_text, expected):
    a = str(el_text or "").strip()
    b = str(expected or "").strip()
    return a == b or b in a

def resolve_pane_descriptors():
    state = {"activeFile": None, "openNotes": []}
    try:
        state = call_bridge("workspace.get_state", {})
    except Exception:
        pass
    open_notes = state.get("openNotes") if isinstance(state.get("openNotes"), list) else []
    titles, breadcrumbs = [], []
    try:
        t_res = call_bridge("ui.inspect", {"selector": ".view-header-title", "limit": 30})
        titles = t_res.get("elements") if isinstance(t_res.get("elements"), list) else []
    except Exception:
        titles = []
    if len(titles) > 1:
        try:
            b_res = call_bridge("ui.inspect", {"selector": ".view-header-breadcrumb", "limit": 30})
            breadcrumbs = b_res.get("elements") if isinstance(b_res.get("elements"), list) else []
        except Exception:
            breadcrumbs = []
    raw_panes = []
    for idx, h in enumerate(titles):
        title = str(h.get("text") or "").strip()
        candidates = []
        for p in open_notes:
            base = posixpath.basename(p)
            if base.endswith(".md"):
                base = base[:-3]
            if base == title or p == title:
                candidates.append(p)
        matched_path = candidates[0] if len(candidates) == 1 else None
        if not matched_path and len(candidates) > 1:
            hr = h.get("rect") or {}
            bc = next((b for b in breadcrumbs if b.get("rect") and abs(b["rect"].get("x", 0) - hr.get("x", 0)) < 120 and abs(b["rect"].get("y", 0) - hr.get("y", 0)) < 60), None)
            if bc and bc.get("text"):
                folder = str(bc["text"]).strip()
                matched_path = next((p for p in candidates if posixpath.dirname(p) == folder), None)
        if not matched_path and len(candidates) == 0 and state.get("activeFile"):
            af = state["activeFile"]
            base = posixpath.basename(af)
            if base.endswith(".md"):
                base = base[:-3]
            if base == title:
                matched_path = af
        r = h.get("rect") or {"x": 0, "y": 0, "width": 400, "height": 30}
        raw_panes.append({
            "pane": f"pane-{idx + 1}",
            "notePath": matched_path,
            "candidates": candidates,
            "xMin": r.get("x", 0) - 40,
            "xMax": r.get("x", 0) + r.get("width", 400) + 40,
            "headerY": r.get("y", 0),
            "centerX": round(r.get("x", 0) + r.get("width", 400) / 2),
        })
    panes = []
    for p in raw_panes:
        below_ys = [o["headerY"] for o in raw_panes if o is not p and o["headerY"] > p["headerY"] + 20 and o["xMin"] <= p["xMax"] and p["xMin"] <= o["xMax"]]
        y_min = p["headerY"] - 4
        y_max = (min(below_ys) - 4) if below_ys else None
        target_mid_y = (p["headerY"] + y_max) / 2 if y_max is not None else p["headerY"] + 220
        cap_y = (y_max - 12) if y_max is not None else 600
        panes.append({
            "pane": p["pane"],
            "notePath": p["notePath"],
            "candidates": p["candidates"],
            "xMin": p["xMin"],
            "xMax": p["xMax"],
            "yMin": y_min,
            "yMax": y_max,
            "centerX": p["centerX"],
            "centerY": round(min(max(target_mid_y, p["headerY"] + 40), cap_y)),
        })
    return {"panes": panes, "activeFile": state.get("activeFile"), "openNotes": open_notes}

def annotate_editor_elements(elements, pane_info):
    out = []
    for el in elements:
        if el.get("notePath") and el.get("pane"):
            out.append(el)
            continue
        r = el.get("rect")
        if r and pane_info["panes"]:
            match = next(
                (p for p in pane_info["panes"] if p["xMin"] <= r.get("x", 0) <= p["xMax"] and r.get("y", 0) >= p["yMin"] and (p["yMax"] is None or r.get("y", 0) < p["yMax"])),
                None,
            )
            if match:
                copy_el = dict(el)
                if not copy_el.get("notePath") and match.get("notePath"):
                    copy_el["notePath"] = match["notePath"]
                if not copy_el.get("pane"):
                    copy_el["pane"] = match["pane"]
                out.append(copy_el)
                continue
        if not pane_info["panes"]:
            single = pane_info["openNotes"][0] if len(pane_info["openNotes"]) == 1 else pane_info.get("activeFile")
            if single:
                copy_el = dict(el)
                if not copy_el.get("notePath"):
                    copy_el["notePath"] = single
                if not copy_el.get("pane"):
                    copy_el["pane"] = "active"
                out.append(copy_el)
                continue
        out.append(el)
    return out

def run_ui_inspect(flags):
    limit = parse_positive_int(flags.get("limit"), "limit")
    base = call_bridge("ui.inspect", {"selector": flags.get("selector"), "text": flags.get("text"), "limit": limit})
    elements = list(base.get("elements") or [])
    total = base.get("total") if isinstance(base.get("total"), int) else len(elements)
    truncated = bool(base.get("truncated"))

    if not flags.get("selector") and flags.get("text"):
        has_annotated = any(isinstance(e.get("notePath"), str) or isinstance(e.get("pane"), str) for e in elements)
        if not has_annotated:
            cm = call_bridge("ui.inspect", {"selector": ".cm-line", "text": flags.get("text"), "limit": limit})
            cm_els = list(cm.get("elements") or [])
            if cm_els:
                seen = {f"{e.get('selector')}|{(e.get('rect') or {}).get('x', 0)}|{(e.get('rect') or {}).get('y', 0)}" for e in elements}
                max_out = limit or 80
                added = 0
                for el in cm_els:
                    key = f"{el.get('selector')}|{(el.get('rect') or {}).get('x', 0)}|{(el.get('rect') or {}).get('y', 0)}"
                    if key not in seen:
                        seen.add(key)
                        if len(elements) < max_out:
                            elements.append(el)
                        added += 1
                total += added
                truncated = truncated or bool(cm.get("truncated")) or total > len(elements)

    looks_like_editor = bool(flags.get("selector") and ".cm-line" in flags["selector"]) or (not flags.get("selector") and bool(flags.get("text")))
    if looks_like_editor and any((not e.get("notePath")) or (not e.get("pane")) for e in elements):
        pane_info = resolve_pane_descriptors()
        elements = annotate_editor_elements(elements, pane_info)
    return {**base, "total": total, "truncated": truncated, "elements": elements}

def run_ui_locate(pos, flags):
    if "note" in flags:
        note_path = str(flags["note"]).strip()
    elif "path" in flags:
        note_path = str(flags["path"]).strip()
    else:
        note_path = pos[0] if pos else ""
    if not note_path:
        raise RuntimeError("Usage: obs-herdr ui locate (--note <path> | <vault-rel-path>) (--line <n> | --after <text> | --heading <h> | --text <t>) [--at start|end]")
    line_num = parse_positive_int(flags.get("line"), "line")
    search_text = str(flags["text"]) if "text" in flags else None
    after_text = str(flags["after"]) if "after" in flags else None
    heading_text = str(flags["heading"]) if "heading" in flags else None
    at_pos = parse_at_position(flags.get("at"), "at")
    if line_num is None and not search_text and not after_text and not heading_text:
        raise RuntimeError("ui locate requires --line <n>, --after <text>, --heading <h>, or --text <t>.")

    try:
        locate_params = {
            k: v for k, v in {
                "note": note_path,
                "path": note_path,
                "line": line_num,
                "text": search_text,
                "after": after_text,
                "heading": heading_text,
                "at": at_pos,
            }.items() if v is not None
        }
        return call_bridge("ui.locate", locate_params)
    except Exception as exc:
        if not str(exc).startswith("unknown_method:"):
            raise

    note = call_bridge("vault.read_note", {"path": note_path})
    lines = re.split(r"\\r?\\n", str(note.get("content") or ""))
    expected_text = search_text or ""
    resolved_line = line_num
    blank_offset = 0

    if resolved_line is None and heading_text:
        needle = strip_heading_prefix(heading_text).strip().lower()
        raw_needle = heading_text.strip().lower()
        h_idx = next(
            (i for i, l in enumerate(lines) if re.match(r"^#{1,6}\\s+", l.strip()) and (l.strip().lower() == raw_needle or strip_heading_prefix(l).strip().lower() == needle)),
            -1,
        )
        if h_idx < 0:
            raise RuntimeError(f"Heading {json.dumps(heading_text)} not found in '{note_path}'.")
        resolved_line = h_idx + 1
        expected_text = strip_heading_prefix(lines[h_idx])
    elif resolved_line is None and after_text:
        a_idx = next((i for i, l in enumerate(lines) if l.strip() == after_text.strip() or strip_heading_prefix(l).strip() == after_text.strip()), -1)
        if a_idx < 0:
            a_idx = next((i for i, l in enumerate(lines) if after_text in l), -1)
        if a_idx < 0:
            raise RuntimeError(f"Anchor text {json.dumps(after_text)} not found in '{note_path}'.")
        resolved_line = a_idx + 1
        expected_text = strip_heading_prefix(lines[a_idx])

    if resolved_line is not None and not heading_text and not after_text:
        if resolved_line > len(lines):
            raise RuntimeError(f"Line {resolved_line} is out of range (1..{len(lines)}) for '{note_path}'.")
        expected_text = strip_heading_prefix(lines[resolved_line - 1])
        if not expected_text.strip():
            for i in range(resolved_line - 2, -1, -1):
                cand = strip_heading_prefix(lines[i])
                if cand.strip():
                    expected_text = cand
                    blank_offset = (resolved_line - 1) - i
                    break
            if not expected_text.strip():
                for i in range(resolved_line, len(lines)):
                    cand = strip_heading_prefix(lines[i])
                    if cand.strip():
                        expected_text = cand
                        blank_offset = (resolved_line - 1) - i
                        break
    elif resolved_line is None and search_text:
        idx = next((i for i, l in enumerate(lines) if search_text in l), -1)
        if idx >= 0:
            resolved_line = idx + 1

    if resolved_line is not None and expected_text.strip():
        dup_matches = [l for l in lines if strip_heading_prefix(l).strip() and line_matches(strip_heading_prefix(l).strip(), expected_text)]
        if len(dup_matches) > 1:
            raise RuntimeError(
                f"Line {resolved_line} text matches multiple lines in '{note_path}'; native ui.locate on an updated Vault Bridge is required for duplicate-line targeting."
            )

    pane_info = resolve_pane_descriptors()
    target_pane = next((p for p in pane_info["panes"] if p.get("notePath") == note_path), None)
    if not target_pane and any(note_path in (p.get("candidates") or []) for p in pane_info["panes"]):
        raise RuntimeError(
            f"Pane identity for '{note_path}' is ambiguous across multiple open notes with the same title; native ui.locate on an updated Vault Bridge is required."
        )
    if not target_pane and pane_info["panes"]:
        raise RuntimeError(f"Note '{note_path}' is not open in any visible Obsidian pane.")
    if not target_pane and pane_info.get("activeFile") and pane_info["activeFile"] != note_path and note_path not in pane_info["openNotes"]:
        raise RuntimeError(f"Note '{note_path}' is not open in any visible Obsidian pane.")

    def filter_pane(els):
        annotated = annotate_editor_elements(els, pane_info)
        by_note = [e for e in annotated if e.get("notePath") == note_path]
        if by_note:
            return by_note
        if target_pane:
            return [
                e for e in annotated
                if e.get("rect")
                and target_pane["xMin"] <= e["rect"].get("x", 0) <= target_pane["xMax"]
                and e["rect"].get("y", 0) >= target_pane["yMin"]
                and (target_pane["yMax"] is None or e["rect"].get("y", 0) < target_pane["yMax"])
            ]
        return annotated

    def find_match(pane_els):
        if not expected_text.strip():
            return None
        match_idxs = [i for i, e in enumerate(pane_els) if str(e.get("text") or "").strip() == expected_text.strip()]
        if not match_idxs:
            match_idxs = [i for i, e in enumerate(pane_els) if line_matches(e.get("text"), expected_text)]
        if not match_idxs:
            return None
        if len(match_idxs) > 1:
            label = f"line {resolved_line}" if resolved_line is not None else "anchor"
            raise RuntimeError(
                f"Multiple visible lines match {label} in '{note_path}'; native ui.locate on an updated Vault Bridge is required."
            )
        idx = match_idxs[0]
        if blank_offset != 0:
            t_idx = idx + blank_offset
            if not (0 <= t_idx < len(pane_els)):
                return None
            if str(pane_els[t_idx].get("text") or "").strip():
                return None
            return pane_els[t_idx]
        return pane_els[idx]

    cm_res = call_bridge("ui.inspect", {"selector": ".cm-line", "limit": 200})
    pane_els = filter_pane(list(cm_res.get("elements") or []))
    match = find_match(pane_els)
    scrolled = False

    if not match and pane_els:
        first_vis_text = next((e.get("text") for e in pane_els if str(e.get("text") or "").strip()), "")
        first_vis_idx = next((i for i, l in enumerate(lines) if line_matches(strip_heading_prefix(l), first_vis_text)), -1) if first_vis_text else -1
        prefer_up = resolved_line is not None and first_vis_idx >= 0 and (resolved_line - 1) < first_vis_idx
        if target_pane:
            scroll_target = {"x": target_pane["centerX"], "y": target_pane["centerY"]}
        else:
            r0 = pane_els[0]["rect"]
            scroll_target = {"x": round(r0["x"] + min(r0["width"] * 0.5, 160)), "y": round(min(max(r0["y"] + 100, 200), 600))}
        dirs = [-360, 360] if prefer_up else [360, -360]
        for dy in dirs:
            prev_sig = ""
            for _ in range(8):
                call_bridge("ui.scroll", {"target": scroll_target, "deltaX": 0, "deltaY": dy})
                scrolled = True
                cm_res = call_bridge("ui.inspect", {"selector": ".cm-line", "limit": 200})
                pane_els = filter_pane(list(cm_res.get("elements") or []))
                match = find_match(pane_els)
                if match:
                    break
                sig = "|".join(str(e.get("text") or "") for e in pane_els[:3])
                if sig == prev_sig:
                    break
                prev_sig = sig
            if match:
                break

    if not match or not match.get("rect"):
        what = f"line {resolved_line}" if resolved_line is not None else json.dumps(heading_text or after_text or search_text or "")
        raise RuntimeError(f"Could not locate {what} in '{note_path}'.")
    r = match["rect"]
    point_x = round(r["x"] + 8) if at_pos == "start" else round(r["x"] + max(4, r["width"] - 12))
    return {
        "found": True,
        "path": note_path,
        "pane": match.get("pane") or (target_pane["pane"] if target_pane else "active"),
        "line": resolved_line,
        "text": match.get("text"),
        "point": {"x": point_x, "y": round(r["y"] + max(r["height"] / 2, r["height"] - 12))},
        "rect": r,
        "selector": match.get("selector"),
        "scrolled": scrolled,
    }

def run_ui_insert_line(pos, flags):
    anchor = ui_target(flags, "")
    if not anchor or not anchor.get("note"):
        raise RuntimeError("Usage: obs-herdr ui insert-line --note <path> (--line <n> | --after <text> | --heading <h>) [--at end|start] (--text <t> | --stdin)")
    if "line" not in anchor and not anchor.get("after") and not anchor.get("heading"):
        raise RuntimeError("ui insert-line requires --line <n>, --after <text>, or --heading <h>.")
    if flags.get("stdin"):
        text_val = sys.stdin.read()
    elif "text" in flags:
        text_val = str(flags["text"])
    elif pos:
        text_val = " ".join(pos)
    else:
        raise RuntimeError("ui insert-line requires --text <t> or --stdin.")
    try:
        return call_bridge("ui.insert_line", {"target": anchor, "text": text_val})
    except Exception as exc:
        if not str(exc).startswith("unknown_method:"):
            raise
        return call_bridge("ui.batch", {"steps": [{"action": "insert_line", "target": anchor, "text": text_val}]})

def main():
    argv = sys.argv[1:]
    help_text = resolve_help_text(argv)
    if help_text is not None:
        sys.stdout.write(help_text + "\\n")
        return
    if argv[0] == "mcp":
        run_mcp()
        return
    if argv[0] == "plugin-action":
        run_plugin_action(argv[1] if len(argv) > 1 else "vault-status")
        return

    group = argv[0]
    sub = argv[1] if len(argv) > 1 else ""
    pos, flags = parse_flags(argv[2:])
    if group == "ui":
        validate_ui_flags(sub, flags)
    if group == "vault" and sub == "info":
        res = call_bridge("vault.info", {})
    elif group == "note" and sub == "list":
        res = call_bridge("vault.list_files", {"folder": flags.get("folder"), "tag": flags.get("tag"), "extension": flags.get("extension"), "limit": parse_positive_int(flags.get("limit"), "limit")})
    elif group == "note" and sub == "read":
        res = call_bridge("vault.read_note", {"path": pos[0]})
    elif group == "note" and sub == "search":
        res = call_bridge("vault.search", {"query": pos[0], "limit": parse_positive_int(flags.get("limit"), "limit")})
    elif group == "note" and sub == "create":
        content = sys.stdin.read() if flags.get("stdin") else flags.get("content", "")
        res = call_bridge("vault.create_note", {"path": pos[0], "content": content, "overwrite": bool(flags.get("overwrite"))})
    elif group == "note" and sub == "update":
        content = sys.stdin.read() if flags.get("stdin") else flags.get("content", "")
        res = call_bridge("vault.update_note", {"path": pos[0], "mode": flags.get("mode", "append"), "heading": flags.get("heading"), "search": flags.get("search"), "content": content})
    elif group == "note" and sub == "frontmatter":
        res = call_bridge("vault.patch_frontmatter", {"path": pos[0], "set": parse_set(flags["set"]), "unset": flags["unset"]})
    elif group == "note" and sub == "rename":
        res = call_bridge("vault.rename_note", {"path": pos[0], "newPath": pos[1]})
    elif group == "note" and sub == "trash":
        res = call_bridge("vault.trash_note", {"path": pos[0]})
    elif group == "note" and sub == "backlinks":
        res = call_bridge("metadata.backlinks", {"path": pos[0]})
    elif group == "note" and sub == "graph":
        res = call_bridge("metadata.graph_neighbors", {"path": pos[0]})
    elif group == "canvas" and sub == "upsert":
        text_val = sys.stdin.read() if flags.get("stdin") else flags.get("text")
        res = call_bridge("canvas.upsert_node", {
            "path": pos[0],
            "id": flags.get("id"),
            "nodeType": flags.get("type") or flags.get("nodeType") or "text",
            "text": text_val,
            "file": flags.get("file"),
            "url": flags.get("url"),
            "x": parse_finite_number(flags.get("x"), "x"),
            "y": parse_finite_number(flags.get("y"), "y"),
            "width": parse_finite_number(flags.get("width"), "width"),
            "height": parse_finite_number(flags.get("height"), "height"),
            "color": flags.get("color"),
        })
    elif group == "workspace" and sub == "state":
        res = call_bridge("workspace.get_state", {})
    elif group == "workspace" and sub == "open":
        res = call_bridge("workspace.open_note", {"path": pos[0], "line": parse_positive_int(flags.get("line"), "line"), "pane": flags.get("pane", "current")})
    elif group == "workspace" and sub == "notice":
        res = call_bridge("workspace.notice", {"message": " ".join(pos)})
    elif group == "editor" and sub == "selection":
        res = call_bridge("editor.selection", {})
    elif group == "editor" and sub == "insert":
        text_val = sys.stdin.read() if flags.get("stdin") else " ".join(pos)
        res = call_bridge("editor.insert_at_cursor", {"text": text_val})
    elif group == "command" and sub == "list":
        res = call_bridge("commands.list", {"query": flags.get("query") or (pos[0] if pos else "")})
    elif group == "command" and sub == "run":
        res = call_bridge("commands.execute", {"commandId": pos[0]})
    elif group == "ui" and sub == "screenshot":
        if "out" in flags and "output" in flags and str(flags["out"]) != str(flags["output"]):
            raise RuntimeError("Conflicting values passed for --out and --output.")
        out_flag = flags["out"] if "out" in flags else flags.get("output")
        if out_flag is not None and str(out_flag).strip() == "":
            raise RuntimeError("--out/--output path cannot be empty.")
        shot = call_bridge("ui.screenshot", {"maxWidth": parse_positive_int(flags.get("max-width"), "max-width")})
        res = save_screenshot(shot, out_flag)
    elif group == "ui" and sub == "inspect":
        res = run_ui_inspect(flags)
    elif group == "ui" and sub == "locate":
        res = run_ui_locate(pos, flags)
    elif group == "ui" and sub == "insert-line":
        res = run_ui_insert_line(pos, flags)
    elif group == "ui" and sub == "wait":
        res = call_bridge("ui.wait_for", {"text": " ".join(pos), "selector": flags.get("selector"), "timeoutMs": parse_non_negative_int(flags.get("timeout"), "timeout")})
    elif group == "ui" and sub == "click":
        res = call_bridge("ui.click", {"target": ui_target(flags, ""), "button": flags.get("button"), "count": parse_positive_int(flags.get("count"), "count")})
    elif group == "ui" and sub == "select":
        sel_params = {"target": ui_target(flags, "")}
        if "value" in flags:
            sel_params["value"] = str(flags["value"])
        if "label" in flags:
            sel_params["label"] = str(flags["label"])
        res = call_bridge("ui.select", sel_params)
    elif group == "ui" and sub == "type":
        text_val = sys.stdin.read() if flags.get("stdin") else (str(flags["text"]) if "text" in flags else " ".join(pos))
        res = call_bridge("ui.type", {"text": text_val, "target": ui_target(flags, "")})
    elif group == "ui" and sub == "key":
        parts = [p for p in (pos[0] if pos else "").split("+") if p]
        key = parts.pop() if parts else ""
        res = call_bridge("ui.press_key", {"key": key, "modifiers": parts})
    elif group == "ui" and sub == "scroll":
        res = call_bridge("ui.scroll", {
            "target": ui_target(flags, ""),
            "deltaX": parse_finite_number(flags["dx"], "dx") if "dx" in flags else 0,
            "deltaY": parse_finite_number(flags["dy"], "dy") if "dy" in flags else 0,
        })
    elif group == "ui" and sub == "drag":
        res = call_bridge("ui.drag", {"from": ui_target(flags, "from-"), "to": ui_target(flags, "to-"), "steps": parse_positive_int(flags.get("steps"), "steps")})
    elif group == "ui" and sub == "batch":
        raw_steps = flags.get("steps-json") or (sys.stdin.read() if flags.get("stdin") else (pos[0] if pos else "[]"))
        res = call_bridge("ui.batch", {"steps": json.loads(raw_steps)})
    elif group == "rpc":
        res = call_bridge(sub, json.loads(pos[0]) if pos else {})
    else:
        raise RuntimeError("Unknown obs-herdr command. Run 'obs-herdr --help' for usage.")
    sys.stdout.write(json.dumps(res, indent=2) + "\\n")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stderr.write(str(e) + "\\n")
        sys.exit(1)
`;
}
