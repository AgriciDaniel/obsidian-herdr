import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { isCommandBlocked } from "../src/bridge/policy";
import { legacyWindowsConnectionFilePath, readExistingBridgeToken } from "../src/bridge/kit-paths";
import type { NativeImageLike } from "../src/control/types";
import { UiControlService } from "../src/control/ui-control";

// Regressions for the second pre-release audit of 0.3.2 (2026-11-23).

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeImage(width: number, height: number): NativeImageLike {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => new Uint8Array(PNG_BYTES),
    resize: (opts) => fakeImage(opts.width, Math.round((height * opts.width) / width)),
  };
}

function rectEl(
  matchesSelector: (selector: string) => boolean,
  box: { left: number; top: number; width: number; height: number }
): Element {
  const el = {
    closest: (selector: string) => (matchesSelector(selector) ? el : null),
    getBoundingClientRect: () => ({
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
    }),
  };
  return el as unknown as Element;
}

function captureHarness(options: { canvas: boolean; allowProtected?: boolean }) {
  const fills: Array<[number, number, number, number]> = [];
  // A Herdr terminal on the right half and an ordinary note on the left.
  const terminal = rectEl((s) => s.includes(".xterm"), { left: 600, top: 0, width: 600, height: 800 });
  const note = rectEl(() => false, { left: 0, top: 0, width: 600, height: 800 });
  const win: Record<string, unknown> = {
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 2,
    document: { querySelectorAll: () => [terminal, note] },
    requestAnimationFrame: (cb: () => void) => {
      cb();
      return 1;
    },
    setTimeout,
    clearTimeout,
  };
  if (options.canvas) {
    win.createImageBitmap = async () => ({ close: () => undefined });
    win.OffscreenCanvas = class {
      constructor(
        public width: number,
        public height: number
      ) {}
      getContext() {
        return {
          fillStyle: "",
          drawImage: () => undefined,
          fillRect: (x: number, y: number, w: number, h: number) => fills.push([x, y, w, h]),
        };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
      }
    };
  }
  const ui = new UiControlService({
    win: win as unknown as Window,
    getWebContents: () => ({
      capturePage: () => Promise.resolve(fakeImage(2400, 1600)),
      sendInputEvent: () => undefined,
      insertText: () => undefined,
    }),
    getAllowUiInProtectedAreas: () => options.allowProtected === true,
    sleep: async () => undefined,
  });
  return { ui, fills };
}

describe("Release hardening (0.3.2 audit)", () => {
  it("refuses commands of plugins that can run code or open other programs, by their real plugin ids", () => {
    for (const id of [
      "templater-obsidian:replace-in-file-templater",
      "templater-obsidian:insert-templater",
      "obsidian-shellcommands:shell-command-0",
      "execute-code:run-all-code-blocks-in-file",
      "open-with-default-app:open",
      "terminal:open-terminal.integrated.root",
      "cmdr:macro-0",
      "customjs:invoke-script",
      "quickadd:runQuickAdd",
      "herdr-obs:open-mission-control",
      "  Templater-Obsidian:replace-in-file-templater",
    ]) {
      assert.equal(isCommandBlocked(id), true, `${id} should be blocked`);
    }
    for (const id of ["editor:toggle-bold", "workspace:split-vertical", "daily-notes", "dataview:dataview-force-refresh-views"]) {
      assert.equal(isCommandBlocked(id), false, `${id} should stay allowed`);
    }
  });

  it("paints over Herdr terminals in screenshots, like inspect redacts them", async () => {
    const { ui, fills } = captureHarness({ canvas: true });
    const shot = (await ui.screenshot({})) as { maskedProtectedAreas: number; image: { data: string } };
    assert.equal(shot.maskedProtectedAreas, 1);
    // Only the terminal box, scaled from CSS pixels to the 2x image: x 600 -> 1200.
    assert.equal(fills.length, 1);
    const [x, y, w, h] = fills[0];
    assert.ok(x <= 1200 && x >= 1198, `mask starts at ${x}`);
    assert.equal(y, 0);
    assert.ok(w >= 1200 && h >= 1600, `mask covers ${w}x${h}`);
    assert.equal(Buffer.from(shot.image.data, "base64").length, 3, "the masked PNG is returned, not the raw capture");
  });

  it("refuses the screenshot when protected areas cannot be hidden, and skips masking when the user allows protected areas", async () => {
    const { ui } = captureHarness({ canvas: false });
    await assert.rejects(() => ui.screenshot({}), (err: unknown) => {
      return (err as { code?: string }).code === "ui_capture_mask_unavailable";
    });

    const allowed = captureHarness({ canvas: false, allowProtected: true });
    const shot = (await allowed.ui.screenshot({})) as { maskedProtectedAreas: number };
    assert.equal(shot.maskedProtectedAreas, 0);
  });
});

describe("Upgrade from 0.2.x (0.3.2 audit)", () => {
  it("finds the 0.2.x Windows connection.json in %TEMP%, and never looks in a shared temp folder elsewhere", () => {
    const kit = {
      runtimeDir: path.join("C:", "Users", "u", "AppData", "Local", "obs-herdr", "0123456789ab"),
      connectionFilePath: path.join("C:", "Users", "u", "AppData", "Local", "obs-herdr", "0123456789ab", "connection.json"),
    };
    const tmp = path.join("C:", "Users", "u", "AppData", "Local", "Temp");
    assert.equal(
      legacyWindowsConnectionFilePath(kit, "win32", tmp),
      path.join(tmp, "0123456789ab", "connection.json")
    );
    assert.equal(legacyWindowsConnectionFilePath(kit, "linux", "/tmp"), null);
    assert.equal(legacyWindowsConnectionFilePath(kit, "darwin", "/tmp"), null);
    // Already in the old location (LOCALAPPDATA unusable): nothing to migrate.
    const tmpKit = { runtimeDir: path.join(tmp, "0123456789ab"), connectionFilePath: path.join(tmp, "0123456789ab", "connection.json") };
    assert.equal(legacyWindowsConnectionFilePath(tmpKit, "win32", tmp), null);
    // Test kits (oh-<digest>) and odd names are ignored.
    assert.equal(legacyWindowsConnectionFilePath({ runtimeDir: "x/oh-0123456789ab", connectionFilePath: "y" }, "win32", tmp), null);
  });

  it("reuses a valid token from the legacy file and ignores a malformed one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-legacy-"));
    try {
      const file = path.join(dir, "connection.json");
      const token = "a".repeat(64);
      fs.writeFileSync(file, JSON.stringify({ token }), "utf8");
      assert.equal(readExistingBridgeToken(file), token);
      fs.writeFileSync(file, JSON.stringify({ token: "not-a-token" }), "utf8");
      assert.equal(readExistingBridgeToken(file), undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Abandoned UI requests (0.3.2 audit)", () => {
  it("skips a queued UI action whose agent hung up before its turn, and still runs the others", async () => {
    const ran: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const ui = new UiControlService({
      win: { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, document: {} } as unknown as Window,
      getWebContents: () => null,
      sleep: async () => undefined,
    });
    const internals = ui as unknown as {
      serialize: <T>(task: () => Promise<T>) => Promise<T>;
    };
    // Agent A holds the UI lock (a long batch).
    const first = ui.runForRequest(
      () => false,
      () =>
        internals.serialize(
          () =>
            new Promise<string>((resolve) => {
              ran.push("A");
              releaseFirst = () => resolve("A done");
            })
        )
    );
    // Agent B queues a click, then its client times out and disconnects.
    let bGone = false;
    const second = ui.runForRequest(
      () => bGone,
      () =>
        internals.serialize(async () => {
          ran.push("B");
          return "B done";
        })
    );
    // Agent C queues normally and stays connected.
    const third = ui.runForRequest(
      () => false,
      () =>
        internals.serialize(async () => {
          ran.push("C");
          return "C done";
        })
    );
    // Let A start, then B's agent gives up while A still holds the lock.
    for (let i = 0; i < 20 && !ran.includes("A"); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(ran, ["A"]);
    bGone = true;
    releaseFirst();
    assert.equal(await first, "A done");
    await assert.rejects(second, (err: unknown) => (err as { code?: string }).code === "ui_request_abandoned");
    assert.equal(await third, "C done");
    assert.deepEqual(ran, ["A", "C"]);
  });
});
