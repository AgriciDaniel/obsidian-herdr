import {
  type App,
  FileSystemAdapter,
  MarkdownView,
  Notice,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";
import { UiControlError, type UiControlService } from "../control/ui-control";
import { guardVaultRelativePath, VaultPathGuardError } from "../domain/path-guard";
import type {
  VaultAuditEntry,
  VaultMutationSnapshot,
  VaultPermissionMode,
} from "../domain/types";

export class BridgeRpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeRpcError";
    this.code = code;
  }
}

function asStr(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

const READ_METHODS = new Set<string>([
  "bridge.ping",
  "vault.info",
  "vault.list_files",
  "vault.read_note",
  "vault.search",
  "metadata.backlinks",
  "metadata.graph_neighbors",
  "metadata.tags_and_properties",
  "workspace.get_state",
  "editor.selection",
  "commands.list",
]);

const WRITE_METHODS = new Set<string>([
  "vault.create_note",
  "vault.update_note",
  "vault.patch_frontmatter",
  "vault.rename_note",
  "vault.trash_note",
  "canvas.upsert_node",
  "workspace.open_note",
  "workspace.notice",
  "editor.replace_selection",
  "editor.insert_at_cursor",
]);

const FULL_METHODS = new Set<string>(["commands.execute"]);

/** Seeing the window: any bridge tier, plus the separate UI control setting. */
const UI_OBSERVE_METHODS = new Set<string>(["ui.screenshot", "ui.inspect", "ui.wait_for"]);

/** Operating the window can do anything a person can, so it needs Full plus the UI control setting. */
const UI_INPUT_METHODS = new Set<string>([
  "ui.click",
  "ui.type",
  "ui.press_key",
  "ui.scroll",
  "ui.drag",
]);

const BLOCKED_COMMAND_SUBSTRINGS = [
  "app:delete-vault",
  "plugin",
  "safe-mode",
];

interface CanvasNodeRecord {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  file?: string;
  url?: string;
  label?: string;
  color?: string;
}

interface CanvasEdgeRecord {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  toSide?: "top" | "right" | "bottom" | "left";
  label?: string;
}

interface CanvasDocument {
  nodes: CanvasNodeRecord[];
  edges: CanvasEdgeRecord[];
}

export class VaultOpsService {
  private readonly app: App;
  private readonly getPermissionMode: () => VaultPermissionMode;
  private readonly getAllowHiddenReads: () => boolean;
  private readonly uiControl: UiControlService | null;
  private readonly getAllowUiControl: () => boolean;
  private readonly auditEntries: VaultAuditEntry[] = [];
  private readonly auditListeners = new Set<() => void>();
  private auditSeq = 0;

  constructor(options: {
    app: App;
    getPermissionMode: () => VaultPermissionMode;
    getAllowHiddenReads: () => boolean;
    uiControl?: UiControlService | null;
    getAllowUiControl?: () => boolean;
  }) {
    this.app = options.app;
    this.getPermissionMode = options.getPermissionMode;
    this.getAllowHiddenReads = options.getAllowHiddenReads;
    this.uiControl = options.uiControl ?? null;
    this.getAllowUiControl = options.getAllowUiControl ?? (() => false);
  }

  onAuditUpdated(listener: () => void): () => void {
    this.auditListeners.add(listener);
    return () => {
      this.auditListeners.delete(listener);
    };
  }

  getAuditLog(): VaultAuditEntry[] {
    return [...this.auditEntries];
  }

  clearAuditLog(): void {
    this.auditEntries.length = 0;
    this.notifyAudit();
  }

  getVaultBasePath(): string | null {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    return null;
  }

  async dispatch(
    method: string,
    params: Record<string, unknown> = {},
    caller = "herdr-agent"
  ): Promise<unknown> {
    const mode = this.getPermissionMode();
    const targetHint =
      typeof params.path === "string"
        ? params.path
        : typeof params.commandId === "string"
          ? params.commandId
          : undefined;

    const isUiMethod = UI_OBSERVE_METHODS.has(method) || UI_INPUT_METHODS.has(method);
    if (isUiMethod && mode !== "off" && !this.getAllowUiControl()) {
      this.recordAudit({
        method,
        caller,
        allowed: false,
        summary: `Denied '${method}': UI control is turned off.`,
      });
      throw new BridgeRpcError(
        "ui_control_disabled",
        "UI control is off. Turn on 'Let agents see and operate Obsidian' in Herdr settings."
      );
    }

    if (!this.isMethodPermitted(method, mode)) {
      this.recordAudit({
        method,
        caller,
        targetPath: targetHint,
        allowed: false,
        summary: `Denied '${method}' under '${mode}' permission mode.`,
      });
      throw new BridgeRpcError(
        "permission_denied",
        `Method '${method}' requires a higher Vault Control Bridge permission tier (current: ${mode}).`
      );
    }

    try {
      const result = await this.executeMethod(method, params, caller);
      return result;
    } catch (err) {
      if (err instanceof VaultPathGuardError) {
        this.recordAudit({
          method,
          caller,
          targetPath: targetHint,
          allowed: false,
          summary: `Blocked unsafe path: ${err.message}`,
        });
        throw new BridgeRpcError(err.code, err.message);
      }
      if (err instanceof BridgeRpcError) {
        throw err;
      }
      if (err instanceof UiControlError) {
        this.recordAudit({
          method,
          caller,
          allowed: false,
          summary: `UI action failed: ${err.message}`,
        });
        throw new BridgeRpcError(err.code, err.message);
      }
      throw new BridgeRpcError(
        "execution_error",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  async undoMutation(auditId: string): Promise<string> {
    const entry = this.auditEntries.find((item) => item.id === auditId);
    if (!entry || !entry.snapshot) {
      throw new Error("No reversible snapshot is recorded for that audit item.");
    }
    if (entry.undone) {
      throw new Error("This mutation has already been undone.");
    }

    const snap = entry.snapshot;
    if (snap.kind === "created") {
      const created = this.app.vault.getAbstractFileByPath(snap.path);
      if (created instanceof TFile) {
        await this.app.fileManager.trashFile(created);
      }
      entry.undone = true;
      this.notifyAudit();
      return `Moved created note '${snap.path}' to trash.`;
    }

    if (snap.kind === "modified" && typeof snap.previousContent === "string") {
      const existing = this.app.vault.getAbstractFileByPath(snap.path);
      if (existing instanceof TFile) {
        const restored = snap.previousContent;
        await this.app.vault.process(existing, () => restored);
      } else {
        await this.ensureParentFolders(snap.path);
        await this.app.vault.create(snap.path, snap.previousContent);
      }
      entry.undone = true;
      this.notifyAudit();
      return `Restored previous content of '${snap.path}'.`;
    }

    if (snap.kind === "renamed" && snap.previousPath) {
      const current = this.app.vault.getAbstractFileByPath(snap.path);
      if (!(current instanceof TFile)) {
        throw new Error(`Renamed note '${snap.path}' is no longer present.`);
      }
      await this.ensureParentFolders(snap.previousPath);
      await this.app.fileManager.renameFile(current, snap.previousPath);
      entry.undone = true;
      this.notifyAudit();
      return `Renamed '${snap.path}' back to '${snap.previousPath}'.`;
    }

    throw new Error("Unsupported snapshot kind.");
  }

  private isMethodPermitted(method: string, mode: VaultPermissionMode): boolean {
    if (mode === "off") {
      return false;
    }
    if (READ_METHODS.has(method)) {
      return true;
    }
    if (WRITE_METHODS.has(method)) {
      return mode === "read-write" || mode === "full";
    }
    if (FULL_METHODS.has(method)) {
      return mode === "full";
    }
    if (UI_OBSERVE_METHODS.has(method)) {
      return true;
    }
    if (UI_INPUT_METHODS.has(method)) {
      return mode === "full";
    }
    return false;
  }

  private async executeUiMethod(
    method: string,
    params: Record<string, unknown>,
    caller: string
  ): Promise<unknown> {
    const ui = this.uiControl;
    if (!ui) {
      throw new BridgeRpcError("ui_unavailable", "UI control is not available in this host.");
    }
    if (method === "ui.screenshot") {
      const shot = await ui.screenshot(params);
      this.recordAudit({ method, caller, allowed: true, summary: "Captured a screenshot of the Obsidian window." });
      return shot;
    }
    if (method === "ui.inspect") {
      return ui.inspect(params);
    }
    if (method === "ui.wait_for") {
      return ui.waitFor(params);
    }

    // Input can change the active note, so keep its text for one-click Undo when it does.
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const notePath = mdView?.file?.path;
    const before = mdView && notePath ? mdView.editor.getValue() : null;

    let result: unknown;
    let summary: string;
    if (method === "ui.click") {
      result = await ui.click(params);
      summary = "Clicked in the Obsidian window.";
    } else if (method === "ui.type") {
      result = await ui.type(params);
      summary = `Typed ${asStr(params.text).length} characters in the Obsidian window.`;
    } else if (method === "ui.press_key") {
      result = await ui.pressKey(params);
      const mods = Array.isArray(params.modifiers) ? params.modifiers.map(String) : [];
      summary = `Pressed ${[...mods, asStr(params.key)].join("+")} in the Obsidian window.`;
    } else if (method === "ui.scroll") {
      result = await ui.scroll(params);
      summary = "Scrolled in the Obsidian window.";
    } else {
      result = await ui.drag(params);
      summary = "Dragged in the Obsidian window.";
    }

    const changed =
      before !== null && mdView !== null && mdView.file?.path === notePath && mdView.editor.getValue() !== before;
    this.recordAudit({
      method,
      caller,
      targetPath: changed ? notePath : undefined,
      allowed: true,
      summary: changed ? `${summary} Changed '${notePath}'.` : summary,
      snapshot: changed && notePath && before !== null ? { kind: "modified", path: notePath, previousContent: before } : undefined,
    });
    return result;
  }

  private safePath(raw: unknown, isWrite: boolean): string {
    const validated = guardVaultRelativePath(asStr(raw), {
      configDirName: this.app.vault.configDir,
      allowHiddenRead: this.getAllowHiddenReads(),
      isWrite,
    });
    return normalizePath(validated);
  }

  private isExcludedFromScan(relPath: string, explicitFolderPrefix = ""): boolean {
    const norm = relPath.replace(/\\/g, "/");
    if (explicitFolderPrefix && norm.startsWith(explicitFolderPrefix)) {
      return false;
    }
    if (/(?:^|\/)(?:\.git|node_modules)(?:\/|$)/.test(norm)) {
      return true;
    }
    const mc = this.app.metadataCache as unknown as {
      isUserIgnored?: (path: string) => boolean;
    };
    if (typeof mc.isUserIgnored === "function" && mc.isUserIgnored(norm)) {
      return true;
    }
    return false;
  }

  private async executeMethod(
    method: string,
    params: Record<string, unknown>,
    caller: string
  ): Promise<unknown> {
    if (method.startsWith("ui.")) {
      return this.executeUiMethod(method, params, caller);
    }
    switch (method) {
      case "bridge.ping":
        return {
          status: "ok",
          vaultName: this.app.vault.getName(),
          permissionMode: this.getPermissionMode(),
        };

      case "vault.info": {
        const mdFiles = this.app.vault
          .getMarkdownFiles()
          .filter((file) => !this.isExcludedFromScan(file.path));
        const allFiles = this.app.vault
          .getFiles()
          .filter((file) => !this.isExcludedFromScan(file.path));
        const activeFile = this.app.workspace.getActiveFile();
        this.recordAudit({
          method,
          caller,
          allowed: true,
          summary: "Inspected vault summary metadata.",
        });
        return {
          vaultName: this.app.vault.getName(),
          vaultPath: this.getVaultBasePath(),
          markdownCount: mdFiles.length,
          totalFileCount: allFiles.length,
          activeNote: activeFile ? activeFile.path : null,
          permissionMode: this.getPermissionMode(),
          uiControl: {
            enabled: this.getAllowUiControl(),
            available: this.uiControl?.isAvailable() ?? false,
            canObserve: this.getAllowUiControl() && this.getPermissionMode() !== "off",
            canOperate: this.getAllowUiControl() && this.getPermissionMode() === "full",
          },
        };
      }

      case "vault.list_files": {
        const folderPrefix =
          typeof params.folder === "string" && params.folder.trim()
            ? normalizePath(params.folder.trim().replace(/^\/+|\/+$/g, "")) + "/"
            : "";
        const extFilter =
          typeof params.extension === "string" && params.extension.trim()
            ? params.extension.trim().replace(/^\./, "").toLowerCase()
            : "";
        const tagFilter =
          typeof params.tag === "string" && params.tag.trim()
            ? params.tag.trim().replace(/^#/, "").toLowerCase()
            : "";
        const limit = Math.min(1000, Math.max(1, Number(params.limit || 250)));

        const matched: Array<{
          path: string;
          basename: string;
          extension: string;
          size: number;
          mtime: number;
        }> = [];

        for (const file of this.app.vault.getFiles()) {
          if (this.isExcludedFromScan(file.path, folderPrefix)) {
            continue;
          }
          if (folderPrefix && !file.path.startsWith(folderPrefix)) {
            continue;
          }
          if (extFilter && file.extension.toLowerCase() !== extFilter) {
            continue;
          }
          if (tagFilter) {
            const cache = this.app.metadataCache.getFileCache(file);
            const inlineTags = (cache?.tags || []).map((t) =>
              t.tag.replace(/^#/, "").toLowerCase()
            );
            const fmTagsRaw: unknown = cache?.frontmatter?.tags;
            const fmTags = Array.isArray(fmTagsRaw)
              ? fmTagsRaw.map((t) => String(t).replace(/^#/, "").toLowerCase())
              : typeof fmTagsRaw === "string"
                ? [fmTagsRaw.replace(/^#/, "").toLowerCase()]
                : [];
            if (!inlineTags.includes(tagFilter) && !fmTags.includes(tagFilter)) {
              continue;
            }
          }
          matched.push({
            path: file.path,
            basename: file.basename,
            extension: file.extension,
            size: file.stat.size,
            mtime: file.stat.mtime,
          });
          if (matched.length >= limit) {
            break;
          }
        }

        this.recordAudit({
          method,
          caller,
          targetPath: folderPrefix || "/",
          allowed: true,
          summary: `Listed ${matched.length} vault files.`,
        });
        return { files: matched, count: matched.length };
      }

      case "vault.read_note": {
        const relPath = this.safePath(params.path, false);
        const file = this.requireFile(relPath);
        const content = await this.app.vault.cachedRead(file);
        const cache = this.app.metadataCache.getFileCache(file);
        const backlinks = this.collectBacklinksForPath(file.path);

        this.recordAudit({
          method,
          caller,
          targetPath: file.path,
          allowed: true,
          summary: `Read note '${file.path}' (${content.length} chars).`,
        });

        return {
          path: file.path,
          basename: file.basename,
          size: file.stat.size,
          mtime: file.stat.mtime,
          content,
          frontmatter: cache?.frontmatter ?? null,
          headings: (cache?.headings || []).map((h) => ({
            level: h.level,
            heading: h.heading,
            line: h.position.start.line + 1,
          })),
          tags: (cache?.tags || []).map((t) => t.tag),
          outgoingLinks: (cache?.links || []).map((l) => ({
            link: l.link,
            displayText: l.displayText || "",
            line: l.position.start.line + 1,
          })),
          backlinks,
        };
      }

      case "vault.search": {
        const query = asStr(params.query).trim();
        if (!query) {
          throw new BridgeRpcError("invalid_params", "Search 'query' must be non-empty.");
        }
        const needle = query.toLowerCase();
        const maxResults = Math.min(100, Math.max(1, Number(params.limit || 25)));
        const hits: Array<{
          path: string;
          score: number;
          matches: Array<{ line: number; snippet: string }>;
        }> = [];

        for (const file of this.app.vault.getMarkdownFiles()) {
          if (this.isExcludedFromScan(file.path)) {
            continue;
          }
          let score = 0;
          if (file.basename.toLowerCase().includes(needle)) {
            score += 30;
          } else if (file.path.toLowerCase().includes(needle)) {
            score += 15;
          }

          const content = await this.app.vault.cachedRead(file);
          const lines = content.split(/\r?\n/);
          const lineMatches: Array<{ line: number; snippet: string }> = [];
          for (let i = 0; i < lines.length; i += 1) {
            if (lines[i].toLowerCase().includes(needle)) {
              score += 5;
              if (lineMatches.length < 4) {
                lineMatches.push({
                  line: i + 1,
                  snippet: lines[i].trim().slice(0, 200),
                });
              }
            }
          }

          if (score > 0) {
            hits.push({ path: file.path, score, matches: lineMatches });
          }
        }

        hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
        const topHits = hits.slice(0, maxResults);

        this.recordAudit({
          method,
          caller,
          allowed: true,
          summary: `Searched vault for '${query.slice(0, 48)}' (${topHits.length} results).`,
        });

        return { query, count: topHits.length, results: topHits };
      }

      case "metadata.backlinks": {
        const relPath = this.safePath(params.path, false);
        const backlinks = this.collectBacklinksForPath(relPath);
        this.recordAudit({
          method,
          caller,
          targetPath: relPath,
          allowed: true,
          summary: `Queried ${backlinks.length} backlinks for '${relPath}'.`,
        });
        return { path: relPath, count: backlinks.length, backlinks };
      }

      case "metadata.graph_neighbors": {
        const relPath = this.safePath(params.path, false);
        const resolved = this.app.metadataCache.resolvedLinks[relPath] || {};
        const unresolved = this.app.metadataCache.unresolvedLinks[relPath] || {};
        const outgoing = Object.entries(resolved).map(([target, count]) => ({
          path: target,
          count,
        }));
        const unresolvedList = Object.entries(unresolved).map(([target, count]) => ({
          link: target,
          count,
        }));
        const incoming = this.collectBacklinksForPath(relPath);

        this.recordAudit({
          method,
          caller,
          targetPath: relPath,
          allowed: true,
          summary: `Inspected graph neighborhood of '${relPath}'.`,
        });

        return {
          path: relPath,
          outgoing,
          incoming,
          unresolved: unresolvedList,
          isOrphan: outgoing.length === 0 && incoming.length === 0,
        };
      }

      case "metadata.tags_and_properties": {
        const tagCounts = new Map<string, number>();
        const propertyCounts = new Map<string, number>();

        for (const file of this.app.vault.getMarkdownFiles()) {
          if (this.isExcludedFromScan(file.path)) {
            continue;
          }
          const cache = this.app.metadataCache.getFileCache(file);
          for (const t of cache?.tags || []) {
            tagCounts.set(t.tag, (tagCounts.get(t.tag) || 0) + 1);
          }
          if (cache?.frontmatter) {
            for (const key of Object.keys(cache.frontmatter)) {
              if (key !== "position") {
                propertyCounts.set(key, (propertyCounts.get(key) || 0) + 1);
              }
            }
          }
        }

        const tags = Array.from(tagCounts.entries())
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count);
        const properties = Array.from(propertyCounts.entries())
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count);

        this.recordAudit({
          method,
          caller,
          allowed: true,
          summary: `Aggregated ${tags.length} tags and ${properties.length} properties.`,
        });
        return { tags, properties };
      }

      case "vault.create_note": {
        const relPath = this.safePath(params.path, true);
        const content = asStr(params.content);
        const overwrite = Boolean(params.overwrite);
        const existing = this.app.vault.getAbstractFileByPath(relPath);

        if (existing instanceof TFolder) {
          throw new BridgeRpcError("is_folder", `'${relPath}' is an existing folder.`);
        }

        if (existing instanceof TFile) {
          if (!overwrite) {
            throw new BridgeRpcError(
              "already_exists",
              `Note '${relPath}' already exists. Use vault.update_note or pass overwrite=true.`
            );
          }
          const prev = await this.app.vault.read(existing);
          await this.app.vault.process(existing, () => content);
          this.recordAudit({
            method,
            caller,
            targetPath: relPath,
            allowed: true,
            summary: `Overwrote note '${relPath}' (${content.length} chars).`,
            snapshot: {
              kind: "modified",
              path: relPath,
              previousContent: prev,
            },
          });
          return { path: relPath, created: false, updated: true, bytes: content.length };
        }

        await this.ensureParentFolders(relPath);
        const created = await this.app.vault.create(relPath, content);
        this.recordAudit({
          method,
          caller,
          targetPath: created.path,
          allowed: true,
          summary: `Created note '${created.path}' (${content.length} chars).`,
          snapshot: {
            kind: "created",
            path: created.path,
          },
        });
        return { path: created.path, created: true, updated: false, bytes: content.length };
      }

      case "vault.update_note": {
        const relPath = this.safePath(params.path, true);
        const file = this.requireFile(relPath);
        const mode = asStr(params.mode, "append");
        const text = asStr(params.content);
        const heading = typeof params.heading === "string" ? params.heading.trim() : "";
        const search = typeof params.search === "string" ? params.search : "";

        const previousContent = await this.app.vault.read(file);

        const updatedContent = await this.app.vault.process(file, (current) => {
          if (mode === "replace") {
            return text;
          }
          if (mode === "prepend") {
            return current ? `${text}\n${current}` : text;
          }
          if (mode === "search_replace") {
            if (!search || !current.includes(search)) {
              throw new BridgeRpcError(
                "search_target_not_found",
                `Target substring was not found in '${relPath}'.`
              );
            }
            return current.replace(search, text);
          }
          if (mode === "under_heading" && heading) {
            return insertUnderMarkdownHeading(current, heading, text);
          }
          // Default: append
          if (!current) {
            return text;
          }
          const sep = current.endsWith("\n") ? "" : "\n";
          return `${current}${sep}${text}${text.endsWith("\n") ? "" : "\n"}`;
        });

        this.recordAudit({
          method,
          caller,
          targetPath: file.path,
          allowed: true,
          summary: `Updated '${file.path}' via mode '${mode}'.`,
          snapshot: {
            kind: "modified",
            path: file.path,
            previousContent,
          },
        });

        return { path: file.path, mode, length: updatedContent.length };
      }

      case "vault.patch_frontmatter": {
        const relPath = this.safePath(params.path, true);
        const file = this.requireFile(relPath);
        const setObj =
          params.set && typeof params.set === "object"
            ? (params.set as Record<string, unknown>)
            : {};
        const unsetKeys = Array.isArray(params.unset)
          ? params.unset.map((k) => String(k))
          : [];

        const previousContent = await this.app.vault.read(file);

        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(setObj)) {
            fm[k] = v;
          }
          for (const k of unsetKeys) {
            delete fm[k];
          }
        });

        this.recordAudit({
          method,
          caller,
          targetPath: file.path,
          allowed: true,
          summary: `Patched YAML frontmatter on '${file.path}'.`,
          snapshot: {
            kind: "modified",
            path: file.path,
            previousContent,
          },
        });

        return {
          path: file.path,
          updatedKeys: Object.keys(setObj),
          removedKeys: unsetKeys,
        };
      }

      case "vault.rename_note": {
        const fromPath = this.safePath(params.path, true);
        const toPath = this.safePath(params.newPath, true);
        const file = this.requireFile(fromPath);
        if (this.app.vault.getAbstractFileByPath(toPath)) {
          throw new BridgeRpcError(
            "destination_exists",
            `Destination '${toPath}' already exists.`
          );
        }
        await this.ensureParentFolders(toPath);
        await this.app.fileManager.renameFile(file, toPath);

        this.recordAudit({
          method,
          caller,
          targetPath: toPath,
          allowed: true,
          summary: `Renamed '${fromPath}' to '${toPath}' with automatic wiki link updates.`,
          snapshot: {
            kind: "renamed",
            path: toPath,
            previousPath: fromPath,
          },
        });

        return { previousPath: fromPath, path: toPath };
      }

      case "vault.trash_note": {
        const relPath = this.safePath(params.path, true);
        const file = this.requireFile(relPath);
        const previousContent = await this.app.vault.read(file);
        await this.app.fileManager.trashFile(file);

        this.recordAudit({
          method,
          caller,
          targetPath: relPath,
          allowed: true,
          summary: `Moved '${relPath}' to trash via FileManager.trashFile.`,
          snapshot: {
            kind: "modified",
            path: relPath,
            previousContent,
          },
        });

        return { trashed: true, path: relPath };
      }

      case "canvas.upsert_node": {
        const rawPath = asStr(params.path);
        const canvasPath = this.safePath(
          rawPath.endsWith(".canvas") ? rawPath : `${rawPath}.canvas`,
          true
        );
        const nodeId = asStr(params.id) || `node-${Date.now()}`;
        const nodeType = (params.nodeType as CanvasNodeRecord["type"]) || "text";
        const newNode: CanvasNodeRecord = {
          id: nodeId,
          type: nodeType,
          x: Number.isFinite(Number(params.x)) ? Number(params.x) : 0,
          y: Number.isFinite(Number(params.y)) ? Number(params.y) : 0,
          width: Number.isFinite(Number(params.width)) ? Number(params.width) : 320,
          height: Number.isFinite(Number(params.height)) ? Number(params.height) : 180,
          ...(typeof params.text === "string" ? { text: params.text } : {}),
          ...(typeof params.file === "string" ? { file: params.file } : {}),
          ...(typeof params.url === "string" ? { url: params.url } : {}),
          ...(typeof params.color === "string" ? { color: params.color } : {}),
        };

        const existing = this.app.vault.getAbstractFileByPath(canvasPath);
        if (existing instanceof TFile) {
          const prevText = await this.app.vault.read(existing);
          await this.app.vault.process(existing, (raw) => {
            const doc = parseCanvasDoc(raw);
            const idx = doc.nodes.findIndex((n) => n.id === nodeId);
            if (idx >= 0) {
              doc.nodes[idx] = { ...doc.nodes[idx], ...newNode };
            } else {
              doc.nodes.push(newNode);
            }
            return JSON.stringify(doc, null, 2) + "\n";
          });
          this.recordAudit({
            method,
            caller,
            targetPath: canvasPath,
            allowed: true,
            summary: `Upserted Canvas node '${nodeId}' in '${canvasPath}'.`,
            snapshot: { kind: "modified", path: canvasPath, previousContent: prevText },
          });
        } else {
          await this.ensureParentFolders(canvasPath);
          const doc: CanvasDocument = { nodes: [newNode], edges: [] };
          await this.app.vault.create(canvasPath, JSON.stringify(doc, null, 2) + "\n");
          this.recordAudit({
            method,
            caller,
            targetPath: canvasPath,
            allowed: true,
            summary: `Created Canvas '${canvasPath}' with node '${nodeId}'.`,
            snapshot: { kind: "created", path: canvasPath },
          });
        }

        return { path: canvasPath, nodeId };
      }

      case "workspace.get_state": {
        const activeFile = this.app.workspace.getActiveFile();
        const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
        const selection = mdView ? mdView.editor.getSelection() : "";
        const cursor = mdView ? mdView.editor.getCursor() : null;
        const openMarkdownPaths: string[] = [];
        this.app.workspace.iterateAllLeaves((leaf) => {
          if (leaf.view instanceof MarkdownView && leaf.view.file) {
            openMarkdownPaths.push(leaf.view.file.path);
          }
        });

        this.recordAudit({
          method,
          caller,
          allowed: true,
          summary: "Inspected live Obsidian workspace and active editor state.",
        });

        return {
          activeFile: activeFile ? activeFile.path : null,
          cursor: cursor ? { line: cursor.line + 1, ch: cursor.ch } : null,
          selection,
          openNotes: Array.from(new Set(openMarkdownPaths)),
          darkTheme:
            typeof document !== "undefined" &&
            document.body.classList.contains("theme-dark"),
        };
      }

      case "workspace.open_note": {
        const relPath = this.safePath(params.path, false);
        const file = this.requireFile(relPath);
        const paneMode = asStr(params.pane, "current");
        const lineOneBased =
          typeof params.line === "number" && Number.isFinite(params.line)
            ? Math.max(1, Math.round(params.line))
            : undefined;

        const leaf =
          paneMode === "split"
            ? this.app.workspace.getLeaf("split", "vertical")
            : paneMode === "tab"
              ? this.app.workspace.getLeaf("tab")
              : this.app.workspace.getLeaf(false);

        await leaf.openFile(
          file,
          lineOneBased ? { eState: { line: lineOneBased - 1 } } : undefined
        );
        await this.app.workspace.revealLeaf(leaf);

        this.recordAudit({
          method,
          caller,
          targetPath: file.path,
          allowed: true,
          summary: `Opened '${file.path}' in Obsidian (${paneMode}).`,
        });

        return { opened: true, path: file.path, line: lineOneBased ?? null };
      }

      case "workspace.notice": {
        const message = asStr(params.message).trim().slice(0, 240);
        if (!message) {
          throw new BridgeRpcError("invalid_params", "Notice 'message' cannot be empty.");
        }
        new Notice(`Herdr: ${message}`, 5000);
        this.recordAudit({
          method,
          caller,
          allowed: true,
          summary: `Displayed notice: ${message}`,
        });
        return { shown: true };
      }

      case "editor.selection": {
        const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!mdView) {
          return { hasActiveEditor: false, file: null, selection: "", cursor: null };
        }
        const cursor = mdView.editor.getCursor();
        return {
          hasActiveEditor: true,
          file: mdView.file ? mdView.file.path : null,
          selection: mdView.editor.getSelection(),
          cursor: { line: cursor.line + 1, ch: cursor.ch },
        };
      }

      case "editor.replace_selection": {
        const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!mdView) {
          throw new BridgeRpcError("no_active_editor", "No Markdown editor is currently focused.");
        }
        const replacement = asStr(params.text);
        mdView.editor.replaceSelection(replacement);
        this.recordAudit({
          method,
          caller,
          targetPath: mdView.file?.path,
          allowed: true,
          summary: `Replaced active editor selection (${replacement.length} chars).`,
        });
        return { updated: true, file: mdView.file?.path ?? null };
      }

      case "editor.insert_at_cursor": {
        const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!mdView) {
          throw new BridgeRpcError("no_active_editor", "No Markdown editor is currently focused.");
        }
        const text = asStr(params.text);
        const cursor = mdView.editor.getCursor();
        mdView.editor.replaceRange(text, cursor);
        this.recordAudit({
          method,
          caller,
          targetPath: mdView.file?.path,
          allowed: true,
          summary: `Inserted ${text.length} chars at line ${cursor.line + 1}.`,
        });
        return { inserted: true, file: mdView.file?.path ?? null, line: cursor.line + 1 };
      }

      case "commands.list": {
        const cmds = this.getCommandRegistry();
        const filter =
          typeof params.query === "string" ? params.query.trim().toLowerCase() : "";
        const items = Object.values(cmds)
          .filter((c) => !filter || c.id.toLowerCase().includes(filter) || c.name.toLowerCase().includes(filter))
          .slice(0, 200)
          .map((c) => ({ id: c.id, name: c.name }));
        return { count: items.length, commands: items };
      }

      case "commands.execute": {
        const commandId = asStr(params.commandId).trim();
        if (!commandId) {
          throw new BridgeRpcError("invalid_params", "Provide a non-empty 'commandId'.");
        }
        const lower = commandId.toLowerCase();
        if (BLOCKED_COMMAND_SUBSTRINGS.some((sub) => lower.includes(sub))) {
          throw new BridgeRpcError(
            "command_blocked",
            `Command '${commandId}' is restricted by safety policy.`
          );
        }
        const executed = this.executeCommandById(commandId);
        if (!executed) {
          throw new BridgeRpcError("command_not_found", `Command '${commandId}' was not found.`);
        }
        this.recordAudit({
          method,
          caller,
          targetPath: commandId,
          allowed: true,
          summary: `Executed Obsidian command '${commandId}'.`,
        });
        return { executed: true, commandId };
      }

      default:
        throw new BridgeRpcError("unknown_method", `Unknown Vault Bridge method '${method}'.`);
    }
  }

  private requireFile(relPath: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(relPath);
    if (!(file instanceof TFile)) {
      throw new BridgeRpcError("not_found", `Vault note '${relPath}' was not found.`);
    }
    return file;
  }

  private async ensureParentFolders(relPath: string): Promise<void> {
    const parts = relPath.split("/");
    if (parts.length <= 1) {
      return;
    }
    let current = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private collectBacklinksForPath(targetPath: string): Array<{ sourcePath: string; count: number }> {
    const resolvedMap = this.app.metadataCache.resolvedLinks;
    const out: Array<{ sourcePath: string; count: number }> = [];
    for (const [sourcePath, targets] of Object.entries(resolvedMap)) {
      const count = targets[targetPath];
      if (typeof count === "number" && count > 0) {
        out.push({ sourcePath, count });
      }
    }
    out.sort((a, b) => b.count - a.count || a.sourcePath.localeCompare(b.sourcePath));
    return out;
  }

  private getCommandRegistry(): Record<string, { id: string; name: string }> {
    const internal = this.app as unknown as {
      commands?: { commands?: Record<string, { id: string; name: string }> };
    };
    return internal.commands?.commands ?? {};
  }

  private executeCommandById(commandId: string): boolean {
    const internal = this.app as unknown as {
      commands?: { executeCommandById?: (id: string) => boolean };
    };
    if (typeof internal.commands?.executeCommandById === "function") {
      return Boolean(internal.commands.executeCommandById(commandId));
    }
    return false;
  }

  private recordAudit(entry: {
    method: string;
    caller: string;
    targetPath?: string;
    allowed: boolean;
    summary: string;
    snapshot?: VaultMutationSnapshot;
  }): void {
    this.auditEntries.unshift({
      id: `audit_${Date.now()}_${(this.auditSeq += 1)}`,
      timestamp: Date.now(),
      method: entry.method,
      caller: entry.caller,
      targetPath: entry.targetPath,
      allowed: entry.allowed,
      summary: entry.summary,
      snapshot: entry.snapshot,
    });
    if (this.auditEntries.length > 200) {
      this.auditEntries.length = 200;
    }
    this.notifyAudit();
  }

  private notifyAudit(): void {
    for (const listener of this.auditListeners) {
      listener();
    }
  }
}

function insertUnderMarkdownHeading(doc: string, headingText: string, insertion: string): string {
  const lines = doc.split(/\r?\n/);
  const normalizedTarget = headingText.replace(/^#+\s*/, "").trim().toLowerCase();
  let targetIdx = -1;
  let targetLevel = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (m && m[2].trim().toLowerCase() === normalizedTarget) {
      targetIdx = i;
      targetLevel = m[1].length;
      break;
    }
  }

  if (targetIdx === -1) {
    const headerLine = headingText.startsWith("#") ? headingText : `## ${headingText}`;
    const sep = doc.endsWith("\n") || !doc ? "" : "\n";
    return `${doc}${sep}\n${headerLine}\n\n${insertion}\n`;
  }

  let insertAt = lines.length;
  for (let j = targetIdx + 1; j < lines.length; j += 1) {
    const m = /^(#{1,6})\s+/.exec(lines[j]);
    if (m && m[1].length <= targetLevel) {
      insertAt = j;
      break;
    }
  }

  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  return [...before, insertion, ...after].join("\n");
}

function parseCanvasDoc(raw: string): CanvasDocument {
  if (!raw.trim()) {
    return { nodes: [], edges: [] };
  }
  const parsed = JSON.parse(raw) as Partial<CanvasDocument>;
  return {
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    edges: Array.isArray(parsed.edges) ? parsed.edges : [],
  };
}
