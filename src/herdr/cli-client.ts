import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  HerdrIntegrationRow,
  HerdrNamedSession,
  HerdrStatusPayload,
} from "../domain/types";

/**
 * Resolves the Herdr CLI binary across common Linux, macOS, and Windows install locations
 * without invoking a shell.
 */
export function resolveHerdrBinary(configuredPath?: string): string | null {
  if (configuredPath && configuredPath.trim()) {
    const expanded = configuredPath.startsWith("~/")
      ? path.join(os.homedir(), configuredPath.slice(2))
      : configuredPath.trim();
    if (isExecutableFile(expanded)) {
      return expanded;
    }
  }

  const exeName = process.platform === "win32" ? "herdr.exe" : "herdr";
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const home = os.homedir();

  const fallbackDirs = [
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/usr/bin",
  ];

  for (const dir of [...pathDirs, ...fallbackDirs]) {
    const candidate = path.join(dir, exeName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isExecutableFile(target: string): boolean {
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform !== "win32") {
      fs.accessSync(target, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutableOnNormalizedPath(name: string): string | null {
  // npm installs Windows command shims, not just .exe files.
  const names = process.platform === "win32" && !path.extname(name)
    ? [".exe", ".com", ".cmd", ".bat"].map(ext => name + ext)
    : [name];
  const norm = buildHostNormalizedEnv(process.env);
  const dirs = (norm.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const executable of names) {
      const candidate = path.join(dir, executable);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolves an interactive POSIX shell, preferring bash or zsh over Flatpak's bare /bin/sh
 * when a richer interactive shell exists on disk.
 */
export function resolvePreferredPosixShell(envShell?: string): string {
  const trimmed = envShell?.trim() || "";
  if (
    trimmed &&
    trimmed !== "/bin/sh" &&
    trimmed !== "/usr/bin/sh" &&
    isExecutableFile(trimmed)
  ) {
    return trimmed;
  }
  for (const candidate of ["/usr/bin/bash", "/bin/bash", "/usr/bin/zsh", "/bin/zsh"]) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  if (trimmed && isExecutableFile(trimmed)) {
    return trimmed;
  }
  return "/bin/sh";
}

/**
 * Normalizes Flatpak and desktop GUI environment overrides so Herdr CLI invocations,
 * daemon panes, and embedded terminals see user-installed binaries (~/.local/bin,
 * ~/.cargo/bin, ~/.bun/bin, ~/.opencode/bin, symlinked Node global bins, etc.), use a
 * real interactive shell instead of bare /bin/sh, and share the host ~/.config/herdr store.
 */
export function buildHostNormalizedEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrides: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...overrides,
  };

  if (process.platform === "win32") {
    // Windows environment keys are case insensitive. Emit one PATH key for Node.
    const pathKey = Object.keys(overrides).find(key => key.toUpperCase() === "PATH")
      ?? Object.keys(baseEnv).find(key => key.toUpperCase() === "PATH");
    const parts = (pathKey ? merged[pathKey] || "" : "").split(path.delimiter).filter(Boolean);
    const home = os.homedir();
    const candidates = [
      path.join(merged.APPDATA || path.join(home, "AppData", "Roaming"), "npm"),
      path.join(home, ".local", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".bun", "bin"),
      ...(merged.ProgramFiles ? [path.join(merged.ProgramFiles, "nodejs")] : []),
    ];
    for (const dir of candidates) {
      try {
        if (
          fs.statSync(dir).isDirectory() &&
          !parts.some(p => p.toLowerCase() === dir.toLowerCase())
        ) {
          parts.push(dir);
        }
      } catch {
        // Optional installation directory.
      }
    }
    for (const key of Object.keys(merged)) {
      if (key.toUpperCase() === "PATH") delete merged[key];
    }
    merged.PATH = parts.join(path.delimiter);
  }

  if (process.platform !== "win32") {
    const home = os.homedir();
    const candidateDirs = [
      path.join(home, ".local", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".opencode", "bin"),
      path.join(home, ".local", "share", "pnpm", "bin"),
      path.join(home, ".local", "share", "pnpm"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".deno", "bin"),
      path.join(home, "go", "bin"),
      path.join(home, "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/home/linuxbrew/.linuxbrew/bin",
    ];

    try {
      const localNode = path.join(home, ".local", "bin", "node");
      if (fs.existsSync(localNode)) {
        const realNodeDir = path.dirname(fs.realpathSync(localNode));
        if (realNodeDir && !candidateDirs.includes(realNodeDir)) {
          candidateDirs.splice(1, 0, realNodeDir);
        }
      }
    } catch {
      // Ignore symlink resolution errors
    }

    const extraBins = candidateDirs.filter((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });

    const currentPath = merged.PATH || "";
    const parts = currentPath.split(path.delimiter).filter(Boolean);
    for (const dir of extraBins.reverse()) {
      if (!parts.includes(dir)) {
        parts.unshift(dir);
      }
    }
    merged.PATH = parts.join(path.delimiter);

    if (!overrides.SHELL) {
      merged.SHELL = resolvePreferredPosixShell(baseEnv.SHELL);
    }

    if (
      fs.existsSync("/.flatpak-info") &&
      !merged.HERDR_CONFIG_PATH &&
      merged.XDG_CONFIG_HOME?.includes("/.var/app/")
    ) {
      const hostConfig = path.join(home, ".config");
      if (fs.existsSync(hostConfig)) {
        merged.XDG_CONFIG_HOME = hostConfig;
      }
    }
  }

  return merged;
}

export class HerdrCliClient {
  private configuredBinary: string;
  private customEnv: Record<string, string>;

  constructor(configuredBinary = "", customEnv: Record<string, string> = {}) {
    this.configuredBinary = configuredBinary;
    this.customEnv = customEnv;
  }

  setConfiguredBinary(nextPath: string): void {
    this.configuredBinary = nextPath;
  }

  setCustomEnv(nextEnv: Record<string, string>): void {
    this.customEnv = nextEnv;
  }

  getBinaryPath(): string | null {
    return resolveHerdrBinary(this.configuredBinary);
  }

  exec(
    args: string[],
    options: { cwd?: string; timeoutMs?: number; extraEnv?: Record<string, string> } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const bin = this.getBinaryPath();
    if (!bin) {
      return Promise.reject(
        new Error(
          "Herdr binary was not found. Install Herdr from https://herdr.dev or set its binary path in settings."
        )
      );
    }

    return new Promise((resolve) => {
      execFile(
        bin,
        args,
        {
          cwd: options.cwd || os.homedir(),
          timeout: options.timeoutMs ?? 8000,
          maxBuffer: 4 * 1024 * 1024,
          env: buildHostNormalizedEnv(process.env, {
            ...this.customEnv,
            ...(options.extraEnv || {}),
          }),
        },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
              ? Number((error as { code?: number }).code)
              : error
                ? 1
                : 0;
          resolve({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            exitCode: code,
          });
        }
      );
    });
  }

  async getStatus(sessionName?: string): Promise<HerdrStatusPayload | null> {
    const bin = this.getBinaryPath();
    if (!bin) {
      return null;
    }
    const args = sessionName
      ? ["--session", sessionName, "status", "--json"]
      : ["status", "--json"];
    const res = await this.exec(args, { timeoutMs: 4000 });
    const trimmed = res.stdout.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return JSON.parse(trimmed) as HerdrStatusPayload;
    } catch {
      return null;
    }
  }

  async listSessions(): Promise<HerdrNamedSession[]> {
    const bin = this.getBinaryPath();
    if (!bin) {
      return [];
    }
    const jsonRes = await this.exec(["session", "list", "--json"], { timeoutMs: 4000 });
    if (jsonRes.exitCode === 0 && jsonRes.stdout.trim()) {
      try {
        const parsed = JSON.parse(jsonRes.stdout.trim()) as {
          sessions?: Array<{
            name?: string;
            running?: boolean;
            status?: string;
            session_dir?: string;
            directory?: string;
            socket_path?: string;
            socket?: string;
          }>;
        };
        if (Array.isArray(parsed.sessions)) {
          return parsed.sessions
            .filter((s) => Boolean(s?.name))
            .map((s) => ({
              name: String(s.name),
              status:
                typeof s.running === "boolean"
                  ? s.running
                    ? "running"
                    : "stopped"
                  : String(s.status || "stopped"),
              directory: String(s.session_dir || s.directory || ""),
              socket: String(s.socket_path || s.socket || ""),
            }));
        }
      } catch {
        // Fall through to plain-text parsing on older CLI formats
      }
    }

    const res = await this.exec(["session", "list"], { timeoutMs: 4000 });
    if (res.exitCode !== 0 || !res.stdout.trim()) {
      return [];
    }
    const lines = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length <= 1) {
      return [];
    }
    const sessions: HerdrNamedSession[] = [];
    for (let i = 1; i < lines.length; i += 1) {
      const cols = lines[i].split(/\s+/).map((c) => c.trim());
      if (cols.length >= 4) {
        sessions.push({
          name: cols[0],
          status: cols[1],
          directory: cols[2],
          socket: cols.slice(3).join(" "),
        });
      }
    }
    return sessions;
  }

  async getIntegrationStatuses(): Promise<HerdrIntegrationRow[]> {
    const bin = this.getBinaryPath();
    if (!bin) {
      return [];
    }
    const res = await this.exec(["integration", "status"], { timeoutMs: 4000 });
    const rows: HerdrIntegrationRow[] = [];
    for (const rawLine of res.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const match = /^([A-Za-z0-9_-]+):\s+(installed|not installed)\s*(?:\((.+)\))?$/i.exec(line);
      if (match) {
        rows.push({
          target: match[1],
          installed: match[2].toLowerCase() === "installed",
          path: match[3] || "",
        });
      }
    }
    return rows;
  }

  /**
   * Starts a background headless Herdr server for a named session if it is not yet running,
   * injecting Vault Control Bridge environment variables so all spawned panes inherit them.
   */
  async ensureHeadlessServer(options: {
    sessionName?: string;
    cwd: string;
    bridgeEnv: Record<string, string>;
  }): Promise<HerdrStatusPayload | null> {
    const existing = await this.getStatus(options.sessionName);
    if (existing?.server?.running && existing.server.socket) {
      return existing;
    }

    const bin = this.getBinaryPath();
    if (!bin) {
      throw new Error("Herdr binary is not installed.");
    }

    const args = options.sessionName
      ? ["--session", options.sessionName, "server"]
      : ["server"];

    const child = spawn(bin, args, {
      cwd: options.cwd,
      detached: true,
      stdio: "ignore",
      env: buildHostNormalizedEnv(process.env, {
        ...this.customEnv,
        ...options.bridgeEnv,
      }),
    });
    child.unref();

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await new Promise((r) => window.setTimeout(r, 150));
      const status = await this.getStatus(options.sessionName);
      if (status?.server?.running && status.server.socket) {
        return status;
      }
    }
    return this.getStatus(options.sessionName);
  }

  async runPaneCommand(
    paneId: string,
    commandText: string,
    sessionName?: string
  ): Promise<void> {
    const args = sessionName
      ? ["--session", sessionName, "pane", "run", paneId, commandText]
      : ["pane", "run", paneId, commandText];
    const res = await this.exec(args, { timeoutMs: 6000 });
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `herdr pane run failed with exit ${res.exitCode}`);
    }
  }

  async stopNamedSession(sessionName: string): Promise<void> {
    const res = await this.exec(["session", "stop", sessionName], { timeoutMs: 6000 });
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `Failed to stop session '${sessionName}'.`);
    }
  }
}
