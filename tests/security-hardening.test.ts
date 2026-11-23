import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { App } from "obsidian";
import {
  buildBridgeEnvForPanes,
  computeRuntimePaths,
  provisionRuntimeKit,
} from "../src/bridge/runtime-kit";
import { VaultBridgeServer } from "../src/bridge/vault-bridge-server";
import { BridgeRpcError, VaultOpsService } from "../src/bridge/vault-ops";
import { UiControlService } from "../src/control/ui-control";
import {
  assertNoSymlinkEscape,
  guardVaultRelativePath,
  VaultPathGuardError,
} from "../src/domain/path-guard";
import { IS_WINDOWS, makeShortTmpDir, testSocketPath } from "./helpers/portable";
import { createMockObsidianApp } from "./obsidian-mock";

// Short base: some tests listen on Unix sockets under these dirs (macOS caps paths at 104 bytes).
function makeTempDir(prefix: string): string {
  return makeShortTmpDir(prefix);
}

describe("Phase 1 Security & Data-Integrity Hardening", () => {
  it("S2/S3: blocks nested .git, nested hidden dirs, symlink escapes, and vault.list_files on protected folders", async () => {
    const vaultRoot = makeTempDir("herdr-sec-vault-");
    const outsideDir = makeTempDir("herdr-sec-out-");
    try {
      fs.writeFileSync(path.join(vaultRoot, "Public.md"), "# Public\n", "utf8");
      fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
      fs.writeFileSync(path.join(vaultRoot, ".obsidian", "app.json"), "{}", "utf8");
      fs.mkdirSync(path.join(vaultRoot, "sub", ".git", "hooks"), { recursive: true });
      fs.writeFileSync(path.join(vaultRoot, "sub", ".git", "hooks", "post-checkout"), "#!/bin/sh\n", "utf8");
      fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top-secret", "utf8");
      // Creating symlinks on Windows needs admin or Developer Mode, so the escape checks are POSIX only.
      if (!IS_WINDOWS) {
        fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(vaultRoot, "leak.md"));
      }

      // Nested .git blocked on both read and write even when allowHiddenRead is true
      assert.throws(
        () => guardVaultRelativePath("sub/.git/hooks/post-checkout", { allowHiddenRead: true, isWrite: false }),
        (err: unknown) => err instanceof VaultPathGuardError && err.code === "protected_directory"
      );
      assert.throws(
        () => guardVaultRelativePath("sub/.ssh/id_rsa", { allowHiddenRead: false, isWrite: false }),
        (err: unknown) => err instanceof VaultPathGuardError && err.code === "protected_directory"
      );
      assert.throws(
        () => guardVaultRelativePath("sub/.hidden/note.md", { allowHiddenRead: true, isWrite: true }),
        (err: unknown) => err instanceof VaultPathGuardError && err.code === "protected_directory"
      );

      // Symlink escape blocked
      if (!IS_WINDOWS) {
        assert.throws(
          () => assertNoSymlinkEscape(vaultRoot, "leak.md"),
          (err: unknown) => err instanceof VaultPathGuardError && err.code === "symlink_escape_forbidden"
        );
      }

      // vault.list_files rejects protected folder parameter
      const mockApp = createMockObsidianApp(vaultRoot);
      const ops = new VaultOpsService({
        app: mockApp as unknown as App,
        getPermissionMode: () => "full",
        getAllowHiddenReads: () => false,
      });

      await assert.rejects(
        () => ops.dispatch("vault.list_files", { folder: ".obsidian" }, "agent"),
        (err: unknown) => err instanceof BridgeRpcError && err.code === "protected_directory"
      );
      await assert.rejects(
        () => ops.dispatch("vault.list_files", { folder: ".git" }, "agent"),
        (err: unknown) => err instanceof BridgeRpcError && err.code === "protected_directory"
      );
      if (!IS_WINDOWS) {
        await assert.rejects(
          () => ops.dispatch("vault.read_note", { path: "leak.md" }, "agent"),
          (err: unknown) => err instanceof BridgeRpcError && err.code === "symlink_escape_forbidden"
        );
      }
    } finally {
      fs.rmSync(vaultRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("S4/H1/H2/H3/M4: blocks frontmatter prototype pollution, fixes $ search_replace, validates canvas, fences headings, tightens commands.execute", async () => {
    const vaultRoot = makeTempDir("herdr-sec-ops-");
    try {
      fs.writeFileSync(
        path.join(vaultRoot, "Doc.md"),
        [
          "---",
          "title: Demo",
          "---",
          "# Real Heading",
          "",
          "```sh",
          "# Real Heading",
          "echo $&",
          "```",
          "",
          "Price: OLD_PRICE",
          "",
        ].join("\n"),
        "utf8"
      );

      const mockApp = createMockObsidianApp(vaultRoot);
      const ops = new VaultOpsService({
        app: mockApp as unknown as App,
        getPermissionMode: () => "full",
        getAllowHiddenReads: () => false,
      });

      // Prototype pollution blocked
      const pollutedParams = JSON.parse('{"path":"Doc.md","set":{"__proto__":{"pwned":true}}}');
      await assert.rejects(
        () => ops.dispatch("vault.patch_frontmatter", pollutedParams, "agent"),
        (err: unknown) => err instanceof BridgeRpcError && err.code === "invalid_params"
      );
      await assert.rejects(
        () => ops.dispatch("vault.patch_frontmatter", { path: "Doc.md", set: { constructor: "x" } }, "agent"),
        (err: unknown) => err instanceof BridgeRpcError && err.code === "invalid_params"
      );

      // search_replace preserves literal $&, $$, $` without JS String.replace corruption
      await ops.dispatch(
        "vault.update_note",
        { path: "Doc.md", mode: "search_replace", search: "OLD_PRICE", content: "$100 $& $$ $`" },
        "agent"
      );
      const afterReplace = fs.readFileSync(path.join(vaultRoot, "Doc.md"), "utf8");
      assert.ok(afterReplace.includes("Price: $100 $& $$ $`"), `Expected literal $ tokens, got: ${afterReplace}`);

      // Invalid update mode rejected instead of silently appending
      await assert.rejects(
        () => ops.dispatch("vault.update_note", { path: "Doc.md", mode: "typo_mode", content: "x" }, "agent"),
        (err: unknown) => err instanceof BridgeRpcError && err.code === "invalid_params"
      );

      // under_heading ignores headings inside fenced code blocks
      await ops.dispatch(
        "vault.update_note",
        { path: "Doc.md", mode: "under_heading", heading: "Real Heading", content: "- appended after fence" },
        "agent"
      );
      const afterHeading = fs.readFileSync(path.join(vaultRoot, "Doc.md"), "utf8");
      assert.ok(afterHeading.trimEnd().endsWith("- appended after fence"));

      // Canvas validation: rejects bad scheme, path traversal in file, invalid nodeType, preserves label
      await assert.rejects(
        () => ops.dispatch("canvas.upsert_node", { path: "Board.canvas", nodeType: "link", url: "javascript:alert(1)" }, "agent"),
        (err: unknown) => err instanceof BridgeRpcError && err.code === "invalid_params"
      );
      await assert.rejects(
        () => ops.dispatch("canvas.upsert_node", { path: "Board.canvas", nodeType: "file", file: "../secret.md" }, "agent"),
        (err: unknown) => err instanceof BridgeRpcError && err.code === "path_traversal_forbidden"
      );
      await ops.dispatch(
        "canvas.upsert_node",
        { path: "Board.canvas", id: "g1", nodeType: "group", label: "Phase 1" },
        "agent"
      );
      const boardJson = JSON.parse(fs.readFileSync(path.join(vaultRoot, "Board.canvas"), "utf8")) as {
        nodes: Array<{ id: string; label?: string }>;
      };
      assert.equal(boardJson.nodes[0]?.label, "Phase 1");

      // Tightened commands.execute rejects herdr-obs:* and app:reload when protected areas are off
      await assert.rejects(
        () => ops.dispatch("commands.execute", { commandId: "herdr-obs:spawn-coding-agent" }, "agent"),
        (err: unknown) => err instanceof BridgeRpcError && err.code === "command_blocked"
      );
      await assert.rejects(
        () => ops.dispatch("commands.execute", { commandId: "app:reload" }, "agent"),
        (err: unknown) => err instanceof BridgeRpcError && err.code === "ui_protected_area"
      );
    } finally {
      fs.rmSync(vaultRoot, { recursive: true, force: true });
    }
  });

  it("S5: VaultBridgeServer handles null JSON safely, preserves split multi-byte UTF-8, and refuses hijacking a live socket", async () => {
    const tmp = makeTempDir("herdr-sec-srv-");
    const sockPath = testSocketPath(tmp, "b.sock");
    const srv = new VaultBridgeServer({
      socketPath: sockPath,
      kitDir: tmp,
      dispatcher: async (_method, params) => ({ echoed: params.text }),
    });
    await srv.start();
    try {
      // Starting a second server on the same live socket must fail instead of hijacking
      const hijack = new VaultBridgeServer({
        socketPath: sockPath,
        kitDir: tmp,
        dispatcher: async () => ({}),
      });
      // POSIX probes the live socket and reports it. A Windows named pipe is opened with
      // FILE_FLAG_FIRST_PIPE_INSTANCE, so the second listen fails with EADDRINUSE instead.
      await assert.rejects(() => hijack.start(), IS_WINDOWS ? /already listening|EADDRINUSE/i : /already listening/i);

      // null JSON line returns structured invalid_json instead of crashing
      const nullResp = await new Promise<string>((resolve, reject) => {
        const c = net.createConnection({ path: sockPath });
        let data = "";
        c.on("connect", () => c.write("null\n"));
        c.on("data", (chunk) => {
          data += chunk.toString("utf8");
          if (data.includes("\n")) {
            c.destroy();
            resolve(data.trim());
          }
        });
        c.on("error", reject);
      });
      const parsedNull = JSON.parse(nullResp) as { ok: boolean; error?: { code: string } };
      assert.equal(parsedNull.ok, false);
      assert.equal(parsedNull.error?.code, "invalid_json");

      // Multi-byte UTF-8 split across two TCP/Unix chunks decodes intact
      const emojiText = "Hello 🚀🔥 日本語 café";
      const reqBuf = Buffer.from(
        JSON.stringify({
          id: "u1",
          token: srv.getAuthToken(),
          method: "echo",
          params: { text: emojiText },
        }) + "\n",
        "utf8"
      );
      const splitIdx = reqBuf.indexOf(0xf0) + 2; // Split right in the middle of the 4-byte 🚀 sequence
      const utf8Resp = await new Promise<string>((resolve, reject) => {
        const c = net.createConnection({ path: sockPath });
        let chunks: Buffer[] = [];
        c.on("connect", () => {
          c.write(reqBuf.subarray(0, splitIdx));
          setTimeout(() => c.write(reqBuf.subarray(splitIdx)), 15);
        });
        c.on("data", (chunk) => {
          chunks.push(chunk);
          const merged = Buffer.concat(chunks);
          if (merged.includes(0x0a)) {
            c.destroy();
            resolve(merged.toString("utf8").trim());
          }
        });
        c.on("error", reject);
      });
      const parsedUtf8 = JSON.parse(utf8Resp) as { ok: boolean; result?: { echoed: string } };
      assert.equal(parsedUtf8.ok, true);
      assert.equal(parsedUtf8.result?.echoed, emojiText);
    } finally {
      await srv.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("S1/H8: buildBridgeEnvForPanes omits plaintext token and runtime-kit writes clean wrappers", () => {
    const tmp = makeTempDir("herdr-sec-kit-");
    try {
      const kit = computeRuntimePaths("sec-vault-key", tmp);
      const token = "a".repeat(64);
      provisionRuntimeKit({
        kit,
        token,
        vaultName: "SecVault",
        vaultPath: tmp,
        pluginVersion: "0.3.2",
      });
      const env = buildBridgeEnvForPanes({
        kit,
        token,
        vaultName: "SecVault",
        vaultPath: tmp,
      });
      assert.equal(env.OBSIDIAN_HERDR_BRIDGE_TOKEN, undefined);
      assert.equal(env.OBSIDIAN_HERDR_CONNECTION_FILE, kit.connectionFilePath);
      const conn = JSON.parse(fs.readFileSync(kit.connectionFilePath, "utf8")) as { token: string };
      assert.equal(conn.token, token);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("S6: UiControlService blocks DevTools/reload shortcuts, blocks password press_key, redacts protected inspect, and hooks ui.select", async () => {
    let hookCalls = 0;
    const makeEl = (tag: string, attrs: Record<string, string> = {}, text = "", parent: unknown = null) => {
      const el: Record<string, unknown> = {
        tagName: tag.toUpperCase(),
        textContent: text,
        innerText: text,
        value: attrs.value ?? "",
        type: attrs.type ?? "",
        disabled: false,
        parentElement: parent,
        children: [],
        getAttribute: (k: string) => attrs[k] ?? null,
        matches: (sel: string) => {
          if (sel.includes("mod-settings")) return attrs.class?.includes("mod-settings") ?? false;
          if (sel.includes("input")) return tag === "input" && attrs.type !== "password";
          if (sel === "select") return tag === "select";
          return false;
        },
        closest: (sel: string) => {
          let cur: Record<string, unknown> | null = el;
          while (cur) {
            if (typeof cur.matches === "function" && (cur.matches as (s: string) => boolean)(sel)) {
              return cur;
            }
            cur = (cur.parentElement as Record<string, unknown> | null) ?? null;
          }
          return null;
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ x: 10, y: 10, left: 10, top: 10, width: 100, height: 30, right: 110, bottom: 40 }),
        dispatchEvent: () => true,
      };
      return el;
    };

    const settingsContainer = makeEl("div", { class: "mod-settings" });
    const secretInput = makeEl("input", { type: "text", value: "sk-live-secret", "aria-label": "API key" }, "", settingsContainer);
    const pwInput = makeEl("input", { type: "password", value: "hunter2" });
    const optA = { value: "a", textContent: "Alpha", label: "Alpha", disabled: false, selected: false };
    const optB = { value: "b", textContent: "Beta", label: "Beta", disabled: false, selected: false };
    const selectEl = makeEl("select", { value: "a" });
    selectEl.options = [optA, optB];

    let currentActive: unknown = pwInput;
    const win = {
      innerWidth: 1280,
      innerHeight: 800,
      devicePixelRatio: 1,
      document: {
        get activeElement() {
          return currentActive;
        },
        body: { innerText: "" },
        elementFromPoint: () => selectEl,
        querySelectorAll: (sel: string) => (sel === "select" ? [selectEl] : [secretInput]),
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      setTimeout,
      clearTimeout,
    } as unknown as Window;

    const svc = new UiControlService({
      win,
      getWebContents: () => ({
        getZoomFactor: () => 1,
        capturePage: async () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => new Uint8Array(), resize: () => ({} as never) }),
        sendInputEvent: () => undefined,
        insertText: async () => undefined,
      }),
      beforeMutation: () => {
        hookCalls += 1;
      },
    });

    // DevTools and reload shortcuts blocked
    await assert.rejects(
      () => svc.pressKey({ key: "F12" }, "agent"),
      (err: unknown) => err instanceof Error && /Developer Tools/i.test(err.message)
    );
    await assert.rejects(
      () => svc.pressKey({ key: "Ctrl+Shift+I" }, "agent"),
      (err: unknown) => err instanceof Error && /Developer Tools/i.test(err.message)
    );
    await assert.rejects(
      () => svc.pressKey({ key: "Ctrl+R" }, "agent"),
      (err: unknown) => err instanceof Error && /reload/i.test(err.message)
    );

    // Password field blocked on press_key
    await assert.rejects(
      () => svc.pressKey({ key: "a" }, "agent"),
      (err: unknown) => (err as { code?: string })?.code === "ui_password_field"
    );

    // Protected inspect redacts text & value when allowUiInProtectedAreas is false
    const inspected = svc.inspect({ limit: 10 }) as {
      elements: Array<{ label: string; text: string; value?: string; protected?: boolean }>;
    };
    assert.equal(inspected.elements[0]?.protected, true);
    assert.equal(inspected.elements[0]?.label, "API key");
    assert.equal(inspected.elements[0]?.text, "");
    assert.equal(inspected.elements[0]?.value, undefined);

    // Substring-extraction oracle against protected elements must return 0 matches
    const probeInspect = svc.inspect({ selector: "input", text: "API" }) as {
      total: number;
      elements: unknown[];
    };
    assert.equal(probeInspect.total, 0);
    assert.equal(probeInspect.elements.length, 0);

    // ui.select invokes beforeMutation hook
    currentActive = selectEl;
    await svc.select({ selector: "select", value: "b" }, "agent");
    assert.equal(hookCalls, 1);
    assert.equal(selectEl.value, "b");
  });

  it("Audit regressions: drive-relative path blocked, Mission Control/Bases/Widget protected, and auth failure disconnects", async () => {
    assert.throws(
      () => guardVaultRelativePath("C:secret.md"),
      (err: unknown) => err instanceof VaultPathGuardError && err.code === "absolute_path_forbidden"
    );

    const { isProtectedElement } = await import("../src/control/safety-guard");
    const makeMockEl = (cls: string, dataType = "") => {
      const node: Record<string, unknown> = {
        tagName: "DIV",
        parentElement: null,
        getAttribute: (k: string) => (k === "data-type" ? dataType : null),
        matches: (sel: string) =>
          (cls !== "" && sel.includes(`.${cls}`)) ||
          (dataType !== "" && sel.includes(`[data-type="${dataType}"]`)),
        closest(sel: string) {
          return (node.matches as (s: string) => boolean)(sel) ? node : null;
        },
        querySelector: () => null,
      };
      return node as unknown as Element;
    };
    assert.equal(isProtectedElement(makeMockEl("herdr-dashboard-pane", "herdr-view")), true);
    assert.equal(isProtectedElement(makeMockEl("herdr-embed-card")), true);
    assert.equal(isProtectedElement(makeMockEl("herdr-bases-board", "herdr-agent-board")), true);

    const { isCommandBlocked, isProtectedCommand } = await import("../src/bridge/policy");
    assert.equal(isCommandBlocked("app:delete-file"), true);
    assert.equal(isProtectedCommand("app:toggle-dev-tools"), true);
    assert.equal(isProtectedCommand("window:toggle-dev-tools"), true);
  });

  it("Release review: the bridge idle timeout never cuts off a request that is still running, but still closes silent sockets", async () => {
    const tmp = makeTempDir("herdr-sec-idle-");
    const sockPath = testSocketPath(tmp, "b.sock");
    const srv = new VaultBridgeServer({
      socketPath: sockPath,
      kitDir: tmp,
      clientIdleTimeoutMs: 150,
      dispatcher: async () => {
        // Four times the idle timeout, like a long ui.batch or a wait behind the UI lock.
        await new Promise((resolve) => setTimeout(resolve, 600));
        return { done: true };
      },
    });
    await srv.start();
    try {
      const slow = await new Promise<string>((resolve, reject) => {
        const c = net.createConnection({ path: sockPath });
        let data = "";
        c.on("connect", () => {
          c.write(JSON.stringify({ id: "slow", token: srv.getAuthToken(), method: "slow", params: {} }) + "\n");
        });
        c.on("data", (chunk) => {
          data += chunk.toString("utf8");
          if (data.includes("\n")) {
            c.end();
            resolve(data.trim());
          }
        });
        c.on("close", () => resolve(data.trim()));
        c.on("error", reject);
      });
      assert.ok(slow, "the connection closed before the slow request answered");
      const parsed = JSON.parse(slow) as { ok: boolean; result?: { done?: boolean } };
      assert.equal(parsed.ok, true);
      assert.equal(parsed.result?.done, true);

      // A socket that never sends anything is still closed by the idle timeout.
      const closedAfterMs = await new Promise<number>((resolve, reject) => {
        const started = Date.now();
        const c = net.createConnection({ path: sockPath });
        c.on("close", () => resolve(Date.now() - started));
        c.on("error", reject);
      });
      assert.ok(closedAfterMs < 2000, `idle socket stayed open for ${closedAfterMs} ms`);
    } finally {
      await srv.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
