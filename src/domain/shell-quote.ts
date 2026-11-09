/**
 * Safe shell quoting helpers for pasting file paths or arguments into interactive shells.
 */
export function quotePosixShellArg(value: string): string {
  if (!value) {
    return "''";
  }
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function quotePowerShellArg(value: string): string {
  if (!value) {
    return "''";
  }
  if (/^[A-Za-z0-9_./:\\@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export function quoteShellPathForPlatform(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return quotePowerShellArg(value);
  }
  return quotePosixShellArg(value);
}

export function deriveVaultSessionSlug(vaultName: string): string {
  const cleaned = vaultName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return cleaned ? `vault-${cleaned}` : "vault-main";
}
