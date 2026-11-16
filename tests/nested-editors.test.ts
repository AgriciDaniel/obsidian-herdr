import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertNestedCodeMirrorIntact,
  classifyNestedEditable,
  cmOwnsElementStrict,
  commitCanvasCardModel,
  commitNestedEditor,
  extractBasesRowCandidates,
  findCanvasCardEditorTarget,
  findCanvasCardNode,
  findPropertyValueInputForKey,
  findTableCellContainer,
  getDeepActiveElement,
  isActiveRenameElement,
  isCanvasCardEditing,
  isInTableCellWidget,
  isNestedCodeMirrorOwnership,
  resolveBasesRowElement,
  resolveBasesRowFilePath,
  resolveNestedCodeMirror,
  resolveTopLevelElement,
  shouldPreserveNestedFocus,
  type NestedCodeMirrorView,
} from "../src/control/nested-editors";

class MockElement {
  readonly tagName: string;
  readonly classList: Set<string>;
  readonly attributes = new Map<string, string>();
  readonly children: MockElement[] = [];
  readonly listeners = new Map<string, Array<{ fn: (ev: unknown) => void; once: boolean }>>();
  parentElement: MockElement | null = null;
  isConnected = true;
  textContent = "";
  value = "";
  isContentEditable = false;
  blurCalls = 0;
  emitBlurEventsOnBlurMethod = false;
  doc: MockDocument | null = null;
  cmView?: { view?: unknown; rootView?: { view?: unknown } };
  cmTile?: { root?: { view?: unknown } };
  editorView?: unknown;
  cm?: unknown;
  contentDocument?: MockDocument | null;
  shadowRoot?: { activeElement?: MockElement | null } | null;

  constructor(tagName: string, classes: string[] = [], doc: MockDocument | null = null) {
    this.tagName = tagName.toUpperCase();
    this.classList = new Set(classes);
    this.doc = doc;
  }

  get ownerDocument(): MockDocument | null {
    return this.doc;
  }

  get firstElementChild(): MockElement | null {
    return this.children[0] ?? null;
  }

  getAttribute(name: string): string | null {
    if (name === "contenteditable" && !this.attributes.has(name) && this.isContentEditable) {
      return "true";
    }
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: MockElement): MockElement {
    child.parentElement = this;
    const assignDoc = (node: MockElement, d: MockDocument | null): void => {
      node.doc = d;
      for (const grand of node.children) {
        assignDoc(grand, d);
      }
    };
    assignDoc(child, this.doc);
    this.children.push(child);
    return child;
  }

  contains(other: unknown): boolean {
    let cur = other as MockElement | null;
    while (cur) {
      if (cur === this) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  matches(selector: string): boolean {
    const parts = selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const part of parts) {
      if (this.matchesSingle(part)) {
        return true;
      }
    }
    return false;
  }

  private matchesSingle(selector: string): boolean {
    const tokens = selector.trim().split(/\s+/);
    if (tokens.length > 1) {
      const leaf = tokens[tokens.length - 1];
      if (!this.matchesSimple(leaf)) {
        return false;
      }
      let cur: MockElement | null = this.parentElement;
      for (let i = tokens.length - 2; i >= 0; i -= 1) {
        const wanted = tokens[i];
        while (cur && !cur.matchesSimple(wanted)) {
          cur = cur.parentElement;
        }
        if (!cur) {
          return false;
        }
        cur = cur.parentElement;
      }
      return true;
    }
    return this.matchesSimple(tokens[0]);
  }

  private matchesSimple(simple: string): boolean {
    if (!simple) {
      return false;
    }
    let rest = simple;
    const tagMatch = /^([a-zA-Z0-9_-]+)/.exec(rest);
    if (tagMatch) {
      if (this.tagName !== tagMatch[1].toUpperCase()) {
        return false;
      }
      rest = rest.slice(tagMatch[0].length);
    }
    const attrMatches = [...rest.matchAll(/\[([^\]=]+)(?:=['"]?([^'"\]]+)['"]?)?\]/g)];
    for (const m of attrMatches) {
      const attrName = m[1];
      const attrVal = m[2];
      if (attrName === "contenteditable") {
        const effective = this.attributes.get("contenteditable") ?? (this.isContentEditable ? "true" : undefined);
        if (effective === undefined) {
          return false;
        }
        if (attrVal !== undefined && effective !== attrVal) {
          return false;
        }
      } else {
        const val = this.attributes.get(attrName);
        if (val === undefined) {
          return false;
        }
        if (attrVal !== undefined && val !== attrVal) {
          return false;
        }
      }
    }
    rest = rest.replace(/\[[^\]]+\]/g, "");
    const classes = rest.split(".").filter(Boolean);
    for (const cls of classes) {
      if (!this.classList.has(cls)) {
        return false;
      }
    }
    return true;
  }

  closest(selector: string): MockElement | null {
    let cur: MockElement | null = this;
    while (cur) {
      if (cur.matches(selector)) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const out: MockElement[] = [];
    const visit = (node: MockElement): void => {
      for (const child of node.children) {
        if (child.matches(selector)) {
          out.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  addEventListener(type: string, fn: (ev: unknown) => void, options?: { once?: boolean }): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, once: Boolean(options?.once) });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type);
    if (!list) {
      return;
    }
    this.listeners.set(
      type,
      list.filter((entry) => entry.fn !== fn)
    );
  }

  dispatchEvent(ev: unknown): boolean {
    const rec = ev as { type?: string };
    const type = rec?.type ?? "";
    const list = [...(this.listeners.get(type) ?? [])];
    for (const entry of list) {
      if (entry.once) {
        this.removeEventListener(type, entry.fn);
      }
      entry.fn(ev);
    }
    return true;
  }

  blur(): void {
    this.blurCalls += 1;
    if (this.doc && this.doc.activeElement === this) {
      this.doc.activeElement = this.doc.body;
    }
    if (this.emitBlurEventsOnBlurMethod) {
      this.dispatchEvent({ type: "focusout", bubbles: true });
      this.dispatchEvent({ type: "blur", bubbles: false });
    }
  }
}

class MockDocument {
  readonly body: MockElement;
  activeElement: MockElement;
  defaultView: { frameElement: MockElement | null } = { frameElement: null };

  constructor(frameElement: MockElement | null = null) {
    this.body = new MockElement("body", [], this);
    this.activeElement = this.body;
    this.defaultView = { frameElement };
  }
}

function makeFakeWindow(doc: MockDocument): Window {
  class FakeEvent {
    readonly type: string;
    readonly bubbles: boolean;
    readonly cancelable: boolean;
    constructor(type: string, init: Record<string, unknown> = {}) {
      this.type = type;
      this.bubbles = Boolean(init.bubbles);
      this.cancelable = Boolean(init.cancelable);
    }
  }
  class FakeInputEvent extends FakeEvent {
    readonly data: unknown;
    readonly inputType: unknown;
    constructor(type: string, init: Record<string, unknown> = {}) {
      super(type, init);
      this.data = init.data ?? null;
      this.inputType = init.inputType ?? "";
    }
  }
  class FakeFocusEvent extends FakeEvent {}
  class FakeKeyboardEvent extends FakeEvent {
    readonly key: unknown;
    readonly code: unknown;
    constructor(type: string, init: Record<string, unknown> = {}) {
      super(type, init);
      this.key = init.key;
      this.code = init.code;
    }
  }
  return {
    document: doc,
    Event: FakeEvent,
    InputEvent: FakeInputEvent,
    FocusEvent: FakeFocusEvent,
    KeyboardEvent: FakeKeyboardEvent,
  } as unknown as Window;
}

function makeMockCm(dom: MockElement, contentDOM: MockElement, text: string): NestedCodeMirrorView {
  return {
    dom: dom as unknown as Element,
    contentDOM: contentDOM as unknown as Element,
    state: {
      doc: {
        length: text.length,
        lines: 1,
        toString: () => text,
        line: () => ({ from: 0, to: text.length, number: 1, text }),
      },
      selection: { main: { head: text.length, anchor: text.length } },
    },
    coordsAtPos: () => ({ left: 100, top: 200, right: 108, bottom: 220 }),
    dispatch: () => undefined,
  };
}

describe("nested-editors helpers", () => {
  it("distinguishes table widget cells from reading-view cells", () => {
    const doc = new MockDocument();
    const outerLeaf = doc.body.appendChild(new MockElement("div", ["workspace-leaf"]));
    const tableWidget = outerLeaf.appendChild(new MockElement("div", ["cm-table-widget"]));
    const td = tableWidget.appendChild(new MockElement("td"));
    const span = td.appendChild(new MockElement("span"));

    const readingView = outerLeaf.appendChild(new MockElement("div", ["markdown-preview-view"]));
    const readingTd = readingView.appendChild(new MockElement("td"));

    assert.equal(isInTableCellWidget(span as unknown as Element), true);
    assert.equal(findTableCellContainer(span as unknown as Element), td as unknown as Element);
    assert.equal(isInTableCellWidget(readingTd as unknown as Element), false);
    assert.equal(findTableCellContainer(readingTd as unknown as Element), null);
  });

  it("never falls back to outer note CM for unmounted table cell and resolves mounted nested cell CM", () => {
    const doc = new MockDocument();
    const leaf = doc.body.appendChild(new MockElement("div", ["workspace-leaf"]));
    const outerEditor = leaf.appendChild(new MockElement("div", ["cm-editor"]));
    const outerContent = outerEditor.appendChild(new MockElement("div", ["cm-content"]));
    const outerLine = outerContent.appendChild(new MockElement("div", ["cm-line"]));
    const outerCm = makeFakeCmWithAttach(outerEditor, outerContent, "# outer");

    const widget = outerContent.appendChild(new MockElement("div", ["cm-table-widget"]));
    const tdUnmounted = widget.appendChild(new MockElement("td"));
    const tdSpan = tdUnmounted.appendChild(new MockElement("span"));

    // Unmounted cell must NOT resolve to outerCm.
    assert.equal(cmOwnsElementStrict(outerCm, tdSpan as unknown as Element), false);
    const unmountedRes = resolveNestedCodeMirror(tdSpan as unknown as Element, { outerCm });
    assert.equal(unmountedRes.cm, null);
    assert.equal(unmountedRes.inTableCell, true);
    assert.equal(unmountedRes.isNested, false);
    assert.equal(unmountedRes.cellEl, tdUnmounted as unknown as Element);

    // Mounted nested cell CM inside <td> resolves strictly to cellCm.
    const tdMounted = widget.appendChild(new MockElement("td"));
    const cellEditor = tdMounted.appendChild(new MockElement("div", ["cm-editor"]));
    const cellContent = cellEditor.appendChild(new MockElement("div", ["cm-content"]));
    const cellLine = cellContent.appendChild(new MockElement("div", ["cm-line"]));
    const cellCm = makeFakeCmWithAttach(cellEditor, cellContent, "initial");

    assert.equal(cmOwnsElementStrict(outerCm, cellLine as unknown as Element), false);
    assert.equal(cmOwnsElementStrict(cellCm, cellLine as unknown as Element), true);
    assert.equal(cmOwnsElementStrict(outerCm, outerLine as unknown as Element), true);

    const mountedFromLine = resolveNestedCodeMirror(cellLine as unknown as Element, { outerCm });
    assert.equal(mountedFromLine.cm, cellCm);
    assert.equal(mountedFromLine.isNested, true);
    assert.equal(mountedFromLine.inTableCell, true);

    const mountedFromTd = resolveNestedCodeMirror(tdMounted as unknown as Element, { outerCm });
    assert.equal(mountedFromTd.cm, cellCm);
    assert.equal(mountedFromTd.isNested, true);

    const outerRes = resolveNestedCodeMirror(outerLine as unknown as Element, { outerCm });
    assert.equal(outerRes.cm, outerCm);
    assert.equal(outerRes.isNested, false);
    assert.equal(outerRes.inTableCell, false);
  });

  it("validates nested cell CM ownership independently of outer leaf CM", () => {
    const doc = new MockDocument();
    const leaf = doc.body.appendChild(new MockElement("div", ["workspace-leaf"]));
    const outerEditor = leaf.appendChild(new MockElement("div", ["cm-editor"]));
    const outerContent = outerEditor.appendChild(new MockElement("div", ["cm-content"]));
    const outerCm = makeFakeCmWithAttach(outerEditor, outerContent, "# outer");

    const widget = outerContent.appendChild(new MockElement("div", ["cm-table-widget"]));
    const td = widget.appendChild(new MockElement("td"));
    const cellEditor = td.appendChild(new MockElement("div", ["cm-editor"]));
    const cellContent = cellEditor.appendChild(new MockElement("div", ["cm-content"]));
    const cellCm = makeFakeCmWithAttach(cellEditor, cellContent, "cell");

    const td2 = widget.appendChild(new MockElement("td"));
    const otherEditor = td2.appendChild(new MockElement("div", ["cm-editor"]));
    const otherContent = otherEditor.appendChild(new MockElement("div", ["cm-content"]));
    makeFakeCmWithAttach(otherEditor, otherContent, "other");

    assert.equal(isNestedCodeMirrorOwnership(cellCm, outerCm), true);
    assert.equal(isNestedCodeMirrorOwnership(outerCm, outerCm), false);

    assert.deepEqual(
      assertNestedCodeMirrorIntact(cellCm, cellContent as unknown as Element, "Typing aborted"),
      { ok: true }
    );
    const switched = assertNestedCodeMirrorIntact(
      cellCm,
      otherContent as unknown as Element,
      "Typing stopped"
    );
    assert.equal(switched.ok, false);

    cellContent.isConnected = false;
    const disconnected = assertNestedCodeMirrorIntact(cellCm, null, "Typing stopped");
    assert.equal(disconnected.ok, false);
  });

  it("classifies properties inputs and finds sibling value field for key input", () => {
    const doc = new MockDocument();
    const container = doc.body.appendChild(new MockElement("div", ["metadata-container"]));
    const propRow = container.appendChild(new MockElement("div", ["metadata-property"]));
    const keyWrap = propRow.appendChild(new MockElement("div", ["metadata-property-key"]));
    const keyInput = keyWrap.appendChild(new MockElement("input", ["metadata-property-key-input"]));
    const valWrap = propRow.appendChild(new MockElement("div", ["metadata-property-value"]));
    const valEditable = valWrap.appendChild(new MockElement("div", ["metadata-input-longtext"]));
    valEditable.isContentEditable = true;

    assert.equal(classifyNestedEditable(keyInput as unknown as Element), "property-key");
    assert.equal(classifyNestedEditable(valEditable as unknown as Element), "property-value");
    assert.equal(
      findPropertyValueInputForKey(keyInput as unknown as Element),
      valEditable as unknown as HTMLElement
    );
  });

  it("commits properties panel and inline-title with input, change, Enter, and non-duplicated blur/focusout", () => {
    const doc = new MockDocument();
    const win = makeFakeWindow(doc);

    // 1) Mock element where .blur() does NOT automatically fire DOM events (like jsdom/minimal mocks).
    const propVal = doc.body.appendChild(new MockElement("div", ["metadata-input-longtext"]));
    propVal.isContentEditable = true;
    propVal.textContent = "draft-ok";
    doc.activeElement = propVal;
    const seen1: string[] = [];
    for (const evName of ["input", "change", "keydown", "keyup", "focusout", "blur"]) {
      propVal.addEventListener(evName, () => seen1.push(evName));
    }

    const res1 = commitNestedEditor(propVal as unknown as Element, win, {
      triggerEnter: true,
      text: "draft-ok",
    });
    assert.equal(res1.committed, true);
    assert.equal(res1.kind, "property-value");
    assert.equal(res1.blurred, true);
    assert.equal(propVal.blurCalls, 1);
    assert.deepEqual(seen1, ["input", "change", "keydown", "keyup", "focusout", "blur"]);

    // 2) Native-like element where .blur() DOES emit focusout + blur once: must NOT duplicate events.
    const inlineTitle = doc.body.appendChild(new MockElement("div", ["inline-title"]));
    inlineTitle.isContentEditable = true;
    inlineTitle.emitBlurEventsOnBlurMethod = true;
    doc.activeElement = inlineTitle;
    const seen2: string[] = [];
    for (const evName of ["input", "change", "keydown", "keyup", "focusout", "blur"]) {
      inlineTitle.addEventListener(evName, () => seen2.push(evName));
    }

    const res2 = commitNestedEditor(inlineTitle as unknown as Element, win, {
      triggerEnter: true,
      text: "agy4 fe note",
    });
    assert.equal(res2.committed, true);
    assert.equal(res2.kind, "inline-title");
    assert.equal(res2.blurred, true);
    assert.deepEqual(seen2, ["input", "change", "keydown", "keyup", "focusout", "blur"]);

    // 3) Enter handler that already blurs natively (fires focusout + blur only while focused)
    // must NOT duplicate commit/focusout/blur notifications.
    const titleWithEnterBlur = doc.body.appendChild(new MockElement("div", ["inline-title"]));
    titleWithEnterBlur.isContentEditable = true;
    titleWithEnterBlur.emitBlurEventsOnBlurMethod = true;
    doc.activeElement = titleWithEnterBlur;
    let commits = 0;
    let focusouts = 0;
    let blurs = 0;
    titleWithEnterBlur.addEventListener("focusout", () => {
      focusouts += 1;
      commits += 1;
    });
    titleWithEnterBlur.addEventListener("blur", () => {
      blurs += 1;
    });
    titleWithEnterBlur.addEventListener("keydown", (ev) => {
      const k = (ev as { key?: string })?.key;
      if (k === "Enter" && doc.activeElement === titleWithEnterBlur) {
        titleWithEnterBlur.blur();
      }
    });
    const resEnterBlur = commitNestedEditor(titleWithEnterBlur as unknown as Element, win, {
      triggerEnter: true,
      text: "renamed once",
    });
    assert.equal(resEnterBlur.committed, true);
    assert.equal(resEnterBlur.blurred, true);
    assert.equal(commits, 1);
    assert.equal(focusouts, 1);
    assert.equal(blurs, 1);

    // 4) Ordinary non-nested element is a clean no-op.
    const plainBtn = doc.body.appendChild(new MockElement("button"));
    assert.deepEqual(commitNestedEditor(plainBtn as unknown as Element, win), {
      committed: false,
      kind: null,
      blurred: false,
    });
  });

  it("preserves focus on .is-being-renamed and .inline-title across focus restoration", () => {
    const doc = new MockDocument();
    const leaf = doc.body.appendChild(new MockElement("div", ["workspace-leaf"]));
    const editor = leaf.appendChild(new MockElement("div", ["cm-editor"]));
    const cmContent = editor.appendChild(new MockElement("div", ["cm-content"]));
    const inlineTitle = leaf.appendChild(new MockElement("div", ["inline-title"]));
    inlineTitle.isContentEditable = true;

    const sidebar = doc.body.appendChild(new MockElement("div", ["nav-files-container"]));
    const renameBox = sidebar.appendChild(new MockElement("div", ["nav-file-title-content", "is-being-renamed"]));
    renameBox.isContentEditable = true;
    const plainButton = doc.body.appendChild(new MockElement("button"));

    assert.equal(isActiveRenameElement(renameBox as unknown as Element), true);
    assert.equal(isActiveRenameElement(inlineTitle as unknown as Element), true);
    assert.equal(isActiveRenameElement(cmContent as unknown as Element), false);

    // Must preserve focus when click moved focus into .is-being-renamed or .inline-title.
    assert.equal(
      shouldPreserveNestedFocus(cmContent as unknown as Element, renameBox as unknown as Element),
      true
    );
    assert.equal(
      shouldPreserveNestedFocus(cmContent as unknown as Element, inlineTitle as unknown as Element),
      true
    );
    // Pressing Enter in .inline-title advances into same leaf's editor body; do not pull back.
    assert.equal(
      shouldPreserveNestedFocus(inlineTitle as unknown as Element, cmContent as unknown as Element),
      true
    );
    // Ordinary non-rename control still allows focus restore.
    assert.equal(
      shouldPreserveNestedFocus(cmContent as unknown as Element, plainButton as unknown as Element),
      false
    );
  });

  it("resolves Canvas card iframe edit mode, active CM, top-level containment, and preserves focus", () => {
    const outerDoc = new MockDocument();
    const leaf = outerDoc.body.appendChild(new MockElement("div", ["workspace-leaf"]));
    const canvasWrapper = leaf.appendChild(new MockElement("div", ["canvas-wrapper"]));

    // Non-editing card: must NOT be flagged as editing or preserved as active editor.
    const idleNode = canvasWrapper.appendChild(new MockElement("div", ["canvas-node"]));
    assert.equal(isCanvasCardEditing(idleNode as unknown as Element), false);
    assert.equal(findCanvasCardEditorTarget(idleNode as unknown as Element), null);

    // Editing card with inner iframe hosting CodeMirror 6 (matching Obsidian live DOM).
    const editingNode = canvasWrapper.appendChild(new MockElement("div", ["canvas-node", "is-editing"]));
    const nodeContainer = editingNode.appendChild(new MockElement("div", ["canvas-node-container"]));
    const nodeContent = nodeContainer.appendChild(new MockElement("div", ["canvas-node-content"]));
    const editorHost = nodeContent.appendChild(new MockElement("div"));
    const iframe = editorHost.appendChild(new MockElement("iframe"));

    const innerDoc = new MockDocument(iframe);
    iframe.contentDocument = innerDoc;
    const innerEditor = innerDoc.body.appendChild(new MockElement("div", ["cm-editor"]));
    const innerCmContent = innerEditor.appendChild(new MockElement("div", ["cm-content"]));
    innerCmContent.isContentEditable = true;
    const innerCm = makeFakeCmWithAttach(innerEditor, innerCmContent, "card body");
    const outerNoteEditor = outerDoc.body.appendChild(new MockElement("div", ["cm-editor"]));
    const outerCmContent = outerNoteEditor.appendChild(new MockElement("div", ["cm-content"]));
    const outerCm = makeFakeCmWithAttach(outerNoteEditor, outerCmContent, "outer note");

    outerDoc.activeElement = iframe;
    innerDoc.activeElement = innerCmContent;

    assert.equal(getDeepActiveElement(outerDoc as unknown as Document), innerCmContent as unknown as Element);
    assert.equal(resolveTopLevelElement(innerCmContent as unknown as Element), iframe as unknown as Element);
    assert.equal(leaf.contains(resolveTopLevelElement(innerCmContent as unknown as Element)), true);
    assert.equal(findCanvasCardNode(innerCmContent as unknown as Element), editingNode as unknown as Element);
    assert.equal(isCanvasCardEditing(innerCmContent as unknown as Element), true);
    assert.equal(isCanvasCardEditing(iframe as unknown as Element), true);
    assert.equal(findCanvasCardEditorTarget(editingNode as unknown as Element), innerCmContent as unknown as Element);

    const cmRes = resolveNestedCodeMirror(innerCmContent as unknown as Element, { outerCm });
    assert.equal(cmRes.cm, innerCm);
    assert.equal(cmRes.isNested, true);
    assert.equal(cmRes.inTableCell, false);

    assert.equal(classifyNestedEditable(innerCmContent as unknown as Element), "canvas-card");
    assert.equal(classifyNestedEditable(iframe as unknown as Element), "canvas-card");

    const editBtn = canvasWrapper.appendChild(new MockElement("button"));
    assert.equal(
      shouldPreserveNestedFocus(editBtn as unknown as Element, iframe as unknown as Element),
      true
    );
    assert.equal(
      shouldPreserveNestedFocus(canvasWrapper as unknown as Element, innerCmContent as unknown as Element),
      true
    );
    assert.equal(
      shouldPreserveNestedFocus(canvasWrapper as unknown as Element, idleNode as unknown as Element),
      false
    );
  });

  it("resolves Bases rows via <span data-href> or data-path, classifies cells, commits, and preserves focus", () => {
    const doc = new MockDocument();
    const win = makeFakeWindow(doc);
    const view = doc.body.appendChild(new MockElement("div", ["bases-view"]));
    const tbody = view.appendChild(new MockElement("div", ["bases-tbody"]));

    // Row 1: matches live Obsidian Bases DOM (<span data-href="..."> inside .bases-td).
    const row1 = tbody.appendChild(new MockElement("div", ["bases-tr"]));
    const nameTd = row1.appendChild(new MockElement("div", ["bases-td"]));
    const nameSpan = nameTd.appendChild(new MockElement("span"));
    nameSpan.attributes.set("data-href", "agy4 target");
    nameSpan.textContent = "agy4 target";
    const statusTd = row1.appendChild(new MockElement("div", ["bases-td"]));
    const statusEditable = statusTd.appendChild(new MockElement("div"));
    statusEditable.isContentEditable = true;
    statusEditable.textContent = "draft";

    assert.equal(resolveBasesRowElement(statusEditable as unknown as Element), row1 as unknown as Element);
    assert.deepEqual(extractBasesRowCandidates(statusEditable as unknown as Element), [
      { kind: "href", value: "agy4 target" },
    ]);
    assert.equal(
      resolveBasesRowFilePath(statusEditable as unknown as Element, {
        resolveHref: (href) => (href === "agy4 target" ? "Crew Test/Audit/agy4 target.md" : null),
      }),
      "Crew Test/Audit/agy4 target.md"
    );

    // Row 2: direct child div of .bases-tbody without .bases-tr class (audit selector style) + data-path.
    const row2 = tbody.appendChild(new MockElement("div"));
    const row2Name = row2.appendChild(new MockElement("div"));
    const row2Link = row2Name.appendChild(new MockElement("a", ["internal-link"]));
    row2Link.attributes.set("data-path", "Crew Test/Audit/agy5 parallel.md");
    const row2Cell = row2.appendChild(new MockElement("div"));
    const row2Editable = row2Cell.appendChild(new MockElement("div"));
    row2Editable.isContentEditable = true;

    assert.equal(resolveBasesRowElement(row2Editable as unknown as Element), row2 as unknown as Element);
    assert.equal(
      resolveBasesRowFilePath(row2Editable as unknown as Element, {
        resolvePath: (p) => (p.endsWith(".md") ? p : null),
      }),
      "Crew Test/Audit/agy5 parallel.md"
    );

    // Row 3: ambiguous links in the row must resolve to null instead of guessing.
    const row3 = tbody.appendChild(new MockElement("div", ["bases-tr"]));
    const c1 = row3.appendChild(new MockElement("div", ["bases-td"]));
    const l1 = c1.appendChild(new MockElement("span"));
    l1.attributes.set("data-href", "note-a");
    const c2 = row3.appendChild(new MockElement("div", ["bases-td"]));
    const l2 = c2.appendChild(new MockElement("span"));
    l2.attributes.set("data-href", "note-b");
    assert.equal(
      resolveBasesRowFilePath(c2 as unknown as Element, {
        resolveHref: (h) => `${h}.md`,
      }),
      null
    );

    // Classification, focus preservation, and clean blur commit.
    assert.equal(classifyNestedEditable(statusEditable as unknown as Element), "bases-cell");
    assert.equal(classifyNestedEditable(row2Editable as unknown as Element), "bases-cell");
    const otherNoteCm = doc.body.appendChild(new MockElement("div", ["cm-content"]));
    assert.equal(
      shouldPreserveNestedFocus(otherNoteCm as unknown as Element, statusEditable as unknown as Element),
      true
    );

    doc.activeElement = statusEditable;
    const events: string[] = [];
    statusEditable.addEventListener("input", () => events.push("input"));
    statusEditable.addEventListener("change", () => events.push("change"));
    statusEditable.addEventListener("focusout", () => events.push("focusout"));
    const commitRes = commitNestedEditor(statusEditable as unknown as Element, win, {
      triggerBlur: true,
      text: "ready",
    });
    assert.equal(commitRes.committed, true);
    assert.equal(commitRes.kind, "bases-cell");
    assert.equal(commitRes.blurred, true);
    assert.deepEqual(events, ["input", "change", "focusout"]);
  });

  it("commits Canvas card DOM edits without Enter and flushes Canvas node child buffer via commitCanvasCardModel", () => {
    const outerDoc = new MockDocument();
    const win = makeFakeWindow(outerDoc);
    const canvasWrapper = outerDoc.body.appendChild(new MockElement("div", ["canvas-wrapper"]));
    const editingNode = canvasWrapper.appendChild(new MockElement("div", ["canvas-node", "is-editing"]));
    const editorHost = editingNode.appendChild(new MockElement("div"));
    const iframe = editorHost.appendChild(new MockElement("iframe"));
    const innerDoc = new MockDocument(iframe);
    iframe.contentDocument = innerDoc;
    const innerEditor = innerDoc.body.appendChild(new MockElement("div", ["cm-editor"]));
    const innerCmContent = innerEditor.appendChild(new MockElement("div", ["cm-content"]));
    innerCmContent.isContentEditable = true;
    const innerCm = makeFakeCmWithAttach(innerEditor, innerCmContent, "agy4 canvas card");

    innerDoc.activeElement = innerCmContent;
    const cardEvents: string[] = [];
    innerCmContent.addEventListener("input", () => cardEvents.push("input"));
    innerCmContent.addEventListener("change", () => cardEvents.push("change"));
    innerCmContent.addEventListener("keydown", () => cardEvents.push("keydown"));
    innerCmContent.addEventListener("focusout", () => cardEvents.push("focusout"));

    const domCommit = commitNestedEditor(innerCmContent as unknown as Element, win, {
      triggerBlur: true,
      text: "agy4 canvas card",
    });
    assert.equal(domCommit.committed, true);
    assert.equal(domCommit.kind, "canvas-card");
    assert.equal(domCommit.blurred, true);
    assert.deepEqual(cardEvents, ["input", "change", "focusout"]);

    let savedPayload: { text: string | undefined; triggerSave: boolean | undefined } | null = null;
    const mockCanvasView = {
      canvas: {
        nodes: new Map([
          [
            "other-id",
            {
              id: "other-id",
              nodeEl: new MockElement("div", ["canvas-node"]) as unknown as Element,
              isEditing: false,
              child: {
                save: () => {
                  throw new Error("should not save unrelated node");
                },
              },
            },
          ],
          [
            "card-1",
            {
              id: "card-1",
              nodeEl: editingNode as unknown as Element,
              isEditing: true,
              child: {
                editor: { getValue: () => "agy4 canvas card", cm: innerCm },
                save: (text?: string, triggerSave?: boolean) => {
                  savedPayload = { text, triggerSave };
                },
              },
            },
          ],
        ]),
      },
    };
    assert.equal(
      commitCanvasCardModel(mockCanvasView, innerCmContent as unknown as Element, innerCm),
      true
    );
    assert.deepEqual(savedPayload, { text: "agy4 canvas card", triggerSave: true });
    assert.equal(commitCanvasCardModel({}, innerCmContent as unknown as Element, innerCm), false);
  });
});

function makeFakeCmWithAttach(
  dom: MockElement,
  contentDOM: MockElement,
  text: string
): NestedCodeMirrorView {
  const cm = makeMockCm(dom, contentDOM, text);
  dom.cmView = { view: cm };
  contentDOM.cmView = { rootView: { view: cm }, view: cm };
  return cm;
}
