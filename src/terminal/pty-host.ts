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

/**
 * Windows pseudoconsole (ConPTY) driver, the counterpart of the Python driver above.
 * Without it the child gets plain pipes, so a full-screen program such as Herdr draws
 * its screen but never receives a keystroke, a mouse click or a resize.
 * fd 0: raw stdin -> pseudoconsole input
 * fd 1: pseudoconsole output -> raw stdout
 * fd 3: NDJSON resize control channel ({"type":"resize","cols":120,"rows":36})
 *
 * It runs inside Windows PowerShell (shipped with every supported Windows), which compiles it
 * with Add-Type, so the plugin needs no native module. Keep it to C# 5 syntax: that is the
 * compiler Windows PowerShell 5.1 has.
 */
const WINDOWS_CONPTY_BRIDGE = String.raw`
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class HerdrObsConPty
{
    [StructLayout(LayoutKind.Sequential)]
    struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFO
    {
        public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
        public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr readEnd, out IntPtr writeEnd, IntPtr attributes, int size);
    [DllImport("kernel32.dll")]
    static extern int CreatePseudoConsole(COORD size, IntPtr input, IntPtr output, uint flags, out IntPtr console);
    [DllImport("kernel32.dll")]
    static extern int ResizePseudoConsole(IntPtr console, COORD size);
    [DllImport("kernel32.dll")]
    static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInfo);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern void GetStartupInfoW(out STARTUPINFO startupInfo);

    static COORD Size(int cols, int rows)
    {
        COORD size;
        size.X = (short)Math.Max(10, Math.Min(cols, 9999));
        size.Y = (short)Math.Max(3, Math.Min(rows, 9999));
        return size;
    }

    // Node hands extra stdio pipes to a Windows child in the C runtime block of STARTUPINFO:
    // an int count, then one flag byte per fd, then one handle per fd.
    static IntPtr InheritedHandle(int fd)
    {
        STARTUPINFO info;
        GetStartupInfoW(out info);
        if (info.lpReserved2 == IntPtr.Zero || info.cbReserved2 < 4) return IntPtr.Zero;
        int count = Marshal.ReadInt32(info.lpReserved2);
        if (fd >= count || info.cbReserved2 < 4 + count * (1 + IntPtr.Size)) return IntPtr.Zero;
        IntPtr handle = Marshal.ReadIntPtr(info.lpReserved2, 4 + count + fd * IntPtr.Size);
        return (handle == IntPtr.Zero || handle == new IntPtr(-1)) ? IntPtr.Zero : handle;
    }

    static void Pump(Stream from, Stream to)
    {
        byte[] buffer = new byte[32768];
        try
        {
            int read;
            while ((read = from.Read(buffer, 0, buffer.Length)) > 0)
            {
                to.Write(buffer, 0, read);
                to.Flush();
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        catch (UnauthorizedAccessException) { }
    }

    static Thread Background(ThreadStart work)
    {
        Thread thread = new Thread(work);
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    public static int Run(int cols, int rows, string commandLine)
    {
        IntPtr inputRead, inputWrite, outputRead, outputWrite;
        if (!CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0) || !CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0))
            throw new InvalidOperationException("CreatePipe failed: " + Marshal.GetLastWin32Error());

        IntPtr console;
        int result = CreatePseudoConsole(Size(cols, rows), inputRead, outputWrite, 0, out console);
        if (result != 0) throw new InvalidOperationException("CreatePseudoConsole failed: 0x" + result.ToString("X8"));
        CloseHandle(inputRead);
        CloseHandle(outputWrite);

        IntPtr listSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref listSize);
        STARTUPINFOEX startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        // STARTF_USESTDHANDLES with empty handles: otherwise the child inherits this
        // process's redirected pipes instead of the pseudoconsole.
        startup.StartupInfo.dwFlags = 0x00000100;
        startup.lpAttributeList = Marshal.AllocHGlobal(listSize);
        // 0x00020016 is PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE.
        if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, ref listSize) ||
            !UpdateProcThreadAttribute(startup.lpAttributeList, 0, new IntPtr(0x00020016), console, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
            throw new InvalidOperationException("Pseudoconsole attribute failed: " + Marshal.GetLastWin32Error());

        PROCESS_INFORMATION process;
        // 0x00080000 is EXTENDED_STARTUPINFO_PRESENT.
        if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, 0x00080000, IntPtr.Zero, null, ref startup, out process))
            throw new InvalidOperationException("Could not start '" + commandLine + "': Windows error " + Marshal.GetLastWin32Error());
        CloseHandle(process.hThread);

        Stream consoleInput = new FileStream(new SafeFileHandle(inputWrite, true), FileAccess.Write, 1, false);
        Stream consoleOutput = new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read, 1, false);
        Stream hostInput = Console.OpenStandardInput();
        Stream hostOutput = Console.OpenStandardOutput();
        ManualResetEvent hostGone = new ManualResetEvent(false);

        Thread outputThread = Background(delegate { Pump(consoleOutput, hostOutput); });
        Background(delegate { Pump(hostInput, consoleInput); hostGone.Set(); });

        IntPtr control = InheritedHandle(3);
        if (control != IntPtr.Zero)
        {
            Background(delegate
            {
                try
                {
                    StreamReader reader = new StreamReader(new FileStream(new SafeFileHandle(control, false), FileAccess.Read, 1, false), Encoding.UTF8);
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        Match c = Regex.Match(line, "\"cols\"\\s*:\\s*(\\d+)");
                        Match r = Regex.Match(line, "\"rows\"\\s*:\\s*(\\d+)");
                        if (line.Contains("\"resize\"") && c.Success && r.Success)
                            ResizePseudoConsole(console, Size(int.Parse(c.Groups[1].Value), int.Parse(r.Groups[1].Value)));
                    }
                }
                catch (Exception) { }
            });
        }

        // 0x102 is WAIT_TIMEOUT. Stop when the child exits or the plugin closes our stdin.
        while (WaitForSingleObject(process.hProcess, 100) == 0x102)
        {
            if (hostGone.WaitOne(0)) break;
        }
        uint exitCode;
        if (!GetExitCodeProcess(process.hProcess, out exitCode) || exitCode == 259) exitCode = 1;
        // Closing the pseudoconsole ends anything still attached and flushes the last output.
        ClosePseudoConsole(console);
        outputThread.Join(2000);
        CloseHandle(process.hProcess);
        return (int)exitCode;
    }
}
`;

const WINDOWS_CONPTY_MIN_BUILD = 17763; // Windows 10 1809, the first release with CreatePseudoConsole

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
      // The driver source and the child command line travel in environment variables: no temp
      // file to clean up, and an inline -Command is not subject to the script execution policy.
      // shortcut: Add-Type compiles the driver on every start (about a second), cache the
      // assembly with -OutputAssembly when terminal start-up time matters.
      // A machine that blocks Add-Type (Constrained Language Mode) shows the bridge error and
      // the terminal ends; it does not fall back to plain pipes.
      const bootstrap =
        "$ErrorActionPreference='Stop';$s=$env:HERDR_OBS_CONPTY_SOURCE;$c=$env:HERDR_OBS_CONPTY_COMMAND;" +
        "Remove-Item Env:HERDR_OBS_CONPTY_SOURCE,Env:HERDR_OBS_CONPTY_COMMAND;" +
        `try{Add-Type -TypeDefinition $s;exit [HerdrObsConPty]::Run(${this.cols},${this.rows},$c)}` +
        "catch{[Console]::Error.WriteLine('[ConPTY bridge error: '+$_.Exception.Message+']');exit 1}";
      this.proc = spawn(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", bootstrap],
        {
          cwd: safeCwd,
          env: {
            ...mergedEnv,
            HERDR_OBS_CONPTY_SOURCE: WINDOWS_CONPTY_BRIDGE,
            HERDR_OBS_CONPTY_COMMAND: [options.command, ...options.args].map(quoteWindowsArg).join(" "),
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
      // Last resort when neither driver is available: plain pipes, no keyboard for full-screen programs
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
