import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { performDrag, type DragWebContentsLike, type DragWindowLike } from "../src/control/html-drag";

interface RecordedDomEvent {
  type: string;
  target: MockDomElement;
  currentTarget: MockDomElement;
  clientX: number;
  clientY: number;
  dataTransfer: unknown;
  defaultPrevented: boolean;
}

type Listener = (ev: MockDragDomEvent) => void;

class MockDragDomEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly composed: boolean;
  readonly clientX: number;
  readonly clientY: number;
  readonly screenX: number;
  readonly screenY: number;
  dataTransfer: unknown;
  target: MockDomElement | null = null;
  currentTarget: MockDomElement | null = null;
  defaultPrevented = false;
  propagationStopped = false;

  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== false;
    this.cancelable = init.cancelable !== false;
    this.composed = init.composed !== false;
    this.clientX = typeof init.clientX === "number" ? init.clientX : 0;
    this.clientY = typeof init.clientY === "number" ? init.clientY : 0;
    this.screenX = typeof init.screenX === "number" ? init.screenX : this.clientX;
    this.screenY = typeof init.screenY === "number" ? init.screenY : this.clientY;
    this.dataTransfer = init.dataTransfer ?? null;
  }

  preventDefault(): void {
    if (this.cancelable) {
      this.defaultPrevented = true;
    }
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

class MockDomElement {
  readonly tagName = "DIV";
  readonly id: string;
  readonly classSet: Set<string>;
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  parentElement: MockDomElement | null = null;
  draggable = false;
  isConnected = true;

  constructor(id: string, classes: string[] = [], attrs: Record<string, string> = {}) {
    this.id = id;
    this.classSet = new Set(classes);
    for (const [k, v] of Object.entries(attrs)) {
      this.attrs.set(k, v);
      if (k === "draggable" && v === "true") {
        this.draggable = true;
      }
    }
  }

  appendChild(child: MockDomElement): MockDomElement {
    child.parentElement = this;
    return child;
  }

  get classList(): { contains(name: string): boolean } {
    return {
      contains: (name: string) => this.classSet.has(name),
    };
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  matches(selector: string): boolean {
    const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.some((part) => {
      if (part === '[draggable="true"]') {
        return this.draggable || this.attrs.get("draggable") === "true";
      }
      if (part.startsWith(".")) {
        return this.classSet.has(part.slice(1));
      }
      return false;
    });
  }

  closest(selector: string): MockDomElement | null {
    let cur: MockDomElement | null = this;
    while (cur) {
      if (cur.matches(selector)) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatchEvent(ev: MockDragDomEvent): boolean {
    ev.target = this;
    let cur: MockDomElement | null = this;
    while (cur) {
      ev.currentTarget = cur;
      const list = cur.listeners.get(ev.type) ?? [];
      for (const fn of list) {
        fn(ev);
      }
      if (!ev.bubbles || ev.propagationStopped) {
        break;
      }
      cur = cur.parentElement;
    }
    return !ev.defaultPrevented;
  }
}

function createMockEnv(elementFromPointImpl?: (x: number, y: number) => MockDomElement | null) {
  const body = new MockDomElement("body");
  const win: DragWindowLike = {
    document: {
      body: body as unknown as Element,
      documentElement: body as unknown as Element,
      elementFromPoint: (x: number, y: number) =>
        (elementFromPointImpl ? elementFromPointImpl(x, y) : null) as unknown as Element | null,
    },
    DragEvent: MockDragDomEvent,
    Event: MockDragDomEvent,
  };
  const mouseEvents: Array<Record<string, unknown>> = [];
  const wc: DragWebContentsLike = {
    sendInputEvent: (ev) => {
      mouseEvents.push(ev);
    },
  };
  return { body, win, wc, mouseEvents };
}

describe("html-drag: HTML5 drag-and-drop and pointer-event drags", () => {
  it("dispatches full HTML5 sequence with one shared DataTransfer for File Explorer move", async () => {
    const { body, win, wc, mouseEvents } = createMockEnv();
    const explorer = new MockDomElement("explorer", ["nav-files-container"]);
    const fileTitle = new MockDomElement("file-row", ["nav-file-title"], { draggable: "true" });
    const fileLabel = new MockDomElement("file-label", ["nav-file-title-content"]);
    const folderTitle = new MockDomElement("folder-row", ["nav-folder-title"], { draggable: "true" });
    body.appendChild(explorer);
    explorer.appendChild(fileTitle);
    fileTitle.appendChild(fileLabel);
    explorer.appendChild(folderTitle);

    const log: RecordedDomEvent[] = [];
    let droppedPayload = "";
    const seenDataTransfers = new Set<unknown>();

    const record = (ev: MockDragDomEvent) => {
      seenDataTransfers.add(ev.dataTransfer);
      log.push({
        type: ev.type,
        target: ev.target as MockDomElement,
        currentTarget: ev.currentTarget as MockDomElement,
        clientX: ev.clientX,
        clientY: ev.clientY,
        dataTransfer: ev.dataTransfer,
        defaultPrevented: ev.defaultPrevented,
      });
    };

    fileTitle.addEventListener("dragstart", (ev) => {
      const dt = ev.dataTransfer as {
        effectAllowed: string;
        setData(format: string, data: string): void;
      };
      dt.effectAllowed = "move";
      dt.setData("text/plain", "Crew Test/Audit/note.md");
      record(ev);
    });
    fileTitle.addEventListener("drag", record);
    fileTitle.addEventListener("dragend", record);
    folderTitle.addEventListener("dragenter", record);
    folderTitle.addEventListener("dragover", (ev) => {
      const dt = ev.dataTransfer as { dropEffect: string };
      dt.dropEffect = "move";
      ev.preventDefault();
      record(ev);
    });
    folderTitle.addEventListener("drop", (ev) => {
      const dt = ev.dataTransfer as { getData(format: string): string };
      droppedPayload = dt.getData("text/plain");
      ev.preventDefault();
      record(ev);
    });

    const stepPoints: Array<{ x: number; y: number; isLast: boolean }> = [];
    const res = await performDrag({
      win,
      wc,
      from: { x: 120, y: 310 },
      to: { x: 120, y: 170 },
      toWindowPoint: (p) => ({ x: Math.round(p.x), y: Math.round(p.y) }),
      fromElement: fileLabel as unknown as Element,
      toElement: folderTitle as unknown as Element,
      steps: 3,
      stepDelayMs: 0,
      dropSettleMs: 0,
      onStep: (pt, isLast) => stepPoints.push({ x: pt.x, y: pt.y, isLast }),
    });

    assert.equal(res.mode, "html5");
    assert.equal(res.dispatched, true);
    assert.equal(res.dropped, true);
    assert.equal(res.canceled, false);
    assert.equal(mouseEvents.length, 0, "HTML5 drag must not emit Electron mouse events");
    assert.equal(droppedPayload, "Crew Test/Audit/note.md");
    assert.equal(seenDataTransfers.size, 1, "All HTML5 drag events must share one DataTransfer instance");
    assert.equal(stepPoints.length, 3);

    const types = log.map((e) => e.type);
    assert.equal(types[0], "dragstart");
    assert.ok(types.includes("dragenter"));
    assert.ok(types.includes("dragover"));
    assert.ok(types.includes("drop"));
    assert.equal(types.at(-1), "dragend");
    assert.ok(types.indexOf("dragstart") < types.indexOf("dragenter"));
    assert.ok(types.indexOf("dragenter") < types.indexOf("dragover"));
    assert.ok(types.indexOf("dragover") < types.indexOf("drop"));
    assert.ok(types.indexOf("drop") < types.indexOf("dragend"));

    const startEv = log.find((e) => e.type === "dragstart");
    assert.equal(startEv?.target, fileTitle, "dragstart must fire on resolved draggable ancestor");
    assert.equal(startEv?.clientX, 120);
    assert.equal(startEv?.clientY, 310);

    const dropEv = log.find((e) => e.type === "drop");
    assert.equal(dropEv?.target, folderTitle);
    assert.equal(dropEv?.clientX, 120);
    assert.equal(dropEv?.clientY, 170);
  });

  it("reorders tabs via HTML5 events resolved from elementFromPoint and preserves clientX/clientY", async () => {
    const tabHeaderContainer = new MockDomElement("tab-container", ["workspace-tab-header-container"]);
    const tabA = new MockDomElement("tab-a", ["workspace-tab-header"], { draggable: "true" });
    const tabATitle = new MockDomElement("tab-a-title", ["workspace-tab-header-inner-title"]);
    const tabB = new MockDomElement("tab-b", ["workspace-tab-header"], { draggable: "true" });
    const tabBTitle = new MockDomElement("tab-b-title", ["workspace-tab-header-inner-title"]);
    tabHeaderContainer.appendChild(tabA);
    tabA.appendChild(tabATitle);
    tabHeaderContainer.appendChild(tabB);
    tabB.appendChild(tabBTitle);

    const { win, wc } = createMockEnv((x, y) => {
      if (x >= 452 && x <= 652 && y >= 6 && y <= 40) return tabATitle;
      if (x >= 652 && x <= 852 && y >= 6 && y <= 40) return tabBTitle;
      return tabHeaderContainer;
    });

    let dropClientX = -1;
    let reordered = false;
    tabB.addEventListener("dragstart", (ev) => {
      (ev.dataTransfer as { setData(f: string, v: string): void }).setData("obsidian/tab", "tab-b");
    });
    tabHeaderContainer.addEventListener("dragover", (ev) => {
      ev.preventDefault();
    });
    tabHeaderContainer.addEventListener("drop", (ev) => {
      const payload = (ev.dataTransfer as { getData(f: string): string }).getData("obsidian/tab");
      dropClientX = ev.clientX;
      if (payload === "tab-b" && ev.target === tabATitle && ev.clientX < 552) {
        reordered = true;
      }
      ev.preventDefault();
    });

    const res = await performDrag({
      win,
      wc,
      from: { x: 752, y: 23 },
      to: { x: 470, y: 23 },
      toWindowPoint: (p) => p,
      steps: 2,
      stepDelayMs: 0,
      dropSettleMs: 0,
    });

    assert.equal(res.mode, "html5");
    assert.equal(res.dropped, true);
    assert.equal(dropClientX, 470);
    assert.equal(reordered, true, "Tab reorder drop must bubble with destination clientX");
  });

  it("skips drop when dragover does not call preventDefault, and cancels cleanly when dragstart prevents default", async () => {
    const { win, wc } = createMockEnv();
    const src = new MockDomElement("src", ["nav-file-title"], { draggable: "true" });
    const dst = new MockDomElement("dst", ["nav-folder-title"], { draggable: "true" });

    const seen: string[] = [];
    src.addEventListener("dragstart", () => seen.push("dragstart"));
    src.addEventListener("dragend", () => seen.push("dragend"));
    dst.addEventListener("dragenter", () => seen.push("dragenter"));
    dst.addEventListener("dragover", () => seen.push("dragover"));
    dst.addEventListener("drop", () => seen.push("drop"));

    const rejected = await performDrag({
      win,
      wc,
      from: { x: 10, y: 10 },
      to: { x: 50, y: 50 },
      toWindowPoint: (p) => p,
      fromElement: src as unknown as Element,
      toElement: dst as unknown as Element,
      steps: 2,
      stepDelayMs: 0,
      dropSettleMs: 0,
    });
    assert.equal(rejected.dropped, false);
    assert.equal(rejected.canceled, false);
    assert.equal(seen.includes("drop"), false);
    assert.equal(seen.at(-1), "dragend");

    seen.length = 0;
    const srcCancel = new MockDomElement("src2", ["nav-file-title"], { draggable: "true" });
    srcCancel.addEventListener("dragstart", (ev) => {
      seen.push("dragstart");
      ev.preventDefault();
    });
    srcCancel.addEventListener("dragend", () => seen.push("dragend"));
    dst.addEventListener("dragenter", () => seen.push("dragenter"));
    const canceled = await performDrag({
      win,
      wc,
      from: { x: 10, y: 10 },
      to: { x: 50, y: 50 },
      toWindowPoint: (p) => p,
      fromElement: srcCancel as unknown as Element,
      toElement: dst as unknown as Element,
      steps: 2,
      stepDelayMs: 0,
      dropSettleMs: 0,
    });
    assert.equal(canceled.canceled, true);
    assert.equal(canceled.dropped, false);
    assert.deepEqual(seen, ["dragstart", "dragend"]);
  });

  it("aborts HTML5 drag safely on onBeforeStep error without firing drop and still firing dragend", async () => {
    const { win, wc } = createMockEnv();
    const src = new MockDomElement("src", ["nav-file-title"], { draggable: "true" });
    const dst = new MockDomElement("dst", ["nav-folder-title"], { draggable: "true" });
    const seen: Array<{ type: string; x: number }> = [];
    src.addEventListener("dragstart", (ev) => seen.push({ type: ev.type, x: ev.clientX }));
    src.addEventListener("dragend", (ev) => seen.push({ type: ev.type, x: ev.clientX }));
    dst.addEventListener("dragover", (ev) => ev.preventDefault());
    dst.addEventListener("drop", (ev) => seen.push({ type: ev.type, x: ev.clientX }));

    await assert.rejects(
      () =>
        performDrag({
          win,
          wc,
          from: { x: 10, y: 10 },
          to: { x: 110, y: 10 },
          toWindowPoint: (p) => p,
          fromElement: src as unknown as Element,
          toElement: dst as unknown as Element,
          steps: 2,
          stepDelayMs: 0,
          dropSettleMs: 0,
          onBeforeStep: (pt) => {
            if (pt.x > 70) {
              throw new Error("protected");
            }
          },
        }),
      /protected/
    );
    assert.equal(seen.some((e) => e.type === "drop"), false);
    assert.equal(seen.at(-1)?.type, "dragend");
    assert.equal(seen.at(-1)?.x, 60, "dragend must report last safe step coordinate");
  });

  it("uses pointer mode with hover settle, button state, intermediate steps, and mouseUp for Canvas nodes", async () => {
    const canvasNode = new MockDomElement("card", ["canvas-node"]);
    const { win, wc, mouseEvents } = createMockEnv(() => canvasNode);
    const timeline: string[] = [];
    const trackingWc: DragWebContentsLike = {
      sendInputEvent: (ev) => {
        mouseEvents.push(ev);
        timeline.push(String(ev.type));
      },
    };

    const res = await performDrag({
      win,
      wc: trackingWc,
      from: { x: 700, y: 380 },
      to: { x: 940, y: 520 },
      toWindowPoint: (p) => ({ x: Math.round(p.x), y: Math.round(p.y) }),
      fromElement: canvasNode as unknown as Element,
      stepDelayMs: 12,
      dropSettleMs: 0,
      sleep: async (ms) => {
        timeline.push(`sleep:${ms}`);
      },
    });

    assert.equal(res.mode, "pointer");
    assert.equal(res.dropped, true);
    assert.ok(res.steps >= 16, `Expected >= 16 smooth intermediate steps when omitted, got ${res.steps}`);
    assert.equal(mouseEvents[0].type, "mouseMove");
    assert.equal(mouseEvents[1].type, "mouseDown");
    assert.equal(mouseEvents[1].button, "left");
    assert.deepEqual(mouseEvents[1].modifiers, ["leftButtonDown"]);

    const moveEvents = mouseEvents.slice(2, -1);
    assert.equal(moveEvents.length, res.steps);
    for (const mv of moveEvents) {
      assert.equal(mv.type, "mouseMove");
      assert.deepEqual(mv.modifiers, ["leftButtonDown"]);
    }
    assert.equal(mouseEvents.at(-1)?.type, "mouseUp");
    assert.equal(mouseEvents.at(-1)?.button, "left");
    assert.equal(mouseEvents.at(-1)?.x, 940);
    assert.equal(mouseEvents.at(-1)?.y, 520);

    // Ensure hover settle and post-mouseDown settle happened before first dragged mouseMove.
    assert.equal(timeline[0], "mouseMove");
    assert.equal(timeline[1], "sleep:12");
    assert.equal(timeline[2], "mouseDown");
    assert.equal(timeline[3], "sleep:12");
    assert.equal(timeline[4], "mouseMove");
  });

  it("honors explicit steps in pointer mode and releases mouseUp at last safe step on abort", async () => {
    const canvasNode = new MockDomElement("card", ["canvas-node"]);
    const { win, wc, mouseEvents } = createMockEnv(() => canvasNode);

    await assert.rejects(
      () =>
        performDrag({
          win,
          wc,
          from: { x: 50, y: 100 },
          to: { x: 450, y: 100 },
          toWindowPoint: (p) => ({ x: Math.round(p.x), y: Math.round(p.y) }),
          fromElement: canvasNode as unknown as Element,
          steps: 4,
          stepDelayMs: 0,
          dropSettleMs: 0,
          onBeforeStep: (pt) => {
            if (pt.x >= 240) {
              throw new Error("protected");
            }
          },
        }),
      /protected/
    );

    const draggedMoves = mouseEvents.filter(
      (ev) => ev.type === "mouseMove" && Array.isArray(ev.modifiers) && ev.modifiers.includes("leftButtonDown")
    );
    assert.equal(draggedMoves.length, 1);
    assert.equal(mouseEvents.at(-1)?.type, "mouseUp");
    assert.equal(mouseEvents.at(-1)?.x, 150);
  });

  it("falls back to plain Event and DataTransfer polyfill with format normalization when DragEvent is absent", async () => {
    const src = new MockDomElement("tab-src", ["workspace-tab-header"]);
    const dst = new MockDomElement("tab-dst", ["workspace-tab-header"]);
    const plainWin: DragWindowLike = {
      document: {
        body: dst as unknown as Element,
        elementFromPoint: () => null,
      },
      Event: class PlainEvent {
        readonly type: string;
        readonly bubbles: boolean;
        readonly cancelable: boolean;
        defaultPrevented = false;
        constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean } = {}) {
          this.type = type;
          this.bubbles = Boolean(init.bubbles);
          this.cancelable = Boolean(init.cancelable);
        }
        preventDefault(): void {
          if (this.cancelable) this.defaultPrevented = true;
        }
      },
    };
    const wc: DragWebContentsLike = { sendInputEvent: () => undefined };

    let readUrl = "";
    let readText = "";
    let typesSnapshot: string[] = [];
    src.addEventListener("dragstart", (ev) => {
      const dt = ev.dataTransfer as {
        setData(f: string, v: string): void;
        clearData(f?: string): void;
        types: string[];
      };
      dt.setData("TEXT", "hello");
      dt.setData("url", "obsidian://open?vault=Obsidian-herdr");
      dt.setData("application/x-temp", "dropme");
      dt.clearData("application/x-temp");
      typesSnapshot = dt.types;
    });
    dst.addEventListener("dragover", (ev) => ev.preventDefault());
    dst.addEventListener("drop", (ev) => {
      const dt = ev.dataTransfer as { getData(f: string): string };
      readText = dt.getData("text/plain");
      readUrl = dt.getData("text/uri-list");
      ev.preventDefault();
    });

    const res = await performDrag({
      win: plainWin,
      wc,
      from: { x: 20, y: 20 },
      to: { x: 80, y: 20 },
      toWindowPoint: (p) => p,
      fromElement: src as unknown as Element,
      toElement: dst as unknown as Element,
      steps: 1,
      stepDelayMs: 0,
      dropSettleMs: 0,
    });

    assert.equal(res.mode, "html5");
    assert.equal(res.dropped, true);
    assert.equal(readText, "hello");
    assert.equal(readUrl, "obsidian://open?vault=Obsidian-herdr");
    assert.deepEqual(typesSnapshot.sort(), ["text/plain", "text/uri-list"]);
  });

  it("revalidates onBeforeStep before dragenter/dragover/drop after final step sleep and during dragover DOM shifts (P1-1)", async () => {
    // 1. Covering overlay appears during the final step delay before dragenter/dragover/drop.
    {
      const { win, wc } = createMockEnv();
      const src = new MockDomElement("src", ["nav-file-title"], { draggable: "true" });
      const dst = new MockDomElement("dst", ["nav-folder-title"], { draggable: "true" });
      const seen: string[] = [];
      let coveredDuringFinalSleep = false;

      src.addEventListener("dragstart", () => seen.push("dragstart"));
      src.addEventListener("dragend", () => seen.push("dragend"));
      dst.addEventListener("dragenter", () => seen.push("dragenter"));
      dst.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        seen.push("dragover");
      });
      dst.addEventListener("drop", () => seen.push("drop"));

      await assert.rejects(
        () =>
          performDrag({
            win,
            wc,
            from: { x: 10, y: 10 },
            to: { x: 110, y: 10 },
            toWindowPoint: (p) => p,
            fromElement: src as unknown as Element,
            toElement: dst as unknown as Element,
            steps: 2,
            stepDelayMs: 5,
            dropSettleMs: 0,
            sleep: async () => {
              coveredDuringFinalSleep = true;
            },
            onBeforeStep: (_pt, isLast) => {
              if (isLast && coveredDuringFinalSleep) {
                throw new Error("protected");
              }
            },
          }),
        /protected/
      );

      assert.equal(seen.includes("dragenter"), false);
      assert.equal(seen.includes("dragover"), false);
      assert.equal(seen.includes("drop"), false);
      assert.equal(seen.at(-1), "dragend");
    }

    // 2. Overlay appears inside dragover handler before drop executes.
    {
      const { win, wc } = createMockEnv();
      const src = new MockDomElement("src2", ["nav-file-title"], { draggable: "true" });
      const dst = new MockDomElement("dst2", ["nav-folder-title"], { draggable: "true" });
      const seen: string[] = [];
      let coveredDuringDragover = false;

      src.addEventListener("dragstart", () => seen.push("dragstart"));
      src.addEventListener("dragend", () => seen.push("dragend"));
      dst.addEventListener("dragenter", () => seen.push("dragenter"));
      dst.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        seen.push("dragover");
        coveredDuringDragover = true;
      });
      dst.addEventListener("drop", () => seen.push("drop"));

      await assert.rejects(
        () =>
          performDrag({
            win,
            wc,
            from: { x: 10, y: 10 },
            to: { x: 110, y: 10 },
            toWindowPoint: (p) => p,
            fromElement: src as unknown as Element,
            toElement: dst as unknown as Element,
            steps: 1,
            stepDelayMs: 0,
            dropSettleMs: 0,
            onBeforeStep: () => {
              if (coveredDuringDragover) {
                throw new Error("protected");
              }
            },
          }),
        /protected/
      );

      assert.equal(seen.includes("drop"), false);
      assert.equal(seen.at(-1), "dragend");
    }
  });
});
