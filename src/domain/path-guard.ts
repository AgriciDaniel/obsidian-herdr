import * as fs from "node:fs";
import * as path from "node:path";

export class VaultPathGuardError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VaultPathGuardError";
    this.code = code;
  }
}

export interface PathGuardOptions {
  configDirName?: string;
  allowHiddenRead?: boolean;
  isWrite?: boolean;
}

/**
 * Normalizes and validates a vault-relative path, blocking traversal, NUL bytes,
 * absolute paths, and writes into Obsidian configuration or secret directories.
 */
export function guardVaultRelativePath(
  rawInput: string,
  options: PathGuardOptions = {}
): string {
  if (typeof rawInput !== "string") {
    throw new VaultPathGuardError("invalid_path", "Vault path must be a string.");
  }
  if (rawInput.includes("\0")) {
    throw new VaultPathGuardError("invalid_path", "Vault path must not contain NUL bytes.");
  }

  const trimmed = rawInput.trim().replace(/\\/g, "/");
  if (!trimmed) {
    throw new VaultPathGuardError("invalid_path", "Vault path must not be empty.");
  }
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    throw new VaultPathGuardError(
      "absolute_path_forbidden",
      "Use a vault-relative path rather than an absolute or drive-prefixed filesystem path."
    );
  }

  const segments = trimmed.split("/").filter((seg) => seg.length > 0 && seg !== ".");
  if (segments.length === 0) {
    throw new VaultPathGuardError("invalid_path", "Vault path resolves to vault root.");
  }
  for (const seg of segments) {
    if (seg === "..") {
      throw new VaultPathGuardError(
        "path_traversal_forbidden",
        "Parent directory traversal ('..') is forbidden."
      );
    }
  }

  const normalized = segments.join("/");
  const configDir = options.configDirName
    ? options.configDirName.replace(/^\/+|\/+$/g, "")
    : "";

  for (const seg of segments) {
    if (seg === ".git") {
      throw new VaultPathGuardError(
        "protected_directory",
        "Access to protected directory '.git' is blocked by Vault Control Bridge policy."
      );
    }
    if ((configDir && seg === configDir) || seg.startsWith(".")) {
      if (options.isWrite || !options.allowHiddenRead) {
        throw new VaultPathGuardError(
          "protected_directory",
          `Access to protected directory '${seg}' is blocked by Vault Control Bridge policy.`
        );
      }
    }
  }

  if (segments.some((seg) => seg === ".env" || seg.startsWith(".env."))) {
    throw new VaultPathGuardError(
      "protected_secret_file",
      "Access to environment secret files is blocked."
    );
  }

  return normalized;
}

/**
 * Verifies that no existing path component inside vaultRoot is a symlink pointing
 * outside vaultRoot (blocks symlink escapes on both reads and writes).
 */
export function assertNoSymlinkEscape(vaultRoot: string, vaultRelPath: string): void {
  if (!vaultRoot || !vaultRelPath) {
    return;
  }
  let realVaultRoot: string;
  try {
    realVaultRoot = fs.realpathSync(vaultRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      // Allow unit tests using synthetic non-existent vault paths without failing reads.
      return;
    }
    throw new VaultPathGuardError(
      "symlink_escape_forbidden",
      `Could not verify vault root boundary for '${vaultRelPath}'.`
    );
  }

  const parts = vaultRelPath.replace(/\\/g, "/").split("/").filter(Boolean);
  let cursor = realVaultRoot;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cursor);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        // Non-existent suffix (e.g. file/folder about to be created) cannot be a symlink.
        break;
      }
      throw new VaultPathGuardError(
        "symlink_escape_forbidden",
        `Could not inspect path component inside vault path '${vaultRelPath}'.`
      );
    }
    if (st.isSymbolicLink()) {
      let targetReal: string;
      try {
        targetReal = fs.realpathSync(cursor);
      } catch {
        throw new VaultPathGuardError(
          "symlink_escape_forbidden",
          `Refused broken or unreadable symlink inside vault path '${vaultRelPath}'.`
        );
      }
      const rel = path.relative(realVaultRoot, targetReal);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new VaultPathGuardError(
          "symlink_escape_forbidden",
          `Refused symlink escaping vault boundary at '${vaultRelPath}'.`
        );
      }
      cursor = targetReal;
    }
  }
}

/**
 * Resolves a candidate path found in terminal output (relative to cwd or vault root)
 * into a safe vault-relative path if and only if it resides strictly inside vaultRoot.
 */
export function resolveTerminalPathInsideVault(
  candidatePath: string,
  vaultRoot: string,
  currentCwd?: string | null,
  configDirName?: string
): { vaultRelPath: string; line?: number; column?: number } | null {
  const cleaned = candidatePath.trim();
  if (!cleaned || cleaned.includes("\0")) {
    return null;
  }

  let filePart = cleaned;
  let line: number | undefined;
  let column: number | undefined;

  const lineColMatch = /^(.+?):(\d+)(?::(\d+))?$/.exec(cleaned);
  if (lineColMatch) {
    filePart = lineColMatch[1];
    line = Number(lineColMatch[2]);
    if (lineColMatch[3]) {
      column = Number(lineColMatch[3]);
    }
  }

  const normalizedVault = path.resolve(vaultRoot);
  const baseDir = currentCwd ? path.resolve(currentCwd) : normalizedVault;
  const resolved = path.isAbsolute(filePart)
    ? path.resolve(filePart)
    : path.resolve(baseDir, filePart);

  const rel = path.relative(normalizedVault, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }

  const posixRel = rel.split(path.sep).join("/");
  const cfgDir = configDirName ? configDirName.replace(/^\/+|\/+$/g, "") : "";
  const segs = posixRel.split("/").filter(Boolean);
  if (segs.some((seg) => (cfgDir && seg === cfgDir) || seg.startsWith("."))) {
    return null;
  }
  try {
    assertNoSymlinkEscape(normalizedVault, posixRel);
  } catch {
    return null;
  }

  return { vaultRelPath: posixRel, line, column };
}
