import { MarkdownView, TFile, type App } from "obsidian";
import { BridgeRpcError, type VaultOpsService, type VaultTextChange } from "../bridge/vault-ops";
import type { AgentCursorOverlay } from "../control/agent-cursor";
import { resolveTopLevelElement } from "../control/nested-editors";
import type {
  CodeMirrorViewLike,
  ElementLeafContext,
  NoteLeafContext,
  UiMutationContext,
} from "../control/ui-control";
import { deliverToTerminal } from "../terminal/pty-host";

export interface ObsidianUiAdapterDeps {
  app: App;
  getVaultOps: () => VaultOpsService;
  cursorOverlay: AgentCursorOverlay;
  getShowAgentCursors: () => boolean;
  resolveCallerLabel: (caller: string) => string;
}

/**
 * Bridges Obsidian Workspace/MarkdownView/Bases/Canvas DOM structures with
 * UiControlService, VaultOpsService, and AgentCursorOverlay.
 */
export class ObsidianUiAdapter {
  private readonly deps: ObsidianUiAdapterDeps;
  private readonly notePaneIds = new WeakMap<MarkdownView, string>();
  private notePaneSeq = 0;

  constructor(deps: ObsidianUiAdapterDeps) {
    this.deps = deps;
  }

  getNotePaneId(view: MarkdownView, leafId?: string): string {
    if (leafId) {
      return leafId;
    }
    let paneId = this.notePaneIds.get(view);
    if (!paneId) {
      paneId = `markdown-pane-${++this.notePaneSeq}`;
      this.notePaneIds.set(view, paneId);
    }
    return paneId;
  }

  resolveEditorContext(el: Element): ElementLeafContext | null {
    const hostElement = resolveTopLevelElement(el) ?? el;
    const activeView = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
    let context: ElementLeafContext | null = null;
    this.deps.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view.containerEl.contains(hostElement)) {
        const file = (view as unknown as { file?: TFile | null }).file;
        if (!file) return;
        context = {
          notePath: file.path,
          pane:
            view instanceof MarkdownView
              ? this.getNotePaneId(view, (leaf as unknown as { id?: string }).id)
              : (leaf as unknown as { id?: string }).id,
          activePane: view === activeView,
        };
      }
    });
    return context;
  }

  deliverCapturedTerminalInput(element: Element, data: string): boolean {
    const leaves: Array<{ view: unknown }> = [];
    this.deps.app.workspace.iterateAllLeaves((leaf) => {
      leaves.push(leaf);
    });
    return deliverToTerminal(element, data, leaves);
  }

  resolveBasesRowPath(element: Element | null, targetView: unknown): string | undefined {
    if (!element) return undefined;
    const view = targetView as {
      file?: TFile | null;
      controller?: { view?: { getCellFromDom?: (element: Element) => unknown } };
    } | null;
    const table = view?.controller?.view;
    const cellElement = element.closest(".bases-td");
    if (table?.getCellFromDom && cellElement) {
      const cell = table.getCellFromDom(element) as {
        el?: Element;
        renderer?: { entry?: { file?: TFile } };
      } | null;
      const file = cell?.renderer?.entry?.file;
      if (
        cell?.el === cellElement &&
        file instanceof TFile &&
        file.extension === "md" &&
        this.deps.app.vault.getAbstractFileByPath(file.path) === file
      ) {
        return file.path;
      }
      return undefined;
    }
    let row = element.closest(".bases-tr, .bases-table-row, [role='row']");
    for (
      let current: Element | null = element, depth = 0;
      !row && current && depth < 20;
      current = current.parentElement, depth++
    ) {
      if (current.parentElement?.classList?.contains("bases-tbody")) {
        row = current;
      }
    }
    if (!row) return undefined;
    const nameCell =
      row.querySelector?.('.bases-td[data-property="file.name"]') ?? row.querySelector?.(".bases-td");
    const paths = new Set<string>();
    const nodes = [
      row,
      ...Array.from(nameCell?.querySelectorAll("[data-href], a.internal-link") ?? []),
      ...Array.from(row.querySelectorAll("[data-path], [data-file], [data-file-path]")),
    ];
    for (const node of nodes) {
      for (const attribute of ["data-path", "data-file", "data-file-path", "data-href"]) {
        const attrPath = node.getAttribute(attribute);
        if (!attrPath) continue;
        const file =
          this.deps.app.vault.getAbstractFileByPath(attrPath) ??
          (attribute === "data-href"
            ? this.deps.app.metadataCache.getFirstLinkpathDest(attrPath, view?.file?.path ?? "")
            : null);
        if (file instanceof TFile && file.extension === "md") {
          paths.add(file.path);
        }
      }
    }
    return paths.size === 1 ? [...paths][0] : undefined;
  }

  captureUiMutation(context: UiMutationContext): ReturnType<VaultOpsService["captureUiMutation"]> {
    const vaultOps = this.deps.getVaultOps();
    const element = context.targetElement;
    const hostElement = resolveTopLevelElement(element);
    if (!context.notePath && !element && !context.targetView) {
      return vaultOps.captureUiMutation(context);
    }
    let targetView: unknown = context.targetView;
    const suppliedFile = (targetView as { file?: TFile | null } | null)?.file;
    this.deps.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      const file = (view as unknown as { file?: TFile | null }).file;
      if (
        hostElement &&
        file?.extension === "canvas" &&
        (file.path === context.notePath || (!context.notePath && !suppliedFile)) &&
        view.containerEl?.contains(hostElement)
      ) {
        targetView = view;
        return;
      }
      if (targetView) return;
      if (hostElement && view.containerEl?.contains(hostElement)) {
        targetView = view;
      } else if (
        !element &&
        view instanceof MarkdownView &&
        view.file?.path === context.notePath &&
        (!context.paneId ||
          this.getNotePaneId(view, (leaf as unknown as { id?: string }).id) === context.paneId)
      ) {
        targetView = view;
      }
    });
    const fileView = targetView as { file?: TFile | null; getViewType?: () => string } | undefined;
    const bound = { ...context, ...(targetView ? { targetView } : {}) };
    const isBases = fileView?.file?.extension === "base" || fileView?.getViewType?.() === "bases";
    const rowPath = isBases ? this.resolveBasesRowPath(element ?? null, targetView) : undefined;
    if (rowPath && bound.targetFilePath && rowPath !== bound.targetFilePath) {
      throw new BridgeRpcError(
        "ui_snapshot_unavailable",
        "The Bases cell no longer belongs to the requested row note."
      );
    }
    if (fileView?.file) {
      bound.notePath ??= fileView.file.path;
      if (isBases && !bound.targetFilePath) {
        bound.targetFilePath = rowPath;
      }
    }
    const button = element?.closest("button, [role='button']");
    const modal = button?.closest(".modal");
    if (
      !bound.expectedFileOperation &&
      modal &&
      /^(delete|move to trash)$/i.test(button?.textContent?.trim() ?? "")
    ) {
      const text = modal.textContent ?? "";
      const names = [...text.matchAll(/["“]([^"”]+)["”]/g)].map((match) => match[1]);
      const files = this.deps.app.vault
        .getFiles()
        .filter((file) => names.includes(file.path) || names.includes(file.name));
      if (files.length !== 1) {
        throw new BridgeRpcError(
          "ui_snapshot_unavailable",
          "Cannot uniquely verify the file named by this Delete confirmation."
        );
      }
      bound.expectedFileOperation = { kind: "trash", path: files[0].path };
    }
    const captured = vaultOps.captureUiMutation(bound, targetView);
    if (!rowPath) {
      return captured;
    }
    return Promise.resolve(captured).then(async (complete) => {
      if (this.resolveBasesRowPath(element ?? null, targetView) !== rowPath) {
        await complete({ ok: false, errorCode: "ui_snapshot_unavailable" });
        throw new BridgeRpcError(
          "ui_snapshot_unavailable",
          "The Bases row changed while its preimage was being captured."
        );
      }
      return complete;
    });
  }

  resolveOpenNoteLeaf(notePath: string): (NoteLeafContext & { view: MarkdownView }) | null {
    const activeView = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
    let resolved: (NoteLeafContext & { view: MarkdownView }) | null = null;
    this.deps.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (
        !(view instanceof MarkdownView) ||
        view.file?.path !== notePath ||
        view.getMode() !== "source"
      ) {
        return;
      }
      if (view.containerEl.ownerDocument !== window.document) {
        return;
      }
      const rect = view.containerEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || (resolved && view !== activeView)) {
        return;
      }
      resolved = {
        view,
        path: notePath,
        pane: this.getNotePaneId(view, (leaf as unknown as { id?: string }).id),
        activePane: view === activeView,
        containerEl: view.containerEl,
        cm: (view.editor as unknown as { cm?: CodeMirrorViewLike }).cm ?? null,
        contentText: view.editor.getValue(),
      };
    });
    return resolved;
  }

  notifyVaultCursorActivity(
    caller: string,
    targetPath: string | undefined,
    _action: string,
    change?: VaultTextChange
  ): void {
    if (!this.deps.getShowAgentCursors()) {
      return;
    }
    this.deps.cursorOverlay.clearAgent(caller);
    if (!targetPath || !change) {
      return;
    }
    const leaf = this.resolveOpenNoteLeaf(targetPath);
    const cm = leaf?.cm;
    if (!leaf || !cm?.coordsAtPos || cm.state?.doc?.toString() !== change.after) {
      return;
    }
    this.deps.cursorOverlay.notifyNoteUpdated(targetPath);
    let pos = change.from + change.insertLength;
    if (!Number.isInteger(pos) || pos < 0 || pos > change.after.length) {
      return;
    }
    while (pos > change.from && /[\r\n]/.test(change.after[pos - 1] ?? "")) {
      pos--;
    }
    const caret = cm.coordsAtPos(pos);
    if (
      !caret ||
      !Number.isFinite(caret.left) ||
      !Number.isFinite(caret.top) ||
      !Number.isFinite(caret.bottom)
    ) {
      return;
    }
    const bounds = (cm.scrollDOM ?? leaf.containerEl).getBoundingClientRect();
    const containerBounds = leaf.containerEl.getBoundingClientRect();
    const left = Math.max(0, bounds.left, containerBounds.left);
    const right = Math.min(window.innerWidth, bounds.right, containerBounds.right);
    const top = Math.max(0, bounds.top, containerBounds.top);
    const bottom = Math.min(window.innerHeight, bounds.bottom, containerBounds.bottom);
    const caretRight = caret.right ?? caret.left;
    const caretBottom = caret.bottom ?? caret.top;
    if (caret.left < left || caretRight > right || caret.top < top || caretBottom > bottom) {
      return;
    }
    const statusBar = window.document
      .querySelector<HTMLElement>(".status-bar")
      ?.getBoundingClientRect();
    if (
      statusBar &&
      statusBar.width > 0 &&
      statusBar.height > 0 &&
      caretRight >= statusBar.left &&
      caret.left <= statusBar.right &&
      caretBottom > statusBar.top &&
      caret.top < statusBar.bottom
    ) {
      return;
    }
    const context = {
      notePath: targetPath,
      pane: leaf.pane,
      leafId: leaf.pane,
      pos,
      cm,
      containerEl: leaf.view.containerEl,
      view: leaf.view,
      getLeafNotePath: () => leaf.view.file?.path ?? null,
    };
    this.deps.cursorOverlay.moveTo(
      caller,
      this.deps.resolveCallerLabel(caller),
      caret.left,
      (caret.top + caretBottom) / 2,
      "note_update",
      context
    );
    this.deps.cursorOverlay.parkAgent(caller, context);
  }
}
