// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Daniel Agrici. Visual multi-agent cursor overlay for Obsidian-herdr.

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
  coordsAtPos?(pos: number, side?: number): { left: number; right?: number; top: number; bottom?: number } | null;
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

interface DocumentAnchor {
  notePath?: string;
  pane?: string;
  leafId?: string;
  cm: CursorCodeMirrorLike | null;
  containerEl: Element | null;
  view: { file?: { path?: string } | null } | null;
  getLeafNotePath?: () => string | null | undefined;
  isVisible?: () => boolean;
  pos: number | null;
  docSnapshot: string | null;
}

interface RecentTextAnchor {
  cm: CursorCodeMirrorLike;
  notePath?: string;
  pos: number;
  docSnapshot: string | null;
}

interface CursorGlide {
  startX: number;
  startY: number;
  elapsedMs: number;
  durationMs: number;
}

interface CursorInstance {
  caller: string;
  label: string;
  hue: number;
  el: HTMLElement;
  pillEl: HTMLElement;
  badgeEl: HTMLElement;
  actionEl: HTMLElement;
  ringEl: HTMLElement;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  glide: CursorGlide | null;
  settleWaiters: Array<() => void>;
  initialized: boolean;
  actionTimer: number | null;
  idleTimer: number | null;
  hideTimer: number | null;
  pulseTimer: number | null;
  docAnchor: DocumentAnchor | null;
  paneBounds: PillRect | null;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_IDLE_MS = 1500;
const DEFAULT_HIDE_MS = 60000;
const BRIEF_ACTION_MS = 550;
const TYPING_SAFETY_MS = 650;
const EXIT_FADE_MS = 240;

const SILENT_MOVE_ACTIONS = new Set([
  "hover",
  "move",
  "focus",
  "scroll",
  "drag",
  "drop",
  "note_update",
  "parked",
  "idle",
]);

function normalizeHonestAction(
  source: "move" | "click" | "typing",
  action?: string
): { text: string; isTyping: boolean } {
  if (source === "typing") {
    return { text: "typing", isTyping: true };
  }
  const trimmed = action?.trim() ?? "";
  if (source === "click") {
    if (!trimmed || trimmed === "click" || trimmed === "clicking" || trimmed === "insert_line" || trimmed === "drag") {
      return { text: "clicking", isTyping: false };
    }
    return { text: trimmed, isTyping: false };
  }
  if (!trimmed) {
    return { text: "", isTyping: false };
  }
  if (trimmed === "click" || trimmed === "clicking") {
    return { text: "clicking", isTyping: false };
  }
  if (SILENT_MOVE_ACTIONS.has(trimmed) || trimmed === "typing") {
    return { text: "", isTyping: false };
  }
  return { text: trimmed, isTyping: false };
}

function mapAnchoredPos(oldText: string | null, newText: string | null, pos: number, change?: NoteDocChange): number {
  const newLen = newText?.length ?? null;
  if (change) {
    const delta = change.insertLength - (change.to - change.from);
    let nextPos = pos;
    if (pos >= change.to) {
      nextPos = pos + delta;
    } else if (pos > change.from) {
      nextPos = change.from + Math.min(change.insertLength, pos - change.from);
    }
    if (newLen !== null) {
      return Math.max(0, Math.min(newLen, nextPos));
    }
    return Math.max(0, nextPos);
  }
  if (oldText === null || newText === null || oldText === newText) {
    return newLen !== null ? Math.max(0, Math.min(newLen, pos)) : Math.max(0, pos);
  }

  const oldLen = oldText.length;
  const minLen = Math.min(oldLen, newLen ?? 0);
  let prefix = 0;
  while (prefix < minLen && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
    prefix += 1;
  }

  let suffix = 0;
  const maxSuffix = minLen - prefix;
  while (
    suffix < maxSuffix &&
    oldText.charCodeAt(oldLen - 1 - suffix) === newText.charCodeAt((newLen ?? 0) - 1 - suffix)
  ) {
    suffix += 1;
  }

  const oldTo = oldLen - suffix;
  const newTo = (newLen ?? 0) - suffix;
  let nextPos = pos;
  if (pos >= oldTo) {
    nextPos = pos + (newTo - oldTo);
  } else if (pos > prefix) {
    nextPos = prefix + Math.min(newTo - prefix, pos - prefix);
  }
  return Math.max(0, Math.min(newLen ?? nextPos, nextPos));
}
const MAX_GLIDE_MS = 180;
const MIN_GLIDE_MS = 45;
const DEFAULT_SETTLE_WAIT_MS = 250;
const MAX_SETTLE_WAIT_MS = 500;
const SETTLE_EPSILON = 0.35;
const CLICK_POS_TOLERANCE_X = 24;
const CLICK_POS_TOLERANCE_Y = 24;
const HUE_BUCKETS = 12;
const PILL_DEFAULT_X = 10;
const PILL_DEFAULT_Y = 5;
const PILL_ROW_STEP = 20;

function hasDocumentAnchorTarget(docContext: DocumentCursorContext): boolean {
  return Boolean(
    docContext.cm ||
      (typeof docContext.notePath === "string" && docContext.notePath.trim() !== "") ||
      (typeof docContext.pos === "number" && Number.isFinite(docContext.pos)) ||
      (typeof docContext.view?.file?.path === "string" && docContext.view.file.path.trim() !== "") ||
      docContext.getLeafNotePath
  );
}

function formatCssPx(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${Object.is(rounded, -0) ? 0 : rounded}px`;
}

/** Returns the text caret anchor at the left edge and vertical midpoint of the line box. */
export function caretPointFromCoords(
  coords: { left: number; top: number; bottom?: number }
): { x: number; y: number } {
  const midY =
    typeof coords.bottom === "number" && Number.isFinite(coords.bottom)
      ? (coords.top + coords.bottom) / 2
      : coords.top;
  return {
    x: coords.left,
    y: midY,
  };
}
const PILL_PAD = 4;

interface PillRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function hashCallerBucket(caller: string): number {
  let hash = 2166136261;
  for (let i = 0; i < caller.length; i += 1) {
    hash ^= caller.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % HUE_BUCKETS;
}

function rectsOverlap(a: PillRect, b: PillRect, pad = PILL_PAD): boolean {
  return (
    a.left < b.right + pad &&
    a.right + pad > b.left &&
    a.top < b.bottom + pad &&
    a.bottom + pad > b.top
  );
}

const HERDR_PANE_ID_RE = /^(?:w\d+:p[0-9a-zA-Z]+|p\d+|pane[-_][0-9a-zA-Z_-]+|markdown-pane-\d+)$/i;

function isHerdrPaneId(value: string): boolean {
  const trimmed = value.trim();
  const bare = trimmed.startsWith("herdr:") ? trimmed.slice(6).trim() : trimmed;
  return bare !== "" && HERDR_PANE_ID_RE.test(bare);
}

/**
 * Formats the visible cursor badge to show only the known agent name and
 * fall back to the pane id when no agent name is available.
 */
export function formatCursorDisplayLabel(caller: string, label: string): string {
  const trimmedCaller = caller.trim();
  const bareCaller = trimmedCaller.startsWith("herdr:")
    ? trimmedCaller.slice(6).trim()
    : trimmedCaller;
  const hashIdx = bareCaller.indexOf("#");
  const callerPane = (hashIdx >= 0 ? bareCaller.slice(0, hashIdx) : bareCaller).trim();
  const callerHint = (hashIdx >= 0 ? bareCaller.slice(hashIdx + 1) : "").trim();

  const isPaneLikeId = (value: string): boolean => {
    const clean = (value.startsWith("herdr:") ? value.slice(6) : value).trim();
    if (!clean) {
      return false;
    }
    if (callerPane && clean === callerPane) {
      return true;
    }
    return isHerdrPaneId(clean);
  };

  const raw = label.trim();
  if (!raw) {
    return callerHint || callerPane || bareCaller || trimmedCaller;
  }

  const tailParenMatch = /^(.+?)\s+\(([^()]+)\)$/.exec(raw);
  if (tailParenMatch && isPaneLikeId(tailParenMatch[2])) {
    const head = tailParenMatch[1].trim();
    if (head) {
      return head;
    }
  }

  if (raw === trimmedCaller || raw === bareCaller || raw === callerPane) {
    return callerHint || callerPane || bareCaller || raw;
  }

  if (raw.startsWith("herdr:")) {
    const withoutPrefix = raw.slice(6).trim();
    const rawHash = withoutPrefix.indexOf("#");
    if (rawHash >= 0) {
      const hint = withoutPrefix.slice(rawHash + 1).trim();
      if (hint) {
        return hint;
      }
      return withoutPrefix.slice(0, rawHash).trim() || withoutPrefix;
    }
    return withoutPrefix || raw;
  }

  return raw;
}

/**
 * Renders one spring-animated, color-coded cursor per active agent inside the
 * Obsidian window without intercepting pointer events or hit-testing.
 */
export class AgentCursorOverlay {
  private readonly win: Window;
  private readonly idleAfterMs: number;
  private readonly hideAfterMs: number;
  private enabled: boolean;
  private disposed = false;
  private layerEl: HTMLElement | null = null;
  private readonly cursors = new Map<string, CursorInstance>();
  private readonly assignedHues = new Map<string, number>();
  private rafId: number | null = null;
  private lastFrameMs: number | null = null;

  constructor(options: AgentCursorOptions) {
    this.win = options.win;
    this.enabled = options.enabled ?? true;
    this.idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_MS;
    this.hideAfterMs = options.hideAfterMs ?? DEFAULT_HIDE_MS;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.clearAll();
    }
  }

  private readonly fadingEls = new Map<HTMLElement, { caller: string; timer: number | null }>();
  private readonly trackedScrollDoms = new Map<Element, () => void>();
  private readonly observedResizeEls = new Set<Element>();
  private readonly mutationObservers = new Map<Element, MutationObserver>();
  private resizeObserver: ResizeObserver | null = null;
  private winScrollListener: (() => void) | null = null;
  private readonly knownLiveCallers = new Set<string>();
  private readonly pendingSettleTimers = new Set<number>();
  private readonly recentTextAnchors = new Map<string, RecentTextAnchor>();

  getActiveCount(): number {
    return this.cursors.size;
  }

  /**
   * Resolves once the caller's cursor finishes gliding to its current target,
   * or immediately when disabled, reduced-motion, missing, or already settled.
   */
  whenSettled(caller: string, maxWaitMs = DEFAULT_SETTLE_WAIT_MS): Promise<void> {
    if (this.disposed || !this.enabled) {
      return Promise.resolve();
    }
    const cursor = this.cursors.get(caller);
    if (!cursor || this.prefersReducedMotion() || this.isCursorSettled(cursor)) {
      return Promise.resolve();
    }
    const capMs =
      typeof maxWaitMs === "number" && Number.isFinite(maxWaitMs)
        ? Math.max(0, Math.min(MAX_SETTLE_WAIT_MS, maxWaitMs))
        : DEFAULT_SETTLE_WAIT_MS;
    if (capMs === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: number | null = null;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== null) {
          this.win.clearTimeout(timer);
          this.pendingSettleTimers.delete(timer);
          timer = null;
        }
        const idx = cursor.settleWaiters.indexOf(finish);
        if (idx >= 0) {
          cursor.settleWaiters.splice(idx, 1);
        }
        resolve();
      };
      cursor.settleWaiters.push(finish);
      if (typeof this.win.setTimeout === "function") {
        timer = this.win.setTimeout(() => {
          const timerId = timer;
          timer = null;
          if (timerId !== null) {
            this.pendingSettleTimers.delete(timerId);
          }
          if (!this.disposed && this.cursors.get(caller) === cursor && !this.isCursorSettled(cursor)) {
            this.setCursorMotionTarget(cursor, cursor.targetX, cursor.targetY, true);
          } else {
            finish();
          }
        }, capMs);
        this.pendingSettleTimers.add(timer);
      }
    });
  }

  moveTo(
    caller: string,
    label: string,
    x: number,
    y: number,
    action?: string,
    docContext?: DocumentCursorContext | null
  ): void {
    if (this.disposed || !this.enabled) {
      return;
    }
    this.cancelExitingForCaller(caller);
    const renameOverride = this.resolveRenamePartialTarget(caller, action, docContext);
    const effectiveCtx = renameOverride ? renameOverride.docContext : docContext;
    const targetX = renameOverride ? renameOverride.point.x : x;
    const targetY = renameOverride ? renameOverride.point.y : y;
    const cursor = this.ensureCursor(caller, label);
    const honest = normalizeHonestAction("move", action);
    this.updateDocumentAnchor(cursor, effectiveCtx, {
      clearOnEmpty: true,
      matchPoint: { x: targetX, y: targetY },
    });
    this.updateCursorTarget(cursor, targetX, targetY, honest.text, {
      isTyping: honest.isTyping,
      transientMs: honest.text ? Math.min(this.idleAfterMs, BRIEF_ACTION_MS) : 0,
    });
  }

  pulseClick(
    caller: string,
    label: string,
    x: number,
    y: number,
    action = "clicking",
    docContext?: DocumentCursorContext | null
  ): void {
    if (this.disposed || !this.enabled) {
      return;
    }
    this.cancelExitingForCaller(caller);
    const cursor = this.ensureCursor(caller, label);
    const honest = normalizeHonestAction("click", action);
    this.updateDocumentAnchor(cursor, docContext, { clearOnEmpty: true, matchPoint: { x, y } });
    this.updateCursorTarget(cursor, x, y, honest.text, { isTyping: false, transientMs: Math.min(this.idleAfterMs, BRIEF_ACTION_MS) });
    this.triggerRing(cursor);
  }

  setTyping(
    caller: string,
    label: string,
    x: number,
    y: number,
    docContext?: DocumentCursorContext | null
  ): void {
    if (this.disposed || !this.enabled) {
      return;
    }
    this.cancelExitingForCaller(caller);
    const cursor = this.ensureCursor(caller, label);
    this.updateDocumentAnchor(cursor, docContext, { clearOnEmpty: true });
    this.updateCursorTarget(cursor, x, y, "typing", { isTyping: true, transientMs: Math.min(this.idleAfterMs, TYPING_SAFETY_MS) });
    cursor.el.classList.add("is-typing");
  }

  finishTyping(caller: string, docContext?: DocumentCursorContext): void {
    this.parkAgent(caller, docContext);
  }

  parkAgent(caller: string, docContext?: DocumentCursorContext | null): void {
    if (this.disposed || !this.enabled) {
      return;
    }
    const cursor = this.cursors.get(caller);
    if (!cursor) {
      return;
    }
    if (cursor.actionTimer !== null) {
      this.win.clearTimeout(cursor.actionTimer);
      cursor.actionTimer = null;
    }
    if (cursor.idleTimer !== null) {
      this.win.clearTimeout(cursor.idleTimer);
      cursor.idleTimer = null;
    }
    this.clearActionLabel(cursor);
    cursor.el.classList.add("is-idle");
    if (docContext !== undefined) {
      this.updateDocumentAnchor(cursor, docContext, {
        clearOnEmpty: true,
        adoptInPlaceRename: true,
      });
      this.reprojectCursor(cursor, true);
    } else if (cursor.docAnchor && this.isAnchorSameNoteAndConnected(cursor.docAnchor)) {
      this.syncAnchorFromDoc(cursor.docAnchor);
      this.recentTextAnchors.delete(caller);
      this.recordRecentTextAnchor(caller, cursor.docAnchor);
      this.reprojectCursor(cursor, true);
    }
    this.resetHideTimer(cursor);
  }

  notifyNoteUpdated(notePath?: string, change?: NoteDocChange): void {
    if (this.disposed || !this.enabled) {
      return;
    }
    for (const cursor of Array.from(this.cursors.values())) {
      const anchor = cursor.docAnchor;
      if (!anchor) {
        continue;
      }
      if (notePath !== undefined && anchor.notePath !== undefined && anchor.notePath !== notePath) {
        continue;
      }
      if (!this.isAnchorSameNoteAndConnected(anchor)) {
        this.hideDisplacedCursor(cursor);
        continue;
      }
      this.syncAnchorFromDoc(anchor, change);
      this.recordRecentTextAnchor(cursor.caller, anchor);
      this.reprojectCursor(cursor, true);
    }
  }

  exitAgent(caller: string): void {
    const cursor = this.cursors.get(caller);
    this.knownLiveCallers.delete(caller);
    this.recentTextAnchors.delete(caller);
    if (!cursor) {
      return;
    }
    this.clearTimers(cursor);
    this.resolveSettleWaiters(cursor);
    this.cursors.delete(caller);
    if (this.cursors.size === 0) {
      this.stopLoop();
      this.detachAllListeners();
    } else {
      this.pruneUnusedObservers();
      this.updateLabelOffsets();
    }

    cursor.el.classList.remove("is-typing", "is-clicking", "is-entering");
    cursor.el.classList.add("is-exiting");
    if (this.disposed || this.prefersReducedMotion()) {
      cursor.el.remove();
      return;
    }

    const fadeMs = Math.min(EXIT_FADE_MS, Math.max(40, this.hideAfterMs));
    const timer = this.win.setTimeout(() => {
      this.fadingEls.delete(cursor.el);
      cursor.el.remove();
    }, fadeMs);
    this.fadingEls.set(cursor.el, { caller, timer });
  }

  reconcileLiveCallers(liveIdentities: Iterable<string>): void {
    if (this.disposed) {
      return;
    }
    const liveSet = new Set<string>();
    for (const raw of liveIdentities) {
      const trimmed = raw.trim();
      if (!trimmed) {
        continue;
      }
      liveSet.add(trimmed);
      if (trimmed.startsWith("herdr:")) {
        liveSet.add(trimmed.slice("herdr:".length));
      }
    }

    for (const caller of Array.from(this.cursors.keys())) {
      const cursor = this.cursors.get(caller);
      if (!cursor) {
        continue;
      }
      const bare = caller.startsWith("herdr:") ? caller.slice("herdr:".length) : caller;
      const hashIdx = bare.indexOf("#");
      const panePart = hashIdx >= 0 ? bare.slice(0, hashIdx) : bare;
      const hintPart = hashIdx >= 0 ? bare.slice(hashIdx + 1) : "";
      const anchorPane = cursor.docAnchor?.pane ?? "";

      const isLive =
        liveSet.has(caller) ||
        liveSet.has(bare) ||
        (panePart !== "" && liveSet.has(panePart)) ||
        (hintPart !== "" && liveSet.has(hintPart)) ||
        (anchorPane !== "" && liveSet.has(anchorPane));

      if (isLive) {
        this.knownLiveCallers.add(caller);
        continue;
      }

      const isHerdrManaged =
        this.knownLiveCallers.has(caller) ||
        caller.startsWith("herdr:") ||
        isHerdrPaneId(panePart) ||
        anchorPane !== "";

      if (isHerdrManaged) {
        this.exitAgent(caller);
      }
    }
  }

  clearAgent(caller: string): void {
    this.cancelExitingForCaller(caller);
    this.knownLiveCallers.delete(caller);
    const cursor = this.cursors.get(caller);
    if (!cursor) {
      return;
    }
    this.clearTimers(cursor);
    this.resolveSettleWaiters(cursor);
    cursor.el.remove();
    this.cursors.delete(caller);
    if (this.cursors.size === 0) {
      this.stopLoop();
      this.detachAllListeners();
    } else {
      this.pruneUnusedObservers();
      this.updateLabelOffsets();
    }
  }

  clearAll(): void {
    for (const caller of Array.from(this.cursors.keys())) {
      this.clearAgent(caller);
    }
    for (const timerId of this.pendingSettleTimers) {
      this.win.clearTimeout(timerId);
    }
    this.pendingSettleTimers.clear();
    for (const [el, entry] of Array.from(this.fadingEls.entries())) {
      if (entry.timer !== null) {
        this.win.clearTimeout(entry.timer);
      }
      el.remove();
      this.fadingEls.delete(el);
    }
    this.knownLiveCallers.clear();
    this.recentTextAnchors.clear();
    this.detachAllListeners();
    if (this.layerEl) {
      this.layerEl.remove();
      this.layerEl = null;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopLoop();
    this.clearAll();
  }

  private pickHueForCaller(caller: string): number {
    const activeHues = new Set<number>();
    for (const [id, cursor] of this.cursors.entries()) {
      if (id !== caller) {
        activeHues.add(cursor.hue);
      }
    }
    const remembered = this.assignedHues.get(caller);
    if (remembered !== undefined && !activeHues.has(remembered)) {
      return remembered;
    }
    const baseBucket = hashCallerBucket(caller);
    let chosen = baseBucket * 30;
    for (let step = 0; step < HUE_BUCKETS; step += 1) {
      const candidate = ((baseBucket + step) % HUE_BUCKETS) * 30;
      if (!activeHues.has(candidate)) {
        chosen = candidate;
        break;
      }
    }
    this.assignedHues.set(caller, chosen);
    return chosen;
  }

  private ensureLayer(): HTMLElement | null {
    if (this.disposed) {
      return null;
    }
    if (this.layerEl && this.layerEl.isConnected) {
      return this.layerEl;
    }
    const body = this.win.document?.body;
    if (!body) {
      return null;
    }
    const layer = body.createDiv({
      cls: "herdr-cursor-layer",
      attr: { "aria-hidden": "true" },
    });
    this.layerEl = layer;
    return layer;
  }

  private ensureCursor(caller: string, label: string): CursorInstance {
    const displayLabel = formatCursorDisplayLabel(caller, label);
    const existing = this.cursors.get(caller);
    if (existing) {
      if (displayLabel && existing.label !== displayLabel) {
        existing.label = displayLabel;
        existing.badgeEl.textContent = displayLabel;
      }
      return existing;
    }

    const hue = this.pickHueForCaller(caller);
    const layer = this.ensureLayer();
    const el = layer
      ? layer.createDiv({ cls: "herdr-cursor is-entering" })
      : this.win.document.createDiv({ cls: "herdr-cursor is-entering" });
    el.style.setProperty("--herdr-cursor-hue", String(hue));
    if (!this.prefersReducedMotion()) {
      this.win.requestAnimationFrame(() => {
        el.classList.remove("is-entering");
      });
    } else {
      el.classList.remove("is-entering");
    }

    const ringEl = el.createDiv({ cls: "herdr-cursor-ring" });

    const svg = this.win.document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "herdr-cursor-pointer");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("viewBox", "0 0 14 14");
    svg.setAttribute("fill", "none");
    const path = this.win.document.createElementNS(SVG_NS, "path");
    // Hotspot is the filled tip apex and stroke join center at SVG (0, 0); CSS overflow: visible keeps it centered on the caret.
    path.setAttribute("d", "M0 0L10.5 5.8L5.8 7.2L4.4 11.8L0 0Z");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("stroke", "var(--background-primary)");
    path.setAttribute("stroke-width", "1.2");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    el.appendChild(svg);

    const pillEl = el.createDiv({ cls: "herdr-cursor-pill" });
    pillEl.style.setProperty("--herdr-pill-x", `${PILL_DEFAULT_X}px`);
    pillEl.style.setProperty("--herdr-pill-y", `${PILL_DEFAULT_Y}px`);
    const badgeEl = pillEl.createSpan({
      cls: "herdr-cursor-label",
      text: displayLabel,
    });
    const actionEl = pillEl.createSpan({ cls: "herdr-cursor-action" });

    const startX = Math.round((this.win.innerWidth || 800) / 2);
    const startY = Math.round((this.win.innerHeight || 600) / 2);
    el.style.transform = `translate3d(${formatCssPx(startX)}, ${formatCssPx(startY)}, 0)`;

    const instance: CursorInstance = {
      caller,
      label: displayLabel,
      hue,
      el,
      pillEl,
      badgeEl,
      actionEl,
      ringEl,
      x: startX,
      y: startY,
      targetX: startX,
      targetY: startY,
      glide: null,
      settleWaiters: [],
      initialized: false,
      actionTimer: null,
      idleTimer: null,
      hideTimer: null,
      pulseTimer: null,
      docAnchor: null,
      paneBounds: null,
    };
    this.cursors.set(caller, instance);
    return instance;
  }

  private estimatePillSize(cursor: CursorInstance): { width: number; height: number } {
    const measured = cursor.pillEl.getBoundingClientRect?.();
    if (measured && measured.width > 0 && measured.height > 0) {
      return { width: Math.ceil(measured.width), height: Math.ceil(measured.height) };
    }
    const textLen = cursor.label.length + (cursor.actionEl.textContent?.length ?? 0);
    return {
      width: Math.max(44, textLen * 7 + 18),
      height: 18,
    };
  }

  /** Offsets overlapping cursor labels so multiple agents at the same point remain readable. */
  private updateLabelOffsets(): void {
    const placed: PillRect[] = [];
    const viewW = this.win.innerWidth || 1920;
    const viewH = this.win.innerHeight || 1080;

    for (const cursor of this.cursors.values()) {
      if (cursor.el.classList.contains("is-offscreen")) {
        continue;
      }
      const bounds = cursor.paneBounds ?? { left: 0, top: 0, right: viewW, bottom: viewH };
      const { width, height } = this.estimatePillSize(cursor);
      const leftSideX = -width - 8;
      const aboveY = -height - 6;
      const candidates: Array<[number, number]> = [
        [PILL_DEFAULT_X, PILL_DEFAULT_Y],
        [PILL_DEFAULT_X, aboveY],
        [leftSideX, PILL_DEFAULT_Y],
        [leftSideX, aboveY],
        [PILL_DEFAULT_X, PILL_DEFAULT_Y + PILL_ROW_STEP],
        [PILL_DEFAULT_X, aboveY - PILL_ROW_STEP],
        [PILL_DEFAULT_X, PILL_DEFAULT_Y + PILL_ROW_STEP * 2],
        [leftSideX, PILL_DEFAULT_Y + PILL_ROW_STEP],
        [PILL_DEFAULT_X, PILL_DEFAULT_Y + PILL_ROW_STEP * 3],
      ];

      let chosenX = PILL_DEFAULT_X;
      let chosenY = PILL_DEFAULT_Y + placed.length * PILL_ROW_STEP;
      let fallbackInBounds: [number, number] | null = null;

      for (const [ox, oy] of candidates) {
        const rect: PillRect = {
          left: cursor.targetX + ox,
          top: cursor.targetY + oy,
          right: cursor.targetX + ox + width,
          bottom: cursor.targetY + oy + height,
        };
        const inViewport =
          rect.left >= bounds.left + 2 &&
          rect.top >= bounds.top + 2 &&
          rect.right <= bounds.right - 2 &&
          rect.bottom <= bounds.bottom - 2;
        if (inViewport && !fallbackInBounds) {
          fallbackInBounds = [ox, oy];
        }
        if (inViewport && !placed.some((p) => rectsOverlap(rect, p))) {
          chosenX = ox;
          chosenY = oy;
          break;
        }
      }

      if (
        chosenX === PILL_DEFAULT_X &&
        chosenY === PILL_DEFAULT_Y + placed.length * PILL_ROW_STEP &&
        fallbackInBounds
      ) {
        const defaultRect: PillRect = {
          left: cursor.targetX + chosenX,
          top: cursor.targetY + chosenY,
          right: cursor.targetX + chosenX + width,
          bottom: cursor.targetY + chosenY + height,
        };
        const overflowsPane =
          defaultRect.left < bounds.left + 2 ||
          defaultRect.top < bounds.top + 2 ||
          defaultRect.right > bounds.right - 2 ||
          defaultRect.bottom > bounds.bottom - 2;
        if (overflowsPane || placed.some((p) => rectsOverlap(defaultRect, p))) {
          chosenX = fallbackInBounds[0];
          chosenY = fallbackInBounds[1];
        }
      }

      if (cursor.paneBounds) {
        const minRelX = bounds.left + 2 - cursor.targetX;
        const maxRelX = bounds.right - 2 - width - cursor.targetX;
        const minRelY = bounds.top + 2 - cursor.targetY;
        const maxRelY = bounds.bottom - 2 - height - cursor.targetY;
        if (maxRelX >= minRelX) {
          chosenX = Math.max(minRelX, Math.min(maxRelX, chosenX));
        }
        if (maxRelY >= minRelY) {
          chosenY = Math.max(minRelY, Math.min(maxRelY, chosenY));
        }
      }

      cursor.pillEl.style.setProperty("--herdr-pill-x", `${Math.round(chosenX)}px`);
      cursor.pillEl.style.setProperty("--herdr-pill-y", `${Math.round(chosenY)}px`);
      placed.push({
        left: cursor.targetX + chosenX,
        top: cursor.targetY + chosenY,
        right: cursor.targetX + chosenX + width,
        bottom: cursor.targetY + chosenY + height,
      });
    }
  }

  private isCursorSettled(cursor: CursorInstance): boolean {
    return (
      !cursor.glide &&
      Math.hypot(cursor.targetX - cursor.x, cursor.targetY - cursor.y) <= SETTLE_EPSILON
    );
  }

  private resolveSettleWaiters(cursor: CursorInstance): void {
    if (cursor.settleWaiters.length === 0) {
      return;
    }
    const waiters = cursor.settleWaiters.splice(0, cursor.settleWaiters.length);
    for (const resolve of waiters) {
      resolve();
    }
  }

  private setCursorMotionTarget(cursor: CursorInstance, x: number, y: number, immediate: boolean): void {
    cursor.targetX = x;
    cursor.targetY = y;
    const dist = Math.hypot(x - cursor.x, y - cursor.y);
    if (immediate || this.prefersReducedMotion() || !cursor.initialized || dist <= SETTLE_EPSILON) {
      cursor.x = x;
      cursor.y = y;
      cursor.glide = null;
      cursor.initialized = true;
      cursor.el.style.transform = `translate3d(${formatCssPx(x)}, ${formatCssPx(y)}, 0)`;
      this.resolveSettleWaiters(cursor);
      return;
    }
    const durationMs = Math.round(
      Math.min(MAX_GLIDE_MS, Math.max(MIN_GLIDE_MS, MIN_GLIDE_MS + dist * 0.135))
    );
    cursor.glide = {
      startX: cursor.x,
      startY: cursor.y,
      elapsedMs: 0,
      durationMs,
    };
    this.startLoop();
  }

  private updateCursorTarget(
    cursor: CursorInstance,
    x: number,
    y: number,
    action: string,
    opts: { isTyping: boolean; transientMs: number }
  ): void {
    const clampedX = Math.max(0, Math.min(this.win.innerWidth || x, x));
    const clampedY = Math.max(0, Math.min(this.win.innerHeight || y, y));

    cursor.el.classList.remove("is-idle", "is-typing", "is-exiting", "is-offscreen");
    if (cursor.actionTimer !== null) {
      this.win.clearTimeout(cursor.actionTimer);
      cursor.actionTimer = null;
    }

    if (action) {
      cursor.actionEl.textContent = action;
      cursor.actionEl.classList.add("is-visible");
      if (opts.isTyping) {
        cursor.el.classList.add("is-typing");
      }
      if (opts.transientMs > 0) {
        cursor.actionTimer = this.win.setTimeout(() => {
          cursor.actionTimer = null;
          this.clearActionLabel(cursor);
        }, opts.transientMs);
      }
    } else {
      this.clearActionLabel(cursor);
    }

    if (cursor.docAnchor) {
      if (!this.isAnchorSameNoteAndConnected(cursor.docAnchor)) {
        cursor.paneBounds = null;
        cursor.el.classList.add("is-offscreen");
      } else {
        const bounds = this.computePaneBounds(cursor.docAnchor);
        cursor.paneBounds = bounds;
        if (bounds) {
          const outOfBounds =
            clampedX < bounds.left - 2 ||
            clampedX > bounds.right + 2 ||
            clampedY < bounds.top - 2 ||
            clampedY > bounds.bottom + 2;
          cursor.el.classList.toggle("is-offscreen", outOfBounds);
        } else if (this.hasMeasurableHostBox(cursor.docAnchor)) {
          cursor.el.classList.add("is-offscreen");
        }
      }
    } else {
      cursor.paneBounds = null;
    }

    this.setCursorMotionTarget(cursor, clampedX, clampedY, false);

    this.updateLabelOffsets();
    this.resetActivityTimers(cursor);
  }

  private triggerRing(cursor: CursorInstance): void {
    if (cursor.pulseTimer !== null) {
      this.win.clearTimeout(cursor.pulseTimer);
      cursor.pulseTimer = null;
    }
    cursor.el.classList.remove("is-clicking");
    // Force style recalc only when restarting an active pulse class.
    void cursor.ringEl.offsetWidth;
    cursor.el.classList.add("is-clicking");
    cursor.pulseTimer = this.win.setTimeout(() => {
      cursor.pulseTimer = null;
      cursor.el.classList.remove("is-clicking");
    }, 420);
  }

  private clearActionLabel(cursor: CursorInstance): void {
    cursor.actionEl.textContent = "";
    cursor.actionEl.classList.remove("is-visible");
    cursor.el.classList.remove("is-typing");
  }

  private resetActivityTimers(cursor: CursorInstance): void {
    if (cursor.idleTimer !== null) {
      this.win.clearTimeout(cursor.idleTimer);
    }
    cursor.idleTimer = this.win.setTimeout(() => {
      cursor.idleTimer = null;
      if (cursor.actionTimer !== null) {
        this.win.clearTimeout(cursor.actionTimer);
        cursor.actionTimer = null;
      }
      this.clearActionLabel(cursor);
      cursor.el.classList.add("is-idle");
    }, this.idleAfterMs);

    this.resetHideTimer(cursor);
  }

  private resetHideTimer(cursor: CursorInstance): void {
    if (cursor.hideTimer !== null) {
      this.win.clearTimeout(cursor.hideTimer);
    }
    cursor.hideTimer = this.win.setTimeout(() => {
      cursor.hideTimer = null;
      this.exitAgent(cursor.caller);
    }, this.hideAfterMs);
  }

  private clearTimers(cursor: CursorInstance): void {
    if (cursor.actionTimer !== null) {
      this.win.clearTimeout(cursor.actionTimer);
      cursor.actionTimer = null;
    }
    if (cursor.idleTimer !== null) {
      this.win.clearTimeout(cursor.idleTimer);
      cursor.idleTimer = null;
    }
    if (cursor.hideTimer !== null) {
      this.win.clearTimeout(cursor.hideTimer);
      cursor.hideTimer = null;
    }
    if (cursor.pulseTimer !== null) {
      this.win.clearTimeout(cursor.pulseTimer);
      cursor.pulseTimer = null;
    }
  }

  private cancelExitingForCaller(caller: string): void {
    for (const [el, entry] of Array.from(this.fadingEls.entries())) {
      if (entry.caller !== caller) {
        continue;
      }
      if (entry.timer !== null) {
        this.win.clearTimeout(entry.timer);
      }
      el.remove();
      this.fadingEls.delete(el);
    }
  }

  private recordRecentTextAnchor(caller: string, anchor: DocumentAnchor | null): void {
    if (
      !anchor?.cm ||
      typeof anchor.pos !== "number" ||
      !Number.isFinite(anchor.pos) ||
      anchor.docSnapshot === null
    ) {
      return;
    }
    this.recentTextAnchors.set(caller, {
      cm: anchor.cm,
      notePath: anchor.notePath,
      pos: anchor.pos,
      docSnapshot: anchor.docSnapshot,
    });
  }

  /**
   * When a mid-write rename aborts typing and vault.rename_note immediately follows with
   * pointAtResult(..., "rename") (which reads the stale editor selection), keep the cursor
   * anchored on the partial streamed line inside the renamed buffer.
   */
  private resolveRenamePartialTarget(
    caller: string,
    action: string | undefined,
    docContext?: DocumentCursorContext | null
  ): { docContext: DocumentCursorContext; point: { x: number; y: number } } | null {
    if (action?.trim() !== "rename" || !docContext?.cm || typeof docContext.pos === "number") {
      return null;
    }
    const cm = docContext.cm;
    if (cm.scrollDOM?.isConnected === false || cm.dom?.isConnected === false) {
      return null;
    }
    const existingAnchor = this.cursors.get(caller)?.docAnchor ?? null;
    const recent =
      existingAnchor?.cm === cm && typeof existingAnchor.pos === "number"
        ? {
            cm,
            notePath: existingAnchor.notePath,
            pos: existingAnchor.pos,
            docSnapshot: existingAnchor.docSnapshot,
          }
        : this.recentTextAnchors.get(caller) ?? null;
    if (!recent || recent.cm !== cm || !Number.isFinite(recent.pos)) {
      return null;
    }
    const currentDoc = cm.state?.doc ? cm.state.doc.toString() : null;
    if (currentDoc === null || recent.docSnapshot === null) {
      return null;
    }
    const sameText = currentDoc === recent.docSnapshot;
    const renamedInPlace = Boolean(
      recent.notePath && docContext.notePath && recent.notePath !== docContext.notePath
    );
    if (!sameText && !renamedInPlace) {
      return null;
    }
    const targetPos = sameText
      ? Math.max(0, Math.min(currentDoc.length, recent.pos))
      : Math.max(
          0,
          Math.min(currentDoc.length, mapAnchoredPos(recent.docSnapshot, currentDoc, recent.pos))
        );
    const coords = cm.coordsAtPos?.(targetPos) ?? cm.coordsAtPos?.(targetPos, -1);
    if (!coords || !Number.isFinite(coords.left) || !Number.isFinite(coords.top)) {
      return null;
    }
    return {
      docContext: { ...docContext, pos: targetPos },
      point: caretPointFromCoords(coords),
    };
  }

  private clearDocumentAnchor(cursor: CursorInstance): void {
    cursor.docAnchor = null;
    cursor.paneBounds = null;
    cursor.el.classList.remove("is-offscreen");
    this.pruneUnusedObservers();
  }

  private updateDocumentAnchor(
    cursor: CursorInstance,
    docContext?: DocumentCursorContext | null,
    opts?: { clearOnEmpty?: boolean; matchPoint?: { x: number; y: number }; adoptInPlaceRename?: boolean }
  ): void {
    if (docContext === null || (!docContext && opts?.clearOnEmpty)) {
      this.clearDocumentAnchor(cursor);
      return;
    }
    if (!docContext) {
      return;
    }
    if (!hasDocumentAnchorTarget(docContext)) {
      if (opts?.clearOnEmpty) {
        this.clearDocumentAnchor(cursor);
      }
      return;
    }

    const prev = cursor.docAnchor;
    const sameNote =
      prev !== null &&
      (docContext.notePath === undefined || prev.notePath === undefined || prev.notePath === docContext.notePath);
    const sameCm =
      prev !== null &&
      (docContext.cm === undefined || docContext.cm === null || prev.cm === null || prev.cm === docContext.cm);
    const sameTargetDoc = Boolean(prev && sameNote && sameCm);

    const cm = docContext.cm !== undefined ? docContext.cm : sameTargetDoc ? prev?.cm ?? null : null;
    const view = docContext.view !== undefined ? docContext.view : sameTargetDoc ? prev?.view ?? null : null;
    const docSnapshot = cm?.state?.doc ? cm.state.doc.toString() : sameTargetDoc ? prev?.docSnapshot ?? null : null;
    let notePath =
      docContext.notePath !== undefined ? docContext.notePath : sameCm ? prev?.notePath : undefined;
    if (
      opts?.adoptInPlaceRename &&
      prev &&
      cm &&
      prev.cm === cm &&
      view?.file?.path &&
      notePath !== undefined &&
      view.file.path !== notePath &&
      prev.docSnapshot !== null &&
      docSnapshot === prev.docSnapshot
    ) {
      notePath = view.file.path;
    }
    const pane = docContext.pane !== undefined ? docContext.pane : sameTargetDoc ? prev?.pane : undefined;
    const leafId = docContext.leafId !== undefined ? docContext.leafId : sameTargetDoc ? prev?.leafId : undefined;
    const containerEl =
      docContext.containerEl !== undefined ? docContext.containerEl : sameTargetDoc ? prev?.containerEl ?? null : null;
    const getLeafNotePath =
      docContext.getLeafNotePath !== undefined
        ? docContext.getLeafNotePath
        : sameTargetDoc
          ? prev?.getLeafNotePath
          : undefined;
    const isVisible =
      docContext.isVisible !== undefined ? docContext.isVisible : sameTargetDoc ? prev?.isVisible : undefined;

    const explicitPos = typeof docContext.pos === "number" && Number.isFinite(docContext.pos) ? docContext.pos : null;
    const selectionPos =
      typeof cm?.state?.selection?.main?.head === "number" && Number.isFinite(cm.state.selection.main.head)
        ? cm.state.selection.main.head
        : null;
    let pos = explicitPos ?? selectionPos ?? (sameTargetDoc ? prev?.pos ?? null : null);

    // Visual widget clicks/moves (e.g. task checkboxes) may inherit an unrelated CM selection
    // head that lies offscreen; keep the anchor unpinned to text pos so DOM re-renders stay put.
    if (pos !== null && opts?.matchPoint && cm?.coordsAtPos) {
      const coords = cm.coordsAtPos(pos) ?? cm.coordsAtPos(pos, -1);
      if (!coords || !Number.isFinite(coords.left) || !Number.isFinite(coords.top)) {
        pos = null;
      } else {
        const pt = caretPointFromCoords(coords);
        if (
          Math.abs(pt.x - opts.matchPoint.x) > CLICK_POS_TOLERANCE_X ||
          Math.abs(pt.y - opts.matchPoint.y) > CLICK_POS_TOLERANCE_Y
        ) {
          pos = null;
        }
      }
    }

    cursor.docAnchor = {
      notePath,
      pane,
      leafId,
      cm,
      containerEl,
      view,
      getLeafNotePath,
      isVisible,
      pos,
      docSnapshot,
    };
    this.recordRecentTextAnchor(cursor.caller, cursor.docAnchor);

    if (cm?.scrollDOM) {
      this.attachScrollDom(cm.scrollDOM);
    }
    if (containerEl && containerEl !== cm?.scrollDOM) {
      this.attachScrollDom(containerEl);
    }
    this.observeResizeTargets(cursor.docAnchor);
    this.observeMutationTarget(cursor.docAnchor);
    this.attachWinListeners();
    this.pruneUnusedObservers();
  }

  private isAnchorSameNoteAndConnected(anchor: DocumentAnchor): boolean {
    if (anchor.isVisible && !anchor.isVisible()) {
      return false;
    }
    const hostDoc = this.win.document;
    for (const el of [anchor.cm?.scrollDOM, anchor.cm?.dom, anchor.containerEl]) {
      const ownerDoc = (el as { ownerDocument?: Document | null } | null | undefined)?.ownerDocument;
      if (ownerDoc && hostDoc && ownerDoc !== hostDoc) {
        return false;
      }
    }
    if (anchor.view && anchor.notePath !== undefined && anchor.view.file?.path !== anchor.notePath) {
      return false;
    }
    if (anchor.getLeafNotePath && anchor.notePath !== undefined && anchor.getLeafNotePath() !== anchor.notePath) {
      return false;
    }
    if (anchor.cm?.scrollDOM && anchor.cm.scrollDOM.isConnected === false) {
      return false;
    }
    if (anchor.cm?.dom && anchor.cm.dom.isConnected === false) {
      return false;
    }
    if (anchor.containerEl && anchor.containerEl.isConnected === false) {
      return false;
    }
    return true;
  }

  private hasMeasurableHostBox(anchor: DocumentAnchor): boolean {
    return (
      typeof anchor.cm?.scrollDOM?.getBoundingClientRect === "function" ||
      typeof anchor.containerEl?.getBoundingClientRect === "function"
    );
  }

  private computePaneBounds(anchor: DocumentAnchor): PillRect | null {
    const viewW = this.win.innerWidth || 1920;
    const viewH = this.win.innerHeight || 1080;
    const bounds: PillRect = { left: 0, top: 0, right: viewW, bottom: viewH };

    const intersectBox = (el: Element | null | undefined): boolean => {
      if (!el || typeof el.getBoundingClientRect !== "function") {
        return true;
      }
      const r = el.getBoundingClientRect();
      if (!r) {
        return true;
      }
      if (r.width <= 0 || r.height <= 0) {
        return false;
      }
      bounds.left = Math.max(bounds.left, r.left);
      bounds.top = Math.max(bounds.top, r.top);
      bounds.right = Math.min(bounds.right, r.right);
      bounds.bottom = Math.min(bounds.bottom, r.bottom);
      return true;
    };

    if (!intersectBox(anchor.cm?.scrollDOM) || !intersectBox(anchor.containerEl)) {
      return null;
    }

    const statusRect = this.win.document?.querySelector?.<HTMLElement>(".status-bar")?.getBoundingClientRect?.();
    if (statusRect && statusRect.height > 0 && statusRect.top > bounds.top) {
      bounds.bottom = Math.min(bounds.bottom, statusRect.top);
    }

    if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
      return null;
    }
    return bounds;
  }

  private hideDisplacedCursor(cursor: CursorInstance): void {
    cursor.paneBounds = null;
    cursor.el.classList.add("is-offscreen");
    const anchor = cursor.docAnchor;
    if (
      anchor &&
      ((anchor.cm?.scrollDOM && anchor.cm.scrollDOM.isConnected === false) ||
        (anchor.cm?.dom && anchor.cm.dom.isConnected === false) ||
        (anchor.containerEl && anchor.containerEl.isConnected === false))
    ) {
      this.clearAgent(cursor.caller);
      return;
    }
    this.updateLabelOffsets();
  }

  private syncAnchorFromDoc(anchor: DocumentAnchor, change?: NoteDocChange): void {
    const nextText = anchor.cm?.state?.doc ? anchor.cm.state.doc.toString() : null;
    if (anchor.pos !== null) {
      const textChanged = nextText === null || anchor.docSnapshot !== nextText;
      anchor.pos = mapAnchoredPos(
        anchor.docSnapshot,
        nextText,
        anchor.pos,
        change && textChanged ? change : undefined
      );
    }
    if (nextText !== null) {
      anchor.docSnapshot = nextText;
    }
  }

  private reprojectCursor(cursor: CursorInstance, immediate = false): void {
    const anchor = cursor.docAnchor;
    if (!anchor) {
      return;
    }
    if (!this.isAnchorSameNoteAndConnected(anchor)) {
      this.hideDisplacedCursor(cursor);
      return;
    }

    const paneBounds = this.computePaneBounds(anchor);
    if (!paneBounds && this.hasMeasurableHostBox(anchor)) {
      cursor.paneBounds = null;
      cursor.el.classList.add("is-offscreen");
      this.updateLabelOffsets();
      return;
    }

    if (!anchor.cm?.coordsAtPos) {
      cursor.paneBounds = paneBounds;
      return;
    }
    if (anchor.pos === null) {
      if (paneBounds && this.hasMeasurableHostBox(anchor)) {
        const outOfBounds =
          cursor.targetX < paneBounds.left - 2 ||
          cursor.targetX > paneBounds.right + 2 ||
          cursor.targetY < paneBounds.top - 2 ||
          cursor.targetY > paneBounds.bottom + 2;
        cursor.el.classList.toggle("is-offscreen", outOfBounds);
        cursor.paneBounds = outOfBounds ? null : paneBounds;
      } else {
        cursor.paneBounds = paneBounds;
        cursor.el.classList.remove("is-offscreen");
      }
      this.updateLabelOffsets();
      return;
    }
    const maxPos = anchor.cm.state?.doc?.length ?? anchor.docSnapshot?.length;
    const clampedPos =
      typeof maxPos === "number" ? Math.max(0, Math.min(maxPos, anchor.pos)) : Math.max(0, anchor.pos);
    anchor.pos = clampedPos;

    const coords =
      anchor.cm.coordsAtPos(clampedPos) ??
      anchor.cm.coordsAtPos(clampedPos, -1);
    if (!coords || !Number.isFinite(coords.left) || !Number.isFinite(coords.top)) {
      cursor.paneBounds = null;
      cursor.el.classList.add("is-offscreen");
      this.updateLabelOffsets();
      return;
    }

    const activeBounds = paneBounds;
    let offscreen = false;
    if (activeBounds && this.hasMeasurableHostBox(anchor)) {
      const caretBottom = typeof coords.bottom === "number" && Number.isFinite(coords.bottom) ? coords.bottom : coords.top;
      const caretRight = typeof coords.right === "number" && Number.isFinite(coords.right) ? coords.right : coords.left;
      offscreen =
        caretBottom < activeBounds.top ||
        coords.top > activeBounds.bottom ||
        caretRight < activeBounds.left ||
        coords.left > activeBounds.right ||
        coords.top < activeBounds.top - 2 ||
        caretBottom > activeBounds.bottom + 2;
    }
    cursor.el.classList.toggle("is-offscreen", offscreen);
    cursor.paneBounds = offscreen ? null : activeBounds;

    const caretPt = caretPointFromCoords(coords);
    const clampedX = Math.max(0, Math.min(this.win.innerWidth || caretPt.x, caretPt.x));
    const clampedY = Math.max(0, Math.min(this.win.innerHeight || caretPt.y, caretPt.y));
    const snap =
      immediate ||
      this.prefersReducedMotion() ||
      !cursor.initialized ||
      cursor.el.classList.contains("is-idle");
    this.setCursorMotionTarget(cursor, clampedX, clampedY, snap);
    this.updateLabelOffsets();
  }

  private reprojectAll(targetEl?: Element, immediate = false): void {
    for (const cursor of Array.from(this.cursors.values())) {
      const anchor = cursor.docAnchor;
      if (!anchor) {
        continue;
      }
      if (
        targetEl &&
        anchor.cm?.scrollDOM !== targetEl &&
        anchor.cm?.contentDOM !== targetEl &&
        anchor.cm?.dom !== targetEl &&
        anchor.containerEl !== targetEl
      ) {
        continue;
      }
      this.reprojectCursor(cursor, immediate);
    }
  }

  private attachScrollDom(scrollDom: Element): void {
    if (this.trackedScrollDoms.has(scrollDom) || typeof scrollDom.addEventListener !== "function") {
      return;
    }
    const handler = (): void => {
      this.reprojectAll(scrollDom, true);
    };
    scrollDom.addEventListener("scroll", handler, { passive: true });
    this.trackedScrollDoms.set(scrollDom, handler);
  }

  private getResizeObserverCtor(): typeof ResizeObserver | undefined {
    const winRo = (this.win as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (typeof winRo === "function") {
      return winRo;
    }
    return typeof ResizeObserver === "function" ? ResizeObserver : undefined;
  }

  private getMutationObserverCtor(): typeof MutationObserver | undefined {
    const winMo = (this.win as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver;
    if (typeof winMo === "function") {
      return winMo;
    }
    return typeof MutationObserver === "function" ? MutationObserver : undefined;
  }

  private observeResizeTargets(anchor: DocumentAnchor): void {
    const ResizeObserverCtor = this.getResizeObserverCtor();
    if (!ResizeObserverCtor) {
      return;
    }
    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserverCtor((entries) => {
        if (this.disposed) {
          return;
        }
        for (const entry of entries) {
          this.reprojectAll(entry.target, true);
        }
      });
    }
    const candidates = [anchor.cm?.scrollDOM, anchor.cm?.contentDOM, anchor.cm?.dom, anchor.containerEl];
    for (const el of candidates) {
      if (el && !this.observedResizeEls.has(el)) {
        this.resizeObserver.observe(el);
        this.observedResizeEls.add(el);
      }
    }
  }

  private observeMutationTarget(anchor: DocumentAnchor): void {
    const target = anchor.cm?.contentDOM ?? anchor.cm?.dom ?? anchor.cm?.scrollDOM;
    if (!target || this.mutationObservers.has(target)) {
      return;
    }
    const MutationObserverCtor = this.getMutationObserverCtor();
    if (!MutationObserverCtor) {
      return;
    }
    const observer = new MutationObserverCtor(() => {
      if (this.disposed) {
        return;
      }
      for (const cursor of Array.from(this.cursors.values())) {
        const curAnchor = cursor.docAnchor;
        if (!curAnchor?.cm) {
          continue;
        }
        const curTarget = curAnchor.cm.contentDOM ?? curAnchor.cm.dom ?? curAnchor.cm.scrollDOM;
        if (curTarget !== target) {
          continue;
        }
        if (!this.isAnchorSameNoteAndConnected(curAnchor)) {
          this.hideDisplacedCursor(cursor);
          continue;
        }
        this.syncAnchorFromDoc(curAnchor);
        this.reprojectCursor(cursor, true);
      }
    });
    observer.observe(target, { childList: true, characterData: true, subtree: true });
    this.mutationObservers.set(target, observer);
  }

  private attachWinListeners(): void {
    if (this.winScrollListener || typeof this.win.addEventListener !== "function") {
      return;
    }
    const handler = (): void => {
      this.reprojectAll(undefined, true);
    };
    this.win.addEventListener("resize", handler, { passive: true });
    this.win.addEventListener("scroll", handler, { passive: true });
    this.winScrollListener = handler;
  }

  private pruneUnusedObservers(): void {
    const activeScrollEls = new Set<Element>();
    const activeResizeEls = new Set<Element>();
    const activeMutationEls = new Set<Element>();
    for (const cursor of this.cursors.values()) {
      const a = cursor.docAnchor;
      if (!a) {
        continue;
      }
      if (a.cm?.scrollDOM) {
        activeScrollEls.add(a.cm.scrollDOM);
        activeResizeEls.add(a.cm.scrollDOM);
      }
      if (a.cm?.contentDOM) {
        activeResizeEls.add(a.cm.contentDOM);
      }
      if (a.cm?.dom) {
        activeResizeEls.add(a.cm.dom);
      }
      if (a.containerEl) {
        activeScrollEls.add(a.containerEl);
        activeResizeEls.add(a.containerEl);
      }
      const mutTarget = a.cm?.contentDOM ?? a.cm?.dom ?? a.cm?.scrollDOM;
      if (mutTarget) {
        activeMutationEls.add(mutTarget);
      }
    }

    for (const [el, handler] of Array.from(this.trackedScrollDoms.entries())) {
      if (!activeScrollEls.has(el)) {
        if (typeof el.removeEventListener === "function") {
          el.removeEventListener("scroll", handler);
        }
        this.trackedScrollDoms.delete(el);
      }
    }
    if (this.resizeObserver) {
      for (const el of Array.from(this.observedResizeEls)) {
        if (!activeResizeEls.has(el)) {
          this.resizeObserver.unobserve(el);
          this.observedResizeEls.delete(el);
        }
      }
    }
    for (const [el, observer] of Array.from(this.mutationObservers.entries())) {
      if (!activeMutationEls.has(el)) {
        observer.disconnect();
        this.mutationObservers.delete(el);
      }
    }
  }

  private detachAllListeners(): void {
    for (const [scrollDom, handler] of Array.from(this.trackedScrollDoms.entries())) {
      if (typeof scrollDom.removeEventListener === "function") {
        scrollDom.removeEventListener("scroll", handler);
      }
      this.trackedScrollDoms.delete(scrollDom);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.observedResizeEls.clear();
    for (const observer of this.mutationObservers.values()) {
      observer.disconnect();
    }
    this.mutationObservers.clear();
    if (this.winScrollListener && typeof this.win.removeEventListener === "function") {
      this.win.removeEventListener("resize", this.winScrollListener);
      this.win.removeEventListener("scroll", this.winScrollListener);
    }
    this.winScrollListener = null;
  }

  private prefersReducedMotion(): boolean {
    try {
      return Boolean(this.win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    } catch {
      return false;
    }
  }

  private startLoop(): void {
    if (this.disposed || this.rafId !== null) {
      return;
    }
    this.lastFrameMs = null;
    this.rafId = this.win.requestAnimationFrame((now) => this.tick(now));
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      this.win.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private tick(now: number): void {
    this.rafId = null;
    if (this.disposed || this.cursors.size === 0) {
      return;
    }
    const rawDtMs =
      this.lastFrameMs !== null && Number.isFinite(now - this.lastFrameMs)
        ? now - this.lastFrameMs
        : 16;
    this.lastFrameMs = Number.isFinite(now) ? now : null;
    const dtMs = Math.min(MAX_GLIDE_MS, Math.max(4, rawDtMs));

    let anyMoving = false;
    for (const cursor of this.cursors.values()) {
      if (cursor.glide) {
        cursor.glide.elapsedMs += dtMs;
        const progress =
          cursor.glide.durationMs > 0
            ? Math.min(1, cursor.glide.elapsedMs / cursor.glide.durationMs)
            : 1;
        const dist = Math.hypot(cursor.targetX - cursor.x, cursor.targetY - cursor.y);
        if (progress >= 1 || dist <= SETTLE_EPSILON) {
          cursor.x = cursor.targetX;
          cursor.y = cursor.targetY;
          cursor.glide = null;
          this.resolveSettleWaiters(cursor);
        } else {
          const eased = 1 - (1 - progress) ** 3;
          cursor.x = cursor.glide.startX + (cursor.targetX - cursor.glide.startX) * eased;
          cursor.y = cursor.glide.startY + (cursor.targetY - cursor.glide.startY) * eased;
          anyMoving = true;
        }
      } else {
        cursor.x = cursor.targetX;
        cursor.y = cursor.targetY;
        this.resolveSettleWaiters(cursor);
      }
      cursor.el.style.transform = `translate3d(${formatCssPx(cursor.x)}, ${formatCssPx(cursor.y)}, 0)`;
    }

    if (anyMoving) {
      this.rafId = this.win.requestAnimationFrame((next) => this.tick(next));
    }
  }
}
