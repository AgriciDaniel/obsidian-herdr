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
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) {
      const winBase = path.join(localAppData, "obs-herdr");
      try {
        fs.mkdirSync(winBase, { recursive: true });
        fs.accessSync(winBase, fs.constants.W_OK);
        return winBase;
      } catch {
        // Fall back to os.tmpdir()
      }
    }
    return os.tmpdir();
  }
  const homeCache = path.join(os.homedir(), ".cache", "obs-herdr");
  const candidateSock = path.join(homeCache, digest, "b.sock");
  if (candidateSock.length <= 98) {
    try {
      fs.mkdirSync(homeCache, { recursive: true, mode: 0o700 });
      fs.accessSync(homeCache, fs.constants.W_OK);
      return homeCache;
    } catch {
      // Try XDG_RUNTIME_DIR or os.tmpdir()
    }
  }
  const xdgRuntime = process.env.XDG_RUNTIME_DIR?.trim();
  if (xdgRuntime) {
    const xdgBase = path.join(xdgRuntime, "obs-herdr");
    if (path.join(xdgBase, digest, "b.sock").length <= 98) {
      try {
        fs.mkdirSync(xdgBase, { recursive: true, mode: 0o700 });
        fs.accessSync(xdgBase, fs.constants.W_OK);
        return xdgBase;
      } catch {
        // Fall back to os.tmpdir()
      }
    }
  }
  return os.tmpdir();
}

/**
 * Computes deterministic, private runtime paths outside the user's vault for
 * the bridge socket, connection metadata, CLI wrappers, and Herdr plugin manifest.
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

/**
 * Where 0.2.x kept connection.json on Windows (`%TEMP%\\<digest>`). 0.3.x moved the kit to
 * `%LOCALAPPDATA%\\obs-herdr\\<digest>` but kept the pipe name, so reusing the old token lets
 * MCP configs and Herdr plugin links copied under 0.2.x keep working. Windows only: there
 * `%TEMP%` is per user, while on Linux and macOS the old fallback was the shared /tmp, where
 * another user could plant a token, and the socket path changed anyway.
 */
export function legacyWindowsConnectionFilePath(
  kit: Pick<ProvisionedRuntimeKit, "runtimeDir" | "connectionFilePath">,
  platform: string = process.platform,
  tmpDir: string = os.tmpdir()
): string | null {
  if (platform !== "win32") {
    return null;
  }
  const digest = path.basename(kit.runtimeDir);
  if (!/^[0-9a-f]{12}$/.test(digest)) {
    return null;
  }
  const legacy = path.join(tmpDir, digest, "connection.json");
  return legacy === kit.connectionFilePath ? null : legacy;
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

  // Do not export plaintext OBSIDIAN_HERDR_BRIDGE_TOKEN into pane environments:
  // obs-herdr reads the mode-0600 connection file referenced by OBSIDIAN_HERDR_CONNECTION_FILE.
  const envOut: Record<string, string> = {
    OBSIDIAN_HERDR_BRIDGE_SOCKET: options.kit.socketPath,
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

export async function pruneOldScreenshots(
  runtimeDir: string,
  options: { maxKeep?: number; maxAgeMs?: number } = {}
): Promise<number> {
  const maxKeep = options.maxKeep ?? 50;
  const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const screenshotsDir = path.join(runtimeDir, "screenshots");
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(screenshotsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const files: Array<{ fullPath: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".png")) {
      continue;
    }
    const fullPath = path.join(screenshotsDir, entry.name);
    try {
      const st = await fs.promises.lstat(fullPath);
      if (st.isFile() && !st.isSymbolicLink()) {
        files.push({ fullPath, mtimeMs: st.mtimeMs });
      }
    } catch {
      // Ignore vanished file
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (let i = 0; i < files.length; i += 1) {
    if (i >= maxKeep || files[i].mtimeMs < cutoff) {
      try {
        await fs.promises.unlink(files[i].fullPath);
        removed += 1;
      } catch {
        // Ignore removal errors
      }
    }
  }
  return removed;
}

const STALE_EMPTY_KIT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const KIT_DIR_NAME_RE = /^(?:oh-)?[0-9a-f]{12}$/;

async function isRealFileAsync(filePath: string): Promise<boolean> {
  try {
    const st = await fs.promises.lstat(filePath);
    return !st.isSymbolicLink() && st.isFile();
  } catch {
    return false;
  }
}

async function hasKitBinSignatureAsync(entryPath: string): Promise<boolean> {
  const binPath = path.join(entryPath, "bin");
  try {
    const binStat = await fs.promises.lstat(binPath);
    if (binStat.isSymbolicLink() || !binStat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }
  return (
    (await isRealFileAsync(path.join(binPath, "obs-herdr-core.mjs"))) ||
    (await isRealFileAsync(path.join(binPath, "obs-herdr-core.py")))
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
  const winDefaultBase = process.env.LOCALAPPDATA?.trim()
    ? path.join(process.env.LOCALAPPDATA.trim(), "obs-herdr")
    : os.tmpdir();
  const defaultBase = process.platform !== "win32" ? homeCacheBase : winDefaultBase;
  const baseDir = path.resolve(opts.baseDir || defaultBase);
  const isHomeCacheBase = baseDir === homeCacheBase;
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
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
      dirStat = await fs.promises.lstat(entryPath);
    } catch {
      continue;
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      continue;
    }

    const connPath = path.join(entryPath, "connection.json");
    let stale = false;
    let hasConnFile = false;
    let hasConnSignature = false;
    let connSocketPath: string | null = null;
    try {
      const connStat = await fs.promises.lstat(connPath);
      if (!connStat.isSymbolicLink() && connStat.isFile()) {
        hasConnFile = true;
        const raw = await fs.promises.readFile(connPath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.socketPath === "string" && parsed.socketPath.trim().length > 0) {
            connSocketPath = parsed.socketPath.trim();
          }
          if (Object.prototype.hasOwnProperty.call(parsed, "vaultPath")) {
            hasConnSignature = true;
            if (typeof parsed.vaultPath === "string" && parsed.vaultPath.trim().length > 0) {
              try {
                await fs.promises.access(parsed.vaultPath);
                stale = false;
              } catch {
                stale = true;
              }
            }
          }
        }
      }
    } catch {
      hasConnFile = false;
    }

    const sockPath = path.join(entryPath, "b.sock");
    let hasLiveSocket = false;
    if (process.platform === "win32" || (connSocketPath && /^\\\\[.?]\\pipe\\/i.test(connSocketPath))) {
      if (connSocketPath) {
        hasLiveSocket = await isSocketLive(connSocketPath);
      }
    } else {
      try {
        const sockStat = await fs.promises.lstat(sockPath);
        if (!sockStat.isSymbolicLink()) {
          hasLiveSocket = await isSocketLive(sockPath);
        }
      } catch {
        hasLiveSocket = false;
      }
      if (!hasLiveSocket && connSocketPath && connSocketPath !== sockPath) {
        try {
          const altStat = await fs.promises.lstat(connSocketPath);
          if (!altStat.isSymbolicLink() && altStat.isSocket()) {
            hasLiveSocket = await isSocketLive(connSocketPath);
          }
        } catch {
          // Ignore unreadable alternate socketPath
        }
      }
    }
    if (hasLiveSocket) {
      continue;
    }

    const hasBinSig = await hasKitBinSignatureAsync(entryPath);
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
        await fs.promises.rm(entryPath, { recursive: true, force: true });
        removed.push(entry.name);
      } catch {
        // Ignore removal errors on busy/protected entries
      }
    }
  }

  return { removed };
}
