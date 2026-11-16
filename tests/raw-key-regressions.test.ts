import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import type {} from "obsidian";
import { UiControlService } from "../src/control/ui-control";

type TestEvent = {
  type: string;
  key?: string;
  code?: string;
  data?: string | null;
  inputType?: string;
  isTrusted?: boolean;
};

function bounds(left = 20, top = 30, width = 220, height = 40) {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height };
}

function makeHarness(kind: "editor" | "input" | "terminal") {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const replayed: TestEvent[] = [];
  const terminalBytes: string[] = [];
  const editorTransactions: TransactionSpec[] = [];
  let editorState = EditorState.create({ doc: "seed", selection: EditorSelection.cursor(4) });
  let modalOpen = false;
  let focusedOriginal = 0;
  const pendingEvents: Array<() => void> = [];

  const node = (classes = "") => {
    const names = new Set(classes.split(/\s+/).filter(Boolean));
    const value = {
      tagName: "DIV",
      isConnected: true,
      isContentEditable: false,
      parentElement: null as { closest: (selector: string) => unknown } | null,
      disabled: false,
      readOnly: false,
      classList: { contains: (name: string) => names.has(name) },
      getAttribute: (_name: string): string | null => null,
      hasAttribute: (_name: string) => false,
      getBoundingClientRect: () => bounds(),
      querySelector: (_selector: string): unknown => null,
      querySelectorAll: (_selector: string): unknown[] => [],
      contains: (other: unknown) => other === value,
      matches: (selector: string): boolean => selector.split(",").some((part) => {
        const s = part.trim();
        if (s.startsWith(".")) return names.has(s.slice(1));
        return s.toUpperCase() === value.tagName;
      }),
      closest: (selector: string): unknown => value.matches(selector)
        ? value : value.parentElement?.closest(selector) ?? null,
    };
    return value;
  };

  const body = node();
  const leaf = node("workspace-leaf");
  const content = node("cm-content");
  content.isContentEditable = true;
  content.parentElement = leaf;
  leaf.contains = (other: unknown) => other === leaf || other === content;
  const modal = node("modal-container prompt");
  const field = (classes = "") => Object.assign(node(classes), {
    tagName: "INPUT",
    value: "seed",
    selectionStart: 4,
    selectionEnd: 4,
    selectionDirection: "none",
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    setRangeText(this: { value: string; selectionStart: number; selectionEnd: number },
      text: string, start = this.selectionStart, end = this.selectionEnd, mode = "preserve") {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      const next = start + text.length;
      this.selectionStart = mode === "select" ? start : next;
      this.selectionEnd = next;
    },
  });
  const plain = field();
  const terminal = field("xterm-helper-textarea");
  terminal.tagName = "TEXTAREA";
  const original = kind === "editor" ? content : kind === "terminal" ? terminal : plain;
  const agent = node("test-agent-control");
  agent.tagName = "BUTTON";
  const palette = field();
  palette.value = "";
  palette.parentElement = modal;
  const doc = {
    body,
    documentElement: node(),
    activeElement: original as unknown,
    querySelectorAll: (selector: string): unknown[] => {
      if (selector === ".test-agent-control") return [agent];
      if (modalOpen && selector.includes(".modal")) return [modal];
      return [];
    },
    elementFromPoint: () => agent,
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      const current = listeners.get(type) ?? [];
      current.push(handler);
      listeners.set(type, current);
    },
    removeEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((fn) => fn !== handler));
    },
  };

  const originalTarget = Object.assign(original, {
    focus: () => { focusedOriginal++; doc.activeElement = original; },
    dispatchEvent: (event: TestEvent) => { replayed.push(event); return true; },
  });
  const cm = {
    dom: leaf as unknown as Element,
    contentDOM: content as unknown as Element,
    scrollDOM: leaf as unknown as HTMLElement,
    get state() { return editorState; },
    dispatch: (spec: TransactionSpec) => {
      editorTransactions.push(spec);
      editorState = editorState.update(spec).state;
    },
    coordsAtPos: () => ({ left: 80, top: 80, right: 82, bottom: 100 }),
    focus: () => { focusedOriginal++; doc.activeElement = content; },
  };
  const win = {
    innerWidth: 1000,
    innerHeight: 600,
    document: doc,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    getSelection: () => null,
    requestAnimationFrame: (fn: (time: number) => void) => setTimeout(() => fn(performance.now()), 0),
    setTimeout,
    clearTimeout,
  } as unknown as Window;

  function trustedEvent(event: TestEvent) {
    let prevented = false;
    let stopped = false;
    const wrapped = {
      ...event, isTrusted: true,
      preventDefault: () => { prevented = true; },
      stopImmediatePropagation: () => { stopped = true; },
      stopPropagation: () => undefined,
    };
    for (const handler of [...(listeners.get(event.type) ?? [])]) {
      handler(wrapped);
      if (stopped) break;
    }
    return { prevented };
  }

  function physicalKey(key: string) {
    const result = trustedEvent({ type: "keydown", key });
    // A canceled physical keydown must not manufacture later typing events.
    if (!result.prevented && key.length === 1) {
      const press = trustedEvent({ type: "keypress", key });
      if (!press.prevented) trustedEvent({ type: "beforeinput", data: key, inputType: "insertText" });
    }
    return result;
  }

  function service(sleep: () => Promise<void>, sendKey: (event: Record<string, unknown>) => void) {
    const options = {
      win,
      getCodeMirrorView: () => kind === "editor" ? cm : null,
      resolveElementContext: (element: Element) => element === content as unknown as Element || element === leaf as unknown as Element
        ? { notePath: "Crew Test/Audit/regression.md", pane: "test-leaf" } : null,
      deliverToTerminal: (element: Element, data: string) => {
        if (kind !== "terminal" || element !== originalTarget as unknown as Element) return false;
        terminalBytes.push(data);
        return true;
      },
      getWebContents: () => ({
        capturePage: () => Promise.reject(new Error("Screenshots are outside this isolated test")),
        sendInputEvent: (event: Record<string, unknown>) => {
          if (event.type === "mouseDown") doc.activeElement = agent;
          else sendKey(event);
        },
        insertText: () => undefined,
      }),
      sleep,
    };
    return new UiControlService(options);
  }

  async function modalInput(keys: string[]) {
    let injected = false;
    const ui = service(async () => {
      if (modalOpen && !injected) {
        injected = true;
        for (const key of keys) assert.equal(physicalKey(key).prevented, true);
      }
    }, (event) => {
      if (event.type === "keyDown") {
        trustedEvent({ type: "keydown", key: String(event.keyCode) });
        modalOpen = true;
        doc.activeElement = palette;
      }
    });
    await ui.batch({ steps: [
      { action: "click", target: { selector: ".test-agent-control" } },
      { action: "press_key", key: "p", modifiers: ["Mod"] },
    ] }, "sol3");
    assert.equal(injected, true, "Physical input must be injected while the modal owns focus");
    assert.equal(doc.activeElement, palette, "Replay must preserve modal focus");
    assert.equal(palette.value, "", "Captured user typing must not enter the palette");
    assert.equal(focusedOriginal, 0, "Replay must not temporarily focus the original target");
  }

  return {
    doc, agent, originalTarget, plain, terminal, cm, terminalBytes, replayed, pendingEvents,
    service, trustedEvent, modalInput, editorTransactions,
    text: () => editorState.doc.toString(),
    select: (from: number, to = from) => {
      editorState = editorState.update({ selection: EditorSelection.single(from, to) }).state;
      plain.selectionStart = from;
      plain.selectionEnd = to;
    },
  };
}

describe("Raw key regressions: delayed agent input and modal replay", () => {
  it("does not replay an agent ArrowRight delivered on the next input turn to the user", async () => {
    const h = makeHarness("input");
    let canceled: boolean | undefined;
    let delivered = false;
    const ui = h.service(async () => {
      while (h.pendingEvents.length) h.pendingEvents.shift()?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }, (event) => {
      if (event.type === "keyDown" && event.keyCode === "Right") {
        h.pendingEvents.push(() => {
          delivered = true;
          canceled = h.trustedEvent({ type: "keydown", key: "ArrowRight", code: "ArrowRight" }).prevented;
        });
      }
    });
    await ui.batch({ steps: [
      { action: "click", target: { selector: ".test-agent-control" } },
      { action: "press_key", key: "ArrowRight" },
    ] }, "sol3");
    assert.equal(delivered, true, "Agent event must arrive after sendInputEvent returns");
    assert.equal(canceled, false, "Delayed agent event must reach its target");
    assert.deepEqual(h.replayed, [], "Agent ArrowRight must not enter the user's replay stream");
    assert.equal(h.plain.value, "seed");
    assert.equal(h.plain.selectionStart, 4);
  });

  for (const kind of ["editor", "input", "terminal"] as const) {
    it(`replays user printable text to the original ${kind} while a modal keeps focus`, async () => {
      const h = makeHarness(kind);
      await h.modalInput(["j"]);
      if (kind === "editor") {
        assert.equal(h.text(), "seedj", "CodeMirror must receive an editor transaction");
        assert.ok(h.editorTransactions.some((transaction) => transaction.changes));
      } else if (kind === "input") {
        assert.equal(h.plain.value, "seedj");
      } else {
        assert.equal(h.terminalBytes.join(""), "j", "Terminal input must reach the PTY adapter");
        assert.equal(h.terminal.value, "seed", "Changing the helper textarea is not terminal delivery");
      }
    });

    it(`replays user Backspace to the original ${kind} while a modal keeps focus`, async () => {
      const h = makeHarness(kind);
      await h.modalInput(["Backspace"]);
      if (kind === "editor") assert.equal(h.text(), "see");
      else if (kind === "input") assert.equal(h.plain.value, "see");
      else {
        assert.equal(h.terminalBytes.join(""), "\x7f", "Backspace must reach the PTY as DEL");
        assert.equal(h.terminal.value, "seed");
      }
    });
  }

  it("replaces the original CodeMirror selection and applies Backspace in order without refocusing", async () => {
    const h = makeHarness("editor");
    h.select(1, 3);
    await h.modalInput(["j", "Backspace", "k"]);
    assert.equal(h.text(), "skd");
  });
});
