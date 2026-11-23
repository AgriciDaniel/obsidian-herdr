// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Daniel Agrici. Pure anchor math, pill layout, and label helpers for AgentCursorOverlay.

import type {
  CursorCodeMirrorLike,
  DocumentCursorContext,
  NoteDocChange,
} from "./types";

export const MAX_DOC_SNAPSHOT_CHARS = 100_000;
export const HUE_BUCKETS = 12;
export const PILL_DEFAULT_X = 10;
export const PILL_DEFAULT_Y = 5;
export const PILL_ROW_STEP = 20;
export const PILL_PAD = 4;

export interface PillRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DocSnapshot {
  docRef: unknown;
  docSnapshot: string | null;
  docLength: number | null;
}

export interface PillLayoutInput {
  targetX: number;
  targetY: number;
  bounds: PillRect;
  clampToBounds: boolean;
  width: number;
  height: number;
}

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

const HERDR_PANE_ID_RE = /^(?:w\d+:p[0-9a-zA-Z]+|p\d+|pane[-_][0-9a-zA-Z_-]+|markdown-pane-\d+)$/i;

export function normalizeHonestAction(
  source: "move" | "click" | "typing",
  action?: string
): { text: string; isTyping: boolean } {
  if (source === "typing") {
    return { text: "typing", isTyping: true };
  }
  const trimmed = action?.trim() ?? "";
  if (source === "click") {
    if (
      !trimmed ||
      trimmed === "click" ||
      trimmed === "clicking" ||
      trimmed === "insert_line" ||
      trimmed === "drag"
    ) {
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

export function isImmutableCmDoc(doc: unknown): boolean {
  return Boolean(
    doc &&
      typeof doc === "object" &&
      typeof (doc as { sliceString?: unknown }).sliceString === "function"
  );
}

export function readDocSnapshot(
  cm: CursorCodeMirrorLike | null | undefined,
  prev?: { docRef?: unknown; docSnapshot: string | null; docLength?: number | null } | null
): DocSnapshot {
  const doc = cm?.state?.doc;
  if (!doc) {
    return {
      docRef: prev?.docRef ?? null,
      docSnapshot: prev?.docSnapshot ?? null,
      docLength: prev?.docLength ?? null,
    };
  }
  const docLen = typeof doc.length === "number" && Number.isFinite(doc.length) ? doc.length : null;
  if (docLen !== null && docLen > MAX_DOC_SNAPSHOT_CHARS) {
    return { docRef: doc, docSnapshot: null, docLength: docLen };
  }
  if (
    prev &&
    isImmutableCmDoc(doc) &&
    prev.docRef === doc &&
    prev.docSnapshot !== null &&
    (docLen === null || docLen === prev.docSnapshot.length)
  ) {
    return {
      docRef: doc,
      docSnapshot: prev.docSnapshot,
      docLength: docLen ?? prev.docSnapshot.length,
    };
  }
  const text = doc.toString();
  return { docRef: doc, docSnapshot: text, docLength: docLen ?? text.length };
}

export function mapAnchoredPos(
  oldText: string | null,
  newText: string | null,
  pos: number,
  change?: NoteDocChange,
  newLenOverride?: number | null
): number {
  const newLen = newText?.length ?? newLenOverride ?? null;
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

export function hasDocumentAnchorTarget(docContext: DocumentCursorContext): boolean {
  return Boolean(
    docContext.cm ||
      (typeof docContext.notePath === "string" && docContext.notePath.trim() !== "") ||
      (typeof docContext.pos === "number" && Number.isFinite(docContext.pos)) ||
      (typeof docContext.view?.file?.path === "string" && docContext.view.file.path.trim() !== "") ||
      docContext.getLeafNotePath
  );
}

export function formatCssPx(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${Object.is(rounded, -0) ? 0 : rounded}px`;
}

/** Returns the text caret anchor at the left edge and vertical midpoint of the line box. */
export function caretPointFromCoords(coords: {
  left: number;
  top: number;
  bottom?: number;
}): { x: number; y: number } {
  const midY =
    typeof coords.bottom === "number" && Number.isFinite(coords.bottom)
      ? (coords.top + coords.bottom) / 2
      : coords.top;
  return {
    x: coords.left,
    y: midY,
  };
}

export function hashCallerBucket(caller: string): number {
  let hash = 2166136261;
  for (let i = 0; i < caller.length; i += 1) {
    hash ^= caller.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % HUE_BUCKETS;
}

export function rectsOverlap(a: PillRect, b: PillRect, pad = PILL_PAD): boolean {
  return (
    a.left < b.right + pad &&
    a.right + pad > b.left &&
    a.top < b.bottom + pad &&
    a.bottom + pad > b.top
  );
}

export function isHerdrPaneId(value: string): boolean {
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

/** Computes non-overlapping label pill offsets in memory without touching DOM state. */
export function resolvePillOffsets(
  items: readonly PillLayoutInput[]
): Array<{ x: number; y: number }> {
  const placed: PillRect[] = [];
  const offsets: Array<{ x: number; y: number }> = [];

  for (const { targetX, targetY, bounds, clampToBounds, width, height } of items) {
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
        left: targetX + ox,
        top: targetY + oy,
        right: targetX + ox + width,
        bottom: targetY + oy + height,
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
        left: targetX + chosenX,
        top: targetY + chosenY,
        right: targetX + chosenX + width,
        bottom: targetY + chosenY + height,
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

    if (clampToBounds) {
      const minRelX = bounds.left + 2 - targetX;
      const maxRelX = bounds.right - 2 - width - targetX;
      const minRelY = bounds.top + 2 - targetY;
      const maxRelY = bounds.bottom - 2 - height - targetY;
      if (maxRelX >= minRelX) {
        chosenX = Math.max(minRelX, Math.min(maxRelX, chosenX));
      }
      if (maxRelY >= minRelY) {
        chosenY = Math.max(minRelY, Math.min(maxRelY, chosenY));
      }
    }

    offsets.push({ x: Math.round(chosenX), y: Math.round(chosenY) });
    placed.push({
      left: targetX + chosenX,
      top: targetY + chosenY,
      right: targetX + chosenX + width,
      bottom: targetY + chosenY + height,
    });
  }

  return offsets;
}
