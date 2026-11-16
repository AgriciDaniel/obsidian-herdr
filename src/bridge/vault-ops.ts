import {
  type App,
  FileSystemAdapter,
  MarkdownView,
  Notice,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";
import {
  UiControlError,
  type PointAtResultTarget,
  type MutationCompleteCallback,
  type UiControlService,
  type UiMutationContext,
} from "../control/ui-control";
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

export interface VaultTextChange {
  before: string;
  after: string;
  from: number;
  to: number;
  insertLength: number;
}

function editedTextRange(before: string, after: string): VaultTextChange | undefined {
  if (before === after) {
    return undefined;
  }
  let from = 0;
  const limit = Math.min(before.length, after.length);
  while (from < limit && before.charCodeAt(from) === after.charCodeAt(from)) {
    from++;
  }
  const splitsSurrogate = (text: string, pos: number): boolean =>
    pos > 0 && pos < text.length && text.charCodeAt(pos - 1) >= 0xd800 &&
    text.charCodeAt(pos - 1) <= 0xdbff && text.charCodeAt(pos) >= 0xdc00 && text.charCodeAt(pos) <= 0xdfff;
  if (splitsSurrogate(before, from) || splitsSurrogate(after, from)) {
    from--;
  }
  let suffix = 0;
  while (
    suffix < limit - from &&
    before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)
  ) {
    suffix++;
  }
  if (splitsSurrogate(before, before.length - suffix) || splitsSurrogate(after, after.length - suffix)) {
    suffix--;
  }
  return { before, after, from, to: before.length - suffix, insertLength: after.length - suffix - from };
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
const UI_OBSERVE_METHODS = new Set<string>(["ui.screenshot", "ui.inspect", "ui.wait_for", "ui.locate"]);

/** Operating the window can do anything a person can, so it needs Full plus the UI control setting. */
const UI_INPUT_METHODS = new Set<string>([
  "ui.click",
  "ui.type",
  "ui.press_key",
  "ui.scroll",
  "ui.drag",
  "ui.batch",
  "ui.insert_line",
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

interface UiSnapshotSession {
  context: UiMutationContext;
  view: MarkdownView;
  editor: MarkdownView["editor"];
  cm: UiMutationContext["targetCm"];
  path: string;
  before: string;
  revision: number;
  commandRevision: number;
  conflicted: boolean;
  depth: number;
}

interface SnapshotGuard {
  revision: number;
  commandRevision: number;
  postContent: string | null | undefined;
  conflicted: boolean;
}

export class VaultOpsService {
  private readonly app: App;
  private readonly getPermissionMode: () => VaultPermissionMode;
  private readonly getAllowHiddenReads: () => boolean;
  private readonly uiControl: UiControlService | null;
  private readonly getAllowUiControl: () => boolean;
  private readonly onAgentActivity:
    | ((caller: string, targetPath: string | undefined, action: string, change?: VaultTextChange) => void)
    | null;
  private readonly auditEntries: VaultAuditEntry[] = [];
  private readonly auditListeners = new Set<() => void>();
  private readonly pathQueues = new Map<string, Promise<unknown>>();
  private readonly pendingUiSnapshots = new Set<UiSnapshotSession>();
  private readonly noteRevisions = new Map<string, number>();
  private readonly nativeWrites = new Map<string, number>();
  private readonly snapshotGuards = new WeakMap<VaultMutationSnapshot, SnapshotGuard>();
  private readonly destructiveUndoPaths = new Set<string>();
  private commandRevision = 0;
  private commandsInFlight = 0;
  private auditSeq = 0;

  constructor(options: {
    app: App;
    getPermissionMode: () => VaultPermissionMode;
    getAllowHiddenReads: () => boolean;
    uiControl?: UiControlService | null;
    getAllowUiControl?: () => boolean;
    onAgentActivity?: (caller: string, targetPath: string | undefined, action: string, change?: VaultTextChange) => void;
  }) {
    this.app = options.app;
    this.getPermissionMode = options.getPermissionMode;
    this.getAllowHiddenReads = options.getAllowHiddenReads;
    this.uiControl = options.uiControl ?? null;
    this.getAllowUiControl = options.getAllowUiControl ?? (() => false);
    this.onAgentActivity = options.onAgentActivity ?? null;
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

    const finishNativeWrite = this.trackNativeWrite(method, params);
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
    } finally {
      finishNativeWrite();
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
    return this.withPathLock(snap.path, async () => {
      if (entry.undone) {
        throw new Error("This mutation has already been undone.");
      }
      const guard = this.snapshotGuards.get(snap);
      if (guard && (guard.conflicted || guard.revision !== this.noteRevision(snap.path) ||
        guard.commandRevision !== this.commandRevision ||
        this.hasPendingWrite(snap.path))) {
        throw this.undoConflict(snap.path);
      }
      const finishNativeWrite = this.beginNativeWrite([snap.path]);
      try {
        if (snap.kind === "created") {
          const created = this.app.vault.getAbstractFileByPath(snap.path);
          if (!(created instanceof TFile) || !guard || typeof guard.postContent !== "string") {
            throw this.undoConflict(snap.path);
          }
          const persisted = await this.app.vault.read(created);
          this.assertUndoStillCurrent(snap.path, guard);
          if (this.app.vault.getAbstractFileByPath(snap.path) !== created || persisted !== guard.postContent ||
            this.liveSourceViews(snap.path).some((view) => view.editor.getValue() !== guard.postContent)) {
            throw this.undoConflict(snap.path);
          }
          // Hold the write guard from final validation until the destructive API settles.
          this.destructiveUndoPaths.add(snap.path);
          try {
            await this.app.fileManager.trashFile(created);
          } finally {
            this.destructiveUndoPaths.delete(snap.path);
          }
          entry.undone = true;
          this.notifyAudit();
          return `Moved created note '${snap.path}' to trash.`;
        }

        if (snap.kind === "modified" && typeof snap.previousContent === "string") {
          await this.restoreModifiedSnapshot(snap, guard);
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
      } finally {
        if (entry.undone) this.noteRevisions.set(snap.path, this.noteRevision(snap.path) + 1);
        finishNativeWrite();
      }
    });
  }

  private undoConflict(path: string): BridgeRpcError {
    return new BridgeRpcError("undo_conflict", `Cannot undo '${path}': another change overlaps or follows this change.`);
  }

  private noteRevision(path: string): number {
    return this.noteRevisions.get(path) ?? 0;
  }

  private hasPendingWrite(path: string): boolean {
    return this.commandsInFlight > 0 || (this.nativeWrites.get(path) ?? 0) > 0 ||
      [...this.pendingUiSnapshots].some((session) => session.path === path);
  }

  private beginNativeWrite(paths: string[]): () => void {
    for (const path of paths) this.assertNoDestructiveUndo(path);
    for (const path of paths) {
      this.nativeWrites.set(path, (this.nativeWrites.get(path) ?? 0) + 1);
      for (const session of this.pendingUiSnapshots) {
        if (session.path === path) {
          session.conflicted = true;
        }
      }
    }
    return () => {
      for (const path of paths) {
        const count = (this.nativeWrites.get(path) ?? 1) - 1;
        if (count <= 0) this.nativeWrites.delete(path);
        else this.nativeWrites.set(path, count);
      }
    };
  }

  private trackNativeWrite(method: string, params: Record<string, unknown>): () => void {
    if (method === "commands.execute") {
      this.assertNoDestructiveUndo();
      // Arbitrary commands have unknown write scope, so invalidate all existing captures and guards.
      this.commandRevision++;
      this.commandsInFlight++;
      for (const session of this.pendingUiSnapshots) session.conflicted = true;
      return () => {
        this.commandsInFlight--;
        this.commandRevision++;
      };
    }
    if (!WRITE_METHODS.has(method) || method.startsWith("workspace.")) {
      return () => undefined;
    }
    const paths = new Set<string>();
    if (typeof params.path === "string") {
      const path = method === "canvas.upsert_node" && !params.path.endsWith(".canvas")
        ? `${params.path}.canvas` : params.path;
      paths.add(normalizePath(path));
    }
    if (typeof params.newPath === "string") paths.add(normalizePath(params.newPath));
    if (method.startsWith("editor.")) {
      const path = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path;
      if (path) paths.add(path);
    }
    return this.beginNativeWrite([...paths]);
  }

  private assertNoDestructiveUndo(path?: string): void {
    if (path ? this.destructiveUndoPaths.has(path) : this.destructiveUndoPaths.size > 0) {
      throw new BridgeRpcError("undo_in_progress", "A created-note Undo is in progress; retry the write afterward.");
    }
  }

  private liveSourceViews(path: string): MarkdownView[] {
    const views: MarkdownView[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path && leaf.view.getMode() === "source") {
        views.push(leaf.view);
      }
    });
    return views;
  }

  private assertUndoStillCurrent(path: string, guard: SnapshotGuard): void {
    if (guard.revision !== this.noteRevision(path) || guard.commandRevision !== this.commandRevision ||
      this.commandsInFlight > 0 || (this.nativeWrites.get(path) ?? 0) > 1 ||
      [...this.pendingUiSnapshots].some((session) => session.path === path)) {
      throw this.undoConflict(path);
    }
  }

  private async restoreModifiedSnapshot(snap: VaultMutationSnapshot, guard?: SnapshotGuard): Promise<void> {
    const restored = snap.previousContent;
    if (typeof restored !== "string" || !guard || guard.postContent === undefined) {
      throw this.undoConflict(snap.path);
    }
    const existing = this.app.vault.getAbstractFileByPath(snap.path);
    if (guard.postContent === null) {
      if (existing) throw this.undoConflict(snap.path);
      await this.ensureParentFolders(snap.path);
      await this.app.vault.create(snap.path, restored);
    } else {
      if (!(existing instanceof TFile)) throw this.undoConflict(snap.path);
      const live = this.liveSourceViews(snap.path);
      if (live.length > 0) {
        const persisted = await this.app.vault.read(existing);
        this.assertUndoStillCurrent(snap.path, guard);
        const currentLive = this.liveSourceViews(snap.path);
        if ((persisted !== restored && persisted !== guard.postContent) || currentLive.length === 0 ||
          currentLive.some((view) => view.editor.getValue() !== guard.postContent)) {
          throw this.undoConflict(snap.path);
        }
        // No await between validating the live buffers and replacing the owned change.
        for (const view of currentLive) view.editor.setValue(restored);
      } else {
        await this.app.vault.process(existing, (current) => {
          this.assertUndoStillCurrent(snap.path, guard);
          if (current !== guard.postContent || this.liveSourceViews(snap.path).length > 0) {
            throw this.undoConflict(snap.path);
          }
          return restored;
        });
      }
    }
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

  private async pointAtUiResult(
    caller: string,
    target: PointAtResultTarget,
    label: string
  ): Promise<void> {
    try {
      await this.uiControl?.pointAtResult(caller, target, label);
    } catch {
      // Passive visual feedback must never fail a completed operation.
    }
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
      return ui.waitFor(params, caller);
    }
    if (method === "ui.locate") {
      return ui.locate(params, caller);
    }

    let result: unknown;
    let summary: string;
    if (method === "ui.click") {
      result = await ui.click(params, caller);
      summary = "Clicked in the Obsidian window.";
    } else if (method === "ui.type") {
      result = await ui.type(params, caller);
      summary = `Typed ${asStr(params.text).length} characters in the Obsidian window.`;
    } else if (method === "ui.press_key") {
      result = await ui.pressKey(params, caller);
      const mods = Array.isArray(params.modifiers) ? params.modifiers.map(String) : [];
      summary = `Pressed ${[...mods, asStr(params.key)].join("+")} in the Obsidian window.`;
    } else if (method === "ui.scroll") {
      result = await ui.scroll(params, caller);
      summary = "Scrolled in the Obsidian window.";
    } else if (method === "ui.drag") {
      result = await ui.drag(params, caller);
      summary = "Dragged in the Obsidian window.";
    } else if (method === "ui.insert_line") {
      result = await ui.insertLine(params, caller);
      summary = "Inserted a line at a note anchor in the Obsidian window.";
    } else {
      result = await ui.batch(params, caller);
      const stepCount = Array.isArray(params.steps) ? params.steps.length : 0;
      summary = `Executed ${stepCount} UI batch steps in the Obsidian window.`;
    }

    this.recordAudit({
      method,
      caller,
      allowed: true,
      summary,
    });
    return result;
  }

  /** Called by the UI service inside its input lock, with the actual target editor. */
  captureUiMutation(context: UiMutationContext, targetView?: MarkdownView | null): MutationCompleteCallback {
    this.assertNoDestructiveUndo();
    const notePath = context.notePath;
    if (!notePath) {
      return () => undefined;
    }
    const suppliedView = context.targetView;
    if (suppliedView !== undefined && !(suppliedView instanceof MarkdownView)) {
      throw new BridgeRpcError("ui_snapshot_unavailable", "The original Markdown view cannot be verified.");
    }
    let view = suppliedView instanceof MarkdownView ? suppliedView : targetView ?? null;
    if (!view) {
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (view) {
          return;
        }
        const candidate = leaf.view;
        const paneId = (leaf as unknown as { id?: string }).id;
        if (
          candidate instanceof MarkdownView && candidate.file?.path === notePath &&
          (!context.paneId || paneId === context.paneId)
        ) {
          view = candidate;
        }
      });
    }
    // Non-note controls can carry DOM fallback metadata; they have no note preimage.
    if (!view) {
      return () => undefined;
    }
    if (view.file?.path !== notePath) {
      throw new BridgeRpcError("ui_snapshot_unavailable", `Cannot capture the target editor for '${notePath}'.`);
    }
    if (context.targetCm && (view.editor as unknown as { cm?: unknown }).cm !== context.targetCm) {
      throw new BridgeRpcError("ui_snapshot_unavailable", `The original editor for '${notePath}' changed.`);
    }
    const editorView = view;
    // Only nested helpers for this caller and action share a change record.
    let session = [...this.pendingUiSnapshots].find((pending) => pending.view === editorView &&
      pending.path === notePath && pending.context.caller === context.caller &&
      pending.context.action === context.action);
    if (session) {
      session.depth++;
    } else {
      session = {
        context, view: editorView, editor: editorView.editor, cm: context.targetCm, path: notePath,
        before: editorView.getMode() === "source" ? editorView.editor.getValue() : editorView.getViewData(),
        revision: this.noteRevision(notePath),
        commandRevision: this.commandRevision,
        conflicted: this.commandsInFlight > 0 || (this.nativeWrites.get(notePath) ?? 0) > 0,
        depth: 1,
      };
      for (const pending of this.pendingUiSnapshots) {
        if (pending.path === notePath) {
          pending.conflicted = true;
          session.conflicted = true;
        }
      }
      this.pendingUiSnapshots.add(session);
    }
    const captured = session;
    let completed = false;
    return async (completion) => {
      if (completed) {
        return;
      }
      completed = true;
      if (--captured.depth > 0) return;
      try {
        const sameEditor = editorView.file?.path === notePath && editorView.editor === captured.editor &&
          (!captured.cm || (editorView.editor as unknown as { cm?: unknown }).cm === captured.cm);
        let partialContent: string | undefined;
        if (completion?.abortedAfterNoteSwitch && completion.edits?.length) {
          let text = captured.before;
          let inserted = 0;
          let valid = true;
          for (const edit of completion.edits) {
            if (!Number.isInteger(edit.from) || !Number.isInteger(edit.to) ||
              edit.from < 0 || edit.to < edit.from || edit.to > text.length || typeof edit.insert !== "string") {
              valid = false;
              break;
            }
            text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
            inserted += edit.insert.length;
          }
          if (valid && inserted === completion.insertedChars) partialContent = text;
        }
        const unverifiedPartial = Boolean(completion?.abortedAfterNoteSwitch &&
          (completion.insertedChars ?? 0) > 0 && partialContent === undefined);
        let postContent: string | undefined;
        try {
          postContent = unverifiedPartial ? undefined : partialContent ?? (sameEditor
            ? editorView.getMode() === "source" ? captured.editor.getValue() : editorView.getViewData()
            : await this.app.vault.read(this.requireFile(notePath)));
          if (!sameEditor && partialContent === undefined) captured.conflicted = true;
        } catch {
          // Preserve the partial-operation audit without replacing its original failure.
          captured.conflicted = true;
        }
        if (postContent === captured.before && !unverifiedPartial) return;
        this.pendingUiSnapshots.delete(captured);
        this.recordAudit({
          method: `ui.${context.action}`,
          caller: context.caller,
          targetPath: notePath,
          allowed: true,
          summary: `${completion?.ok === false ? "Partially changed" : "Changed"} '${notePath}' via ${context.action}${context.paneId ? ` in pane '${context.paneId}'` : ""}.${unverifiedPartial ? ` ${completion?.insertedChars ?? 0} characters reported; final content unverified.` : ""}`,
          snapshot: { kind: "modified", path: notePath, previousContent: captured.before },
          postContent,
          snapshotConflicted: captured.conflicted || captured.revision !== this.noteRevision(notePath) ||
            captured.commandRevision !== this.commandRevision,
        });
      } finally {
        this.pendingUiSnapshots.delete(captured);
      }
    };
  }

  private withPathLock<T>(pathKey: string, task: () => Promise<T>): Promise<T> {
    const prev = this.pathQueues.get(pathKey) ?? Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.then(
      () => {
        if (this.pathQueues.get(pathKey) === tail) {
          this.pathQueues.delete(pathKey);
        }
      },
      () => {
        if (this.pathQueues.get(pathKey) === tail) {
          this.pathQueues.delete(pathKey);
        }
      }
    );
    this.pathQueues.set(pathKey, tail);
    return run;
  }

  private notifyActivity(
    caller: string,
    targetPath: string | undefined,
    action: string,
    beforeContent?: string,
    afterContent?: string
  ): void {
    try {
      const change = beforeContent !== undefined && afterContent !== undefined
        ? editedTextRange(beforeContent, afterContent)
        : undefined;
      this.onAgentActivity?.(caller, targetPath, action, change);
    } catch {
      // Visual cursor notifications must never fail a vault operation.
    }
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
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        const buffers: Array<{ view: MarkdownView; content: string }> = [];
        this.app.workspace.iterateAllLeaves((leaf) => {
          const view = leaf.view;
          if (view instanceof MarkdownView && view.file?.path === relPath && view.getMode() === "source") {
            buffers.push({ view, content: view.editor.getValue() });
          }
        });
        // Prefer the focused split if several editors display this note.
        const live = buffers.find((buffer) => buffer.view === activeView) ?? buffers[0];
        const content = live ? live.content : await this.app.vault.cachedRead(file);
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
          size: Buffer.byteLength(content, "utf8"),
          mtime: file.stat.mtime,
          content,
          source: live ? "editor" : "vault",
          conflictingBuffers: buffers.some((buffer) => buffer.content !== content),
          metadataSource: "cache",
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
        return this.withPathLock(relPath, async () => {
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
            let prev = await this.app.vault.read(existing);
            await this.app.vault.process(existing, (current) => {
              prev = current;
              return content;
            });
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
              postContent: content,
            });
            this.notifyActivity(caller, relPath, "write", prev, content);
            await this.pointAtUiResult(caller, { notePath: relPath, prefer: "file-tree" }, "create");
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
            postContent: content,
          });
          this.notifyActivity(caller, created.path, "create", "", content);
          await this.pointAtUiResult(caller, { notePath: created.path, prefer: "file-tree" }, "create");
          return { path: created.path, created: true, updated: false, bytes: content.length };
        });
      }

      case "vault.update_note": {
        const relPath = this.safePath(params.path, true);
        const mode = asStr(params.mode, "append");
        const text = asStr(params.content);
        const heading = typeof params.heading === "string" ? params.heading.trim() : "";
        const search = typeof params.search === "string" ? params.search : "";

        return this.withPathLock(relPath, async () => {
          const file = this.requireFile(relPath);
          let previousContent = await this.app.vault.read(file);

          const updatedContent = await this.app.vault.process(file, (current) => {
            previousContent = current;
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
            postContent: updatedContent,
          });
          this.notifyActivity(caller, file.path, "edit", previousContent, updatedContent);

          return { path: file.path, mode, length: updatedContent.length };
        });
      }

      case "vault.patch_frontmatter": {
        const relPath = this.safePath(params.path, true);
        const setObj =
          params.set && typeof params.set === "object"
            ? (params.set as Record<string, unknown>)
            : {};
        const unsetKeys = Array.isArray(params.unset)
          ? params.unset.map((k) => String(k))
          : [];

        return this.withPathLock(relPath, async () => {
          const file = this.requireFile(relPath);
          const previousContent = await this.app.vault.read(file);

          await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(setObj)) {
              fm[k] = v;
            }
            for (const k of unsetKeys) {
              delete fm[k];
            }
          });

          let updatedContent: string | undefined;
          try {
            updatedContent = await this.app.vault.read(file);
          } catch {
            // Keep the successful write; without a verified postimage Undo must refuse.
          }
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
            postContent: updatedContent,
          });
          this.notifyActivity(caller, file.path, "props", previousContent, updatedContent);

          return {
            path: file.path,
            updatedKeys: Object.keys(setObj),
            removedKeys: unsetKeys,
          };
        });
      }

      case "vault.rename_note": {
        const fromPath = this.safePath(params.path, true);
        const toPath = this.safePath(params.newPath, true);
        const [firstLock, secondLock] = [fromPath, toPath].sort();
        const doRename = async () => {
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
          this.notifyActivity(caller, toPath, "rename");
          await this.pointAtUiResult(caller, { notePath: toPath, prefer: "file-tree" }, "rename");

          return { previousPath: fromPath, path: toPath };
        };
        return this.withPathLock(firstLock, () =>
          firstLock === secondLock ? doRename() : this.withPathLock(secondLock, doRename)
        );
      }

      case "vault.trash_note": {
        const relPath = this.safePath(params.path, true);
        return this.withPathLock(relPath, async () => {
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
            postContent: null,
          });
          this.notifyActivity(caller, relPath, "trash");

          return { trashed: true, path: relPath };
        });
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

        return this.withPathLock(canvasPath, async () => {
          const existing = this.app.vault.getAbstractFileByPath(canvasPath);
          if (existing instanceof TFile) {
            let prevText = await this.app.vault.read(existing);
            const updatedText = await this.app.vault.process(existing, (raw) => {
              prevText = raw;
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
              postContent: updatedText,
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
              postContent: JSON.stringify(doc, null, 2) + "\n",
            });
          }
          this.notifyActivity(caller, canvasPath, "canvas");

          return { path: canvasPath, nodeId };
        });
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

        const leafEl =
          (leaf as unknown as { containerEl?: Element }).containerEl ??
          leaf.view?.containerEl ??
          null;
        await this.pointAtUiResult(
          caller,
          { notePath: file.path, element: leafEl, prefer: "leaf" },
          "open"
        );

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
        const previousContent = mdView.editor.getValue();
        mdView.editor.replaceSelection(replacement);
        this.recordAudit({
          method,
          caller,
          targetPath: mdView.file?.path,
          allowed: true,
          summary: `Replaced active editor selection (${replacement.length} chars).`,
        });
        this.notifyActivity(caller, mdView.file?.path, "edit", previousContent, mdView.editor.getValue());
        return { updated: true, file: mdView.file?.path ?? null };
      }

      case "editor.insert_at_cursor": {
        const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!mdView) {
          throw new BridgeRpcError("no_active_editor", "No Markdown editor is currently focused.");
        }
        const text = asStr(params.text);
        const previousContent = mdView.editor.getValue();
        const cursor = mdView.editor.getCursor();
        mdView.editor.replaceRange(text, cursor);
        this.recordAudit({
          method,
          caller,
          targetPath: mdView.file?.path,
          allowed: true,
          summary: `Inserted ${text.length} chars at line ${cursor.line + 1}.`,
        });
        this.notifyActivity(caller, mdView.file?.path, "edit", previousContent, mdView.editor.getValue());
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
        const commandName = this.getCommandRegistry()[commandId]?.name?.trim() || commandId;
        const activePath = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path;
        await this.pointAtUiResult(
          caller,
          { ...(activePath ? { notePath: activePath } : {}), prefer: "modal" },
          `command: ${commandName}`
        );
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
    postContent?: string | null;
    snapshotConflicted?: boolean;
  }): void {
    if (entry.snapshot) {
      const path = entry.snapshot.path;
      const revision = this.noteRevision(path) + 1;
      this.noteRevisions.set(path, revision);
      this.snapshotGuards.set(entry.snapshot, {
        revision,
        commandRevision: this.commandRevision,
        postContent: entry.postContent,
        conflicted: Boolean(entry.snapshotConflicted) || this.commandsInFlight > 0 ||
          (this.nativeWrites.get(path) ?? 0) > 1 ||
          [...this.pendingUiSnapshots].some((pending) => pending.path === path),
      });
      for (const pending of this.pendingUiSnapshots) {
        if (pending.path === path) pending.conflicted = true;
      }
    } else if (entry.allowed && entry.targetPath && WRITE_METHODS.has(entry.method) &&
      !entry.method.startsWith("workspace.")) {
      this.noteRevisions.set(entry.targetPath, this.noteRevision(entry.targetPath) + 1);
      for (const pending of this.pendingUiSnapshots) {
        if (pending.path === entry.targetPath) pending.conflicted = true;
      }
    }
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
