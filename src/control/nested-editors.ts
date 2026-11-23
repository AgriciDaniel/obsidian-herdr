// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Daniel Agrici. Nested editor helpers for UI control.

/** Minimal CodeMirror EditorView shape needed for nested editor resolution and ownership. */
export interface NestedCodeMirrorView {
  dom?: Element | null;
  contentDOM?: Element | null;
  scrollDOM?: HTMLElement | null;
  state?: {
    doc?: {
      length: number;
      lines: number;
      toString(): string;
      line(n: number): { from: number; to: number; number: number; text: string };
    };
    selection?: { main?: { head?: number; anchor?: number; from?: number; to?: number } };
  };
  coordsAtPos?(pos: number, side?: number): { left: number; top: number; right?: number; bottom?: number } | null;
  posAtCoords?(coords: { x: number; y: number }): number | null;
  dispatch?(spec: unknown): void;
  focus?(): void;
}

export type NestedEditableKind =
  | "table-cell"
  | "property-key"
  | "property-value"
  | "inline-title"
  | "file-explorer-rename"
  | "canvas-card"
  | "bases-cell";

export interface BasesRowCandidate {
  kind: "path" | "href";
  value: string;
}

export interface BasesRowPathResolverOptions {
  resolvePath?: (path: string) => string | null | undefined;
  resolveHref?: (href: string) => string | null | undefined;
}

export interface NestedCodeMirrorResolution<T extends NestedCodeMirrorView = NestedCodeMirrorView> {
  cm: T | null;
  isNested: boolean;
  inTableCell: boolean;
  cellEl: Element | null;
}

export interface NestedCommitResult {
  committed: boolean;
  kind: NestedEditableKind | null;
  blurred: boolean;
}

const TABLE_CELL_SELECTOR = "td, th";
const TABLE_WIDGET_SELECTOR = ".cm-table-widget";
const PROPERTY_KEY_SELECTOR =
  '.metadata-property-key-input, .metadata-property-key input, .metadata-property-key [contenteditable="true"], .metadata-property-key [contenteditable]';
const PROPERTY_VALUE_SELECTOR =
  '.metadata-input-longtext, .metadata-input-text, .metadata-input-number, .metadata-input, .multi-select-input, .metadata-property-value [contenteditable="true"], .metadata-property-value [contenteditable], .metadata-property-value input, .metadata-property-value textarea';
const RENAME_ELEMENT_SELECTOR = ".is-being-renamed, .inline-title";
const CANVAS_NODE_SELECTOR = ".canvas-node";
const CANVAS_EDITING_NODE_SELECTOR = ".canvas-node.is-editing";
const BASES_ROW_SELECTOR = ".bases-tr, .bases-table-row, [role='row']";
const BASES_CONTAINER_SELECTOR = ".bases-tbody, .bases-tr, .bases-td, .bases-table-cell";
const BASES_LINK_SELECTOR = "[data-path], [data-file], [data-file-path], [data-href], a.internal-link";
const EDITABLE_TARGET_SELECTOR =
  '.cm-content[contenteditable="true"], .cm-content, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable], textarea, input';

function closestSafe(el: Element | null | undefined, selector: string): Element | null {
  if (!el || typeof el.closest !== "function") {
    return null;
  }
  try {
    return el.closest(selector);
  } catch {
    return null;
  }
}

function matchesSafe(el: Element | null | undefined, selector: string): boolean {
  if (!el || typeof el.matches !== "function") {
    return false;
  }
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

function containsSafe(parent: Element | null | undefined, child: Element | null | undefined): boolean {
  if (!parent || !child) {
    return false;
  }
  if (parent === child) {
    return true;
  }
  if (typeof parent.contains === "function") {
    try {
      return parent.contains(child);
    } catch {
      return false;
    }
  }
  return false;
}

function isConnectedSafe(el: Element | null | undefined): boolean {
  return Boolean(el && (el as { isConnected?: boolean }).isConnected !== false);
}

function queryAllSafe(root: Element | Document | null | undefined, selector: string): Element[] {
  if (!root) {
    return [];
  }
  try {
    return Array.from(root.querySelectorAll?.(selector) ?? []);
  } catch {
    return [];
  }
}

function getImmediateHostFrame(el: Element | null | undefined): Element | null {
  if (!el) {
    return null;
  }
  try {
    const doc = (el as { ownerDocument?: Document | null }).ownerDocument ?? null;
    const frame = doc?.defaultView?.frameElement ?? null;
    return frame && typeof frame.tagName === "string" ? frame : null;
  } catch {
    return null;
  }
}

function getIframeDocumentSafe(el: Element | null | undefined): Document | null {
  if (!el || String((el as { tagName?: string }).tagName ?? "").toUpperCase() !== "IFRAME") {
    return null;
  }
  try {
    return (el as { contentDocument?: Document | null }).contentDocument ?? null;
  } catch {
    return null;
  }
}

/**
 * Walks up frameElement links so elements inside a hosted iframe map back to their
 * enclosing element in the top Obsidian document for containment and leaf resolution.
 */
export function resolveTopLevelElement(el: Element | null | undefined): Element | null {
  if (!el) {
    return null;
  }
  let cur: Element = el;
  for (let depth = 0; depth < 8; depth += 1) {
    const frame = getImmediateHostFrame(cur);
    if (!frame || frame === cur) {
      break;
    }
    cur = frame;
  }
  return cur;
}

/**
 * Resolves the deepest active element across Shadow DOM roots and same-origin
 * iframe documents (such as Obsidian Canvas card editors).
 */
export function getDeepActiveElement(doc: Document | null | undefined): Element | null {
  let el: Element | null = doc?.activeElement ?? null;
  for (let depth = 0; depth < 16 && el; depth += 1) {
    const shadowNext = (el as Element & { shadowRoot?: { activeElement?: Element | null } | null })
      .shadowRoot?.activeElement;
    if (shadowNext && shadowNext !== el) {
      el = shadowNext;
      continue;
    }
    const frameDoc = getIframeDocumentSafe(el);
    const frameNext = frameDoc?.activeElement ?? null;
    const skipFrameBody =
      frameNext === frameDoc?.body &&
      !(frameDoc?.body as { isContentEditable?: boolean } | null | undefined)?.isContentEditable;
    if (frameNext && frameNext !== el && !skipFrameBody) {
      el = frameNext;
      continue;
    }
    break;
  }
  return el;
}

/**
 * Resolves the enclosing .canvas-node for an element, including elements inside
 * a Canvas card editor iframe or the selected node for a .canvas-menu action.
 */
export function findCanvasCardNode(el: Element | null | undefined): Element | null {
  const topEl = resolveTopLevelElement(el);
  if (!topEl) {
    return null;
  }
  const direct = closestSafe(topEl, CANVAS_NODE_SELECTOR);
  if (direct) {
    return direct;
  }
  const menu = closestSafe(topEl, ".canvas-menu");
  if (menu) {
    const wrapper = closestSafe(menu, ".canvas-wrapper");
    if (wrapper) {
      return (
        queryAllSafe(wrapper, `${CANVAS_EDITING_NODE_SELECTOR}, .canvas-node.is-focused`)[0] ?? null
      );
    }
  }
  return null;
}

/** True when el is a Canvas card currently in .is-editing mode (or inside its iframe). */
export function isCanvasCardEditing(el: Element | null | undefined): boolean {
  const card = findCanvasCardNode(el);
  return Boolean(card && isConnectedSafe(card) && matchesSafe(card, CANVAS_EDITING_NODE_SELECTOR));
}

function isCanvasEditableCandidate(el: Element | null | undefined): boolean {
  if (!el || !isConnectedSafe(el)) {
    return false;
  }
  if (matchesSafe(el, EDITABLE_TARGET_SELECTOR)) {
    return true;
  }
  return Boolean((el as { isContentEditable?: boolean }).isContentEditable);
}

/**
 * Finds the mounted editable target inside an editing Canvas card, checking both
 * embedded same-origin iframe documents and direct inline descendants.
 */
export function findCanvasCardEditorTarget(cardOrEl: Element | null | undefined): Element | null {
  const card = findCanvasCardNode(cardOrEl);
  if (!card || !matchesSafe(card, CANVAS_EDITING_NODE_SELECTOR)) {
    return null;
  }
  for (const frame of queryAllSafe(card, "iframe")) {
    const innerDoc = getIframeDocumentSafe(frame);
    if (!innerDoc) {
      continue;
    }
    if (isCanvasEditableCandidate(innerDoc.activeElement)) {
      return innerDoc.activeElement;
    }
    for (const candidate of queryAllSafe(innerDoc.body ?? innerDoc, EDITABLE_TARGET_SELECTOR)) {
      if (isCanvasEditableCandidate(candidate)) {
        return candidate;
      }
    }
  }
  for (const candidate of queryAllSafe(card, EDITABLE_TARGET_SELECTOR)) {
    if (isCanvasEditableCandidate(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolves the enclosing Obsidian Bases data row for an element, supporting both
 * .bases-tr rows and direct child rows inside .bases-tbody.
 */
export function resolveBasesRowElement(el: Element | null | undefined): Element | null {
  if (!el) {
    return null;
  }
  const explicit = closestSafe(el, BASES_ROW_SELECTOR);
  if (explicit && !closestSafe(explicit, ".bases-thead")) {
    return explicit;
  }
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < 20; depth += 1) {
    const parentEl: Element | null = (cur as { parentElement?: Element | null }).parentElement ?? null;
    if (parentEl && matchesSafe(parentEl, ".bases-tbody")) {
      return cur;
    }
    cur = parentEl;
  }
  return null;
}

function collectRowCandidatesFromNodes(
  nodes: readonly Element[],
  out: BasesRowCandidate[],
  seen: Set<string>
): void {
  const pushCandidate = (kind: "path" | "href", raw: string | null): void => {
    const value = raw?.trim() ?? "";
    if (!value) {
      return;
    }
    const key = `${kind}:${value}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ kind, value });
    }
  };
  for (const node of nodes) {
    if (typeof node.getAttribute !== "function") {
      continue;
    }
    for (const attr of ["data-path", "data-file", "data-file-path"]) {
      pushCandidate("path", node.getAttribute(attr));
    }
    pushCandidate("href", node.getAttribute("data-href"));
  }
}

/**
 * Extracts link and file-path candidates from a Bases row DOM element, including
 * <span data-href="..."> cells and standard data-path/data-file attributes.
 */
export function extractBasesRowCandidates(el: Element | null | undefined): BasesRowCandidate[] {
  const row = resolveBasesRowElement(el);
  if (!row) {
    return [];
  }
  const seen = new Set<string>();
  const out: BasesRowCandidate[] = [];
  const nameCell =
    queryAllSafe(row, '.bases-td[data-property="file.name"]')[0] ??
    (row as { firstElementChild?: Element | null }).firstElementChild ??
    null;
  const primaryNodes = nameCell ? [nameCell, ...queryAllSafe(nameCell, BASES_LINK_SELECTOR)] : [];
  const rowNodes = [row, ...queryAllSafe(row, BASES_LINK_SELECTOR)];
  collectRowCandidatesFromNodes(primaryNodes, out, seen);
  collectRowCandidatesFromNodes(rowNodes, out, seen);
  return out;
}

function resolveBasesCandidates(
  candidates: readonly BasesRowCandidate[],
  options?: BasesRowPathResolverOptions
): Set<string> {
  const resolved = new Set<string>();
  for (const candidate of candidates) {
    let target: string | null | undefined = null;
    if (candidate.kind === "path") {
      target = options?.resolvePath ? options.resolvePath(candidate.value) : candidate.value;
    } else if (options?.resolveHref) {
      target = options.resolveHref(candidate.value);
    } else if (candidate.value.endsWith(".md") && options?.resolvePath) {
      target = options.resolvePath(candidate.value);
    }
    if (target) {
      resolved.add(target);
    }
  }
  return resolved;
}

/**
 * Resolves an unambiguous note file path from a Bases cell or row element using
 * caller-supplied path/linkpath resolvers, returning null when missing or ambiguous.
 */
export function resolveBasesRowFilePath(
  el: Element | null | undefined,
  options?: BasesRowPathResolverOptions
): string | null {
  const row = resolveBasesRowElement(el);
  if (!row) {
    return null;
  }
  const explicitNameCell = queryAllSafe(row, '.bases-td[data-property="file.name"]')[0] ?? null;
  if (explicitNameCell) {
    const primarySeen = new Set<string>();
    const primaryOut: BasesRowCandidate[] = [];
    const primaryNodes = [explicitNameCell, ...queryAllSafe(explicitNameCell, BASES_LINK_SELECTOR)];
    collectRowCandidatesFromNodes(primaryNodes, primaryOut, primarySeen);
    const primaryResolved = resolveBasesCandidates(primaryOut, options);
    if (primaryResolved.size === 1) {
      return [...primaryResolved][0];
    }
  }
  const candidates = extractBasesRowCandidates(el);
  if (candidates.length === 0) {
    return null;
  }
  const resolved = resolveBasesCandidates(candidates, options);
  return resolved.size === 1 ? [...resolved][0] : null;
}

function isPlainNativeInput(el: Element | null | undefined): boolean {
  if (!el) {
    return false;
  }
  const tag = typeof el.tagName === "string" ? el.tagName.toLowerCase() : "";
  return tag === "input" || tag === "textarea";
}

/** Extracts a valid structural CodeMirror EditorView reference from a candidate object. */
export function extractNestedCodeMirrorView<T extends NestedCodeMirrorView = NestedCodeMirrorView>(
  candidate: unknown
): T | null {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const view = candidate as NestedCodeMirrorView;
  if (
    typeof view.coordsAtPos === "function" &&
    typeof view.state?.selection?.main?.head === "number"
  ) {
    return view as T;
  }
  return null;
}

function extractCmFromDomNode<T extends NestedCodeMirrorView>(node: Element): T | null {
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
    const view = extractNestedCodeMirrorView<T>(candidate);
    if (view) {
      return view;
    }
  }
  return null;
}

/** Returns the enclosing td/th inside a Live Preview .cm-table-widget, or null. */
export function findTableCellContainer(el: Element | null | undefined): Element | null {
  const cell = closestSafe(el, TABLE_CELL_SELECTOR);
  if (!cell || !closestSafe(cell, TABLE_WIDGET_SELECTOR)) {
    return null;
  }
  return cell;
}

/** True when an element sits inside an editable Live Preview .cm-table-widget cell. */
export function isInTableCellWidget(el: Element | null | undefined): boolean {
  return findTableCellContainer(el) !== null;
}

/**
 * Checks whether a CodeMirror view strictly owns the target element without leaking
 * ownership from an outer note CodeMirror into a nested cell or sub-editor.
 */
export function cmOwnsElementStrict(
  view: NestedCodeMirrorView,
  el: Element | null | undefined
): boolean {
  if (!el) {
    return false;
  }
  const root = view.contentDOM ?? view.dom ?? null;
  if (!root) {
    return !isPlainNativeInput(el);
  }
  if (!containsSafe(root, el)) {
    return false;
  }

  const cellEl = findTableCellContainer(el);
  if (cellEl && !containsSafe(cellEl, root)) {
    return false;
  }

  const elEditor = closestSafe(el, ".cm-editor");
  const viewEditor = closestSafe(root, ".cm-editor") ?? (matchesSafe(root, ".cm-editor") ? root : null);
  if (elEditor && viewEditor && elEditor !== viewEditor) {
    return false;
  }
  return true;
}

function resolveCodeMirrorFromSubtree<T extends NestedCodeMirrorView>(
  el: Element,
  stopAt: Element | null,
  outerCm: T | null
): T | null {
  let cur: Element | null = el;
  while (cur) {
    const candidate = extractCmFromDomNode<T>(cur);
    if (candidate && candidate !== outerCm && cmOwnsElementStrict(candidate, el)) {
      return candidate;
    }
    if (stopAt && cur === stopAt) {
      break;
    }
    cur = cur.parentElement ?? null;
  }
  return null;
}

/**
 * Resolves the innermost CodeMirror view owning an element. For elements inside a
 * Live Preview table widget cell or Canvas card editor, never falls back to the outer note editor.
 */
export function resolveNestedCodeMirror<T extends NestedCodeMirrorView = NestedCodeMirrorView>(
  el: Element | null | undefined,
  options?: { outerCm?: T | null }
): NestedCodeMirrorResolution<T> {
  if (!el) {
    return { cm: null, isNested: false, inTableCell: false, cellEl: null };
  }
  const outerCm = options?.outerCm ?? null;
  const cellEl = findTableCellContainer(el);

  if (cellEl) {
    const direct = resolveCodeMirrorFromSubtree(el, cellEl, outerCm);
    if (direct) {
      return { cm: direct, isNested: true, inTableCell: true, cellEl };
    }
    for (const desc of queryAllSafe(cellEl, ".cm-editor, .cm-content, .cm-scroller")) {
      const candidate = extractCmFromDomNode<T>(desc);
      if (candidate && candidate !== outerCm) {
        return { cm: candidate, isNested: true, inTableCell: true, cellEl };
      }
    }
    return { cm: null, isNested: false, inTableCell: true, cellEl };
  }

  const canvasNode = findCanvasCardNode(el);
  if (canvasNode) {
    const direct = resolveCodeMirrorFromSubtree(el, canvasNode, outerCm);
    if (direct) {
      return { cm: direct, isNested: true, inTableCell: false, cellEl: null };
    }
    const cardTarget = findCanvasCardEditorTarget(canvasNode);
    if (cardTarget) {
      const targetCm = resolveCodeMirrorFromSubtree(cardTarget, canvasNode, outerCm);
      if (targetCm) {
        return { cm: targetCm, isNested: true, inTableCell: false, cellEl: null };
      }
    }
    return { cm: null, isNested: true, inTableCell: false, cellEl: null };
  }

  let cur: Element | null = el;
  while (cur) {
    const candidate = extractCmFromDomNode<T>(cur);
    if (candidate && cmOwnsElementStrict(candidate, el)) {
      const elEditor = closestSafe(el, ".cm-editor");
      const parentEditor = elEditor?.parentElement
        ? closestSafe(elEditor.parentElement, ".cm-editor")
        : null;
      const isNested = Boolean(parentEditor || (outerCm && candidate !== outerCm));
      return { cm: candidate, isNested, inTableCell: false, cellEl: null };
    }
    cur = cur.parentElement ?? null;
  }

  return { cm: null, isNested: false, inTableCell: false, cellEl: null };
}

/** True when cm is a distinct nested editor inside outerLeafCm or a table widget. */
export function isNestedCodeMirrorOwnership(
  cm: NestedCodeMirrorView | null | undefined,
  outerLeafCm: NestedCodeMirrorView | null | undefined
): boolean {
  if (!cm || !outerLeafCm || cm === outerLeafCm) {
    return false;
  }
  const innerDom = cm.contentDOM ?? cm.dom ?? null;
  const outerDom = outerLeafCm.contentDOM ?? outerLeafCm.dom ?? null;
  return containsSafe(outerDom, innerDom) || isInTableCellWidget(innerDom);
}

/** Validates that a nested CodeMirror instance remains mounted and focused on the same editor. */
export function assertNestedCodeMirrorIntact(
  cm: NestedCodeMirrorView,
  liveFocusEl: Element | null | undefined,
  progress: string
): { ok: true } | { ok: false; reason: string } {
  const root = cm.contentDOM ?? cm.dom ?? null;
  if (root && !isConnectedSafe(root)) {
    return { ok: false, reason: `${progress}: nested editor instance was unmounted.` };
  }
  if (liveFocusEl && isConnectedSafe(liveFocusEl) && !cmOwnsElementStrict(cm, liveFocusEl)) {
    return { ok: false, reason: `${progress}: focus moved away from the nested editor.` };
  }
  return { ok: true };
}

function isBasesEditableControl(el: Element | null | undefined): boolean {
  if (!el || !isConnectedSafe(el)) {
    return false;
  }
  const inBasesCell =
    Boolean(closestSafe(el, BASES_CONTAINER_SELECTOR)) || Boolean(resolveBasesRowElement(el));
  if (!inBasesCell) {
    return false;
  }
  return (
    isPlainNativeInput(el) ||
    Boolean((el as { isContentEditable?: boolean }).isContentEditable) ||
    Boolean(closestSafe(el, '[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable], input, textarea'))
  );
}

/** Classifies an element into one of Obsidian's nested editable control surfaces. */
export function classifyNestedEditable(el: Element | null | undefined): NestedEditableKind | null {
  if (!el) {
    return null;
  }
  if (closestSafe(el, ".is-being-renamed")) {
    return "file-explorer-rename";
  }
  if (closestSafe(el, ".inline-title")) {
    return "inline-title";
  }
  if (
    isCanvasCardEditing(el) &&
    (matchesSafe(el, "iframe") || isCanvasEditableCandidate(el) || Boolean(getImmediateHostFrame(el)))
  ) {
    return "canvas-card";
  }
  if (closestSafe(el, PROPERTY_KEY_SELECTOR)) {
    return "property-key";
  }
  if (closestSafe(el, PROPERTY_VALUE_SELECTOR)) {
    return "property-value";
  }
  if (isBasesEditableControl(el)) {
    return "bases-cell";
  }
  if (isInTableCellWidget(el)) {
    return "table-cell";
  }
  return null;
}

/** Locates the sibling property value input or editable element in the same .metadata-property row. */
export function findPropertyValueInputForKey(
  keyEl: Element | null | undefined
): HTMLElement | null {
  const row = closestSafe(keyEl, ".metadata-property");
  if (!row) {
    return null;
  }
  for (const candidate of queryAllSafe(row, PROPERTY_VALUE_SELECTOR)) {
    if (isConnectedSafe(candidate)) {
      return candidate as HTMLElement;
    }
  }
  return null;
}

function dispatchSimpleEvent(
  el: Element,
  win: Window,
  ctorName: "Event" | "InputEvent" | "FocusEvent" | "KeyboardEvent",
  type: string,
  init: Record<string, unknown>,
  fallbackWin?: Window
): void {
  const target = el as unknown as { dispatchEvent?: (event: unknown) => boolean };
  if (typeof target.dispatchEvent !== "function") {
    return;
  }
  const winRecord = win as unknown as Record<string, unknown>;
  const fallbackRecord = fallbackWin as unknown as Record<string, unknown> | undefined;
  const Ctor = (
    typeof winRecord[ctorName] === "function"
      ? winRecord[ctorName]
      : fallbackRecord && typeof fallbackRecord[ctorName] === "function"
        ? fallbackRecord[ctorName]
        : undefined
  ) as (new (t: string, i: Record<string, unknown>) => unknown) | undefined;
  const fallbackEvent = { type, ...init };
  const event = typeof Ctor === "function" ? new Ctor(type, init) : fallbackEvent;
  target.dispatchEvent(event);
}

/**
 * Commits edits in properties panel inputs (.metadata-input-longtext, key inputs),
 * .inline-title, or .is-being-renamed using Obsidian-compatible input/change/Enter/blur semantics.
 */
export function commitNestedEditor(
  el: Element | null | undefined,
  win: Window,
  options?: { triggerEnter?: boolean; triggerBlur?: boolean; text?: string }
): NestedCommitResult {
  const kind = classifyNestedEditable(el);
  if (
    !el ||
    !kind ||
    kind === "table-cell" ||
    !isConnectedSafe(el)
  ) {
    return { committed: false, kind: null, blurred: false };
  }
  const targetEl =
    kind === "canvas-card" && matchesSafe(el, "iframe")
      ? (findCanvasCardEditorTarget(el) ?? el)
      : el;
  const eventWin =
    ((targetEl as { ownerDocument?: Document | null }).ownerDocument?.defaultView as
      | Window
      | null
      | undefined) ?? win;

  let sawBlur = false;
  let sawFocusOut = false;
  const onBlur = (): void => {
    sawBlur = true;
  };
  const onFocusOut = (): void => {
    sawFocusOut = true;
  };
  const listenerTarget = targetEl as unknown as {
    addEventListener?: (t: string, fn: () => void, opts?: { once?: boolean }) => void;
    removeEventListener?: (t: string, fn: () => void) => void;
  };
  listenerTarget.addEventListener?.("blur", onBlur, { once: true });
  listenerTarget.addEventListener?.("focusout", onFocusOut, { once: true });

  let blurred = false;
  try {
    dispatchSimpleEvent(targetEl, eventWin, "InputEvent", "input", {
      bubbles: true,
      inputType: "insertText",
      data: options?.text ?? null,
    }, win);
    dispatchSimpleEvent(targetEl, eventWin, "Event", "change", { bubbles: true }, win);

    if (options?.triggerEnter) {
      const enterInit = {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      };
      dispatchSimpleEvent(targetEl, eventWin, "KeyboardEvent", "keydown", enterInit, win);
      dispatchSimpleEvent(targetEl, eventWin, "KeyboardEvent", "keyup", enterInit, win);
    }

    const shouldBlur = options?.triggerBlur !== false;
    if (shouldBlur) {
      const ownerDoc = (targetEl as { ownerDocument?: Document | null }).ownerDocument ?? win.document;
      const stillFocused = ownerDoc?.activeElement === targetEl;
      if ((!sawBlur || !sawFocusOut) && (stillFocused || (!sawBlur && !sawFocusOut))) {
        const htmlEl = targetEl as HTMLElement;
        if (typeof htmlEl.blur === "function") {
          htmlEl.blur();
        }
      }
      if (!sawFocusOut) {
        dispatchSimpleEvent(targetEl, eventWin, "FocusEvent", "focusout", { bubbles: true }, win);
      }
      if (!sawBlur) {
        dispatchSimpleEvent(targetEl, eventWin, "FocusEvent", "blur", { bubbles: false }, win);
      }
      blurred = true;
    } else {
      blurred = sawBlur || sawFocusOut;
    }
  } finally {
    listenerTarget.removeEventListener?.("blur", onBlur);
    listenerTarget.removeEventListener?.("focusout", onFocusOut);
  }

  return { committed: true, kind, blurred };
}

interface CanvasNodeChildLike {
  data?: string;
  editor?: { getValue?: () => string; cm?: NestedCodeMirrorView } | null;
  getViewData?: () => string;
  save?: (data?: string, triggerSave?: boolean) => void;
}

interface CanvasNodeLike {
  id?: string;
  nodeEl?: Element | null;
  isEditing?: boolean;
  child?: CanvasNodeChildLike | null;
  setText?: (text: string) => void;
}

interface CanvasViewLike {
  canvas?: {
    nodes?: Iterable<CanvasNodeLike> | Map<string, CanvasNodeLike> | null;
  } | null;
}

function collectCanvasNodes(view: CanvasViewLike | null | undefined): CanvasNodeLike[] {
  const nodes = view?.canvas?.nodes;
  if (!nodes) {
    return [];
  }
  if (nodes instanceof Map) {
    return Array.from(nodes.values());
  }
  if (typeof nodes[Symbol.iterator] === "function") {
    return Array.from(nodes);
  }
  return [];
}

function findMatchingCanvasModelNode(
  nodes: readonly CanvasNodeLike[],
  cardEl: Element | null,
  topEl: Element | null
): CanvasNodeLike | null {
  if (cardEl || topEl) {
    for (const node of nodes) {
      if (node.nodeEl && ((cardEl && (node.nodeEl === cardEl || containsSafe(node.nodeEl, cardEl))) || (topEl && containsSafe(node.nodeEl, topEl)))) {
        return node;
      }
    }
  }
  const cardId =
    cardEl && typeof cardEl.getAttribute === "function"
      ? (cardEl.getAttribute("data-node-id") ?? cardEl.getAttribute("data-id") ?? "").trim()
      : "";
  if (cardId) {
    for (const node of nodes) {
      if (node.id === cardId) {
        return node;
      }
    }
  }
  const editingNodes = nodes.filter((node) => node.isEditing === true);
  return editingNodes.length === 1 ? editingNodes[0] : null;
}

/**
 * Flushes an uncommitted Canvas text-card child editor buffer into the owning
 * Canvas node model (via node.child.save(text, true) or node.setText) without requiring blur.
 */
export function commitCanvasCardModel(
  owningView: unknown,
  targetElement?: Element | null,
  cm?: NestedCodeMirrorView | null
): boolean {
  const nodes = collectCanvasNodes(owningView as CanvasViewLike | null | undefined);
  if (nodes.length === 0) {
    return false;
  }
  const cardEl = findCanvasCardNode(targetElement);
  const topEl = resolveTopLevelElement(targetElement);
  const node = findMatchingCanvasModelNode(nodes, cardEl, topEl);
  if (!node) {
    return false;
  }
  const child = node.child ?? null;
  const resolvedCm =
    cm ??
    child?.editor?.cm ??
    resolveNestedCodeMirror(targetElement ?? findCanvasCardEditorTarget(cardEl)).cm ??
    null;
  let liveText: string | null = null;
  if (resolvedCm?.state?.doc && typeof resolvedCm.state.doc.toString === "function") {
    liveText = resolvedCm.state.doc.toString();
  } else if (typeof child?.editor?.getValue === "function") {
    liveText = child.editor.getValue();
  } else if (typeof child?.getViewData === "function") {
    liveText = child.getViewData();
  } else if (typeof child?.data === "string") {
    liveText = child.data;
  }
  if (typeof liveText !== "string") {
    return false;
  }
  if (typeof child?.save === "function") {
    child.save(liveText, true);
    return true;
  }
  if (typeof node.setText === "function") {
    node.setText(liveText);
    return true;
  }
  return false;
}

/** True when el is inside a connected file-explorer rename box or inline note title. */
export function isActiveRenameElement(el: Element | null | undefined): boolean {
  return Boolean(isConnectedSafe(el) && closestSafe(el, RENAME_ELEMENT_SELECTOR));
}

/**
 * True when focus restoration must preserve an active nested target
 * (.is-being-renamed, .inline-title, editing Canvas card, or Bases editable cell)
 * instead of restoring prior editor focus.
 */
export function shouldPreserveNestedFocus(
  beforeEl: Element | null | undefined,
  afterEl: Element | null | undefined
): boolean {
  if (!afterEl || !isConnectedSafe(afterEl)) {
    return false;
  }
  if (isActiveRenameElement(afterEl) && beforeEl !== afterEl) {
    return true;
  }
  if (beforeEl && closestSafe(beforeEl, ".inline-title") && closestSafe(afterEl, ".cm-content, .cm-editor")) {
    const beforeLeaf = closestSafe(beforeEl, ".workspace-leaf");
    const afterLeaf = closestSafe(afterEl, ".workspace-leaf");
    if (!beforeLeaf || !afterLeaf || beforeLeaf === afterLeaf) {
      return true;
    }
  }
  const afterKind = classifyNestedEditable(afterEl);
  if ((afterKind === "canvas-card" || afterKind === "bases-cell") && beforeEl !== afterEl) {
    return true;
  }
  return false;
}
