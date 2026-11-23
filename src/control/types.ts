// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Daniel Agrici. Shared structural types and pure DOM/geometry helpers for UI control.

import type { AgentCursorOverlay } from "./agent-cursor";

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
export type UiTargetInput = UiTarget;

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
    selection?: { main?: { head?: number; anchor?: number; from?: number; to?: number } };
  };
  coordsAtPos?(pos: number, side?: number): CaretCoords | null;
  posAtCoords?(coords: { x: number; y: number }): number | null;
  dispatch?(spec: unknown): void;
  focus?(): void;
}

export type TerminalInputDeliverer = (
  element: Element,
  data: string
) => boolean | void | Promise<boolean | void>;

export interface ElementLeafContext {
  notePath?: string;
  pane?: string;
  activePane?: boolean;
}

export interface WorkspaceLeafLike {
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

export type OpenNoteLeafInfo = NoteLeafContext;

export interface InspectedElement {
  selector: string;
  tag: string;
  role: string | null;
  label: string;
  text: string;
  value?: string;
  disabled: boolean;
  protected?: boolean;
  rect: { x: number; y: number; width: number; height: number };
  notePath?: string;
  pane?: string;
  activePane?: boolean;
}

export type InspectElementInfo = InspectedElement;

export interface FocusState {
  tag: string | null;
  label: string;
  editable: boolean;
  password: boolean;
}

export type UiMutationAction = "click" | "select" | "type" | "press_key" | "insert_line" | "drag";

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
  targetElement?: Element | null;
  targetFilePath?: string;
  expectedFileOperation?: { kind: "trash"; path: string };
}

export type UiMutationHookContext = UiMutationContext;

export type MutationCompleteCallback = (
  completion?: UiMutationCompletion
) => void | Promise<void>;

export type BeforeMutationHook = (
  context: UiMutationContext
) => void | MutationCompleteCallback | Promise<void | MutationCompleteCallback>;

export type UiMutationHook = BeforeMutationHook;

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

export interface ResolvedUiTarget {
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

export interface FocusedOwnership {
  notePath: string | null;
  paneId: string | null;
  containerEl: Element | null;
  leaf: WorkspaceLeafLike | null;
  view: WorkspaceLeafLike["view"] | null;
  cm: CodeMirrorViewLike | null;
}

export interface UiControlServiceOptions {
  win: Window;
  getWebContents: () => WebContentsLike | null;
  getCodeMirrorView?: () => CodeMirrorViewLike | null;
  resolveElementContext?: (el: Element) => ElementLeafContext | null;
  resolveNoteLeaf?: (notePath: string) => NoteLeafContext | null;
  beforeMutation?: BeforeMutationHook;
  platform?: string;
  sleep?: (ms: number) => Promise<void>;
  cursorOverlay?: AgentCursorOverlay | null;
  resolveAgentLabel?: (caller: string) => string;
  getUiTypingSpeed?: () => UiTypingSpeed;
  getAllowUiInProtectedAreas?: () => boolean;
  deliverToTerminal?: TerminalInputDeliverer;
  executeCommandById?: (commandId: string) => boolean;
  /**
   * The plugin's own `this.app`. UI control never reads the global
   * `window.app` (Obsidian plugin guidelines); without this option the
   * workspace-aware paths fall back to DOM state only.
   */
  getApp?: () => unknown;
}

export interface AgentCursorOptions {
  win: Window;
  enabled?: boolean;
  idleAfterMs?: number;
  hideAfterMs?: number;
}

export interface CursorCodeMirrorLike {
  dom?: Element | null;
  scrollDOM?: Element | null;
  contentDOM?: Element | null;
  state?: {
    doc?: {
      toString(): string;
      length?: number;
    };
    selection?: {
      main?: {
        head?: number;
      };
    };
  };
  coordsAtPos?(
    pos: number,
    side?: number
  ): { left: number; right?: number; top: number; bottom?: number } | null;
}

export interface DocumentCursorContext {
  notePath?: string;
  pane?: string;
  leafId?: string;
  pos?: number;
  cm?: CursorCodeMirrorLike | null;
  containerEl?: Element | null;
  view?: { file?: { path?: string } | null } | null;
  getLeafNotePath?: () => string | null | undefined;
  isVisible?: () => boolean;
}

export interface NoteDocChange {
  from: number;
  to: number;
  insertLength: number;
}

export interface OpenFence {
  char: "`" | "~";
  length: number;
}

export function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function base64FromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function hasNonZeroBox(
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

export function rectMidY(rect: { top: number; bottom?: number; height?: number }): number {
  if (typeof rect.bottom === "number" && Number.isFinite(rect.bottom)) {
    return Math.round((rect.top + rect.bottom) / 2);
  }
  if (typeof rect.height === "number" && Number.isFinite(rect.height)) {
    return Math.round(rect.top + rect.height / 2);
  }
  return Math.round(rect.top);
}

export function isInputOrTextarea(
  el: Element | null | undefined
): el is HTMLInputElement | HTMLTextAreaElement {
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

export function escapeCssIdent(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

export function findClosestElement(
  el: Element | null | undefined,
  selector: string
): Element | null {
  if (!el || typeof el.closest !== "function") {
    return null;
  }
  try {
    return el.closest(selector);
  } catch {
    return null;
  }
}

export function isElementContentEditable(el: Element | null | undefined): boolean {
  if (!el) {
    return false;
  }
  return Boolean((el as HTMLElement).isContentEditable);
}

export function normalizeText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

export function parseCssPx(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function clampPointToRect(
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

export function nextFenceState(lineText: string, open: OpenFence | null): OpenFence | null {
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

export function splitTypingChunks(text: string, maxTypingChunks = 40): string[] {
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
  if (fine.length <= maxTypingChunks) {
    return fine;
  }
  const groupSize = Math.ceil(fine.length / maxTypingChunks);
  const merged: string[] = [];
  for (let i = 0; i < fine.length; i += groupSize) {
    merged.push(fine.slice(i, i + groupSize).join(""));
  }
  return merged;
}
