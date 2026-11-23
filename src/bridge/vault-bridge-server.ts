import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { VaultBridgeRequest, VaultBridgeResponse } from "../domain/types";
import { BridgeRpcError } from "./vault-ops";

export type BridgeMethodDispatcher = (
  method: string,
  params: Record<string, unknown>,
  caller: string,
  /** True once the client that sent this request has disconnected (gave up or timed out). */
  isAbandoned?: () => boolean
) => Promise<unknown>;

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT_CLIENTS = 64;
const CLIENT_IDLE_TIMEOUT_MS = 60_000;

function isSocketLive(socketPath: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (live: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(live);
    };
    const sock = net.createConnection({ path: socketPath });
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * Identity of a socket file. The inode number alone is not enough: ext4 and tmpfs reuse a
 * freed inode number at once, so a newer server's socket can look like ours. The creation
 * (or change) time in nanoseconds tells them apart.
 */
interface SocketIdentity {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
  ctimeNs: bigint;
}

function readSocketIdentity(socketPath: string): SocketIdentity | null {
  const st = fs.lstatSync(socketPath, { bigint: true });
  if (!st.isSocket()) {
    return null;
  }
  return { dev: st.dev, ino: st.ino, birthtimeNs: st.birthtimeNs, ctimeNs: st.ctimeNs };
}

function sameSocketIdentity(a: SocketIdentity, b: SocketIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.ctimeNs === b.ctimeNs;
}

function isPathInsideDir(targetPath: string, containerDir: string): boolean {
  const rel = path.relative(path.resolve(containerDir), path.resolve(targetPath));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Local-only Unix domain socket / Windows named pipe RPC server for the Obsidian Vault Control Bridge.
 * Authenticates every request with a constant-time 256-bit bearer token check.
 */
export class VaultBridgeServer {
  private readonly socketPath: string;
  private readonly kitDir: string | null;
  private readonly authToken: string;
  private readonly dispatcher: BridgeMethodDispatcher;
  private readonly clientIdleTimeoutMs: number;
  private server: net.Server | null = null;
  private socketIdentity: SocketIdentity | null = null;
  private readonly activeClients = new Set<net.Socket>();
  private running = false;

  constructor(options: {
    socketPath: string;
    kitDir?: string;
    authToken?: string;
    dispatcher: BridgeMethodDispatcher;
    /** Closes sockets that send nothing for this long while no request is running. */
    clientIdleTimeoutMs?: number;
  }) {
    this.socketPath = options.socketPath;
    this.kitDir = options.kitDir ? path.resolve(options.kitDir) : null;
    this.authToken = options.authToken || crypto.randomBytes(32).toString("hex");
    this.dispatcher = options.dispatcher;
    this.clientIdleTimeoutMs = options.clientIdleTimeoutMs ?? CLIENT_IDLE_TIMEOUT_MS;
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  getAuthToken(): string {
    return this.authToken;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    if (process.platform !== "win32") {
      const socketDir = path.dirname(this.socketPath);
      fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
      if (socketDir !== os.tmpdir() && socketDir !== "/tmp") {
        try {
          fs.chmodSync(socketDir, 0o700);
        } catch {
          // Ignore chmod on unsupported fs
        }
      }
      let existingStat: fs.Stats | null = null;
      try {
        existingStat = fs.lstatSync(this.socketPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") {
          throw err;
        }
      }
      if (existingStat) {
        if (existingStat.isSocket()) {
          if (await isSocketLive(this.socketPath)) {
            throw new Error(
              `Another live Vault Control Bridge is already listening on '${this.socketPath}'.`
            );
          }
          try {
            fs.unlinkSync(this.socketPath);
          } catch {
            // Ignore stale socket cleanup error
          }
        } else if (
          !existingStat.isDirectory() &&
          this.kitDir &&
          isPathInsideDir(this.socketPath, this.kitDir)
        ) {
          fs.unlinkSync(this.socketPath);
        } else {
          throw new Error(
            `Refusing to remove non-socket entry at bridge socket path '${this.socketPath}' outside the runtime kit directory.`
          );
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer((client) => {
        this.handleClient(client);
      });
      srv.maxConnections = MAX_CONCURRENT_CLIENTS;

      const onStartupError = (err: Error) => {
        reject(err);
      };
      srv.once("error", onStartupError);

      srv.listen(this.socketPath, () => {
        srv.off("error", onStartupError);
        srv.on("error", (err: Error) => {
          this.running = false;
          console.warn("[herdr-obs] Vault bridge server error:", err);
          void this.stop().catch(() => undefined);
        });

        if (process.platform !== "win32") {
          try {
            fs.chmodSync(this.socketPath, 0o600);
          } catch {
            // Ignore chmod on unsupported fs
          }
          try {
            this.socketIdentity = readSocketIdentity(this.socketPath);
          } catch {
            this.socketIdentity = null;
          }
        } else {
          this.socketIdentity = null;
        }
        this.server = srv;
        this.running = true;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    const ownedIdentity = this.socketIdentity;
    this.socketIdentity = null;
    for (const sock of this.activeClients) {
      sock.destroy();
    }
    this.activeClients.clear();

    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
      });
    }

    if (process.platform !== "win32" && ownedIdentity !== null) {
      try {
        const current = readSocketIdentity(this.socketPath);
        // Our server is closed now, so anything still answering on this path is a newer
        // bridge (for example after a plugin reload): never delete its socket.
        if (current && sameSocketIdentity(current, ownedIdentity) && !(await isSocketLive(this.socketPath))) {
          fs.unlinkSync(this.socketPath);
        }
      } catch {
        // Ignore cleanup failure or already removed socket
      }
    }
  }

  private handleClient(client: net.Socket): void {
    this.activeClients.add(client);
    client.setTimeout(this.clientIdleTimeoutMs, () => {
      client.destroy();
    });
    let pending: Buffer = Buffer.alloc(0);
    const queuedLines: string[] = [];
    let draining = false;
    let consecutiveFailures = 0;
    const MAX_QUEUED_LINES = 64;
    const MAX_CONSECUTIVE_FAILURES = 5;

    const drainQueue = async (): Promise<void> => {
      if (draining) {
        return;
      }
      draining = true;
      // The idle timeout guards silent sockets only. While a request is being
      // handled the client is waiting on us, so a long ui.batch or a request
      // queued behind another agent's UI lock must not be cut off at 60 s.
      client.setTimeout(0);
      try {
        while (queuedLines.length > 0 && !client.destroyed) {
          const line = queuedLines.shift();
          if (!line) {
            continue;
          }
          const outcome = await this.processLine(client, line);
          if (outcome === "bad_frame") {
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              client.end();
              break;
            }
          } else {
            consecutiveFailures = 0;
          }
        }
      } finally {
        draining = false;
        if (!client.destroyed) {
          client.setTimeout(this.clientIdleTimeoutMs);
        }
        if (!client.destroyed && queuedLines.length === 0) {
          client.resume();
        }
      }
    };

    client.on("data", (chunk: Buffer) => {
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      if (pending.length > MAX_FRAME_BYTES) {
        const overflowPayload =
          JSON.stringify({
            id: "overflow",
            ok: false,
            error: {
              code: "payload_too_large",
              message: "Vault Bridge request exceeded 2 MiB frame limit.",
            },
          }) + "\n";
        pending = Buffer.alloc(0);
        if (!client.destroyed && client.writable) {
          client.end(overflowPayload, "utf8");
        } else {
          client.destroy();
        }
        return;
      }

      let newlineIdx = pending.indexOf(0x0a);
      while (newlineIdx !== -1) {
        const line = pending.subarray(0, newlineIdx).toString("utf8").trim();
        pending = pending.subarray(newlineIdx + 1);
        if (line) {
          if (queuedLines.length >= MAX_QUEUED_LINES) {
            this.writeResponse(client, {
              id: "overflow",
              ok: false,
              error: {
                code: "too_many_requests",
                message: "Vault Bridge client exceeded queued request limit.",
              },
            });
            client.end();
            return;
          }
          queuedLines.push(line);
        }
        newlineIdx = pending.indexOf(0x0a);
      }

      if (queuedLines.length > 0) {
        if (queuedLines.length >= 8) {
          client.pause();
        }
        void drainQueue();
      }
    });

    client.on("close", () => {
      this.activeClients.delete(client);
    });

    client.on("error", () => {
      this.activeClients.delete(client);
    });
  }

  private async processLine(client: net.Socket, line: string): Promise<"ok" | "bad_frame"> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.writeResponse(client, {
        id: "invalid",
        ok: false,
        error: { code: "invalid_json", message: "Request line must be valid JSON." },
      });
      return "bad_frame";
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.writeResponse(client, {
        id: "invalid",
        ok: false,
        error: { code: "invalid_json", message: "Request payload must be a JSON object." },
      });
      return "bad_frame";
    }
    const req = parsed as Partial<VaultBridgeRequest>;

    const reqId = typeof req.id === "string" ? req.id : "req";
    if (!this.verifyToken(req.token)) {
      this.writeResponse(client, {
        id: reqId,
        ok: false,
        error: { code: "unauthorized", message: "Invalid Vault Control Bridge token." },
      });
      return "bad_frame";
    }

    if (typeof req.method !== "string" || !req.method.trim()) {
      this.writeResponse(client, {
        id: reqId,
        ok: false,
        error: { code: "invalid_request", message: "Missing RPC method name." },
      });
      return "ok";
    }

    if (req.params !== undefined && (req.params === null || typeof req.params !== "object" || Array.isArray(req.params))) {
      this.writeResponse(client, {
        id: reqId,
        ok: false,
        error: { code: "invalid_params", message: "Request params must be a JSON object." },
      });
      return "ok";
    }

    try {
      const result = await this.dispatcher(
        req.method.trim(),
        req.params ?? {},
        typeof req.caller === "string" && req.caller.trim()
          ? req.caller.trim().slice(0, 64)
          : "herdr-agent",
        () => client.destroyed
      );
      this.writeResponse(client, { id: reqId, ok: true, result });
    } catch (err) {
      const code = err instanceof BridgeRpcError ? err.code : "bridge_error";
      const message = err instanceof Error ? err.message : String(err);
      this.writeResponse(client, {
        id: reqId,
        ok: false,
        error: { code, message },
      });
    }
    return "ok";
  }

  private verifyToken(candidate: unknown): boolean {
    if (typeof candidate !== "string" || candidate.length !== this.authToken.length) {
      return false;
    }
    const a = Buffer.from(candidate, "utf8");
    const b = Buffer.from(this.authToken, "utf8");
    if (a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }

  private writeResponse(client: net.Socket, response: VaultBridgeResponse): void {
    if (!client.destroyed && client.writable) {
      client.write(JSON.stringify(response) + "\n", "utf8");
    }
  }
}
