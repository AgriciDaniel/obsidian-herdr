import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { buildHostNormalizedEnv, resolvePreferredPosixShell } from "../herdr/cli-client";

export interface PtySpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  onData: (chunk: string) => void;
  onExit: (exitCode: number | null, signal: string | null) => void;
}

/**
 * Clean-room POSIX Python 3 pty driver.
 * fd 0: raw stdin -> PTY master
 * fd 1: PTY master -> raw stdout
 * fd 2: driver errors
 * fd 3: NDJSON resize control channel ({"type":"resize","cols":120,"rows":36})
 */
const PYTHON_PTY_BRIDGE = [
  "import errno, fcntl, json, os, pty, select, signal, struct, sys, termios",
  "cols = max(20, int(sys.argv[1]))",
  "rows = max(5, int(sys.argv[2]))",
  "cmd = sys.argv[3:]",
  "master_fd, slave_fd = pty.openpty()",
  "def apply_winsz(fd, r, c):",
  "    try:",
  "        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))",
  "    except OSError:",
  "        pass",
  "apply_winsz(master_fd, rows, cols)",
  "apply_winsz(slave_fd, rows, cols)",
  "pid = os.fork()",
  "if pid == 0:",
  "    os.setsid()",
  "    os.close(master_fd)",
  "    try:",
  "        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)",
  "    except OSError:",
  "        pass",
  "    os.dup2(slave_fd, 0)",
  "    os.dup2(slave_fd, 1)",
  "    os.dup2(slave_fd, 2)",
  "    if slave_fd > 2:",
  "        os.close(slave_fd)",
  "    try:",
  "        os.close(3)",
  "    except OSError:",
  "        pass",
  "    os.execvp(cmd[0], cmd)",
  "os.close(slave_fd)",
  "ctrl_open = True",
  "try:",
  "    os.fstat(3)",
  "except OSError:",
  "    ctrl_open = False",
  "ctrl_buf = b''",
  "stdin_open = True",
  "def handle_term(signum, _frame):",
  "    try:",
  "        os.killpg(pid, signal.SIGHUP)",
  "    except OSError:",
  "        pass",
  "signal.signal(signal.SIGTERM, handle_term)",
  "signal.signal(signal.SIGHUP, handle_term)",
  "while True:",
  "    watch = [master_fd]",
  "    if stdin_open:",
  "        watch.append(0)",
  "    if ctrl_open:",
  "        watch.append(3)",
  "    try:",
  "        rlist, _, _ = select.select(watch, [], [], 0.25)",
  "    except InterruptedError:",
  "        continue",
  "    except OSError:",
  "        break",
  "    if master_fd in rlist:",
  "        try:",
  "            data = os.read(master_fd, 32768)",
  "            if not data:",
  "                break",
  "            os.write(1, data)",
  "        except OSError as exc:",
  "            if exc.errno in (errno.EIO, errno.EBADF):",
  "                break",
  "            raise",
  "    if stdin_open and 0 in rlist:",
  "        try:",
  "            inp = os.read(0, 16384)",
  "            if not inp:",
  "                stdin_open = False",
  "            else:",
  "                os.write(master_fd, inp)",
  "        except OSError:",
  "            stdin_open = False",
  "    if ctrl_open and 3 in rlist:",
  "        try:",
  "            chunk = os.read(3, 4096)",
  "            if not chunk:",
  "                ctrl_open = False",
  "            else:",
  "                ctrl_buf += chunk",
  "                while b'\\n' in ctrl_buf:",
  "                    line, ctrl_buf = ctrl_buf.split(b'\\n', 1)",
  "                    if not line.strip():",
  "                        continue",
  "                    msg = json.loads(line.decode('utf-8', 'replace'))",
  "                    if msg.get('type') == 'resize':",
  "                        nc = max(10, int(msg.get('cols', cols)))",
  "                        nr = max(3, int(msg.get('rows', rows)))",
  "                        apply_winsz(master_fd, nr, nc)",
  "                        try:",
  "                            os.killpg(pid, signal.SIGWINCH)",
  "                        except OSError:",
  "                            pass",
  "        except Exception:",
  "            ctrl_open = False",
  "    done_pid, status = os.waitpid(pid, os.WNOHANG)",
  "    if done_pid == pid:",
  "        while True:",
  "            try:",
  "                rem, _, _ = select.select([master_fd], [], [], 0.02)",
  "                if not rem:",
  "                    break",
  "                tail = os.read(master_fd, 32768)",
  "                if not tail:",
  "                    break",
  "                os.write(1, tail)",
  "            except OSError:",
  "                break",
  "        os.close(master_fd)",
  "        sys.exit(os.waitstatus_to_exitcode(status))",
  "try:",
  "    os.close(master_fd)",
  "except OSError:",
  "    pass",
  "_, status = os.waitpid(pid, 0)",
  "sys.exit(os.waitstatus_to_exitcode(status))",
].join("\n");

function findPython3(): string | null {
  if (process.platform === "win32") {
    return null;
  }
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
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

  constructor(options: PtySpawnOptions) {
    this.cols = Math.max(20, Math.round(options.cols || 80));
    this.rows = Math.max(5, Math.round(options.rows || 24));
    this.start(options);
  }

  private start(options: PtySpawnOptions): void {
    const safeCwd = fs.existsSync(options.cwd) ? options.cwd : os.homedir();
    const mergedEnv: NodeJS.ProcessEnv = buildHostNormalizedEnv(process.env, {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: process.env.LANG || "en_US.UTF-8",
      ...(options.env || {}),
    });

    const py3 = findPython3();
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
    } else {
      // Cross-platform fallback when Python 3 is unavailable
      this.proc = spawn(options.command, options.args, {
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
      const text = chunk.toString("utf8");
      if (text) {
        options.onData(text);
      }
    });

    this.proc.on("exit", (code, signal) => {
      if (!this.disposed) {
        options.onExit(code, signal);
      }
    });

    this.proc.on("error", (err) => {
      if (!this.disposed) {
        options.onData(`\r\n[PTY error: ${err.message}]\r\n`);
        options.onExit(1, null);
      }
    });
  }

  write(data: string): void {
    if (this.disposed || !this.proc?.stdin || this.proc.stdin.destroyed) {
      return;
    }
    this.proc.stdin.write(data, "utf8");
  }

  resize(cols: number, rows: number): void {
    const nextCols = Math.max(10, Math.round(cols));
    const nextRows = Math.max(3, Math.round(rows));
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
      }
    }
  }
}
