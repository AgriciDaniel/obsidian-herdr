import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Cross-platform helpers so the suite runs on the CI matrix (ubuntu, macos, windows).

export const IS_WINDOWS = process.platform === "win32";

/**
 * Python 3 command. actions/setup-python on windows-latest provides `python`, not `python3`.
 */
export const PYTHON = IS_WINDOWS ? "python" : "python3";

/**
 * Value for node:test's `skip` option on tests that need POSIX-only features (a real PTY,
 * `/bin/sh`, Unix socket files, symlinks without admin rights).
 */
export function skipOnWindows(reason: string): string | false {
  return IS_WINDOWS ? `POSIX only: ${reason}` : false;
}

/**
 * Creates a fresh temp dir under a short base. macOS os.tmpdir() is long
 * (/var/folders/xx/<30 chars>/T) and Unix socket paths are capped at 104 bytes there, so a
 * runtime kit socket such as <tmp>/runtime/oh-<12 hex>/b.sock fails with listen EINVAL.
 * Windows uses named pipes for sockets, so os.tmpdir() is fine there.
 */
export function makeShortTmpDir(prefix = "oh-"): string {
  const base = !IS_WINDOWS && fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
  return fs.mkdtempSync(path.join(base, prefix));
}

let pipeCounter = 0;

/**
 * A listenable socket path: `<dir>/<name>` on POSIX, a unique named pipe on Windows (which
 * cannot listen on a file path).
 */
export function testSocketPath(dir: string, name = "b.sock"): string {
  if (IS_WINDOWS) {
    pipeCounter += 1;
    return `\\\\.\\pipe\\obs-herdr-test-${process.pid}-${pipeCounter}`;
  }
  return path.join(dir, name);
}

/**
 * Command and leading args that run the provisioned obs-herdr CLI. On POSIX this is the real
 * generated wrapper script, so the wrapper itself stays covered. On Windows the wrapper is a
 * .cmd file, which Node refuses to execFile/spawn without a shell (EINVAL), so run the Node
 * core it would launch directly.
 */
export function cliInvocation(
  kit: { cliScriptPath: string; binDir: string },
  args: string[] = []
): [string, string[]] {
  if (IS_WINDOWS) {
    return [process.execPath, [path.join(kit.binDir, "obs-herdr-core.mjs"), ...args]];
  }
  return [kit.cliScriptPath, args];
}
