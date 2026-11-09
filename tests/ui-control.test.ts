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
import { buildKeyPress } from "../src/control/keys";
import {
  type NativeImageLike,
  UiControlError,
  UiControlService,
  type WebContentsLike,
} from "../src/control/ui-control";
import type { VaultPermissionMode } from "../src/domain/types";
import { createMockObsidianApp } from "./obsidian-mock";

const execFileAsync = promisify(execFile);

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
    assert.deepEqual(typed, ["Hello ✓"]);

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
});
