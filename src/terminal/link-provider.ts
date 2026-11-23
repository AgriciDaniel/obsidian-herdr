import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { type App, Notice, TFile } from "obsidian";
import { resolveTerminalPathInsideVault } from "../domain/path-guard";
import { confirmAction } from "../ui/modals";

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]+)?\]\]/g;
const OBSIDIAN_URI_RE = /\bobsidian:\/\/[^\s"'<>)\]]+/g;
const FILE_CANDIDATE_RE =
  /(?:[A-Za-z0-9_./-]+\.(?:md|canvas|base|txt|json|ts|py|toml|yaml|yml))(?::\d+(?::\d+)?)?/g;

export type ParsedObsidianUri =
  | { kind: "open-file"; file: string; cleanedUri: string }
  | { kind: "external"; cleanedUri: string };

export function parseObsidianUriTarget(rawUri: string): ParsedObsidianUri | null {
  const cleanedUri = rawUri.trim().replace(/[.,;]+$/, "");
  if (!cleanedUri.startsWith("obsidian://")) {
    return null;
  }
  try {
    const parsed = new URL(cleanedUri);
    const action = parsed.hostname || parsed.pathname.replace(/^\/+/, "");
    if (action === "open") {
      const fileParam = parsed.searchParams.get("file");
      if (fileParam && fileParam.trim()) {
        return {
          kind: "open-file",
          file: fileParam.trim(),
          cleanedUri,
        };
      }
    }
    return { kind: "external", cleanedUri };
  } catch {
    return null;
  }
}

export class VaultTerminalLinkProvider implements ILinkProvider {
  private readonly app: App;
  private readonly terminal: Terminal;
  private readonly getVaultRoot: () => string | null;
  private readonly getCurrentCwd: () => string | null;

  constructor(options: {
    app: App;
    terminal: Terminal;
    getVaultRoot: () => string | null;
    getCurrentCwd: () => string | null;
  }) {
    this.app = options.app;
    this.terminal = options.terminal;
    this.getVaultRoot = options.getVaultRoot;
    this.getCurrentCwd = options.getCurrentCwd;
  }

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const line: IBufferLine | undefined =
      this.terminal.buffer.active.getLine(bufferLineNumber - 1);
    if (!line) {
      callback(undefined);
      return;
    }

    const text = line.translateToString(true);
    if (!text.trim()) {
      callback(undefined);
      return;
    }

    const links: ILink[] = [];
    const occupied: Array<[number, number]> = [];
    const overlaps = (start: number, end: number): boolean =>
      occupied.some(([s, e]) => start <= e && end >= s);
    const addLink = (startCol: number, endCol: number, linkText: string, activate: () => void) => {
      if (overlaps(startCol, endCol)) {
        return;
      }
      occupied.push([startCol, endCol]);
      links.push({
        text: linkText,
        range: {
          start: { x: startCol, y: bufferLineNumber },
          end: { x: endCol, y: bufferLineNumber },
        },
        activate,
      });
    };

    WIKILINK_RE.lastIndex = 0;
    let wikiMatch = WIKILINK_RE.exec(text);
    while (wikiMatch !== null) {
      const fullText = wikiMatch[0];
      const noteTarget = wikiMatch[1].trim();
      const heading = wikiMatch[2]?.trim();
      const resolvedFile =
        noteTarget && !/^\s*-/.test(noteTarget)
          ? this.app.metadataCache.getFirstLinkpathDest(noteTarget, "")
          : null;
      if (resolvedFile instanceof TFile) {
        const startCol = wikiMatch.index + 1;
        const endCol = wikiMatch.index + fullText.length;
        const linkStr = heading ? `${noteTarget}#${heading}` : noteTarget;
        addLink(startCol, endCol, fullText, () => {
          void this.app.workspace.openLinkText(linkStr, "", true);
        });
      }
      wikiMatch = WIKILINK_RE.exec(text);
    }

    OBSIDIAN_URI_RE.lastIndex = 0;
    let uriMatch = OBSIDIAN_URI_RE.exec(text);
    while (uriMatch !== null) {
      const parsedUri = parseObsidianUriTarget(uriMatch[0]);
      if (parsedUri) {
        const startCol = uriMatch.index + 1;
        const endCol = uriMatch.index + parsedUri.cleanedUri.length;
        addLink(startCol, endCol, parsedUri.cleanedUri, () => {
          if (parsedUri.kind === "open-file") {
            const currentVault = this.app.vault.getName();
            let targetVault: string | null = null;
            try {
              targetVault = new URL(parsedUri.cleanedUri).searchParams.get("vault")?.trim() || null;
            } catch {
              targetVault = null;
            }
            if (targetVault && targetVault !== currentVault) {
              void confirmAction(this.app, {
                title: "Open URI in another vault?",
                body: `Open '${parsedUri.cleanedUri}' (targets vault '${targetVault}')?`,
                confirmText: "Open URI",
              }).then((ok) => {
                if (ok) {
                  window.open(parsedUri.cleanedUri);
                }
              });
              return;
            }
            const resolved = this.app.metadataCache.getFirstLinkpathDest(parsedUri.file, "");
            if (resolved instanceof TFile) {
              void this.openVaultFileAtLine(resolved);
            } else {
              new Notice(`Note '${parsedUri.file}' was not found in this vault.`);
            }
          } else {
            void confirmAction(this.app, {
              title: "Open Obsidian URI from terminal?",
              body: `Terminal output linked to:\n\n${parsedUri.cleanedUri}`,
              confirmText: "Open URI",
              danger: true,
            }).then((ok) => {
              if (ok) {
                window.open(parsedUri.cleanedUri);
              }
            });
          }
        });
      }
      uriMatch = OBSIDIAN_URI_RE.exec(text);
    }

    const vaultRoot = this.getVaultRoot();
    if (vaultRoot) {
      FILE_CANDIDATE_RE.lastIndex = 0;
      let pathMatch = FILE_CANDIDATE_RE.exec(text);
      while (pathMatch !== null) {
        const candidate = pathMatch[0];
        const resolved = resolveTerminalPathInsideVault(
          candidate,
          vaultRoot,
          this.getCurrentCwd(),
          this.app.vault.configDir
        );
        if (resolved) {
          const abstractFile = this.app.vault.getAbstractFileByPath(resolved.vaultRelPath);
          if (abstractFile instanceof TFile) {
            const startCol = pathMatch.index + 1;
            const endCol = pathMatch.index + candidate.length;
            const lineZero = resolved.line ? Math.max(0, resolved.line - 1) : undefined;
            addLink(startCol, endCol, candidate, () => {
              void this.openVaultFileAtLine(abstractFile, lineZero);
            });
          }
        }
        pathMatch = FILE_CANDIDATE_RE.exec(text);
      }
    }

    callback(links.length > 0 ? links : undefined);
  }

  private async openVaultFileAtLine(file: TFile, lineZero?: number): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(
      file,
      lineZero !== undefined ? { eState: { line: lineZero } } : undefined
    );
  }
}
