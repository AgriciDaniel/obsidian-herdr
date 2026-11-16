import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import type { App } from "obsidian";
import {
  buildBridgeEnvForPanes,
  computeRuntimePaths,
  provisionRuntimeKit,
} from "../src/bridge/runtime-kit";
import { VaultBridgeServer } from "../src/bridge/vault-bridge-server";
import { BridgeRpcError, VaultOpsService } from "../src/bridge/vault-ops";
import { AgentCursorOverlay } from "../src/control/agent-cursor";
import { buildKeyPress } from "../src/control/keys";
import {
  type NativeImageLike,
  UiControlError,
  UiControlService,
  type UiMutationCompletion,
  type UiMutationContext,
  type WebContentsLike,
} from "../src/control/ui-control";
import type { VaultPermissionMode } from "../src/domain/types";
import { createMockObsidianApp } from "./obsidian-mock";

const execFileAsync = promisify(execFile);

function extractScrollEffectPos(spec: Record<string, unknown>): number | null {
  const rawEffects = spec.effects;
  const list = Array.isArray(rawEffects) ? rawEffects : rawEffects ? [rawEffects] : [];
  for (const eff of list) {
    const val = (eff as { value?: { range?: { from?: unknown } } } | null)?.value;
    if (typeof val?.range?.from === "number") {
      return val.range.from;
    }
  }
  return null;
}

const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

function fakeImage(width: number, height: number): NativeImageLike {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => new Uint8Array(PNG_BYTES),
    resize: (opts) => fakeImage(opts.width, Math.round((height * opts.width) / width)),
  };
}

function fakeWebContents(events: Array<Record<string, unknown>>, typed: string[]): WebContentsLike {
  return {
    capturePage: () => Promise.resolve(fakeImage(2400, 1600)),
    sendInputEvent: (event) => {
      events.push(event);
    },
    insertText: (text) => {
      typed.push(text);
      return Promise.resolve();
    },
    getZoomFactor: () => 1,
  };
}

function fakeWindow(activeElement: unknown = null): Window {
  const doc = {
    activeElement,
    body: { innerText: "Mission Control ready" },
    documentElement: {},
    querySelectorAll: () => [],
    elementFromPoint: () => null,
  };
  return {
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 2,
    document: doc,
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    requestAnimationFrame: (fn: () => void) => {
      fn();
      return 0;
    },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  } as unknown as Window;
}

function editableField(): unknown {
  return {
    tagName: "TEXTAREA",
    readOnly: false,
    disabled: false,
    isContentEditable: false,
    matches: (sel: string) => !sel.includes("password") && sel.includes("textarea"),
    getAttribute: () => null,
  };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe("UI control: keys, Electron input, permission gating, CLI, and MCP images", () => {
  it("maps keys and modifiers to Electron input, with Mod per platform", () => {
    assert.deepEqual(buildKeyPress("Enter"), { keyCode: "Enter", text: "\r", modifiers: [] });
    assert.deepEqual(buildKeyPress("p", ["Mod"], "linux"), {
      keyCode: "P",
      text: null,
      modifiers: ["control"],
    });
    assert.deepEqual(buildKeyPress("p", ["Mod"], "darwin").modifiers, ["meta"]);
    assert.deepEqual(buildKeyPress("a", ["Shift"]), { keyCode: "A", text: "A", modifiers: ["shift"] });
    assert.deepEqual(buildKeyPress("ArrowDown"), { keyCode: "Down", text: null, modifiers: [] });
    assert.throws(() => buildKeyPress("F13"), /Unsupported key/);
    assert.throws(() => buildKeyPress("a", ["Hyper"]), /Unknown modifier/);
  });

  it("captures screenshots, sends paired input, flips wheel sign, and refuses unsafe targets", async () => {
    const events: Array<Record<string, unknown>> = [];
    const typed: string[] = [];
    const ui = new UiControlService({
      win: fakeWindow(editableField()),
      getWebContents: () => fakeWebContents(events, typed),
      platform: "linux",
      sleep: noSleep,
    });

    const shot = (await ui.screenshot({ maxWidth: 1200 })) as {
      image: { mimeType: string; data: string };
      width: number;
      cssPixelsPerImagePixel: { x: number };
    };
    assert.equal(shot.image.mimeType, "image/png");
    assert.deepEqual(Buffer.from(shot.image.data, "base64"), PNG_BYTES);
    assert.equal(shot.width, 1200);
    assert.equal(shot.cssPixelsPerImagePixel.x, 1);

    await ui.click({ target: { x: 100, y: 50 }, count: 2 });
    assert.deepEqual(
      events.map((e) => e.type),
      ["mouseMove", "mouseDown", "mouseUp", "mouseDown", "mouseUp"]
    );
    assert.equal(events[3].clickCount, 2);

    events.length = 0;
    await ui.pressKey({ key: "p", modifiers: ["Mod", "Shift"] });
    assert.deepEqual(
      events.map((e) => [e.type, e.keyCode]),
      [
        ["keyDown", "P"],
        ["keyUp", "P"],
      ]
    );
    assert.deepEqual(events[0].modifiers, ["shift", "control"]);

    events.length = 0;
    await ui.scroll({ target: { x: 10, y: 10 }, deltaY: 300 });
    assert.equal(events[1].type, "mouseWheel");
    assert.equal(events[1].deltaY, -300, "Positive deltaY (down) maps to Electron's negative wheel delta");

    events.length = 0;
    await ui.drag({ from: { x: 10, y: 10 }, to: { x: 110, y: 10 }, steps: 4 });
    assert.equal(events[0].type, "mouseMove");
    assert.equal(events[1].type, "mouseDown");
    assert.equal(events.at(-1)?.type, "mouseUp");
    assert.equal(events.at(-1)?.x, 110);

    await ui.type({ text: "Hello ✓" });
    assert.equal(typed.join(""), "Hello ✓");
    assert.ok(typed.length >= 2, "Multi-word text types in small chunks");

    await assert.rejects(ui.click({ target: { x: 5000, y: 5 } }), (err: unknown) => {
      return err instanceof UiControlError && err.code === "ui_target_outside";
    });
    await assert.rejects(ui.click({ target: { selector: ".missing" } }), (err: unknown) => {
      return err instanceof UiControlError && err.code === "ui_target_ambiguous";
    });

    const waited = (await ui.waitFor({ text: "Mission Control", timeoutMs: 0 })) as { found: boolean };
    assert.equal(waited.found, true);
    const missing = (await ui.waitFor({ text: "Nope", timeoutMs: 0 })) as { found: boolean };
    assert.equal(missing.found, false);

    const noFocus = new UiControlService({
      win: fakeWindow(null),
      getWebContents: () => fakeWebContents([], typed),
      sleep: noSleep,
    });
    await assert.rejects(noFocus.type({ text: "x" }), (err: unknown) => {
      return err instanceof UiControlError && err.code === "ui_not_editable";
    });

    const passwordFocus = new UiControlService({
      win: fakeWindow({ ...(editableField() as object), tagName: "INPUT", matches: () => true }),
      getWebContents: () => fakeWebContents([], typed),
      sleep: noSleep,
    });
    await assert.rejects(passwordFocus.type({ text: "secret" }), /Password fields are excluded/);

    const missingHost = new UiControlService({ win: fakeWindow(), getWebContents: () => null });
    assert.equal(missingHost.isAvailable(), false);
    await assert.rejects(missingHost.screenshot(), (err: unknown) => {
      return err instanceof UiControlError && err.code === "ui_unavailable";
    });
  });

  it("gates UI methods by setting and tier, audits input, and serves images over CLI and MCP", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "obs-herdr-ui-test-"));
    const vaultDir = path.join(tmpBase, "vault");
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, "Index.md"), "# Home\n", "utf8");

    let mode: VaultPermissionMode = "read-only";
    let allowUi = false;
    const events: Array<Record<string, unknown>> = [];
    const ui = new UiControlService({
      win: fakeWindow(editableField()),
      getWebContents: () => fakeWebContents(events, []),
      sleep: noSleep,
    });
    const vaultOps = new VaultOpsService({
      app: createMockObsidianApp(vaultDir, "UiVault") as unknown as App,
      getPermissionMode: () => mode,
      getAllowHiddenReads: () => false,
      uiControl: ui,
      getAllowUiControl: () => allowUi,
    });

    await assert.rejects(vaultOps.dispatch("ui.screenshot", {}), (err: unknown) => {
      return err instanceof BridgeRpcError && err.code === "ui_control_disabled";
    });

    allowUi = true;
    const info = (await vaultOps.dispatch("vault.info", {})) as {
      uiControl: { enabled: boolean; available: boolean; canObserve: boolean; canOperate: boolean };
    };
    assert.deepEqual(info.uiControl, { enabled: true, available: true, canObserve: true, canOperate: false });

    await vaultOps.dispatch("ui.screenshot", {});
    await assert.rejects(vaultOps.dispatch("ui.click", { target: { x: 1, y: 1 } }), (err: unknown) => {
      return err instanceof BridgeRpcError && err.code === "permission_denied";
    });
    mode = "read-write";
    await assert.rejects(vaultOps.dispatch("ui.type", { text: "x" }), (err: unknown) => {
      return err instanceof BridgeRpcError && err.code === "permission_denied";
    });

    mode = "full";
    await vaultOps.dispatch("ui.click", { target: { x: 1, y: 1 } }, "herdr:test");
    assert.ok(events.length > 0);
    assert.ok(vaultOps.getAuditLog().some((e) => e.method === "ui.click" && e.allowed && e.caller === "herdr:test"));
    await assert.rejects(vaultOps.dispatch("ui.press_key", { key: "F99" }), (err: unknown) => {
      return err instanceof BridgeRpcError && err.code === "invalid_params";
    });

    mode = "off";
    await assert.rejects(vaultOps.dispatch("ui.screenshot", {}), (err: unknown) => {
      return err instanceof BridgeRpcError && err.code === "permission_denied";
    });
    mode = "full";

    const kit = computeRuntimePaths(vaultDir, path.join(tmpBase, "runtime"));
    const server = new VaultBridgeServer({
      socketPath: kit.socketPath,
      dispatcher: (method, params, caller) => vaultOps.dispatch(method, params, caller),
    });
    await server.start();
    try {
      provisionRuntimeKit({ kit, token: server.getAuthToken(), vaultName: "UiVault", vaultPath: vaultDir });
      const env = {
        ...process.env,
        ...buildBridgeEnvForPanes({ kit, token: server.getAuthToken(), vaultName: "UiVault", vaultPath: vaultDir }),
      };

      // CLI saves screenshots privately next to the connection file by default.
      const shotOut = await execFileAsync(kit.cliScriptPath, ["ui", "screenshot"], { env });
      const shotJson = JSON.parse(shotOut.stdout) as { path: string; width: number };
      assert.ok(shotJson.path.startsWith(path.join(kit.runtimeDir, "screenshots")));
      assert.deepEqual(fs.readFileSync(shotJson.path), PNG_BYTES);
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(shotJson.path).mode & 0o777, 0o600);
      }

      events.length = 0;
      await execFileAsync(kit.cliScriptPath, ["ui", "key", "Mod+Shift+P"], { env });
      assert.equal(events[0].keyCode, "P");

      const corePyPath = path.join(kit.binDir, "obs-herdr-core.py");
      const pyOut = path.join(tmpBase, "py-shot.png");
      await execFileAsync("python3", [corePyPath, "ui", "screenshot", "--out", pyOut], { env });
      assert.deepEqual(fs.readFileSync(pyOut), PNG_BYTES);

      for (const [cmd, args] of [
        [kit.cliScriptPath, ["mcp"]],
        ["python3", [corePyPath, "mcp"]],
      ] as Array<[string, string[]]>) {
        const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
        const responses: Array<Record<string, unknown>> = [];
        let buf = "";
        child.stdout.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          let nl = buf.indexOf("\n");
          while (nl !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) {
              responses.push(JSON.parse(line) as Record<string, unknown>);
            }
            nl = buf.indexOf("\n");
          }
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "obsidian_screenshot", arguments: {} },
          }) + "\n"
        );
        child.stdin.end();
        const until = Date.now() + 5000;
        while (responses.length < 2 && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 40));
        }
        child.kill();
        assert.equal(responses.length, 2, `${cmd} MCP answered both requests`);
        const tools = (responses[0].result as { tools: Array<{ name: string }> }).tools;
        for (const name of [
          "obsidian_screenshot",
          "obsidian_inspect",
          "obsidian_wait_for",
          "obsidian_click",
          "obsidian_type",
          "obsidian_press_key",
          "obsidian_scroll",
          "obsidian_drag",
          "obsidian_ui_batch",
        ]) {
          assert.ok(tools.some((t) => t.name === name), `${cmd} MCP lists ${name}`);
        }
        const content = (responses[1].result as { content: Array<Record<string, string>> }).content;
        assert.equal(content[0].type, "image");
        assert.equal(content[0].mimeType, "image/png");
        assert.deepEqual(Buffer.from(content[0].data, "base64"), PNG_BYTES);
        assert.equal(content[1].type, "text");
        assert.ok(!content[1].text.includes(content[0].data), "Image data is not duplicated in text");
      }
    } finally {
      await server.stop();
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("animates parallel agent cursors and executes ui.batch atomically without interleaving", async () => {
    function makeMockEl(tag: string) {
      const classes = new Set<string>();
      const attrs = new Map<string, string>();
      const children: Array<ReturnType<typeof makeMockEl>> = [];
      const props = new Map<string, string>();
      let parentChildren: Array<ReturnType<typeof makeMockEl>> | null = null;
      const el = {
        tagName: tag.toUpperCase(),
        isConnected: true,
        offsetWidth: 24,
        textContent: "",
        children,
        classList: {
          add: (...names: string[]) => names.forEach((n) => classes.add(n)),
          remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
          contains: (name: string) => classes.has(name),
        },
        style: {
          transform: "",
          setProperty: (k: string, v: string) => props.set(k, v),
          getPropertyValue: (k: string) => props.get(k) ?? "",
        },
        setAttribute: (k: string, v: string) => attrs.set(k, v),
        getAttribute: (k: string) => attrs.get(k) ?? null,
        appendChild: (child: ReturnType<typeof makeMockEl>) => {
          children.push(child);
          return child;
        },
        remove: () => {
          el.isConnected = false;
          if (parentChildren) {
            const idx = parentChildren.indexOf(el);
            if (idx >= 0) parentChildren.splice(idx, 1);
          }
        },
        createDiv: (opts?: { cls?: string; attr?: Record<string, string> }) => {
          const child = makeMockEl("div");
          if (opts?.cls) child.classList.add(opts.cls);
          if (opts?.attr) {
            for (const [k, v] of Object.entries(opts.attr)) child.setAttribute(k, v);
          }
          child._setParent(children);
          children.push(child);
          return child;
        },
        createSpan: (opts?: { cls?: string; text?: string }) => {
          const child = makeMockEl("span");
          if (opts?.cls) child.classList.add(opts.cls);
          if (opts?.text) child.textContent = opts.text;
          child._setParent(children);
          children.push(child);
          return child;
        },
        _setParent: (list: Array<ReturnType<typeof makeMockEl>>) => {
          parentChildren = list;
        },
      };
      return el;
    }

    const body = makeMockEl("body");
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    let nextTimer = 1;
    let nextRaf = 1;
    const rafCallbacks = new Map<number, (t: number) => void>();

    const mockWin = {
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 1,
      performance: { now: () => Date.now() },
      matchMedia: () => ({ matches: false }),
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextTimer++;
        timers.set(id, setTimeout(fn, ms));
        return id;
      },
      clearTimeout: (id: number) => {
        const handle = timers.get(id);
        if (handle) clearTimeout(handle);
        timers.delete(id);
      },
      requestAnimationFrame: (cb: (t: number) => void) => {
        const id = nextRaf++;
        rafCallbacks.set(id, cb);
        return id;
      },
      cancelAnimationFrame: (id: number) => {
        rafCallbacks.delete(id);
      },
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      document: {
        body,
        activeElement: {
          tagName: "TEXTAREA",
          isContentEditable: false,
          readOnly: false,
          disabled: false,
          matches: (sel: string) => sel.includes("textarea"),
          getAttribute: () => "Editor",
          getBoundingClientRect: () => ({ left: 100, top: 100, width: 400, height: 200 }),
        },
        documentElement: null,
        querySelectorAll: () => [],
        elementFromPoint: () => null,
        createDiv: (opts?: { cls?: string }) => {
          const el = makeMockEl("div");
          if (opts?.cls) el.classList.add(opts.cls);
          return el;
        },
        createElementNS: (_ns: string, tag: string) => makeMockEl(tag),
      },
    } as unknown as Window;

    const overlay = new AgentCursorOverlay({
      win: mockWin,
      idleAfterMs: 40,
      hideAfterMs: 120,
    });

    const events: Array<Record<string, unknown>> = [];
    const typed: string[] = [];
    const ui = new UiControlService({
      win: mockWin,
      getWebContents: () => fakeWebContents(events, typed),
      sleep: async () => {
        await new Promise((r) => setTimeout(r, 10));
      },
      cursorOverlay: overlay,
      resolveAgentLabel: (caller) => `agent:${caller}`,
    });

    // Run a multi-step batch from caller A concurrently with a click from caller B.
    const batchPromise = ui.batch(
      {
        steps: [
          { action: "click", target: { x: 100, y: 120 } },
          { action: "type", text: "atomic" },
        ],
      },
      "w1:p1"
    );
    const clickBPromise = ui.click({ target: { x: 500, y: 400 } }, "w1:p2");

    await Promise.all([batchPromise, clickBPromise]);

    assert.equal(overlay.getActiveCount(), 2, "Both agent cursors should be active simultaneously");
    assert.equal(typed[0], "atomic");
    // Caller A's click (100, 120) must finish and type before Caller B's click (500, 400) runs.
    const firstDown = events.find((e) => e.type === "mouseDown");
    const lastDown = [...events].reverse().find((e) => e.type === "mouseDown");
    assert.equal(firstDown?.x, 100);
    assert.equal(lastDown?.x, 500);

    // Wait for idle & auto-hide timers, then verify dispose cleans up cleanly.
    await new Promise((r) => setTimeout(r, 160));
    assert.equal(overlay.getActiveCount(), 0);
    overlay.dispose();
    assert.equal(body.children.length, 0);
  });

  it("places cursors at CodeMirror caret, follows fallback order, moves across chunks, restores focus, and offsets overlapping labels", async () => {
    // 1. Caret-exact CodeMirror coordsAtPos + chunked typing cursor movement.
    let cmHead = 10;
    const cmContentEl = {
      tagName: "DIV",
      isContentEditable: true,
      readOnly: false,
      disabled: false,
      isConnected: true,
      matches: (sel: string) => sel.includes("div") && !sel.includes("password"),
      getAttribute: () => null,
      contains: (other: unknown) => other === cmContentEl,
      closest: () => null,
      getBoundingClientRect: () => ({ left: 50, top: 40, width: 600, height: 400 }),
      cmView: undefined as unknown,
    };
    const cmView = {
      contentDOM: cmContentEl,
      dom: cmContentEl,
      state: {
        get selection() {
          return { main: { head: cmHead } };
        },
      },
      coordsAtPos: (pos: number) => ({ left: 200 + pos * 8, top: 300, bottom: 320 }),
    };
    cmContentEl.cmView = { view: cmView };

    const winCaret = fakeWindow(cmContentEl) as unknown as {
      document: { activeElement: unknown };
      getSelection?: () => unknown;
    };
    winCaret.getSelection = () => ({
      rangeCount: 1,
      getRangeAt: () => ({
        collapsed: false,
        commonAncestorContainer: cmContentEl,
        getClientRects: () => [{ left: 777, top: 777, width: 10, height: 18 }],
        getBoundingClientRect: () => ({ left: 777, top: 777, width: 10, height: 18 }),
      }),
    });

    const cursorCalls: Array<{ kind: string; caller: string; label: string; x: number; y: number; action?: string }> = [];
    const fakeOverlay = {
      moveTo: (caller: string, label: string, x: number, y: number, action?: string) => {
        cursorCalls.push({ kind: "move", caller, label, x, y, action });
      },
      pulseClick: (caller: string, label: string, x: number, y: number, action?: string) => {
        cursorCalls.push({ kind: "click", caller, label, x, y, action });
      },
      setTyping: (caller: string, label: string, x: number, y: number) => {
        cursorCalls.push({ kind: "type", caller, label, x, y });
      },
    } as unknown as AgentCursorOverlay;

    const typedChunks: string[] = [];
    const uiCaret = new UiControlService({
      win: winCaret as unknown as Window,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(1200, 800)),
        sendInputEvent: () => {
          cmHead += 5;
        },
        insertText: (chunk) => {
          typedChunks.push(chunk);
          cmHead += chunk.length;
        },
        getZoomFactor: () => 1,
      }),
      sleep: noSleep,
      cursorOverlay: fakeOverlay,
      resolveAgentLabel: (c) => (c === "herdr:w1:p6" ? "agy1 (w1:p6)" : c),
    });

    await uiCaret.type({ text: "hello world again" }, "herdr:w1:p6");
    assert.equal(typedChunks.join(""), "hello world again");
    assert.ok(typedChunks.length >= 3, "Expected multi-word text to type in chunks");
    const typePoints = cursorCalls.filter((c) => c.kind === "type");
    assert.ok(typePoints.length >= 4, "Expected initial cursor placement plus one update per chunk");
    assert.equal(typePoints[0].label, "agy1 (w1:p6)");
    assert.equal(typePoints[0].x, 280, "CodeMirror coordsAtPos should beat DOM selection and element center");
    assert.equal(typePoints[0].y, 310);
    assert.ok(
      typePoints[typePoints.length - 1].x > typePoints[0].x,
      "Cursor must advance along the line as chunks are typed"
    );

    // pressKey reports pre-key caret and post-key updated caret after key lands.
    cursorCalls.length = 0;
    await uiCaret.pressKey({ key: "Enter" }, "herdr:w1:p6");
    assert.equal(cursorCalls.length, 2);
    assert.ok(cursorCalls[1].x > cursorCalls[0].x);

    // 2. Fallback order when CodeMirror view is absent:
    // 2a: window.getSelection() with collapsed zero rect falls back to cloneRange adjacent char.
    const textNode = { nodeType: 3, textContent: "abc", parentElement: null };
    const collapsedContentEditable = {
      tagName: "DIV",
      isContentEditable: true,
      readOnly: false,
      disabled: false,
      isConnected: true,
      matches: (sel: string) => sel.includes("div") && !sel.includes("password"),
      getAttribute: () => null,
      contains: () => true,
      closest: () => null,
      getBoundingClientRect: () => ({ left: 100, top: 100, width: 400, height: 200 }),
    };
    const fakeRange = {
      collapsed: true,
      startContainer: textNode,
      startOffset: 2,
      commonAncestorContainer: collapsedContentEditable,
      getClientRects: () => [{ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
      cloneRange: () => ({
        setStart: () => undefined,
        setEnd: () => undefined,
        getClientRects: () => [{ left: 330, right: 344, top: 210, bottom: 228, width: 14, height: 18 }],
        getBoundingClientRect: () => ({ left: 330, right: 344, top: 210, bottom: 228, width: 14, height: 18 }),
      }),
    };
    winCaret.document.activeElement = collapsedContentEditable;
    winCaret.getSelection = () => ({ rangeCount: 1, getRangeAt: () => fakeRange });
    cursorCalls.length = 0;
    await uiCaret.type({ text: "x" }, "herdr:w1:p6");
    assert.equal(cursorCalls[0].x, 344, "Collapsed range fallback should read right edge of previous char");
    assert.equal(cursorCalls[0].y, 219);

    // 2b: <input>/<textarea> uses element left edge rather than element center.
    winCaret.getSelection = () => ({ rangeCount: 0 });
    winCaret.document.activeElement = {
      tagName: "TEXTAREA",
      isContentEditable: false,
      readOnly: false,
      disabled: false,
      isConnected: true,
      matches: (sel: string) => sel.includes("textarea"),
      getAttribute: () => null,
      closest: () => null,
      getBoundingClientRect: () => ({ left: 100, top: 100, width: 400, height: 200 }),
    };
    cursorCalls.length = 0;
    await uiCaret.type({ text: "x" }, "herdr:w1:p6");
    assert.equal(cursorCalls[0].x, 110, "Input/textarea should use left edge (100 + 10), not center (260)");

    // 2c: Generic editable div without selection falls back to element center last.
    winCaret.document.activeElement = collapsedContentEditable;
    cursorCalls.length = 0;
    await uiCaret.type({ text: "x" }, "herdr:w1:p6");
    assert.equal(cursorCalls[0].x, 260, "Generic element falls back to center only last");
    assert.equal(cursorCalls[0].y, 170);

    // 3. waitFor moves cursor to the first matched element center.
    (winCaret.document as unknown as Record<string, unknown>).querySelectorAll = () => [
      {
        tagName: "DIV",
        innerText: "Target Banner",
        textContent: "Target Banner",
        matches: () => false,
        contains: () => false,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ x: 500, y: 200, left: 500, top: 200, width: 100, height: 40, bottom: 240, right: 600 }),
        parentElement: null,
      },
    ];
    (winCaret.document as unknown as Record<string, unknown>).body = { innerText: "Target Banner" };
    cursorCalls.length = 0;
    const foundRes = (await uiCaret.waitFor({ text: "Target Banner", timeoutMs: 0 }, "herdr:w1:p6")) as {
      found: boolean;
    };
    assert.equal(foundRes.found, true);
    assert.equal(cursorCalls[0].action, "wait_for");
    assert.equal(cursorCalls[0].x, 550);
    assert.equal(cursorCalls[0].y, 220);

    // 4. Focus restore: preserves user terminal focus across batch, but skips restore when modal opens.
    let restoredSelection: Array<unknown> = [];
    let terminalFocusCount = 0;
    const terminalEl = {
      tagName: "TEXTAREA",
      isConnected: true,
      readOnly: false,
      disabled: false,
      isContentEditable: false,
      selectionStart: 2,
      selectionEnd: 5,
      selectionDirection: "forward",
      matches: (sel: string) => sel.includes("textarea"),
      getAttribute: () => "Terminal",
      closest: () => null,
      getBoundingClientRect: () => ({ left: 20, top: 20, width: 300, height: 200 }),
      focus: () => {
        terminalFocusCount += 1;
        winFocus.document.activeElement = terminalEl;
      },
      setSelectionRange: (s: number, e: number, dir?: string) => {
        restoredSelection = [s, e, dir];
      },
    };
    const editorEl = {
      tagName: "DIV",
      isConnected: true,
      readOnly: false,
      disabled: false,
      isContentEditable: true,
      matches: (sel: string) => sel.includes("div") && !sel.includes("password"),
      getAttribute: () => null,
      closest: () => null,
      getBoundingClientRect: () => ({ left: 700, top: 100, width: 400, height: 400 }),
    };
    let modalOpen = false;
    const modalInput = {
      tagName: "INPUT",
      isConnected: true,
      readOnly: false,
      disabled: false,
      isContentEditable: false,
      matches: (sel: string) => sel.includes("input") && !sel.includes("password"),
      getAttribute: () => "Command palette",
      closest: (sel: string) => (sel.includes(".prompt") ? modalBox : null),
      getBoundingClientRect: () => ({ left: 400, top: 80, width: 400, height: 32 }),
    };
    const modalBox = {
      getBoundingClientRect: () => ({ left: 380, top: 60, width: 440, height: 300, bottom: 360, right: 820 }),
    };
    const winFocus = {
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 1,
      setTimeout: (fn: () => void) => {
        fn();
        return 0;
      },
      requestAnimationFrame: (fn: () => void) => {
        fn();
        return 0;
      },
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      getSelection: () => ({ rangeCount: 0 }),
      document: {
        activeElement: terminalEl as unknown,
        body: { innerText: "" },
        documentElement: {},
        querySelectorAll: (sel: string) => (modalOpen && sel.includes(".prompt") ? [modalBox] : []),
        elementFromPoint: () => null,
      },
    };
    const uiFocus = new UiControlService({
      win: winFocus as unknown as Window,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(1200, 800)),
        sendInputEvent: (ev) => {
          if (ev.type === "mouseDown") {
            winFocus.document.activeElement = editorEl;
          } else if (ev.type === "keyDown" && ev.keyCode === "P") {
            modalOpen = true;
            winFocus.document.activeElement = modalInput;
          }
        },
        insertText: () => Promise.resolve(),
        getZoomFactor: () => 1,
      }),
      platform: "linux",
      sleep: noSleep,
    });

    await uiFocus.batch({
      steps: [
        { action: "click", target: { x: 800, y: 200 } },
        { action: "type", text: "note line" },
      ],
    });
    assert.equal(terminalFocusCount, 1, "Batch outside modal should restore terminal focus");
    assert.equal(winFocus.document.activeElement, terminalEl);
    assert.deepEqual(restoredSelection, [2, 5, "forward"]);

    await uiFocus.pressKey({ key: "p", modifiers: ["Mod"] });
    assert.equal(winFocus.document.activeElement, modalInput, "Intentional modal open must keep focus in modal");
    assert.equal(terminalFocusCount, 1);

    // 5. Overlapping agent cursor pills at the same spot keep distinct hues and offset labels.
    const pillEls: Array<Record<string, unknown>> = [];
    const makeTrackableEl = (tag: string): Record<string, unknown> => {
      const classes = new Set<string>();
      const props = new Map<string, string>();
      const children: Array<Record<string, unknown>> = [];
      const el: Record<string, unknown> = {
        tagName: tag.toUpperCase(),
        isConnected: true,
        offsetWidth: 24,
        textContent: "",
        children,
        classList: {
          add: (...n: string[]) => n.forEach((x) => classes.add(x)),
          remove: (...n: string[]) => n.forEach((x) => classes.delete(x)),
          contains: (x: string) => classes.has(x),
        },
        style: {
          transform: "",
          setProperty: (k: string, v: string) => props.set(k, v),
          getPropertyValue: (k: string) => props.get(k) ?? "",
        },
        setAttribute: () => undefined,
        getAttribute: () => null,
        appendChild: (c: Record<string, unknown>) => {
          children.push(c);
          return c;
        },
        remove: () => {
          el.isConnected = false;
        },
        createDiv: (opts?: { cls?: string }) => {
          const child = makeTrackableEl("div");
          if (opts?.cls) (child.classList as { add: (...n: string[]) => void }).add(opts.cls);
          if (opts?.cls === "herdr-cursor-pill") {
            pillEls.push(child);
          }
          children.push(child);
          return child;
        },
        createSpan: (opts?: { cls?: string; text?: string }) => {
          const child = makeTrackableEl("span");
          if (opts?.cls) (child.classList as { add: (...n: string[]) => void }).add(opts.cls);
          if (opts?.text) child.textContent = opts.text;
          children.push(child);
          return child;
        },
      };
      return el;
    };
    const overlapBody = makeTrackableEl("body");
    const overlapWin = {
      innerWidth: 1200,
      innerHeight: 800,
      matchMedia: () => ({ matches: true }),
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      requestAnimationFrame: (fn: () => void) => {
        fn();
        return 1;
      },
      cancelAnimationFrame: () => undefined,
      document: {
        body: overlapBody,
        createDiv: () => makeTrackableEl("div"),
        createElementNS: (_ns: string, tag: string) => makeTrackableEl(tag),
      },
    } as unknown as Window;

    const overlapOverlay = new AgentCursorOverlay({ win: overlapWin, idleAfterMs: 5000, hideAfterMs: 10000 });
    overlapOverlay.moveTo("herdr:w1:p6", "agy1 (w1:p6)", 300, 300, "typing");
    overlapOverlay.moveTo("herdr:w1:p4", "agy2 (w1:p4)", 300, 300, "typing");
    assert.equal(pillEls.length, 2);
    const getProp = (el: Record<string, unknown>, key: string) =>
      (el.style as { getPropertyValue: (k: string) => string }).getPropertyValue(key);
    assert.notEqual(
      getProp(pillEls[0], "--herdr-pill-y"),
      getProp(pillEls[1], "--herdr-pill-y"),
      "Two cursors at the same spot should receive distinct vertical pill offsets"
    );
    const cursorLayerChildren = (overlapBody.children as Array<Record<string, unknown>>)[0].children as Array<Record<string, unknown>>;
    assert.notEqual(
      getProp(cursorLayerChildren[0], "--herdr-cursor-hue"),
      getProp(cursorLayerChildren[1], "--herdr-cursor-hue"),
      "Distinct active agents should keep distinct cursor hues"
    );
    overlapOverlay.dispose();
  });

  it("supports inspect editor metadata, native ui.locate, anchor targets, insert_line without double bullets, and caret scroll sync", async () => {
    const events: Array<Record<string, unknown>> = [];
    const typed: string[] = [];
    const wc: WebContentsLike = {
      capturePage: () => Promise.resolve(fakeImage(2400, 1600)),
      sendInputEvent: (ev) => {
        events.push(ev);
      },
      insertText: async (text) => {
        typed.push(text);
        if (activeDocLines && cmState) {
          // Splice inserted text into the simulated CM document so multi-chunk & insert_line flows stay live.
          const head = cmState.selection.main.head;
          const raw = activeDocLines.join("\n");
          const next = raw.slice(0, head) + text + raw.slice(head);
          activeDocLines = next.split("\n");
          cmState.selection.main.head = head + text.length;
        }
      },
      getZoomFactor: () => 1,
    };

    let activeDocLines = [
      "# Mission Board",
      "",
      "## agy1: Overview",
      "- First item",
      "",
      "## agy2: Next",
      "- Other item",
      "Tail line",
    ];
    let scrollOffset = 0;

    const lineOffsets = (): Array<{ from: number; to: number; number: number; text: string }> => {
      const out: Array<{ from: number; to: number; number: number; text: string }> = [];
      let off = 0;
      for (let i = 0; i < activeDocLines.length; i += 1) {
        const text = activeDocLines[i];
        out.push({ number: i + 1, text, from: off, to: off + text.length });
        off += text.length + 1;
      }
      return out;
    };

    const cmState = {
      doc: {
        get length() {
          return activeDocLines.join("\n").length;
        },
        get lines() {
          return activeDocLines.length;
        },
        toString: () => activeDocLines.join("\n"),
        line: (n: number) => lineOffsets()[n - 1],
      },
      selection: { main: { head: 0 } },
    };

    const cmDispatches: Array<Record<string, unknown>> = [];
    const makeDomLine = (idx: number, getText: () => string) => {
      const top = () => 100 + idx * 140 - scrollOffset;
      return {
        tagName: "DIV",
        className: "cm-line",
        isConnected: true,
        get textContent() {
          return getText();
        },
        get innerText() {
          return getText();
        },
        getAttribute: () => null,
        matches: (s: string) => s.split(",").some((p) => p.trim() === ".cm-line"),
        closest: (s: string) => (s.includes(".workspace-leaf") ? leftLeafEl : null),
        getClientRects: () => [{ left: 60, top: top(), width: 320, height: 24 }],
        getBoundingClientRect: () => ({
          x: 60,
          y: top(),
          left: 60,
          top: top(),
          right: 560,
          bottom: top() + 24,
          width: 500,
          height: 24,
        }),
        scrollIntoView: () => {
          const curTop = top();
          if (curTop > 700 || curTop < 20) {
            scrollOffset += curTop - 300;
          }
        },
      };
    };

    const cmContentEl: Record<string, unknown> = {
      tagName: "DIV",
      isConnected: true,
      isContentEditable: true,
      matches: () => false,
      getAttribute: () => null,
      contains: () => true,
      focus: () => {
        doc.activeElement = cmContentEl;
      },
      getBoundingClientRect: () => ({
        x: 60,
        y: 80,
        left: 60,
        top: 80,
        right: 600,
        bottom: 740,
        width: 540,
        height: 660,
      }),
    };

    const cmView = {
      contentDOM: cmContentEl as unknown as Element,
      scrollDOM: {
        scrollTop: 0,
        getBoundingClientRect: () => ({
          x: 40,
          y: 60,
          left: 40,
          top: 60,
          right: 620,
          bottom: 740,
          width: 580,
          height: 680,
        }),
      } as unknown as HTMLElement,
      state: cmState,
      coordsAtPos: (pos: number) => {
        const lines = lineOffsets();
        const found = lines.find((l) => pos >= l.from && pos <= l.to) ?? lines[lines.length - 1];
        const y = 100 + (found.number - 1) * 140 - scrollOffset;
        const x = 60 + Math.max(0, pos - found.from) * 7;
        return { left: x, top: y, right: x + 2, bottom: y + 20 };
      },
      dispatch: (spec: Record<string, unknown>) => {
        cmDispatches.push(spec);
        const ch = spec.changes as { from: number; insert: string } | undefined;
        if (ch && typeof ch.insert === "string") {
          const raw = activeDocLines.join("\n");
          activeDocLines = (raw.slice(0, ch.from) + ch.insert + raw.slice(ch.from)).split("\n");
        }
        const sel = spec.selection as { anchor?: number } | undefined;
        if (sel && typeof sel.anchor === "number") {
          cmState.selection.main.head = sel.anchor;
        }
        const effectPos = extractScrollEffectPos(spec);
        if (spec.scrollIntoView || effectPos !== null) {
          const head = effectPos ?? cmState.selection.main.head;
          const found = lineOffsets().find((l) => head >= l.from && head <= l.to);
          if (found) {
            const y = 100 + (found.number - 1) * 140 - scrollOffset;
            if (y > 700 || y < 20) {
              scrollOffset += y - 360;
            }
          }
        }
      },
      focus: () => {
        doc.activeElement = cmContentEl;
      },
    };
    cmContentEl.cmView = { view: cmView };

    const leftLineEls = () => activeDocLines.map((_, idx) => makeDomLine(idx, () => activeDocLines[idx] ?? ""));
    const buttonInPane = {
      tagName: "BUTTON",
      isConnected: true,
      disabled: false,
      textContent: "Save",
      innerText: "Save",
      getAttribute: () => null,
      matches: (s: string) => s.split(",").some((p) => p.trim() === "button"),
      closest: (s: string) => (s.includes(".workspace-leaf") ? leftLeafEl : null),
      getClientRects: () => [{ left: 80, top: 20, width: 50, height: 24 }],
      getBoundingClientRect: () => ({ x: 80, y: 20, left: 80, top: 20, right: 130, bottom: 44, width: 50, height: 24 }),
    };
    const leftLeafEl: Record<string, unknown> = {
      tagName: "DIV",
      isConnected: true,
      id: "leaf-mission",
      classList: { contains: (c: string) => c === "mod-active" },
      contains: (node: unknown) =>
        node === cmContentEl || node === buttonInPane || leftLineEls().some((l) => l === node),
      querySelector: (s: string) => (s === ".cm-content" ? cmContentEl : null),
      querySelectorAll: (s: string) => (s === ".cm-line" ? leftLineEls() : []),
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 40, y: 20, left: 40, top: 20, right: 620, bottom: 760, width: 580, height: 740 }),
    };

    const rightLineEl = {
      tagName: "DIV",
      className: "cm-line",
      isConnected: true,
      textContent: "- First item from right",
      innerText: "- First item from right",
      getAttribute: () => null,
      matches: (s: string) => s.split(",").some((p) => p.trim() === ".cm-line"),
      closest: (s: string) => (s.includes(".workspace-leaf") ? rightLeafEl : null),
      getClientRects: () => [{ left: 680, top: 140, width: 220, height: 24 }],
      getBoundingClientRect: () => ({ x: 680, y: 140, left: 680, top: 140, right: 900, bottom: 164, width: 220, height: 24 }),
    };
    const rightLeafEl: Record<string, unknown> = {
      tagName: "DIV",
      isConnected: true,
      id: "leaf-notes",
      classList: { contains: () => false },
      contains: (node: unknown) => node === rightLineEl,
      querySelector: () => null,
      querySelectorAll: (s: string) => (s === ".cm-line" ? [rightLineEl] : []),
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 640, y: 20, left: 640, top: 20, right: 1180, bottom: 760, width: 540, height: 740 }),
    };

    const leftLeaf = {
      id: "leaf-mission",
      containerEl: leftLeafEl,
      view: {
        getViewType: () => "markdown",
        file: { path: "Crew Test/Mission Board.md" },
        editor: { cm: cmView },
      },
    };
    const rightLeaf = {
      id: "leaf-notes",
      containerEl: rightLeafEl,
      view: {
        getViewType: () => "markdown",
        file: { path: "Notes/Scratch.md" },
        getViewData: () => "- First item from right",
      },
    };

    const doc: Record<string, unknown> = {
      activeElement: cmContentEl,
      body: { innerText: "Mission Board" },
      documentElement: {},
      querySelectorAll: (selector: string) => {
        const out: unknown[] = [];
        if (selector.includes("button")) {
          out.push(buttonInPane);
        }
        if (selector.includes(".cm-line")) {
          out.push(...leftLineEls(), rightLineEl);
        }
        return out;
      },
      elementFromPoint: () => null,
    };

    const cursorMoves: Array<{ action: string; x: number; y: number; text?: string }> = [];
    const win = {
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 2,
      document: doc,
      app: {
        workspace: {
          activeLeaf: leftLeaf,
          getLeavesOfType: (t: string) => (t === "markdown" ? [leftLeaf, rightLeaf] : []),
        },
      },
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      setTimeout,
    } as unknown as Window;

    const fakeCursor = {
      moveTo: (_id: string, _lbl: string, x: number, y: number, action?: string) => {
        cursorMoves.push({ action: action ?? "move", x, y });
      },
      pulseClick: (_id: string, _lbl: string, x: number, y: number, action?: string) => {
        cursorMoves.push({ action: action ?? "click", x, y });
      },
      setTyping: (_id: string, _lbl: string, x: number, y: number) => {
        cursorMoves.push({ action: "type", x, y });
      },
    } as unknown as AgentCursorOverlay;

    const ui = new UiControlService({
      win,
      getWebContents: () => wc,
      sleep: async () => undefined,
      cursorOverlay: fakeCursor,
    });

    // 1) inspect({ text }) includes .cm-line by default and populates notePath, pane, activePane.
    const defaultInspect = ui.inspect({}) as { elements: Array<{ tag: string; notePath?: string }> };
    assert.equal(defaultInspect.elements.length, 1);
    assert.equal(defaultInspect.elements[0].tag, "button");
    assert.equal(defaultInspect.elements[0].notePath, "Crew Test/Mission Board.md");

    const textInspect = ui.inspect({ text: "First item" }) as {
      elements: Array<{ text: string; notePath?: string; pane?: string; activePane?: boolean }>;
    };
    assert.equal(textInspect.elements.length, 2);
    assert.equal(textInspect.elements[0].notePath, "Crew Test/Mission Board.md");
    assert.equal(textInspect.elements[0].pane, "leaf-mission");
    assert.equal(textInspect.elements[0].activePane, true);
    assert.equal(textInspect.elements[1].notePath, "Notes/Scratch.md");
    assert.equal(textInspect.elements[1].pane, "leaf-notes");
    assert.equal(textInspect.elements[1].activePane, false);

    // 2) ui.locate finds offscreen line, scrolls into view, and fails clearly when note is not open.
    const located = (await ui.locate({ path: "Crew Test/Mission Board.md", line: 8 })) as {
      found: boolean;
      path: string;
      pane: string;
      line: number;
      text: string;
      scrolled: boolean;
      point: { x: number; y: number };
    };
    assert.equal(located.found, true);
    assert.equal(located.path, "Crew Test/Mission Board.md");
    assert.equal(located.pane, "leaf-mission");
    assert.equal(located.line, 8);
    assert.equal(located.text, "Tail line");
    assert.equal(located.scrolled, true);
    assert.ok(located.point.y >= 0 && located.point.y < 800);
    assert.equal(located.point.x, 60 + "Tail line".length * 7);

    await assert.rejects(
      () => ui.locate({ path: "Missing/Closed Note.md", line: 1 }),
      (err: unknown) => err instanceof UiControlError && err.code === "ui_target_not_found"
    );

    // Reset scroll back to top before editing anchors.
    scrollOffset = 0;

    // 3) Heading anchor targets section end (line 4 "- First item", before "## agy2: Next") & insert_line avoids double bullets.
    events.length = 0;
    typed.length = 0;
    cmDispatches.length = 0;
    const insertRes = (await ui.insertLine({
      target: { note: "Crew Test/Mission Board.md", heading: "agy1: Overview" },
      text: "- Second item added without Enter keymap",
    })) as { dispatched: boolean; line: number; path: string };
    assert.equal(insertRes.dispatched, true);
    assert.equal(insertRes.path, "Crew Test/Mission Board.md");
    assert.equal(insertRes.line, 5);
    assert.equal(activeDocLines[3], "- First item");
    assert.equal(activeDocLines[4], "- Second item added without Enter keymap");
    assert.equal(activeDocLines[5], "");
    assert.equal(activeDocLines[6], "## agy2: Next");
    // Must not dispatch Return/Enter key events that trigger Smart Indent Lists double bullets.
    assert.equal(
      events.some((ev) => ev.type === "keyDown" && ev.keyCode === "Return"),
      false
    );
    assert.ok(
      cmDispatches.some((spec) => Boolean((spec.changes as { insert?: string } | undefined)?.insert === "\n"))
    );

    // 4) Batch supports insert_line + anchor targets (`after` + `at: "start"`).
    await ui.batch({
      steps: [
        {
          action: "insert_line",
          target: { note: "Crew Test/Mission Board.md", after: "Tail line", at: "end" },
          text: "Appended in batch",
        },
        {
          action: "click",
          target: { note: "Crew Test/Mission Board.md", after: "Tail line", at: "start" },
        },
      ],
    });
    assert.equal(activeDocLines[activeDocLines.length - 1], "Appended in batch");

    // 5) Caret stays in view and agent cursor tracks post-scroll coordinates when typing near bottom.
    scrollOffset = 0;
    const lastCursorCount = cursorMoves.length;
    await ui.type({
      target: { note: "Crew Test/Mission Board.md", after: "Appended in batch", at: "end" },
      text: " keeps scrolling cursor synced cleanly inside viewport bounds",
    });
    const recentCursorMoves = cursorMoves.slice(lastCursorCount).filter((m) => m.action === "type");
    assert.ok(recentCursorMoves.length >= 2);
    const finalTypeCursor = recentCursorMoves[recentCursorMoves.length - 1];
    assert.ok(finalTypeCursor.y >= 60 && finalTypeCursor.y <= 740);

    // 6) resolveNoteLeaf returning null is authoritative even when app.workspace has leaves.
    const guardedUi = new UiControlService({
      win,
      getWebContents: () => wc,
      resolveNoteLeaf: () => null,
      sleep: async () => undefined,
    });
    await assert.rejects(
      () => guardedUi.locate({ path: "Crew Test/Mission Board.md", line: 1 }),
      (err: unknown) => err instanceof UiControlError && err.code === "ui_target_not_found"
    );

    // 7) Multi-chunk typing aborts on focus drift (another field, password field, or non-editable target)
    // and reports partial insertion honestly without typing into the new target.
    const driftEditor = editableField() as Record<string, unknown>;
    const driftTerminal = editableField() as Record<string, unknown>;
    const driftPassword = {
      tagName: "INPUT",
      readOnly: false,
      disabled: false,
      isContentEditable: false,
      matches: (sel: string) => sel.includes('input[type="password"]') || sel.includes("input"),
      getAttribute: () => null,
    };
    const driftWin = fakeWindow(driftEditor) as unknown as { document: { activeElement: unknown } };
    const fieldLog: Array<{ field: string; chunk: string }> = [];
    const driftUi = new UiControlService({
      win: driftWin as unknown as Window,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(800, 600)),
        sendInputEvent: () => undefined,
        insertText: async (chunk: string) => {
          const active = driftWin.document.activeElement;
          const field =
            active === driftEditor
              ? "editor"
              : active === driftTerminal
                ? "terminal"
                : active === driftPassword
                  ? "password"
                  : "other";
          fieldLog.push({ field, chunk });
        },
        getZoomFactor: () => 1,
      }),
      sleep: async () => {
        // Simulate the user clicking into the terminal during the first inter-chunk delay.
        driftWin.document.activeElement = driftTerminal;
      },
    });
    const driftText = "first second third";
    await assert.rejects(
      () => driftUi.type({ text: driftText }),
      (err: unknown) =>
        err instanceof UiControlError &&
        err.code === "ui_not_editable" &&
        err.message.includes(`after inserting 6 of ${driftText.length} characters`)
    );
    assert.deepEqual(fieldLog, [{ field: "editor", chunk: "first " }]);

    // Password-target drift check during inter-chunk delay.
    fieldLog.length = 0;
    driftWin.document.activeElement = driftEditor;
    const pwDriftUi = new UiControlService({
      win: driftWin as unknown as Window,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(800, 600)),
        sendInputEvent: () => undefined,
        insertText: async (chunk: string) => {
          const field = driftWin.document.activeElement === driftEditor ? "editor" : "other";
          fieldLog.push({ field, chunk });
        },
        getZoomFactor: () => 1,
      }),
      sleep: async () => {
        driftWin.document.activeElement = driftPassword;
      },
    });
    await assert.rejects(
      () => pwDriftUi.type({ text: driftText }),
      (err: unknown) =>
        err instanceof UiControlError &&
        err.code === "ui_not_editable" &&
        err.message.includes(`after inserting 6 of ${driftText.length} characters`)
    );
    assert.deepEqual(fieldLog, [{ field: "editor", chunk: "first " }]);

    // 8) R1-5 exact reproduction: agent4 -> clear -> agent8 -> agent4 keeps active hues distinct.
    const activeCursorRoots: Array<{ style: { getPropertyValue: (k: string) => string } }> = [];
    const makeHueEl = (cls?: string): Record<string, unknown> => {
      const props = new Map<string, string>();
      const el: Record<string, unknown> = {
        tagName: "DIV",
        isConnected: true,
        classList: {
          add: () => undefined,
          remove: () => undefined,
          toggle: () => undefined,
          contains: () => false,
        },
        style: {
          setProperty: (k: string, v: string) => props.set(k, v),
          getPropertyValue: (k: string) => props.get(k) ?? "",
          removeProperty: (k: string) => props.delete(k),
        },
        setAttribute: () => undefined,
        removeAttribute: () => undefined,
        appendChild: () => undefined,
        getBoundingClientRect: () => ({
          left: 0,
          top: 0,
          right: 60,
          bottom: 20,
          width: 60,
          height: 20,
        }),
        remove: () => {
          el.isConnected = false;
          const idx = activeCursorRoots.indexOf(
            el as unknown as { style: { getPropertyValue: (k: string) => string } }
          );
          if (idx >= 0) {
            activeCursorRoots.splice(idx, 1);
          }
        },
        createDiv: (subOpts?: { cls?: string }) => makeHueEl(subOpts?.cls),
        createSpan: (subOpts?: { cls?: string }) => makeHueEl(subOpts?.cls),
      };
      if (cls?.includes("herdr-cursor ")) {
        activeCursorRoots.push(
          el as unknown as { style: { getPropertyValue: (k: string) => string } }
        );
      }
      return el;
    };
    const hueWin = {
      innerWidth: 1200,
      innerHeight: 800,
      matchMedia: () => ({ matches: true }),
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      requestAnimationFrame: (fn: () => void) => {
        fn();
        return 1;
      },
      cancelAnimationFrame: () => undefined,
      document: {
        body: {
          children: [] as unknown[],
          createDiv: (opts?: { cls?: string }) => makeHueEl(opts?.cls),
        },
        createElementNS: () => ({
          setAttribute: () => undefined,
          appendChild: () => undefined,
        }),
      },
    } as unknown as Window;
    const hueOverlay = new AgentCursorOverlay({ win: hueWin, idleAfterMs: 5000, hideAfterMs: 10000 });
    hueOverlay.moveTo("agent4", "agent4", 100, 100, "move");
    hueOverlay.clearAgent("agent4");
    hueOverlay.moveTo("agent8", "agent8", 200, 200, "move");
    hueOverlay.moveTo("agent4", "agent4", 300, 300, "move");
    assert.equal(activeCursorRoots.length, 2);
    const activeHueValues = activeCursorRoots.map((r) =>
      r.style.getPropertyValue("--herdr-cursor-hue")
    );
    assert.ok(activeHueValues[0] && activeHueValues[1]);
    assert.notEqual(activeHueValues[0], activeHueValues[1]);
    hueOverlay.dispose();
  });

  it("matches exact trimmed after anchors, ignores fenced code headings, keeps drag endpoints synced, and fires beforeMutation inside the UI lock", async () => {
    let linesA = [
      "- Ready for review",
      "  - Ready  ",
      "~~~md",
      "## sol3",
      "~~~",
      "## sol3",
      "```md",
      "## example",
      "```",
      "- real end",
      "~~~text",
      "## fake-heading-in-tilde",
      "~~~",
      "- after tilde",
      "## other",
      "- Dup",
      "- Dup",
      "Bottom far line",
    ];
    let linesB = ["# Beta note", "- beta line"];
    let scrollA = 0;

    const offsetsFor = (lines: string[]) => {
      const out: Array<{ from: number; to: number; number: number; text: string }> = [];
      let off = 0;
      for (let i = 0; i < lines.length; i += 1) {
        const text = lines[i];
        out.push({ number: i + 1, text, from: off, to: off + text.length });
        off += text.length + 1;
      }
      return out;
    };

    const cmStateA = {
      doc: {
        get length() {
          return linesA.join("\n").length;
        },
        get lines() {
          return linesA.length;
        },
        toString: () => linesA.join("\n"),
        line: (n: number) => offsetsFor(linesA)[n - 1],
      },
      selection: { main: { head: 0 } },
    };
    const cmStateB = {
      doc: {
        get length() {
          return linesB.join("\n").length;
        },
        get lines() {
          return linesB.length;
        },
        toString: () => linesB.join("\n"),
        line: (n: number) => offsetsFor(linesB)[n - 1],
      },
      selection: { main: { head: 0 } },
    };

    let currentLinesRef = () => linesA;
    let currentSetLines = (next: string[]) => {
      linesA = next;
    };
    let currentState = cmStateA;

    const timeline: string[] = [];
    const inputEvents: Array<Record<string, unknown>> = [];

    const cmViewA = {
      scrollDOM: {
        getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 760, width: 600, height: 760 }),
      } as unknown as HTMLElement,
      state: cmStateA,
      coordsAtPos: (pos: number) => {
        const offsets = offsetsFor(linesA);
        const found = offsets.find((l) => pos >= l.from && pos <= l.to) ?? offsets[offsets.length - 1];
        // Space lines 140px apart so line 18 (y ~ 2480) is more than one viewport below line 1 (y = 100),
        // while line 5 (y = 660) and line 7 (y = 940) can both fit once scrolled slightly.
        const y = 100 + (found.number - 1) * 140 - scrollA;
        const x = 40 + Math.max(0, pos - found.from) * 6;
        return { left: x, top: y, right: x + 2, bottom: y + 20 };
      },
      dispatch: (spec: Record<string, unknown>) => {
        const ch = spec.changes as { from: number; insert: string } | undefined;
        if (ch && typeof ch.insert === "string") {
          timeline.push(`cm-dispatch:${JSON.stringify(ch.insert)}`);
          const raw = linesA.join("\n");
          linesA = (raw.slice(0, ch.from) + ch.insert + raw.slice(ch.from)).split("\n");
        }
        const sel = spec.selection as { anchor?: number } | undefined;
        if (sel && typeof sel.anchor === "number") {
          cmStateA.selection.main.head = sel.anchor;
        }
        const effectPos = extractScrollEffectPos(spec);
        if (spec.scrollIntoView || effectPos !== null) {
          const head = effectPos ?? cmStateA.selection.main.head;
          const found = offsetsFor(linesA).find((l) => head >= l.from && head <= l.to);
          if (found) {
            const rawY = 100 + (found.number - 1) * 140;
            const y = rawY - scrollA;
            if (y > 700 || y < 20) {
              scrollA = Math.max(0, rawY - 620);
            }
          }
        }
      },
      focus: () => {
        currentLinesRef = () => linesA;
        currentSetLines = (next) => {
          linesA = next;
        };
        currentState = cmStateA;
        doc.activeElement = cmElA;
      },
    };

    const cmViewB = {
      scrollDOM: {
        getBoundingClientRect: () => ({ x: 600, y: 0, left: 600, top: 0, right: 1200, bottom: 760, width: 600, height: 760 }),
      } as unknown as HTMLElement,
      state: cmStateB,
      coordsAtPos: (pos: number) => {
        const offsets = offsetsFor(linesB);
        const found = offsets.find((l) => pos >= l.from && pos <= l.to) ?? offsets[offsets.length - 1];
        const y = 100 + (found.number - 1) * 40;
        const x = 640 + Math.max(0, pos - found.from) * 6;
        return { left: x, top: y, right: x + 2, bottom: y + 20 };
      },
      dispatch: (spec: Record<string, unknown>) => {
        const ch = spec.changes as { from: number; insert: string } | undefined;
        if (ch && typeof ch.insert === "string") {
          timeline.push(`cm-dispatch-b:${JSON.stringify(ch.insert)}`);
          const raw = linesB.join("\n");
          linesB = (raw.slice(0, ch.from) + ch.insert + raw.slice(ch.from)).split("\n");
        }
        const sel = spec.selection as { anchor?: number } | undefined;
        if (sel && typeof sel.anchor === "number") {
          cmStateB.selection.main.head = sel.anchor;
        }
      },
      focus: () => {
        currentLinesRef = () => linesB;
        currentSetLines = (next) => {
          linesB = next;
        };
        currentState = cmStateB;
        doc.activeElement = cmElB;
      },
    };

    const cmElA: Record<string, unknown> = {
      tagName: "DIV",
      isConnected: true,
      isContentEditable: true,
      matches: (s: string) => s.includes("div"),
      closest: (s: string) => (s.includes(".workspace-leaf") ? leafElA : null),
      getAttribute: () => null,
      contains: (o: unknown) => o === cmElA,
      focus: () => cmViewA.focus(),
      cmView: { view: cmViewA },
    };
    const cmElB: Record<string, unknown> = {
      tagName: "DIV",
      isConnected: true,
      isContentEditable: true,
      matches: (s: string) => s.includes("div"),
      closest: (s: string) => (s.includes(".workspace-leaf") ? leafElB : null),
      getAttribute: () => null,
      contains: (o: unknown) => o === cmElB,
      focus: () => cmViewB.focus(),
      cmView: { view: cmViewB },
    };
    const leafElA: Record<string, unknown> = {
      tagName: "DIV",
      isConnected: true,
      id: "pane-a",
      classList: { contains: (c: string) => c === "mod-active" },
      contains: (n: unknown) => n === cmElA,
      querySelector: () => null,
      querySelectorAll: () => [],
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 760, width: 600, height: 760 }),
    };
    const leafElB: Record<string, unknown> = {
      tagName: "DIV",
      isConnected: true,
      id: "pane-b",
      classList: { contains: () => false },
      contains: (n: unknown) => n === cmElB,
      querySelector: () => null,
      querySelectorAll: () => [],
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 600, y: 0, left: 600, top: 0, right: 1200, bottom: 760, width: 600, height: 760 }),
    };

    const doc: Record<string, unknown> = {
      activeElement: cmElA,
      body: { innerText: "Round 3" },
      documentElement: {},
      querySelectorAll: () => [],
      elementFromPoint: (x: number) => (x < 600 ? cmElA : cmElB),
    };

    const win = {
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 2,
      document: doc,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      setTimeout,
    } as unknown as Window;

    const mutationCalls: Array<UiMutationContext & { snapshotText: string }> = [];
    const wc: WebContentsLike = {
      capturePage: () => Promise.resolve(fakeImage(2400, 1600)),
      sendInputEvent: (ev) => {
        inputEvents.push(ev);
        timeline.push(`input:${String(ev.type)}`);
      },
      insertText: async (chunk) => {
        timeline.push(`insertText:${chunk}`);
        const lines = currentLinesRef();
        const head = currentState.selection.main.head;
        const raw = lines.join("\n");
        currentSetLines((raw.slice(0, head) + chunk + raw.slice(head)).split("\n"));
        currentState.selection.main.head = head + chunk.length;
      },
      getZoomFactor: () => 1,
    };

    const ui = new UiControlService({
      win,
      getWebContents: () => wc,
      sleep: async () => undefined,
      resolveElementContext: (el) => {
        if (el === cmElA) return { notePath: "Notes/Alpha.md", pane: "pane-a", activePane: true };
        if (el === cmElB) return { notePath: "Notes/Beta.md", pane: "pane-b", activePane: false };
        return null;
      },
      resolveNoteLeaf: (p) => {
        if (p === "Notes/Alpha.md") {
          return { path: p, pane: "pane-a", activePane: doc.activeElement === cmElA, containerEl: leafElA as unknown as Element, cm: cmViewA };
        }
        if (p === "Notes/Beta.md") {
          return { path: p, pane: "pane-b", activePane: doc.activeElement === cmElB, containerEl: leafElB as unknown as Element, cm: cmViewB };
        }
        return null;
      },
      beforeMutation: async (ctx) => {
        const snap =
          ctx.notePath === "Notes/Beta.md"
            ? linesB.join("\n")
            : ctx.notePath === "Notes/Alpha.md"
              ? linesA.join("\n")
              : "";
        timeline.push(`beforeMutation:${ctx.action}:${ctx.notePath}:${ctx.caller}`);
        mutationCalls.push({ ...ctx, snapshotText: snap });
        return () => {
          timeline.push(`afterMutation:${ctx.action}:${ctx.notePath}:${ctx.caller}`);
        };
      },
    });

    // R2-2: `after` matches whole trimmed line (not earlier substring `- Ready for review`), fails on substring or duplicates.
    const exactAfterLoc = (await ui.locate({ path: "Notes/Alpha.md", after: "- Ready" })) as { line: number; text: string };
    assert.equal(exactAfterLoc.line, 2);
    assert.equal(exactAfterLoc.text, "  - Ready  ");

    const substrLoc = (await ui.locate({ path: "Notes/Alpha.md", text: "Ready" })) as { line: number };
    assert.equal(substrLoc.line, 1);

    await assert.rejects(
      () => ui.locate({ path: "Notes/Alpha.md", after: "Ready" }),
      (err: unknown) => err instanceof UiControlError && err.code === "ui_target_not_found"
    );
    await assert.rejects(
      () => ui.locate({ path: "Notes/Alpha.md", after: "- Dup" }),
      (err: unknown) => err instanceof UiControlError && err.code === "ui_target_ambiguous"
    );

    // R2-5: heading lookup and section-end boundary ignore `#` inside both `~~~` and ```` ``` ```` fences.
    const headingEnd = (await ui.locate({ path: "Notes/Alpha.md", heading: "sol3" })) as { line: number; text: string };
    assert.equal(headingEnd.text, "- after tilde");
    assert.equal(headingEnd.line, 14);

    // R2-4: far drag endpoints (>1 viewport apart) fail cleanly BEFORE mouseDown when destination scroll invalidates start.
    scrollA = 0;
    inputEvents.length = 0;
    await assert.rejects(
      () =>
        ui.drag({
          from: { note: "Notes/Alpha.md", line: 1 },
          to: { note: "Notes/Alpha.md", line: 18 },
        }),
      (err: unknown) => err instanceof UiControlError && err.code === "ui_target_outside"
    );
    assert.equal(inputEvents.some((ev) => ev.type === "mouseDown"), false);

    // R2-4: reachable drag where resolving `to` (line 7) scrolls `from` (line 5) updates start coordinates instead of using stale pixels.
    scrollA = 0;
    inputEvents.length = 0;
    const dragRes = (await ui.drag({
      from: { note: "Notes/Alpha.md", line: 5, at: "start" },
      to: { note: "Notes/Alpha.md", line: 7, at: "start" },
    })) as { from: { y: number }; to: { y: number } };
    assert.ok(scrollA > 0);
    assert.equal(dragRes.from.y, 100 + 4 * 140 - scrollA + 10);
    const firstDown = inputEvents.find((ev) => ev.type === "mouseDown") as { y: number } | undefined;
    assert.equal(firstDown?.y, Math.round(dragRes.from.y));

    // beforeMutation hook: fires inside UI lock before input for click, type, pressKey, insertLine, drag; never for scroll/locate/inspect.
    scrollA = 0;
    mutationCalls.length = 0;
    timeline.length = 0;

    await ui.scroll({ target: { x: 100, y: 100 }, deltaY: 20 }, "herdr:p1");
    ui.inspect({ text: "Ready" });
    assert.equal(mutationCalls.length, 0);

    await ui.click({ target: { note: "Notes/Alpha.md", line: 1 } }, "herdr:p1");
    await ui.pressKey({ key: "a" }, "herdr:p1");
    await ui.type({ target: { note: "Notes/Beta.md", after: "- beta line" }, text: " ok" }, "herdr:p2");
    await ui.drag(
      { from: { note: "Notes/Alpha.md", line: 1, at: "start" }, to: { note: "Notes/Alpha.md", line: 2, at: "start" } },
      "herdr:p1"
    );

    assert.deepEqual(
      mutationCalls.map((m) => [m.action, m.notePath, m.paneId, m.caller]),
      [
        ["click", "Notes/Alpha.md", "pane-a", "herdr:p1"],
        ["press_key", "Notes/Alpha.md", "pane-a", "herdr:p1"],
        ["type", "Notes/Beta.md", "pane-b", "herdr:p2"],
        ["drag", "Notes/Alpha.md", "pane-a", "herdr:p1"],
      ]
    );
    // For type with anchored target Beta.md, beforeMutation fires before CM dispatch and never double-fires click.
    const typeMutIdx = timeline.indexOf("beforeMutation:type:Notes/Beta.md:herdr:p2");
    const firstBetaInsertIdx = timeline.findIndex((t) => t.startsWith("cm-dispatch-b:"));
    assert.ok(typeMutIdx >= 0 && firstBetaInsertIdx > typeMutIdx);

    // Concurrent queued insertLines capture sequential pre-mutation snapshots inside the lock (R2-1 prevention)
    // and run the returned completion callback before the next queued step begins.
    mutationCalls.length = 0;
    timeline.length = 0;
    await Promise.all([
      ui.insertLine({ target: { note: "Notes/Alpha.md", after: "- Ready" }, text: "X" }, "agentA"),
      ui.insertLine({ target: { note: "Notes/Alpha.md", after: "X" }, text: "Y" }, "agentB"),
    ]);
    assert.equal(mutationCalls.length, 2);
    assert.equal(mutationCalls[0].action, "insert_line");
    assert.equal(mutationCalls[0].snapshotText.includes("\nX\n"), false);
    assert.equal(mutationCalls[1].snapshotText.includes("\nX\n"), true);
    assert.equal(mutationCalls[1].snapshotText.includes("\nY\n"), false);
    const aAfter = timeline.indexOf("afterMutation:insert_line:Notes/Alpha.md:agentA");
    const bBefore = timeline.indexOf("beforeMutation:insert_line:Notes/Alpha.md:agentB");
    assert.ok(aAfter >= 0 && bBefore > aAfter);

    // Completion callback still runs in finally inside the lock on partial typing failure.
    let partialCompleteCalled = false;
    const partialUi = new UiControlService({
      win: {
        ...win,
        document: { ...doc, activeElement: cmElA },
      } as unknown as Window,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(800, 600)),
        sendInputEvent: () => undefined,
        insertText: async () => undefined,
        getZoomFactor: () => 1,
      }),
      sleep: async () => {
        (partialUi as unknown as { win: { document: { activeElement: unknown } } }).win.document.activeElement = null;
      },
      resolveElementContext: () => ({ notePath: "Notes/Alpha.md", pane: "pane-a", activePane: true }),
      beforeMutation: () => () => {
        partialCompleteCalled = true;
      },
    });
    await assert.rejects(
      () => partialUi.type({ text: "first second" }, "agentPartial"),
      (err: unknown) => err instanceof UiControlError && err.code === "ui_not_editable"
    );
    assert.equal(partialCompleteCalled, true);
  });

  it("keeps a 3-line scroll margin above the footer and status bar while typing near the bottom", async () => {
    const lineHeight = 20;
    const expectedMargin = 3 * lineHeight;
    let docLines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`);
    const offsetsFor = (lines: string[]) => {
      let off = 0;
      return lines.map((line, i) => {
        const from = off;
        const to = from + line.length;
        off = to + 1;
        return { number: i + 1, text: line, from, to };
      });
    };

    const scroller = {
      scrollTop: 220,
      scrollHeight: 1600,
      clientHeight: 500,
      getBoundingClientRect: () => ({
        x: 0,
        y: 40,
        left: 0,
        top: 40,
        right: 800,
        bottom: 540,
        width: 800,
        height: 500,
      }),
    };

    // Place caret at line 35 (y = 40 + 34 * 20 - 220 = 500, bottom = 520) inside the 500px scroller
    // ending at y = 540, with a visible status bar overlapping the bottom 28px (top = 512..540).
    let headPos = offsetsFor(docLines)[34].to;
    const cmState = {
      doc: {
        get length() {
          return docLines.join("\n").length;
        },
        get lines() {
          return docLines.length;
        },
        toString: () => docLines.join("\n"),
        line: (n: number) => offsetsFor(docLines)[n - 1],
      },
      selection: {
        main: {
          get head() {
            return headPos;
          },
        },
      },
    };

    let statusBarVisible = true;
    const statusBarEl = {
      getBoundingClientRect: () => ({
        x: 0,
        y: 512,
        left: 0,
        top: 512,
        right: 1200,
        bottom: 540,
        width: 1200,
        height: 28,
      }),
    };

    let cmEl: Record<string, unknown>;
    const cmView = {
      contentDOM: undefined as unknown as Element,
      scrollDOM: scroller as unknown as HTMLElement,
      state: cmState,
      coordsAtPos: (pos: number) => {
        const list = offsetsFor(docLines);
        const found = list.find((l) => pos >= l.from && pos <= l.to) ?? list[list.length - 1];
        const top = 40 + (found.number - 1) * lineHeight - scroller.scrollTop;
        const left = 60 + Math.max(0, pos - found.from) * 7;
        return { left, top, right: left + 2, bottom: top + lineHeight };
      },
      dispatch: (spec: Record<string, unknown>) => {
        const ch = spec.changes as { from: number; insert: string } | undefined;
        if (ch && typeof ch.insert === "string") {
          const raw = docLines.join("\n");
          docLines = (raw.slice(0, ch.from) + ch.insert + raw.slice(ch.from)).split("\n");
        }
        const sel = spec.selection as { anchor?: number } | undefined;
        if (sel && typeof sel.anchor === "number") {
          headPos = sel.anchor;
        }
        // Mirror real CM6 minimal scrollIntoView: only brings line to 5px above scroller bottom.
        const effectPos = extractScrollEffectPos(spec);
        if (spec.scrollIntoView || effectPos !== null) {
          const rect = cmView.coordsAtPos(effectPos ?? headPos);
          if (rect.bottom > 540 - 4) {
            scroller.scrollTop += rect.bottom - (540 - 5);
          } else if (rect.top < 40 + 4) {
            scroller.scrollTop = Math.max(0, scroller.scrollTop + rect.top - (40 + 5));
          }
        }
      },
      focus: () => {
        doc.activeElement = cmEl;
      },
    };

    cmEl = {
      tagName: "DIV",
      isConnected: true,
      isContentEditable: true,
      matches: (s: string) => s.includes("div"),
      closest: (s: string) => (s.includes(".workspace-leaf") ? leafEl : null),
      getAttribute: () => null,
      contains: (o: unknown) => o === cmEl,
      focus: () => cmView.focus(),
      cmView: { view: cmView },
    };
    cmView.contentDOM = cmEl as unknown as Element;

    const leafEl = {
      tagName: "DIV",
      isConnected: true,
      id: "pane-bottom",
      classList: { contains: (c: string) => c === "mod-active" },
      contains: (n: unknown) => n === cmEl,
      querySelector: () => null,
      querySelectorAll: () => [],
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 0, y: 40, left: 0, top: 40, right: 800, bottom: 540, width: 800, height: 500 }),
    };

    const doc: Record<string, unknown> = {
      activeElement: cmEl,
      body: { innerText: "Bottom Scroll" },
      documentElement: {},
      querySelector: (sel: string) => (sel === ".status-bar" && statusBarVisible ? statusBarEl : null),
      querySelectorAll: () => [],
      elementFromPoint: () => cmEl,
    };

    const win = {
      innerWidth: 1200,
      innerHeight: 540,
      devicePixelRatio: 1,
      document: doc,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      setTimeout,
    } as unknown as Window;

    const emittedTypeY: number[] = [];
    const ui = new UiControlService({
      win,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(1200, 540)),
        sendInputEvent: () => undefined,
        insertText: async (chunk: string) => {
          const raw = docLines.join("\n");
          docLines = (raw.slice(0, headPos) + chunk + raw.slice(headPos)).split("\n");
          headPos += chunk.length;
        },
        getZoomFactor: () => 1,
      }),
      sleep: noSleep,
      resolveElementContext: () => ({ notePath: "Notes/Bottom.md", pane: "pane-bottom", activePane: true }),
      resolveNoteLeaf: (p) =>
        p === "Notes/Bottom.md"
          ? { path: p, pane: "pane-bottom", activePane: true, containerEl: leafEl as unknown as Element, cm: cmView }
          : null,
      cursorOverlay: {
        moveTo: () => undefined,
        pulseClick: () => undefined,
        setTyping: (_caller: string, _label: string, _x: number, y: number) => {
          emittedTypeY.push(y);
        },
      } as unknown as AgentCursorOverlay,
    });

    // 1. Typing starting near the status-bar-clipped bottom scrolls up immediately so the caret and
    //    every emitted typing cursor sit >= 3 lines above the status bar top (512 - 60 = 452).
    await ui.type({ text: "alpha beta gamma" }, "agy1");
    assert.ok(scroller.scrollTop > 220, "Typing near bottom must advance scrollTop before clipping");
    const afterTypeBox = cmView.coordsAtPos(headPos);
    assert.ok(
      afterTypeBox.bottom <= 512 - expectedMargin,
      `Expected caret bottom (${afterTypeBox.bottom}) <= ${512 - expectedMargin}`
    );
    assert.ok(
      emittedTypeY.length > 0 && emittedTypeY.every((y) => y <= 512 - expectedMargin),
      `All typing cursor Y positions (${emittedTypeY.join(",")}) must stay above the 3-line status-bar margin`
    );

    // 2. insertLine after line 39 (offscreen below) dispatches CM6 scrollIntoView and enforces the
    //    3-line margin above scroller bottom even without a status bar overlap.
    statusBarVisible = false;
    emittedTypeY.length = 0;
    await ui.insertLine({ target: { note: "Notes/Bottom.md", line: 39 }, text: "- bottom bullet" }, "agy1");
    const afterInsertBox = cmView.coordsAtPos(headPos);
    assert.ok(
      afterInsertBox.bottom <= 540 - expectedMargin,
      `Expected insertLine caret bottom (${afterInsertBox.bottom}) <= ${540 - expectedMargin}`
    );
    assert.ok(
      emittedTypeY.length > 0 && emittedTypeY.every((y) => y <= 540 - expectedMargin),
      "insertLine typing cursors must stay inside the 3-line margin above scroller bottom"
    );

    // 3. Caret too close to the top edge pulls back to preserve the top margin without negative scrollTop.
    headPos = offsetsFor(docLines)[1].to;
    scroller.scrollTop = 20; // line 2 top = 40 + 20 - 20 = 40 (touches top edge of scroller)
    await ui.type({ text: "!" }, "agy1");
    const afterTopBox = cmView.coordsAtPos(headPos);
    assert.equal(scroller.scrollTop, 0, "Top margin scroll clamps cleanly at scrollTop 0");
    assert.ok(afterTopBox.top >= 40);
  });

  it("wires document anchors, note updates, and finishTyping to AgentCursorOverlay and covers type focus-click under beforeMutation (R3-1, R3-2, R3-3)", async () => {
    function makeEl(tag: string) {
      const classes = new Set<string>();
      const attrs = new Map<string, string>();
      const children: Array<ReturnType<typeof makeEl>> = [];
      const props = new Map<string, string>();
      let parentChildren: Array<ReturnType<typeof makeEl>> | null = null;
      const el = {
        tagName: tag.toUpperCase(),
        isConnected: true,
        offsetWidth: 24,
        textContent: "",
        children,
        classList: {
          add: (...names: string[]) => names.forEach((n) => classes.add(n)),
          remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
          contains: (name: string) => classes.has(name),
          toggle: (name: string, force?: boolean) => {
            if (force === undefined) {
              if (classes.has(name)) classes.delete(name);
              else classes.add(name);
              return classes.has(name);
            }
            if (force) classes.add(name);
            else classes.delete(name);
            return force;
          },
        },
        style: {
          transform: "",
          setProperty: (k: string, v: string) => props.set(k, v),
          getPropertyValue: (k: string) => props.get(k) ?? "",
        },
        setAttribute: (k: string, v: string) => attrs.set(k, v),
        getAttribute: (k: string) => attrs.get(k) ?? null,
        appendChild: (child: ReturnType<typeof makeEl>) => {
          children.push(child);
          return child;
        },
        remove: () => {
          el.isConnected = false;
          if (parentChildren) {
            const idx = parentChildren.indexOf(el);
            if (idx >= 0) parentChildren.splice(idx, 1);
          }
        },
        createDiv: (opts?: { cls?: string; attr?: Record<string, string> }) => {
          const child = makeEl("div");
          if (opts?.cls) opts.cls.split(/\s+/).filter(Boolean).forEach((c) => child.classList.add(c));
          if (opts?.attr) {
            for (const [k, v] of Object.entries(opts.attr)) child.setAttribute(k, v);
          }
          child._setParent(children);
          children.push(child);
          return child;
        },
        createSpan: (opts?: { cls?: string; text?: string }) => {
          const child = makeEl("span");
          if (opts?.cls) opts.cls.split(/\s+/).filter(Boolean).forEach((c) => child.classList.add(c));
          if (opts?.text) child.textContent = opts.text;
          child._setParent(children);
          children.push(child);
          return child;
        },
        _setParent: (list: Array<ReturnType<typeof makeEl>>) => {
          parentChildren = list;
        },
      };
      return el;
    }

    const lineHeight = 24;
    let docLines = ["# Board", "## Section", "Line three", "Target line", "After target"];
    const offsetsFor = (lines: string[]) => {
      let off = 0;
      return lines.map((line, i) => {
        const from = off;
        const to = from + line.length;
        off = to + 1;
        return { number: i + 1, text: line, from, to };
      });
    };

    let headPos = offsetsFor(docLines)[3].to;
    let reflowOffset = 0;
    const scrollListeners = new Map<string, Array<() => void>>();
    const resizeCallbacks: Array<(entries: Array<{ target: unknown }>) => void> = [];
    const observedResizeTargets: unknown[] = [];

    class MockResizeObserver {
      private readonly cb: (entries: Array<{ target: unknown }>) => void;
      constructor(cb: (entries: Array<{ target: unknown }>) => void) {
        this.cb = cb;
        resizeCallbacks.push(cb);
      }
      observe(target: unknown): void {
        observedResizeTargets.push(target);
      }
      disconnect(): void {
        // No-op for test.
      }
    }

    const scrollerEl = {
      isConnected: true,
      scrollTop: 0,
      scrollHeight: 2000,
      clientHeight: 600,
      addEventListener: (ev: string, fn: () => void) => {
        const list = scrollListeners.get(ev) ?? [];
        list.push(fn);
        scrollListeners.set(ev, list);
      },
      removeEventListener: () => undefined,
      getBoundingClientRect: () => ({
        x: 0,
        y: 60,
        left: 0,
        top: 60,
        right: 700,
        bottom: 660,
        width: 700,
        height: 600,
      }),
    };

    let cmContentEl: Record<string, unknown>;
    const cmState = {
      doc: {
        get length() {
          return docLines.join("\n").length;
        },
        get lines() {
          return docLines.length;
        },
        toString: () => docLines.join("\n"),
        line: (n: number) => offsetsFor(docLines)[n - 1],
      },
      selection: {
        main: {
          get head() {
            return headPos;
          },
        },
      },
    };
    const cmView = {
      dom: null as unknown as Element,
      contentDOM: null as unknown as Element,
      scrollDOM: scrollerEl as unknown as HTMLElement,
      state: cmState,
      coordsAtPos: (pos: number) => {
        const list = offsetsFor(docLines);
        const found = list.find((l) => pos >= l.from && pos <= l.to) ?? list[list.length - 1];
        const top = 80 + (found.number - 1) * lineHeight + reflowOffset - scrollerEl.scrollTop;
        const left = 60 + Math.max(0, pos - found.from) * 7;
        return { left, top, right: left + 2, bottom: top + lineHeight };
      },
      dispatch: (spec: Record<string, unknown>) => {
        const ch = spec.changes as { from: number; insert: string } | undefined;
        if (ch && typeof ch.insert === "string") {
          const raw = docLines.join("\n");
          docLines = (raw.slice(0, ch.from) + ch.insert + raw.slice(ch.from)).split("\n");
        }
        const sel = spec.selection as { anchor?: number } | undefined;
        if (sel && typeof sel.anchor === "number") {
          headPos = sel.anchor;
        }
      },
      focus: () => {
        doc.activeElement = cmContentEl;
      },
    };
    cmContentEl = {
      tagName: "DIV",
      isConnected: true,
      isContentEditable: true,
      matches: (s: string) => s.includes("div") && !s.includes("password"),
      closest: (s: string) => (s.includes(".workspace-leaf") ? leafEl : null),
      getAttribute: () => null,
      contains: (o: unknown) => o === cmContentEl,
      focus: () => cmView.focus(),
      getBoundingClientRect: () => ({ x: 0, y: 60, left: 0, top: 60, right: 700, bottom: 660, width: 700, height: 600 }),
      cmView: { view: cmView },
    };
    cmView.contentDOM = cmContentEl as unknown as Element;
    cmView.dom = cmContentEl as unknown as Element;

    const leafEl = {
      tagName: "DIV",
      isConnected: true,
      id: "pane-board",
      classList: { contains: (c: string) => c === "mod-active" },
      contains: (n: unknown) => n === cmContentEl,
      querySelector: () => null,
      querySelectorAll: () => [],
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 0, y: 60, left: 0, top: 60, right: 700, bottom: 660, width: 700, height: 600 }),
    };

    let checkboxChecked = false;
    const checkboxEl = {
      tagName: "INPUT",
      isConnected: true,
      disabled: false,
      isContentEditable: false,
      readOnly: false,
      matches: (s: string) => s.includes(".task-checkbox"),
      closest: (s: string) => (s.includes(".workspace-leaf") ? leafEl : null),
      contains: (o: unknown) => o === checkboxEl,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 20, y: 120, left: 20, top: 120, right: 40, bottom: 140, width: 20, height: 20 }),
    };

    const body = makeEl("body");
    const doc: Record<string, unknown> = {
      activeElement: cmContentEl,
      body,
      documentElement: {},
      createDiv: body.createDiv,
      createElementNS: () => makeEl("svg"),
      querySelector: (sel: string) => (sel === ".task-checkbox" ? checkboxEl : null),
      querySelectorAll: (sel: string) => (sel === ".task-checkbox" ? [checkboxEl] : []),
      elementFromPoint: (x: number, y: number) => (x < 45 && y >= 120 && y <= 140 ? checkboxEl : cmContentEl),
    };

    let nextTimer = 1;
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    const win = {
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 1,
      document: doc,
      performance: { now: () => Date.now() },
      matchMedia: () => ({ matches: true }),
      ResizeObserver: MockResizeObserver,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      requestAnimationFrame: (cb: (t: number) => void) => {
        cb(Date.now());
        return 1;
      },
      cancelAnimationFrame: () => undefined,
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextTimer++;
        timers.set(id, setTimeout(fn, ms));
        return id;
      },
      clearTimeout: (id: number) => {
        const h = timers.get(id);
        if (h) clearTimeout(h);
        timers.delete(id);
      },
    } as unknown as Window;

    const overlay = new AgentCursorOverlay({ win, enabled: true, idleAfterMs: 1500, hideAfterMs: 60000 });
    const hookRecords: Array<{ action: string; beforeChecked: boolean; afterChecked?: boolean }> = [];
    let moveFocusAwayOnSleep = false;

    const ui = new UiControlService({
      win,
      cursorOverlay: overlay,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(1200, 800)),
        sendInputEvent: (ev) => {
          if (ev.type === "mouseDown" && Number(ev.x) < 45) {
            checkboxChecked = !checkboxChecked;
            doc.activeElement = checkboxEl;
          }
        },
        insertText: async (chunk: string) => {
          const raw = docLines.join("\n");
          docLines = (raw.slice(0, headPos) + chunk + raw.slice(headPos)).split("\n");
          headPos += chunk.length;
        },
        getZoomFactor: () => 1,
      }),
      sleep: async () => {
        if (moveFocusAwayOnSleep) {
          doc.activeElement = checkboxEl;
        }
      },
      resolveElementContext: (el) => {
        if (el === cmContentEl || el === leafEl || el === checkboxEl) {
          return { notePath: "Notes/Board.md", pane: "pane-board", activePane: true };
        }
        return null;
      },
      resolveNoteLeaf: (p) =>
        p === "Notes/Board.md"
          ? { path: p, pane: "pane-board", activePane: true, containerEl: leafEl as unknown as Element, cm: cmView }
          : null,
      beforeMutation: (ctx) => {
        const rec: { action: string; beforeChecked: boolean; afterChecked?: boolean } = {
          action: ctx.action,
          beforeChecked: checkboxChecked,
        };
        hookRecords.push(rec);
        return () => {
          rec.afterChecked = checkboxChecked;
        };
      },
    });

    try {
      const parseTranslateY = (el: ReturnType<typeof makeEl>): number => {
        const m = /translate3d\([^,]+,\s*(-?\d+(?:\.\d+)?)px/.exec(el.style.transform);
        return m ? Number(m[1]) : Number.NaN;
      };
      const layer = () => body.children.find((c) => c.classList.contains("herdr-cursor-layer"));
      const cursorElAt = (idx: number) => layer()?.children[idx];

      // R3-1 + R3-3: ui.type through production path finishes typing immediately and installs document anchor + observers.
      await ui.type({ target: { note: "Notes/Board.md", line: 4, at: "end" }, text: " hello" }, "herdr:agy1");
      const agy1El = cursorElAt(0)!;
      assert.ok(agy1El, "Overlay cursor element must exist after ui.type");
      assert.equal(agy1El.classList.contains("is-typing"), false, "R3-3: typing class must clear when ui.type resolves");
      assert.equal(agy1El.classList.contains("is-idle"), true, "R3-3: cursor must park immediately on completion");
      const agy1Action = agy1El.children.find((c) => c.classList.contains("herdr-cursor-pill"))?.children.find((c) => c.classList.contains("herdr-cursor-action"));
      assert.equal(agy1Action?.textContent ?? "", "", "R3-3: action label must clear immediately after ui.type");
      const initialParkedY = parseTranslateY(agy1El);
      assert.ok(observedResizeTargets.includes(scrollerEl), "R3-1: ResizeObserver must track scrollDOM");

      // Another agent inserts a line above agy1's parked cursor -> agy1 shifts down automatically.
      await ui.insertLine({ target: { note: "Notes/Board.md", line: 1 }, text: "inserted above" }, "herdr:sol1");
      const shiftedY = parseTranslateY(agy1El);
      assert.equal(shiftedY, initialParkedY + lineHeight, "R3-1: parked cursor shifts down by 1 line after edit above");

      // Layout reflow triggers ResizeObserver -> agy1 reprojects without another UI call.
      reflowOffset = 36;
      for (const cb of resizeCallbacks) {
        cb([{ target: scrollerEl }]);
      }
      assert.equal(parseTranslateY(agy1El), shiftedY + 36, "R3-1: parked cursor updates on ResizeObserver reflow");

      // Editor scroll event triggers scroll listener -> agy1 follows text and hides when scrolled past top edge.
      scrollerEl.scrollTop = 200;
      for (const fn of scrollListeners.get("scroll") ?? []) {
        fn();
      }
      assert.equal(agy1El.classList.contains("is-offscreen"), true, "R3-1: offscreen parked cursor hides cleanly");
      scrollerEl.scrollTop = 0;
      reflowOffset = 0;

      // R3-3 partial focus drift: finishTyping still fires in finally when chunk 2 aborts.
      doc.activeElement = cmContentEl;
      moveFocusAwayOnSleep = true;
      await assert.rejects(
        () => ui.type({ text: "first second" }, "herdr:agy1"),
        (err: unknown) => err instanceof UiControlError && err.code === "ui_not_editable"
      );
      moveFocusAwayOnSleep = false;
      assert.equal(agy1El.classList.contains("is-typing"), false, "R3-3: partial failure also clears typing state");

      // R3-2: ui.type(target) wraps its preparatory focus-click inside beforeMutation/completion.
      hookRecords.length = 0;
      checkboxChecked = false;
      await assert.rejects(
        () => ui.type({ target: { selector: ".task-checkbox" }, text: "cannot type" }, "herdr:agy1"),
        (err: unknown) => err instanceof UiControlError && err.code === "ui_not_editable"
      );
      assert.equal(hookRecords.length, 1, "R3-2: beforeMutation must wrap the focus-click before editability rejection");
      assert.equal(hookRecords[0].action, "type");
      assert.equal(hookRecords[0].beforeChecked, false);
      assert.equal(hookRecords[0].afterChecked, true, "R3-2: completion callback sees click mutation in finally");
    } finally {
      overlay.dispose();
    }
  });

  it("scrolls offscreen heading targets clear of status-bar edges and never leaves a parked text-anchored cursor after ui.scroll", async () => {
    const lineHeight = 22;
    let docLines = [
      ...Array.from({ length: 22 }, (_, i) => `Line ${i + 1}`),
      "## sol3: Review verdict",
      "",
      "## Log",
    ];
    const offsetsFor = (lines: string[]) => {
      let off = 0;
      return lines.map((line, i) => {
        const from = off;
        const to = from + line.length;
        off = to + 1;
        return { number: i + 1, text: line, from, to };
      });
    };

    const makeEl = (tag: string, initialCls = "") => {
      const classes = new Set(initialCls.split(/\s+/).filter(Boolean));
      const attrs = new Map<string, string>();
      const styleMap = new Map<string, string>();
      const listeners = new Map<string, Array<() => void>>();
      const el: {
        tagName: string;
        isConnected: boolean;
        textContent: string;
        children: Array<ReturnType<typeof makeEl>>;
        parentElement: ReturnType<typeof makeEl> | null;
        style: {
          transform: string;
          setProperty: (k: string, v: string) => void;
          getPropertyValue: (k: string) => string;
        };
        classList: {
          add: (...c: string[]) => void;
          remove: (...c: string[]) => void;
          contains: (c: string) => boolean;
          toggle: (c: string, force?: boolean) => void;
        };
        offsetWidth: number;
        setAttribute: (k: string, v: string) => void;
        getAttribute: (k: string) => string | null;
        addEventListener: (ev: string, fn: () => void) => void;
        removeEventListener: (ev: string, fn: () => void) => void;
        dispatchEvent: (ev: string) => void;
        createDiv: (opts?: { cls?: string; attr?: Record<string, string> }) => ReturnType<typeof makeEl>;
        createSpan: (opts?: { cls?: string; text?: string }) => ReturnType<typeof makeEl>;
        appendChild: (c: ReturnType<typeof makeEl>) => ReturnType<typeof makeEl>;
        remove: () => void;
        contains: (other: unknown) => boolean;
      } = {
        tagName: tag.toUpperCase(),
        isConnected: true,
        textContent: "",
        children: [],
        parentElement: null,
        style: {
          transform: "",
          setProperty: (k: string, v: string) => {
            styleMap.set(k, v);
          },
          getPropertyValue: (k: string) => styleMap.get(k) ?? "",
        },
        classList: {
          add: (...cs: string[]) => cs.forEach((c) => classes.add(c)),
          remove: (...cs: string[]) => cs.forEach((c) => classes.delete(c)),
          contains: (c: string) => classes.has(c),
          toggle: (c: string, force?: boolean) => {
            const on = force === undefined ? !classes.has(c) : force;
            if (on) classes.add(c);
            else classes.delete(c);
          },
        },
        offsetWidth: 0,
        setAttribute: (k: string, v: string) => {
          attrs.set(k, v);
        },
        getAttribute: (k: string) => attrs.get(k) ?? null,
        addEventListener: (ev: string, fn: () => void) => {
          const list = listeners.get(ev) ?? [];
          list.push(fn);
          listeners.set(ev, list);
        },
        removeEventListener: (ev: string, fn: () => void) => {
          const list = listeners.get(ev) ?? [];
          listeners.set(ev, list.filter((x) => x !== fn));
        },
        dispatchEvent: (ev: string) => {
          for (const fn of listeners.get(ev) ?? []) fn();
        },
        createDiv: (opts) => {
          const child = makeEl("div", opts?.cls ?? "");
          for (const [k, v] of Object.entries(opts?.attr ?? {})) child.setAttribute(k, v);
          return el.appendChild(child);
        },
        createSpan: (opts) => {
          const child = makeEl("span", opts?.cls ?? "");
          if (opts?.text) child.textContent = opts.text;
          return el.appendChild(child);
        },
        appendChild: (c) => {
          c.parentElement = el;
          c.isConnected = el.isConnected;
          el.children.push(c);
          return c;
        },
        remove: () => {
          el.isConnected = false;
          if (el.parentElement) {
            el.parentElement.children = el.parentElement.children.filter((x) => x !== el);
          }
        },
        contains: (other: unknown): boolean => other === el || el.children.some((c) => c.contains(other)),
      };
      return el;
    };

    const scroller = {
      scrollTop: 0,
      scrollHeight: 1400,
      clientHeight: 460,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getBoundingClientRect: () => ({
        x: 0,
        y: 40,
        left: 0,
        top: 40,
        right: 900,
        bottom: 500,
        width: 900,
        height: 460,
      }),
    };

    // Visible status bar covers bottom 26px of scroller (y = 474..500).
    const statusBarEl = {
      getBoundingClientRect: () => ({
        x: 0,
        y: 474,
        left: 0,
        top: 474,
        right: 1200,
        bottom: 500,
        width: 1200,
        height: 26,
      }),
    };

    let headPos = 0;
    let cmEl: Record<string, unknown>;
    const cmView = {
      contentDOM: undefined as unknown as Element,
      scrollDOM: scroller as unknown as HTMLElement,
      state: {
        doc: {
          get length() {
            return docLines.join("\n").length;
          },
          get lines() {
            return docLines.length;
          },
          toString: () => docLines.join("\n"),
          line: (n: number) => offsetsFor(docLines)[n - 1],
        },
        selection: {
          main: {
            get head() {
              return headPos;
            },
          },
        },
      },
      coordsAtPos: (pos: number) => {
        const list = offsetsFor(docLines);
        const found = list.find((l) => pos >= l.from && pos <= l.to) ?? list[list.length - 1];
        // Simulate CM6 virtualizing lines > 21 until scroller reaches >= 60px.
        if (found.number >= 23 && scroller.scrollTop < 10) {
          return null;
        }
        const top = 40 + (found.number - 1) * lineHeight - scroller.scrollTop;
        const left = 60 + Math.max(0, pos - found.from) * 7;
        return { left, top, right: left + 2, bottom: top + lineHeight };
      },
      dispatch: (spec: Record<string, unknown>) => {
        const ch = spec.changes as { from: number; insert: string } | undefined;
        if (ch && typeof ch.insert === "string") {
          const raw = docLines.join("\n");
          docLines = (raw.slice(0, ch.from) + ch.insert + raw.slice(ch.from)).split("\n");
        }
        const sel = spec.selection as { anchor?: number } | undefined;
        if (sel && typeof sel.anchor === "number") {
          headPos = sel.anchor;
        }
        // Minimal CM6 scrollIntoView puts line 23 at scroller bottom (500), behind status-bar (474..500).
        const effectPos = extractScrollEffectPos(spec);
        if (spec.scrollIntoView || effectPos !== null) {
          const list = offsetsFor(docLines);
          const targetPos = effectPos ?? headPos;
          const found = list.find((l) => targetPos >= l.from && targetPos <= l.to) ?? list[list.length - 1];
          const bottom = 40 + (found.number - 1) * lineHeight + lineHeight - scroller.scrollTop;
          if (bottom > 495) {
            scroller.scrollTop += bottom - 495;
          }
        }
      },
      focus: () => {
        doc.activeElement = cmEl;
      },
    };

    cmEl = {
      tagName: "DIV",
      isConnected: true,
      isContentEditable: true,
      matches: (s: string) => s.includes("div"),
      closest: (s: string) => (s.includes(".workspace-leaf") ? leafEl : null),
      getAttribute: () => null,
      contains: (o: unknown) => o === cmEl,
      focus: () => cmView.focus(),
      cmView: { view: cmView },
    };
    cmView.contentDOM = cmEl as unknown as Element;

    const leafEl = {
      tagName: "DIV",
      isConnected: true,
      id: "pane-board",
      classList: { contains: (c: string) => c === "mod-active" },
      contains: (n: unknown) => n === cmEl,
      querySelector: () => null,
      querySelectorAll: () => [],
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 0, y: 40, left: 0, top: 40, right: 900, bottom: 500, width: 900, height: 460 }),
    };

    const body = makeEl("body");
    const doc: Record<string, unknown> = {
      activeElement: cmEl,
      body,
      documentElement: {},
      createDiv: body.createDiv,
      createElementNS: () => makeEl("svg"),
      querySelector: (sel: string) => (sel === ".status-bar" ? statusBarEl : null),
      querySelectorAll: () => [],
      elementFromPoint: () => cmEl,
    };

    let nextTimer = 1;
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    const win = {
      innerWidth: 1200,
      innerHeight: 500,
      devicePixelRatio: 1,
      document: doc,
      performance: { now: () => Date.now() },
      matchMedia: () => ({ matches: false }),
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      requestAnimationFrame: (cb: (t: number) => void) => {
        cb(Date.now());
        return 1;
      },
      cancelAnimationFrame: () => undefined,
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextTimer++;
        timers.set(id, setTimeout(fn, ms));
        return id;
      },
      clearTimeout: (id: number) => {
        const h = timers.get(id);
        if (h) clearTimeout(h);
        timers.delete(id);
      },
    } as unknown as Window;

    const overlay = new AgentCursorOverlay({ win, enabled: true, idleAfterMs: 1500, hideAfterMs: 60000 });
    const ui = new UiControlService({
      win,
      cursorOverlay: overlay,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(1200, 500)),
        sendInputEvent: (ev) => {
          if (ev.type === "mouseWheel") {
            scroller.scrollTop = Math.max(0, scroller.scrollTop - Number(ev.deltaY ?? 0));
          }
        },
        insertText: async (chunk: string) => {
          const raw = docLines.join("\n");
          docLines = (raw.slice(0, headPos) + chunk + raw.slice(headPos)).split("\n");
          headPos += chunk.length;
        },
        getZoomFactor: () => 1,
      }),
      sleep: noSleep,
      resolveElementContext: (el) =>
        el === cmEl || el === leafEl ? { notePath: "Crew Test/Mission Board 2.md", pane: "pane-board", activePane: true } : null,
      resolveNoteLeaf: (p) =>
        p === "Crew Test/Mission Board 2.md"
          ? { path: p, pane: "pane-board", activePane: true, containerEl: leafEl as unknown as Element, cm: cmView }
          : null,
    });

    try {
      // 1) Even with line 23 offscreen & virtualized behind a visible status bar, heading insertLine scrolls clear into view inside the lock instead of throwing ui_target_outside.
      const insertRes = (await ui.insertLine(
        {
          target: { note: "Crew Test/Mission Board 2.md", heading: "sol3: Review verdict" },
          text: "- PASS",
        },
        "herdr:sol3"
      )) as { line: number; scrolled: boolean };
      assert.equal(insertRes.scrolled, true);
      assert.equal(insertRes.line, 24);
      assert.equal(docLines[23], "- PASS");
      assert.ok(scroller.scrollTop > 0);

      // 2) ui.scroll over editor text clears any existing doc anchor and fades out cleanly (never leaves a parked text-anchored cursor).
      const layer = () => body.children.find((c) => c.classList.contains("herdr-cursor-layer"));
      assert.equal(overlay.getActiveCount(), 1);
      await ui.scroll({ target: { x: 200, y: 200 }, deltaY: 120 }, "herdr:sol3");
      assert.equal(overlay.getActiveCount(), 0, "Scroll must not leave an active parked cursor");
      const fadingCursor = layer()?.children.find((c) => c.classList.contains("is-exiting"));
      assert.ok(fadingCursor, "Cursor fades out with is-exiting after scroll");
      assert.equal(fadingCursor.classList.contains("is-idle"), false);

      // Fresh caller scrolling directly also fades cleanly instead of parking anchored over scrolled text.
      await ui.scroll({ target: { x: 200, y: 200 }, deltaY: -80 }, "herdr:orch");
      assert.equal(overlay.getActiveCount(), 0);
      await new Promise((r) => setTimeout(r, 270));
      assert.equal(layer()?.children.length ?? 0, 0, "Scroll cursors detach completely after exit fade");
    } finally {
      overlay.dispose();
    }
  });

  it("glides cursor via pointAtResult to opened tabs/editors, file-tree items, and command modals with honest labels", async () => {
    const makeNode = (tag: string, initialCls = "") => {
      const classes = new Set(initialCls.split(/\s+/).filter(Boolean));
      const attrs = new Map<string, string>();
      const styleMap = new Map<string, string>();
      const node: {
        tagName: string;
        isConnected: boolean;
        textContent: string;
        children: Array<ReturnType<typeof makeNode>>;
        parentElement: ReturnType<typeof makeNode> | null;
        style: {
          transform: string;
          setProperty: (k: string, v: string) => void;
          getPropertyValue: (k: string) => string;
        };
        classList: {
          add: (...c: string[]) => void;
          remove: (...c: string[]) => void;
          contains: (c: string) => boolean;
          toggle: (c: string, force?: boolean) => void;
        };
        offsetWidth: number;
        setAttribute: (k: string, v: string) => void;
        getAttribute: (k: string) => string | null;
        addEventListener: () => void;
        removeEventListener: () => void;
        createDiv: (opts?: { cls?: string; attr?: Record<string, string> }) => ReturnType<typeof makeNode>;
        createSpan: (opts?: { cls?: string; text?: string }) => ReturnType<typeof makeNode>;
        appendChild: (c: ReturnType<typeof makeNode>) => ReturnType<typeof makeNode>;
        remove: () => void;
        contains: (other: unknown) => boolean;
      } = {
        tagName: tag.toUpperCase(),
        isConnected: true,
        textContent: "",
        children: [],
        parentElement: null,
        style: {
          transform: "",
          setProperty: (k: string, v: string) => {
            styleMap.set(k, v);
          },
          getPropertyValue: (k: string) => styleMap.get(k) ?? "",
        },
        classList: {
          add: (...cs: string[]) => cs.forEach((c) => classes.add(c)),
          remove: (...cs: string[]) => cs.forEach((c) => classes.delete(c)),
          contains: (c: string) => classes.has(c),
          toggle: (c: string, force?: boolean) => {
            const on = force === undefined ? !classes.has(c) : force;
            if (on) classes.add(c);
            else classes.delete(c);
          },
        },
        offsetWidth: 0,
        setAttribute: (k: string, v: string) => {
          attrs.set(k, v);
        },
        getAttribute: (k: string) => attrs.get(k) ?? null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        createDiv: (opts) => {
          const child = makeNode("div", opts?.cls ?? "");
          for (const [k, v] of Object.entries(opts?.attr ?? {})) child.setAttribute(k, v);
          return node.appendChild(child);
        },
        createSpan: (opts) => {
          const child = makeNode("span", opts?.cls ?? "");
          if (opts?.text) child.textContent = opts.text;
          return node.appendChild(child);
        },
        appendChild: (c) => {
          c.parentElement = node;
          c.isConnected = node.isConnected;
          node.children.push(c);
          return c;
        },
        remove: () => {
          node.isConnected = false;
          if (node.parentElement) {
            node.parentElement.children = node.parentElement.children.filter((x) => x !== node);
          }
        },
        contains: (other: unknown): boolean => other === node || node.children.some((c) => c.contains(other)),
      };
      return node;
    };

    const rect = (left: number, top: number, width: number, height: number) => ({
      x: left,
      y: top,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
    });

    const tabHeaderEl = {
      tagName: "DIV",
      isConnected: true,
      getBoundingClientRect: () => rect(320, 12, 160, 28),
      getAttribute: () => null,
      matches: () => false,
    };
    const workspaceTabsEl = {
      querySelector: (sel: string) => (sel.includes(".workspace-tab-header.is-active") ? tabHeaderEl : null),
    };
    const viewTitleEl = {
      tagName: "DIV",
      isConnected: true,
      getBoundingClientRect: () => rect(360, 48, 220, 24),
      getAttribute: () => null,
      matches: () => false,
    };
    const cmContentEl = {
      tagName: "DIV",
      isConnected: true,
      getBoundingClientRect: () => rect(340, 90, 500, 400),
      getAttribute: () => null,
      matches: (s: string) => s.includes(".cm-content"),
      contains: () => true,
    };
    const cmView = {
      contentDOM: cmContentEl as unknown as Element,
      scrollDOM: {
        isConnected: true,
        getBoundingClientRect: () => rect(340, 90, 500, 400),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as HTMLElement,
      state: {
        doc: {
          length: 24,
          lines: 1,
          toString: () => "# Opened Note heading",
          line: () => ({ number: 1, text: "# Opened Note heading", from: 0, to: 21 }),
        },
        selection: { main: { head: 10 } },
      },
      coordsAtPos: () => ({ left: 410, top: 140, right: 412, bottom: 160 }),
    };
    const leafEl = {
      tagName: "DIV",
      isConnected: true,
      classList: { contains: (c: string) => c === "mod-active" },
      closest: (s: string) => (s.includes(".workspace-tabs") ? workspaceTabsEl : null),
      querySelector: (s: string) => {
        if (s === ".view-header-title") return viewTitleEl;
        if (s === ".cm-content") return cmContentEl;
        return null;
      },
      querySelectorAll: () => [],
      contains: (other: unknown) => other === tabHeaderEl || other === viewTitleEl || other === cmContentEl,
      getBoundingClientRect: () => rect(320, 40, 600, 500),
      getAttribute: () => null,
      matches: () => false,
    };

    const treeCreatedEl = {
      tagName: "DIV",
      isConnected: true,
      getBoundingClientRect: () => rect(24, 180, 180, 24),
      getAttribute: (name: string) => (name === "data-path" ? "Notes/Created.md" : null),
      matches: () => false,
    };
    const treeRenamedEl = {
      tagName: "DIV",
      isConnected: true,
      getBoundingClientRect: () => rect(24, 210, 180, 24),
      getAttribute: (name: string) => (name === "data-path" ? "Notes/Renamed.md" : null),
      matches: () => false,
    };

    let modalVisible = false;
    const promptInputEl = {
      tagName: "INPUT",
      isConnected: true,
      getBoundingClientRect: () => rect(450, 120, 300, 32),
      getAttribute: () => null,
      matches: () => false,
    };
    const modalContainerEl = {
      tagName: "DIV",
      isConnected: true,
      getBoundingClientRect: () => rect(0, 0, 1200, 800),
      querySelector: (sel: string) => (sel === ".prompt-input" ? promptInputEl : null),
      getAttribute: () => null,
      matches: (s: string) => s.includes(".modal-container"),
    };
    const customBadgeEl = {
      tagName: "BUTTON",
      isConnected: true,
      getBoundingClientRect: () => rect(820, 62, 60, 26),
      getAttribute: () => null,
      matches: (s: string) => s.includes("button"),
    };

    const body = makeNode("body");
    const doc: Record<string, unknown> = {
      activeElement: cmContentEl,
      body,
      documentElement: {},
      createDiv: body.createDiv,
      createElementNS: () => makeNode("svg"),
      querySelector: () => null,
      querySelectorAll: (sel: string) => {
        if (sel === ".nav-file-title[data-path]" || sel === "[data-path]") {
          return [treeCreatedEl, treeRenamedEl];
        }
        if (sel.includes(".modal-container")) {
          return modalVisible ? [modalContainerEl] : [];
        }
        if (sel === ".reading-toggle-btn") {
          return [customBadgeEl];
        }
        return [];
      },
      elementFromPoint: () => null,
    };

    let nextTimer = 1;
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    const win = {
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 1,
      document: doc,
      app: {
        workspace: {
          activeLeaf: {
            containerEl: leafEl,
            view: { file: { path: "Notes/Opened.md" }, editor: { cm: cmView } },
          },
        },
      },
      performance: { now: () => Date.now() },
      matchMedia: () => ({ matches: true }),
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      requestAnimationFrame: (cb: (t: number) => void) => {
        cb(Date.now());
        return 1;
      },
      cancelAnimationFrame: () => undefined,
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextTimer++;
        timers.set(id, setTimeout(fn, ms));
        return id;
      },
      clearTimeout: (id: number) => {
        const h = timers.get(id);
        if (h) clearTimeout(h);
        timers.delete(id);
      },
    } as unknown as Window;

    const overlay = new AgentCursorOverlay({ win, enabled: true, idleAfterMs: 1500, hideAfterMs: 60000 });
    const ui = new UiControlService({
      win,
      cursorOverlay: overlay,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(1200, 800)),
        sendInputEvent: () => undefined,
        insertText: () => undefined,
      }),
      sleep: noSleep,
      resolveNoteLeaf: (p) =>
        p === "Notes/Opened.md"
          ? { path: p, pane: "pane-open", activePane: true, containerEl: leafEl as unknown as Element, cm: cmView }
          : null,
    });

    try {
      const layer = () => body.children.find((c) => c.classList.contains("herdr-cursor-layer"));
      const cursorEl = () => layer()?.children[0];
      const actionText = () =>
        cursorEl()
          ?.children.find((c) => c.classList.contains("herdr-cursor-pill"))
          ?.children.find((c) => c.classList.contains("herdr-cursor-action"))?.textContent ?? "";

      // 1) workspace.open -> glides inside the opened note editor (not onto the tab title bar) with "open" label.
      const openRes = await ui.pointAtResult("herdr:w1:p6#agy1", { notePath: "Notes/Opened.md", prefer: "leaf" }, "open");
      assert.equal(openRes.shown, true);
      assert.equal(openRes.notePath, "Notes/Opened.md");
      assert.equal(openRes.x, 410);
      assert.equal(openRes.y, 150);
      assert.equal(actionText(), "open");

      // 2) prefer: "editor" glides to CM caret inside opened editor and installs note doc anchor.
      const editorRes = await ui.pointAtResult("herdr:w1:p6#agy1", { notePath: "Notes/Opened.md", prefer: "editor" }, "command: Toggle reading view");
      assert.equal(editorRes.shown, true);
      assert.equal(editorRes.x, 410);
      assert.equal(editorRes.y, 150);
      assert.equal(actionText(), "command: Toggle reading view");

      // 3) note create/rename -> glides to file-tree item and detaches any prior editor docAnchor.
      const createRes = await ui.pointAtResult("herdr:w1:p6#agy1", { notePath: "Notes/Created.md", prefer: "file-tree" }, "create");
      assert.equal(createRes.shown, true);
      assert.equal(createRes.x, 114);
      assert.equal(createRes.y, 192);
      assert.equal(actionText(), "create");
      // Triggering note update on Notes/Opened.md must not snap cursor off file-tree back to editor.
      overlay.notifyNoteUpdated("Notes/Opened.md");
      assert.equal(cursorEl()?.style.transform, "translate3d(114px, 192px, 0)");

      const renameRes = await ui.pointAtResult("herdr:w1:p6#agy1", { notePath: "Notes/Renamed.md", prefer: "file-tree" }, "rename");
      assert.equal(renameRes.shown, true);
      assert.equal(renameRes.y, 222);
      assert.equal(actionText(), "rename");

      // 4) command.run -> when command opens a modal, glides to inner .prompt-input instead of fullscreen backdrop.
      modalVisible = true;
      const modalRes = await ui.pointAtResult("herdr:w1:p6#agy1", { prefer: "modal" }, "command: Quick switcher");
      assert.equal(modalRes.shown, true);
      assert.equal(modalRes.x, 600);
      assert.equal(modalRes.y, 136);
      assert.equal(actionText(), "command: Quick switcher");
      modalVisible = false;

      // 5) command.run without modal falls back inside active workspace editor (not tab title); selector target also works.
      const fallbackRes = await ui.pointAtResult("herdr:w1:p6#agy1", { prefer: "modal" }, "command: Toggle reading view");
      assert.equal(fallbackRes.shown, true);
      assert.equal(fallbackRes.x, 410);
      assert.equal(fallbackRes.y, 150);

      const selRes = await ui.pointAtResult("herdr:w1:p6#agy1", { selector: ".reading-toggle-btn" }, "command: Toggle reading view");
      assert.equal(selRes.shown, true);
      assert.equal(selRes.x, 850);
      assert.equal(selRes.y, 75);

      // 6) Missing target or disabled overlay returns shown:false cleanly without throwing.
      const missingRes = await ui.pointAtResult("herdr:w1:p6#agy1", { notePath: "Notes/Missing.md", prefer: "file-tree" }, "create");
      assert.equal(missingRes.shown, false);

      overlay.setEnabled(false);
      const disabledRes = await ui.pointAtResult("herdr:w1:p6#agy1", { selector: ".reading-toggle-btn" }, "command: Toggle reading view");
      assert.equal(disabledRes.shown, false);
    } finally {
      overlay.dispose();
    }
  });

  it("blocks UI input inside protected areas unless allowUiInProtectedAreas is enabled while keeping observation allowed", async () => {
    interface ProtNode {
      tagName: string;
      classes: Set<string>;
      attrs: Record<string, string>;
      textContent: string;
      innerText: string;
      isContentEditable: boolean;
      rect: { left: number; top: number; right: number; bottom: number };
      children: ProtNode[];
      parentElement: ProtNode | null;
      classList: { contains: (c: string) => boolean };
      matches: (sel: string) => boolean;
      closest: (sel: string) => ProtNode | null;
      querySelector: (sel: string) => ProtNode | null;
      querySelectorAll: (sel: string) => ProtNode[];
      contains: (other: unknown) => boolean;
      getBoundingClientRect: () => {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
        x: number;
        y: number;
      };
      getAttribute: (name: string) => string | null;
      focus: () => void;
    }

    const matchesSingle = (node: ProtNode, token: string): boolean => {
      const part = token.trim();
      if (!part) return false;
      const attrMatch = /^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/.exec(part);
      if (attrMatch) {
        const val = node.attrs[attrMatch[1]];
        return attrMatch[2] === undefined ? val !== undefined : val === attrMatch[2];
      }
      if (part.includes(".") && !part.startsWith(".")) {
        const segs = part.split(".");
        return node.tagName.toLowerCase() === segs[0].toLowerCase() && segs.slice(1).every((c) => node.classes.has(c));
      }
      if (part.startsWith(".")) {
        return part.slice(1).split(".").every((c) => node.classes.has(c));
      }
      return node.tagName.toLowerCase() === part.toLowerCase();
    };

    const matchesSel = (node: ProtNode, sel: string): boolean =>
      sel.split(",").some((alt) => matchesSingle(node, alt));

    const allNodes: ProtNode[] = [];
    const docObj: { activeElement: ProtNode | null } = { activeElement: null };

    const makeEl = (
      tag: string,
      classes: string[],
      rect: { left: number; top: number; right: number; bottom: number },
      opts?: { attrs?: Record<string, string>; text?: string; editable?: boolean; parent?: ProtNode }
    ): ProtNode => {
      const children: ProtNode[] = [];
      const node: ProtNode = {
        tagName: tag.toUpperCase(),
        classes: new Set(classes),
        attrs: { ...(opts?.attrs ?? {}) },
        textContent: opts?.text ?? "",
        innerText: opts?.text ?? "",
        isContentEditable: Boolean(opts?.editable),
        rect,
        children,
        parentElement: opts?.parent ?? null,
        classList: { contains: (c: string) => node.classes.has(c) },
        matches: (sel: string) => matchesSel(node, sel),
        closest: (sel: string) => {
          let cur: ProtNode | null = node;
          while (cur) {
            if (matchesSel(cur, sel)) return cur;
            cur = cur.parentElement;
          }
          return null;
        },
        querySelector: (sel: string) => node.querySelectorAll(sel)[0] ?? null,
        querySelectorAll: (sel: string) => {
          const out: ProtNode[] = [];
          const walk = (n: ProtNode) => {
            for (const c of n.children) {
              if (matchesSel(c, sel)) out.push(c);
              walk(c);
            }
          };
          walk(node);
          return out;
        },
        contains: (other: unknown) => {
          let cur = other as ProtNode | null;
          while (cur) {
            if (cur === node) return true;
            cur = cur.parentElement ?? null;
          }
          return false;
        },
        getBoundingClientRect: () => ({
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.right - rect.left,
          height: rect.bottom - rect.top,
          x: rect.left,
          y: rect.top,
        }),
        getAttribute: (name: string) => node.attrs[name] ?? null,
        focus: () => {
          docObj.activeElement = node;
        },
      };
      if (opts?.parent) {
        opts.parent.children.push(node);
      }
      allNodes.push(node);
      return node;
    };

    const body = makeEl("body", [], { left: 0, top: 0, right: 1200, bottom: 800 }, { text: "Quick open" });
    const leaf = makeEl("div", ["workspace-leaf"], { left: 0, top: 0, right: 600, bottom: 600 }, { parent: body });
    const safeEditor = makeEl(
      "div",
      ["cm-content"],
      { left: 40, top: 60, right: 560, bottom: 300 },
      { parent: leaf, editable: true, text: "Safe note" }
    );

    const terminalPane = makeEl(
      "div",
      ["herdr-terminal-pane"],
      { left: 620, top: 40, right: 1180, bottom: 380 },
      { parent: body, attrs: { "data-type": "herdr-terminal-view" } }
    );
    const terminalHost = makeEl("div", ["herdr-terminal-host"], { left: 630, top: 60, right: 1170, bottom: 360 }, { parent: terminalPane });
    const xterm = makeEl("div", ["xterm"], { left: 630, top: 60, right: 1170, bottom: 360 }, { parent: terminalHost });
    const xtermTextarea = makeEl("textarea", ["xterm-helper-textarea"], { left: 640, top: 80, right: 740, bottom: 110 }, { parent: xterm, editable: true });

    const settingsModal = makeEl("div", ["modal-container", "mod-settings"], { left: 100, top: 400, right: 700, bottom: 760 }, { parent: body });
    const settingsInput = makeEl("input", ["setting-search"], { left: 140, top: 430, right: 400, bottom: 460 }, { parent: settingsModal, editable: true });
    const pluginsBox = makeEl("div", ["installed-plugins-container"], { left: 140, top: 480, right: 650, bottom: 650 }, { parent: settingsModal });
    const pluginItem = makeEl("div", ["community-plugin-item"], { left: 150, top: 490, right: 640, bottom: 540 }, { parent: pluginsBox, attrs: { "data-plugin-id": "obsidian-git" } });
    const pluginToggle = makeEl("div", ["checkbox-container"], { left: 580, top: 500, right: 620, bottom: 525 }, { parent: pluginItem, attrs: { role: "checkbox" } });

    const titledSettingsModal = makeEl("div", ["modal-container"], { left: 720, top: 400, right: 1150, bottom: 760 }, { parent: body });
    makeEl("div", ["modal-title"], { left: 740, top: 410, right: 900, bottom: 435 }, { parent: titledSettingsModal, text: "Settings" });
    const titledSettingsBtn = makeEl("button", ["titled-setting-btn"], { left: 740, top: 450, right: 920, bottom: 485 }, { parent: titledSettingsModal, text: "Appearance" });

    const paletteModal = makeEl("div", ["modal-container"], { left: 20, top: 310, right: 320, bottom: 390 }, { parent: body });
    const palettePrompt = makeEl("div", ["prompt"], { left: 25, top: 315, right: 315, bottom: 385 }, { parent: paletteModal });
    const paletteInput = makeEl("input", ["prompt-input"], { left: 30, top: 325, right: 310, bottom: 355 }, { parent: palettePrompt, editable: true, text: "Quick open" });

    const hitAt = (x: number, y: number): ProtNode | null => {
      for (let i = allNodes.length - 1; i >= 0; i -= 1) {
        const n = allNodes[i];
        if (n === body) continue;
        if (x >= n.rect.left && x <= n.rect.right && y >= n.rect.top && y <= n.rect.bottom) {
          return n;
        }
      }
      return body;
    };

    const doc = {
      get activeElement() {
        return docObj.activeElement;
      },
      body,
      querySelectorAll: (sel: string) => allNodes.filter((n) => matchesSel(n, sel)),
      elementFromPoint: hitAt,
    };

    const dispatched: Array<Record<string, unknown>> = [];
    const typed: string[] = [];
    let allowProtected = false;
    let driftAfterChunks = 0;

    const win = {
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 1,
      document: doc,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    } as unknown as Window;

    const ui = new UiControlService({
      win,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(1200, 800)),
        sendInputEvent: (ev) => {
          dispatched.push(ev);
        },
        insertText: (txt) => {
          typed.push(txt);
          if (driftAfterChunks > 0 && typed.length >= driftAfterChunks) {
            driftAfterChunks = 0;
            docObj.activeElement = xtermTextarea;
          }
        },
      }),
      sleep: async () => undefined,
      getAllowUiInProtectedAreas: () => allowProtected,
    });

    const isProtectedErr = (err: unknown): boolean =>
      err instanceof UiControlError && err.code === "ui_protected_area";

    // Refuses click/scroll/drag/type/pressKey inside terminal, settings modal, and community plugin toggles.
    await assert.rejects(() => ui.click({ target: { selector: ".xterm-helper-textarea" } }), isProtectedErr);
    await assert.rejects(() => ui.click({ target: { selector: ".setting-search" } }), isProtectedErr);
    await assert.rejects(() => ui.click({ target: { selector: ".titled-setting-btn" } }), isProtectedErr);
    await assert.rejects(() => ui.click({ target: { selector: ".checkbox-container" } }), isProtectedErr);
    await assert.rejects(() => ui.scroll({ target: { selector: ".herdr-terminal-pane" }, deltaY: 120 }), isProtectedErr);
    await assert.rejects(
      () => ui.drag({ from: { selector: ".cm-content" }, to: { selector: ".setting-search" }, steps: 2 }),
      isProtectedErr
    );
    await assert.rejects(
      () => ui.type({ target: { selector: ".setting-search" }, text: "theme" }),
      isProtectedErr
    );

    docObj.activeElement = xtermTextarea;
    await assert.rejects(() => ui.type({ text: "rm -rf" }), isProtectedErr);
    await assert.rejects(() => ui.pressKey({ key: "Enter" }), isProtectedErr);

    docObj.activeElement = settingsInput;
    await assert.rejects(() => ui.pressKey({ key: "Enter" }), isProtectedErr);

    // Mid-type focus drift into Herdr terminal aborts with ui_protected_area.
    docObj.activeElement = safeEditor;
    typed.length = 0;
    driftAfterChunks = 1;
    await assert.rejects(() => ui.type({ text: "alpha beta gamma delta" }), isProtectedErr);
    assert.equal(typed.length, 1);

    // Observation stays allowed and non-protected command palette remains usable.
    const inspected = ui.inspect({ selector: ".herdr-terminal-pane, .mod-settings, .prompt-input" }) as {
      elements: unknown[];
      durationMs: number;
    };
    assert.ok(inspected.elements.length >= 2);
    const waited = (await ui.waitFor({ text: "Quick open", timeoutMs: 100 })) as {
      found: boolean;
      durationMs: number;
    };
    assert.equal(waited.found, true);

    paletteInput.focus();
    await ui.click({ target: { selector: ".prompt-input" } });
    await ui.type({ target: { selector: ".prompt-input" }, text: "Open" });
    assert.ok(dispatched.length > 0);

    // Enabling allowUiInProtectedAreas lifts the block cleanly.
    allowProtected = true;
    await ui.click({ target: { selector: ".checkbox-container" } });
    docObj.activeElement = xtermTextarea;
    await ui.pressKey({ key: "Enter" });
    await ui.type({ target: { selector: ".setting-search" }, text: "ok" });
  });

  it("honors uiTypingSpeed visible vs fast and minimizes delays in fast mode", async () => {
    const sleepCalls: number[] = [];
    const insertedChunks: string[] = [];
    let speed: "visible" | "fast" = "visible";

    const editableEl = {
      tagName: "TEXTAREA",
      matches: (s: string) => s.includes("textarea"),
      getBoundingClientRect: () => ({ left: 20, top: 20, right: 320, bottom: 120, width: 300, height: 100 }),
      getAttribute: () => "Note",
      isContentEditable: false,
      closest: () => null,
    };
    const win = {
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 1,
      document: {
        activeElement: editableEl,
        body: { innerText: "" },
        querySelectorAll: () => [editableEl],
        elementFromPoint: () => editableEl,
      },
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    } as unknown as Window;

    const ui = new UiControlService({
      win,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(800, 600)),
        sendInputEvent: () => undefined,
        insertText: (txt) => {
          insertedChunks.push(txt);
        },
      }),
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      getUiTypingSpeed: () => speed,
    });

    const sample = "one two three four five";
    await ui.type({ text: sample });
    assert.ok(insertedChunks.length > 1, "visible mode splits into multiple chunks");
    assert.ok(sleepCalls.some((ms) => ms > 0), "visible mode sleeps between chunks");

    insertedChunks.length = 0;
    sleepCalls.length = 0;
    speed = "fast";

    await ui.type({ text: sample });
    assert.deepEqual(insertedChunks, [sample]);
    assert.equal(sleepCalls.length, 0, "fast mode performs zero sleeps inside typeChunks");

    await ui.click({ target: { x: 40, y: 40 } });
    await ui.pressKey({ key: "Escape" });
    await ui.scroll({ target: { x: 40, y: 40 }, deltaY: 120 });
    await ui.drag({ from: { x: 30, y: 30 }, to: { x: 80, y: 80 }, steps: 2 });
    assert.deepEqual(sleepCalls, [10, 10, 30, 4, 4, 10]);
  });

  it("returns verified path, line, text, and fenced-aware section heading proof from insertLine", async () => {
    const docLines = [
      "Top intro",
      "## Alpha Section",
      "```markdown",
      "## Fake Heading Inside Fence",
      "```",
      "Body under Alpha",
      "## Beta Section",
      "First beta line",
    ];
    let headPos = 0;
    const lineSpan = (idx: number) => {
      let from = 0;
      for (let i = 0; i < idx; i += 1) from += docLines[i].length + 1;
      const to = from + docLines[idx].length;
      return { number: idx + 1, text: docLines[idx], from, to };
    };
    const fakeDoc = {
      get lines() {
        return docLines.length;
      },
      get length() {
        return docLines.join("\n").length;
      },
      toString: () => docLines.join("\n"),
      line: (n: number) => lineSpan(n - 1),
    };
    const editorEl = {
      tagName: "DIV",
      isContentEditable: true,
      matches: (sel: string) => sel.includes(".cm-content") || sel.includes(".workspace-leaf"),
      getBoundingClientRect: () => ({ left: 20, top: 20, right: 620, bottom: 520, width: 600, height: 500 }),
      getAttribute: () => "",
      closest: () => null,
      contains: () => true,
      focus: () => undefined,
    };
    const cmView = {
      dom: editorEl as unknown as Element,
      contentDOM: editorEl as unknown as Element,
      scrollDOM: {
        scrollTop: 0,
        clientHeight: 500,
        getBoundingClientRect: () => ({ left: 20, top: 20, right: 620, bottom: 520, width: 600, height: 500 }),
      } as unknown as HTMLElement,
      state: {
        doc: fakeDoc,
        selection: {
          get main() {
            return { head: headPos, anchor: headPos };
          },
        },
      },
      coordsAtPos: (pos: number) => {
        let cur = 0;
        let lineIdx = 0;
        for (let i = 0; i < docLines.length; i += 1) {
          const end = cur + docLines[i].length;
          if (pos <= end) {
            lineIdx = i;
            break;
          }
          cur = end + 1;
        }
        return { left: 40, top: 30 + lineIdx * 24, right: 140, bottom: 50 + lineIdx * 24 };
      },
      dispatch: (spec: { changes?: { from: number; insert: string }; selection?: { anchor: number } }) => {
        if (typeof spec.changes?.insert === "string") {
          const textBefore = docLines.join("\n");
          const updated =
            textBefore.slice(0, spec.changes.from) + spec.changes.insert + textBefore.slice(spec.changes.from);
          docLines.splice(0, docLines.length, ...updated.split("\n"));
          headPos = spec.changes.from + spec.changes.insert.length;
        }
        if (typeof spec.selection?.anchor === "number") {
          headPos = spec.selection.anchor;
        }
      },
      focus: () => undefined,
    };

    const win = {
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 1,
      document: {
        activeElement: editorEl,
        body: { innerText: "" },
        querySelectorAll: () => [],
        elementFromPoint: () => editorEl,
      },
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    } as unknown as Window;

    const ui = new UiControlService({
      win,
      getCodeMirrorView: () => cmView,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(800, 600)),
        sendInputEvent: () => undefined,
        insertText: (txt) => {
          const full = docLines.join("\n");
          const updated = full.slice(0, headPos) + txt + full.slice(headPos);
          docLines.splice(0, docLines.length, ...updated.split("\n"));
          headPos += txt.length;
        },
      }),
      sleep: async () => undefined,
      getUiTypingSpeed: () => "fast",
      resolveNoteLeaf: (p) =>
        p === "Notes/Proof.md"
          ? {
              path: "Notes/Proof.md",
              pane: "pane-proof",
              activePane: true,
              containerEl: editorEl as unknown as Element,
              cm: cmView,
            }
          : null,
    });

    // After fenced block under Alpha Section: ignores "## Fake Heading Inside Fence".
    const alphaProof = (await ui.insertLine({
      target: { note: "Notes/Proof.md", after: "Body under Alpha" },
      text: "Proof under Alpha",
    })) as { path: string; line: number; text: string; heading: string | null; durationMs: number };
    assert.equal(alphaProof.path, "Notes/Proof.md");
    assert.equal(alphaProof.line, 7);
    assert.equal(alphaProof.text, "Proof under Alpha");
    assert.equal(alphaProof.heading, "Alpha Section");
    assert.equal(typeof alphaProof.durationMs, "number");

    // Above any heading returns heading: null.
    const topProof = (await ui.insertLine({
      target: { note: "Notes/Proof.md", line: 1, at: "start" },
      text: "Line zero",
    })) as { path: string; line: number; text: string; heading: string | null };
    assert.equal(topProof.line, 1);
    assert.equal(topProof.text, "Line zero");
    assert.equal(topProof.heading, null);
  });

  it("includes numeric durationMs on every public UI method result", async () => {
    const line = "Hello world";
    const editableEl = {
      tagName: "TEXTAREA",
      isContentEditable: false,
      matches: (s: string) => s.includes("textarea") || s.includes(".cm-content") || s.includes("button"),
      getBoundingClientRect: () => ({ left: 20, top: 20, right: 320, bottom: 120, width: 300, height: 100 }),
      getAttribute: () => "Editor",
      closest: () => null,
      contains: () => true,
      focus: () => undefined,
    };
    const cmView = {
      dom: editableEl as unknown as Element,
      contentDOM: editableEl as unknown as Element,
      state: {
        doc: {
          lines: 1,
          length: line.length,
          toString: () => line,
          line: () => ({ number: 1, text: line, from: 0, to: line.length }),
        },
        selection: { main: { head: 0, anchor: 0 } },
      },
      coordsAtPos: () => ({ left: 30, top: 30, right: 90, bottom: 50 }),
      dispatch: () => undefined,
      focus: () => undefined,
    };
    const win = {
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 1,
      document: {
        activeElement: editableEl,
        body: { innerText: "Hello world" },
        querySelectorAll: () => [editableEl],
        elementFromPoint: () => editableEl,
      },
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    } as unknown as Window;

    const ui = new UiControlService({
      win,
      getCodeMirrorView: () => cmView,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(800, 600)),
        sendInputEvent: () => undefined,
        insertText: () => undefined,
      }),
      sleep: async () => undefined,
      getUiTypingSpeed: () => "fast",
      resolveNoteLeaf: () => ({
        path: "Notes/Timing.md",
        pane: "pane-timing",
        activePane: true,
        containerEl: editableEl as unknown as Element,
        cm: cmView,
      }),
    });

    const assertHasDuration = (res: unknown, name: string): void => {
      const obj = res as { durationMs?: unknown };
      assert.equal(typeof obj.durationMs, "number", `${name} must include numeric durationMs`);
      assert.ok(Number.isFinite(obj.durationMs as number) && (obj.durationMs as number) >= 0, `${name} durationMs >= 0`);
    };

    assertHasDuration(await ui.screenshot(), "screenshot");
    assertHasDuration(ui.inspect(), "inspect");
    assertHasDuration(await ui.pointAtResult("agent", { notePath: "Notes/Timing.md" }, "open"), "pointAtResult");
    assertHasDuration(await ui.locate({ path: "Notes/Timing.md", line: 1 }), "locate");
    assertHasDuration(await ui.waitFor({ text: "Hello world", timeoutMs: 100 }), "waitFor");
    assertHasDuration(await ui.click({ target: { x: 40, y: 40 } }), "click");
    assertHasDuration(await ui.type({ text: "hi" }), "type");
    assertHasDuration(await ui.insertLine({ target: { note: "Notes/Timing.md", line: 1 }, text: "x" }), "insertLine");
    assertHasDuration(await ui.pressKey({ key: "Enter" }), "pressKey");
    assertHasDuration(await ui.scroll({ target: { x: 40, y: 40 }, deltaY: 120 }), "scroll");
    assertHasDuration(await ui.drag({ from: { x: 30, y: 30 }, to: { x: 80, y: 80 }, steps: 2 }), "drag");

    const batchRes = (await ui.batch({
      steps: [
        { action: "click", target: { x: 40, y: 40 } },
        { action: "type", text: "z" },
        { action: "wait_for", text: "Hello world", timeoutMs: 50 },
      ],
    })) as { durationMs?: unknown; results: unknown[] };
    assertHasDuration(batchRes, "batch");
    batchRes.results.forEach((stepRes, idx) => assertHasDuration(stepRes, `batch.results[${idx}]`));
  });

  it("lets locate, inspect, and screenshot bypass the UI serialize mutation lock while typing runs", async () => {
    let releaseType!: () => void;
    const typeGate = new Promise<void>((resolve) => {
      releaseType = resolve;
    });
    let typeStartedResolve!: () => void;
    const typeStarted = new Promise<void>((resolve) => {
      typeStartedResolve = resolve;
    });

    const editorEl = {
      tagName: "TEXTAREA",
      isContentEditable: false,
      matches: (s: string) => s.includes("textarea") || s.includes(".cm-content"),
      getBoundingClientRect: () => ({ left: 20, top: 20, right: 520, bottom: 320, width: 500, height: 300 }),
      getAttribute: () => "Editor",
      closest: () => null,
      contains: () => true,
      focus: () => undefined,
    };
    const cmView = {
      dom: editorEl as unknown as Element,
      contentDOM: editorEl as unknown as Element,
      state: {
        doc: {
          lines: 1,
          length: 10,
          toString: () => "Target row",
          line: () => ({ number: 1, text: "Target row", from: 0, to: 10 }),
        },
        selection: { main: { head: 0, anchor: 0 } },
      },
      coordsAtPos: () => ({ left: 30, top: 30, right: 90, bottom: 50 }),
      dispatch: () => undefined,
      focus: () => undefined,
    };

    const win = {
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 1,
      document: {
        activeElement: editorEl,
        body: { innerText: "Target row" },
        querySelectorAll: () => [editorEl],
        elementFromPoint: () => editorEl,
      },
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    } as unknown as Window;

    const ui = new UiControlService({
      win,
      getCodeMirrorView: () => cmView,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(800, 600)),
        sendInputEvent: () => undefined,
        insertText: async () => {
          typeStartedResolve();
          await typeGate;
        },
      }),
      sleep: async () => undefined,
      getUiTypingSpeed: () => "fast",
      resolveNoteLeaf: () => ({
        path: "Notes/Concurrent.md",
        pane: "pane-c",
        activePane: true,
        containerEl: editorEl as unknown as Element,
        cm: cmView,
      }),
    });

    let typeDone = false;
    const typePromise = ui.type({ text: "holding lock" }, "herdr:w1:p1").then((r) => {
      typeDone = true;
      return r;
    });
    await typeStarted;

    // Observation calls must all complete immediately while type is still blocked inside serialize.
    const inspected = ui.inspect() as { elements: unknown[]; durationMs: number };
    assert.equal(typeDone, false, "inspect must run while type holds lock");
    assert.equal(inspected.elements.length, 1);

    const shot = (await ui.screenshot()) as { width: number; durationMs: number };
    assert.equal(typeDone, false, "screenshot must resolve before type releases lock");
    assert.equal(shot.width, 800);

    const located = (await ui.locate({ path: "Notes/Concurrent.md", line: 1 }, "herdr:w1:p2")) as {
      found: boolean;
      line: number;
      durationMs: number;
    };
    assert.equal(typeDone, false, "ui.locate must bypass serialize and finish before type releases lock");
    assert.equal(located.found, true);
    assert.equal(located.line, 1);

    releaseType();
    await typePromise;
  });

  it("never parks cursor over the Herdr terminal after dialog-dismiss keys and fades when focus leaves target area", async () => {
    const bodyEl = {
      tagName: "BODY",
      isConnected: true,
      classList: { contains: () => false },
      getAttribute: () => null,
      matches: () => false,
      closest: () => null,
    };
    const terminalEl = {
      tagName: "TEXTAREA",
      isConnected: true,
      readOnly: false,
      disabled: false,
      isContentEditable: false,
      classList: { contains: (c: string) => c === "xterm-helper-textarea" },
      getAttribute: () => null,
      matches: (sel: string) => sel.includes("textarea") && !sel.includes("password"),
      closest: (sel: string) => (sel.includes(".xterm-helper-textarea") ? terminalEl : null),
      getBoundingClientRect: () => ({ left: 400, top: 500, right: 600, bottom: 560, width: 200, height: 60 }),
      focus: () => {
        doc.activeElement = terminalEl;
      },
    };
    const modalInput = {
      tagName: "INPUT",
      isConnected: true,
      readOnly: false,
      disabled: false,
      isContentEditable: false,
      classList: { contains: (c: string) => c === "prompt-input" },
      getAttribute: () => null,
      matches: (sel: string) => sel.includes("input") && !sel.includes("password"),
      closest: () => null,
      getBoundingClientRect: () => ({ left: 200, top: 100, right: 500, bottom: 136, width: 300, height: 36 }),
    };
    const safeEditor = {
      tagName: "DIV",
      isConnected: true,
      readOnly: false,
      disabled: false,
      isContentEditable: true,
      classList: { contains: (c: string) => c === "cm-content" },
      getAttribute: () => null,
      matches: () => false,
      closest: () => null,
      getBoundingClientRect: () => ({ left: 60, top: 80, right: 360, bottom: 280, width: 300, height: 200 }),
    };

    let nextFocusAfterEscape: unknown = terminalEl;
    const doc: {
      activeElement: unknown;
      body: unknown;
      documentElement: Record<string, unknown>;
      querySelectorAll: () => unknown[];
      elementFromPoint: () => null;
    } = {
      activeElement: modalInput,
      body: bodyEl,
      documentElement: {},
      querySelectorAll: () => [],
      elementFromPoint: () => null,
    };

    const cursorMoves: Array<{ caller: string; x: number; y: number; actionText?: string }> = [];
    const exited: string[] = [];

    const win = {
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 1,
      document: doc,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    } as unknown as Window;

    const ui = new UiControlService({
      win,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(800, 600)),
        sendInputEvent: (ev) => {
          if (ev.type === "keyDown" && ev.keyCode === "Escape") {
            modalInput.isConnected = false;
            doc.activeElement = nextFocusAfterEscape;
          }
        },
        insertText: () => undefined,
      }),
      sleep: async () => undefined,
      cursorOverlay: {
        moveTo: (caller: string, _label: string, x: number, y: number, actionText?: string) => {
          cursorMoves.push({ caller, x, y, actionText });
        },
        pulseClick: (caller: string, _label: string, x: number, y: number, actionText?: string) => {
          cursorMoves.push({ caller, x, y, actionText });
        },
        setTyping: (caller: string, _label: string, x: number, y: number, actionText?: string) => {
          cursorMoves.push({ caller, x, y, actionText });
        },
        exitAgent: (caller: string) => {
          exited.push(caller);
        },
      } as unknown as AgentCursorOverlay,
    });

    // 1. Escape closes modal and Obsidian returns focus to Herdr terminal: must NOT park cursor at terminal (400..600, 500..560); fades out instead.
    nextFocusAfterEscape = terminalEl;
    await ui.pressKey({ key: "Escape" }, "herdr:w1:p9");
    assert.deepEqual(exited, ["herdr:w1:p9"]);
    assert.equal(
      cursorMoves.some((m) => m.y >= 500),
      false,
      "Cursor must never move onto the Herdr terminal after Escape"
    );

    // 2. Escape closes modal and focus lands on document.body (outside target area): fades out cleanly.
    cursorMoves.length = 0;
    exited.length = 0;
    modalInput.isConnected = true;
    doc.activeElement = modalInput;
    nextFocusAfterEscape = bodyEl;
    await ui.pressKey({ key: "Escape" }, "herdr:w1:p9");
    assert.deepEqual(exited, ["herdr:w1:p9"]);
    assert.equal(cursorMoves.length, 1, "Only pre-key modal cursor position emitted; no post-key park");

    // 3. Escape closes modal and focus moves cleanly to a safe note editor: cursor moves to the newly focused editor.
    cursorMoves.length = 0;
    exited.length = 0;
    modalInput.isConnected = true;
    doc.activeElement = modalInput;
    nextFocusAfterEscape = safeEditor;
    await ui.pressKey({ key: "Escape" }, "herdr:w1:p9");
    assert.equal(exited.length, 0);
    assert.equal(cursorMoves.length, 2);
    assert.deepEqual({ x: cursorMoves[1].x, y: cursorMoves[1].y }, { x: 210, y: 150 });
  });

  it("computes native input and textarea caret coordinates using mirror layout and text metrics", async () => {
    const events: Array<{ x: number; y: number }> = [];
    const textInput = {
      tagName: "INPUT",
      value: "hello world",
      selectionStart: 5,
      selectionEnd: 5,
      selectionDirection: "forward",
      scrollLeft: 0,
      scrollTop: 0,
      readOnly: false,
      disabled: false,
      isContentEditable: false,
      isConnected: true,
      matches: (sel: string) => sel.includes("input") && !sel.includes("password"),
      getAttribute: () => null,
      closest: () => null,
      getBoundingClientRect: () => ({ left: 100, top: 100, right: 400, bottom: 136, width: 300, height: 36 }),
    };

    const winNoMirror = {
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 1,
      document: {
        activeElement: textInput,
        body: { innerText: "" },
        querySelectorAll: () => [],
        elementFromPoint: () => null,
      },
      getComputedStyle: () => ({
        paddingLeft: "12px",
        paddingTop: "6px",
        fontSize: "16px",
        lineHeight: "22px",
      }),
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    } as unknown as Window;

    const uiFallback = new UiControlService({
      win: winNoMirror,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(800, 600)),
        sendInputEvent: () => undefined,
        insertText: () => undefined,
      }),
      sleep: async () => undefined,
      getUiTypingSpeed: () => "fast",
      cursorOverlay: {
        moveTo: () => undefined,
        pulseClick: () => undefined,
        setTyping: (_caller: string, _label: string, x: number, y: number) => {
          events.push({ x, y });
        },
      } as unknown as AgentCursorOverlay,
    });

    await uiFallback.type({ text: "!" }, "agent");
    // 100 + 12 + 5 * (16 * 0.56 = 8.96) = 156.8 -> 157; mid-height y = 118.
    assert.equal(events[0].x, 157);
    assert.equal(events[0].y, 118);

    // Multi-line textarea advances y cleanly on second line and accounts for scrollTop.
    const textareaEl = {
      tagName: "TEXTAREA",
      value: "first\nsecond",
      selectionStart: 9,
      selectionEnd: 9,
      selectionDirection: "forward",
      scrollLeft: 4,
      scrollTop: 0,
      readOnly: false,
      disabled: false,
      isContentEditable: false,
      isConnected: true,
      matches: (sel: string) => sel.includes("textarea"),
      getAttribute: () => null,
      closest: () => null,
      getBoundingClientRect: () => ({ left: 100, top: 200, right: 400, bottom: 320, width: 300, height: 120 }),
    };
    (winNoMirror.document as { activeElement: unknown }).activeElement = textareaEl;
    events.length = 0;
    await uiFallback.type({ text: "x" }, "agent");
    // Line 2 ("sec" = 3 chars): x = 100 + 12 + 3 * 8.96 - 4 = 134.88 -> 135; y = 200 + 6 + 1*22 + 11 = 239.
    assert.equal(events[0].x, 135);
    assert.equal(events[0].y, 239);

    // With DOM mirror layout support, exact marker span rect minus scrollLeft wins.
    let removedMirror = false;
    const fakeBody = {
      innerText: "",
      createDiv: () => {
        const children: unknown[] = [];
        return {
          tagName: "DIV",
          style: {} as Record<string, string>,
          textContent: "",
          children,
          createSpan: (opts?: { text?: string }) => {
            const span = {
              tagName: "SPAN",
              textContent: opts?.text ?? "",
              getBoundingClientRect: () => ({
                left: 264,
                top: 230,
                right: 264,
                bottom: 250,
                width: 0,
                height: 20,
              }),
            };
            children.push(span);
            return span;
          },
          remove: () => {
            removedMirror = true;
          },
          getBoundingClientRect: () => ({ left: 100, top: 200, right: 400, bottom: 320, width: 300, height: 120 }),
        };
      },
    };
    const uiMirror = new UiControlService({
      win: {
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 1,
        document: {
          activeElement: textareaEl,
          body: fakeBody,
          querySelectorAll: () => [],
          elementFromPoint: () => null,
        },
        getComputedStyle: () => ({ paddingLeft: "12px", fontSize: "16px" }),
        requestAnimationFrame: (cb: () => void) => {
          cb();
          return 1;
        },
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      } as unknown as Window,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(800, 600)),
        sendInputEvent: () => undefined,
        insertText: () => undefined,
      }),
      sleep: async () => undefined,
      getUiTypingSpeed: () => "fast",
      cursorOverlay: {
        moveTo: () => undefined,
        pulseClick: () => undefined,
        setTyping: (_caller: string, _label: string, x: number, y: number) => {
          events.push({ x, y });
        },
      } as unknown as AgentCursorOverlay,
    });

    events.length = 0;
    await uiMirror.type({ text: "x" }, "agent");
    assert.equal(removedMirror, true, "Mirror div must be removed cleanly after measurement");
    // 264 - scrollLeft(4) = 260; y = 230 + 20 * 0.5 = 240.
    assert.deepEqual(events[0], { x: 260, y: 240 });
  });

  it("validates topmost hit elements for anchored actions and drag paths against protected and covering modals (R6 P1-1)", async () => {
    function makeNode(classes: string, box: { left: number; top: number; width: number; height: number }) {
      const names = new Set(classes.split(/\s+/).filter(Boolean));
      const node: Record<string, unknown> = {
        tagName: "DIV",
        isConnected: true,
        isContentEditable: false,
        parentElement: null as unknown,
        classList: { contains: (c: string) => names.has(c) },
        getBoundingClientRect: () => ({
          x: box.left,
          y: box.top,
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
          right: box.left + box.width,
          bottom: box.top + box.height,
        }),
        getAttribute: () => null,
        hasAttribute: () => false,
        querySelector: () => null,
        querySelectorAll: () => [],
        contains: (other: unknown) => other === node,
        matches: (selector: string) =>
          selector
            .split(",")
            .some((part) => part.trim().startsWith(".") && names.has(part.trim().slice(1))),
        closest: (selector: string): unknown =>
          (node.matches as (s: string) => boolean)(selector)
            ? node
            : ((node.parentElement as { closest?: (s: string) => unknown } | null)?.closest?.(selector) ?? null),
      };
      return node;
    }

    const bodyEl = makeNode("body", { left: 0, top: 0, width: 1000, height: 600 });
    const leafEl = makeNode("workspace-leaf mod-active", { left: 0, top: 0, width: 450, height: 550 });
    const cmContent = makeNode("cm-content", { left: 20, top: 60, width: 410, height: 470 });
    cmContent.isContentEditable = true;
    cmContent.parentElement = leafEl;
    leafEl.contains = (other: unknown) => other === leafEl || other === cmContent;

    const settingsModal = makeNode("mod-settings modal", { left: 200, top: 0, width: 140, height: 550 });
    const ordinaryModal = makeNode("modal-container", { left: 20, top: 40, width: 410, height: 500 });

    let noteText = "line one\nline two";
    const docObj = {
      toString: () => noteText,
      get length() {
        return noteText.length;
      },
      get lines() {
        return noteText.split("\n").length;
      },
      line: (n: number) => {
        const all = noteText.split("\n");
        const from = all.slice(0, n - 1).reduce((s, line) => s + line.length + 1, 0);
        return { number: n, from, to: from + all[n - 1].length, text: all[n - 1] };
      },
    };
    let head = 8;
    const cm = {
      dom: leafEl as unknown as Element,
      contentDOM: cmContent as unknown as Element,
      scrollDOM: leafEl as unknown as HTMLElement,
      state: { doc: docObj, selection: { main: { head, anchor: head } } },
      coordsAtPos: () => ({ left: 120, top: 120, right: 122, bottom: 140 }),
      focus: () => {
        doc.activeElement = cmContent;
      },
      dispatch: (spec: Record<string, unknown>) => {
        const ch = spec.changes as { from: number; insert: string } | undefined;
        if (ch && typeof ch.insert === "string") {
          noteText = noteText.slice(0, ch.from) + ch.insert + noteText.slice(ch.from);
        }
        const sel = spec.selection as { anchor?: number } | undefined;
        if (sel && typeof sel.anchor === "number") {
          head = sel.anchor;
          cm.state.selection.main.head = head;
        }
      },
    };
    const leafCtx = {
      path: "Shared.md",
      pane: "main",
      activePane: true,
      containerEl: leafEl as unknown as Element,
      cm,
    };

    let overlayAtPoint: (x: number, y: number) => unknown = () => cmContent;
    const doc = {
      body: bodyEl,
      documentElement: makeNode("html", { left: 0, top: 0, width: 1000, height: 600 }),
      activeElement: cmContent as unknown,
      querySelectorAll: () => [],
      querySelector: () => null,
      elementFromPoint: (x: number, y: number) => overlayAtPoint(x, y),
    };
    const win = {
      innerWidth: 1000,
      innerHeight: 600,
      document: doc,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      setTimeout,
    } as unknown as Window;

    const events: Array<Record<string, unknown>> = [];
    const typed: string[] = [];
    const ui = new UiControlService({
      win,
      getWebContents: () => fakeWebContents(events, typed),
      resolveNoteLeaf: () => leafCtx,
      resolveElementContext: (el) => (el === leafEl ? { notePath: "Shared.md", pane: "main", activePane: true } : null),
      sleep: async () => undefined,
    });

    // 1. Anchored click, type, insertLine, scroll under Settings modal refuse with ui_protected_area and 0 input events.
    overlayAtPoint = () => settingsModal;
    for (const invoke of [
      () => ui.click({ target: { note: "Shared.md", line: 1 } }, "reviewer"),
      () => ui.type({ target: { note: "Shared.md", line: 1 }, text: "blocked" }, "reviewer"),
      () => ui.insertLine({ target: { note: "Shared.md", line: 1 }, text: "blocked" }, "reviewer"),
      () => ui.scroll({ target: { note: "Shared.md", line: 1 }, deltaY: 40 }, "reviewer"),
    ]) {
      events.length = 0;
      typed.length = 0;
      await assert.rejects(
        invoke,
        (err: unknown) => err instanceof UiControlError && err.code === "ui_protected_area"
      );
      assert.equal(events.filter((ev) => ev.type === "mouseDown" || ev.type === "mouseWheel").length, 0);
      assert.equal(typed.length, 0);
    }

    // 2. Ordinary covering modal over anchored pane rejects with ui_target_covered before dispatch.
    overlayAtPoint = () => ordinaryModal;
    events.length = 0;
    await assert.rejects(
      () => ui.click({ target: { note: "Shared.md", line: 1 } }, "reviewer"),
      (err: unknown) => err instanceof UiControlError && err.code === "ui_target_covered"
    );
    assert.equal(events.some((ev) => ev.type === "mouseDown"), false);

    // 3. Drag crossing Settings modal fails preflight before mouseDown.
    overlayAtPoint = (x) => (x >= 200 && x <= 340 ? settingsModal : bodyEl);
    events.length = 0;
    await assert.rejects(
      () => ui.drag({ from: { x: 50, y: 100 }, to: { x: 450, y: 100 }, steps: 4 }, "reviewer"),
      (err: unknown) => err instanceof UiControlError && err.code === "ui_protected_area"
    );
    assert.equal(events.length, 0, "Preflight must prevent mouseDown and all drag moves across Settings");

    // 4. Mid-drag protection change aborts before protected mouseMove and safely sends mouseUp at last safe point.
    let stepMoved = 0;
    let dynamicProtected = false;
    overlayAtPoint = (x) => (dynamicProtected && x >= 240 ? settingsModal : bodyEl);
    const dynamicUi = new UiControlService({
      win,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(2000, 1200)),
        sendInputEvent: (ev) => {
          events.push(ev);
          if (ev.type === "mouseMove" && Array.isArray(ev.modifiers) && ev.modifiers.includes("leftButtonDown")) {
            stepMoved += 1;
            if (stepMoved === 1) {
              dynamicProtected = true;
            }
          }
        },
        insertText: () => undefined,
      }),
      sleep: async () => undefined,
    });
    events.length = 0;
    await assert.rejects(
      () => dynamicUi.drag({ from: { x: 50, y: 100 }, to: { x: 450, y: 100 }, steps: 4 }, "reviewer"),
      (err: unknown) => err instanceof UiControlError && err.code === "ui_protected_area"
    );
    const dragMoves = events.filter(
      (ev) => ev.type === "mouseMove" && Array.isArray(ev.modifiers) && ev.modifiers.includes("leftButtonDown")
    );
    assert.equal(dragMoves.length, 1, "Must stop immediately after first safe step before moving onto Settings");
    const mouseUp = events.find((ev) => ev.type === "mouseUp") as { x?: number } | undefined;
    assert.equal(mouseUp?.x, 150, "finally must release mouseUp at last safe position");
  });

  it("never moves a concurrent writer's caret or focus when ui.locate scrolls an offscreen target (R6 P1-2)", async () => {
    let text = "start\nDESTINATION";
    let head = 5;
    let scrolled = false;
    const cmSpecs: Array<Record<string, unknown>> = [];

    const container = {
      tagName: "DIV",
      isConnected: true,
      classList: { contains: (c: string) => c === "workspace-leaf" || c === "mod-active" },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 550, right: 800, bottom: 550 }),
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      contains: (other: unknown) => other === container || other === content,
      matches: (s: string) => s.includes(".workspace-leaf"),
      closest: (s: string) => (s.includes(".workspace-leaf") ? container : null),
    };
    const content = {
      tagName: "DIV",
      isConnected: true,
      isContentEditable: true,
      classList: { contains: (c: string) => c === "cm-content" },
      getAttribute: () => null,
      matches: () => false,
      closest: (s: string) => (s.includes(".workspace-leaf") ? container : null),
      contains: (o: unknown) => o === content,
      getBoundingClientRect: () => ({ left: 20, top: 60, width: 760, height: 480, right: 780, bottom: 540 }),
    };

    const cm = {
      dom: container as unknown as Element,
      contentDOM: content as unknown as Element,
      scrollDOM: container as unknown as HTMLElement,
      state: {
        doc: {
          toString: () => text,
          get length() {
            return text.length;
          },
          get lines() {
            return text.split("\n").length;
          },
          line: (n: number) => {
            const all = text.split("\n");
            const from = all.slice(0, n - 1).reduce((s, line) => s + line.length + 1, 0);
            return { number: n, from, to: from + all[n - 1].length, text: all[n - 1] };
          },
        },
        selection: {
          main: {
            get head() {
              return head;
            },
            set head(v: number) {
              head = v;
            },
            get anchor() {
              return head;
            },
            set anchor(v: number) {
              head = v;
            },
          },
        },
      },
      coordsAtPos: (pos: number) => {
        const line = text.slice(0, pos).split("\n").length;
        const top = line === 1 ? 120 : scrolled ? 220 : 900;
        return { left: 100, right: 102, top, bottom: top + 20 };
      },
      focus: () => {
        doc.activeElement = content;
      },
      dispatch: (spec: Record<string, unknown>) => {
        cmSpecs.push(spec);
        const sel = spec.selection as { anchor?: number } | undefined;
        if (sel && typeof sel.anchor === "number") {
          head = sel.anchor;
        }
        if (spec.scrollIntoView || extractScrollEffectPos(spec) !== null) {
          scrolled = true;
        }
      },
    };

    const doc = {
      body: { innerText: "" },
      documentElement: {},
      activeElement: content as unknown,
      querySelectorAll: () => [],
      elementFromPoint: () => content,
    };
    const win = {
      innerWidth: 800,
      innerHeight: 600,
      document: doc,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      setTimeout,
    } as unknown as Window;

    const leafCtx = {
      path: "Shared.md",
      pane: "main",
      activePane: true,
      containerEl: container as unknown as Element,
      cm,
    };

    let observed = false;
    let locateResult: unknown = null;
    const ui = new UiControlService({
      win,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(800, 600)),
        sendInputEvent: () => undefined,
        insertText: (chunk: string) => {
          text = text.slice(0, head) + chunk + text.slice(head);
          head += chunk.length;
        },
      }),
      getCodeMirrorView: () => cm,
      resolveNoteLeaf: () => leafCtx,
      resolveElementContext: () => ({ notePath: "Shared.md", pane: "main", activePane: true }),
      sleep: async () => {
        if (!observed) {
          observed = true;
          locateResult = await ui.locate({ note: "Shared.md", line: 2 }, "observer");
        }
      },
    });

    await ui.type({ text: "alpha beta gamma" }, "writer");
    assert.equal(text, "startalpha beta gamma\nDESTINATION");
    assert.equal((locateResult as { scrolled?: boolean; line?: number })?.scrolled, true);
    assert.equal((locateResult as { line?: number })?.line, 2);
    assert.equal(
      cmSpecs.some((s) => s.selection !== undefined),
      false,
      "Offscreen locate must never pass selection in cm.dispatch"
    );
    assert.ok(cmSpecs.some((s) => extractScrollEffectPos(s) !== null));
  });

  it("aborts typing with ui_target_changed when an editor switches notes mid-typing and delivers partial edits to beforeMutation complete (R6 P1-3)", async () => {
    const completions: Array<UiMutationCompletion | undefined> = [];
    const hookContexts: UiMutationContext[] = [];

    const makeSwitchHarness = () => {
      let currentPath = "Shared.md";
      const fileObj: { path?: string } = { path: currentPath };
      let text = "original ";
      let head = text.length;
      const chunksDelivered: Array<{ path: string; chunk: string }> = [];

      const containerEl = {
        tagName: "DIV",
        isConnected: true,
        classList: { contains: (c: string) => c === "workspace-leaf" || c === "mod-active" },
        contains: (other: unknown) => other === containerEl || other === cmContent,
        closest: (s: string) => (s.includes(".workspace-leaf") ? containerEl : null),
        matches: (s: string) => s.includes(".workspace-leaf"),
        getAttribute: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 500, right: 600, bottom: 500 }),
      };
      const cmContent = {
        tagName: "DIV",
        isConnected: true,
        isContentEditable: true,
        classList: { contains: (c: string) => c === "cm-content" },
        matches: () => false,
        closest: (s: string) => (s.includes(".workspace-leaf") ? containerEl : null),
        contains: (o: unknown) => o === cmContent,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ left: 20, top: 60, width: 560, height: 400, right: 580, bottom: 460 }),
      };
      const cm = {
        dom: containerEl as unknown as Element,
        contentDOM: cmContent as unknown as Element,
        scrollDOM: containerEl as unknown as HTMLElement,
        state: {
          doc: {
            toString: () => text,
            get length() {
              return text.length;
            },
            get lines() {
              return text.split("\n").length;
            },
            line: (n: number) => {
              const all = text.split("\n");
              const from = all.slice(0, n - 1).reduce((s, line) => s + line.length + 1, 0);
              return { number: n, from, to: from + all[n - 1].length, text: all[n - 1] };
            },
          },
          selection: {
            main: {
              get head() {
                return head;
              },
              set head(v: number) {
                head = v;
              },
              get anchor() {
                return head;
              },
              set anchor(v: number) {
                head = v;
              },
            },
          },
        },
        coordsAtPos: () => ({ left: 100, top: 100, right: 102, bottom: 120 }),
        dispatch: (spec: Record<string, unknown>) => {
          const ch = spec.changes as { from: number; insert: string } | undefined;
          if (ch && typeof ch.insert === "string") {
            chunksDelivered.push({ path: currentPath, chunk: ch.insert });
            text = text.slice(0, ch.from) + ch.insert + text.slice(ch.from);
          }
        },
        focus: () => {
          doc.activeElement = cmContent;
        },
      };
      const viewObj = {
        file: fileObj,
        editor: { cm },
        getViewType: () => "markdown",
      };
      const wsLeaf = {
        id: "leaf-shared",
        containerEl: containerEl as unknown as Element,
        view: viewObj,
      };
      const doc = {
        body: { innerText: "" },
        documentElement: {},
        activeElement: cmContent as unknown,
        querySelectorAll: () => [],
        elementFromPoint: () => cmContent,
      };
      const win = {
        innerWidth: 800,
        innerHeight: 600,
        document: doc,
        getComputedStyle: () => ({ visibility: "visible", display: "block" }),
        requestAnimationFrame: (cb: () => void) => {
          cb();
          return 1;
        },
        setTimeout,
        app: {
          workspace: {
            activeLeaf: wsLeaf,
            iterateAllLeaves: (cb: (l: unknown) => void) => cb(wsLeaf),
            getLeavesOfType: () => [wsLeaf],
          },
        },
      } as unknown as Window;

      return {
        win,
        viewObj,
        cm,
        chunksDelivered,
        switchToOther: () => {
          currentPath = "Other.md";
          fileObj.path = "Other.md";
          text = "other note ";
          head = text.length;
        },
        otherText: () => text,
        makeUi: (
          speed: "visible" | "fast",
          onSleep: () => Promise<void> | void,
          onHook?: () => Promise<void> | void
        ) =>
          new UiControlService({
            win,
            getUiTypingSpeed: () => speed,
            getWebContents: () => ({
              capturePage: () => Promise.resolve(fakeImage(800, 600)),
              sendInputEvent: () => undefined,
              insertText: (chunk: string) => {
                chunksDelivered.push({ path: currentPath, chunk });
                text = text.slice(0, head) + chunk + text.slice(head);
                head += chunk.length;
              },
            }),
            beforeMutation: async (ctx) => {
              hookContexts.push(ctx);
              await onHook?.();
              return (completion) => {
                completions.push(completion);
              };
            },
            sleep: async () => {
              await onSleep();
            },
          }),
      };
    };

    // Visible mode: first chunk goes to Shared.md, then editor switches to Other.md before chunk 2.
    let switched = false;
    const visibleHarness = makeSwitchHarness();
    const uiVisible = visibleHarness.makeUi("visible", () => {
      if (!switched) {
        switched = true;
        visibleHarness.switchToOther();
      }
    });
    await assert.rejects(
      () => uiVisible.type({ text: "alpha beta gamma delta" }, "writer"),
      (err: unknown) =>
        err instanceof UiControlError &&
        err.code === "ui_target_changed" &&
        err.message.includes("Typing stopped after inserting") &&
        err.message.includes("Shared.md") &&
        err.message.includes("Other.md")
    );
    assert.ok(visibleHarness.chunksDelivered.length > 0);
    assert.ok(visibleHarness.chunksDelivered.every((c) => c.path === "Shared.md"));
    assert.equal(visibleHarness.otherText(), "other note ");
    assert.equal(hookContexts[0]?.targetView, visibleHarness.viewObj);
    assert.equal(hookContexts[0]?.targetCm, visibleHarness.cm);
    assert.equal(completions[0]?.ok, false);
    assert.equal(completions[0]?.errorCode, "ui_target_changed");
    assert.equal(completions[0]?.abortedAfterNoteSwitch, true);
    assert.ok((completions[0]?.insertedChars ?? 0) > 0);
    assert.deepEqual(completions[0]?.edits, [
      { from: 9, to: 9, insert: visibleHarness.chunksDelivered[0].chunk },
    ]);

    // Targeted fast mode: note switches inside async hook before CM transaction executes.
    completions.length = 0;
    const fastHarness = makeSwitchHarness();
    let clickSettled = false;
    const uiFast = fastHarness.makeUi(
      "fast",
      () => undefined,
      () => {
        if (!clickSettled) {
          clickSettled = true;
          fastHarness.switchToOther();
        }
      }
    );
    await assert.rejects(
      () => uiFast.type({ target: { note: "Shared.md", line: 1 }, text: "never written to other" }, "writer"),
      (err: unknown) => err instanceof UiControlError && err.code === "ui_target_changed"
    );
    assert.equal(fastHarness.chunksDelivered.length, 0);
    assert.equal(fastHarness.otherText(), "other note ");
    assert.equal(completions[0]?.ok, false);
    assert.equal(completions[0]?.abortedAfterNoteSwitch, true);
  });

  it("attributes insertLine proof strictly to the target split and returns post-restore focus (R6 P2-1, P2-2)", async () => {
    let textA = "## A\nexisting A\n## B\nexisting B";
    const textB = "## B Only\ndifferent split";
    let headA = 0;
    const makeSplit = (id: string, getText: () => string, setText: (t: string) => void, leftX: number) => {
      const containerEl = {
        tagName: "DIV",
        isConnected: true,
        id,
        classList: { contains: (c: string) => c === "workspace-leaf" || (id === "leaf-A" && c === "mod-active") },
        contains: (other: unknown) => other === containerEl || other === cmContent,
        closest: (s: string) => (s.includes(".workspace-leaf") ? containerEl : null),
        matches: (s: string) => s.includes(".workspace-leaf"),
        getAttribute: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ left: leftX, top: 0, width: 450, height: 550, right: leftX + 450, bottom: 550 }),
      };
      const cmContent = {
        tagName: "DIV",
        isConnected: true,
        isContentEditable: true,
        classList: { contains: (c: string) => c === "cm-content" },
        matches: () => false,
        closest: (s: string) => (s.includes(".workspace-leaf") ? containerEl : null),
        contains: (o: unknown) => o === cmContent,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ left: leftX + 10, top: 40, width: 420, height: 480, right: leftX + 430, bottom: 520 }),
      };
      const cm = {
        dom: containerEl as unknown as Element,
        contentDOM: cmContent as unknown as Element,
        scrollDOM: containerEl as unknown as HTMLElement,
        state: {
          doc: {
            toString: getText,
            get length() {
              return getText().length;
            },
            get lines() {
              return getText().split("\n").length;
            },
            line: (n: number) => {
              const all = getText().split("\n");
              const from = all.slice(0, n - 1).reduce((s, line) => s + line.length + 1, 0);
              return { number: n, from, to: from + all[n - 1].length, text: all[n - 1] };
            },
          },
          selection: {
            main: {
              get head() {
                return id === "leaf-A" ? headA : getText().length;
              },
              set head(v: number) {
                if (id === "leaf-A") {
                  headA = v;
                }
              },
              get anchor() {
                return id === "leaf-A" ? headA : getText().length;
              },
              set anchor(v: number) {
                if (id === "leaf-A") {
                  headA = v;
                }
              },
            },
          },
        },
        coordsAtPos: () => ({ left: leftX + 80, top: 120, right: leftX + 82, bottom: 140 }),
        focus: () => {
          doc.activeElement = cmContent;
        },
        dispatch: (spec: Record<string, unknown>) => {
          const ch = spec.changes as { from: number; insert: string } | undefined;
          if (ch && typeof ch.insert === "string") {
            const cur = getText();
            setText(cur.slice(0, ch.from) + ch.insert + cur.slice(ch.from));
          }
          const sel = spec.selection as { anchor?: number } | undefined;
          if (sel && typeof sel.anchor === "number" && id === "leaf-A") {
            headA = sel.anchor;
          }
        },
      };
      return {
        path: "Shared.md",
        pane: id,
        activePane: id === "leaf-A",
        containerEl: containerEl as unknown as Element & { isConnected: boolean },
        cm,
        cmContent,
        view: { file: { path: "Shared.md" }, editor: { cm } },
      };
    };

    const splitA = makeSplit("leaf-A", () => textA, (t) => {
      textA = t;
    }, 0);
    const splitB = makeSplit("leaf-B", () => textB, () => undefined, 500);

    const terminalEl = {
      tagName: "TEXTAREA",
      isConnected: true,
      readOnly: false,
      disabled: false,
      isContentEditable: false,
      matches: (s: string) => s.includes("textarea") && !s.includes("password"),
      closest: (s: string) => (s.includes(".xterm-helper-textarea") ? terminalEl : null),
      getAttribute: (name: string) => (name === "aria-label" ? "Terminal input" : null),
      focus: () => {
        doc.activeElement = terminalEl;
      },
    };
    const doc = {
      body: { innerText: "" },
      documentElement: {},
      activeElement: terminalEl as unknown,
      querySelectorAll: () => [],
      elementFromPoint: (x: number) => (x < 480 ? splitA.cmContent : splitB.cmContent),
    };
    const win = {
      innerWidth: 1000,
      innerHeight: 600,
      document: doc,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      setTimeout,
    } as unknown as Window;

    let preferSplit: "A" | "B" = "A";
    const ui = new UiControlService({
      win,
      getUiTypingSpeed: () => "fast",
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(1000, 600)),
        sendInputEvent: (ev) => {
          if (ev.type === "mouseDown") {
            const x = typeof ev.x === "number" ? ev.x : 0;
            doc.activeElement = x < 480 ? splitA.cmContent : splitB.cmContent;
          } else if (ev.type === "keyDown" && ev.keyCode === "ArrowRight") {
            doc.activeElement = splitA.cmContent;
          }
        },
        insertText: (chunk: string) => {
          textA = textA.slice(0, headA) + chunk + textA.slice(headA);
          headA += chunk.length;
        },
      }),
      resolveNoteLeaf: () => (preferSplit === "A" ? splitA : splitB),
      sleep: async () => undefined,
    });

    // Even when resolveNoteLeaf switches to splitB right before proof runs, proof stays on splitA.
    preferSplit = "A";
    const proofRes = (await ui.insertLine(
      { target: { note: "Shared.md", after: "existing A" }, text: "inserted on A" },
      "agy1"
    )) as { line: number; text: string; heading: string | null; focus: { tag: string; label: string } };
    assert.equal(proofRes.line, 3);
    assert.equal(proofRes.text, "inserted on A");
    assert.equal(proofRes.heading, "A");
    // P2-2: Focus returned to terminalEl after action; reported focus reflects restored terminal input.
    assert.deepEqual(proofRes.focus, ui.focusState());
    assert.equal(proofRes.focus.tag, "textarea");
    assert.equal(proofRes.focus.label, "Terminal input");

    for (const action of [
      () => ui.click({ target: { note: "Shared.md", line: 1 } }, "agy1"),
      () => ui.type({ target: { note: "Shared.md", line: 1 }, text: "!" }, "agy1"),
    ]) {
      doc.activeElement = terminalEl;
      const out = (await action()) as { focus: { tag: string; label: string } };
      assert.deepEqual(out.focus, ui.focusState());
      assert.equal(out.focus.tag, "textarea");
      assert.equal(out.focus.label, "Terminal input");
    }

    const searchInput = {
      tagName: "INPUT",
      isConnected: true,
      readOnly: false,
      disabled: false,
      isContentEditable: false,
      matches: (s: string) => s.includes("input") && !s.includes("password"),
      closest: () => null,
      getAttribute: (name: string) => (name === "aria-label" ? "Search filter" : null),
      focus: () => {
        doc.activeElement = searchInput;
      },
    };
    doc.activeElement = searchInput;
    const keyOut = (await ui.pressKey({ key: "ArrowRight" }, "agy1")) as {
      focus: { tag: string; label: string };
    };
    assert.deepEqual(keyOut.focus, ui.focusState());
    assert.equal(keyOut.focus.tag, "input");
    assert.equal(keyOut.focus.label, "Search filter");

    // P2-1 failure case: if the target split closes during insertLine, fail with ui_target_changed instead of reading splitB.
    const origDispatchA = splitA.cm.dispatch;
    splitA.cm.dispatch = (spec: Record<string, unknown>) => {
      origDispatchA(spec);
      const ch = spec.changes as { insert?: string } | undefined;
      if (ch?.insert === "x") {
        splitA.containerEl.isConnected = false;
      }
    };
    const closingUi = new UiControlService({
      win,
      getUiTypingSpeed: () => "fast",
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(1000, 600)),
        sendInputEvent: () => undefined,
        insertText: () => undefined,
      }),
      resolveNoteLeaf: () => (preferSplit === "A" ? splitA : splitB),
      sleep: async () => undefined,
    });
    doc.activeElement = terminalEl;
    preferSplit = "A";
    await assert.rejects(
      () => closingUi.insertLine({ target: { note: "Shared.md", line: 1 }, text: "x" }, "agy1"),
      (err: unknown) => err instanceof UiControlError && err.code === "ui_target_changed"
    );
  });

  it("streams insert_line and anchored edits via CodeMirror view.dispatch without stealing focus or selection (P0-1)", async () => {
    let noteText = "## sol3\nFirst bullet";
    let cmHead = 3; // User caret resting on "## sol3" inside note should not jump.
    const cmSpecs: Array<Record<string, unknown>> = [];
    const cursorEvents: Array<{ kind: string; x: number; y: number; pos?: number }> = [];
    let focusChanges = 0;
    let cmFocusCalls = 0;

    const terminalEl = {
      tagName: "TEXTAREA",
      value: "echo ",
      selectionStart: 5,
      selectionEnd: 5,
      selectionDirection: "forward",
      readOnly: false,
      disabled: false,
      isContentEditable: false,
      isConnected: true,
      matches: (s: string) => s.includes("textarea") && !s.includes("password"),
      closest: (s: string) => (s.includes(".xterm-helper-textarea") ? terminalEl : null),
      getAttribute: (n: string) => (n === "aria-label" ? "Terminal input" : null),
      focus: () => {
        focusChanges += 1;
      },
      setSelectionRange: (start: number, end: number) => {
        terminalEl.selectionStart = start;
        terminalEl.selectionEnd = end;
      },
      getBoundingClientRect: () => ({ left: 500, top: 450, right: 900, bottom: 580, width: 400, height: 130 }),
    };

    const leafEl = {
      tagName: "DIV",
      isConnected: true,
      classList: { contains: (c: string) => c === "workspace-leaf" || c === "mod-active" },
      contains: (other: unknown) => other === leafEl || other === cmContent,
      closest: (s: string) => (s.includes(".workspace-leaf") ? leafEl : null),
      matches: (s: string) => s.includes(".workspace-leaf"),
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 480, height: 550, right: 480, bottom: 550 }),
    };
    const cmContent = {
      tagName: "DIV",
      isConnected: true,
      isContentEditable: true,
      classList: { contains: (c: string) => c === "cm-content" },
      matches: () => false,
      closest: (s: string) => (s.includes(".workspace-leaf") ? leafEl : null),
      contains: (o: unknown) => o === cmContent,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 20, top: 40, width: 440, height: 480, right: 460, bottom: 520 }),
    };
    const cm = {
      dom: leafEl as unknown as Element,
      contentDOM: cmContent as unknown as Element,
      scrollDOM: leafEl as unknown as HTMLElement,
      state: {
        doc: {
          toString: () => noteText,
          get length() {
            return noteText.length;
          },
          get lines() {
            return noteText.split("\n").length;
          },
          line: (n: number) => {
            const all = noteText.split("\n");
            const from = all.slice(0, n - 1).reduce((s, line) => s + line.length + 1, 0);
            return { number: n, from, to: from + all[n - 1].length, text: all[n - 1] };
          },
        },
        selection: {
          main: {
            get head() {
              return cmHead;
            },
            set head(v: number) {
              cmHead = v;
            },
            get anchor() {
              return cmHead;
            },
            set anchor(v: number) {
              cmHead = v;
            },
          },
        },
      },
      coordsAtPos: (pos: number) => {
        const before = noteText.slice(0, pos).split("\n");
        const lineIdx = before.length - 1;
        const col = before[lineIdx].length;
        const x = 40 + col * 8;
        const y = 80 + lineIdx * 24;
        return { left: x, top: y, right: x + 2, bottom: y + 20 };
      },
      focus: () => {
        cmFocusCalls += 1;
        focusChanges += 1;
        doc.activeElement = cmContent;
      },
      dispatch: (spec: Record<string, unknown>) => {
        cmSpecs.push(spec);
        const ch = spec.changes as { from: number; insert: string } | undefined;
        if (ch && typeof ch.insert === "string") {
          noteText = noteText.slice(0, ch.from) + ch.insert + noteText.slice(ch.from);
        }
        const sel = spec.selection as { anchor?: number } | undefined;
        if (sel && typeof sel.anchor === "number") {
          cmHead = sel.anchor;
        }
      },
    };
    const leafCtx = {
      path: "Crew Test/Mission Board 2.md",
      pane: "main",
      activePane: true,
      containerEl: leafEl as unknown as Element,
      cm,
      view: { file: { path: "Crew Test/Mission Board 2.md" }, editor: { cm } },
    };
    const doc = {
      body: { innerText: "" },
      documentElement: {},
      activeElement: terminalEl as unknown,
      querySelectorAll: () => [],
      elementFromPoint: (x: number) => (x < 480 ? cmContent : terminalEl),
    };
    const win = {
      innerWidth: 1000,
      innerHeight: 600,
      document: doc,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      setTimeout,
    } as unknown as Window;

    const webInputEvents: Array<Record<string, unknown>> = [];
    const webTyped: string[] = [];
    const userTypedDuringAgent = ["j", "u", "s", "t"];
    let userTypeStep = 0;

    const ui = new UiControlService({
      win,
      getUiTypingSpeed: () => "visible",
      getWebContents: () => fakeWebContents(webInputEvents, webTyped),
      resolveNoteLeaf: () => leafCtx,
      resolveElementContext: (el) =>
        el === leafEl ? { notePath: leafCtx.path, pane: "main", activePane: true } : null,
      sleep: async () => {
        // Focus must still be on terminalEl on every sleep tick; simulated user keystrokes go straight to terminalEl.
        assert.equal(doc.activeElement, terminalEl);
        if (userTypeStep < userTypedDuringAgent.length) {
          terminalEl.value += userTypedDuringAgent[userTypeStep];
          terminalEl.selectionStart = terminalEl.value.length;
          terminalEl.selectionEnd = terminalEl.value.length;
          userTypeStep += 1;
        }
      },
      cursorOverlay: {
        moveTo: (_c: string, _l: string, x: number, y: number, _a?: string, ctx?: { pos?: number }) => {
          cursorEvents.push({ kind: "move", x, y, pos: ctx?.pos });
        },
        pulseClick: (_c: string, _l: string, x: number, y: number, _a?: string, ctx?: { pos?: number }) => {
          cursorEvents.push({ kind: "click", x, y, pos: ctx?.pos });
        },
        setTyping: (_c: string, _l: string, x: number, y: number, ctx?: { pos?: number }) => {
          cursorEvents.push({ kind: "type", x, y, pos: ctx?.pos });
        },
        finishTyping: (_c: string, ctx?: { pos?: number }) => {
          cursorEvents.push({ kind: "finish", x: 0, y: 0, pos: ctx?.pos });
        },
      } as unknown as AgentCursorOverlay,
    });

    const insertOut = (await ui.insertLine(
      {
        target: { note: "Crew Test/Mission Board 2.md", heading: "sol3" },
        text: "Focus retest line types cleanly",
      },
      "agy1"
    )) as { line: number; text: string; focus: { tag: string; label: string } };
    assert.equal(insertOut.line, 3);
    assert.equal(insertOut.text, "Focus retest line types cleanly");

    await ui.type(
      {
        target: { note: "Crew Test/Mission Board 2.md", after: "Focus retest line types cleanly" },
        text: " without stealing focus",
      },
      "agy1"
    );

    assert.equal(noteText, "## sol3\nFirst bullet\nFocus retest line types cleanly without stealing focus");
    assert.equal(terminalEl.value, "echo just", "User keys typed during visible mode go cleanly to terminal");
    assert.equal(terminalEl.selectionStart, 9);
    assert.equal(cmHead, 3, "Existing CM selection in target note must not be moved");
    assert.equal(cmFocusCalls, 0, "cm.focus must never be called for anchored edits");
    assert.equal(focusChanges, 0, "Focus must never leave or re-focus away from user's element");
    assert.equal(doc.activeElement, terminalEl);
    assert.equal(webInputEvents.length, 0, "No mouse/key OS input events may be sent during anchored edits");
    assert.equal(webTyped.length, 0, "wc.insertText must not be used for anchored edits");
    assert.equal(
      cmSpecs.some((spec) => spec.selection !== undefined),
      false,
      "CM transactions must never set selection during anchored edits"
    );
    const typeXs = cursorEvents.filter((e) => e.kind === "type").map((e) => e.x);
    assert.ok(typeXs.length > 3, "Visible mode must stream multiple cursor typing updates across chunks");
    assert.ok(typeXs.at(-1)! > typeXs[0], "Cursor overlay X advances monotonically along inserted chunks");
  });

  it("captures and re-delivers interleaved user keydown/keypress/beforeinput events during raw ui.type and ui.key (P0-2)", async () => {
    const docListeners = new Map<string, Array<(ev: unknown) => void>>();
    const terminalListeners = new Map<string, Array<(ev: unknown) => void>>();
    const searchListeners = new Map<string, Array<(ev: unknown) => void>>();
    const agentReceivedUserEvents: string[] = [];

    const makeDispatcher = (
      map: Map<string, Array<(ev: unknown) => void>>,
      onDefault?: (ev: Record<string, unknown>) => void
    ) => ({
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        const list = map.get(type) ?? [];
        list.push(fn);
        map.set(type, list);
      },
      removeEventListener: (type: string, fn: (ev: unknown) => void) => {
        const list = map.get(type) ?? [];
        map.set(
          type,
          list.filter((entry) => entry !== fn)
        );
      },
      dispatchEvent: (rawEv: Record<string, unknown>) => {
        let stoppedImmediate = false;
        let stopped = false;
        let prevented = false;
        const ev = {
          ...rawEv,
          get defaultPrevented() {
            return prevented;
          },
          preventDefault: () => {
            prevented = true;
          },
          stopImmediatePropagation: () => {
            stoppedImmediate = true;
            stopped = true;
          },
          stopPropagation: () => {
            stopped = true;
          },
        };
        for (const capFn of [...(docListeners.get(String(rawEv.type)) ?? [])]) {
          capFn(ev);
          if (stoppedImmediate) break;
        }
        if (!stopped) {
          for (const tgtFn of [...(map.get(String(rawEv.type)) ?? [])]) {
            tgtFn(ev);
            if (stoppedImmediate) break;
          }
          if (!prevented) {
            onDefault?.(ev);
          }
        }
        return !prevented;
      },
    });

    const terminalDispatcher = makeDispatcher(terminalListeners);
    const terminalEl = {
      tagName: "TEXTAREA",
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
      selectionDirection: "forward",
      readOnly: false,
      disabled: false,
      isContentEditable: false,
      isConnected: true,
      matches: (s: string) => s.includes("textarea") && !s.includes("password"),
      closest: (s: string) => (s.includes(".xterm-helper-textarea") ? terminalEl : null),
      getAttribute: (n: string) => (n === "aria-label" ? "Terminal input" : null),
      focus: () => {
        doc.activeElement = terminalEl;
      },
      setSelectionRange: (start: number, end: number) => {
        terminalEl.selectionStart = start;
        terminalEl.selectionEnd = end;
      },
      dispatchEvent: terminalDispatcher.dispatchEvent,
      addEventListener: terminalDispatcher.addEventListener,
      removeEventListener: terminalDispatcher.removeEventListener,
      getBoundingClientRect: () => ({ left: 400, top: 480, right: 800, bottom: 580, width: 400, height: 100 }),
    };

    const searchDispatcher = makeDispatcher(searchListeners);
    const searchInput = {
      tagName: "INPUT",
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
      selectionDirection: "forward",
      readOnly: false,
      disabled: false,
      isContentEditable: false,
      isConnected: true,
      matches: (s: string) => s.includes(".search-input") || (s.includes("input") && !s.includes("password")),
      closest: () => null,
      getAttribute: () => null,
      contains: (other: unknown) => other === searchInput,
      focus: () => {
        doc.activeElement = searchInput;
      },
      dispatchEvent: searchDispatcher.dispatchEvent,
      addEventListener: searchDispatcher.addEventListener,
      removeEventListener: searchDispatcher.removeEventListener,
      getBoundingClientRect: () => ({ left: 60, top: 60, right: 300, bottom: 96, width: 240, height: 36 }),
    };
    const agentReceivedAgentKeys: string[] = [];
    for (const type of ["keydown", "keypress", "beforeinput"]) {
      searchInput.addEventListener(type, (ev) => {
        const rec = ev as { key?: string; data?: string; isTrusted?: boolean };
        if (type === "keydown" && rec.key === "Right") {
          agentReceivedAgentKeys.push(rec.key);
          return;
        }
        // Ignore the agent's own beforeinput triggered by wc.insertText; record any user event as a leak.
        if (type !== "beforeinput" || rec.data !== "agent query string".slice(0, rec.data?.length ?? 0)) {
          if (type !== "beforeinput" || ["j", "u", "o", "k", "z"].includes(rec.data ?? "")) {
            agentReceivedUserEvents.push(`${type}:${rec.key ?? rec.data ?? ""}`);
          }
        }
      });
    }

    const terminalReceivedTypes: string[] = [];
    for (const type of ["keydown", "keypress", "beforeinput", "input"]) {
      terminalEl.addEventListener(type, (ev) => {
        const rec = ev as { key?: string; data?: string };
        terminalReceivedTypes.push(`${type}:${rec.key ?? rec.data ?? ""}`);
      });
    }

    const doc = {
      body: { innerText: "" },
      documentElement: {},
      activeElement: terminalEl as unknown,
      querySelectorAll: (s: string) => (s.includes(".search-input") ? [searchInput] : []),
      elementFromPoint: () => searchInput,
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        const list = docListeners.get(type) ?? [];
        list.push(fn);
        docListeners.set(type, list);
      },
      removeEventListener: (type: string, fn: (ev: unknown) => void) => {
        const list = docListeners.get(type) ?? [];
        docListeners.set(
          type,
          list.filter((entry) => entry !== fn)
        );
      },
    };

    const win = {
      innerWidth: 900,
      innerHeight: 600,
      document: doc,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      setTimeout,
    } as unknown as Window;

    const sendTrustedUserEvent = (ev: Record<string, unknown>) => {
      const target = doc.activeElement as { dispatchEvent?: (e: Record<string, unknown>) => boolean } | null;
      target?.dispatchEvent?.({ ...ev, isTrusted: true });
    };

    let sleepCount = 0;
    const ui = new UiControlService({
      win,
      getUiTypingSpeed: () => "visible",
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(900, 600)),
        sendInputEvent: (ev) => {
          if (ev.type === "mouseDown") {
            doc.activeElement = searchInput;
          } else if (ev.type === "keyDown") {
            (doc.activeElement as { dispatchEvent?: (e: Record<string, unknown>) => void } | null)?.dispatchEvent?.({
              type: "keydown",
              key: ev.keyCode,
              isTrusted: true,
            });
          } else if (ev.type === "char") {
            (doc.activeElement as { dispatchEvent?: (e: Record<string, unknown>) => void } | null)?.dispatchEvent?.({
              type: "keypress",
              key: ev.keyCode,
              isTrusted: true,
            });
          }
        },
        insertText: (chunk) => {
          searchInput.dispatchEvent({
            type: "beforeinput",
            data: chunk,
            inputType: "insertText",
            isTrusted: true,
          });
          searchInput.value += chunk;
        },
      }),
      sleep: async () => {
        sleepCount += 1;
        // Inject trusted user keystrokes while the agent holds focus on searchInput.
        if (sleepCount === 2) {
          sendTrustedUserEvent({ type: "keydown", key: "j" });
          sendTrustedUserEvent({ type: "keypress", key: "j" });
          sendTrustedUserEvent({ type: "beforeinput", data: "j", inputType: "insertText" });
          sendTrustedUserEvent({ type: "keydown", key: "u" });
          sendTrustedUserEvent({ type: "beforeinput", data: "u", inputType: "insertText" });
        } else if (sleepCount === 3) {
          sendTrustedUserEvent({ type: "keydown", key: "Backspace" });
          sendTrustedUserEvent({ type: "keydown", key: "o" });
          sendTrustedUserEvent({ type: "beforeinput", data: "o", inputType: "insertText" });
          sendTrustedUserEvent({ type: "keydown", key: "k" });
          sendTrustedUserEvent({ type: "beforeinput", data: "k", inputType: "insertText" });
        }
      },
    });

    await ui.type(
      { target: { selector: ".search-input" }, text: "agent query string" },
      "agy1"
    );

    assert.equal(agentReceivedUserEvents.length, 0, "Interleaved user keys must never reach agent's target");
    assert.equal(searchInput.value, "agent query string");
    assert.equal(doc.activeElement, terminalEl, "Focus must restore to terminal after raw ui.type");
    assert.equal(terminalEl.value, "jok", "Captured user keystrokes must replay cleanly to user's terminal");
    assert.ok(terminalReceivedTypes.includes("keydown:j"));
    assert.ok(terminalReceivedTypes.includes("keypress:j"));
    assert.ok(terminalReceivedTypes.includes("beforeinput:j"));

    // Also test interleaved user keystroke during raw ui.key inside a batch holding searchInput focus.
    sleepCount = 0;
    let keyBatchSleeps = 0;
    const uiKey = new UiControlService({
      win,
      getWebContents: () => ({
        capturePage: () => Promise.resolve(fakeImage(900, 600)),
        sendInputEvent: (ev) => {
          if (ev.type === "mouseDown") {
            doc.activeElement = searchInput;
          } else if (ev.type === "keyDown") {
            searchInput.dispatchEvent({ type: "keydown", key: ev.keyCode, isTrusted: true });
          }
        },
        insertText: () => undefined,
      }),
      sleep: async () => {
        keyBatchSleeps += 1;
        if (doc.activeElement === searchInput && keyBatchSleeps === 2) {
          sendTrustedUserEvent({ type: "keydown", key: "z" });
          sendTrustedUserEvent({ type: "beforeinput", data: "z", inputType: "insertText" });
        }
      },
    });

    await uiKey.batch(
      {
        steps: [
          { action: "click", target: { selector: ".search-input" } },
          { action: "press_key", key: "ArrowRight" },
        ],
      },
      "agy1"
    );
    assert.equal(agentReceivedUserEvents.length, 0, "Interleaved key during ui.key must not hit agent target");
    assert.deepEqual(agentReceivedAgentKeys, ["Right"], "Agent's own trusted ArrowRight must pass through to agent target");
    assert.equal(doc.activeElement, terminalEl);
    assert.equal(terminalEl.value, "jokz");
    assert.equal(docListeners.get("keydown")?.length ?? 0, 0, "Shield listeners must detach cleanly in finally");
  });

  it("blocks matching physical keys during press_key settle, shields rAF/wait_for gaps, avoids obsolete focus restore in insert_line, and retains keys when modals open (review-focus P1-1..P1-4)", async () => {
    const createHarness = () => {
      const listeners = new Map<string, Array<(ev: unknown) => void>>();
      const makeField = (label: string, extraClasses = "") => {
        const names = new Set(extraClasses.split(/\s+/).filter(Boolean));
        const field: Record<string, unknown> = {
          tagName: "INPUT",
          value: "",
          selectionStart: 0,
          selectionEnd: 0,
          selectionDirection: "none",
          disabled: false,
          readOnly: false,
          isConnected: true,
          parentElement: null as unknown,
          classList: { contains: (c: string) => names.has(c) },
          getAttribute: (k: string) => (k === "aria-label" ? label : null),
          matches: (s: string) =>
            (s.includes("input") && !s.includes("password")) ||
            Array.from(names).some((n) => s.includes(`.${n}`)),
          closest: (s: string): unknown =>
            (field.matches as (sel: string) => boolean)(s)
              ? field
              : ((field.parentElement as { closest?: (sel: string) => unknown } | null)?.closest?.(s) ?? null),
          contains: (o: unknown) => o === field,
          focus: () => {
            doc.activeElement = field;
          },
          setSelectionRange: (a: number, b: number) => {
            field.selectionStart = a;
            field.selectionEnd = b;
          },
          dispatchEvent: () => true,
          getBoundingClientRect: () => ({ left: 20, top: 30, width: 200, height: 30, right: 220, bottom: 60 }),
        };
        return field;
      };

      const user = makeField("Original input");
      const next = makeField("Next input");
      const agent = makeField("Agent target", "agent-target");
      const palette = makeField("Palette input");
      const modalNames = new Set(["modal-container", "prompt"]);
      const modal = {
        tagName: "DIV",
        isConnected: true,
        classList: { contains: (c: string) => modalNames.has(c) },
        matches: (s: string) => Array.from(modalNames).some((n) => s.includes(`.${n}`)),
        closest: (s: string) => (Array.from(modalNames).some((n) => s.includes(`.${n}`)) ? modal : null),
        contains: (o: unknown) => o === modal || o === palette,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ left: 30, top: 30, width: 300, height: 200, right: 330, bottom: 230 }),
      };
      palette.parentElement = modal;

      let modalOpen = false;
      const doc: Record<string, unknown> = {
        body: { innerText: "" },
        documentElement: {},
        activeElement: user,
        querySelectorAll: (s: string) => {
          if (modalOpen && s.includes(".modal")) return [modal];
          if (s.includes(".agent-target")) return [agent];
          return [];
        },
        elementFromPoint: () => agent,
        addEventListener: (t: string, fn: (ev: unknown) => void) => {
          const list = listeners.get(t) ?? [];
          list.push(fn);
          listeners.set(t, list);
        },
        removeEventListener: (t: string, fn: (ev: unknown) => void) => {
          listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== fn));
        },
      };

      const emit = (type: string, init: Record<string, unknown> = {}) => {
        let prevented = false;
        let stopped = false;
        const ev = {
          type,
          isTrusted: true,
          ...init,
          preventDefault: () => {
            prevented = true;
          },
          stopImmediatePropagation: () => {
            stopped = true;
          },
          stopPropagation: () => undefined,
        };
        for (const fn of [...(listeners.get(type) ?? [])]) {
          fn(ev);
          if (stopped) break;
        }
        return { prevented, stopped };
      };

      const typePhysicalChar = (ch: string, onDeliver?: () => void) => {
        if (emit("keydown", { key: ch }).prevented) return false;
        if (emit("keypress", { key: ch }).prevented) return false;
        if (emit("beforeinput", { data: ch, inputType: "insertText" }).prevented) return false;
        if (onDeliver) {
          onDeliver();
        } else {
          const active = doc.activeElement as { value?: string; selectionStart?: number; selectionEnd?: number };
          if (typeof active.value === "string") {
            active.value += ch;
            active.selectionStart = active.value.length;
            active.selectionEnd = active.value.length;
          }
        }
        return true;
      };

      const win = {
        innerWidth: 1000,
        innerHeight: 600,
        document: doc,
        getComputedStyle: () => ({ visibility: "visible", display: "block" }),
        requestAnimationFrame: (cb: () => void) => {
          cb();
          return 1;
        },
        setTimeout,
        clearTimeout,
      } as unknown as Window;

      return {
        win,
        doc,
        user,
        next,
        agent,
        palette,
        emit,
        typePhysicalChar,
        setModalOpen: (v: boolean) => {
          modalOpen = v;
        },
      };
    };

    // 1) P1-1: Physical key matching agent press_key ("a") during settle must NEVER bypass shield into agent target;
    //    and Electron "Right" normalizes cleanly to DOM "ArrowRight" during synchronous dispatch.
    {
      const h = createHarness();
      let sleeps = 0;
      let deliveredMatchedChar: boolean | null = null;
      const ui = new UiControlService({
        win: h.win,
        getWebContents: () => ({
          capturePage: () => Promise.resolve(fakeImage(1000, 600)),
          sendInputEvent: (ev) => {
            if (ev.type === "mouseDown") h.doc.activeElement = h.agent;
          },
          insertText: () => undefined,
        }),
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 2) {
            deliveredMatchedChar = h.typePhysicalChar("a");
          }
        },
      });
      await ui.batch(
        { steps: [{ action: "click", target: { selector: ".agent-target" } }, { action: "press_key", key: "a" }] },
        "A"
      );
      assert.equal(deliveredMatchedChar, false, "Matching physical 'a' during settle must be intercepted");
      assert.equal(h.agent.value, "", "Agent target must not receive physical 'a' from user");
      assert.equal(h.user.value, "a", "User input must receive buffered 'a' after restore");

      // Sync ArrowRight normalization: Electron keyCode "Right" emits DOM key "ArrowRight" during dispatch.
      h.user.value = "";
      h.agent.value = "";
      const replayedToUser: string[] = [];
      let arrowCanceled: boolean | null = null;
      h.user.dispatchEvent = (e?: { key?: string }) => {
        if (e?.key) replayedToUser.push(e.key);
        return true;
      };
      const uiArrow = new UiControlService({
        win: h.win,
        getWebContents: () => ({
          capturePage: () => Promise.resolve(fakeImage(1000, 600)),
          sendInputEvent: (ev) => {
            if (ev.type === "mouseDown") h.doc.activeElement = h.agent;
            if (ev.type === "keyDown" && ev.keyCode === "Right") {
              arrowCanceled = h.emit("keydown", { key: "ArrowRight" }).prevented;
            }
          },
          insertText: () => undefined,
        }),
        sleep: async () => undefined,
      });
      await uiArrow.batch(
        { steps: [{ action: "click", target: { selector: ".agent-target" } }, { action: "press_key", key: "ArrowRight" }] },
        "A"
      );
      assert.equal(arrowCanceled, false, "Agent's normalized ArrowRight must pass through to agent target");
      assert.deepEqual(replayedToUser, []);
    }

    // 2) P1-2: Shield covers full borrowed-focus window: both click rAF paint AND wait_for polling inside batch.
    {
      const h = createHarness();
      let sleeps = 0;
      const uiBatch = new UiControlService({
        win: h.win,
        getWebContents: () => ({
          capturePage: () => Promise.resolve(fakeImage(1000, 600)),
          sendInputEvent: (ev) => {
            if (ev.type === "mouseDown") h.doc.activeElement = h.agent;
          },
          insertText: () => undefined,
        }),
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 2) {
            h.typePhysicalChar("j");
            (h.doc.body as { innerText: string }).innerText = "READY";
          }
        },
      });
      await uiBatch.batch(
        {
          steps: [
            { action: "click", target: { selector: ".agent-target" } },
            { action: "wait_for", text: "READY", timeoutMs: 300 },
          ],
        },
        "A"
      );
      assert.equal(h.agent.value, "", "User typing during batch wait_for must not hit agent target");
      assert.equal(h.user.value, "j", "Captured key during batch wait_for must replay to user input");

      // Standalone anchored click paint gap test (user keystroke during waitForPaint rAF).
      let noteText = "agent note";
      const leafEl = {
        tagName: "DIV",
        isConnected: true,
        classList: { contains: (c: string) => c === "workspace-leaf" || c === "mod-active" },
        contains: (o: unknown) => o === leafEl || o === contentEl,
        closest: (s: string) => (s.includes(".workspace-leaf") ? leafEl : null),
        matches: (s: string) => s.includes(".workspace-leaf"),
        getAttribute: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 450, height: 550, right: 450, bottom: 550 }),
      };
      const contentEl = {
        tagName: "DIV",
        isConnected: true,
        isContentEditable: true,
        classList: { contains: (c: string) => c === "cm-content" },
        matches: () => false,
        closest: (s: string) => (s.includes(".workspace-leaf") ? leafEl : null),
        contains: (o: unknown) => o === contentEl,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ left: 20, top: 40, width: 400, height: 480, right: 420, bottom: 520 }),
      };
      const cm = {
        dom: leafEl as unknown as Element,
        contentDOM: contentEl as unknown as Element,
        scrollDOM: leafEl as unknown as HTMLElement,
        state: {
          doc: {
            toString: () => noteText,
            get length() {
              return noteText.length;
            },
            get lines() {
              return 1;
            },
            line: () => ({ number: 1, from: 0, to: noteText.length, text: noteText }),
          },
          selection: { main: { head: 0, anchor: 0 } },
        },
        coordsAtPos: () => ({ left: 100, top: 120, right: 102, bottom: 140 }),
        focus: () => {
          h.doc.activeElement = contentEl;
        },
        dispatch: () => undefined,
      };
      h.user.value = "";
      h.doc.activeElement = h.user;
      h.doc.elementFromPoint = () => contentEl;
      let painted = false;
      h.win.requestAnimationFrame = ((cb: () => void) => {
        if (!painted && h.doc.activeElement === contentEl) {
          painted = true;
          h.typePhysicalChar("j", () => {
            noteText += "j";
          });
        }
        cb();
        return 1;
      }) as unknown as typeof window.requestAnimationFrame;
      const uiPaint = new UiControlService({
        win: h.win,
        resolveNoteLeaf: () => ({
          path: "Shared.md",
          pane: "main",
          activePane: true,
          containerEl: leafEl as unknown as Element,
          cm,
        }),
        resolveElementContext: (el) => (el === leafEl ? { notePath: "Shared.md", pane: "main", activePane: true } : null),
        getWebContents: () => ({
          capturePage: () => Promise.resolve(fakeImage(1000, 600)),
          sendInputEvent: (ev) => {
            if (ev.type === "mouseDown") h.doc.activeElement = contentEl;
          },
          insertText: () => undefined,
        }),
        sleep: async () => undefined,
      });
      await uiPaint.click({ target: { note: "Shared.md", line: 1 } }, "A");
      assert.equal(noteText, "agent note", "Key typed during waitForPaint must never reach clicked note");
      assert.equal(h.user.value, "j", "Key typed during waitForPaint must replay to user input");
      assert.equal(h.doc.activeElement, h.user);
    }

    // 3) P1-3: Nonfocusing insertLine and anchored ui.type preserve newer user focus and selection choices.
    {
      const h = createHarness();
      h.user.value = "echo ";
      h.user.selectionStart = 5;
      h.user.selectionEnd = 5;
      h.doc.activeElement = h.user;
      let noteText = "## A\nline";
      const leafEl = {
        tagName: "DIV",
        isConnected: true,
        classList: { contains: (c: string) => c === "workspace-leaf" || c === "mod-active" },
        contains: (o: unknown) => o === leafEl || o === contentEl,
        closest: (s: string) => (s.includes(".workspace-leaf") ? leafEl : null),
        matches: (s: string) => s.includes(".workspace-leaf"),
        getAttribute: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 450, height: 550, right: 450, bottom: 550 }),
      };
      const contentEl = {
        tagName: "DIV",
        isConnected: true,
        isContentEditable: true,
        classList: { contains: (c: string) => c === "cm-content" },
        matches: () => false,
        closest: (s: string) => (s.includes(".workspace-leaf") ? leafEl : null),
        contains: (o: unknown) => o === contentEl,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ left: 20, top: 40, width: 400, height: 480, right: 420, bottom: 520 }),
      };
      const cm = {
        dom: leafEl as unknown as Element,
        contentDOM: contentEl as unknown as Element,
        scrollDOM: leafEl as unknown as HTMLElement,
        state: {
          doc: {
            toString: () => noteText,
            get length() {
              return noteText.length;
            },
            get lines() {
              return noteText.split("\n").length;
            },
            line: (n: number) => {
              const all = noteText.split("\n");
              const from = all.slice(0, n - 1).reduce((s, line) => s + line.length + 1, 0);
              return { number: n, from, to: from + all[n - 1].length, text: all[n - 1] };
            },
          },
          selection: { main: { head: 0, anchor: 0 } },
        },
        coordsAtPos: () => ({ left: 100, top: 120, right: 102, bottom: 140 }),
        focus: () => {
          h.doc.activeElement = contentEl;
        },
        dispatch: (spec: Record<string, unknown>) => {
          const ch = spec.changes as { from: number; insert: string } | undefined;
          if (ch && typeof ch.insert === "string") {
            noteText = noteText.slice(0, ch.from) + ch.insert + noteText.slice(ch.from);
          }
        },
      };
      h.doc.elementFromPoint = () => contentEl;
      let userMoved = false;
      const uiAnchored = new UiControlService({
        win: h.win,
        getUiTypingSpeed: () => "visible",
        resolveNoteLeaf: () => ({
          path: "Shared.md",
          pane: "main",
          activePane: true,
          containerEl: leafEl as unknown as Element,
          cm,
          view: { file: { path: "Shared.md" }, editor: { cm } },
        }),
        resolveElementContext: (el) => (el === leafEl ? { notePath: "Shared.md", pane: "main", activePane: true } : null),
        getWebContents: () => null,
        sleep: async () => {
          if (!userMoved) {
            userMoved = true;
            h.user.value = `${String(h.user.value)}x`;
            h.user.selectionStart = 6;
            h.user.selectionEnd = 6;
            (h.next.focus as () => void)();
            (h.next.setSelectionRange as (a: number, b: number) => void)(1, 1);
          }
        },
      });
      const out = (await uiAnchored.insertLine(
        { target: { note: "Shared.md", heading: "A" }, text: "alpha beta gamma" },
        "A"
      )) as { focus: { label: string } };
      assert.equal(h.doc.activeElement, h.next, "insert_line must never restore obsolete initial user focus");
      assert.equal(h.user.selectionStart, 6, "insert_line must never overwrite newer user selection");
      assert.equal(h.next.selectionStart, 1);
      assert.equal(out.focus.label, "Next input");

      // Also verify anchored ui.type leaves newer user focus & selection untouched.
      h.user.selectionStart = 2;
      let movedDuringType = false;
      const uiType = new UiControlService({
        win: h.win,
        getUiTypingSpeed: () => "visible",
        resolveNoteLeaf: () => ({
          path: "Shared.md",
          pane: "main",
          activePane: true,
          containerEl: leafEl as unknown as Element,
          cm,
          view: { file: { path: "Shared.md" }, editor: { cm } },
        }),
        resolveElementContext: (el) => (el === leafEl ? { notePath: "Shared.md", pane: "main", activePane: true } : null),
        getWebContents: () => null,
        sleep: async () => {
          if (!movedDuringType) {
            movedDuringType = true;
            h.doc.activeElement = h.user;
            h.user.selectionStart = 4;
          }
        },
      });
      await uiType.type({ target: { note: "Shared.md", after: "alpha beta gamma" }, text: " tail tail" }, "A");
      assert.equal(h.doc.activeElement, h.user);
      assert.equal(h.user.selectionStart, 4);
    }

    // 4) P1-4: Opening a modal (Mod+P) keeps modal focus without discarding captured user typing.
    {
      const h = createHarness();
      let sentKey = false;
      const uiModal = new UiControlService({
        win: h.win,
        getWebContents: () => ({
          capturePage: () => Promise.resolve(fakeImage(1000, 600)),
          sendInputEvent: (ev) => {
            if (ev.type === "keyDown") {
              h.emit("keydown", { key: ev.keyCode });
              h.setModalOpen(true);
              h.doc.activeElement = h.palette;
            }
          },
          insertText: () => undefined,
        }),
        sleep: async () => {
          if (!sentKey) {
            sentKey = true;
            h.typePhysicalChar("j");
            h.typePhysicalChar("k");
          }
        },
      });
      await uiModal.pressKey({ key: "p", modifiers: ["Mod"] }, "A");
      assert.equal(h.doc.activeElement, h.palette, "Opened modal must retain focus");
      assert.equal(h.palette.value, "", "Modal input must not be polluted by user's pre-modal typing");
      assert.equal(h.user.value, "jk", "Captured user typing during modal open must not be dropped");
    }
  });
});
