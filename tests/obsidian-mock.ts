import * as fs from "node:fs";
import * as path from "node:path";

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

export class FileSystemAdapter {
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  getBasePath(): string {
    return this.basePath;
  }
}

export abstract class TAbstractFile {
  path: string;
  name: string;
  parent: TFolder | null = null;

  constructor(relPath: string) {
    this.path = normalizePath(relPath);
    this.name = path.posix.basename(this.path);
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class TFile extends TAbstractFile {
  basename: string;
  extension: string;
  stat: { ctime: number; mtime: number; size: number };

  constructor(relPath: string, size = 0, mtime = Date.now()) {
    super(relPath);
    const ext = path.posix.extname(this.name);
    this.extension = ext.replace(/^\./, "");
    this.basename = ext ? this.name.slice(0, -ext.length) : this.name;
    this.stat = { ctime: mtime, mtime, size };
  }
}

export class MarkdownView {
  file: TFile | null = null;
  editor = {
    selection: "",
    cursor: { line: 0, ch: 0 },
    getSelection(): string {
      return this.selection;
    },
    getCursor(): { line: number; ch: number } {
      return this.cursor;
    },
    replaceSelection(text: string): void {
      this.selection = text;
    },
    replaceRange(_text: string, _pos: { line: number; ch: number }): void {
      // Mock no-op
    },
  };
}

export class Notice {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

function parseSimpleFrontmatter(raw: string): {
  data: Record<string, unknown> | null;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) {
    return { data: null, body: raw };
  }
  const data: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const k = line.slice(0, colon).trim();
      const vRaw = line.slice(colon + 1).trim();
      try {
        data[k] = JSON.parse(vRaw);
      } catch {
        data[k] = vRaw.replace(/^["']|["']$/g, "");
      }
    }
  }
  return { data, body: match[2] };
}

function serializeSimpleFrontmatter(data: Record<string, unknown>, body: string): string {
  const keys = Object.keys(data);
  if (keys.length === 0) {
    return body;
  }
  const yamlLines = keys.map((k) => `${k}: ${JSON.stringify(data[k])}`);
  return `---\n${yamlLines.join("\n")}\n---\n${body}`;
}

export function createMockObsidianApp(vaultRoot: string, vaultName = "TestVault") {
  const files = new Map<string, TFile>();
  const folders = new Map<string, TFolder>();
  let activeFile: TFile | null = null;
  const executedCommands: string[] = [];

  const syncFromDisk = () => {
    files.clear();
    folders.clear();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        const abs = path.join(dir, entry.name);
        const rel = normalizePath(path.relative(vaultRoot, abs));
        if (entry.isDirectory()) {
          folders.set(rel, new TFolder(rel));
          walk(abs);
        } else if (entry.isFile()) {
          const st = fs.statSync(abs);
          files.set(rel, new TFile(rel, st.size, st.mtimeMs));
        }
      }
    };
    walk(vaultRoot);
  };

  syncFromDisk();

  const buildResolvedLinks = () => {
    const resolved: Record<string, Record<string, number>> = {};
    for (const [srcPath, f] of files.entries()) {
      if (f.extension !== "md") {
        continue;
      }
      resolved[srcPath] = {};
      const text = fs.readFileSync(path.join(vaultRoot, srcPath), "utf8");
      const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
      let m = re.exec(text);
      while (m !== null) {
        const targetRaw = m[1].trim();
        const targetCandidate = targetRaw.endsWith(".md") ? targetRaw : `${targetRaw}.md`;
        for (const candidatePath of files.keys()) {
          if (
            candidatePath === targetCandidate ||
            path.posix.basename(candidatePath) === path.posix.basename(targetCandidate)
          ) {
            resolved[srcPath][candidatePath] = (resolved[srcPath][candidatePath] || 0) + 1;
          }
        }
        m = re.exec(text);
      }
    }
    return resolved;
  };

  const app = {
    vault: {
      configDir: ".obsidian",
      adapter: new FileSystemAdapter(vaultRoot),
      getName: () => vaultName,
      getFiles: () => Array.from(files.values()),
      getMarkdownFiles: () =>
        Array.from(files.values()).filter((f) => f.extension === "md"),
      getAbstractFileByPath: (relPath: string) => {
        const norm = normalizePath(relPath);
        return files.get(norm) || folders.get(norm) || null;
      },
      read: (file: TFile) =>
        Promise.resolve(fs.readFileSync(path.join(vaultRoot, file.path), "utf8")),
      cachedRead: (file: TFile) =>
        Promise.resolve(fs.readFileSync(path.join(vaultRoot, file.path), "utf8")),
      createFolder: (relPath: string) => {
        const norm = normalizePath(relPath);
        fs.mkdirSync(path.join(vaultRoot, norm), { recursive: true });
        const folder = new TFolder(norm);
        folders.set(norm, folder);
        return Promise.resolve(folder);
      },
      create: (relPath: string, content: string) => {
        const norm = normalizePath(relPath);
        const abs = path.join(vaultRoot, norm);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
        const st = fs.statSync(abs);
        const f = new TFile(norm, st.size, st.mtimeMs);
        files.set(norm, f);
        return Promise.resolve(f);
      },
      process: (file: TFile, fn: (data: string) => string) => {
        const abs = path.join(vaultRoot, file.path);
        const current = fs.readFileSync(abs, "utf8");
        const next = fn(current);
        fs.writeFileSync(abs, next, "utf8");
        const st = fs.statSync(abs);
        file.stat = { ctime: st.ctimeMs, mtime: st.mtimeMs, size: st.size };
        return Promise.resolve(next);
      },
    },
    metadataCache: {
      get resolvedLinks() {
        return buildResolvedLinks();
      },
      unresolvedLinks: {} as Record<string, Record<string, number>>,
      getFileCache: (file: TFile) => {
        if (file.extension !== "md") {
          return null;
        }
        const raw = fs.readFileSync(path.join(vaultRoot, file.path), "utf8");
        const { data: frontmatter } = parseSimpleFrontmatter(raw);
        const tags: Array<{ tag: string }> = [];
        const tagRe = /(?:^|\s)(#[A-Za-z0-9_/-]+)/g;
        let tm = tagRe.exec(raw);
        while (tm !== null) {
          tags.push({ tag: tm[1] });
          tm = tagRe.exec(raw);
        }
        const headings: Array<{
          level: number;
          heading: string;
          position: { start: { line: number } };
        }> = [];
        const lines = raw.split(/\r?\n/);
        lines.forEach((line, idx) => {
          const hm = /^(#{1,6})\s+(.+)$/.exec(line);
          if (hm) {
            headings.push({
              level: hm[1].length,
              heading: hm[2].trim(),
              position: { start: { line: idx } },
            });
          }
        });
        return { frontmatter, tags, headings, links: [] };
      },
    },
    fileManager: {
      processFrontMatter: (file: TFile, fn: (fm: Record<string, unknown>) => void) => {
        const abs = path.join(vaultRoot, file.path);
        const raw = fs.readFileSync(abs, "utf8");
        const parsed = parseSimpleFrontmatter(raw);
        const fm = parsed.data ? { ...parsed.data } : {};
        fn(fm);
        const updated = serializeSimpleFrontmatter(fm, parsed.body);
        fs.writeFileSync(abs, updated, "utf8");
        syncFromDisk();
        return Promise.resolve();
      },
      renameFile: (file: TFile, newPath: string) => {
        const oldNorm = file.path;
        const newNorm = normalizePath(newPath);
        const oldBase = file.basename;
        const newAbs = path.join(vaultRoot, newNorm);
        fs.mkdirSync(path.dirname(newAbs), { recursive: true });
        fs.renameSync(path.join(vaultRoot, oldNorm), newAbs);
        syncFromDisk();
        const renamedFile = files.get(newNorm);
        if (renamedFile) {
          for (const other of files.values()) {
            if (other.extension === "md" && other.path !== newNorm) {
              const otherAbs = path.join(vaultRoot, other.path);
              const body = fs.readFileSync(otherAbs, "utf8");
              const updated = body.replace(
                new RegExp(`\\[\\[${oldBase}(\\|[^\\]]*)?\\]\\]`, "g"),
                `[[${renamedFile.basename}$1]]`
              );
              if (updated !== body) {
                fs.writeFileSync(otherAbs, updated, "utf8");
              }
            }
          }
        }
        return Promise.resolve();
      },
      trashFile: (file: TFile) => {
        const trashDir = path.join(vaultRoot, ".trash");
        fs.mkdirSync(trashDir, { recursive: true });
        fs.renameSync(
          path.join(vaultRoot, file.path),
          path.join(trashDir, path.posix.basename(file.path))
        );
        syncFromDisk();
        return Promise.resolve();
      },
    },
    workspace: {
      getActiveFile: () => activeFile,
      getActiveViewOfType: () => null,
      iterateAllLeaves: () => undefined,
      getLeaf: () => ({
        openFile: (f: TFile) => {
          activeFile = f;
          return Promise.resolve();
        },
      }),
      revealLeaf: () => Promise.resolve(),
    },
    commands: {
      commands: {
        "workspace:toggle-pin": { id: "workspace:toggle-pin", name: "Toggle pin" },
        "app:delete-file": { id: "app:delete-file", name: "Delete current file" },
      },
      executeCommandById: (id: string) => {
        if (id === "workspace:toggle-pin") {
          executedCommands.push(id);
          return true;
        }
        return false;
      },
    },
    _getExecutedCommands: () => executedCommands,
  };

  return app;
}
