import * as crypto from "node:crypto";
import * as fs from "node:fs";
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
}): void {
  const { kit, token, vaultName, vaultPath } = options;

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
  fs.writeFileSync(coreMjsPath, buildObsHerdrCoreMjs(kit.connectionFilePath), {
    encoding: "utf8",
    mode: 0o700,
  });

  const corePyPath = path.join(kit.binDir, "obs-herdr-core.py");
  fs.writeFileSync(corePyPath, buildObsHerdrCorePy(kit.connectionFilePath), {
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
    buildHerdrPluginManifestToml(kit.cliScriptPath),
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

function buildHerdrPluginManifestToml(cliScriptPath: string): string {
  const cliEsc = JSON.stringify(cliScriptPath);
  return [
    'id = "obsidian.vault"',
    'name = "Obsidian Vault Bridge"',
    'version = "0.1.0"',
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

const SHARED_SKILL_TEXT = [
  "---",
  "name: obsidian-vault-bridge",
  'description: "Inspect, search, create, edit, link-safe rename, and navigate notes in the live Obsidian vault via obs-herdr."',
  "---",
  "",
  "# Obsidian Vault Control Bridge (obs-herdr)",
  "",
  "Use `obs-herdr` inside Herdr panes to interact with the live Obsidian app and vault safely through Obsidian's native Vault, FileManager, MetadataCache, and Workspace APIs.",
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
  "  obs-herdr mcp   # Run JSON-RPC 2.0 MCP server over stdio (24 tools)",
  "",
  "## See and operate the Obsidian window",
  "",
  "Needs 'Let agents see and operate Obsidian' in Herdr settings. Clicking, typing, keys, scrolling, and dragging also need the Full permission tier. Check `obs-herdr vault info` (uiControl) first.",
  "",
  "  obs-herdr ui screenshot [--out <file.png>] [--max-width <px>]   # saves a PNG and prints its path",
  "  obs-herdr ui inspect [--selector <css>] [--text <t>] [--limit <n>]",
  "  obs-herdr ui wait <text> [--selector <css>] [--timeout <ms>]",
  "  obs-herdr ui click (--selector <css> | --x <n> --y <n>) [--button left|right|middle] [--count <n>]",
  "  obs-herdr ui type [<text> | --stdin] [--selector <css>]",
  "  obs-herdr ui key <Key|Mod+Key>   # e.g. Enter, Escape, Mod+P, Mod+Shift+F",
  "  obs-herdr ui scroll (--selector <css> | --x <n> --y <n>) [--dy <n>] [--dx <n>]   # positive dy scrolls down",
  "  obs-herdr ui drag (--from-selector <css> | --from-x <n> --from-y <n>) (--to-selector <css> | --to-x <n> --to-y <n>) [--steps <n>]",
  "",
  "Tips: coordinates are CSS pixels from `ui inspect`. A selector must match exactly one visible, uncovered element. Input only reports that it was dispatched, so confirm the effect with `ui wait`, `ui inspect`, or a screenshot. Prefer `note` commands for editing note text; use UI control for things only the interface can do. Typing that changes the active note is logged and can be undone in Mission Control.",
].join("\n");

const UI_TARGET_SCHEMA = {
  type: "object",
  description: "Either {selector} or {x, y} in CSS pixels.",
  properties: {
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
      "Capture the Obsidian window as a PNG image. Needs UI control enabled in Herdr settings. Use cssPixelsPerImagePixel to map image pixels to CSS pixels for other UI tools.",
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
      "List visible interface elements with labels, text, CSS selectors, and CSS pixel bounds. Optional selector and text filters.",
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
];

function buildObsHerdrCoreMjs(defaultConnFile: string): string {
  return `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as readline from "node:readline";

const DEFAULT_CONN_FILE = ${JSON.stringify(defaultConnFile)};

const SKILL_TEXT = ${JSON.stringify(SHARED_SKILL_TEXT)};

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

function callBridge(method, params = {}) {
  const { socketPath, token } = resolveConnection();
  const id = "cli_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const caller = process.env.HERDR_PANE_ID ? "herdr:" + process.env.HERDR_PANE_ID : "obs-herdr-cli";
  return new Promise((resolve, reject) => {
    let buf = "";
    const sock = net.createConnection({ path: socketPath });
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id, token, method, params, caller }) + "\\n", "utf8");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\\n");
      if (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        sock.destroy();
        const res = JSON.parse(line);
        if (!res.ok) {
          reject(new Error((res.error?.code || "error") + ": " + (res.error?.message || "Bridge error")));
        } else {
          resolve(res.result);
        }
      }
    });
    sock.on("error", (err) => reject(err));
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

function parseFlags(args) {
  const pos = [];
  const flags = { set: [], unset: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--stdin" || a === "--overwrite") {
      flags[a.slice(2)] = true;
    } else if (a === "--set" && args[i + 1]) {
      flags.set.push(args[++i]);
    } else if (a === "--unset" && args[i + 1]) {
      flags.unset.push(args[++i]);
    } else if (a.startsWith("--") && args[i + 1] !== undefined) {
      flags[a.slice(2)] = args[++i];
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
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

function uiTarget(flags, prefix) {
  const sel = flags[prefix + "selector"];
  if (sel) return { selector: sel };
  if (flags[prefix + "x"] !== undefined && flags[prefix + "y"] !== undefined) {
    return { x: Number(flags[prefix + "x"]), y: Number(flags[prefix + "y"]) };
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
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "obsidian-herdr-bridge", version: "0.1.0" } } }) + "\\n");
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

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "--skill") {
    process.stdout.write(SKILL_TEXT + "\\n");
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
  const readStdin = () => fs.readFileSync(0, "utf8");
  let result;

  if (group === "vault" && sub === "info") {
    result = await callBridge("vault.info", {});
  } else if (group === "note" && sub === "list") {
    result = await callBridge("vault.list_files", { folder: flags.folder, tag: flags.tag, extension: flags.extension, limit: flags.limit ? Number(flags.limit) : undefined });
  } else if (group === "note" && sub === "read") {
    result = await callBridge("vault.read_note", { path: pos[0] });
  } else if (group === "note" && sub === "search") {
    result = await callBridge("vault.search", { query: pos[0], limit: flags.limit ? Number(flags.limit) : undefined });
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
      x: flags.x !== undefined ? Number(flags.x) : undefined,
      y: flags.y !== undefined ? Number(flags.y) : undefined,
      width: flags.width !== undefined ? Number(flags.width) : undefined,
      height: flags.height !== undefined ? Number(flags.height) : undefined,
      color: flags.color,
    });
  } else if (group === "workspace" && sub === "state") {
    result = await callBridge("workspace.get_state", {});
  } else if (group === "workspace" && sub === "open") {
    result = await callBridge("workspace.open_note", { path: pos[0], line: flags.line ? Number(flags.line) : undefined, pane: flags.pane || "current" });
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
    const shot = await callBridge("ui.screenshot", { maxWidth: flags["max-width"] ? Number(flags["max-width"]) : undefined });
    result = saveScreenshot(shot, flags.out);
  } else if (group === "ui" && sub === "inspect") {
    result = await callBridge("ui.inspect", { selector: flags.selector, text: flags.text, limit: flags.limit ? Number(flags.limit) : undefined });
  } else if (group === "ui" && sub === "wait") {
    result = await callBridge("ui.wait_for", { text: pos.join(" "), selector: flags.selector, timeoutMs: flags.timeout ? Number(flags.timeout) : undefined });
  } else if (group === "ui" && sub === "click") {
    result = await callBridge("ui.click", { target: uiTarget(flags, ""), button: flags.button, count: flags.count ? Number(flags.count) : undefined });
  } else if (group === "ui" && sub === "type") {
    result = await callBridge("ui.type", { text: flags.stdin ? readStdin() : pos.join(" "), target: uiTarget(flags, "") });
  } else if (group === "ui" && sub === "key") {
    const parts = String(pos[0] || "").split("+").filter(Boolean);
    result = await callBridge("ui.press_key", { key: parts.pop() || "", modifiers: parts });
  } else if (group === "ui" && sub === "scroll") {
    result = await callBridge("ui.scroll", { target: uiTarget(flags, ""), deltaX: flags.dx ? Number(flags.dx) : 0, deltaY: flags.dy ? Number(flags.dy) : 0 });
  } else if (group === "ui" && sub === "drag") {
    result = await callBridge("ui.drag", { from: uiTarget(flags, "from-"), to: uiTarget(flags, "to-"), steps: flags.steps ? Number(flags.steps) : undefined });
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

function buildObsHerdrCorePy(defaultConnFile: string): string {
  return `#!/usr/bin/env python3
import datetime, json, os, socket, subprocess, sys, time

DEFAULT_CONN_FILE = ${JSON.stringify(defaultConnFile)}

SKILL_TEXT = ${JSON.stringify(SHARED_SKILL_TEXT)}

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

def call_bridge(method, params=None):
    sock_path, token = resolve_conn()
    caller = f"herdr:{os.environ['HERDR_PANE_ID']}" if os.environ.get("HERDR_PANE_ID") else "obs-herdr-py"
    clean_params = {k: v for k, v in (params or {}).items() if v is not None}
    req = {"id": f"py_{int(time.time()*1000)}", "token": token, "method": method, "params": clean_params, "caller": caller}
    payload = (json.dumps(req) + "\\n").encode("utf-8")
    if os.name == "nt" and sock_path.startswith("\\\\\\\\.\\\\pipe\\\\"):
        with open(sock_path, "r+b", buffering=0) as pipe_fh:
            pipe_fh.write(payload)
            buf = b""
            while b"\\n" not in buf:
                chunk = pipe_fh.read(65536)
                if not chunk:
                    break
                buf += chunk
    else:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.connect(sock_path)
            s.sendall(payload)
            buf = b""
            while b"\\n" not in buf:
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
    res = json.loads(buf.split(b"\\n", 1)[0].decode("utf-8"))
    if not res.get("ok"):
        err = res.get("error") or {}
        raise RuntimeError(f"{err.get('code', 'error')}: {err.get('message', 'Bridge error')}")
    return res.get("result")

def parse_flags(args):
    pos, flags = [], {"set": [], "unset": []}
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("--stdin", "--overwrite"):
            flags[a[2:]] = True
        elif a == "--set" and i + 1 < len(args):
            i += 1
            flags["set"].append(args[i])
        elif a == "--unset" and i + 1 < len(args):
            i += 1
            flags["unset"].append(args[i])
        elif a.startswith("--") and i + 1 < len(args):
            flags[a[2:]] = args[i + 1]
            i += 1
        else:
            pos.append(a)
        i += 1
    return pos, flags

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

def ui_target(flags, prefix):
    if flags.get(prefix + "selector"):
        return {"selector": flags[prefix + "selector"]}
    if (prefix + "x") in flags and (prefix + "y") in flags:
        return {"x": float(flags[prefix + "x"]), "y": float(flags[prefix + "y"])}
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
                out = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "obsidian-herdr-bridge", "version": "0.1.0"}}
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

def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help", "--skill"):
        sys.stdout.write(SKILL_TEXT + "\\n")
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
    if group == "vault" and sub == "info":
        res = call_bridge("vault.info", {})
    elif group == "note" and sub == "list":
        res = call_bridge("vault.list_files", {"folder": flags.get("folder"), "tag": flags.get("tag"), "extension": flags.get("extension"), "limit": int(flags["limit"]) if "limit" in flags else None})
    elif group == "note" and sub == "read":
        res = call_bridge("vault.read_note", {"path": pos[0]})
    elif group == "note" and sub == "search":
        res = call_bridge("vault.search", {"query": pos[0], "limit": int(flags["limit"]) if "limit" in flags else None})
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
            "x": float(flags["x"]) if "x" in flags else None,
            "y": float(flags["y"]) if "y" in flags else None,
            "width": float(flags["width"]) if "width" in flags else None,
            "height": float(flags["height"]) if "height" in flags else None,
            "color": flags.get("color"),
        })
    elif group == "workspace" and sub == "state":
        res = call_bridge("workspace.get_state", {})
    elif group == "workspace" and sub == "open":
        res = call_bridge("workspace.open_note", {"path": pos[0], "line": int(flags["line"]) if "line" in flags else None, "pane": flags.get("pane", "current")})
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
        shot = call_bridge("ui.screenshot", {"maxWidth": float(flags["max-width"]) if "max-width" in flags else None})
        res = save_screenshot(shot, flags.get("out"))
    elif group == "ui" and sub == "inspect":
        res = call_bridge("ui.inspect", {"selector": flags.get("selector"), "text": flags.get("text"), "limit": int(flags["limit"]) if "limit" in flags else None})
    elif group == "ui" and sub == "wait":
        res = call_bridge("ui.wait_for", {"text": " ".join(pos), "selector": flags.get("selector"), "timeoutMs": int(flags["timeout"]) if "timeout" in flags else None})
    elif group == "ui" and sub == "click":
        res = call_bridge("ui.click", {"target": ui_target(flags, ""), "button": flags.get("button"), "count": int(flags["count"]) if "count" in flags else None})
    elif group == "ui" and sub == "type":
        text_val = sys.stdin.read() if flags.get("stdin") else " ".join(pos)
        res = call_bridge("ui.type", {"text": text_val, "target": ui_target(flags, "")})
    elif group == "ui" and sub == "key":
        parts = [p for p in (pos[0] if pos else "").split("+") if p]
        key = parts.pop() if parts else ""
        res = call_bridge("ui.press_key", {"key": key, "modifiers": parts})
    elif group == "ui" and sub == "scroll":
        res = call_bridge("ui.scroll", {"target": ui_target(flags, ""), "deltaX": float(flags.get("dx", 0)), "deltaY": float(flags.get("dy", 0))})
    elif group == "ui" and sub == "drag":
        res = call_bridge("ui.drag", {"from": ui_target(flags, "from-"), "to": ui_target(flags, "to-"), "steps": int(flags["steps"]) if "steps" in flags else None})
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
