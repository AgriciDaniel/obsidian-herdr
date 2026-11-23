#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as readline from "node:readline";

const DEFAULT_CONN_FILE = "__OBS_HERDR_CONN_FILE__";
const PLUGIN_VERSION = "__OBS_HERDR_PLUGIN_VERSION__";

const SKILL_TEXT = "__OBS_HERDR_SKILL_TEXT__";

const COMMAND_HELP = /*__OBS_HERDR_COMMAND_HELP__*/ {};

const UI_ALLOWED_FLAGS = /*__OBS_HERDR_UI_ALLOWED_FLAGS__*/ {};

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
  const clamp = (ms) => Math.min(600000, Math.max(1000, Math.round(ms)));
  const envRaw = process.env.OBS_HERDR_TIMEOUT_MS;
  const envNum = envRaw !== undefined && envRaw !== "" ? Number(envRaw) : NaN;
  // UI actions queue behind other agents' actions and a batch can run for minutes, so
  // they get 5 minutes by default; an explicit OBS_HERDR_TIMEOUT_MS still wins.
  const defaultMs = typeof method === "string" && method.startsWith("ui.") ? 300000 : 60000;
  const base = Number.isFinite(envNum) && envNum > 0 ? clamp(envNum) : defaultMs;
  if (method === "ui.wait_for") {
    const p = params && typeof params === "object" ? params : {};
    const waitMs = Number.isFinite(Number(p.timeoutMs)) && Number(p.timeoutMs) >= 0 ? Number(p.timeoutMs) : 5000;
    return clamp(Math.max(base, Math.round(waitMs) + 30000));
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
      return clamp(Math.max(base, Math.round(totalWait) + 30000));
    }
  }
  return clamp(base);
}

function isUiControlEnabledFromConn() {
  const connFile = process.env.OBSIDIAN_HERDR_CONNECTION_FILE || DEFAULT_CONN_FILE;
  if (fs.existsSync(connFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(connFile, "utf8"));
      if (parsed && typeof parsed.uiControlEnabled === "boolean") {
        return parsed.uiControlEnabled;
      }
    } catch {
      // Fall back to default
    }
  }
  return true;
}

class BridgeRpcClientError extends Error {
  constructor(code, message) {
    super(code + ": " + message);
    this.code = code;
    this.isBridgeError = true;
  }
}

function callBridge(method, params = {}) {
  const { socketPath, token } = resolveConnection();
  const id = "cli_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const caller = process.env.HERDR_PANE_ID ? "herdr:" + process.env.HERDR_PANE_ID : "obs-herdr-cli";
  const timeoutMs = resolveTimeoutMs(method, params);
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
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
      sock.write(JSON.stringify({ id, token, method, params, caller }) + "\n", "utf8");
    });
    sock.on("data", (chunk) => {
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      const nl = pending.indexOf(0x0a);
      if (nl !== -1) {
        const line = pending.subarray(0, nl).toString("utf8").trim();
        let res;
        try {
          res = JSON.parse(line);
        } catch (parseErr) {
          finish(new Error("Invalid JSON response from Obsidian bridge: " + (parseErr instanceof Error ? parseErr.message : String(parseErr))));
          return;
        }
        if (!res || !res.ok) {
          finish(new BridgeRpcClientError(res?.error?.code || "error", res?.error?.message || "Bridge error"));
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
      if (eq <= 0) {
        throw new Error("--set requires key=value with a non-empty key.");
      }
      const key = trimmed.slice(0, eq).trim();
      if (!key) {
        throw new Error("--set requires key=value with a non-empty key.");
      }
      out[key] = trimmed.slice(eq + 1);
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
  const isHelpCmd = argv[0] === "help";
  const parsed = parseFlags(isHelpCmd ? argv.slice(1) : argv, { strict: false });
  if (!isHelpCmd && !parsed.flags.help) {
    return null;
  }
  const { pos } = parsed;
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

const MCP_TOOLS = /*__OBS_HERDR_MCP_TOOLS__*/ [];

function toMcpContent(out) {
  if (out && typeof out === "object" && out.image && typeof out.image.data === "string") {
    const { image, ...rest } = out;
    return [
      { type: "image", data: image.data, mimeType: image.mimeType || "image/png" },
      { type: "text", text: JSON.stringify(rest) },
    ];
  }
  return [{ type: "text", text: JSON.stringify(out) }];
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
  if (!/^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/.test(s)) {
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
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
    if (msg.id === undefined) continue;
    try {
      if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "obsidian-herdr-bridge", version: PLUGIN_VERSION } } }) + "\n");
      } else if (msg.method === "tools/list") {
        const uiEnabled = isUiControlEnabledFromConn();
        const visible = uiEnabled ? MCP_TOOLS : MCP_TOOLS.filter((t) => !t.rpc.startsWith("ui."));
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: visible.map(({ rpc, ...rest }) => rest) } }) + "\n");
      } else if (msg.method === "tools/call") {
        const tool = MCP_TOOLS.find((t) => t.name === msg.params?.name);
        if (!tool) throw new Error("Unknown tool: " + msg.params?.name);
        try {
          const out = await callBridge(tool.rpc, msg.params?.arguments || {});
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: toMcpContent(out) } }) + "\n");
        } catch (callErr) {
          if (callErr && callErr.isBridgeError) {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: callErr.message }], isError: true } }) + "\n");
          } else {
            throw callErr;
          }
        }
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
      }
    } catch (err) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } }) + "\n");
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
  } else if (action === "capture-pane") {
    const paneId = String(process.env.HERDR_PANE_ID || "").trim();
    if (!paneId || paneId.startsWith("-") || /\s/.test(paneId)) {
      throw new Error("HERDR_PANE_ID is not set or invalid in this pane environment.");
    }
    const text = execFileSync(herdrBin, ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "120"], { encoding: "utf8" });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeId = paneId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.\./g, "-");
    const trimmed = text.trim();
    const longestRun = (trimmed.match(/`+/g) || []).reduce((m, s) => Math.max(m, s.length), 0);
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    const notePath = "Herdr Captures/Pane " + safeId + " " + stamp + ".md";
    await callBridge("vault.create_note", { path: notePath, content: "# Herdr Pane Capture (" + paneId + ")\n\n" + fence + "text\n" + trimmed + "\n" + fence + "\n" });
    await callBridge("workspace.open_note", { path: notePath });
    execFileSync(herdrBin, ["notification", "show", "Saved pane to vault", "--body", notePath]);
  }
}

async function runUiInspect(flags) {
  const limit = parsePositiveInt(flags.limit, "limit");
  return callBridge("ui.inspect", {
    selector: flags.selector,
    text: flags.text,
    limit,
  });
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
  return callBridge("ui.locate", {
    note: notePath,
    path: notePath,
    line: lineNum,
    text: searchText,
    after: afterText,
    heading: headingText,
    at: atPos,
  });
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
    process.stdout.write(helpText + "\n");
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
    result = await callBridge("vault.list_files", {
      folder: flags.folder,
      tag: flags.tag,
      extension: flags.extension,
      limit: parsePositiveInt(flags.limit, "limit"),
      offset: parseNonNegativeInt(flags.offset, "offset"),
    });
  } else if (group === "note" && sub === "read") {
    if (!pos[0]) {
      throw new Error("Usage: obs-herdr note read <vault-rel-path> [--offset-line <n>] [--max-lines <n>] [--max-chars <n>]");
    }
    result = await callBridge("vault.read_note", {
      path: pos[0],
      offsetLine: parseNonNegativeInt(flags["offset-line"], "offset-line"),
      maxLines: parsePositiveInt(flags["max-lines"], "max-lines"),
      maxChars: parsePositiveInt(flags["max-chars"], "max-chars"),
    });
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
    result = await callBridge("metadata.backlinks", {
      path: pos[0],
      limit: parsePositiveInt(flags.limit, "limit"),
      offset: parseNonNegativeInt(flags.offset, "offset"),
    });
  } else if (group === "note" && sub === "graph") {
    result = await callBridge("metadata.graph_neighbors", {
      path: pos[0],
      limit: parsePositiveInt(flags.limit, "limit"),
    });
  } else if (group === "canvas" && sub === "upsert") {
    result = await callBridge("canvas.upsert_node", {
      path: pos[0],
      id: flags.id,
      nodeType: flags.type || flags.nodeType || "text",
      text: flags.stdin ? readStdin() : flags.text,
      file: flags.file,
      url: flags.url,
      label: flags.label,
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
    result = await callBridge("commands.list", {
      query: flags.query || pos[0] || "",
      limit: parsePositiveInt(flags.limit, "limit"),
      offset: parseNonNegativeInt(flags.offset, "offset"),
    });
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
    const rawKey = String(pos[0] || "");
    let key = "";
    let modifiers = [];
    if (rawKey === "+") {
      key = "+";
    } else if (rawKey.endsWith("++")) {
      key = "+";
      modifiers = rawKey.slice(0, -2).split("+").filter(Boolean);
    } else {
      const parts = rawKey.split("+").filter(Boolean);
      key = parts.pop() || "";
      modifiers = parts;
    }
    result = await callBridge("ui.press_key", { key, modifiers });
  } else if (group === "ui" && sub === "scroll") {
    result = await callBridge("ui.scroll", {
      target: uiTarget(flags, ""),
      deltaX: flags.dx !== undefined ? parseFiniteNumber(flags.dx, "dx") : 0,
      deltaY: flags.dy !== undefined ? parseFiniteNumber(flags.dy, "dy") : 0,
    });
  } else if (group === "ui" && sub === "drag") {
    result = await callBridge("ui.drag", { from: uiTarget(flags, "from-"), to: uiTarget(flags, "to-"), steps: parsePositiveInt(flags.steps, "steps") });
  } else if (group === "ui" && sub === "batch") {
    if (flags["steps-json"] !== undefined && String(flags["steps-json"]).trim() === "") {
      throw new Error("--steps-json cannot be empty.");
    }
    const rawSteps = flags["steps-json"] !== undefined ? String(flags["steps-json"]) : (flags.stdin ? readStdin() : pos[0] || "[]");
    result = await callBridge("ui.batch", { steps: JSON.parse(rawSteps) });
  } else if (group === "rpc") {
    result = await callBridge(sub, pos[0] ? JSON.parse(pos[0]) : {});
  } else {
    throw new Error("Unknown obs-herdr command. Run 'obs-herdr --help' for usage.");
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
  process.exit(1);
});
