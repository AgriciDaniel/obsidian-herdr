import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  HerdrSocketClient,
  isHerdrSocketPresent,
  resolveHerdrSocketEndpoint,
} from "../src/herdr/socket-client";

if (typeof globalThis.window === "undefined") {
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
}
const prefix = "\\\\.\\pipe\\";
describe("Herdr IPC transport", () => {
  it("matches Herdr GenericNamespaced without rewriting Windows paths", () => {
    for (const p of [
      String.raw`C:\Users\Tester\AppData\Roaming\herdr\sessions\test-session\herdr.sock`,
      "C:/Mixed/Český vault/herdr.sock",
      String.raw`\\server\share\herdr.sock`,
      "relative.sock",
    ]) {
      assert.equal(resolveHerdrSocketEndpoint(p, "win32"), prefix + p);
    }
  });
  it("preserves explicit local named pipes and empty paths", () => {
    for (const p of [prefix + "herdr", String.raw`\\?\pipe\herdr`, ""]) {
      assert.equal(resolveHerdrSocketEndpoint(p, "win32"), p);
    }
  });
  it("leaves Linux and macOS socket names unchanged", () => {
    for (const platform of ["linux", "darwin"] as const) {
      for (const p of [
        "/tmp/herdr.sock",
        "/home/český vault/herdr.sock",
        "relative.sock",
        prefix + "literal",
        "",
      ]) {
        assert.equal(resolveHerdrSocketEndpoint(p, platform), p);
      }
    }
  });
  it("recognizes Windows marker files but never mistakes them for Unix sockets", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-marker-test-"));
    const marker = path.join(root, "herdr.sock");
    try {
      fs.writeFileSync(marker, "123:456\n");
      assert.equal(isHerdrSocketPresent(marker, "win32"), true);
      assert.equal(isHerdrSocketPresent(marker, "linux"), false);
      assert.equal(isHerdrSocketPresent(root, "win32"), false);
      assert.equal(
        isHerdrSocketPresent(path.join(root, "absent"), "win32"),
        false,
      );
      assert.equal(isHerdrSocketPresent(prefix + "explicit", "win32"), true);
      assert.equal(isHerdrSocketPresent("", "win32"), false);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  });
  it("uses the native transport for RPC, event subscription and endpoint switching", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-ipc-test-"));
    const logical = path.join(root, "herdr.sock");
    const logical2 = path.join(root, "other.sock");
    const peers = new Set<net.Socket>();
    const methods: string[] = [];
    const makeServer = () =>
      net.createServer((socket) => {
        peers.add(socket);
        socket.on("close", () => peers.delete(socket));
        let buffer = "";
        socket.on("data", (data) => {
          buffer += data.toString();
          let idx: number;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const req = JSON.parse(buffer.slice(0, idx)) as {
              id: string;
              method: string;
            };
            buffer = buffer.slice(idx + 1);
            methods.push(req.method);
            socket.write(
              JSON.stringify({
                id: req.id,
                result: { version: "0.9.5", protocol: 22 },
              }) + "\n",
            );
            if (req.method === "events.subscribe")
              socket.write(
                JSON.stringify({
                  event: "workspace.updated",
                  data: { test: true },
                }) + "\n",
              );
          }
        });
      });
    const a = makeServer(),
      b = makeServer();
    const client = new HerdrSocketClient(logical);
    try {
      await new Promise<void>((r) =>
        a.listen(resolveHerdrSocketEndpoint(logical), r),
      );
      await new Promise<void>((r) =>
        b.listen(resolveHerdrSocketEndpoint(logical2), r),
      );
      if (process.platform === "win32") fs.writeFileSync(logical, "123:456\n");
      assert.equal(client.isSocketPresent(), true);
      assert.equal(client.getSocketPath(), logical);
      assert.deepEqual(await client.ping(), { version: "0.9.5", protocol: 22 });
      const event = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("subscription timed out")),
          2000,
        );
        client.onEvent((ev) => {
          if (ev.event === "workspace.updated") {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      client.startSubscription();
      await event;
      assert.equal(client.isSubscribed(), true);
      client.stopSubscription();
      client.setSocketPath(logical2);
      assert.equal(
        client.getConnectionPath(),
        resolveHerdrSocketEndpoint(logical2),
      );
      assert.deepEqual(await client.ping(), { version: "0.9.5", protocol: 22 });
      assert.ok(methods.includes("events.subscribe"));
    } finally {
      client.dispose();
      for (const peer of peers) peer.destroy();
      await Promise.all([
        new Promise<void>((r) => a.close(() => r())),
        new Promise<void>((r) => b.close(() => r())),
      ]);
      fs.rmSync(root, { recursive: true });
    }
  });
});
