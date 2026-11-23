// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Daniel Agrici. Part of the UI control module.
// See src/control/LICENSE and the NOTICE file in the repository root.

/** Viewport CSS coordinate used for drag start, intermediate steps, and drop. */
export interface DragPoint {
  x: number;
  y: number;
}

/** Minimal Electron WebContents surface needed for pointer-event drags. */
export interface DragWebContentsLike {
  sendInputEvent(event: Record<string, unknown>): void;
}

/** Structural Window/Document surface compatible with both DOM and unit-test mocks. */
export interface DragWindowLike {
  document: {
    body?: Element | null;
    documentElement?: Element | null;
    elementFromPoint?(x: number, y: number): Element | null;
  };
  DragEvent?: unknown;
  Event?: unknown;
  DataTransfer?: unknown;
  setTimeout?(handler: () => void, timeout?: number): unknown;
}

/** Options passed from UiControlService.dragNow to performDrag. */
export interface PerformDragOptions {
  win: DragWindowLike;
  wc: DragWebContentsLike;
  from: DragPoint;
  to: DragPoint;
  toWindowPoint: (point: DragPoint) => DragPoint;
  fromElement?: Element | null;
  toElement?: Element | null;
  steps?: number;
  stepDelayMs?: number;
  dropSettleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onStart?: (point: DragPoint) => void;
  onBeforeStart?: (point: DragPoint) => void;
  onBeforeStep?: (point: DragPoint, isLast: boolean) => void;
  onStep?: (point: DragPoint, isLast: boolean) => void;
  onComplete?: (point: DragPoint, dropped: boolean) => void;
}

/** Outcome returned to dragNow and bridge callers. */
export interface PerformDragResult {
  dispatched: true;
  mode: "html5" | "pointer";
  from: DragPoint;
  to: DragPoint;
  steps: number;
  dropped: boolean;
  canceled: boolean;
}

interface DataTransferLike {
  dropEffect: string;
  effectAllowed: string;
  readonly files: unknown[];
  readonly items: { length: number; add?(): void; clear?(): void; remove?(): void };
  readonly types: string[];
  setData(format: string, data: string): void;
  getData(format: string): string;
  clearData(format?: string): void;
  setDragImage?(image: unknown, xOffset: number, yOffset: number): void;
}

interface DragStep {
  css: DragPoint;
  win: DragPoint;
  isLast: boolean;
}

const HTML5_DRAG_ANCESTOR_SELECTOR =
  '[draggable="true"], .workspace-tab-header, .nav-file-title, .nav-folder-title';
const MAX_ANCESTOR_WALK = 16;
const MIN_POINTER_AUTO_STEPS = 16;
const MAX_DRAG_STEPS = 60;
const POINTER_PIXELS_PER_STEP = 8;

function defaultSleep(win: DragWindowLike, ms: number): Promise<void> {
  if (typeof win.setTimeout === "function") {
    return new Promise((resolve) => {
      win.setTimeout?.(() => resolve(), ms);
    });
  }
  if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
    return new Promise((resolve) => {
      window.setTimeout(() => resolve(), ms);
    });
  }
  return Promise.resolve();
}

function elementFromPointSafe(win: DragWindowLike, point: DragPoint): Element | null {
  try {
    return win.document.elementFromPoint?.(point.x, point.y) ?? null;
  } catch {
    return null;
  }
}

function normalizeDataTransferFormat(format: string): string {
  const lower = String(format).toLowerCase();
  if (lower === "text") {
    return "text/plain";
  }
  if (lower === "url") {
    return "text/uri-list";
  }
  return lower;
}

function createDataTransferPolyfill(): DataTransferLike {
  const store = new Map<string, string>();
  const items: DataTransferLike["items"] = {
    get length(): number {
      return store.size;
    },
    add: () => undefined,
    clear: () => {
      store.clear();
    },
    remove: () => undefined,
  };
  return {
    dropEffect: "none",
    effectAllowed: "all",
    files: [],
    items,
    get types(): string[] {
      return Array.from(store.keys());
    },
    setData(format: string, data: string): void {
      store.set(normalizeDataTransferFormat(format), String(data));
    },
    getData(format: string): string {
      return store.get(normalizeDataTransferFormat(format)) ?? "";
    },
    clearData(format?: string): void {
      if (format === undefined) {
        store.clear();
        return;
      }
      store.delete(normalizeDataTransferFormat(format));
    },
    setDragImage: () => undefined,
  };
}

function createSharedDataTransfer(win: DragWindowLike): DataTransferLike {
  const Ctor = win.DataTransfer as (new () => DataTransferLike) | undefined;
  if (typeof Ctor === "function") {
    try {
      const dt = new Ctor();
      dt.effectAllowed = "all";
      return dt;
    } catch {
      // Fall back to portable polyfill when host DataTransfer cannot be constructed.
    }
  }
  return createDataTransferPolyfill();
}

function elementMatchesSimple(el: Element, selector: string): boolean {
  const candidate = el as Element & {
    matches?: (s: string) => boolean;
    classList?: { contains?(name: string): boolean };
    getAttribute?: (name: string) => string | null;
  };
  if (typeof candidate.matches === "function") {
    try {
      return candidate.matches(selector);
    } catch {
      // Ignore selector syntax errors in minimal mocks.
    }
  }
  const attr = candidate.getAttribute?.("draggable");
  if (attr === "true") {
    return true;
  }
  return Boolean(
    candidate.classList?.contains?.("workspace-tab-header") ||
      candidate.classList?.contains?.("nav-file-title") ||
      candidate.classList?.contains?.("nav-folder-title")
  );
}

/**
 * Resolves the draggable HTML5 ancestor for file-explorer items or workspace tabs.
 * Returns null for pointer-driven widgets such as Canvas cards and resize handles.
 */
export function findHtml5DragSource(
  win: DragWindowLike,
  from: DragPoint,
  fromElement?: Element | null
): Element | null {
  const startEl = fromElement ?? elementFromPointSafe(win, from);
  if (!startEl) {
    return null;
  }

  let current: Element | null = startEl;
  for (let depth = 0; current && depth < MAX_ANCESTOR_WALK; depth += 1) {
    const candidate = current as Element & {
      draggable?: unknown;
      getAttribute?: (name: string) => string | null;
      parentElement?: Element | null;
    };
    const explicitAttr = candidate.getAttribute?.("draggable");
    if (candidate.draggable === true || explicitAttr === "true") {
      return current;
    }
    if (explicitAttr !== "false" && elementMatchesSimple(current, HTML5_DRAG_ANCESTOR_SELECTOR)) {
      return current;
    }
    current = candidate.parentElement ?? null;
  }
  return null;
}

function createDragEvent(
  win: DragWindowLike,
  type: string,
  point: DragPoint,
  dataTransfer: DataTransferLike
): Event & { dataTransfer?: DataTransferLike; defaultPrevented: boolean } {
  const init: Record<string, unknown> = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.x,
    clientY: point.y,
    screenX: point.x,
    screenY: point.y,
    view: win,
    dataTransfer,
  };

  type EventCtor = new (t: string, i?: Record<string, unknown>) => Event & {
    dataTransfer?: DataTransferLike;
    clientX?: number;
    clientY?: number;
    screenX?: number;
    screenY?: number;
  };
  const DragCtor = win.DragEvent as EventCtor | undefined;
  const fallbackEventCtor = (win.Event ?? (typeof Event !== "undefined" ? Event : undefined)) as EventCtor;
  const EventCtorFn = typeof DragCtor === "function" ? DragCtor : fallbackEventCtor;

  let ev: Event & {
    dataTransfer?: DataTransferLike;
    clientX?: number;
    clientY?: number;
    screenX?: number;
    screenY?: number;
  };
  try {
    ev = new EventCtorFn(type, init);
  } catch {
    ev = new fallbackEventCtor(type, { bubbles: true, cancelable: true, composed: true });
  }

  if (ev.dataTransfer !== dataTransfer) {
    try {
      Object.defineProperty(ev, "dataTransfer", {
        value: dataTransfer,
        configurable: true,
        enumerable: true,
      });
    } catch {
      ev.dataTransfer = dataTransfer;
    }
  }

  const coordPairs: Array<["clientX" | "clientY" | "screenX" | "screenY", number]> = [
    ["clientX", point.x],
    ["clientY", point.y],
    ["screenX", point.x],
    ["screenY", point.y],
  ];
  for (const [prop, val] of coordPairs) {
    if (ev[prop] !== val) {
      try {
        Object.defineProperty(ev, prop, {
          value: val,
          configurable: true,
          enumerable: true,
        });
      } catch {
        // Ignore read-only properties when host DragEvent already populated them.
      }
    }
  }

  return ev;
}

function dispatchDomEvent(
  target: Element,
  event: Event & { defaultPrevented: boolean }
): boolean {
  if (typeof (target as { dispatchEvent?: unknown }).dispatchEvent !== "function") {
    return false;
  }
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Computes the bounded step count used for both preflight checks and drag dispatch. */
export function computeDragStepCount(
  from: DragPoint,
  to: DragPoint,
  explicitSteps?: number
): number {
  if (typeof explicitSteps === "number" && Number.isFinite(explicitSteps)) {
    return Math.min(MAX_DRAG_STEPS, Math.max(1, Math.round(explicitSteps)));
  }
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.min(MAX_DRAG_STEPS, Math.max(MIN_POINTER_AUTO_STEPS, Math.ceil(distance / POINTER_PIXELS_PER_STEP)));
}

function buildSteps(
  from: DragPoint,
  to: DragPoint,
  fromWin: DragPoint,
  toWin: DragPoint,
  steps: number
): DragStep[] {
  return Array.from({ length: steps }, (_, idx) => {
    const i = idx + 1;
    return {
      css: {
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      },
      win: {
        x: Math.round(fromWin.x + ((toWin.x - fromWin.x) * i) / steps),
        y: Math.round(fromWin.y + ((toWin.y - fromWin.y) * i) / steps),
      },
      isLast: i === steps,
    };
  });
}

async function performHtml5Drag(
  options: PerformDragOptions,
  sourceEl: Element,
  stepPoints: DragStep[]
): Promise<PerformDragResult> {
  const { win, from, to, stepDelayMs = 16, dropSettleMs = 100 } = options;
  const sleepFn = options.sleep ?? ((ms: number) => defaultSleep(win, ms));
  let targetEl =
    options.toElement ??
    elementFromPointSafe(win, to) ??
    win.document.body ??
    win.document.documentElement ??
    sourceEl;

  const dataTransfer = createSharedDataTransfer(win);
  let lastPoint: DragPoint = from;
  let dropped = false;
  let canceled = false;

  options.onStart?.(from);
  options.onBeforeStart?.(from);

  const startPrevented = dispatchDomEvent(
    sourceEl,
    createDragEvent(win, "dragstart", from, dataTransfer)
  );
  if (startPrevented) {
    canceled = true;
    dispatchDomEvent(sourceEl, createDragEvent(win, "dragend", from, dataTransfer));
    options.onComplete?.(from, false);
    return {
      dispatched: true,
      mode: "html5",
      from,
      to,
      steps: stepPoints.length,
      dropped: false,
      canceled: true,
    };
  }

  try {
    for (const step of stepPoints) {
      options.onBeforeStep?.(step.css, step.isLast);
      options.onStep?.(step.css, step.isLast);
      dispatchDomEvent(sourceEl, createDragEvent(win, "drag", step.css, dataTransfer));
      lastPoint = step.css;
      if (stepDelayMs > 0) {
        await sleepFn(stepDelayMs);
      }
    }

    // Re-resolve dynamic drop overlays mounted after dragstart when destination was not forced.
    if (!options.toElement) {
      const liveDropTarget = elementFromPointSafe(win, to);
      if (liveDropTarget) {
        targetEl = liveDropTarget;
      }
    }

    // Revalidate receiver safety after the final awaited step and after each destination handler
    // in case a covering overlay or protected area appeared before dragenter/dragover/drop.
    options.onBeforeStep?.(to, true);
    const enterPrevented = dispatchDomEvent(
      targetEl,
      createDragEvent(win, "dragenter", to, dataTransfer)
    );
    options.onBeforeStep?.(to, true);
    const overPrevented = dispatchDomEvent(
      targetEl,
      createDragEvent(win, "dragover", to, dataTransfer)
    );
    if (overPrevented || enterPrevented) {
      options.onBeforeStep?.(to, true);
      dispatchDomEvent(targetEl, createDragEvent(win, "drop", to, dataTransfer));
      dropped = true;
    }
  } finally {
    dispatchDomEvent(sourceEl, createDragEvent(win, "dragend", lastPoint, dataTransfer));
  }

  options.onComplete?.(to, dropped);
  if (dropSettleMs > 0) {
    await sleepFn(dropSettleMs);
  }
  return {
    dispatched: true,
    mode: "html5",
    from,
    to,
    steps: stepPoints.length,
    dropped,
    canceled,
  };
}

async function performPointerDrag(
  options: PerformDragOptions,
  fromWin: DragPoint,
  stepPoints: DragStep[]
): Promise<PerformDragResult> {
  const { win, wc, from, to, stepDelayMs = 16, dropSettleMs = 100 } = options;
  const sleepFn = options.sleep ?? ((ms: number) => defaultSleep(win, ms));

  let lastWin = fromWin;
  options.onBeforeStart?.(from);
  options.onStart?.(from);
  wc.sendInputEvent({ type: "mouseMove", ...fromWin });
  if (stepDelayMs > 0) {
    // Allow hover/pointerenter handlers to settle before pressing the button.
    await sleepFn(stepDelayMs);
  }
  options.onBeforeStart?.(from);

  let pressed = false;
  try {
    wc.sendInputEvent({
      type: "mouseDown",
      ...fromWin,
      button: "left",
      clickCount: 1,
      modifiers: ["leftButtonDown"],
    });
    pressed = true;
    if (stepDelayMs > 0) {
      // Allow pointerdown capture listeners to attach before moving off the start point.
      await sleepFn(stepDelayMs);
    }
    for (const step of stepPoints) {
      options.onBeforeStep?.(step.css, step.isLast);
      options.onStep?.(step.css, step.isLast);
      wc.sendInputEvent({
        type: "mouseMove",
        ...step.win,
        modifiers: ["leftButtonDown"],
      });
      lastWin = step.win;
      if (stepDelayMs > 0) {
        await sleepFn(stepDelayMs);
      }
    }
  } finally {
    if (pressed) {
      try {
        wc.sendInputEvent({ type: "mouseUp", ...lastWin, button: "left", clickCount: 1 });
      } catch {
        // Ignore mouseUp cleanup errors when WebContents is unavailable.
      }
    }
  }

  options.onComplete?.(to, true);
  if (dropSettleMs > 0) {
    await sleepFn(dropSettleMs);
  }
  return {
    dispatched: true,
    mode: "pointer",
    from,
    to,
    steps: stepPoints.length,
    dropped: true,
    canceled: false,
  };
}

/**
 * Performs a drag gesture matching the target's input model:
 * HTML5 dragstart/dragenter/dragover/drop/dragend with one shared DataTransfer for
 * draggable elements (file explorer items, tab headers), or smooth Electron mouse
 * moves with leftButtonDown state for pointer-event surfaces (Canvas cards, handles).
 */
export async function performDrag(options: PerformDragOptions): Promise<PerformDragResult> {
  const steps = computeDragStepCount(options.from, options.to, options.steps);
  const fromWin = options.toWindowPoint(options.from);
  const toWin = options.toWindowPoint(options.to);
  const stepPoints = buildSteps(options.from, options.to, fromWin, toWin, steps);

  const html5Source = findHtml5DragSource(options.win, options.from, options.fromElement);
  if (html5Source) {
    return performHtml5Drag(options, html5Source, stepPoints);
  }
  return performPointerDrag(options, fromWin, stepPoints);
}
