export interface FakeDomNode {
  tagName: string;
  textContent: string;
  value: string;
  disabled: boolean;
  open: boolean;
  isConnected: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
  scrollTop: number;
  scrollHeight: number;
  rows?: number;
  type?: string;
  placeholder?: string;
  parentNode: FakeDomNode | null;
  children: FakeDomNode[];
  attrs: Record<string, string>;
  style: Record<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  className: string;
  classList: {
    add: (...cls: string[]) => void;
    remove: (...cls: string[]) => void;
    toggle: (cls: string, force?: boolean) => boolean;
    contains: (cls: string) => boolean;
  };
  ownerDocument: FakeDomDocument;
  doc: FakeDomDocument;
  win: FakeDomWindow;
  addClass: (...cls: string[]) => void;
  removeClass: (...cls: string[]) => void;
  setAttr: (k: string, v: string | number | boolean | null) => void;
  getAttr: (k: string) => string | null;
  getAttribute: (k: string) => string | null;
  setText: (t: string) => void;
  empty: () => void;
  createEl: (tag: string, opts?: FakeCreateOpts) => FakeDomNode;
  createDiv: (opts?: FakeCreateOpts | string) => FakeDomNode;
  createSpan: (opts?: FakeCreateOpts | string) => FakeDomNode;
  appendChild: (child: FakeDomNode) => FakeDomNode;
  remove: () => void;
  contains: (target: unknown) => boolean;
  addEventListener: (ev: string, fn: (e: unknown) => void) => void;
  removeEventListener: (ev: string, fn: (e: unknown) => void) => void;
  dispatchEvent: (ev: { type: string; [k: string]: unknown }) => void;
  click: () => void;
  focus: (opts?: unknown) => void;
  setSelectionRange: (start: number, end: number) => void;
  scrollIntoView: (opts?: unknown) => void;
}

export interface FakeCreateOpts {
  cls?: string;
  text?: string;
  type?: string;
  placeholder?: string;
  attr?: Record<string, string | number | boolean | null>;
}

export interface FakeDomDocument {
  activeElement: FakeDomNode | null;
  body: FakeDomNode;
}

export interface FakeDomWindow {
  document: FakeDomDocument;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}

export function createFakeDomEnvironment(): {
  win: FakeDomWindow;
  doc: FakeDomDocument;
  createNode: (tag: string, opts?: FakeCreateOpts) => FakeDomNode;
} {
  const doc: FakeDomDocument = {
    activeElement: null,
    body: null as unknown as FakeDomNode,
  };
  const win: FakeDomWindow = {
    document: doc,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };

  const createNode = (tag: string, opts?: FakeCreateOpts | string): FakeDomNode => {
    const normalized: FakeCreateOpts =
      typeof opts === "string" ? { cls: opts } : opts || {};
    const classSet = new Set<string>(
      (normalized.cls || "").split(/\s+/).filter(Boolean)
    );
    const attrs: Record<string, string> = {};
    if (normalized.attr) {
      for (const [k, v] of Object.entries(normalized.attr)) {
        if (v !== null && v !== undefined) {
          attrs[k] = String(v);
        }
      }
    }
    const listeners = new Map<string, Array<(ev: unknown) => void>>();
    const node: FakeDomNode = {
      tagName: tag.toUpperCase(),
      textContent: normalized.text || "",
      value: "",
      disabled: false,
      open: false,
      isConnected: true,
      selectionStart: 0,
      selectionEnd: 0,
      scrollTop: 0,
      scrollHeight: 40,
      type: normalized.type,
      placeholder: normalized.placeholder,
      parentNode: null,
      children: [],
      attrs,
      style: {},
      listeners,
      get className() {
        return Array.from(classSet).join(" ");
      },
      set className(val: string) {
        classSet.clear();
        for (const c of String(val || "").split(/\s+/).filter(Boolean)) {
          classSet.add(c);
        }
      },
      classList: {
        add: (...cls: string[]) => {
          for (const raw of cls) {
            for (const c of String(raw || "").split(/\s+/).filter(Boolean)) {
              classSet.add(c);
            }
          }
        },
        remove: (...cls: string[]) => {
          for (const c of cls) {
            classSet.delete(c);
          }
        },
        toggle: (cls: string, force?: boolean) => {
          const shouldAdd = force === undefined ? !classSet.has(cls) : Boolean(force);
          if (shouldAdd) {
            classSet.add(cls);
          } else {
            classSet.delete(cls);
          }
          return shouldAdd;
        },
        contains: (cls: string) => classSet.has(cls),
      },
      ownerDocument: doc,
      doc,
      win,
      addClass: (...cls: string[]) => node.classList.add(...cls),
      removeClass: (...cls: string[]) => node.classList.remove(...cls),
      setAttr: (k: string, v: string | number | boolean | null) => {
        if (v === null || v === undefined) {
          delete attrs[k];
        } else {
          attrs[k] = String(v);
        }
      },
      getAttr: (k: string) => (k in attrs ? attrs[k] : null),
      getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
      setText: (t: string) => {
        node.textContent = t;
      },
      empty: () => {
        for (const ch of node.children) {
          ch.parentNode = null;
          ch.isConnected = false;
        }
        node.children = [];
        node.textContent = "";
      },
      createEl: (childTag: string, childOpts?: FakeCreateOpts) => {
        const child = createNode(childTag, childOpts);
        node.appendChild(child);
        return child;
      },
      createDiv: (childOpts?: FakeCreateOpts | string) => {
        const child = createNode("div", childOpts);
        node.appendChild(child);
        return child;
      },
      createSpan: (childOpts?: FakeCreateOpts | string) => {
        const child = createNode("span", childOpts);
        node.appendChild(child);
        return child;
      },
      appendChild: (child: FakeDomNode) => {
        child.parentNode = node;
        child.isConnected = node.isConnected;
        node.children.push(child);
        return child;
      },
      remove: () => {
        if (node.parentNode) {
          node.parentNode.children = node.parentNode.children.filter((c) => c !== node);
          node.parentNode = null;
        }
        node.isConnected = false;
      },
      contains: (target: unknown) => {
        if (target === node) return true;
        return node.children.some((c) => c.contains(target));
      },
      addEventListener: (ev: string, fn: (e: unknown) => void) => {
        const list = listeners.get(ev) || [];
        list.push(fn);
        listeners.set(ev, list);
      },
      removeEventListener: (ev: string, fn: (e: unknown) => void) => {
        const list = listeners.get(ev) || [];
        listeners.set(
          ev,
          list.filter((item) => item !== fn)
        );
      },
      dispatchEvent: (ev: { type: string; [k: string]: unknown }) => {
        for (const fn of [...(listeners.get(ev.type) || [])]) {
          fn(ev);
        }
      },
      click: () => {
        node.dispatchEvent({
          type: "click",
          preventDefault: () => undefined,
          stopPropagation: () => undefined,
        });
      },
      focus: () => {
        doc.activeElement = node;
      },
      setSelectionRange: (start: number, end: number) => {
        node.selectionStart = start;
        node.selectionEnd = end;
      },
      scrollIntoView: () => undefined,
    };
    return node;
  };

  doc.body = createNode("body");
  return { win, doc, createNode };
}

export function findAllNodes(
  root: FakeDomNode,
  predicate: (node: FakeDomNode) => boolean,
  out: FakeDomNode[] = []
): FakeDomNode[] {
  if (predicate(root)) {
    out.push(root);
  }
  for (const child of root.children) {
    findAllNodes(child, predicate, out);
  }
  return out;
}
