import { normalizePath } from "obsidian";
import { isDeepStrictEqual } from "node:util";
import type { VaultPermissionMode } from "../domain/types";

export class BridgeRpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeRpcError";
    this.code = code;
  }
}

export interface VaultTextChange {
  before: string;
  after: string;
  from: number;
  to: number;
  insertLength: number;
}

export interface CanvasNodeRecord {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  file?: string;
  url?: string;
  label?: string;
  color?: string;
}

export interface CanvasEdgeRecord {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  toSide?: "top" | "right" | "bottom" | "left";
  label?: string;
}

export interface CanvasDocument {
  nodes: CanvasNodeRecord[];
  edges: CanvasEdgeRecord[];
}

export interface ScanExclusionOptions {
  configDir?: string;
  allowHiddenReads: boolean;
  explicitFolderPrefix?: string;
  isUserIgnored?: (path: string) => boolean;
}

export const TIER_ORDER: Readonly<Record<VaultPermissionMode, number>> = {
  off: 0,
  "read-only": 1,
  "read-write": 2,
  full: 3,
};

export const READ_METHODS: ReadonlySet<string> = new Set<string>([
  "bridge.ping",
  "vault.info",
  "vault.list_files",
  "vault.read_note",
  "vault.search",
  "metadata.backlinks",
  "metadata.graph_neighbors",
  "metadata.tags_and_properties",
  "workspace.get_state",
  "editor.selection",
  "commands.list",
]);

export const WRITE_METHODS: ReadonlySet<string> = new Set<string>([
  "vault.create_note",
  "vault.update_note",
  "vault.patch_frontmatter",
  "vault.rename_note",
  "vault.trash_note",
  "canvas.upsert_node",
  "workspace.open_note",
  "workspace.notice",
  "editor.replace_selection",
  "editor.insert_at_cursor",
]);

export const FULL_METHODS: ReadonlySet<string> = new Set<string>(["commands.execute"]);

/** Seeing the window: any bridge tier, plus the separate UI control setting. */
export const UI_OBSERVE_METHODS: ReadonlySet<string> = new Set<string>([
  "ui.screenshot",
  "ui.inspect",
  "ui.wait_for",
  "ui.locate",
  "ui.hover",
]);

/** Operating the window can do anything a person can, so it needs Full plus the UI control setting. */
export const UI_INPUT_METHODS: ReadonlySet<string> = new Set<string>([
  "ui.click",
  "ui.select",
  "ui.type",
  "ui.press_key",
  "ui.scroll",
  "ui.drag",
  "ui.batch",
  "ui.insert_line",
]);

export const UI_CONTROL_METHODS: ReadonlySet<string> = new Set<string>([
  ...UI_OBSERVE_METHODS,
  ...UI_INPUT_METHODS,
]);

export const METHOD_REQUIRED_TIER: Readonly<Record<string, Exclude<VaultPermissionMode, "off">>> = {
  ...Object.fromEntries(Array.from(READ_METHODS, (m) => [m, "read-only" as const])),
  ...Object.fromEntries(Array.from(UI_OBSERVE_METHODS, (m) => [m, "read-only" as const])),
  ...Object.fromEntries(Array.from(WRITE_METHODS, (m) => [m, "read-write" as const])),
  ...Object.fromEntries(Array.from(FULL_METHODS, (m) => [m, "full" as const])),
  ...Object.fromEntries(Array.from(UI_INPUT_METHODS, (m) => [m, "full" as const])),
};

export const RESTRICTED_COMMAND_KEYWORDS: readonly string[] = [
  "app:delete-vault",
  "app:delete-file",
  "app:toggle-restricted-mode",
  "file-explorer:delete",
  "toggle-dev-tools",
  "plugin",
  "safe-mode",
];

export const RESTRICTED_COMMAND_PREFIXES: readonly string[] = [
  "herdr-obs:",
  "templater:",
  "shell-commands:",
  "quickadd:",
];

/**
 * Plugins (core or community, by plugin id: the part of a command id before
 * the first ":") whose commands can run code, run shell commands, chain other
 * commands, or open files in other programs. An agent running one of these
 * could escape the permission tiers, so they are refused at every tier.
 */
export const RESTRICTED_COMMAND_PLUGIN_IDS: ReadonlySet<string> = new Set<string>([
  "herdr-obs",
  "templater-obsidian",
  "templater",
  "obsidian-shellcommands",
  "shell-commands",
  "quickadd",
  "execute-code",
  "open-with-default-app",
  "terminal",
  "cmdr",
  "customjs",
  "runjs",
  "js-engine",
  "python-scripter",
  "user-plugins",
]);

export const RESTRICTED_COMMAND_EXACT: ReadonlySet<string> = new Set<string>([
  "app:quit",
  "app:exit",
  "app:reload",
  "app:close-window",
  "workspace:close-window",
  "app:open-settings",
  "app:open-vault",
  "app:toggle-dev-tools",
  "window:toggle-dev-tools",
  "app:show-debug-info",
]);

export const FORBIDDEN_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export const VALID_UPDATE_MODES: ReadonlySet<string> = new Set([
  "append",
  "prepend",
  "replace",
  "under_heading",
  "search_replace",
]);

export const VALID_CANVAS_NODE_TYPES: ReadonlySet<CanvasNodeRecord["type"]> = new Set<
  CanvasNodeRecord["type"]
>(["text", "file", "link", "group"]);

export function isTierAllowed(
  current: VaultPermissionMode,
  required: VaultPermissionMode
): boolean {
  if (current === "off") {
    return false;
  }
  return TIER_ORDER[current] >= TIER_ORDER[required];
}

export function isMethodPermitted(method: string, mode: VaultPermissionMode): boolean {
  if (mode === "off" || !Object.prototype.hasOwnProperty.call(METHOD_REQUIRED_TIER, method)) {
    return false;
  }
  return isTierAllowed(mode, METHOD_REQUIRED_TIER[method]);
}

export function isProtectedCommand(commandId: string): boolean {
  return RESTRICTED_COMMAND_EXACT.has(commandId.toLowerCase());
}

export function isCommandBlocked(commandId: string): boolean {
  const lower = commandId.trim().toLowerCase();
  const colon = lower.indexOf(":");
  const pluginId = colon === -1 ? lower : lower.slice(0, colon);
  return (
    RESTRICTED_COMMAND_PLUGIN_IDS.has(pluginId) ||
    RESTRICTED_COMMAND_KEYWORDS.some((sub) => lower.includes(sub)) ||
    RESTRICTED_COMMAND_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

export function isExcludedFromScan(relPath: string, options: ScanExclusionOptions): boolean {
  const norm = relPath.replace(/\\/g, "/");
  const cfgDir = options.configDir ? normalizePath(options.configDir) : "";
  const parts = norm.split("/").filter(Boolean);
  if (parts.some((seg) => seg === ".git" || seg === ".env" || seg.startsWith(".env."))) {
    return true;
  }
  if (cfgDir && parts.includes(cfgDir) && !options.allowHiddenReads) {
    return true;
  }
  if (parts.some((seg) => seg.startsWith(".")) && !options.allowHiddenReads) {
    return true;
  }
  if (options.explicitFolderPrefix && norm.startsWith(options.explicitFolderPrefix)) {
    return false;
  }
  if (cfgDir && (norm === cfgDir || norm.startsWith(`${cfgDir}/`))) {
    return true;
  }
  if (/(?:^|\/)node_modules(?:\/|$)/.test(norm)) {
    return true;
  }
  if (typeof options.isUserIgnored === "function" && options.isUserIgnored(norm)) {
    return true;
  }
  return false;
}

export function isValidHttpUrl(raw: string): boolean {
  try {
    const parsedUrl = new URL(raw.trim());
    return parsedUrl.protocol === "https:" || parsedUrl.protocol === "http:";
  } catch {
    return false;
  }
}

export function validateCanvasHttpUrl(raw: string): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(raw.trim());
  } catch {
    throw new BridgeRpcError("invalid_params", "Canvas node 'url' must be a valid URL.");
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new BridgeRpcError(
      "invalid_params",
      `Canvas node 'url' scheme '${parsedUrl.protocol}' is not allowed; use http: or https:.`
    );
  }
  return parsedUrl.toString();
}

export function asStr(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

export function editedTextRange(before: string, after: string): VaultTextChange | undefined {
  if (before === after) {
    return undefined;
  }
  let from = 0;
  const limit = Math.min(before.length, after.length);
  while (from < limit && before.charCodeAt(from) === after.charCodeAt(from)) {
    from++;
  }
  const splitsSurrogate = (text: string, pos: number): boolean =>
    pos > 0 &&
    pos < text.length &&
    text.charCodeAt(pos - 1) >= 0xd800 &&
    text.charCodeAt(pos - 1) <= 0xdbff &&
    text.charCodeAt(pos) >= 0xdc00 &&
    text.charCodeAt(pos) <= 0xdfff;
  if (splitsSurrogate(before, from) || splitsSurrogate(after, from)) {
    from--;
  }
  let suffix = 0;
  while (
    suffix < limit - from &&
    before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)
  ) {
    suffix++;
  }
  if (
    splitsSurrogate(before, before.length - suffix) ||
    splitsSurrogate(after, after.length - suffix)
  ) {
    suffix--;
  }
  return {
    before,
    after,
    from,
    to: before.length - suffix,
    insertLength: after.length - suffix - from,
  };
}

export function fileContentsEqual(
  path: string,
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (a === b) return true;
  if (!path.endsWith(".canvas") || typeof a !== "string" || typeof b !== "string") return false;
  try {
    const left: unknown = JSON.parse(a);
    const right: unknown = JSON.parse(b);
    return isDeepStrictEqual(left, right);
  } catch {
    return false;
  }
}

export function insertUnderMarkdownHeading(
  doc: string,
  headingText: string,
  insertion: string
): string {
  const lines = doc.split(/\r?\n/);
  const normalizedTarget = headingText.replace(/^#+\s*/, "").trim().toLowerCase();
  let targetIdx = -1;
  let targetLevel = 0;

  let startIdx = 0;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "---" || lines[i].trim() === "...") {
        startIdx = i + 1;
        break;
      }
    }
  }

  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  const updateFence = (line: string): boolean => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!m) {
      return fenceChar !== null;
    }
    const ch = m[1][0] as "`" | "~";
    const len = m[1].length;
    if (fenceChar === null) {
      fenceChar = ch;
      fenceLen = len;
      return true;
    }
    if (fenceChar === ch && len >= fenceLen && /^\s*(?:`{3,}|~{3,})\s*$/.test(line)) {
      fenceChar = null;
      fenceLen = 0;
      return true;
    }
    return true;
  };

  for (let i = startIdx; i < lines.length; i += 1) {
    if (updateFence(lines[i])) {
      continue;
    }
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (m && m[2].trim().toLowerCase() === normalizedTarget) {
      targetIdx = i;
      targetLevel = m[1].length;
      break;
    }
  }

  if (targetIdx === -1) {
    const headerLine = headingText.startsWith("#") ? headingText : `## ${headingText}`;
    const sep = doc.endsWith("\n") || !doc ? "" : "\n";
    return `${doc}${sep}\n${headerLine}\n\n${insertion}\n`;
  }

  let insertAt = lines.length;
  fenceChar = null;
  fenceLen = 0;
  for (let j = targetIdx + 1; j < lines.length; j += 1) {
    if (updateFence(lines[j])) {
      continue;
    }
    const m = /^(#{1,6})\s+/.exec(lines[j]);
    if (m && m[1].length <= targetLevel) {
      insertAt = j;
      break;
    }
  }

  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  return [...before, insertion, ...after].join("\n");
}

export function parseCanvasDoc(raw: string): CanvasDocument {
  if (!raw.trim()) {
    return { nodes: [], edges: [] };
  }
  const parsed = JSON.parse(raw) as Partial<CanvasDocument>;
  return {
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    edges: Array.isArray(parsed.edges) ? parsed.edges : [],
  };
}
