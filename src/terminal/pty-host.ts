import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Writable } from "node:stream";
import type { TerminalProfileKind } from "../domain/types";
import { buildHostNormalizedEnv, resolvePreferredPosixShell } from "../herdr/cli-client";
import PYTHON_PTY_BRIDGE from "./drivers/pty-bridge.py";
import WINDOWS_CONPTY_BRIDGE from "./drivers/conpty-bridge.cs";

export interface PtySpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  /** Optional override for tests: pass null to force the plain-pipe fallback on POSIX. */
  python3Path?: string | null;
  onData: (chunk: string) => void;
  onExit: (exitCode: number | null, signal: string | null) => void;
}

/** Returns true when a Herdr terminal profile cannot launch because the herdr binary is missing. */
export function shouldFallbackMissingHerdr(
  profileKind: TerminalProfileKind,
  binaryPath: string | null
): boolean {
  if (binaryPath) {
    return false;
  }
  return (
    profileKind === "herdr-vault" ||
    profileKind === "herdr-agent" ||
    profileKind === "herdr-remote"
  );
}

const WINDOWS_CONPTY_MIN_BUILD = 17763; // Windows 10 1809, the first release with CreatePseudoConsole

/** The largest terminal, in columns or rows, a resize asks for. */
export const MAX_TERMINAL_CELLS = 1000;

function cells(value: number, min: number): number {
  return Math.min(MAX_TERMINAL_CELLS, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));
}

function isRegularFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** A drive path (C:\...) or a UNC path (\\server\share\...): never relative to the current folder. */
function fullyQualifiedWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\/]/.test(p);
}

/**
 * The program a Windows terminal starts, as the absolute path of a .exe, or why it is refused.
 * A bare name is looked up only in fully qualified PATH folders, never in the current folder
 * (the vault, where a synced herdr.exe could have been planted) and never in a relative PATH
 * entry such as ".". A .cmd, .bat or .com file is refused: Windows runs those through cmd.exe,
 * which reads % ^ & | in the arguments its own way, and session names can come from links.
 */
export function resolveConPtyApplication(
  command: string,
  pathValue: string = buildHostNormalizedEnv(process.env).PATH || "",
  isFile: (p: string) => boolean = isRegularFile
): { ok: true; application: string } | { ok: false; reason: string } {
  const name = command.trim();
  const ext = path.win32.extname(name).toLowerCase();
  if (!name) {
    return { ok: false, reason: "No program was given." };
  }
  if (ext && ext !== ".exe") {
    return {
      ok: false,
      reason: `'${name}' is not a .exe program. On Windows the terminal starts only .exe programs, so a .cmd or .bat file never runs through cmd.exe.`,
    };
  }
  const file = ext ? name : `${name}.exe`;
  if (fullyQualifiedWindowsPath(name)) {
    return isFile(file) ? { ok: true, application: file } : { ok: false, reason: `'${file}' was not found.` };
  }
  if (/[\\/:]/.test(name)) {
    return { ok: false, reason: `'${name}' is not a full path. Give the full path, for example C:\\Tools\\herdr.exe.` };
  }
  for (const raw of pathValue.split(";")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !fullyQualifiedWindowsPath(dir)) {
      continue;
    }
    const candidate = path.win32.join(dir, file);
    if (isFile(candidate)) {
      return { ok: true, application: candidate };
    }
  }
  return { ok: false, reason: `'${file}' was not found in a folder on PATH. Give its full path in settings.` };
}

/** Quote one argument the way CommandLineToArgvW and the C runtime parse it back. */
export function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export function findWindowsPowerShell(): string | null {
  if (process.platform !== "win32") {
    return null;
  }
  const build = Number(os.release().split(".")[2]);
  if (!Number.isFinite(build) || build < WINDOWS_CONPTY_MIN_BUILD) {
    return null;
  }
  const candidate = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  return fs.existsSync(candidate) ? candidate : null;
}

function findPython3(): string | null {
  if (process.platform === "win32") {
    return null;
  }
  const pathDirs = (process.env.PATH || "")
    .split(path.delimiter)
    .filter((d) => Boolean(d) && path.isAbsolute(d));
  const candidates = [
    ...pathDirs.map((d) => path.join(d, "python3")),
    "/usr/bin/python3",
    "/usr/local/bin/python3",
    "/opt/homebrew/bin/python3",
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Continue scanning
    }
  }
  return null;
}

export function resolveDefaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  return resolvePreferredPosixShell(process.env.SHELL);
}

export class PtySession {
  private proc: ChildProcess | null = null;
  private ctrlStream: Writable | null = null;
  private disposed = false;
  private cols: number;
  private rows: number;
  private readonly decoder = new TextDecoder("utf-8");
  private readonly stderrDecoder = new TextDecoder("utf-8");
  private killTimer: number | null = null;

  constructor(options: PtySpawnOptions) {
    this.cols = cells(options.cols || 80, 20);
    this.rows = cells(options.rows || 24, 5);
    this.start(options);
  }

  private start(options: PtySpawnOptions): void {
    let safeCwd = os.homedir();
    try {
      if (options.cwd && fs.statSync(options.cwd).isDirectory()) {
        safeCwd = options.cwd;
      }
    } catch {
      // Fall back to home directory
    }
    const mergedEnv: NodeJS.ProcessEnv = buildHostNormalizedEnv(process.env, {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: process.env.LANG || "en_US.UTF-8",
      ...(options.env || {}),
    });

    const py3 = options.python3Path === undefined ? findPython3() : options.python3Path;
    const powershell = findWindowsPowerShell();
    if (py3 && process.platform !== "win32") {
      this.proc = spawn(
        py3,
        [
          "-u",
          "-c",
          PYTHON_PTY_BRIDGE,
          String(this.cols),
          String(this.rows),
          options.command,
          ...options.args,
        ],
        {
          cwd: safeCwd,
          env: mergedEnv,
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        }
      );
      const fd3 = this.proc.stdio[3];
      if (fd3 && "write" in fd3 && typeof fd3.write === "function") {
        this.ctrlStream = fd3;
      }
    } else if (powershell) {
      const resolved = resolveConPtyApplication(options.command, mergedEnv.PATH || "");
      if (!resolved.ok) {
        this.refuseStart(options, resolved.reason);
        return;
      }
      const bootstrap =
        "$ErrorActionPreference='Stop';$s=$env:HERDR_OBS_CONPTY_SOURCE;$a=$env:HERDR_OBS_CONPTY_APP;$c=$env:HERDR_OBS_CONPTY_COMMAND;" +
        "Remove-Item Env:HERDR_OBS_CONPTY_SOURCE,Env:HERDR_OBS_CONPTY_APP,Env:HERDR_OBS_CONPTY_COMMAND;" +
        `try{Add-Type -TypeDefinition $s;exit [HerdrObsConPty]::Run(${this.cols},${this.rows},$a,$c)}` +
        "catch{[Console]::Error.WriteLine('[ConPTY bridge error: '+$_.Exception.Message+']');exit 1}";
      this.proc = spawn(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", bootstrap],
        {
          cwd: safeCwd,
          env: {
            ...mergedEnv,
            HERDR_OBS_CONPTY_SOURCE: WINDOWS_CONPTY_BRIDGE,
            HERDR_OBS_CONPTY_APP: resolved.application,
            HERDR_OBS_CONPTY_COMMAND: [resolved.application, ...options.args].map(quoteWindowsArg).join(" "),
          },
          stdio: ["pipe", "pipe", "pipe", "pipe"],
          windowsHide: true,
        }
      );
      const fd3 = this.proc.stdio[3];
      if (fd3 && "write" in fd3 && typeof fd3.write === "function") {
        this.ctrlStream = fd3;
      }
    } else {
      let command = options.command;
      if (process.platform === "win32") {
        const resolved = resolveConPtyApplication(options.command, mergedEnv.PATH || "");
        if (!resolved.ok) {
          this.refuseStart(options, resolved.reason);
          return;
        }
        command = resolved.application;
      }
      if (process.platform !== "win32") {
        options.onData(
          "\r\n\x1b[33m[Warning: python3 not found; falling back to plain pipes without a PTY. Full-screen apps such as Herdr will not work.]\x1b[0m\r\n"
        );
      }
      this.proc = spawn(command, options.args, {
        cwd: safeCwd,
        env: mergedEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      if (this.disposed) {
        return;
      }
      const text = this.decoder.decode(chunk, { stream: true });
      if (text) {
        options.onData(text);
      }
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      if (this.disposed) {
        return;
      }
      const text = this.stderrDecoder.decode(chunk, { stream: true });
      if (text) {
        options.onData(text);
      }
    });

    this.proc.on("close", (code, signal) => {
      if (this.killTimer !== null) {
        window.clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      if (!this.disposed) {
        const tailOut = this.decoder.decode();
        if (tailOut) {
          options.onData(tailOut);
        }
        const tailErr = this.stderrDecoder.decode();
        if (tailErr) {
          options.onData(tailErr);
        }
        options.onExit(code, signal);
      }
    });

    this.proc.on("error", (err) => {
      if (this.killTimer !== null) {
        window.clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      if (!this.disposed) {
        options.onData(`\r\n[PTY error: ${err.message}]\r\n`);
        options.onExit(1, null);
      }
    });
  }

  /** Pause reading stdout/stderr from the child PTY to apply backpressure to xterm.js. */
  pause(): void {
    this.proc?.stdout?.pause();
    this.proc?.stderr?.pause();
  }

  /** Resume reading stdout/stderr from the child PTY after xterm.js drains. */
  resume(): void {
    if (this.disposed) {
      return;
    }
    this.proc?.stdout?.resume();
    this.proc?.stderr?.resume();
  }

  /** Tells the terminal why nothing was started, after the constructor returned. */
  private refuseStart(options: PtySpawnOptions, reason: string): void {
    window.setTimeout(() => {
      if (!this.disposed) {
        options.onData(`\r\n[Could not start the terminal: ${reason}]\r\n`);
        options.onExit(1, null);
      }
    }, 0);
  }

  write(data: string): void {
    if (this.disposed || !this.proc?.stdin || this.proc.stdin.destroyed) {
      return;
    }
    this.proc.stdin.write(data, "utf8");
  }

  /** Accept captured user bytes without focusing xterm or silently targeting a closed input. */
  tryWrite(data: string): boolean {
    const input = this.proc?.stdin;
    if (!data || !this.isRunning() || !input || input.destroyed || input.writableEnded || !input.writable) {
      return false;
    }
    try {
      input.write(data, "utf8");
      // A false stream.write return indicates backpressure; the bytes were still accepted.
      return true;
    } catch {
      return false;
    }
  }

  resize(cols: number, rows: number): void {
    const nextCols = cells(cols, 10);
    const nextRows = cells(rows, 3);
    if (nextCols === this.cols && nextRows === this.rows) {
      return;
    }
    this.cols = nextCols;
    this.rows = nextRows;

    if (this.disposed || !this.ctrlStream || this.ctrlStream.destroyed) {
      return;
    }
    try {
      this.ctrlStream.write(
        JSON.stringify({ type: "resize", cols: nextCols, rows: nextRows }) + "\n",
        "utf8"
      );
    } catch {
      // Ignore closed control stream
    }
  }

  isRunning(): boolean {
    return Boolean(this.proc && this.proc.exitCode === null && !this.disposed);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      this.ctrlStream?.end();
    } catch {
      // Ignore
    }
    if (this.proc) {
      const child = this.proc;
      this.proc = null;
      try {
        child.stdin?.end();
      } catch {
        // Ignore
      }
      if (child.exitCode === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore
        }
        this.killTimer = window.setTimeout(() => {
          this.killTimer = null;
          if (child.exitCode === null) {
            try {
              child.kill("SIGKILL");
            } catch {
              // Ignore
            }
          }
        }, 1500);
        child.once("exit", () => {
          if (this.killTimer !== null) {
            window.clearTimeout(this.killTimer);
            this.killTimer = null;
          }
        });
      }
    }
  }
}

/** Deliver to the original xterm input's current session, without changing DOM focus. */
export function deliverToTerminal(
  element: Element,
  data: string,
  leaves: Iterable<{ view: unknown }>
): boolean {
  if (!data || !element.isConnected || !element.matches(".xterm-helper-textarea")) return false;
  const host = element.closest(".herdr-terminal-host");
  if (!host) return false;
  for (const leaf of leaves) {
    // HerdrTerminalView owns this runtime session; sendTextToPty also focuses its view.
    const view = leaf.view as {
      getViewType?: () => string;
      contentEl?: HTMLElement;
      pty?: unknown;
    } | null;
    if (view?.getViewType?.() !== "herdr-terminal-view" ||
      view.contentEl?.ownerDocument !== element.ownerDocument ||
      !view.contentEl.contains(element) || !view.contentEl.contains(host)) continue;
    return view.pty instanceof PtySession ? view.pty.tryWrite(data) : false;
  }
  return false;
}
