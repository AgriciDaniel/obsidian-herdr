// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Daniel Agrici. Part of the UI control module, ported from Obsidian Control Center.
// See src/control/LICENSE and the NOTICE file in the repository root.

import { EditorView } from "@codemirror/view";
import type { AgentCursorOverlay, DocumentCursorContext, NoteDocChange } from "./agent-cursor";
import { buildKeyPress } from "./keys";

/** Subset of Electron's NativeImage used for screenshots. */
export interface NativeImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  toPNG(): Uint8Array;
  resize(options: { width: number; quality?: string }): NativeImageLike;
}

/** Subset of Electron's WebContents used for capture and trusted input. */
export interface WebContentsLike {
  capturePage(): Promise<NativeImageLike>;
  sendInputEvent(event: Record<string, unknown>): void;
  insertText(text: string): Promise<void> | void;
  getZoomFactor?(): number;
}

export interface AnchorTarget {
  note: string;
  line?: number;
  after?: string;
  heading?: string;
  at?: "start" | "end";
}

export type UiTarget = { selector: string } | { x: number; y: number } | AnchorTarget;

export class UiControlError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UiControlError";
    this.code = code;
  }
}

export const DEFAULT_INSPECT_SELECTOR =
  'button,input,textarea,select,[role="button"],[role="tab"],[aria-label],.nav-file-title,.workspace-leaf-resize-handle';

const MAX_TYPE_CHARS = 20000;
const MAX_WAIT_MS = 20000;
const MAX_BATCH_STEPS = 20;
const MAX_TYPING_CHUNKS = 40;
const TYPING_BUDGET_PER_100_CHARS_MS = 1400;
const CARET_SCROLL_MARGIN_LINES = 3;
const DEFAULT_LINE_HEIGHT_PX = 22;
const MODAL_SELECTOR = '.modal-container, .modal, .prompt, [role="dialog"]';
const HERDR_TERMINAL_PROTECTED_SELECTOR =
  '.herdr-terminal-pane, [data-type="herdr-terminal-view"], .herdr-terminal-host, .xterm, .xterm-helper-textarea';
const COMMUNITY_PLUGIN_PROTECTED_SELECTOR =
  '.installed-plugins-container, .community-plugin-item, .community-plugins-container, .community-plugin-info, [data-plugin-id]';
const SETTINGS_MODAL_PROTECTED_SELECTOR =
  '.mod-settings, .modal-container.mod-settings, .modal.mod-settings, [data-type="settings"]';

export type UiTypingSpeed = "visible" | "fast";

export interface CaretCoords {
  left: number;
  top: number;
  right?: number;
  bottom?: number;
}

export interface CodeMirrorDocLike {
  length: number;
  lines: number;
  toString(): string;
  line(n: number): { from: number; to: number; number: number; text: string };
}

export interface CodeMirrorViewLike {
  dom?: Element | null;
  contentDOM?: Element | null;
  scrollDOM?: HTMLElement | null;
  state?: {
    doc?: CodeMirrorDocLike;
    selection?: { main?: { head?: number; anchor?: number } };
  };
  coordsAtPos?(pos: number, side?: number): CaretCoords | null;
  dispatch?(spec: unknown): void;
  focus?(): void;
}

export interface ElementLeafContext {
  notePath?: string;
  pane?: string;
  activePane?: boolean;
}

export interface NoteLeafContext {
  path: string;
  pane: string;
  activePane: boolean;
  containerEl: Element;
  cm?: CodeMirrorViewLike | null;
  contentText?: string;
  view?: WorkspaceLeafLike["view"] | null;
  workspaceLeaf?: WorkspaceLeafLike | null;
}

export interface InspectedElement {
  selector: string;
  tag: string;
  role: string | null;
  label: string;
  text: string;
  value?: string;
  disabled: boolean;
  rect: { x: number; y: number; width: number; height: number };
  notePath?: string;
  pane?: string;
  activePane?: boolean;
}

export interface FocusState {
  tag: string | null;
  label: string;
  editable: boolean;
  password: boolean;
}

export type UiMutationAction = "click" | "type" | "press_key" | "insert_line" | "drag";

export interface UiMutationEdit {
  from: number;
  to: number;
  insert: string;
}

export interface UiMutationCompletion {
  ok: boolean;
  errorCode?: string;
  insertedChars?: number;
  edits?: UiMutationEdit[];
  abortedAfterNoteSwitch?: boolean;
}

export interface UiMutationContext {
  action: UiMutationAction;
  notePath: string | null;
  paneId: string | null;
  caller: string;
  targetView?: unknown;
  targetCm?: CodeMirrorViewLike | null;
}

export type MutationCompleteCallback = (
  completion?: UiMutationCompletion
) => void | Promise<void>;

export type BeforeMutationHook = (
  context: UiMutationContext
) => void | MutationCompleteCallback | Promise<void | MutationCompleteCallback>;

interface FocusSnapshot {
  element: HTMLElement | null;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: "forward" | "backward" | "none" | null;
  domRanges: Range[];
  visibleModals: Set<Element>;
}

export interface PointAtResultTarget {
  notePath?: string;
  selector?: string;
  element?: Element | null;
  prefer?: "auto" | "leaf" | "editor" | "file-tree" | "modal";
}

export interface PointAtResultOutput {
  shown: boolean;
  x?: number;
  y?: number;
  notePath?: string;
  label: string;
  durationMs?: number;
}

interface EditorTypingOwnership {
  expectedActive: Element | null;
  notePath: string | null;
  paneId: string | null;
  containerEl: Element | null;
  leaf: WorkspaceLeafLike | null;
  view: WorkspaceLeafLike["view"] | null;
  cm: CodeMirrorViewLike | null;
}

interface ActiveMutationRun {
  edits: UiMutationEdit[];
  insertedChars: number;
  abortedAfterNoteSwitch: boolean;
}

interface CapturedUserEvent {
  type: "keydown" | "keypress" | "beforeinput";
  key?: string;
  code?: string;
  keyCode?: number;
  charCode?: number;
  which?: number;
  data?: string | null;
  inputType?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
}

interface FocusShieldSession {
  userElement: HTMLElement | null;
  activeCount: number;
  captured: CapturedUserEvent[];
  detach: (() => void) | null;
}

interface ResolvedUiTarget {
  point: { x: number; y: number };
  element?: Element | null;
  isSelector?: boolean;
  notePath?: string;
  paneId?: string;
  containerEl?: Element | null;
  cm?: CodeMirrorViewLike | null;
  view?: WorkspaceLeafLike["view"] | null;
  workspaceLeaf?: WorkspaceLeafLike | null;
  pos?: number;
  scrolled?: boolean;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function base64FromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function hasNonZeroBox(
  rect:
    | {
        left?: number;
        top?: number;
        width?: number;
        height?: number;
        right?: number;
        bottom?: number;
      }
    | null
    | undefined
): rect is CaretCoords & { width?: number; height?: number } {
  if (!rect) {
    return false;
  }
  const left = rect.left;
  const top = rect.top;
  if (
    typeof left !== "number" ||
    !Number.isFinite(left) ||
    typeof top !== "number" ||
    !Number.isFinite(top)
  ) {
    return false;
  }
  const w = Number.isFinite(rect.width)
    ? (rect.width as number)
    : Math.max(0, (rect.right ?? left) - left);
  const h = Number.isFinite(rect.height)
    ? (rect.height as number)
    : Math.max(0, (rect.bottom ?? top) - top);
  return left !== 0 || top !== 0 || w > 0 || h > 0;
}

function rectMidY(rect: { top: number; bottom?: number; height?: number }): number {
  if (typeof rect.bottom === "number" && Number.isFinite(rect.bottom)) {
    return Math.round((rect.top + rect.bottom) / 2);
  }
  if (typeof rect.height === "number" && Number.isFinite(rect.height)) {
    return Math.round(rect.top + rect.height / 2);
  }
  return Math.round(rect.top);
}

function splitTypingChunks(text: string): string[] {
  const rawTokens = text.match(/\S+\s*|\s+/g) ?? [text];
  const fine: string[] = [];
  for (const token of rawTokens) {
    const cps = Array.from(token);
    if (cps.length <= 8) {
      fine.push(token);
    } else {
      for (let i = 0; i < cps.length; i += 8) {
        fine.push(cps.slice(i, i + 8).join(""));
      }
    }
  }
  if (fine.length <= MAX_TYPING_CHUNKS) {
    return fine;
  }
  const groupSize = Math.ceil(fine.length / MAX_TYPING_CHUNKS);
  const merged: string[] = [];
  for (let i = 0; i < fine.length; i += groupSize) {
    merged.push(fine.slice(i, i + groupSize).join(""));
  }
  return merged;
}

function isInputOrTextarea(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) {
    return false;
  }
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA") {
    return true;
  }
  try {
    return Boolean(el.matches?.("input,textarea"));
  } catch {
    return false;
  }
}

interface OpenFence {
  char: "`" | "~";
  length: number;
}

function nextFenceState(lineText: string, open: OpenFence | null): OpenFence | null {
  const trimmed = lineText.trimStart();
  if (!open) {
    const backtick = /^(`{3,})([^`]*)$/.exec(trimmed);
    if (backtick) {
      return { char: "`", length: backtick[1].length };
    }
    const tilde = /^(~{3,})(.*)$/.exec(trimmed);
    if (tilde) {
      return { char: "~", length: tilde[1].length };
    }
    return null;
  }
  const closeRe = open.char === "`" ? /^(`{3,})\s*$/ : /^(~{3,})\s*$/;
  const close = closeRe.exec(trimmed);
  if (close && close[1].length >= open.length) {
    return null;
  }
  return open;
}

/**
 * Lets agents see and operate the Obsidian window through Electron's own
 * capture and trusted input APIs. Runs inside the renderer, so it needs no
 * official CLI, remote debugging port, or vault identity check.
 */
export class UiControlService {
  private readonly win: Window;
  private readonly getWebContents: () => WebContentsLike | null;
  private readonly getCodeMirrorView: (() => CodeMirrorViewLike | null) | null;
  private readonly resolveElementContext:
    | ((el: Element) => ElementLeafContext | null)
    | null;
  private readonly resolveNoteLeaf: ((notePath: string) => NoteLeafContext | null) | null;
  private readonly beforeMutation: BeforeMutationHook | null;
  private readonly platform: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cursorOverlay: AgentCursorOverlay | null;
  private readonly resolveAgentLabel: (caller: string) => string;
  private readonly getUiTypingSpeed: () => UiTypingSpeed;
  private readonly getAllowUiInProtectedAreas: () => boolean;
  private queue: Promise<unknown> = Promise.resolve();
  private activeMutationRun: ActiveMutationRun | null = null;
  private activeShield: FocusShieldSession | null = null;
  private agentKeyDepth = 0;
  private agentKeyMatch: string | null = null;
  private agentInsertTextChunk: string | null = null;
  private deferredUserInputs: CapturedUserEvent[] = [];
  private replayingUserInput = false;

  constructor(options: {
    win: Window;
    getWebContents: () => WebContentsLike | null;
    getCodeMirrorView?: () => CodeMirrorViewLike | null;
    resolveElementContext?: (el: Element) => ElementLeafContext | null;
    resolveNoteLeaf?: ((notePath: string) => NoteLeafContext | null);
    beforeMutation?: BeforeMutationHook;
    platform?: string;
    sleep?: (ms: number) => Promise<void>;
    cursorOverlay?: AgentCursorOverlay | null;
    resolveAgentLabel?: (caller: string) => string;
    getUiTypingSpeed?: () => UiTypingSpeed;
    getAllowUiInProtectedAreas?: () => boolean;
  }) {
    this.win = options.win;
    this.getWebContents = options.getWebContents;
    this.getCodeMirrorView = options.getCodeMirrorView ?? null;
    this.resolveElementContext = options.resolveElementContext ?? null;
    this.resolveNoteLeaf = options.resolveNoteLeaf ?? null;
    this.beforeMutation = options.beforeMutation ?? null;
    this.platform = options.platform ?? process.platform;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => this.win.setTimeout(resolve, ms)));
    this.cursorOverlay = options.cursorOverlay ?? null;
    this.resolveAgentLabel = options.resolveAgentLabel ?? ((caller) => caller);
    this.getUiTypingSpeed = options.getUiTypingSpeed ?? (() => "visible");
    this.getAllowUiInProtectedAreas = options.getAllowUiInProtectedAreas ?? (() => false);
  }

  private async timedAsync<T extends object>(
    task: () => Promise<T>
  ): Promise<T & { durationMs: number }> {
    const startedAt = Date.now();
    const result = await task();
    return { ...result, durationMs: Math.max(0, Date.now() - startedAt) };
  }

  /** Serializes a UI action, wrapping focus-borrowing actions in a continuous focus/input shield. */
  private executeUiAction<T extends Record<string, unknown>>(
    task: () => Promise<T>,
    includeFocus = false,
    borrowFocus = true
  ): Promise<T & { durationMs: number }> {
    return this.serialize(() =>
      this.timedAsync(async () => {
        const result = borrowFocus ? await this.withFocusRestore(task) : await task();
        if (!includeFocus) {
          return result;
        }
        return {
          ...result,
          focus: this.focusState(),
        };
      })
    );
  }

  private recordMutationInsert(from: number | null | undefined, insert: string): void {
    const run = this.activeMutationRun;
    if (!run || !insert) {
      return;
    }
    run.insertedChars += insert.length;
    if (typeof from === "number" && Number.isFinite(from)) {
      run.edits.push({ from, to: from, insert });
    }
  }

  private markMutationAbortedAfterNoteSwitch(): void {
    if (this.activeMutationRun) {
      this.activeMutationRun.abortedAfterNoteSwitch = true;
    }
  }

  private timedSync<T extends object>(task: () => T): T & { durationMs: number } {
    const startedAt = Date.now();
    const result = task();
    return { ...result, durationMs: Math.max(0, Date.now() - startedAt) };
  }

  private typingSpeed(): UiTypingSpeed {
    return this.getUiTypingSpeed() === "fast" ? "fast" : "visible";
  }

  private actionDelayMs(visibleMs: number, fastMs = 10): number {
    return this.typingSpeed() === "fast" ? fastMs : visibleMs;
  }

  isAvailable(): boolean {
    try {
      return this.getWebContents() !== null;
    } catch {
      return false;
    }
  }

  screenshot(params: Record<string, unknown> = {}): Promise<unknown> {
    return this.timedAsync(async () => {
      const wc = this.requireWebContents();
      await this.waitForPaint();
      let image = await wc.capturePage();
      if (image.isEmpty()) {
        throw new UiControlError(
          "ui_capture_empty",
          "The Obsidian window returned an empty capture. It may be minimized or hidden."
        );
      }
      const maxWidth = num(params.maxWidth, 0);
      if (maxWidth >= 320 && image.getSize().width > maxWidth) {
        image = image.resize({ width: Math.round(maxWidth), quality: "good" });
      }
      const size = image.getSize();
      const viewport = this.viewport();
      return {
        image: { mimeType: "image/png", data: base64FromBytes(image.toPNG()) },
        width: size.width,
        height: size.height,
        viewport,
        cssPixelsPerImagePixel: {
          x: viewport.width / size.width,
          y: viewport.height / size.height,
        },
      };
    });
  }

  inspect(params: Record<string, unknown> = {}): unknown {
    return this.timedSync(() => {
      const hasCustomSelector = typeof params.selector === "string" && Boolean(params.selector.trim());
      const matchText = typeof params.text === "string" && params.text ? params.text : null;
      const selector = hasCustomSelector
        ? String(params.selector)
        : matchText !== null
          ? `${DEFAULT_INSPECT_SELECTOR},.cm-line`
          : DEFAULT_INSPECT_SELECTOR;
      const limit = Math.min(200, Math.max(1, Math.round(num(params.limit, 80))));
      return this.collect(selector, limit, matchText);
    });
  }

  /**
   * Glides the caller's visual cursor to the visible result of a shortcut RPC
   * (opened note tab/editor, created or renamed file-tree item, or command modal).
   * Safe no-op when no cursor overlay or visible DOM target is present.
   */
  pointAtResult(
    caller: string,
    target: PointAtResultTarget,
    label: string
  ): Promise<PointAtResultOutput> {
    return this.serialize(() => this.timedAsync(() => this.pointAtResultNow(caller, target, label)));
  }

  locate(params: Record<string, unknown> = {}, caller = "agent"): Promise<unknown> {
    return this.timedAsync(() => this.locateNow(params, caller));
  }

  private async locateNow(
    params: Record<string, unknown>,
    caller: string
  ): Promise<Record<string, unknown>> {
    const anchor = await this.resolveAnchorTarget(params, false);
    this.showCursor(
      caller,
      "move",
      anchor.point.x,
      anchor.point.y,
      anchor.scrolled ? "scroll" : "locate",
      params,
      this.buildDocContext({
        notePath: anchor.leaf.path,
        paneId: anchor.leaf.pane,
        cm: anchor.cm,
        containerEl: anchor.leaf.containerEl,
        pos: anchor.pos,
      })
    );
    return {
      found: true,
      path: anchor.leaf.path,
      pane: anchor.leaf.pane,
      line: anchor.lineNumber,
      text: anchor.lineText,
      point: anchor.point,
      rect: anchor.rect,
      selector: anchor.selector,
      scrolled: anchor.scrolled,
    };
  }

  waitFor(params: Record<string, unknown> = {}, caller = "agent"): Promise<unknown> {
    const text = typeof params.text === "string" ? params.text : "";
    if (!text) {
      throw new UiControlError("invalid_params", "ui.wait_for needs non-empty 'text'.");
    }
    const selector = typeof params.selector === "string" && params.selector.trim() ? params.selector : null;
    const timeoutMs = Math.min(MAX_WAIT_MS, Math.max(0, Math.round(num(params.timeoutMs, 5000))));
    return this.timedAsync(async () => {
      const started = Date.now();
      for (;;) {
        const doc = this.win.document;
        // Match against the full visible text first, then collect bounded element previews.
        const found = selector
          ? this.collect(selector, 20, text).total > 0
          : (doc.body?.innerText ?? "").includes(text);
        if (found) {
          const matches = this.collect(selector ?? "body *", 20, text, true).elements;
          if (matches.length > 0) {
            const r = matches[0].rect;
            this.showCursor(
              caller,
              "move",
              Math.round(r.x + r.width / 2),
              Math.round(r.y + r.height / 2),
              "wait_for",
              params,
              this.buildDocContext({
                notePath: matches[0].notePath,
                paneId: matches[0].pane,
                cm: null,
              })
            );
          }
          return {
            found: true,
            elapsedMs: Date.now() - started,
            matches,
          };
        }
        if (Date.now() - started >= timeoutMs) {
          return { found: false, elapsedMs: Date.now() - started, matches: [] };
        }
        await this.sleep(200);
      }
    });
  }

  click(params: Record<string, unknown>, caller = "agent"): Promise<unknown> {
    return this.executeUiAction(() => this.clickNow(params, caller), true);
  }

  private async dispatchResolvedClick(
    wc: WebContentsLike,
    resolved: ResolvedUiTarget,
    params: Record<string, unknown>,
    caller: string,
    actionName: "click" | "type" = "click"
  ): Promise<{ dispatched: true; point: { x: number; y: number }; button: "left" | "right" | "middle"; count: number; focus: FocusState }> {
    const docCtx = this.docContextForResolvedTarget(resolved);
    if (resolved.scrolled) {
      this.showCursor(caller, "move", resolved.point.x, resolved.point.y, "scroll", params, docCtx);
    }
    const point = resolved.point;
    const button = params.button === "right" || params.button === "middle" ? params.button : "left";
    const count = Math.min(3, Math.max(1, Math.round(num(params.count, 1))));
    const expectedContainer = this.expectedTargetContainer(resolved);
    this.showCursor(
      caller,
      "click",
      point.x,
      point.y,
      count > 1 ? `click x${count}` : "click",
      params,
      docCtx
    );
    const at = this.toWindowPoint(wc, point);
    wc.sendInputEvent({ type: "mouseMove", ...at });
    // Validate the topmost element right before sending mouseDown so late overlays block the click.
    this.assertPointReceiverSafe(point, actionName, expectedContainer);
    for (let i = 1; i <= count; i += 1) {
      try {
        wc.sendInputEvent({ type: "mouseDown", ...at, button, clickCount: i });
      } finally {
        wc.sendInputEvent({ type: "mouseUp", ...at, button, clickCount: i });
      }
    }
    if (resolved.cm && typeof resolved.pos === "number") {
      resolved.cm.focus?.();
      this.dispatchScrollToPos(resolved.cm, resolved.pos, true);
      await this.waitForPaint();
      await this.ensureCaretInView(resolved.cm);
    }
    const settleMs = this.actionDelayMs(100, 10);
    if (settleMs > 0) {
      await this.runWithUserInputShield(() => this.sleep(settleMs));
    }
    return { dispatched: true, point, button, count, focus: this.focusState() };
  }

  private async clickNow(
    params: Record<string, unknown>,
    caller: string,
    notifyMutation = true
  ): Promise<Record<string, unknown>> {
    return this.timedAsync(async () => {
      const wc = this.requireWebContents();
      const resolved = await this.resolveTargetAsync(params.target);
      this.assertElementNotProtected(resolved.element ?? resolved.containerEl ?? null, "click");
      this.assertPointReceiverSafe(resolved.point, "click", this.expectedTargetContainer(resolved));
      const targetCtx = notifyMutation ? this.resolveTargetLeafMeta(resolved) : null;
      const run = () => this.dispatchResolvedClick(wc, resolved, params, caller, "click");
      if (!targetCtx) {
        return run();
      }
      return this.withMutationHook(
        "click",
        targetCtx.notePath,
        targetCtx.paneId,
        caller,
        run,
        {
          targetView: resolved.view ?? undefined,
          targetCm: resolved.cm ?? undefined,
        }
      );
    });
  }

  type(params: Record<string, unknown>, caller = "agent"): Promise<unknown> {
    this.validateTypeParams(params);
    const borrowFocus = !(params.target !== undefined && this.isAnchorTargetObject(params.target));
    return this.executeUiAction(() => this.typeNow(params, caller), true, borrowFocus);
  }

  private validateTypeParams(params: Record<string, unknown>): string {
    const text = typeof params.text === "string" ? params.text : "";
    if (!text) {
      throw new UiControlError("invalid_params", "ui.type needs non-empty 'text'.");
    }
    if (text.length > MAX_TYPE_CHARS) {
      throw new UiControlError(
        "invalid_params",
        `ui.type accepts at most ${MAX_TYPE_CHARS} characters per call.`
      );
    }
    return text;
  }

  private assertEditorHostOwnershipIntact(
    ownership: EditorTypingOwnership,
    progress: string,
    liveFocusEl: Element | null
  ): void {
    if (ownership.containerEl?.isConnected === false) {
      this.markMutationAbortedAfterNoteSwitch();
      throw new UiControlError(
        "ui_target_changed",
        `${progress}: target editor pane was closed or replaced.`
      );
    }
    if (ownership.leaf && ownership.view && ownership.leaf.view !== ownership.view) {
      this.markMutationAbortedAfterNoteSwitch();
      throw new UiControlError(
        "ui_target_changed",
        `${progress}: target editor view was replaced.`
      );
    }
    if (ownership.notePath) {
      const viewPath =
        ownership.view && "file" in ownership.view
          ? (ownership.view.file?.path ?? null)
          : ownership.leaf?.view && "file" in ownership.leaf.view
            ? (ownership.leaf.view.file?.path ?? null)
            : null;
      const hasLiveViewFile = Boolean(
        (ownership.view && "file" in ownership.view) ||
          (ownership.leaf?.view && "file" in ownership.leaf.view)
      );
      const domCtx =
        (liveFocusEl && liveFocusEl.isConnected !== false
          ? this.resolveElementLeafContext(liveFocusEl)
          : null) ??
        (ownership.containerEl ? this.resolveElementLeafContext(ownership.containerEl) : null);
      const domPath = domCtx?.notePath !== undefined ? (domCtx.notePath ?? null) : undefined;
      const viewSwitched = hasLiveViewFile && viewPath !== ownership.notePath;
      const domSwitched = domPath !== undefined && domPath !== ownership.notePath;
      if (viewSwitched || domSwitched) {
        const switchedTo = viewSwitched ? viewPath : domPath;
        this.markMutationAbortedAfterNoteSwitch();
        throw new UiControlError(
          "ui_target_changed",
          `${progress}: target editor switched from '${ownership.notePath}' to '${switchedTo ?? "another note"}'.`
        );
      }
    }
    if (ownership.cm) {
      const liveViewCm = this.extractCodeMirrorView(
        ownership.view?.editor?.cm ?? ownership.leaf?.view?.editor?.cm
      );
      const liveFocusedCm = liveFocusEl ? this.findFocusedCodeMirrorView(liveFocusEl) : null;
      const liveCm = liveViewCm ?? liveFocusedCm;
      if (liveCm && liveCm !== ownership.cm) {
        this.markMutationAbortedAfterNoteSwitch();
        throw new UiControlError(
          "ui_target_changed",
          `${progress}: target editor instance changed.`
        );
      }
    }
  }

  private assertAnchoredOwnershipIntact(
    ownership: EditorTypingOwnership,
    insertedChars: number,
    totalChars: number
  ): void {
    const progress =
      insertedChars > 0
        ? `Typing stopped after inserting ${insertedChars} of ${totalChars} characters`
        : "Typing aborted before inserting any characters";
    if (!this.isProtectedAreasAllowed()) {
      const area = this.detectProtectedArea(ownership.containerEl);
      if (area) {
        throw new UiControlError(
          "ui_protected_area",
          `${progress}: target moved into ${area}.`
        );
      }
    }
    this.assertEditorHostOwnershipIntact(ownership, progress, null);
  }

  private assertTypingOwnershipIntact(
    ownership: EditorTypingOwnership,
    insertedChars: number,
    totalChars: number
  ): void {
    const progress =
      insertedChars > 0
        ? `Typing stopped after inserting ${insertedChars} of ${totalChars} characters`
        : "Typing aborted before inserting any characters";
    const current = this.win.document.activeElement ?? null;
    if (!this.isProtectedAreasAllowed()) {
      const protectedArea = this.detectProtectedArea(current);
      if (protectedArea) {
        throw new UiControlError(
          "ui_protected_area",
          `${progress}: focus moved into ${protectedArea}. Ask the user to operate protected controls manually, or enable allowUiInProtectedAreas in Herdr settings if explicitly authorized.`
        );
      }
    }
    this.assertEditorHostOwnershipIntact(ownership, progress, current);
    if (ownership.expectedActive) {
      const stillOwned =
        current !== null &&
        (current === ownership.expectedActive || Boolean(ownership.expectedActive.contains?.(current)));
      if (!stillOwned) {
        throw new UiControlError(
          "ui_not_editable",
          `${progress}: focus moved away from the intended editable target.`
        );
      }
    }
    const focus = this.focusState();
    if (focus.password) {
      throw new UiControlError(
        "ui_not_editable",
        `${progress}: focus landed on a password field.`
      );
    }
    if (!focus.editable) {
      throw new UiControlError(
        "ui_not_editable",
        `${progress}: active target is no longer editable.`
      );
    }
  }

  private async dispatchAgentInsertText(wc: WebContentsLike, chunk: string): Promise<void> {
    const prevChunk = this.agentInsertTextChunk;
    this.agentInsertTextChunk = chunk;
    try {
      await wc.insertText(chunk);
    } finally {
      this.agentInsertTextChunk = prevChunk;
    }
  }

  private dispatchAgentKeyInput(wc: WebContentsLike, event: Record<string, unknown>): void {
    const keyCode = typeof event.keyCode === "string" ? event.keyCode : null;
    const prevMatch = this.agentKeyMatch;
    this.agentKeyMatch = keyCode;
    this.agentKeyDepth += 1;
    try {
      wc.sendInputEvent(event);
    } finally {
      this.agentKeyMatch = prevMatch;
      this.agentKeyDepth = Math.max(0, this.agentKeyDepth - 1);
    }
  }

  /**
   * Streams anchored edits directly into CodeMirror via view.dispatch transactions so
   * neither DOM focus nor any external user selection ever leaves its current control.
   */
  private async dispatchCmChunks(
    cm: CodeMirrorViewLike,
    text: string,
    initialPos: number,
    caller: string,
    params: Record<string, unknown>,
    ownership: EditorTypingOwnership,
    docHint: {
      notePath?: string | null;
      paneId?: string | null;
      containerEl?: Element | null;
    }
  ): Promise<number> {
    this.assertAnchoredOwnershipIntact(ownership, 0, text.length);
    let cursorPos = initialPos;
    const buildCtx = (pos: number): DocumentCursorContext | undefined =>
      this.buildDocContext({
        cm,
        notePath: docHint.notePath,
        paneId: docHint.paneId,
        containerEl: docHint.containerEl,
        pos,
      });

    await this.ensureCaretInView(cm, cursorPos);
    let lastDocCtx = buildCtx(cursorPos);
    const startPt = this.resolveCaretOrFocusPoint(cm, cursorPos);
    this.showCursor(caller, "type", startPt.x, startPt.y, undefined, params, lastDocCtx);

    const applyChunkAndSync = async (chunk: string, delayMs: number): Promise<void> => {
      const docLen = cm.state?.doc?.length;
      const from = typeof docLen === "number" ? Math.max(0, Math.min(cursorPos, docLen)) : cursorPos;
      if (chunk) {
        cm.dispatch?.({
          changes: { from, insert: chunk },
        });
        this.recordMutationInsert(from, chunk);
      }
      cursorPos = from + chunk.length;
      if (delayMs > 0) {
        await this.sleep(delayMs);
      }
      await this.ensureCaretInView(cm, cursorPos);
      lastDocCtx = buildCtx(cursorPos) ?? lastDocCtx;
      const nextPt = this.resolveCaretOrFocusPoint(cm, cursorPos);
      this.showCursor(caller, "type", nextPt.x, nextPt.y, undefined, params, lastDocCtx);
      if (chunk) {
        this.notifyOverlayNoteUpdated(lastDocCtx?.notePath, {
          from,
          to: from,
          insertLength: chunk.length,
        });
      }
    };

    try {
      if (this.typingSpeed() === "fast") {
        this.assertAnchoredOwnershipIntact(ownership, 0, text.length);
        await applyChunkAndSync(text, 0);
        return cursorPos;
      }

      const chunks = splitTypingChunks(text);
      if (chunks.length <= 1) {
        this.assertAnchoredOwnershipIntact(ownership, 0, text.length);
        await applyChunkAndSync(text, 80);
        return cursorPos;
      }

      const budgetMs = Math.min(
        2200,
        Math.max(120, Math.round((text.length / 100) * TYPING_BUDGET_PER_100_CHARS_MS))
      );
      const delayMs = Math.min(55, Math.max(12, Math.floor(budgetMs / chunks.length)));
      let insertedChars = 0;
      for (const chunk of chunks) {
        this.assertAnchoredOwnershipIntact(ownership, insertedChars, text.length);
        await applyChunkAndSync(chunk, delayMs);
        insertedChars += chunk.length;
      }
      return cursorPos;
    } finally {
      const finalCtx = buildCtx(cursorPos) ?? lastDocCtx;
      this.cursorOverlay?.finishTyping?.(caller, finalCtx);
    }
  }

  private async typeChunks(
    wc: WebContentsLike,
    text: string,
    caller: string,
    params: Record<string, unknown>,
    preferredCm?: CodeMirrorViewLike | null,
    docHint?: {
      notePath?: string | null;
      paneId?: string | null;
      containerEl?: Element | null;
      leaf?: WorkspaceLeafLike | null;
      view?: WorkspaceLeafLike["view"] | null;
    }
  ): Promise<void> {
    const expectedActive = this.win.document.activeElement ?? null;
    const activeCm = preferredCm ?? this.findFocusedCodeMirrorView(expectedActive);
    const ownership: EditorTypingOwnership = {
      expectedActive,
      notePath: docHint?.notePath ?? null,
      paneId: docHint?.paneId ?? null,
      containerEl: docHint?.containerEl ?? null,
      leaf: docHint?.leaf ?? null,
      view: docHint?.view ?? null,
      cm: activeCm ?? null,
    };
    this.assertTypingOwnershipIntact(ownership, 0, text.length);
    const buildCtx = (): DocumentCursorContext | undefined =>
      this.buildDocContext({
        cm: activeCm ?? undefined,
        notePath: docHint?.notePath,
        paneId: docHint?.paneId,
        containerEl: docHint?.containerEl,
      });

    await this.ensureCaretInView(activeCm);
    let lastDocCtx = buildCtx();
    const startPt = this.resolveCaretOrFocusPoint(activeCm);
    this.showCursor(caller, "type", startPt.x, startPt.y, undefined, params, lastDocCtx);

    const insertChunkAndSync = async (chunk: string, delayMs: number): Promise<void> => {
      const beforeHead = activeCm?.state?.selection?.main?.head;
      if (chunk) {
        await this.dispatchAgentInsertText(wc, chunk);
        this.recordMutationInsert(beforeHead, chunk);
      }
      if (delayMs > 0) {
        await this.sleep(delayMs);
      }
      await this.ensureCaretInView(activeCm);
      lastDocCtx = buildCtx() ?? lastDocCtx;
      const nextPt = this.resolveCaretOrFocusPoint(activeCm);
      this.showCursor(caller, "type", nextPt.x, nextPt.y, undefined, params, lastDocCtx);
      const change: NoteDocChange | undefined =
        typeof beforeHead === "number" && chunk
          ? { from: beforeHead, to: beforeHead, insertLength: chunk.length }
          : undefined;
      if (chunk) {
        this.notifyOverlayNoteUpdated(lastDocCtx?.notePath, change);
      }
    };

    try {
      if (this.typingSpeed() === "fast") {
        this.assertTypingOwnershipIntact(ownership, 0, text.length);
        await insertChunkAndSync(text, 0);
        return;
      }

      const chunks = splitTypingChunks(text);
      if (chunks.length <= 1) {
        this.assertTypingOwnershipIntact(ownership, 0, text.length);
        await insertChunkAndSync(text, 80);
        return;
      }

      const budgetMs = Math.min(
        2200,
        Math.max(120, Math.round((text.length / 100) * TYPING_BUDGET_PER_100_CHARS_MS))
      );
      const delayMs = Math.min(55, Math.max(12, Math.floor(budgetMs / chunks.length)));
      let insertedChars = 0;
      for (const chunk of chunks) {
        this.assertTypingOwnershipIntact(ownership, insertedChars, text.length);
        await insertChunkAndSync(chunk, delayMs);
        insertedChars += chunk.length;
      }
    } finally {
      // Clear active "typing" state immediately when insertion completes or aborts on focus drift,
      // retaining the original editor context even if focus moved elsewhere.
      const finalCtx = buildCtx() ?? lastDocCtx;
      this.cursorOverlay?.finishTyping?.(caller, finalCtx);
    }
  }

  private async typeNow(params: Record<string, unknown>, caller: string): Promise<Record<string, unknown>> {
    return this.timedAsync(async () => {
      const text = this.validateTypeParams(params);
      if (params.target !== undefined && this.isAnchorTargetObject(params.target)) {
        const resolved = await this.resolveTargetAsync(params.target, { focusLeaf: false });
        this.assertElementNotProtected(resolved.element ?? resolved.containerEl ?? null, "type");
        this.assertPointReceiverSafe(resolved.point, "type", this.expectedTargetContainer(resolved));
        const preferredCm = resolved.cm ?? null;
        if (!preferredCm || !preferredCm.state?.doc || typeof preferredCm.dispatch !== "function") {
          throw new UiControlError(
            "ui_not_editable",
            `Target note '${resolved.notePath ?? "note"}' does not have an active CodeMirror editor view. Switch the pane to Editing view before typing.`
          );
        }
        const targetMeta = this.resolveTargetLeafMeta(resolved);
        const notePath = targetMeta.notePath ?? resolved.notePath ?? null;
        const paneId = targetMeta.paneId ?? resolved.paneId ?? null;
        const targetView = resolved.view ?? targetMeta.view ?? null;
        const targetLeaf = resolved.workspaceLeaf ?? targetMeta.leaf ?? null;
        const containerEl = resolved.containerEl ?? targetMeta.containerEl ?? null;
        const ownership: EditorTypingOwnership = {
          expectedActive: null,
          notePath,
          paneId,
          containerEl,
          leaf: targetLeaf,
          view: targetView,
          cm: preferredCm,
        };
        return this.withMutationHook(
          "type",
          notePath,
          paneId,
          caller,
          async () => {
            this.assertPointReceiverSafe(resolved.point, "type", this.expectedTargetContainer(resolved));
            if (resolved.scrolled) {
              this.showCursor(
                caller,
                "move",
                resolved.point.x,
                resolved.point.y,
                "scroll",
                params,
                this.docContextForResolvedTarget(resolved)
              );
            }
            await this.dispatchCmChunks(
              preferredCm,
              text,
              resolved.pos ?? preferredCm.state?.selection?.main?.head ?? 0,
              caller,
              params,
              ownership,
              { notePath, paneId, containerEl }
            );
            return { dispatched: true, characters: text.length, focus: this.focusState() };
          },
          { targetView, targetCm: preferredCm }
        );
      }

      const wc = this.requireWebContents();
      return this.runWithUserInputShield(async () => {
        if (params.target !== undefined) {
          const clickStep = { ...params, target: params.target };
          const resolved = await this.resolveTargetAsync(params.target);
          this.assertElementNotProtected(resolved.element ?? resolved.containerEl ?? null, "type");
          this.assertPointReceiverSafe(resolved.point, "type", this.expectedTargetContainer(resolved));
          const preferredCm = resolved.cm ?? null;
          const targetMeta = this.resolveTargetLeafMeta(resolved);
          const focusedOwnership = this.resolveFocusedOwnership();
          const notePath = targetMeta.notePath ?? focusedOwnership.notePath;
          const paneId = targetMeta.paneId ?? focusedOwnership.paneId;
          const targetView = resolved.view ?? targetMeta.view ?? focusedOwnership.view ?? null;
          const targetLeaf = resolved.workspaceLeaf ?? targetMeta.leaf ?? focusedOwnership.leaf ?? null;
          const containerEl = resolved.containerEl ?? targetMeta.containerEl ?? focusedOwnership.containerEl ?? null;
          return this.withMutationHook(
            "type",
            notePath,
            paneId,
            caller,
            async () => {
              await this.dispatchResolvedClick(wc, resolved, clickStep, caller, "type");
              this.assertElementNotProtected(this.win.document.activeElement ?? null, "type");
              const focus = this.focusState();
              if (!focus.editable || focus.password) {
                throw new UiControlError(
                  "ui_not_editable",
                  "Focus an editable text field before typing. Password fields are excluded."
                );
              }
              await this.typeChunks(wc, text, caller, params, preferredCm, {
                notePath,
                paneId,
                containerEl,
                leaf: targetLeaf,
                view: targetView,
              });
              return { dispatched: true, characters: text.length, focus: this.focusState() };
            },
            { targetView, targetCm: preferredCm }
          );
        }

        this.assertElementNotProtected(this.win.document.activeElement ?? null, "type");
        const focus = this.focusState();
        if (!focus.editable || focus.password) {
          throw new UiControlError(
            "ui_not_editable",
            "Focus an editable text field before typing. Password fields are excluded."
          );
        }
        const focusedOwnership = this.resolveFocusedOwnership();
        return this.withMutationHook(
          "type",
          focusedOwnership.notePath,
          focusedOwnership.paneId,
          caller,
          async () => {
            await this.typeChunks(wc, text, caller, params, focusedOwnership.cm, {
              notePath: focusedOwnership.notePath,
              paneId: focusedOwnership.paneId,
              containerEl: focusedOwnership.containerEl,
              leaf: focusedOwnership.leaf,
              view: focusedOwnership.view,
            });
            return { dispatched: true, characters: text.length, focus: this.focusState() };
          },
          {
            targetView: focusedOwnership.view,
            targetCm: focusedOwnership.cm,
          }
        );
      });
    });
  }

  insertLine(params: Record<string, unknown>, caller = "agent"): Promise<unknown> {
    return this.executeUiAction(() => this.insertLineNow(params, caller), true, false);
  }

  private async insertLineNow(params: Record<string, unknown>, caller: string): Promise<Record<string, unknown>> {
    if (typeof params.text !== "string") {
      throw new UiControlError("invalid_params", "ui.insert_line requires string 'text'.");
    }
    const text = params.text;
    if (text.length > MAX_TYPE_CHARS) {
      throw new UiControlError(
        "invalid_params",
        `ui.insert_line accepts at most ${MAX_TYPE_CHARS} characters per call.`
      );
    }

    return this.timedAsync(async () => {
      const rawTarget =
        params.target && typeof params.target === "object" ? params.target : params;
      const anchor = await this.resolveAnchorTarget(rawTarget, false);
      this.assertElementNotProtected(anchor.leaf.containerEl, "insert_line");
      this.assertPointReceiverSafe(anchor.point, "insert_line", anchor.leaf.containerEl);
      const cm = anchor.cm;
      if (!cm || !cm.state?.doc || typeof cm.dispatch !== "function") {
        throw new UiControlError(
          "ui_not_editable",
          `Target note '${anchor.leaf.path}' does not have an active CodeMirror editor view. Switch the pane to Editing view before running insert_line.`
        );
      }
      const leafMeta = {
        notePath: anchor.leaf.path,
        paneId: anchor.leaf.pane,
        containerEl: anchor.leaf.containerEl,
        leaf: anchor.leaf.workspaceLeaf ?? null,
        view: anchor.leaf.view ?? null,
      };
      const buildAnchorCtx = (pos?: number): DocumentCursorContext | undefined =>
        this.buildDocContext({
          notePath: leafMeta.notePath,
          paneId: leafMeta.paneId,
          containerEl: leafMeta.containerEl,
          cm,
          pos,
        });

      return this.withMutationHook(
        "insert_line",
        anchor.leaf.path,
        anchor.leaf.pane,
        caller,
        async () => {
          this.assertPointReceiverSafe(anchor.point, "insert_line", anchor.leaf.containerEl);
          const ownership: EditorTypingOwnership = {
            expectedActive: null,
            notePath: anchor.leaf.path,
            paneId: anchor.leaf.pane,
            containerEl: anchor.leaf.containerEl,
            leaf: anchor.leaf.workspaceLeaf ?? null,
            view: anchor.leaf.view ?? null,
            cm,
          };
          this.assertAnchoredOwnershipIntact(ownership, 0, text.length);

          const initialCtx = buildAnchorCtx(anchor.pos);
          if (anchor.scrolled) {
            this.showCursor(caller, "move", anchor.point.x, anchor.point.y, "scroll", params, initialCtx);
          } else {
            this.showCursor(caller, "move", anchor.point.x, anchor.point.y, "insert_line", params, initialCtx);
          }

          const insertAt = anchor.at === "start" ? anchor.from : anchor.to;
          const newCaretPos = anchor.at === "start" ? anchor.from : anchor.to + 1;
          cm.dispatch?.({
            changes: { from: insertAt, insert: "\n" },
          });
          this.recordMutationInsert(insertAt, "\n");
          await this.waitForPaint();
          await this.ensureCaretInView(cm, newCaretPos);
          this.notifyOverlayNoteUpdated(anchor.leaf.path, {
            from: insertAt,
            to: insertAt,
            insertLength: 1,
          });

          if (text.length > 0) {
            await this.dispatchCmChunks(cm, text, newCaretPos, caller, params, ownership, leafMeta);
          } else {
            const caretPt = this.resolveCaretOrFocusPoint(cm, newCaretPos);
            const afterCtx = buildAnchorCtx(newCaretPos);
            this.showCursor(caller, "move", caretPt.x, caretPt.y, "insert_line", params, afterCtx);
            this.cursorOverlay?.finishTyping?.(caller, afterCtx);
          }

          const expectedLine = anchor.at === "start" ? anchor.lineNumber : anchor.lineNumber + 1;
          const proof = this.readInsertedLineProof(anchor.leaf, cm, expectedLine, newCaretPos);
          return {
            dispatched: true,
            path: proof.path,
            pane: anchor.leaf.pane,
            line: proof.line,
            text: proof.text,
            heading: proof.heading,
            characters: text.length,
            scrolled: anchor.scrolled,
            focus: this.focusState(),
          };
        },
        {
          targetView: anchor.leaf.view ?? undefined,
          targetCm: cm,
        }
      );
    });
  }

  pressKey(params: Record<string, unknown>, caller = "agent"): Promise<unknown> {
    return this.executeUiAction(() => this.pressKeyNow(params, caller), true);
  }

  private async pressKeyNow(
    params: Record<string, unknown>,
    caller: string,
    notifyMutation = true
  ): Promise<Record<string, unknown>> {
    return this.timedAsync(async () => {
      const wc = this.requireWebContents();
      const key = typeof params.key === "string" ? params.key : "";
      const modifiers = Array.isArray(params.modifiers) ? params.modifiers.map(String) : [];
      let press;
      try {
        press = buildKeyPress(key, modifiers, this.platform);
      } catch (err) {
        throw new UiControlError("invalid_params", err instanceof Error ? err.message : String(err));
      }
      this.assertElementNotProtected(this.win.document.activeElement ?? null, "press_key");
      const run = (): Promise<Record<string, unknown>> =>
        this.runWithUserInputShield(async () => {
          const pt = this.resolveCaretOrFocusPoint();
          const combo = [...modifiers, key].filter(Boolean).join("+");
          const beforeCtx = this.buildDocContext();
          this.showCursor(caller, "move", pt.x, pt.y, combo || "key", params, beforeCtx);
          try {
            this.dispatchAgentKeyInput(wc, {
              type: "keyDown",
              keyCode: press.keyCode,
              modifiers: press.modifiers,
            });
            if (press.text !== null) {
              this.dispatchAgentKeyInput(wc, {
                type: "char",
                keyCode: press.text,
                modifiers: press.modifiers,
              });
            }
          } finally {
            this.dispatchAgentKeyInput(wc, {
              type: "keyUp",
              keyCode: press.keyCode,
              modifiers: press.modifiers,
            });
          }
          const settleMs = this.actionDelayMs(80, 10);
          if (settleMs > 0) {
            await this.sleep(settleMs);
          }
          const doc = this.win.document;
          const afterActive = doc.activeElement ?? null;
          const afterProtected = this.detectProtectedArea(afterActive);
          const afterRect =
            afterActive &&
            typeof (afterActive as { getBoundingClientRect?: unknown }).getBoundingClientRect === "function"
              ? afterActive.getBoundingClientRect()
              : null;
          const afterStyle =
            afterActive && typeof this.win.getComputedStyle === "function"
              ? this.win.getComputedStyle(afterActive)
              : null;
          const afterHidden = Boolean(
            afterRect &&
              (afterRect.width <= 0 ||
                afterRect.height <= 0 ||
                afterStyle?.visibility === "hidden" ||
                afterStyle?.display === "none")
          );
          const focusLeftTargetArea =
            Boolean(afterProtected) ||
            !afterActive ||
            afterActive === doc.body ||
            afterActive === doc.documentElement ||
            afterActive.isConnected === false ||
            afterHidden;
          if (focusLeftTargetArea) {
            this.cursorOverlay?.exitAgent?.(caller);
          } else {
            await this.ensureCaretInView();
            const afterPt = this.resolveCaretOrFocusPoint();
            const afterCtx = this.buildDocContext();
            this.showCursor(caller, "move", afterPt.x, afterPt.y, combo || "key", params, afterCtx);
            if (
              afterCtx?.notePath &&
              (press.text !== null ||
                press.keyCode === "Backspace" ||
                press.keyCode === "Delete" ||
                press.keyCode === "Return")
            ) {
              this.notifyOverlayNoteUpdated(afterCtx.notePath);
            }
          }
          return { dispatched: true, key, modifiers: press.modifiers, focus: this.focusState() };
        });
      if (!notifyMutation) {
        return run();
      }
      const focusedOwnership = this.resolveFocusedOwnership();
      return this.withMutationHook(
        "press_key",
        focusedOwnership.notePath,
        focusedOwnership.paneId,
        caller,
        run,
        {
          targetView: focusedOwnership.view,
          targetCm: focusedOwnership.cm,
        }
      );
    });
  }

  scroll(params: Record<string, unknown>, caller = "agent"): Promise<unknown> {
    return this.executeUiAction(() => this.scrollNow(params, caller), false, false);
  }

  private async scrollNow(
    params: Record<string, unknown>,
    caller: string,
    fadeOnComplete = true
  ): Promise<Record<string, unknown>> {
    return this.timedAsync(async () => {
      const wc = this.requireWebContents();
      const resolved = await this.resolveTargetAsync(params.target, { focusLeaf: false });
      this.assertElementNotProtected(resolved.element ?? resolved.containerEl ?? null, "scroll");
      this.assertPointReceiverSafe(resolved.point, "scroll", this.expectedTargetContainer(resolved));
      const point = resolved.point;
      const deltaX = num(params.deltaX, 0);
      const deltaY = num(params.deltaY, 0);
      if (deltaX === 0 && deltaY === 0) {
        throw new UiControlError("invalid_params", "ui.scroll needs a non-zero deltaX or deltaY.");
      }
      // Clear any existing doc anchor immediately and avoid anchoring to text under the scroll point.
      this.showCursor(caller, "move", point.x, point.y, "scroll", params, null);
      const at = this.toWindowPoint(wc, point);
      wc.sendInputEvent({ type: "mouseMove", ...at });
      // Electron uses wheel deltas where positive scrolls up; the public contract follows DOM
      // WheelEvent (positive scrolls down/right), so the sign is flipped here.
      wc.sendInputEvent({
        type: "mouseWheel",
        ...at,
        deltaX: -Math.round(deltaX),
        deltaY: -Math.round(deltaY),
        canScroll: true,
      });
      const settleMs = this.actionDelayMs(180, 30);
      if (settleMs > 0) {
        await this.sleep(settleMs);
      }
      if (fadeOnComplete) {
        this.cursorOverlay?.exitAgent?.(caller);
      }
      return { dispatched: true, point, deltaX, deltaY };
    });
  }

  drag(params: Record<string, unknown>, caller = "agent"): Promise<unknown> {
    return this.executeUiAction(() => this.dragNow(params, caller));
  }

  private async dragNow(params: Record<string, unknown>, caller: string): Promise<Record<string, unknown>> {
    return this.timedAsync(async () => {
      const wc = this.requireWebContents();
      let resolvedStart = await this.resolveTargetAsync(params.from);
      this.assertElementNotProtected(resolvedStart.element ?? resolvedStart.containerEl ?? null, "drag");
      const resolvedEnd = await this.resolveTargetAsync(params.to);
      this.assertElementNotProtected(resolvedEnd.element ?? resolvedEnd.containerEl ?? null, "drag");
      if (resolvedEnd.scrolled) {
        try {
          resolvedStart = await this.resolveTargetAsync(params.from, {
            allowScroll: false,
            focusLeaf: false,
          });
          this.assertElementNotProtected(resolvedStart.element ?? resolvedStart.containerEl ?? null, "drag");
        } catch (err) {
          if (err instanceof UiControlError && err.code === "ui_target_outside") {
            throw new UiControlError(
              "ui_target_outside",
              "Drag start and destination targets cannot both fit in the viewport at the same time."
            );
          }
          throw err;
        }
      }
      const expectedStartContainer = this.expectedTargetContainer(resolvedStart);
      const expectedEndContainer = this.expectedTargetContainer(resolvedEnd);
      const start = resolvedStart.point;
      const end = resolvedEnd.point;
      const steps = Math.min(60, Math.max(1, Math.round(num(params.steps, 12))));
      const from = this.toWindowPoint(wc, start);
      const to = this.toWindowPoint(wc, end);
      const stepPoints = Array.from({ length: steps }, (_, idx) => {
        const i = idx + 1;
        return {
          css: {
            x: start.x + ((end.x - start.x) * i) / steps,
            y: start.y + ((end.y - start.y) * i) / steps,
          },
          win: {
            x: Math.round(from.x + ((to.x - from.x) * i) / steps),
            y: Math.round(from.y + ((to.y - from.y) * i) / steps),
          },
          isLast: i === steps,
        };
      });
      // Preflight start, destination, and every interpolated point before starting mouseDown.
      this.assertPointReceiverSafe(start, "drag", expectedStartContainer);
      for (const step of stepPoints) {
        this.assertPointReceiverSafe(step.css, "drag", step.isLast ? expectedEndContainer : undefined);
      }

      const startMeta = this.resolveTargetLeafMeta(resolvedStart);
      const endMeta = this.resolveTargetLeafMeta(resolvedEnd);
      const startDocCtx = this.docContextForResolvedTarget(resolvedStart);
      const endDocCtx = this.docContextForResolvedTarget(resolvedEnd);
      return this.withMutationHook(
        "drag",
        startMeta.notePath ?? endMeta.notePath,
        startMeta.paneId ?? endMeta.paneId,
        caller,
        async () => {
          let last = from;
          const stepDelayMs = this.actionDelayMs(16, 4);
          this.showCursor(caller, "click", start.x, start.y, "drag", params, startDocCtx);
          wc.sendInputEvent({ type: "mouseMove", ...from });
          this.assertPointReceiverSafe(start, "drag", expectedStartContainer);
          try {
            wc.sendInputEvent({ type: "mouseDown", ...from, button: "left", clickCount: 1 });
            for (const step of stepPoints) {
              this.assertPointReceiverSafe(
                step.css,
                "drag",
                step.isLast ? expectedEndContainer : undefined
              );
              this.showCursor(caller, "move", step.css.x, step.css.y, "drag", params, startDocCtx);
              wc.sendInputEvent({ type: "mouseMove", ...step.win, modifiers: ["leftButtonDown"] });
              last = step.win;
              if (stepDelayMs > 0) {
                await this.sleep(stepDelayMs);
              }
            }
          } finally {
            wc.sendInputEvent({ type: "mouseUp", ...last, button: "left", clickCount: 1 });
          }
          this.showCursor(caller, "move", end.x, end.y, "drop", params, endDocCtx);
          const dropSettleMs = this.actionDelayMs(100, 10);
          if (dropSettleMs > 0) {
            await this.sleep(dropSettleMs);
          }
          return { dispatched: true, from: start, to: end, steps };
        },
        {
          targetView: resolvedStart.view ?? resolvedEnd.view ?? undefined,
          targetCm: resolvedStart.cm ?? resolvedEnd.cm ?? undefined,
        }
      );
    });
  }

  private stepBorrowsFocus(rawStep: unknown): boolean {
    if (!rawStep || typeof rawStep !== "object") {
      return false;
    }
    const step = rawStep as Record<string, unknown>;
    const action = typeof step.action === "string" ? step.action : "";
    if (action === "click" || action === "drag" || action === "press_key") {
      return true;
    }
    if (action === "type") {
      return !(step.target !== undefined && this.isAnchorTargetObject(step.target));
    }
    return false;
  }

  /**
   * Executes a multi-step UI sequence inside one serialized lock so parallel
   * agents cannot interleave click-then-type actions.
   */
  batch(params: Record<string, unknown>, caller = "agent"): Promise<unknown> {
    const rawSteps = params.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      return Promise.reject(
        new UiControlError("invalid_params", "ui.batch needs a non-empty 'steps' array.")
      );
    }
    if (rawSteps.length > MAX_BATCH_STEPS) {
      return Promise.reject(
        new UiControlError(
          "invalid_params",
          `ui.batch accepts at most ${MAX_BATCH_STEPS} steps per call.`
        )
      );
    }
    const borrowFocus = rawSteps.some((step) => this.stepBorrowsFocus(step));
    return this.executeUiAction(
      async () => {
        const batchAgentName =
          typeof params.agentName === "string" && params.agentName.trim()
            ? params.agentName.trim()
            : typeof params.callerName === "string" && params.callerName.trim()
              ? params.callerName.trim()
              : undefined;
        const results: unknown[] = [];
        const stepsList: unknown[] = rawSteps;
        for (let i = 0; i < stepsList.length; i += 1) {
          const rawStep = stepsList[i];
          if (!rawStep || typeof rawStep !== "object") {
            throw new UiControlError("invalid_params", "Each ui.batch step must be an object.");
          }
          const isLastStep = i === stepsList.length - 1;
          const baseStep = rawStep as Record<string, unknown>;
          const step =
            batchAgentName && baseStep.agentName === undefined && baseStep.callerName === undefined
              ? { ...baseStep, agentName: batchAgentName }
              : baseStep;
          const action = typeof step.action === "string" ? step.action : "";
          if (action === "click") {
            results.push(await this.clickNow(step, caller));
          } else if (action === "type") {
            results.push(await this.typeNow(step, caller));
          } else if (action === "insert_line") {
            results.push(await this.insertLineNow(step, caller));
          } else if (action === "press_key") {
            results.push(await this.pressKeyNow(step, caller));
          } else if (action === "scroll") {
            results.push(await this.scrollNow(step, caller, isLastStep));
          } else if (action === "drag") {
            results.push(await this.dragNow(step, caller));
          } else if (action === "wait_for") {
            results.push(await this.waitFor(step, caller));
          } else {
            throw new UiControlError(
              "invalid_params",
              `Unsupported ui.batch step action '${action}'.`
            );
          }
        }
        return { completed: true, stepCount: results.length, results };
      },
      false,
      borrowFocus
    );
  }

  private formatCursorLabel(caller: string, params?: Record<string, unknown>): string {
    const explicitName =
      typeof params?.agentName === "string" && params.agentName.trim()
        ? params.agentName.trim()
        : typeof params?.callerName === "string" && params.callerName.trim()
          ? params.callerName.trim()
          : "";
    const resolved = this.resolveAgentLabel(caller).trim();
    if (explicitName) {
      const paneMatch = /^herdr:(.+)$/.exec(caller);
      const paneId = paneMatch?.[1] ?? "";
      if (!resolved || resolved === caller || resolved === paneId) {
        return paneId ? `${explicitName} (${paneId})` : explicitName;
      }
      if (!resolved.includes(explicitName)) {
        return `${explicitName} (${resolved})`;
      }
    }
    const hashIdx = caller.indexOf("#");
    if (hashIdx > 0 && (!resolved || resolved === caller || resolved === caller.slice(6))) {
      const baseCaller = caller.slice(0, hashIdx);
      const nameHint = caller.slice(hashIdx + 1).trim();
      if (nameHint) {
        const baseResolved = this.resolveAgentLabel(baseCaller).trim();
        const paneId = baseCaller.startsWith("herdr:") ? baseCaller.slice(6) : baseCaller;
        if (!baseResolved || baseResolved === baseCaller || baseResolved === paneId) {
          return paneId && paneId !== baseCaller ? `${nameHint} (${paneId})` : nameHint;
        }
        return baseResolved;
      }
    }
    return resolved || caller;
  }

  private buildDocContext(opts?: {
    cm?: CodeMirrorViewLike | null;
    notePath?: string | null;
    paneId?: string | null;
    containerEl?: Element | null;
    pos?: number;
  }): DocumentCursorContext | undefined {
    const activeEl = this.win.document.activeElement ?? null;
    const cm = opts && "cm" in opts ? (opts.cm ?? null) : this.findFocusedCodeMirrorView(activeEl);
    const cmEl = cm?.contentDOM ?? cm?.dom ?? null;
    const cmCtx = cmEl ? this.resolveElementLeafContext(cmEl) : null;
    const focusedCtx =
      !opts?.notePath && !cmCtx?.notePath && (!cm || this.cmOwnsElement(cm, activeEl))
        ? this.resolveFocusedLeafContext()
        : null;
    const notePath = opts?.notePath ?? cmCtx?.notePath ?? focusedCtx?.notePath ?? undefined;
    const pane = opts?.paneId ?? cmCtx?.pane ?? focusedCtx?.paneId ?? undefined;
    let containerEl: Element | null =
      opts?.containerEl ?? cmEl?.closest?.(".workspace-leaf") ?? cmEl ?? null;
    if (!containerEl && notePath) {
      containerEl = this.findOpenNoteLeaf(notePath)?.containerEl ?? null;
    }
    const rawPos =
      typeof opts?.pos === "number" && Number.isFinite(opts.pos)
        ? opts.pos
        : typeof cm?.state?.selection?.main?.head === "number" &&
            Number.isFinite(cm.state.selection.main.head)
          ? cm.state.selection.main.head
          : undefined;
    if (!cm && !notePath && !containerEl && rawPos === undefined) {
      return undefined;
    }

    const visEl = containerEl ?? cm?.scrollDOM ?? cmEl ?? null;
    const canMeasureVis =
      Boolean(visEl && typeof visEl.getBoundingClientRect === "function") &&
      typeof this.win.getComputedStyle === "function";
    const probeEl = containerEl ?? cmEl ?? null;
    const probeResolves = Boolean(
      notePath && probeEl && this.resolveElementLeafContext(probeEl)?.notePath === notePath
    );
    const matchedLeaf =
      cm || containerEl
        ? this.collectWorkspaceLeaves().find(
            (l) =>
              (containerEl && this.leafContainer(l) === containerEl) ||
              (cm && l.view?.editor?.cm === cm)
          ) ?? null
        : null;

    return {
      ...(notePath ? { notePath } : {}),
      ...(pane ? { pane } : {}),
      ...(rawPos !== undefined ? { pos: rawPos } : {}),
      ...(cm ? { cm } : opts && "cm" in opts ? { cm: null } : {}),
      ...(containerEl ? { containerEl } : {}),
      ...(matchedLeaf?.view ? { view: matchedLeaf.view } : {}),
      ...(probeResolves && probeEl
        ? { getLeafNotePath: () => this.resolveElementLeafContext(probeEl)?.notePath ?? null }
        : {}),
      ...(canMeasureVis && visEl ? { isVisible: () => this.isVisible(visEl) } : {}),
    };
  }

  private docContextForResolvedTarget(resolved: ResolvedUiTarget): DocumentCursorContext | undefined {
    const meta = this.resolveTargetLeafMeta(resolved);
    const cm =
      resolved.cm !== undefined
        ? resolved.cm
        : resolved.element
          ? this.findFocusedCodeMirrorView(resolved.element)
          : null;
    const containerEl =
      resolved.containerEl ??
      resolved.element?.closest?.(".workspace-leaf") ??
      null;
    return this.buildDocContext({
      cm,
      notePath: meta.notePath,
      paneId: meta.paneId,
      containerEl,
      pos: resolved.pos,
    });
  }

  private notifyOverlayNoteUpdated(notePath?: string | null, change?: NoteDocChange): void {
    this.cursorOverlay?.notifyNoteUpdated?.(notePath || undefined, change);
  }

  private showCursor(
    caller: string,
    kind: "move" | "click" | "type",
    x: number,
    y: number,
    action?: string,
    params?: Record<string, unknown>,
    docContext?: DocumentCursorContext | null
  ): void {
    if (!this.cursorOverlay) {
      return;
    }
    const label = this.formatCursorLabel(caller, params);
    if (kind === "click") {
      this.cursorOverlay.pulseClick(caller, label, x, y, action, docContext ?? undefined);
    } else if (kind === "type") {
      this.cursorOverlay.setTyping(caller, label, x, y, docContext ?? undefined);
    } else {
      this.cursorOverlay.moveTo(caller, label, x, y, action, docContext);
    }
  }

  private extractCodeMirrorView(candidate: unknown): CodeMirrorViewLike | null {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }
    const view = candidate as CodeMirrorViewLike;
    if (
      typeof view.coordsAtPos === "function" &&
      typeof view.state?.selection?.main?.head === "number"
    ) {
      return view;
    }
    return null;
  }

  private cmOwnsElement(view: CodeMirrorViewLike, el: Element | null): boolean {
    if (!el) {
      return true;
    }
    const root = view.contentDOM ?? view.dom;
    if (root) {
      if (root === el) {
        return true;
      }
      if (typeof root.contains === "function") {
        return root.contains(el);
      }
    }
    // Without DOM containment info on a mock view, avoid hijacking plain input/textarea modals.
    return !isInputOrTextarea(el);
  }

  private findFocusedCodeMirrorView(activeEl: Element | null): CodeMirrorViewLike | null {
    let node: Element | null = activeEl;
    while (node) {
      const rec = node as unknown as {
        cmView?: { view?: unknown; rootView?: { view?: unknown } };
        cmTile?: { root?: { view?: unknown } };
        editorView?: unknown;
        cm?: unknown;
      };
      for (const candidate of [
        rec.cmView?.rootView?.view,
        rec.cmView?.view,
        rec.cmTile?.root?.view,
        rec.editorView,
        rec.cm,
      ]) {
        const view = this.extractCodeMirrorView(candidate);
        if (view && this.cmOwnsElement(view, activeEl)) {
          return view;
        }
      }
      node = node.parentElement ?? null;
    }

    const fromHook = this.extractCodeMirrorView(this.getCodeMirrorView?.());
    if (fromHook && this.cmOwnsElement(fromHook, activeEl)) {
      return fromHook;
    }

    const winWithApp = this.win as unknown as {
      app?: { workspace?: { activeEditor?: { editor?: { cm?: unknown } } } };
    };
    const fromWorkspace = this.extractCodeMirrorView(
      winWithApp.app?.workspace?.activeEditor?.editor?.cm
    );
    if (fromWorkspace && this.cmOwnsElement(fromWorkspace, activeEl)) {
      return fromWorkspace;
    }

    return null;
  }

  private codeMirrorCaretPoint(
    activeEl: Element | null,
    preferredCm?: CodeMirrorViewLike | null,
    explicitPos?: number
  ): { x: number; y: number } | null {
    const view = preferredCm ?? this.findFocusedCodeMirrorView(activeEl);
    if (!view || typeof view.coordsAtPos !== "function") {
      return null;
    }
    const head =
      typeof explicitPos === "number" && Number.isFinite(explicitPos)
        ? explicitPos
        : view.state?.selection?.main?.head;
    if (typeof head !== "number") {
      return null;
    }
    try {
      const rect = view.coordsAtPos(head) ?? view.coordsAtPos(head, -1);
      if (hasNonZeroBox(rect)) {
        return { x: Math.round(rect.left), y: rectMidY(rect) };
      }
    } catch {
      return null;
    }
    return null;
  }

  private selectionRangePoint(activeEl: Element | null): { x: number; y: number } | null {
    const sel = this.win.getSelection?.();
    if (!sel || sel.rangeCount === 0) {
      return null;
    }
    let range: Range;
    try {
      range = sel.getRangeAt(0);
    } catch {
      return null;
    }
    if (
      activeEl &&
      typeof activeEl.contains === "function" &&
      range.commonAncestorContainer &&
      activeEl !== range.commonAncestorContainer &&
      !activeEl.contains(range.commonAncestorContainer)
    ) {
      return null;
    }

    const clientRects = range.getClientRects?.();
    if (clientRects) {
      for (let i = 0; i < clientRects.length; i += 1) {
        const r = clientRects[i];
        if (hasNonZeroBox(r)) {
          return { x: Math.round(r.left), y: rectMidY(r) };
        }
      }
    }

    const bound = range.getBoundingClientRect?.();
    if (hasNonZeroBox(bound)) {
      return { x: Math.round(bound.left), y: rectMidY(bound) };
    }

    // Chromium/Obsidian often returns an empty or all-zero rect for collapsed selections.
    if (range.collapsed !== false && range.startContainer) {
      const container = range.startContainer as Node & {
        getBoundingClientRect?: () => CaretCoords & { width?: number; height?: number };
      };
      if (container.nodeType === 3 && typeof range.cloneRange === "function") {
        const len = container.textContent?.length ?? 0;
        const probe = range.cloneRange();
        try {
          if (range.startOffset > 0) {
            probe.setStart(container, range.startOffset - 1);
            probe.setEnd(container, range.startOffset);
            const probed = probe.getClientRects?.()?.[0] ?? probe.getBoundingClientRect?.();
            if (hasNonZeroBox(probed)) {
              const x = typeof probed.right === "number" ? probed.right : probed.left;
              return { x: Math.round(x), y: rectMidY(probed) };
            }
          } else if (range.startOffset < len) {
            probe.setStart(container, range.startOffset);
            probe.setEnd(container, range.startOffset + 1);
            const probed = probe.getClientRects?.()?.[0] ?? probe.getBoundingClientRect?.();
            if (hasNonZeroBox(probed)) {
              return { x: Math.round(probed.left), y: rectMidY(probed) };
            }
          }
        } catch {
          // Fall through to parent/container rect lookup.
        }
      }

      const children = container.childNodes;
      if (children && children.length > 0) {
        const childIdx = Math.min(children.length - 1, Math.max(0, range.startOffset));
        const child = children[childIdx] as Element | undefined;
        const childRect = child?.getBoundingClientRect?.();
        if (hasNonZeroBox(childRect)) {
          return { x: Math.round(childRect.left), y: rectMidY(childRect) };
        }
      }

      const containerRect = container.getBoundingClientRect?.();
      if (hasNonZeroBox(containerRect)) {
        return { x: Math.round(containerRect.left), y: rectMidY(containerRect) };
      }

      const parentRect = container.parentElement?.getBoundingClientRect?.();
      if (hasNonZeroBox(parentRect)) {
        return { x: Math.round(parentRect.left), y: rectMidY(parentRect) };
      }
    }

    return null;
  }

  private parseCssPx(value: string | undefined): number | null {
    if (!value) {
      return null;
    }
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  private clampPointToRect(
    x: number,
    y: number,
    rect: { left: number; top: number; right?: number; bottom?: number; width: number; height: number }
  ): { x: number; y: number } {
    const right = typeof rect.right === "number" ? rect.right : rect.left + rect.width;
    const bottom = typeof rect.bottom === "number" ? rect.bottom : rect.top + rect.height;
    const minX = rect.left + Math.min(4, rect.width * 0.2);
    const maxX = Math.max(minX, right - 4);
    const minY = rect.top + Math.min(4, rect.height * 0.2);
    const maxY = Math.max(minY, bottom - 4);
    return {
      x: Math.round(Math.min(maxX, Math.max(minX, x))),
      y: Math.round(Math.min(maxY, Math.max(minY, y))),
    };
  }

  private nativeInputMirrorPoint(
    el: HTMLInputElement | HTMLTextAreaElement,
    beforeText: string,
    rect: { left: number; top: number; right?: number; bottom?: number; width: number; height: number },
    style: CSSStyleDeclaration | undefined
  ): { x: number; y: number } | null {
    const body = this.win.document.body as HTMLElement | null;
    if (!body || typeof body.createDiv !== "function") {
      return null;
    }

    let mirror: HTMLDivElement | null = null;
    try {
      mirror = body.createDiv();
      if (!mirror || !mirror.style || typeof mirror.createSpan !== "function") {
        return null;
      }
      const isTextarea = (el.tagName ?? "").toUpperCase() === "TEXTAREA";
      const s = mirror.style;
      s.position = "fixed";
      s.left = `${rect.left}px`;
      s.top = `${rect.top}px`;
      s.width = `${rect.width}px`;
      s.height = `${rect.height}px`;
      s.visibility = "hidden";
      s.pointerEvents = "none";
      s.margin = "0";
      s.overflow = "hidden";
      s.boxSizing = "border-box";
      s.whiteSpace = isTextarea ? style?.whiteSpace || "pre-wrap" : "pre";
      if (isTextarea) {
        s.overflowWrap = "break-word";
      }
      if (style) {
        const copyProps = [
          "direction",
          "fontFamily",
          "fontSize",
          "fontStyle",
          "fontVariant",
          "fontWeight",
          "letterSpacing",
          "lineHeight",
          "tabSize",
          "textAlign",
          "textIndent",
          "textTransform",
          "wordSpacing",
          "paddingTop",
          "paddingRight",
          "paddingBottom",
          "paddingLeft",
          "borderTopWidth",
          "borderRightWidth",
          "borderBottomWidth",
          "borderLeftWidth",
          "borderTopStyle",
          "borderRightStyle",
          "borderBottomStyle",
          "borderLeftStyle",
        ] as const;
        for (const prop of copyProps) {
          const val = style[prop];
          if (val) {
            (s as unknown as Record<string, string>)[prop] = val;
          }
        }
      }

      if (beforeText) {
        mirror.textContent = beforeText;
      }

      const marker = mirror.createSpan({ text: "\u200b" });
      const mr = marker.getBoundingClientRect?.();
      if (!mr || !(mr.height > 0)) {
        return null;
      }
      const scrollLeft = typeof el.scrollLeft === "number" ? el.scrollLeft : 0;
      const scrollTop = typeof el.scrollTop === "number" ? el.scrollTop : 0;
      const x = mr.left - scrollLeft;
      const y = isTextarea ? mr.top + mr.height * 0.5 - scrollTop : rect.top + rect.height * 0.5;
      return this.clampPointToRect(x, y, rect);
    } catch {
      return null;
    } finally {
      mirror?.remove?.();
    }
  }

  private nativeInputCaretPoint(
    el: HTMLInputElement | HTMLTextAreaElement
  ): { x: number; y: number } | null {
    if (typeof el.getBoundingClientRect !== "function") {
      return null;
    }
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) {
      return null;
    }
    const text = typeof el.value === "string" ? el.value : "";
    const rawCaret =
      el.selectionDirection === "backward"
        ? el.selectionStart
        : (el.selectionEnd ?? el.selectionStart);
    const caretPos =
      typeof rawCaret === "number" && Number.isFinite(rawCaret)
        ? Math.max(0, Math.min(text.length, rawCaret))
        : text.length;
    const beforeText = text.slice(0, caretPos);
    const style = this.win.getComputedStyle?.(el);

    const mirrorPoint = this.nativeInputMirrorPoint(el, beforeText, r, style);
    if (mirrorPoint) {
      return mirrorPoint;
    }

    const isTextarea = (el.tagName ?? "").toUpperCase() === "TEXTAREA";
    const padLeft = this.parseCssPx(style?.paddingLeft) ?? Math.min(10, r.width * 0.2);
    const padTop = this.parseCssPx(style?.paddingTop) ?? 6;
    const fontSize = this.parseCssPx(style?.fontSize) ?? 14;
    const charWidth = fontSize * 0.56;
    const lineHeight = this.parseCssPx(style?.lineHeight) ?? Math.round(fontSize * 1.4);
    const lines = beforeText.split("\n");
    const lastLine = lines[lines.length - 1] ?? "";
    const scrollLeft = typeof el.scrollLeft === "number" ? el.scrollLeft : 0;
    const scrollTop = typeof el.scrollTop === "number" ? el.scrollTop : 0;

    const rawX = r.left + padLeft + lastLine.length * charWidth - scrollLeft;
    const rawY = isTextarea
      ? lines.length > 1 || text.includes("\n") || this.parseCssPx(style?.lineHeight) !== null
        ? r.top + padTop + (lines.length - 1) * lineHeight + lineHeight * 0.5 - scrollTop
        : r.top + Math.min(r.height * 0.5, 22)
      : r.top + r.height * 0.5;
    return this.clampPointToRect(rawX, rawY, r);
  }

  private resolveCaretOrFocusPoint(
    preferredCm?: CodeMirrorViewLike | null,
    explicitPos?: number
  ): { x: number; y: number } {
    const activeEl = this.win.document.activeElement ?? null;

    const cmPoint = this.codeMirrorCaretPoint(activeEl, preferredCm, explicitPos);
    if (cmPoint) {
      return cmPoint;
    }

    if (typeof explicitPos === "number" && preferredCm) {
      const targetEl = preferredCm.contentDOM ?? preferredCm.dom;
      if (targetEl && typeof targetEl.getBoundingClientRect === "function") {
        const r = targetEl.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return {
            x: Math.round(r.left + Math.min(r.width * 0.25, 120)),
            y: Math.round(r.top + Math.min(r.height * 0.2, 64)),
          };
        }
      }
    }

    const selPoint = this.selectionRangePoint(activeEl);
    if (selPoint) {
      return selPoint;
    }

    if (isInputOrTextarea(activeEl)) {
      const nativePoint = this.nativeInputCaretPoint(activeEl);
      if (nativePoint) {
        return nativePoint;
      }
    }

    return this.activeElementCenter();
  }

  private activeElementCenter(): { x: number; y: number } {
    const el = this.win.document.activeElement as HTMLElement | null;
    if (el && typeof el.getBoundingClientRect === "function") {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return {
          x: Math.round(r.left + Math.min(r.width * 0.5, 160)),
          y: Math.round(r.top + Math.min(r.height * 0.35, 80)),
        };
      }
    }
    return {
      x: Math.round((this.win.innerWidth || 800) / 2),
      y: Math.round((this.win.innerHeight || 600) / 2),
    };
  }

  private isRenderableVisible(el: Element | null | undefined): el is Element {
    if (!el || (el as { isConnected?: boolean }).isConnected === false) {
      return false;
    }
    if (typeof el.getBoundingClientRect !== "function") {
      return false;
    }
    try {
      return this.isVisible(el);
    } catch {
      return false;
    }
  }

  private clampViewportPoint(x: number, y: number): { x: number; y: number } {
    const maxX = Math.max(0, (this.win.innerWidth || 800) - 1);
    const maxY = Math.max(0, (this.win.innerHeight || 600) - 1);
    return {
      x: Math.max(0, Math.min(maxX, Math.round(x))),
      y: Math.max(0, Math.min(maxY, Math.round(y))),
    };
  }

  private pointOnElement(
    el: Element,
    mode: "header" | "modal" | "editor"
  ): { x: number; y: number } {
    const r = el.getBoundingClientRect();
    if (mode === "editor") {
      return this.clampViewportPoint(
        r.left + Math.min(r.width * 0.25, 120),
        r.top + Math.min(r.height * 0.2, 64)
      );
    }
    if (mode === "modal") {
      return this.clampViewportPoint(
        r.left + Math.min(r.width * 0.5, 180),
        r.top + Math.min(r.height * 0.2, 40)
      );
    }
    return this.clampViewportPoint(
      r.left + Math.min(r.width * 0.5, 160),
      r.top + r.height * 0.5
    );
  }

  private findVisibleModalTarget(): {
    point: { x: number; y: number };
    docContext: null;
  } | null {
    const modals = this.visibleModalElements();
    for (const modal of modals) {
      for (const [sel, mode] of [
        [".prompt-input", "header"],
        [".modal-title", "header"],
        [".modal, .prompt, [role=\"dialog\"]", "modal"],
      ] as const) {
        const inner = modal.querySelector?.(sel) ?? null;
        if (this.isRenderableVisible(inner)) {
          return { point: this.pointOnElement(inner, mode), docContext: null };
        }
      }
      if (this.isRenderableVisible(modal)) {
        return { point: this.pointOnElement(modal, "modal"), docContext: null };
      }
    }
    return null;
  }

  private findFileTreeElement(notePath: string): Element | null {
    const wanted = notePath.trim();
    if (!wanted) {
      return null;
    }
    for (const sel of [".nav-file-title[data-path]", "[data-path]"]) {
      let candidates: Element[];
      try {
        candidates = this.queryAll(sel);
      } catch {
        candidates = [];
      }
      for (const el of candidates) {
        if ((el.getAttribute("data-path") ?? "").trim() === wanted && this.isRenderableVisible(el)) {
          return el;
        }
      }
    }
    return null;
  }

  private resolveLeafResultPoint(
    leaf: NoteLeafContext
  ): { point: { x: number; y: number }; notePath: string; docContext: DocumentCursorContext | null } | null {
    const containerEl = leaf.containerEl;
    if (leaf.cm) {
      const caretPt = this.codeMirrorCaretPoint(null, leaf.cm);
      if (caretPt) {
        const bounds = this.scrollBounds(leaf.cm);
        if (
          caretPt.y >= bounds.top &&
          caretPt.y <= bounds.bottom &&
          caretPt.x >= bounds.left &&
          caretPt.x < bounds.right
        ) {
          const docContext =
            this.buildDocContext({
              cm: leaf.cm,
              notePath: leaf.path,
              paneId: leaf.pane,
              containerEl,
            }) ?? null;
          return {
            point: this.clampViewportPoint(caretPt.x, caretPt.y),
            notePath: leaf.path,
            docContext,
          };
        }
      }
    }

    for (const candidate of [
      containerEl.querySelector?.(".cm-content") ?? null,
      containerEl.querySelector?.(".view-content") ?? null,
      containerEl,
    ]) {
      if (this.isRenderableVisible(candidate)) {
        return {
          point: this.pointOnElement(candidate, "editor"),
          notePath: leaf.path,
          docContext: null,
        };
      }
    }
    return null;
  }

  private resolveActiveWorkspaceLeafResult(): {
    point: { x: number; y: number };
    notePath?: string;
    docContext: DocumentCursorContext | null;
  } | null {
    const ws = this.workspaceLike();
    const activeLeaf = ws?.activeLeaf ?? null;
    if (!activeLeaf) {
      return null;
    }
    const containerEl = this.leafContainer(activeLeaf);
    if (!this.isRenderableVisible(containerEl)) {
      return null;
    }
    const notePath = activeLeaf.view?.file?.path ?? "";
    const pane = this.describeLeafPane(activeLeaf, containerEl, this.collectWorkspaceLeaves());
    const rawCm = activeLeaf.view?.editor?.cm;
    const cm = this.extractCodeMirrorView(rawCm) ?? this.findCodeMirrorInContainer(containerEl);
    const leafCtx: NoteLeafContext = {
      path: notePath,
      pane,
      activePane: true,
      containerEl,
      cm,
    };
    const resolved = this.resolveLeafResultPoint(leafCtx);
    if (!resolved) {
      return null;
    }
    return {
      point: resolved.point,
      ...(notePath ? { notePath } : {}),
      docContext: resolved.docContext,
    };
  }

  private async pointAtResultNow(
    caller: string,
    target: PointAtResultTarget,
    label: string
  ): Promise<PointAtResultOutput> {
    const cleanLabel = typeof label === "string" ? label.trim() : "";
    if (!this.cursorOverlay || this.cursorOverlay.isEnabled?.() === false) {
      return { shown: false, label: cleanLabel };
    }
    await this.waitForPaint();

    let resolved: {
      point: { x: number; y: number };
      notePath?: string;
      docContext: DocumentCursorContext | null;
    } | null = null;

    if (target.element) {
      if (this.isRenderableVisible(target.element)) {
        const ctx = this.resolveElementLeafContext(target.element);
        const notePath = target.notePath ?? ctx?.notePath;
        const asLeaf =
          notePath && target.prefer !== "file-tree"
            ? this.findOpenNoteLeaf(notePath, target.element)
            : null;
        if (asLeaf) {
          resolved = this.resolveLeafResultPoint(asLeaf);
        }
        if (!resolved) {
          const isModal = target.element.matches?.(MODAL_SELECTOR) ?? false;
          const isEditor = Boolean(target.element.matches?.(".cm-content, .view-content, .workspace-leaf"));
          const innerEditor =
            !isModal && isEditor
              ? [
                  target.element.querySelector?.(".cm-content") ?? null,
                  target.element.querySelector?.(".view-content") ?? null,
                ].find((cand) => this.isRenderableVisible(cand)) ?? target.element
              : target.element;
          resolved = {
            point: this.pointOnElement(innerEditor, isModal ? "modal" : isEditor ? "editor" : "header"),
            ...(notePath ? { notePath } : {}),
            docContext: null,
          };
        }
      }
    } else if (typeof target.selector === "string" && target.selector.trim()) {
      let candidates: Element[];
      try {
        candidates = this.queryAll(target.selector);
      } catch {
        candidates = [];
      }
      const el = candidates.find((c) => this.isRenderableVisible(c)) ?? null;
      if (el) {
        const isModal = el.matches?.(MODAL_SELECTOR) ?? false;
        const isEditor = Boolean(el.matches?.(".cm-content, .view-content, .workspace-leaf"));
        const ctx = this.resolveElementLeafContext(el);
        resolved = {
          point: this.pointOnElement(el, isModal ? "modal" : isEditor ? "editor" : "header"),
          ...((target.notePath ?? ctx?.notePath) ? { notePath: target.notePath ?? ctx?.notePath } : {}),
          docContext: null,
        };
      }
    }

    if (!resolved) {
      const prefer = target.prefer ?? "auto";
      const notePath = typeof target.notePath === "string" ? target.notePath.trim() : "";

      if (prefer === "modal") {
        resolved = this.findVisibleModalTarget();
      }

      if (!resolved && notePath) {
        if (prefer === "file-tree") {
          const treeEl = this.findFileTreeElement(notePath);
          if (treeEl) {
            resolved = {
              point: this.pointOnElement(treeEl, "header"),
              notePath,
              docContext: null,
            };
          } else {
            const leaf = this.findOpenNoteLeaf(notePath);
            if (leaf) {
              resolved = this.resolveLeafResultPoint(leaf);
            }
          }
        } else {
          const leaf = this.findOpenNoteLeaf(notePath);
          if (leaf) {
            resolved = this.resolveLeafResultPoint(leaf);
          }
          if (!resolved) {
            const treeEl = this.findFileTreeElement(notePath);
            if (treeEl) {
              resolved = {
                point: this.pointOnElement(treeEl, "header"),
                notePath,
                docContext: null,
              };
            }
          }
        }
      }

      if (!resolved && prefer !== "file-tree") {
        resolved = this.findVisibleModalTarget() ?? this.resolveActiveWorkspaceLeafResult();
      }
    }

    if (!resolved) {
      return { shown: false, label: cleanLabel };
    }

    this.showCursor(
      caller,
      "move",
      resolved.point.x,
      resolved.point.y,
      cleanLabel || "move",
      undefined,
      resolved.docContext
    );
    return {
      shown: true,
      x: resolved.point.x,
      y: resolved.point.y,
      ...(resolved.notePath ? { notePath: resolved.notePath } : {}),
      label: cleanLabel,
    };
  }

  private visibleModalElements(): Element[] {
    try {
      return this.queryAll(MODAL_SELECTOR).filter((el) => this.isVisible(el));
    } catch {
      return [];
    }
  }

  private captureFocusSnapshot(): FocusSnapshot {
    const doc = this.win.document;
    const raw = (doc.activeElement as HTMLElement | null) ?? null;
    const element =
      raw && raw !== doc.body && raw !== doc.documentElement && raw.isConnected !== false
        ? raw
        : null;

    let selectionStart: number | null = null;
    let selectionEnd: number | null = null;
    let selectionDirection: "forward" | "backward" | "none" | null = null;
    if (element && isInputOrTextarea(element)) {
      if (typeof element.selectionStart === "number") {
        selectionStart = element.selectionStart;
      }
      if (typeof element.selectionEnd === "number") {
        selectionEnd = element.selectionEnd;
      }
      if (
        element.selectionDirection === "forward" ||
        element.selectionDirection === "backward" ||
        element.selectionDirection === "none"
      ) {
        selectionDirection = element.selectionDirection;
      }
    }

    const domRanges: Range[] = [];
    if (element && !isInputOrTextarea(element)) {
      const sel = this.win.getSelection?.();
      if (sel && sel.rangeCount > 0) {
        for (let i = 0; i < sel.rangeCount; i += 1) {
          try {
            const range = sel.getRangeAt(i);
            domRanges.push(typeof range.cloneRange === "function" ? range.cloneRange() : range);
          } catch {
            // Skip unreadable ranges.
          }
        }
      }
    }

    return {
      element,
      selectionStart,
      selectionEnd,
      selectionDirection,
      domRanges,
      visibleModals: new Set(this.visibleModalElements()),
    };
  }

  private restoreElementFocusAndSelection(
    beforeEl: HTMLElement,
    before: FocusSnapshot
  ): void {
    try {
      if (typeof beforeEl.focus === "function") {
        beforeEl.focus({ preventScroll: true });
      }
    } catch {
      try {
        beforeEl.focus?.();
      } catch {
        // Ignore disconnected or unfocusable targets.
      }
    }
    if (
      isInputOrTextarea(beforeEl) &&
      before.selectionStart !== null &&
      before.selectionEnd !== null &&
      typeof beforeEl.setSelectionRange === "function"
    ) {
      try {
        beforeEl.setSelectionRange(
          before.selectionStart,
          before.selectionEnd,
          before.selectionDirection ?? undefined
        );
      } catch {
        // Ignore input types that reject selection ranges.
      }
    } else if (before.domRanges.length > 0) {
      const sel = this.win.getSelection?.();
      if (sel && typeof sel.removeAllRanges === "function" && typeof sel.addRange === "function") {
        try {
          sel.removeAllRanges();
          for (const range of before.domRanges) {
            sel.addRange(range);
          }
        } catch {
          // Ignore stale DOM ranges.
        }
      }
    }
  }

  private matchesAgentKeyName(evKey: string | undefined, expected: string): boolean {
    if (!evKey) {
      return false;
    }
    const normalize = (value: string): string => {
      const lower = value.toLowerCase();
      const aliases: Record<string, string> = {
        return: "enter",
        enter: "enter",
        space: " ",
        " ": " ",
        esc: "escape",
        escape: "escape",
        del: "delete",
        delete: "delete",
        backspace: "backspace",
        left: "arrowleft",
        arrowleft: "arrowleft",
        right: "arrowright",
        arrowright: "arrowright",
        up: "arrowup",
        arrowup: "arrowup",
        down: "arrowdown",
        arrowdown: "arrowdown",
        pageup: "pageup",
        pgup: "pageup",
        pagedown: "pagedown",
        pgdn: "pagedown",
        home: "home",
        end: "end",
        insert: "insert",
        ins: "insert",
        tab: "tab",
      };
      return aliases[lower] ?? lower;
    };
    return normalize(evKey) === normalize(expected);
  }

  private consumeAgentDispatchedEvent(ev: {
    type?: string;
    key?: string;
    data?: string | null;
  }): boolean {
    const evType = ev.type;
    if (evType === "keydown" || evType === "keypress") {
      if (this.agentKeyDepth <= 0) {
        return false;
      }
      if (!this.agentKeyMatch) {
        return true;
      }
      const keyVal = typeof ev.key === "string" ? ev.key : (ev.data ?? "");
      return this.matchesAgentKeyName(keyVal, this.agentKeyMatch);
    }
    if (evType === "beforeinput") {
      const dataVal = typeof ev.data === "string" ? ev.data : "";
      if (this.agentInsertTextChunk !== null && dataVal === this.agentInsertTextChunk) {
        return true;
      }
      if (this.agentKeyDepth > 0) {
        if (!this.agentKeyMatch) {
          return true;
        }
        return this.matchesAgentKeyName(dataVal || ev.key, this.agentKeyMatch);
      }
    }
    return false;
  }

  private attachUserInputCaptureListener(session: FocusShieldSession): () => void {
    const doc = this.win.document as unknown as {
      addEventListener?: (
        type: string,
        listener: (event: unknown) => void,
        options?: boolean | { capture?: boolean }
      ) => void;
      removeEventListener?: (
        type: string,
        listener: (event: unknown) => void,
        options?: boolean | { capture?: boolean }
      ) => void;
    };
    const winTarget = this.win as unknown as typeof doc;
    const host =
      typeof doc.addEventListener === "function" && typeof doc.removeEventListener === "function"
        ? doc
        : typeof winTarget.addEventListener === "function" &&
            typeof winTarget.removeEventListener === "function"
          ? winTarget
          : null;
    if (!host?.addEventListener || !host?.removeEventListener) {
      return () => undefined;
    }

    const types: Array<CapturedUserEvent["type"]> = ["keydown", "keypress", "beforeinput"];
    const handler = (rawEvent: unknown): void => {
      if (this.replayingUserInput || !rawEvent || typeof rawEvent !== "object") {
        return;
      }
      const expectedBase = session.userElement ?? this.win.document.body ?? null;
      const focusMovedAway = (this.win.document.activeElement ?? null) !== expectedBase;
      if (!focusMovedAway && session.activeCount <= 0) {
        return;
      }
      const ev = rawEvent as {
        type?: string;
        isTrusted?: boolean;
        key?: string;
        code?: string;
        keyCode?: number;
        charCode?: number;
        which?: number;
        data?: string | null;
        inputType?: string;
        shiftKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        metaKey?: boolean;
        repeat?: boolean;
        preventDefault?: () => void;
        stopImmediatePropagation?: () => void;
        stopPropagation?: () => void;
      };
      if (ev.isTrusted === false) {
        return;
      }
      if (
        ev.type !== "keydown" &&
        ev.type !== "keypress" &&
        ev.type !== "beforeinput"
      ) {
        return;
      }
      if (this.consumeAgentDispatchedEvent(ev)) {
        return;
      }
      ev.preventDefault?.();
      ev.stopImmediatePropagation?.();
      ev.stopPropagation?.();
      session.captured.push({
        type: ev.type,
        ...(typeof ev.key === "string" ? { key: ev.key } : {}),
        ...(typeof ev.code === "string" ? { code: ev.code } : {}),
        ...(typeof ev.keyCode === "number" ? { keyCode: ev.keyCode } : {}),
        ...(typeof ev.charCode === "number" ? { charCode: ev.charCode } : {}),
        ...(typeof ev.which === "number" ? { which: ev.which } : {}),
        ...(ev.data !== undefined ? { data: ev.data } : {}),
        ...(typeof ev.inputType === "string" ? { inputType: ev.inputType } : {}),
        ...(typeof ev.shiftKey === "boolean" ? { shiftKey: ev.shiftKey } : {}),
        ...(typeof ev.ctrlKey === "boolean" ? { ctrlKey: ev.ctrlKey } : {}),
        ...(typeof ev.altKey === "boolean" ? { altKey: ev.altKey } : {}),
        ...(typeof ev.metaKey === "boolean" ? { metaKey: ev.metaKey } : {}),
        ...(typeof ev.repeat === "boolean" ? { repeat: ev.repeat } : {}),
      });
    };

    for (const type of types) {
      host.addEventListener(type, handler, { capture: true });
    }
    return () => {
      for (const type of types) {
        host.removeEventListener?.(type, handler, { capture: true });
      }
    };
  }

  /**
   * Captures user-originated keyboard/beforeinput events during raw focus-based input
   * actions so interleaved user typing cannot land inside the agent's target control.
   */
  private async runWithUserInputShield<T>(task: () => Promise<T>): Promise<T> {
    const session = this.activeShield;
    if (!session) {
      return task();
    }
    session.activeCount += 1;
    if (!session.detach) {
      session.detach = this.attachUserInputCaptureListener(session);
    }
    try {
      return await task();
    } finally {
      session.activeCount = Math.max(0, session.activeCount - 1);
    }
  }

  private buildReplayDomEvent(ev: CapturedUserEvent): unknown {
    const winRec = this.win as unknown as {
      KeyboardEvent?: new (type: string, init: Record<string, unknown>) => unknown;
      InputEvent?: new (type: string, init: Record<string, unknown>) => unknown;
    };
    const KeyboardCtor = winRec.KeyboardEvent;
    const InputCtor = winRec.InputEvent;
    if (ev.type === "beforeinput") {
      if (typeof InputCtor === "function") {
        try {
          return new InputCtor("beforeinput", {
            data: ev.data ?? null,
            inputType: ev.inputType ?? "insertText",
            bubbles: true,
            cancelable: true,
          });
        } catch {
          // Fall back to plain mock event object below.
        }
      }
      return {
        type: "beforeinput",
        data: ev.data ?? null,
        inputType: ev.inputType ?? "insertText",
        bubbles: true,
        cancelable: true,
      };
    }
    const init: Record<string, unknown> = {
      key: ev.key ?? "",
      code: ev.code ?? "",
      keyCode: ev.keyCode,
      charCode: ev.charCode,
      which: ev.which,
      shiftKey: Boolean(ev.shiftKey),
      ctrlKey: Boolean(ev.ctrlKey),
      altKey: Boolean(ev.altKey),
      metaKey: Boolean(ev.metaKey),
      repeat: Boolean(ev.repeat),
      bubbles: true,
      cancelable: true,
    };
    if (typeof KeyboardCtor === "function") {
      try {
        return new KeyboardCtor(ev.type, init);
      } catch {
        // Fall back to plain mock event object below.
      }
    }
    return { type: ev.type, ...init };
  }

  private applyTextToNativeInput(
    target: HTMLInputElement | HTMLTextAreaElement,
    insertText: string,
    backspace = false
  ): void {
    const value = typeof target.value === "string" ? target.value : "";
    const start =
      typeof target.selectionStart === "number" ? target.selectionStart : value.length;
    const end =
      typeof target.selectionEnd === "number" ? target.selectionEnd : start;
    if (backspace) {
      const nextStart = start === end ? Math.max(0, start - 1) : start;
      target.value = value.slice(0, nextStart) + value.slice(end);
      if (typeof target.setSelectionRange === "function") {
        target.setSelectionRange(nextStart, nextStart);
      } else {
        target.selectionStart = nextStart;
        target.selectionEnd = nextStart;
      }
    } else {
      target.value = value.slice(0, start) + insertText + value.slice(end);
      const nextPos = start + insertText.length;
      if (typeof target.setSelectionRange === "function") {
        target.setSelectionRange(nextPos, nextPos);
      } else {
        target.selectionStart = nextPos;
        target.selectionEnd = nextPos;
      }
    }
    const dispatcher = target as unknown as { dispatchEvent?: (event: unknown) => boolean };
    if (typeof dispatcher.dispatchEvent === "function") {
      const InputCtor = (
        this.win as unknown as { InputEvent?: new (type: string, init: Record<string, unknown>) => unknown }
      ).InputEvent;
      const inputEv =
        typeof InputCtor === "function"
          ? new InputCtor("input", {
              data: backspace ? null : insertText,
              inputType: backspace ? "deleteContentBackward" : "insertText",
              bubbles: true,
            })
          : {
              type: "input",
              data: backspace ? null : insertText,
              inputType: backspace ? "deleteContentBackward" : "insertText",
              bubbles: true,
            };
      dispatcher.dispatchEvent(inputEv);
    }
  }

  private async replayCapturedUserInputs(
    target: HTMLElement,
    captured: CapturedUserEvent[],
    preserveCurrentFocus = false
  ): Promise<void> {
    if (captured.length === 0 || target.isConnected === false) {
      return;
    }
    const isElectron =
      typeof process !== "undefined" &&
      Boolean((process as { versions?: { electron?: string } }).versions?.electron);
    const wc = this.getWebContents();
    this.replayingUserInput = true;
    try {
      if (isElectron && wc && !preserveCurrentFocus && this.win.document.activeElement === target) {
        let lastKeyChar: string | null = null;
        for (const ev of captured) {
          if (ev.type === "keydown") {
            const key = ev.key ?? "";
            if (!key || key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") {
              continue;
            }
            const modifiers: string[] = [];
            if (ev.shiftKey) modifiers.push("Shift");
            if (ev.ctrlKey) modifiers.push("Control");
            if (ev.altKey) modifiers.push("Alt");
            if (ev.metaKey) modifiers.push("Meta");
            try {
              const press = buildKeyPress(key, modifiers, this.platform);
              wc.sendInputEvent({ type: "keyDown", keyCode: press.keyCode, modifiers: press.modifiers });
              if (press.text !== null) {
                wc.sendInputEvent({ type: "char", keyCode: press.text, modifiers: press.modifiers });
              }
              wc.sendInputEvent({ type: "keyUp", keyCode: press.keyCode, modifiers: press.modifiers });
              lastKeyChar = press.text;
            } catch {
              if (key.length === 1 && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
                await wc.insertText(key);
                lastKeyChar = key;
              }
            }
          } else if (ev.type === "keypress") {
            const ch = ev.key || ev.data || "";
            if (lastKeyChar !== null && ch === lastKeyChar) {
              continue;
            }
            if (ch.length === 1 && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
              await wc.insertText(ch);
              lastKeyChar = ch;
            }
          } else if (ev.type === "beforeinput") {
            const data = typeof ev.data === "string" ? ev.data : "";
            if (!data) {
              continue;
            }
            if (lastKeyChar === data) {
              lastKeyChar = null;
              continue;
            }
            lastKeyChar = null;
            await wc.insertText(data);
          }
        }
        return;
      }

      const dispatcher = target as unknown as { dispatchEvent?: (event: unknown) => boolean };
      const nativeTarget = isInputOrTextarea(target) ? target : null;
      let insertedForKey: string | null = null;
      for (const ev of captured) {
        const domEv = this.buildReplayDomEvent(ev);
        const notCanceled =
          typeof dispatcher.dispatchEvent === "function" ? dispatcher.dispatchEvent(domEv) !== false : true;
        if (!nativeTarget || !notCanceled) {
          continue;
        }
        if (ev.type === "keydown") {
          const key = ev.key ?? "";
          if (key === "Backspace" && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
            this.applyTextToNativeInput(nativeTarget, "", true);
            insertedForKey = null;
          } else if (key === "Enter" && (nativeTarget.tagName ?? "").toUpperCase() === "TEXTAREA" && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
            this.applyTextToNativeInput(nativeTarget, "\n");
            insertedForKey = "\n";
          } else if (key.length === 1 && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
            this.applyTextToNativeInput(nativeTarget, key);
            insertedForKey = key;
          } else {
            insertedForKey = null;
          }
        } else if (ev.type === "keypress") {
          const ch = ev.key || ev.data || "";
          if (insertedForKey !== null && ch === insertedForKey) {
            continue;
          }
          if (ch.length === 1 && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
            this.applyTextToNativeInput(nativeTarget, ch);
            insertedForKey = ch;
          }
        } else if (ev.type === "beforeinput") {
          const data = typeof ev.data === "string" ? ev.data : "";
          if (data && data === insertedForKey) {
            insertedForKey = null;
            continue;
          }
          insertedForKey = null;
          if (data) {
            this.applyTextToNativeInput(nativeTarget, data);
          }
        }
      }
    } finally {
      this.replayingUserInput = false;
    }
  }

  /**
   * Preserves the user's keyboard focus across an agent action that borrows DOM
   * focus: attaches a continuous input shield for the entire borrowed-focus
   * interval, restores focus afterward unless a modal was opened, and retains
   * or re-delivers captured user keystrokes in either outcome.
   */
  private async withFocusRestore<T>(task: () => Promise<T>): Promise<T> {
    const before = this.captureFocusSnapshot();
    const ownsShield = this.activeShield === null;
    const shieldSession: FocusShieldSession = this.activeShield ?? {
      userElement: before.element,
      activeCount: 0,
      captured: [],
      detach: null,
    };
    if (ownsShield) {
      shieldSession.detach = this.attachUserInputCaptureListener(shieldSession);
      this.activeShield = shieldSession;
    }
    try {
      return await task();
    } finally {
      if (ownsShield) {
        shieldSession.detach?.();
        shieldSession.detach = null;
        this.activeShield = null;
      }
      const beforeEl = before.element;
      const doc = this.win.document;
      const afterEl = (doc.activeElement as HTMLElement | null) ?? null;
      let blockedByModal = false;
      if (beforeEl && beforeEl.isConnected !== false && afterEl !== beforeEl) {
        const afterModals = this.visibleModalElements();
        const openedNewModal = afterModals.some((el) => !before.visibleModals.has(el));
        const beforeInModal = Boolean(beforeEl.closest?.(MODAL_SELECTOR));
        const afterInModal = Boolean(afterEl?.closest?.(MODAL_SELECTOR));
        blockedByModal = openedNewModal || (afterInModal && !beforeInModal);
        if (!blockedByModal) {
          this.restoreElementFocusAndSelection(beforeEl, before);
        }
      }
      if (ownsShield && shieldSession.captured.length > 0) {
        if (beforeEl && beforeEl.isConnected !== false) {
          await this.replayCapturedUserInputs(beforeEl, shieldSession.captured, blockedByModal);
          if (blockedByModal && afterEl && afterEl.isConnected !== false && doc.activeElement !== afterEl) {
            try {
              afterEl.focus?.({ preventScroll: true });
            } catch {
              afterEl.focus?.();
            }
          }
        } else {
          this.deferredUserInputs.push(...shieldSession.captured);
        }
      }
    }
  }

  private isProtectedAreasAllowed(): boolean {
    try {
      return this.getAllowUiInProtectedAreas() === true;
    } catch {
      return false;
    }
  }

  private findClosestElement(el: Element | null | undefined, selector: string): Element | null {
    if (!el || typeof el.closest !== "function") {
      return null;
    }
    try {
      return el.closest(selector);
    } catch {
      return null;
    }
  }

  private detectProtectedArea(el: Element | null | undefined): string | null {
    if (!el) {
      return null;
    }
    if (this.findClosestElement(el, HERDR_TERMINAL_PROTECTED_SELECTOR)) {
      return "the Herdr terminal view";
    }
    if (this.findClosestElement(el, COMMUNITY_PLUGIN_PROTECTED_SELECTOR)) {
      return "community plugin settings and toggles";
    }
    if (this.findClosestElement(el, SETTINGS_MODAL_PROTECTED_SELECTOR)) {
      return "the Obsidian Settings modal";
    }
    const modal = this.findClosestElement(el, '.modal, .modal-container, [role="dialog"]');
    if (modal) {
      try {
        if (
          modal.querySelector?.(".mod-settings, .installed-plugins-container, .vertical-tabs-container") ||
          modal.querySelector?.(".modal-title")?.textContent?.trim() === "Settings"
        ) {
          return "the Obsidian Settings modal";
        }
      } catch {
        // Ignore query errors on minimal mocks.
      }
    }
    return null;
  }

  private assertElementNotProtected(el: Element | null | undefined, action: string): void {
    if (this.isProtectedAreasAllowed()) {
      return;
    }
    const area = this.detectProtectedArea(el);
    if (!area) {
      return;
    }
    throw new UiControlError(
      "ui_protected_area",
      `Refused ui.${action} inside ${area}. Ask the user to operate protected controls manually, or enable allowUiInProtectedAreas in Herdr settings if explicitly authorized.`
    );
  }

  private elementAtPoint(point: { x: number; y: number }): Element | null {
    try {
      return this.win.document.elementFromPoint?.(point.x, point.y) ?? null;
    } catch {
      return null;
    }
  }

  private isElementWithinContainer(el: Element, container: Element): boolean {
    if (el === container || Boolean(container.contains?.(el))) {
      return true;
    }
    try {
      return typeof el.closest === "function" && el.closest(".workspace-leaf") === container;
    } catch {
      return false;
    }
  }

  private expectedTargetContainer(resolved: ResolvedUiTarget): Element | null {
    if (resolved.containerEl) {
      return resolved.containerEl;
    }
    if (resolved.isSelector) {
      return resolved.element ?? null;
    }
    return null;
  }

  /**
   * Validates the topmost element under the dispatch point right before input delivery so
   * overlays (protected Settings/Terminal areas or ordinary covering modals) block the event.
   */
  private assertPointReceiverSafe(
    point: { x: number; y: number },
    action: string,
    expectedContainer?: Element | null
  ): void {
    const hit = this.elementAtPoint(point);
    if (!hit) {
      return;
    }
    this.assertElementNotProtected(hit, action);
    if (expectedContainer && !this.isElementWithinContainer(hit, expectedContainer)) {
      throw new UiControlError(
        "ui_target_covered",
        `Target for ui.${action} is covered by another element.`
      );
    }
  }

  private findSectionHeadingAbove(
    lines: Array<{ number: number; text: string; from: number; to: number }>,
    targetLineNumber: number
  ): string | null {
    const limit = Math.min(lines.length, Math.max(0, targetLineNumber - 1));
    let fence: OpenFence | null = null;
    let currentHeading: string | null = null;
    for (let i = 0; i < limit; i += 1) {
      const wasInFence = fence !== null;
      fence = nextFenceState(lines[i].text, fence);
      if (wasInFence || fence !== null) {
        continue;
      }
      const m = /^\s*(#{1,6})\s+(.+?)\s*$/.exec(lines[i].text);
      if (!m) {
        continue;
      }
      const title = m[2].replace(/\s+#+\s*$/, "").trim();
      if (title) {
        currentHeading = title;
      }
    }
    return currentHeading;
  }

  private readLiveSplitPath(
    targetLeaf: NoteLeafContext
  ): string | null {
    const liveView = targetLeaf.workspaceLeaf?.view ?? targetLeaf.view ?? null;
    if (liveView && "file" in liveView) {
      return liveView.file?.path ?? null;
    }
    const elCtx = this.resolveElementLeafContext(targetLeaf.containerEl);
    if (elCtx?.notePath !== undefined) {
      return elCtx.notePath ?? null;
    }
    return targetLeaf.path;
  }

  private readInsertedLineProof(
    targetLeaf: NoteLeafContext,
    targetCm: CodeMirrorViewLike | null,
    expectedLine: number,
    insertedStartPos?: number
  ): { path: string; line: number; text: string; heading: string | null } {
    if (targetLeaf.containerEl?.isConnected === false) {
      throw new UiControlError(
        "ui_target_changed",
        `Target split for '${targetLeaf.path}' was closed before insert_line completed.`
      );
    }
    if (
      targetLeaf.workspaceLeaf &&
      targetLeaf.view &&
      targetLeaf.workspaceLeaf.view !== targetLeaf.view
    ) {
      throw new UiControlError(
        "ui_target_changed",
        `Target split for '${targetLeaf.path}' changed views before insert_line completed.`
      );
    }
    const livePath = this.readLiveSplitPath(targetLeaf);
    if (livePath !== targetLeaf.path) {
      throw new UiControlError(
        "ui_target_changed",
        `Target split switched from '${targetLeaf.path}' to '${livePath ?? "closed note"}' before insert_line completed.`
      );
    }
    const liveCm = targetCm ?? targetLeaf.cm ?? null;
    const liveViewCm = this.extractCodeMirrorView(targetLeaf.view?.editor?.cm);
    if (liveCm && liveViewCm && liveViewCm !== liveCm) {
      throw new UiControlError(
        "ui_target_changed",
        `Target editor for '${targetLeaf.path}' was replaced before insert_line completed.`
      );
    }

    const liveViewText =
      typeof targetLeaf.view?.getViewData === "function"
        ? targetLeaf.view.getViewData()
        : typeof targetLeaf.view?.data === "string"
          ? targetLeaf.view.data
          : undefined;
    const proofLeaf: NoteLeafContext =
      typeof liveViewText === "string" && !liveCm?.state?.doc
        ? { ...targetLeaf, contentText: liveViewText }
        : targetLeaf;
    const lines = this.buildLines(liveCm, proofLeaf);
    if (lines.length === 0) {
      return { path: targetLeaf.path, line: expectedLine, text: "", heading: null };
    }
    const offsetLine =
      typeof insertedStartPos === "number" && Number.isFinite(insertedStartPos)
        ? (lines.find(
            (entry) => insertedStartPos >= entry.from && insertedStartPos <= entry.to
          ) ?? null)
        : null;
    const head = liveCm?.state?.selection?.main?.head;
    const headLine =
      typeof head === "number" && Number.isFinite(head)
        ? (lines.find((entry) => head >= entry.from && head <= entry.to) ?? null)
        : null;
    const fallbackIdx = Math.max(0, Math.min(lines.length - 1, expectedLine - 1));
    const targetLine = offsetLine ?? headLine ?? lines[fallbackIdx];
    const heading = this.findSectionHeadingAbove(lines, targetLine.number);
    return {
      path: targetLeaf.path,
      line: targetLine.number,
      text: targetLine.text,
      heading,
    };
  }

  focusState(): FocusState {
    const el = this.win.document.activeElement as HTMLElement | null;
    if (!el || el === this.win.document.body) {
      return { tag: el ? el.tagName.toLowerCase() : null, label: "", editable: false, password: false };
    }
    const input = el as HTMLInputElement;
    const password = el.matches('input[type="password"]');
    const editable =
      !input.readOnly &&
      !input.disabled &&
      (el.isContentEditable ||
        el.matches(
          'textarea,input:not([type]),input[type="text"],input[type="search"],input[type="email"],input[type="url"],input[type="tel"],input[type="number"]'
        ));
    return {
      tag: el.tagName.toLowerCase(),
      label: el.getAttribute("aria-label") ?? "",
      editable,
      password,
    };
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private requireWebContents(): WebContentsLike {
    let wc: WebContentsLike | null = null;
    try {
      wc = this.getWebContents();
    } catch {
      wc = null;
    }
    if (!wc) {
      throw new UiControlError(
        "ui_unavailable",
        "This Obsidian build does not expose window capture and input to plugins."
      );
    }
    return wc;
  }

  private viewport(): { width: number; height: number; devicePixelRatio: number } {
    return {
      width: this.win.innerWidth,
      height: this.win.innerHeight,
      devicePixelRatio: this.win.devicePixelRatio || 1,
    };
  }

  private waitForPaint(): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      try {
        this.win.requestAnimationFrame(() => this.win.requestAnimationFrame(finish));
      } catch {
        finish();
      }
      this.win.setTimeout(finish, 300);
    });
  }

  /** CSS pixels from getBoundingClientRect to window coordinates for sendInputEvent. */
  private toWindowPoint(wc: WebContentsLike, point: { x: number; y: number }): { x: number; y: number } {
    let zoom = 1;
    try {
      zoom = wc.getZoomFactor?.() ?? 1;
    } catch {
      zoom = 1;
    }
    if (!Number.isFinite(zoom) || zoom <= 0) {
      zoom = 1;
    }
    return { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) };
  }

  private isVisible(el: Element): boolean {
    const r = el.getBoundingClientRect();
    const s = this.win.getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < this.win.innerHeight &&
      r.left < this.win.innerWidth &&
      s.visibility !== "hidden" &&
      s.display !== "none"
    );
  }

  private selectorPath(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    const root = this.win.document.documentElement;
    while (node && node !== root) {
      if (node.id) {
        const escaped =
          typeof CSS !== "undefined" && typeof CSS.escape === "function"
            ? CSS.escape(node.id)
            : node.id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
        parts.unshift(`#${escaped}`);
        break;
      }
      const parent: Element | null = node.parentElement;
      const index = parent ? Array.from(parent.children).indexOf(node) + 1 : 1;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`);
      node = parent;
    }
    return parts.join(" > ");
  }

  private queryAll(selector: string): Element[] {
    try {
      return Array.from(this.win.document.querySelectorAll(selector));
    } catch {
      throw new UiControlError("invalid_params", `Invalid CSS selector: ${selector}`);
    }
  }

  private collect(
    selector: string,
    limit: number,
    matchText: string | null,
    innermostOnly = false
  ): { viewport: unknown; total: number; truncated: boolean; elements: InspectedElement[] } {
    const textOf = (el: Element): string =>
      (el as HTMLElement).innerText || el.textContent || "";
    let all = this.queryAll(selector)
      .filter((el) => this.isVisible(el))
      .filter(
        (el) =>
          matchText === null ||
          textOf(el).includes(matchText) ||
          (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "").includes(matchText)
      );
    if (innermostOnly) {
      all = all.filter((el) => !all.some((other) => other !== el && el.contains(other)));
    }
    const elements = all.slice(0, limit).map((el): InspectedElement => {
      const r = el.getBoundingClientRect();
      const field = el as HTMLInputElement;
      const isField = el.matches('input:not([type="password"]),textarea,select');
      const ctx = this.resolveElementLeafContext(el);
      return {
        selector: this.selectorPath(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        label: el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "",
        text: textOf(el).trim().slice(0, 180),
        ...(isField ? { value: field.value } : {}),
        disabled: Boolean(field.disabled),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        ...(ctx?.notePath ? { notePath: ctx.notePath } : {}),
        ...(ctx?.pane ? { pane: ctx.pane } : {}),
        ...(ctx && typeof ctx.activePane === "boolean" ? { activePane: ctx.activePane } : {}),
      };
    });
    return { viewport: this.viewport(), total: all.length, truncated: all.length > elements.length, elements };
  }

  private workspaceLike(): {
    activeLeaf?: WorkspaceLeafLike | null;
    leftSplit?: unknown;
    rightSplit?: unknown;
    iterateAllLeaves?: (cb: (leaf: WorkspaceLeafLike) => void) => void;
    getLeavesOfType?: (type: string) => WorkspaceLeafLike[];
  } | null {
    const winWithApp = this.win as unknown as {
      app?: {
        workspace?: {
          activeLeaf?: WorkspaceLeafLike | null;
          leftSplit?: unknown;
          rightSplit?: unknown;
          iterateAllLeaves?: (cb: (leaf: WorkspaceLeafLike) => void) => void;
          getLeavesOfType?: (type: string) => WorkspaceLeafLike[];
        };
      };
    };
    return winWithApp.app?.workspace ?? null;
  }

  private collectWorkspaceLeaves(typeFilter?: string): WorkspaceLeafLike[] {
    const ws = this.workspaceLike();
    if (!ws) {
      return [];
    }
    const seen = new Set<WorkspaceLeafLike>();
    const out: WorkspaceLeafLike[] = [];
    const add = (leaf: WorkspaceLeafLike): void => {
      if (!seen.has(leaf)) {
        seen.add(leaf);
        out.push(leaf);
      }
    };
    if (typeFilter && typeof ws.getLeavesOfType === "function") {
      for (const leaf of ws.getLeavesOfType(typeFilter)) {
        add(leaf);
      }
      if (out.length > 0) {
        return out;
      }
    }
    if (typeof ws.iterateAllLeaves === "function") {
      ws.iterateAllLeaves((leaf) => {
        if (!typeFilter || leaf.view?.getViewType?.() === typeFilter || Boolean(leaf.view?.file)) {
          add(leaf);
        }
      });
    }
    if (out.length === 0 && typeof ws.getLeavesOfType === "function") {
      for (const leaf of ws.getLeavesOfType(typeFilter ?? "markdown")) {
        add(leaf);
      }
    }
    return out;
  }

  private leafContainer(leaf: WorkspaceLeafLike): Element | null {
    return leaf.containerEl ?? leaf.view?.containerEl ?? null;
  }

  private describeLeafPane(
    leaf: WorkspaceLeafLike | null,
    containerEl: Element | null,
    allLeaves: WorkspaceLeafLike[]
  ): string {
    if (typeof leaf?.id === "string" && leaf.id.trim()) {
      return leaf.id.trim();
    }
    const ws = this.workspaceLike();
    if (
      (leaf && ws?.leftSplit && leaf.getRoot?.() === ws.leftSplit) ||
      containerEl?.closest?.(".mod-left-split")
    ) {
      return "left-sidebar";
    }
    if (
      (leaf && ws?.rightSplit && leaf.getRoot?.() === ws.rightSplit) ||
      containerEl?.closest?.(".mod-right-split")
    ) {
      return "right-sidebar";
    }
    const visibleMain = allLeaves.filter((candidate) => {
      const c = this.leafContainer(candidate);
      if (!c || !this.isVisible(c)) {
        return false;
      }
      if (
        (ws?.leftSplit && candidate.getRoot?.() === ws.leftSplit) ||
        (ws?.rightSplit && candidate.getRoot?.() === ws.rightSplit) ||
        c.closest?.(".mod-left-split, .mod-right-split")
      ) {
        return false;
      }
      return true;
    });
    if (leaf && visibleMain.length > 0) {
      visibleMain.sort((a, b) => {
        const ra = this.leafContainer(a)?.getBoundingClientRect?.();
        const rb = this.leafContainer(b)?.getBoundingClientRect?.();
        const dx = (ra?.left ?? 0) - (rb?.left ?? 0);
        return dx !== 0 ? dx : (ra?.top ?? 0) - (rb?.top ?? 0);
      });
      if (visibleMain.length === 1) {
        return "main";
      }
      const idx = visibleMain.indexOf(leaf);
      if (visibleMain.length === 2 && idx >= 0) {
        return idx === 0 ? "left" : "right";
      }
      if (idx >= 0) {
        return `pane-${idx + 1}`;
      }
    }
    const domId = containerEl?.getAttribute?.("data-leaf-id") ?? containerEl?.id ?? "";
    if (domId.trim()) {
      return domId.trim();
    }
    if (containerEl) {
      const domLeaves = this.queryAll(".workspace-leaf").filter((el) => this.isVisible(el));
      const domIdx = domLeaves.indexOf(containerEl);
      if (domIdx >= 0) {
        return domLeaves.length === 1 ? "main" : `pane-${domIdx + 1}`;
      }
    }
    return "active";
  }

  private isLeafActive(leaf: WorkspaceLeafLike | null, containerEl: Element | null): boolean {
    const ws = this.workspaceLike();
    if (leaf && ws?.activeLeaf) {
      return ws.activeLeaf === leaf;
    }
    return Boolean(containerEl?.classList?.contains("mod-active"));
  }

  private resolveElementLeafContext(el: Element): ElementLeafContext | null {
    if (this.resolveElementContext) {
      const custom = this.resolveElementContext(el);
      if (
        custom &&
        (custom.notePath !== undefined ||
          custom.pane !== undefined ||
          custom.activePane !== undefined)
      ) {
        return custom;
      }
    }

    const leafEl = el.closest?.(".workspace-leaf") ?? null;
    const leaves = this.collectWorkspaceLeaves();
    if (leaves.length > 0) {
      for (const leaf of leaves) {
        const container = this.leafContainer(leaf);
        if (!container) {
          continue;
        }
        if (
          container === el ||
          container === leafEl ||
          container.contains(el)
        ) {
          const notePath = leaf.view?.file?.path;
          return {
            ...(notePath ? { notePath } : {}),
            pane: this.describeLeafPane(leaf, container, leaves),
            activePane: this.isLeafActive(leaf, container),
          };
        }
      }
    }

    if (!leafEl) {
      return null;
    }

    const directPath =
      leafEl.getAttribute("data-note-path") ?? leafEl.getAttribute("data-path") ?? "";
    let notePath = directPath.trim();
    if (!notePath) {
      const titleEl = leafEl.querySelector?.(".view-header-title");
      const title = titleEl?.textContent?.trim() ?? "";
      if (title) {
        const crumbs = Array.from(leafEl.querySelectorAll?.(".view-header-breadcrumb") ?? [])
          .map((c) => c.textContent?.trim() ?? "")
          .filter(Boolean);
        const joined = [...crumbs, title].join("/");
        notePath = joined.endsWith(".md") ? joined : `${joined}.md`;
      }
    }
    return {
      ...(notePath ? { notePath } : {}),
      pane: this.describeLeafPane(null, leafEl, []),
      activePane: leafEl.classList?.contains("mod-active") ?? false,
    };
  }

  private findCodeMirrorInContainer(container: Element): CodeMirrorViewLike | null {
    const candidates: Element[] = [container];
    for (const sel of [".cm-editor", ".cm-content", ".cm-scroller"]) {
      const found = container.querySelector?.(sel);
      if (found) {
        candidates.push(found);
      }
    }
    for (const el of candidates) {
      const rec = el as unknown as {
        cmView?: { view?: unknown; rootView?: { view?: unknown } };
        cmTile?: { root?: { view?: unknown } };
        editorView?: unknown;
        cm?: unknown;
      };
      for (const raw of [
        rec.cmView?.rootView?.view,
        rec.cmView?.view,
        rec.cmTile?.root?.view,
        rec.editorView,
        rec.cm,
      ]) {
        if (raw && typeof raw === "object") {
          const view = raw as CodeMirrorViewLike;
          if (view.state?.doc || typeof view.coordsAtPos === "function") {
            return view;
          }
        }
      }
    }
    return null;
  }

  private findOpenNoteLeaf(notePath: string, preferredContainer?: Element | null): NoteLeafContext | null {
    const wanted = notePath.trim();
    if (this.resolveNoteLeaf) {
      return this.resolveNoteLeaf(wanted);
    }

    const leaves = this.collectWorkspaceLeaves();
    const matches: NoteLeafContext[] = [];
    for (const leaf of leaves) {
      if (leaf.view?.file?.path !== wanted) {
        continue;
      }
      const containerEl = this.leafContainer(leaf);
      if (!containerEl || !this.isVisible(containerEl)) {
        continue;
      }
      const rawCm = leaf.view?.editor?.cm;
      const cm =
        (rawCm && typeof rawCm === "object" && ((rawCm as CodeMirrorViewLike).state?.doc || typeof (rawCm as CodeMirrorViewLike).coordsAtPos === "function")
          ? (rawCm as CodeMirrorViewLike)
          : null) ?? this.findCodeMirrorInContainer(containerEl);
      const contentText =
        cm?.state?.doc?.toString() ??
        (typeof leaf.view?.getViewData === "function" ? leaf.view.getViewData() : undefined) ??
        (typeof leaf.view?.data === "string" ? leaf.view.data : undefined);
      matches.push({
        path: wanted,
        pane: this.describeLeafPane(leaf, containerEl, leaves),
        activePane: this.isLeafActive(leaf, containerEl),
        containerEl,
        cm,
        contentText,
        view: leaf.view ?? null,
        workspaceLeaf: leaf,
      });
    }

    if (matches.length > 0) {
      const byContainer =
        preferredContainer
          ? matches.find(
              (m) => m.containerEl === preferredContainer || m.containerEl.contains?.(preferredContainer)
            )
          : undefined;
      return byContainer ?? matches.find((m) => m.activePane) ?? matches[0];
    }

    for (const leafEl of this.queryAll(".workspace-leaf")) {
      if (!this.isVisible(leafEl)) {
        continue;
      }
      const ctx = this.resolveElementLeafContext(leafEl);
      if (ctx?.notePath === wanted) {
        const cm = this.findCodeMirrorInContainer(leafEl);
        return {
          path: wanted,
          pane: ctx.pane ?? "active",
          activePane: Boolean(ctx.activePane),
          containerEl: leafEl,
          cm,
          contentText: cm?.state?.doc?.toString(),
        };
      }
    }

    return null;
  }

  private scrollBounds(
    cm?: CodeMirrorViewLike | null,
    options: { excludeStatusBar?: boolean } = {}
  ): {
    top: number;
    bottom: number;
    left: number;
    right: number;
  } {
    const winW = this.win.innerWidth || 800;
    const winH = this.win.innerHeight || 600;
    const sr = cm?.scrollDOM?.getBoundingClientRect?.();
    let top = 0;
    let bottom = winH;
    let left = 0;
    let right = winW;
    if (sr && sr.width > 0 && sr.height > 0) {
      const clientH = cm?.scrollDOM?.clientHeight;
      const scrollerBottom =
        typeof clientH === "number" && clientH > 0 ? Math.min(sr.bottom, sr.top + clientH) : sr.bottom;
      top = Math.max(0, sr.top);
      bottom = Math.min(winH, scrollerBottom);
      left = Math.max(0, sr.left);
      right = Math.min(winW, sr.right);
    }
    if (!options.excludeStatusBar) {
      const statusBar = this.win.document.querySelector?.(".status-bar") ?? null;
      if (statusBar && this.isVisible(statusBar)) {
        const sb = statusBar.getBoundingClientRect();
        if (
          sb.height > 0 &&
          sb.height < 100 &&
          sb.top > top + 40 &&
          sb.top < bottom &&
          sb.bottom >= bottom - 2 &&
          sb.right > left &&
          sb.left < right
        ) {
          bottom = Math.min(bottom, sb.top);
        }
      }
    }
    return { top, bottom, left, right };
  }

  /** Keep roughly 3 lines of breathing room above the editor footer/status bar and top edge. */
  private scrollMarginPx(viewportHeight: number, lineHeight: number): number {
    const line = Math.max(16, Math.min(44, Math.round(lineHeight)));
    const desired = line * CARET_SCROLL_MARGIN_LINES;
    const maxSafe = Math.max(4, Math.floor(Math.max(0, viewportHeight - line) / 3));
    return Math.min(desired, maxSafe);
  }

  private scrollContainerBy(
    scroller: { scrollTop?: number } | null | undefined,
    deltaY: number
  ): boolean {
    if (
      !scroller ||
      typeof scroller.scrollTop !== "number" ||
      !Number.isFinite(deltaY) ||
      Math.abs(deltaY) < 1
    ) {
      return false;
    }
    const before = scroller.scrollTop;
    scroller.scrollTop = Math.max(0, before + Math.round(deltaY));
    return scroller.scrollTop !== before;
  }

  private findScrollableAncestor(start: Node | null | undefined): HTMLElement | null {
    let cur: Node | null | undefined = start;
    while (cur) {
      const el = cur as Partial<HTMLElement> & { parentElement?: Element | null };
      if (
        typeof el.scrollTop === "number" &&
        typeof el.scrollHeight === "number" &&
        typeof el.clientHeight === "number" &&
        el.scrollHeight > el.clientHeight + 1
      ) {
        return el as HTMLElement;
      }
      cur = el.parentElement ?? null;
    }
    return null;
  }

  /** Return signed pixel delta needed to pull rect inside the 3-line scroll margin, or 0 if clear. */
  private caretMarginOffset(
    rect: CaretCoords,
    bounds: { top: number; bottom: number }
  ): number {
    const lineHeight = (rect.bottom ?? rect.top + DEFAULT_LINE_HEIGHT_PX) - rect.top;
    const margin = this.scrollMarginPx(bounds.bottom - bounds.top, lineHeight);
    const rectBottom = rect.bottom ?? rect.top + lineHeight;
    if (rect.top < bounds.top + margin) {
      return rect.top - (bounds.top + margin);
    }
    if (rectBottom > bounds.bottom - margin) {
      return rectBottom - (bounds.bottom - margin);
    }
    return 0;
  }

  private async ensureCaretInView(
    preferredCm?: CodeMirrorViewLike | null,
    explicitPos?: number
  ): Promise<boolean> {
    const activeEl = this.win.document.activeElement ?? null;
    const view = preferredCm ?? this.findFocusedCodeMirrorView(activeEl);
    if (view) {
      const hasExplicitPos = typeof explicitPos === "number" && Number.isFinite(explicitPos);
      const head = hasExplicitPos ? explicitPos : view.state?.selection?.main?.head;
      if (typeof head !== "number") {
        return false;
      }
      const readCaretRect = (): CaretCoords | null =>
        typeof view.coordsAtPos === "function"
          ? (view.coordsAtPos(head) ?? view.coordsAtPos(head, -1))
          : null;

      let bounds = this.scrollBounds(view);
      let rect = readCaretRect();
      const rectBottom = rect?.bottom ?? (rect ? rect.top + DEFAULT_LINE_HEIGHT_PX : 0);
      let didScroll = false;

      // Bring completely offscreen or unmeasured carets into view via CM6 first so
      // virtualized lines render, then enforce the 3-line scroll margin on scrollDOM.
      if (!hasNonZeroBox(rect) || rect.top < bounds.top + 4 || rectBottom > bounds.bottom - 4) {
        if (typeof view.dispatch === "function") {
          if (hasExplicitPos) {
            this.dispatchScrollToPos(view, head, false);
          } else {
            view.dispatch({ scrollIntoView: true });
          }
          await this.waitForPaint();
          didScroll = true;
          bounds = this.scrollBounds(view);
          rect = readCaretRect();
        }
      }

      const targetOffset = hasNonZeroBox(rect) ? this.caretMarginOffset(rect, bounds) : 0;
      if (targetOffset !== 0) {
        if (this.scrollContainerBy(view.scrollDOM, targetOffset)) {
          await this.waitForPaint();
          didScroll = true;
        } else if (!didScroll && typeof view.dispatch === "function") {
          if (hasExplicitPos) {
            this.dispatchScrollToPos(view, head, false);
          } else {
            view.dispatch({ scrollIntoView: true });
          }
          await this.waitForPaint();
          didScroll = true;
        }
      }
      return didScroll;
    }

    const sel = this.win.getSelection?.();
    if (sel && sel.rangeCount > 0) {
      try {
        const range = sel.getRangeAt(0);
        const r = range.getBoundingClientRect?.();
        const bounds = this.scrollBounds(null);
        const delta = hasNonZeroBox(r) ? this.caretMarginOffset(r, bounds) : 0;
        if (delta !== 0) {
          const scroller = this.findScrollableAncestor(range.startContainer);
          if (this.scrollContainerBy(scroller, delta)) {
            await this.waitForPaint();
            return true;
          }
          const container = range.startContainer as Node & {
            scrollIntoView?: (opts?: ScrollIntoViewOptions) => void;
            parentElement?: Element | null;
          };
          if (typeof container.scrollIntoView === "function") {
            container.scrollIntoView({ block: "nearest" });
          } else {
            container.parentElement?.scrollIntoView?.({ block: "nearest" });
          }
          await this.waitForPaint();
          return true;
        }
      } catch {
        // Ignore selection ranges that cannot be scrolled.
      }
    }
    return false;
  }

  private linePointFromDom(
    lineEl: Element,
    at: "start" | "end"
  ): { x: number; y: number } | null {
    const lineRect = lineEl.getBoundingClientRect?.();
    if (!hasNonZeroBox(lineRect)) {
      return null;
    }

    const doc = this.win.document;
    if (typeof doc.createRange === "function") {
      const textNodes: Text[] = [];
      const walk = (node: Node): void => {
        if (node.nodeType === 3) {
          if ((node.textContent ?? "").length > 0) {
            textNodes.push(node as Text);
          }
          return;
        }
        const children = node.childNodes;
        if (children) {
          for (let i = 0; i < children.length; i += 1) {
            walk(children[i]);
          }
        }
      };
      walk(lineEl);

      const targetNode = at === "start" ? textNodes[0] : textNodes[textNodes.length - 1];
      if (targetNode) {
        const len = targetNode.textContent?.length ?? 0;
        const range = doc.createRange();
        try {
          if (at === "start") {
            range.setStart(targetNode, 0);
            range.setEnd(targetNode, Math.min(1, len));
            const r = range.getClientRects?.()?.[0] ?? range.getBoundingClientRect?.();
            if (hasNonZeroBox(r)) {
              return { x: Math.round(r.left), y: rectMidY(r) };
            }
          } else {
            range.setStart(targetNode, Math.max(0, len - 1));
            range.setEnd(targetNode, len);
            const rects = range.getClientRects?.();
            const last =
              rects && rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect?.();
            if (hasNonZeroBox(last)) {
              const x = typeof last.right === "number" ? last.right : last.left;
              return { x: Math.round(x), y: rectMidY(last) };
            }
          }
        } catch {
          // Fall back to line element box below.
        }
      }
    }

    if (at === "start") {
      return { x: Math.round(lineRect.left + 2), y: rectMidY(lineRect) };
    }
    const text = (lineEl.textContent ?? "").trim();
    const x = text ? lineRect.right - 2 : lineRect.left + 2;
    return { x: Math.round(x), y: rectMidY(lineRect) };
  }

  private findDomLineElement(
    containerEl: Element,
    lineNumber: number,
    lineText: string,
    totalLines: number
  ): Element | null {
    const lineEls = Array.from(containerEl.querySelectorAll?.(".cm-line") ?? []);
    if (lineEls.length === 0) {
      return null;
    }
    if (lineEls.length === totalLines && lineNumber >= 1 && lineNumber <= lineEls.length) {
      return lineEls[lineNumber - 1];
    }
    const exact = lineEls.find((el) => (el.textContent ?? "") === lineText);
    if (exact) {
      return exact;
    }
    const normalizedTarget = lineText
      .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+(?:\[[ xX]\]\s+)?|>\s+)/, "")
      .trim();
    if (normalizedTarget) {
      return lineEls.find((el) => (el.textContent ?? "").trim() === normalizedTarget) ?? null;
    }
    return null;
  }

  private buildLines(
    cm: CodeMirrorViewLike | null,
    leaf: NoteLeafContext
  ): Array<{ number: number; text: string; from: number; to: number }> {
    const doc = cm?.state?.doc;
    if (doc) {
      const lines: Array<{ number: number; text: string; from: number; to: number }> = [];
      for (let i = 1; i <= doc.lines; i += 1) {
        const line = doc.line(i);
        lines.push({ number: line.number, text: line.text, from: line.from, to: line.to });
      }
      return lines;
    }
    const rawLines =
      typeof leaf.contentText === "string"
        ? leaf.contentText.split("\n")
        : Array.from(leaf.containerEl.querySelectorAll?.(".cm-line") ?? []).map(
            (el) => el.textContent ?? ""
          );
    const out: Array<{ number: number; text: string; from: number; to: number }> = [];
    let offset = 0;
    for (let i = 0; i < rawLines.length; i += 1) {
      const text = rawLines[i];
      const from = offset;
      const to = offset + text.length;
      out.push({ number: i + 1, text, from, to });
      offset = to + 1;
    }
    return out;
  }

  private findAnchorLine(
    notePath: string,
    lines: Array<{ number: number; text: string; from: number; to: number }>,
    spec: { line?: number; after?: string; heading?: string; text?: string }
  ): { number: number; text: string; from: number; to: number } {
    if (lines.length === 0) {
      throw new UiControlError("ui_target_not_found", `Note '${notePath}' has no lines.`);
    }

    if (spec.line !== undefined) {
      if (!Number.isInteger(spec.line) || spec.line < 1) {
        throw new UiControlError("invalid_params", "Anchor 'line' must be a positive integer.");
      }
      if (spec.line > lines.length) {
        throw new UiControlError(
          "ui_target_not_found",
          `Line ${spec.line} is out of range (1..${lines.length}) for '${notePath}'.`
        );
      }
      const line = lines[spec.line - 1];
      if (spec.text && !line.text.includes(spec.text)) {
        throw new UiControlError(
          "ui_target_not_found",
          `Line ${spec.line} in '${notePath}' does not contain ${JSON.stringify(spec.text)}.`
        );
      }
      return line;
    }

    if (spec.heading !== undefined) {
      const wanted = spec.heading.trim().replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").trim();
      const wantedLower = wanted.toLowerCase();
      let exactIdx = -1;
      let ciIdx = -1;
      let headingLevel = 0;
      let fence: OpenFence | null = null;

      for (let i = 0; i < lines.length; i += 1) {
        const wasInFence = fence !== null;
        fence = nextFenceState(lines[i].text, fence);
        if (wasInFence || fence !== null) {
          continue;
        }
        const m = /^\s*(#{1,6})\s+(.+?)\s*$/.exec(lines[i].text);
        if (!m) {
          continue;
        }
        const title = m[2].replace(/\s+#+\s*$/, "").trim();
        if (title === wanted) {
          exactIdx = i;
          headingLevel = m[1].length;
          break;
        }
        if (ciIdx === -1 && title.toLowerCase() === wantedLower) {
          ciIdx = i;
          headingLevel = m[1].length;
        }
      }

      const hIdx = exactIdx !== -1 ? exactIdx : ciIdx;
      if (hIdx === -1) {
        throw new UiControlError(
          "ui_target_not_found",
          `Heading '${spec.heading}' not found in '${notePath}'.`
        );
      }

      let lastNonEmpty = hIdx;
      let sectionFence: OpenFence | null = null;
      for (let i = hIdx + 1; i < lines.length; i += 1) {
        const wasInFence = sectionFence !== null;
        sectionFence = nextFenceState(lines[i].text, sectionFence);
        if (!wasInFence && sectionFence === null) {
          const nextHeading = /^\s*(#{1,6})\s+/.exec(lines[i].text);
          if (nextHeading && nextHeading[1].length <= headingLevel) {
            break;
          }
        }
        if (lines[i].text.trim().length > 0) {
          lastNonEmpty = i;
        }
      }
      return lines[lastNonEmpty];
    }

    if (spec.after !== undefined) {
      const wanted = spec.after.trim();
      if (!wanted) {
        throw new UiControlError("invalid_params", "Anchor 'after' must be non-empty.");
      }
      const matches = lines.filter((line) => line.text.trim() === wanted);
      if (matches.length === 0) {
        throw new UiControlError(
          "ui_target_not_found",
          `No exact line matching ${JSON.stringify(wanted)} found in '${notePath}'.`
        );
      }
      if (matches.length > 1) {
        throw new UiControlError(
          "ui_target_ambiguous",
          `Anchor 'after' ${JSON.stringify(wanted)} matched ${matches.length} lines in '${notePath}'.`
        );
      }
      return matches[0];
    }

    if (spec.text !== undefined) {
      const matched = lines.find((line) => line.text.includes(spec.text as string));
      if (!matched) {
        throw new UiControlError(
          "ui_target_not_found",
          `Could not find ${JSON.stringify(spec.text)} in '${notePath}'.`
        );
      }
      return matched;
    }

    throw new UiControlError(
      "invalid_params",
      "Anchor target requires 'line', 'after', 'heading', or 'text'."
    );
  }

  private dispatchScrollToPos(
    cm: CodeMirrorViewLike,
    pos: number,
    moveSelection: boolean
  ): void {
    if (typeof cm.dispatch !== "function") {
      return;
    }
    if (moveSelection) {
      cm.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      return;
    }
    // Observation calls must never alter a writer's active caret selection while scrolling.
    cm.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  }

  private async resolveAnchorTarget(
    raw: unknown,
    focusLeaf: boolean,
    options: { allowScroll?: boolean } = {}
  ): Promise<{
    leaf: NoteLeafContext;
    cm: CodeMirrorViewLike | null;
    lineNumber: number;
    lineText: string;
    from: number;
    to: number;
    at: "start" | "end";
    pos: number;
    point: { x: number; y: number };
    rect: { x: number; y: number; width: number; height: number };
    selector: string;
    scrolled: boolean;
  }> {
    if (!raw || typeof raw !== "object") {
      throw new UiControlError("invalid_params", "Anchor target must be an object.");
    }
    const obj = raw as Record<string, unknown>;
    const rawNote =
      typeof obj.note === "string"
        ? obj.note.trim()
        : typeof obj.path === "string"
          ? obj.path.trim()
          : "";
    if (!rawNote) {
      throw new UiControlError("invalid_params", "Anchor target requires non-empty 'note' (or 'path').");
    }

    const atRaw = obj.at;
    let at: "start" | "end" = "end";
    if (atRaw !== undefined) {
      if (atRaw !== "start" && atRaw !== "end") {
        throw new UiControlError("invalid_params", "Anchor 'at' must be 'start' or 'end'.");
      }
      at = atRaw;
    }

    const lineParam = obj.line !== undefined ? num(obj.line, Number.NaN) : undefined;
    const afterParam = typeof obj.after === "string" && obj.after ? obj.after : undefined;
    const headingParam = typeof obj.heading === "string" && obj.heading ? obj.heading : undefined;
    const textParam = typeof obj.text === "string" && obj.text ? obj.text : undefined;
    if (
      lineParam === undefined &&
      afterParam === undefined &&
      headingParam === undefined &&
      textParam === undefined
    ) {
      throw new UiControlError(
        "invalid_params",
        "Anchor target requires 'line', 'after', 'heading', or 'text'."
      );
    }

    const leaf = this.findOpenNoteLeaf(rawNote);
    if (!leaf) {
      throw new UiControlError(
        "ui_target_not_found",
        `Note '${rawNote}' is not open in any visible Obsidian pane.`
      );
    }

    const cm = leaf.cm ?? null;
    if (focusLeaf && !leaf.activePane) {
      if (typeof cm?.focus === "function") {
        cm.focus();
      } else {
        const cmContent = leaf.containerEl.querySelector?.<HTMLElement>(".cm-content") ?? null;
        cmContent?.focus?.();
      }
    }

    const lines = this.buildLines(cm, leaf);
    const targetLine = this.findAnchorLine(rawNote, lines, {
      line: lineParam,
      after: afterParam,
      heading: headingParam,
      text: textParam,
    });
    const pos = at === "start" ? targetLine.from : targetLine.to;

    const measure = (): {
      point: { x: number; y: number };
      rect: { x: number; y: number; width: number; height: number };
      selector: string;
    } | null => {
      const lineEl = this.findDomLineElement(
        leaf.containerEl,
        targetLine.number,
        targetLine.text,
        lines.length
      );
      const selector = lineEl ? this.selectorPath(lineEl) : `${this.selectorPath(leaf.containerEl)} .cm-line`;
      const elRect = lineEl?.getBoundingClientRect?.();

      const coords = cm?.coordsAtPos?.(pos) ?? cm?.coordsAtPos?.(pos, -1) ?? null;
      if (hasNonZeroBox(coords)) {
        const point = { x: Math.round(coords.left), y: rectMidY(coords) };
        const rect = hasNonZeroBox(elRect)
          ? { x: elRect.x, y: elRect.y, width: elRect.width, height: elRect.height }
          : {
              x: coords.left,
              y: coords.top,
              width: Math.max(1, (coords.right ?? coords.left + 2) - coords.left),
              height: Math.max(1, (coords.bottom ?? coords.top + 18) - coords.top),
            };
        return { point, rect, selector };
      }

      if (lineEl && hasNonZeroBox(elRect)) {
        const pt = this.linePointFromDom(lineEl, at);
        if (pt) {
          return {
            point: pt,
            rect: { x: elRect.x, y: elRect.y, width: elRect.width, height: elRect.height },
            selector,
          };
        }
      }
      return null;
    };

    let bounds = this.scrollBounds(cm);
    const isInBounds = (
      pt: { x: number; y: number },
      b: { top: number; bottom: number; left: number; right: number } = bounds
    ): boolean =>
      pt.y >= b.top + 4 &&
      pt.y <= b.bottom - 4 &&
      pt.x >= b.left &&
      pt.x < b.right;

    let measured = measure();
    let scrolled = false;
    const allowScroll = options.allowScroll !== false;

    if (!measured || !isInBounds(measured.point, bounds)) {
      if (!allowScroll) {
        throw new UiControlError(
          "ui_target_outside",
          `Target line ${targetLine.number} in '${rawNote}' is outside the current viewport.`
        );
      }
      scrolled = true;
      if (cm && typeof cm.dispatch === "function" && cm.state?.doc) {
        this.dispatchScrollToPos(cm, pos, focusLeaf);
        await this.waitForPaint();
        bounds = this.scrollBounds(cm);
        measured = measure();
      }
      if (!measured && cm?.scrollDOM) {
        const scroller = cm.scrollDOM;
        const totalH = scroller.scrollHeight;
        const clientH = scroller.clientHeight;
        if (
          typeof scroller.scrollTop === "number" &&
          typeof totalH === "number" &&
          typeof clientH === "number" &&
          totalH > clientH &&
          lines.length > 0
        ) {
          const approxTop = Math.max(
            0,
            Math.round((totalH * (targetLine.number - 1)) / lines.length - clientH * 0.4)
          );
          if (approxTop !== scroller.scrollTop) {
            scroller.scrollTop = approxTop;
            await this.waitForPaint();
            if (cm) {
              this.dispatchScrollToPos(cm, pos, focusLeaf);
            }
            await this.waitForPaint();
            bounds = this.scrollBounds(cm);
            measured = measure();
          }
        }
      }
      // CM6 scrollIntoView aligns flush with scrollDOM edges, which can still fall inside a
      // status-bar footer or margin; pull the scroller toward the pane center when scrollable.
      if (measured && !isInBounds(measured.point, bounds)) {
        const scroller =
          cm?.scrollDOM ?? this.findScrollableAncestor(cm?.contentDOM ?? cm?.dom ?? leaf.containerEl);
        let adjusted = false;
        if (measured.point.y < bounds.top + 4 || measured.point.y > bounds.bottom - 4) {
          const targetMidY = Math.round((bounds.top + bounds.bottom) / 2);
          const deltaY = Math.round(measured.point.y - targetMidY);
          if (this.scrollContainerBy(scroller, deltaY)) {
            adjusted = true;
          }
        }
        if (
          scroller &&
          typeof (scroller as { scrollLeft?: number }).scrollLeft === "number" &&
          (measured.point.x < bounds.left || measured.point.x >= bounds.right)
        ) {
          const sLeft = scroller as { scrollLeft: number };
          const targetX = Math.round(
            bounds.left + Math.min(80, Math.max(8, (bounds.right - bounds.left) / 4))
          );
          const nextLeft = Math.max(0, sLeft.scrollLeft + Math.round(measured.point.x - targetX));
          if (nextLeft !== sLeft.scrollLeft) {
            sLeft.scrollLeft = nextLeft;
            adjusted = true;
          }
        }
        if (adjusted) {
          await this.waitForPaint();
          bounds = this.scrollBounds(cm);
          measured = measure();
        }
      }
      if (!measured || !isInBounds(measured.point, bounds)) {
        const lineEl = this.findDomLineElement(
          leaf.containerEl,
          targetLine.number,
          targetLine.text,
          lines.length
        );
        if (lineEl && typeof lineEl.scrollIntoView === "function") {
          lineEl.scrollIntoView({ block: "center" });
          await this.waitForPaint();
          bounds = this.scrollBounds(cm);
          measured = measure();
        }
      }
    }

    if (!measured) {
      throw new UiControlError(
        "ui_target_outside",
        `Could not resolve screen coordinates for line ${targetLine.number} in '${rawNote}'.`
      );
    }

    const visiblePaneBounds = allowScroll
      ? this.scrollBounds(cm, { excludeStatusBar: true })
      : bounds;
    if (
      !Number.isFinite(measured.point.x) ||
      !Number.isFinite(measured.point.y) ||
      measured.point.x < 0 ||
      measured.point.y < 0 ||
      measured.point.x >= this.win.innerWidth ||
      measured.point.y >= this.win.innerHeight ||
      measured.point.y < visiblePaneBounds.top ||
      measured.point.y >= visiblePaneBounds.bottom ||
      measured.point.x < visiblePaneBounds.left ||
      measured.point.x >= visiblePaneBounds.right
    ) {
      throw new UiControlError(
        "ui_target_outside",
        `Target line ${targetLine.number} in '${rawNote}' is outside the Obsidian viewport.`
      );
    }

    return {
      leaf,
      cm,
      lineNumber: targetLine.number,
      lineText: targetLine.text,
      from: targetLine.from,
      to: targetLine.to,
      at,
      pos,
      point: measured.point,
      rect: measured.rect,
      selector: measured.selector,
      scrolled,
    };
  }

  private isAnchorTargetObject(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") {
      return false;
    }
    const obj = raw as Record<string, unknown>;
    return (
      typeof obj.selector !== "string" &&
      obj.x === undefined &&
      obj.y === undefined &&
      (typeof obj.note === "string" || typeof obj.path === "string")
    );
  }

  private async resolveTargetAsync(
    raw: unknown,
    options: { allowScroll?: boolean; focusLeaf?: boolean } = {}
  ): Promise<ResolvedUiTarget> {
    if (this.isAnchorTargetObject(raw)) {
      const anchor = await this.resolveAnchorTarget(raw, options.focusLeaf ?? true, {
        allowScroll: options.allowScroll,
      });
      return {
        point: anchor.point,
        notePath: anchor.leaf.path,
        paneId: anchor.leaf.pane,
        containerEl: anchor.leaf.containerEl,
        cm: anchor.cm,
        view: anchor.leaf.view ?? null,
        workspaceLeaf: anchor.leaf.workspaceLeaf ?? null,
        pos: anchor.pos,
        scrolled: anchor.scrolled,
      };
    }
    const point = this.resolveTarget(raw);
    return {
      point: { x: point.x, y: point.y },
      element: point.element,
      isSelector: point.isSelector,
    };
  }

  private async withMutationHook<T>(
    action: UiMutationAction,
    notePath: string | null,
    paneId: string | null,
    caller: string,
    task: () => Promise<T>,
    extra?: { targetView?: unknown; targetCm?: CodeMirrorViewLike | null }
  ): Promise<T> {
    let complete: MutationCompleteCallback | void = undefined;
    if (this.beforeMutation) {
      complete = await this.beforeMutation({
        action,
        notePath,
        paneId,
        caller,
        ...(extra?.targetView !== undefined ? { targetView: extra.targetView } : {}),
        ...(extra?.targetCm !== undefined ? { targetCm: extra.targetCm } : {}),
      });
    }
    const prevRun = this.activeMutationRun;
    const run: ActiveMutationRun = {
      edits: [],
      insertedChars: 0,
      abortedAfterNoteSwitch: false,
    };
    this.activeMutationRun = run;
    let ok = false;
    let errorCode: string | undefined;
    try {
      const result = await task();
      ok = true;
      return result;
    } catch (err) {
      errorCode = err instanceof UiControlError ? err.code : "error";
      throw err;
    } finally {
      this.activeMutationRun = prevRun;
      if (typeof complete === "function") {
        await complete({
          ok,
          ...(errorCode ? { errorCode } : {}),
          ...(run.insertedChars > 0 ? { insertedChars: run.insertedChars } : {}),
          ...(run.edits.length > 0 ? { edits: [...run.edits] } : {}),
          ...(run.abortedAfterNoteSwitch ? { abortedAfterNoteSwitch: true } : {}),
        });
      }
    }
  }

  private findWorkspaceLeafForElement(el: Element | null | undefined): WorkspaceLeafLike | null {
    if (!el) {
      return null;
    }
    const leafEl = this.findClosestElement(el, ".workspace-leaf");
    for (const leaf of this.collectWorkspaceLeaves()) {
      const container = this.leafContainer(leaf);
      if (!container) {
        continue;
      }
      if (
        container === el ||
        container === leafEl ||
        container.contains?.(el) ||
        (leafEl !== null && container === leafEl)
      ) {
        return leaf;
      }
    }
    return null;
  }

  private resolveTargetLeafMeta(resolved: {
    point: { x: number; y: number };
    element?: Element | null;
    notePath?: string;
    paneId?: string;
    containerEl?: Element | null;
    view?: WorkspaceLeafLike["view"] | null;
    workspaceLeaf?: WorkspaceLeafLike | null;
  }): {
    notePath: string | null;
    paneId: string | null;
    containerEl: Element | null;
    leaf: WorkspaceLeafLike | null;
    view: WorkspaceLeafLike["view"] | null;
  } {
    if (resolved.notePath !== undefined) {
      return {
        notePath: resolved.notePath,
        paneId: resolved.paneId ?? null,
        containerEl: resolved.containerEl ?? null,
        leaf: resolved.workspaceLeaf ?? null,
        view: resolved.view ?? null,
      };
    }
    if (resolved.element) {
      const ctx = this.resolveElementLeafContext(resolved.element);
      const leaf = this.findWorkspaceLeafForElement(resolved.element);
      const containerEl =
        (leaf ? this.leafContainer(leaf) : null) ??
        this.findClosestElement(resolved.element, ".workspace-leaf");
      if (ctx || leaf) {
        return {
          notePath: ctx?.notePath ?? leaf?.view?.file?.path ?? null,
          paneId: ctx?.pane ?? null,
          containerEl,
          leaf,
          view: leaf?.view ?? null,
        };
      }
    }
    return { notePath: null, paneId: null, containerEl: null, leaf: null, view: null };
  }

  private resolveFocusedOwnership(): {
    notePath: string | null;
    paneId: string | null;
    containerEl: Element | null;
    leaf: WorkspaceLeafLike | null;
    view: WorkspaceLeafLike["view"] | null;
    cm: CodeMirrorViewLike | null;
  } {
    const activeEl = this.win.document.activeElement ?? null;
    if (activeEl) {
      if (this.findClosestElement(activeEl, MODAL_SELECTOR)) {
        return {
          notePath: null,
          paneId: null,
          containerEl: null,
          leaf: null,
          view: null,
          cm: null,
        };
      }
      const ctx = this.resolveElementLeafContext(activeEl);
      const leaf = this.findWorkspaceLeafForElement(activeEl);
      const containerEl =
        (leaf ? this.leafContainer(leaf) : null) ??
        this.findClosestElement(activeEl, ".workspace-leaf");
      const cm =
        this.extractCodeMirrorView(leaf?.view?.editor?.cm) ??
        this.findFocusedCodeMirrorView(activeEl) ??
        (containerEl ? this.findCodeMirrorInContainer(containerEl) : null);
      if (ctx && (ctx.notePath || ctx.pane)) {
        return {
          notePath: ctx.notePath ?? null,
          paneId: ctx.pane ?? null,
          containerEl,
          leaf,
          view: leaf?.view ?? null,
          cm,
        };
      }
      if (isInputOrTextarea(activeEl)) {
        return {
          notePath: null,
          paneId: null,
          containerEl: null,
          leaf: null,
          view: null,
          cm: null,
        };
      }
    }
    const ws = this.workspaceLike();
    const activeLeaf = ws?.activeLeaf ?? null;
    if (activeLeaf) {
      const container = this.leafContainer(activeLeaf);
      return {
        notePath: activeLeaf.view?.file?.path ?? null,
        paneId: this.describeLeafPane(activeLeaf, container, this.collectWorkspaceLeaves()),
        containerEl: container,
        leaf: activeLeaf,
        view: activeLeaf.view ?? null,
        cm:
          this.extractCodeMirrorView(activeLeaf.view?.editor?.cm) ??
          (container ? this.findCodeMirrorInContainer(container) : null),
      };
    }
    return { notePath: null, paneId: null, containerEl: null, leaf: null, view: null, cm: null };
  }

  private resolveFocusedLeafContext(): { notePath: string | null; paneId: string | null } {
    const owned = this.resolveFocusedOwnership();
    return { notePath: owned.notePath, paneId: owned.paneId };
  }

  /** Resolves a selector or CSS-pixel point, requiring one visible, enabled, uncovered element. */
  private resolveTarget(
    raw: unknown
  ): { x: number; y: number; element?: Element | null; isSelector?: boolean } {
    if (!raw || typeof raw !== "object") {
      throw new UiControlError(
        "invalid_params",
        "Target must be {selector}, {x, y}, or {note, line|after|heading}."
      );
    }
    const target = raw as Record<string, unknown>;
    let x: number;
    let y: number;
    let element: Element | null = null;
    let isSelector = false;
    if (typeof target.selector === "string" && target.selector.trim()) {
      isSelector = true;
      const matches = this.queryAll(target.selector).filter((el) => this.isVisible(el));
      if (matches.length !== 1) {
        throw new UiControlError(
          "ui_target_ambiguous",
          `Selector must match exactly one visible element; matched ${matches.length}.`
        );
      }
      const el = matches[0];
      if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") {
        throw new UiControlError("ui_target_disabled", "Target is disabled.");
      }
      const r = el.getBoundingClientRect();
      x = (Math.max(0, r.left) + Math.min(this.win.innerWidth, r.right)) / 2;
      y = (Math.max(0, r.top) + Math.min(this.win.innerHeight, r.bottom)) / 2;
      const hit = this.win.document.elementFromPoint(x, y);
      if (!hit || !(hit === el || el.contains(hit))) {
        throw new UiControlError("ui_target_covered", "Target is covered by another element.");
      }
      element = el;
    } else {
      x = num(target.x, Number.NaN);
      y = num(target.y, Number.NaN);
    }
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x >= this.win.innerWidth ||
      y >= this.win.innerHeight
    ) {
      throw new UiControlError("ui_target_outside", "Coordinates are outside the Obsidian viewport.");
    }
    if (!element) {
      try {
        element = this.win.document.elementFromPoint?.(x, y) ?? null;
      } catch {
        element = null;
      }
    }
    return { x, y, element, isSelector };
  }
}

interface WorkspaceLeafLike {
  id?: string;
  containerEl?: Element;
  getRoot?: () => unknown;
  view?: {
    containerEl?: Element;
    getViewType?: () => string;
    getViewData?: () => string;
    data?: string;
    file?: { path?: string } | null;
    editor?: { cm?: unknown };
  };
}
