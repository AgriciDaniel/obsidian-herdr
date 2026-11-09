// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Daniel Agrici. Part of the UI control module, ported from Obsidian Control Center.
// See src/control/LICENSE and the NOTICE file in the repository root.

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

export type UiTarget = { selector: string } | { x: number; y: number };

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

export interface InspectedElement {
  selector: string;
  tag: string;
  role: string | null;
  label: string;
  text: string;
  value?: string;
  disabled: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

export interface FocusState {
  tag: string | null;
  label: string;
  editable: boolean;
  password: boolean;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function base64FromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/**
 * Lets agents see and operate the Obsidian window through Electron's own
 * capture and trusted input APIs. Runs inside the renderer, so it needs no
 * official CLI, remote debugging port, or vault identity check.
 */
export class UiControlService {
  private readonly win: Window;
  private readonly getWebContents: () => WebContentsLike | null;
  private readonly platform: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: {
    win: Window;
    getWebContents: () => WebContentsLike | null;
    platform?: string;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.win = options.win;
    this.getWebContents = options.getWebContents;
    this.platform = options.platform ?? process.platform;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => this.win.setTimeout(resolve, ms)));
  }

  isAvailable(): boolean {
    try {
      return this.getWebContents() !== null;
    } catch {
      return false;
    }
  }

  async screenshot(params: Record<string, unknown> = {}): Promise<unknown> {
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
  }

  inspect(params: Record<string, unknown> = {}): unknown {
    const selector =
      typeof params.selector === "string" && params.selector.trim()
        ? params.selector
        : DEFAULT_INSPECT_SELECTOR;
    const limit = Math.min(200, Math.max(1, Math.round(num(params.limit, 80))));
    const matchText = typeof params.text === "string" && params.text ? params.text : null;
    return this.collect(selector, limit, matchText);
  }

  async waitFor(params: Record<string, unknown> = {}): Promise<unknown> {
    const text = typeof params.text === "string" ? params.text : "";
    if (!text) {
      throw new UiControlError("invalid_params", "ui.wait_for needs non-empty 'text'.");
    }
    const selector = typeof params.selector === "string" && params.selector.trim() ? params.selector : null;
    const timeoutMs = Math.min(MAX_WAIT_MS, Math.max(0, Math.round(num(params.timeoutMs, 5000))));
    const started = Date.now();
    for (;;) {
      const doc = this.win.document;
      // Match against the full visible text first, then collect bounded element previews.
      const found = selector
        ? this.collect(selector, 20, text).total > 0
        : (doc.body?.innerText ?? "").includes(text);
      if (found) {
        return {
          found: true,
          elapsedMs: Date.now() - started,
          matches: this.collect(selector ?? "body *", 20, text, true).elements,
        };
      }
      if (Date.now() - started >= timeoutMs) {
        return { found: false, elapsedMs: Date.now() - started, matches: [] };
      }
      await this.sleep(200);
    }
  }

  click(params: Record<string, unknown>): Promise<unknown> {
    return this.serialize(() => this.clickNow(params));
  }

  private async clickNow(params: Record<string, unknown>): Promise<unknown> {
    const wc = this.requireWebContents();
    const point = this.resolveTarget(params.target);
    const button = params.button === "right" || params.button === "middle" ? params.button : "left";
    const count = Math.min(3, Math.max(1, Math.round(num(params.count, 1))));
    const at = this.toWindowPoint(wc, point);
    wc.sendInputEvent({ type: "mouseMove", ...at });
    for (let i = 1; i <= count; i += 1) {
      try {
        wc.sendInputEvent({ type: "mouseDown", ...at, button, clickCount: i });
      } finally {
        wc.sendInputEvent({ type: "mouseUp", ...at, button, clickCount: i });
      }
    }
    await this.sleep(100);
    return { dispatched: true, point, button, count, focus: this.focusState() };
  }

  type(params: Record<string, unknown>): Promise<unknown> {
    const text = typeof params.text === "string" ? params.text : "";
    if (!text) {
      return Promise.reject(new UiControlError("invalid_params", "ui.type needs non-empty 'text'."));
    }
    if (text.length > MAX_TYPE_CHARS) {
      return Promise.reject(
        new UiControlError("invalid_params", `ui.type accepts at most ${MAX_TYPE_CHARS} characters per call.`)
      );
    }
    return this.serialize(async (): Promise<unknown> => {
      if (params.target !== undefined) {
        await this.clickNow({ target: params.target });
      }
      const focus = this.focusState();
      if (!focus.editable || focus.password) {
        throw new UiControlError(
          "ui_not_editable",
          "Focus an editable text field before typing. Password fields are excluded."
        );
      }
      await this.requireWebContents().insertText(text);
      await this.sleep(80);
      return { dispatched: true, characters: text.length, focus: this.focusState() };
    });
  }

  pressKey(params: Record<string, unknown>): Promise<unknown> {
    return this.serialize(async () => {
      const wc = this.requireWebContents();
      const key = typeof params.key === "string" ? params.key : "";
      const modifiers = Array.isArray(params.modifiers) ? params.modifiers.map(String) : [];
      let press;
      try {
        press = buildKeyPress(key, modifiers, this.platform);
      } catch (err) {
        throw new UiControlError("invalid_params", err instanceof Error ? err.message : String(err));
      }
      try {
        wc.sendInputEvent({ type: "keyDown", keyCode: press.keyCode, modifiers: press.modifiers });
        if (press.text !== null) {
          wc.sendInputEvent({ type: "char", keyCode: press.text, modifiers: press.modifiers });
        }
      } finally {
        wc.sendInputEvent({ type: "keyUp", keyCode: press.keyCode, modifiers: press.modifiers });
      }
      await this.sleep(80);
      return { dispatched: true, key, modifiers: press.modifiers, focus: this.focusState() };
    });
  }

  scroll(params: Record<string, unknown>): Promise<unknown> {
    return this.serialize(async () => {
      const wc = this.requireWebContents();
      const point = this.resolveTarget(params.target);
      const deltaX = num(params.deltaX, 0);
      const deltaY = num(params.deltaY, 0);
      if (deltaX === 0 && deltaY === 0) {
        throw new UiControlError("invalid_params", "ui.scroll needs a non-zero deltaX or deltaY.");
      }
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
      await this.sleep(180);
      return { dispatched: true, point, deltaX, deltaY };
    });
  }

  drag(params: Record<string, unknown>): Promise<unknown> {
    return this.serialize(async () => {
      const wc = this.requireWebContents();
      const start = this.resolveTarget(params.from);
      const end = this.resolveTarget(params.to);
      const steps = Math.min(60, Math.max(1, Math.round(num(params.steps, 12))));
      const from = this.toWindowPoint(wc, start);
      const to = this.toWindowPoint(wc, end);
      let last = from;
      wc.sendInputEvent({ type: "mouseMove", ...from });
      try {
        wc.sendInputEvent({ type: "mouseDown", ...from, button: "left", clickCount: 1 });
        for (let i = 1; i <= steps; i += 1) {
          const next = {
            x: Math.round(from.x + ((to.x - from.x) * i) / steps),
            y: Math.round(from.y + ((to.y - from.y) * i) / steps),
          };
          wc.sendInputEvent({ type: "mouseMove", ...next, modifiers: ["leftButtonDown"] });
          last = next;
          await this.sleep(16);
        }
      } finally {
        wc.sendInputEvent({ type: "mouseUp", ...last, button: "left", clickCount: 1 });
      }
      await this.sleep(100);
      return { dispatched: true, from: start, to: end, steps };
    });
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
        parts.unshift(`#${CSS.escape(node.id)}`);
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
      return {
        selector: this.selectorPath(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        label: el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "",
        text: textOf(el).trim().slice(0, 180),
        ...(isField ? { value: field.value } : {}),
        disabled: Boolean(field.disabled),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      };
    });
    return { viewport: this.viewport(), total: all.length, truncated: all.length > elements.length, elements };
  }

  /** Resolves a selector or CSS-pixel point, requiring one visible, enabled, uncovered element. */
  private resolveTarget(raw: unknown): { x: number; y: number } {
    if (!raw || typeof raw !== "object") {
      throw new UiControlError("invalid_params", "Target must be {selector} or {x, y} in CSS pixels.");
    }
    const target = raw as Record<string, unknown>;
    let x: number;
    let y: number;
    if (typeof target.selector === "string" && target.selector.trim()) {
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
    return { x, y };
  }
}
