import type { MarkdownView, TFile } from "obsidian";
import type { UiMutationContext } from "../control/ui-control";
import type { VaultAuditEntry, VaultMutationSnapshot } from "../domain/types";
import { BridgeRpcError, WRITE_METHODS } from "./policy";

export const MAX_AUDIT_ENTRIES = 200;
export const MAX_SINGLE_SNAPSHOT_BYTES = 512 * 1024;
export const MAX_TOTAL_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export interface UiFileView {
  file?: TFile | null;
  getViewType?: () => string;
  getViewData?: () => string;
  setViewData?: (data: string, clear: boolean) => void;
  save?: (clear?: boolean) => Promise<void>;
  canvas?: {
    getData?: () => unknown;
    setData?: (data: unknown) => void;
    requestSave?: (history?: boolean) => void;
  };
  containerEl?: HTMLElement;
}

export interface SnapshotGuard {
  revision: number;
  postContent: string | null | undefined;
  conflicted: boolean;
  fileView?: WeakRef<UiFileView>;
}

export interface UiSnapshotSession {
  context: UiMutationContext;
  view: MarkdownView;
  editor: MarkdownView["editor"];
  cm: UiMutationContext["targetCm"];
  path: string;
  before: string;
  revision: number;
  conflicted: boolean;
  depth: number;
}

export interface FileUiSnapshotSession {
  context: UiMutationContext;
  path: string;
  view: UiFileView | null;
  viewPath: string | null;
  before: string;
  revision: number;
  conflicted: boolean;
  depth: number;
}

export interface AuditRecordInput {
  method: string;
  caller: string;
  targetPath?: string;
  allowed: boolean;
  summary: string;
  snapshot?: VaultMutationSnapshot;
  postContent?: string | null;
  snapshotConflicted?: boolean;
  fileView?: UiFileView;
}

export class MutationLedger {
  private readonly auditEntries: VaultAuditEntry[] = [];
  private readonly auditListeners = new Set<() => void>();
  private readonly pathQueues = new Map<string, Promise<unknown>>();
  private readonly pendingUiSnapshots = new Set<UiSnapshotSession>();
  private readonly pendingFileSnapshots = new Set<FileUiSnapshotSession>();
  private readonly noteRevisions = new Map<string, number>();
  private readonly nativeWrites = new Map<string, number>();
  private readonly snapshotGuards = new WeakMap<VaultMutationSnapshot, SnapshotGuard>();
  private readonly destructiveUndoPaths = new Set<string>();
  private readonly commandWrites = new Map<string, number>();
  private auditSeq = 0;

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

  getUndoEntry(auditId: string): VaultAuditEntry | undefined {
    return this.auditEntries.find((item) => item.id === auditId);
  }

  removeUndoEntry(auditId: string): boolean {
    const entry = this.getUndoEntry(auditId);
    if (!entry || !entry.snapshot) {
      return false;
    }
    entry.snapshot = undefined;
    this.notifyAudit();
    return true;
  }

  markEntryUndone(entry: VaultAuditEntry): void {
    entry.undone = true;
    this.notifyAudit();
  }

  getSnapshotGuard(snapshot: VaultMutationSnapshot): SnapshotGuard | undefined {
    return this.snapshotGuards.get(snapshot);
  }

  noteRevision(path: string): number {
    return this.noteRevisions.get(path) ?? 0;
  }

  bumpRevision(path: string): number {
    const next = this.noteRevision(path) + 1;
    this.noteRevisions.set(path, next);
    return next;
  }

  bumpRevisions(paths: Iterable<string>): void {
    for (const path of paths) {
      this.bumpRevision(path);
    }
  }

  undoConflict(path: string): BridgeRpcError {
    return new BridgeRpcError(
      "undo_conflict",
      `Cannot undo '${path}': another change overlaps or follows this change.`
    );
  }

  hasPendingWrite(path: string): boolean {
    return (
      (this.commandWrites.get(path) ?? 0) > 0 ||
      (this.nativeWrites.get(path) ?? 0) > 0 ||
      this.activeUiSnapshots().some((session) => session.path === path)
    );
  }

  getNativeWriteCount(path: string): number {
    return this.nativeWrites.get(path) ?? 0;
  }

  activeUiSnapshots(): Array<{ path: string; conflicted: boolean }> {
    return [...this.pendingUiSnapshots, ...this.pendingFileSnapshots];
  }

  markUiSnapshotsConflicted(path: string): void {
    for (const session of this.activeUiSnapshots()) {
      if (session.path === path) {
        session.conflicted = true;
      }
    }
  }

  collectTrackedPaths(): Set<string> {
    const paths = new Set<string>();
    for (const entry of this.auditEntries) {
      if (entry.snapshot) {
        paths.add(entry.snapshot.path);
      }
    }
    for (const session of this.activeUiSnapshots()) {
      paths.add(session.path);
    }
    return paths;
  }

  beginNativeWrite(paths: string[]): () => void {
    for (const path of paths) {
      this.assertNoDestructiveUndo(path);
    }
    for (const path of paths) {
      this.nativeWrites.set(path, (this.nativeWrites.get(path) ?? 0) + 1);
      this.markUiSnapshotsConflicted(path);
    }
    return () => {
      for (const path of paths) {
        const count = (this.nativeWrites.get(path) ?? 1) - 1;
        if (count <= 0) {
          this.nativeWrites.delete(path);
        } else {
          this.nativeWrites.set(path, count);
        }
      }
    };
  }

  beginCommandWrites(paths: Iterable<string>): () => void {
    const tracked = [...paths];
    for (const path of tracked) {
      this.commandWrites.set(path, (this.commandWrites.get(path) ?? 0) + 1);
    }
    return () => {
      for (const path of tracked) {
        const count = (this.commandWrites.get(path) ?? 1) - 1;
        if (count <= 0) {
          this.commandWrites.delete(path);
        } else {
          this.commandWrites.set(path, count);
        }
      }
    };
  }

  assertNoDestructiveUndo(path?: string): void {
    if (path ? this.destructiveUndoPaths.has(path) : this.destructiveUndoPaths.size > 0) {
      throw new BridgeRpcError(
        "undo_in_progress",
        "A created-note Undo is in progress; retry the write afterward."
      );
    }
  }

  async withDestructiveUndo<T>(path: string, task: () => Promise<T>): Promise<T> {
    this.destructiveUndoPaths.add(path);
    try {
      return await task();
    } finally {
      this.destructiveUndoPaths.delete(path);
    }
  }

  assertUndoStillCurrent(path: string, guard: SnapshotGuard): void {
    if (
      guard.revision !== this.noteRevision(path) ||
      (this.commandWrites.get(path) ?? 0) > 0 ||
      (this.nativeWrites.get(path) ?? 0) > 1 ||
      this.activeUiSnapshots().some((session) => session.path === path)
    ) {
      throw this.undoConflict(path);
    }
  }

  findPendingUiSnapshot(
    view: MarkdownView,
    path: string,
    caller: string,
    action: string
  ): UiSnapshotSession | undefined {
    return [...this.pendingUiSnapshots].find(
      (pending) =>
        pending.view === view &&
        pending.path === path &&
        pending.context.caller === caller &&
        pending.context.action === action
    );
  }

  addPendingUiSnapshot(session: UiSnapshotSession): void {
    for (const pending of this.activeUiSnapshots()) {
      if (pending.path === session.path) {
        pending.conflicted = true;
        session.conflicted = true;
      }
    }
    this.pendingUiSnapshots.add(session);
  }

  deletePendingUiSnapshot(session: UiSnapshotSession): void {
    this.pendingUiSnapshots.delete(session);
  }

  addPendingFileSnapshot(session: FileUiSnapshotSession): void {
    this.markUiSnapshotsConflicted(session.path);
    this.pendingFileSnapshots.add(session);
  }

  deletePendingFileSnapshot(session: FileUiSnapshotSession): void {
    this.pendingFileSnapshots.delete(session);
  }

  withPathLock<T>(pathKey: string, task: () => Promise<T>): Promise<T> {
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

  recordAudit(entry: AuditRecordInput): void {
    let storedSnapshot = entry.snapshot;
    if (storedSnapshot) {
      const snapBytes =
        (storedSnapshot.previousContent ? storedSnapshot.previousContent.length * 2 : 0) +
        (typeof entry.postContent === "string" ? entry.postContent.length * 2 : 0);
      if (snapBytes > MAX_SINGLE_SNAPSHOT_BYTES) {
        storedSnapshot = undefined;
      }
    }

    if (entry.snapshot) {
      const targetPath = entry.snapshot.path;
      const revision = this.bumpRevision(targetPath);
      if (entry.snapshot.previousPath && entry.snapshot.previousPath !== targetPath) {
        this.bumpRevision(entry.snapshot.previousPath);
      }
      if (storedSnapshot) {
        this.snapshotGuards.set(storedSnapshot, {
          revision,
          postContent: entry.postContent,
          fileView: entry.fileView ? new WeakRef(entry.fileView) : undefined,
          conflicted:
            Boolean(entry.snapshotConflicted) ||
            (this.nativeWrites.get(targetPath) ?? 0) > 1 ||
            this.activeUiSnapshots().some((pending) => pending.path === targetPath),
        });
      }
      this.markUiSnapshotsConflicted(targetPath);
    } else if (
      entry.allowed &&
      entry.targetPath &&
      WRITE_METHODS.has(entry.method) &&
      !entry.method.startsWith("workspace.")
    ) {
      this.bumpRevision(entry.targetPath);
      this.markUiSnapshotsConflicted(entry.targetPath);
    }

    this.auditEntries.unshift({
      id: `audit_${Date.now()}_${(this.auditSeq += 1)}`,
      timestamp: Date.now(),
      method: entry.method,
      caller: entry.caller,
      targetPath: entry.targetPath,
      allowed: entry.allowed,
      summary: entry.summary,
      snapshot: storedSnapshot,
    });
    if (this.auditEntries.length > MAX_AUDIT_ENTRIES) {
      this.auditEntries.length = MAX_AUDIT_ENTRIES;
    }

    // Enforce total snapshot memory budget by dropping oldest snapshot payloads first.
    let totalSnapBytes = 0;
    for (const item of this.auditEntries) {
      if (!item.snapshot) continue;
      const g = this.snapshotGuards.get(item.snapshot);
      const itemBytes =
        (item.snapshot.previousContent ? item.snapshot.previousContent.length * 2 : 0) +
        (typeof g?.postContent === "string" ? g.postContent.length * 2 : 0);
      if (totalSnapBytes + itemBytes > MAX_TOTAL_SNAPSHOT_BYTES) {
        item.snapshot = undefined;
      } else {
        totalSnapBytes += itemBytes;
      }
    }
    this.notifyAudit();
  }

  private notifyAudit(): void {
    for (const listener of this.auditListeners) {
      listener();
    }
  }
}
