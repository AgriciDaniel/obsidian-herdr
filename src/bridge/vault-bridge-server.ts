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
  caller: string
) => Promise<unknown>;

const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/**
 * Local-only Unix domain socket / Windows named pipe RPC server for the Obsidian Vault Control Bridge.
 * Authenticates every request with a constant-time 256-bit bearer token check.
 */
export class VaultBridgeServer {
  private readonly socketPath: string;
  private readonly authToken: string;
  private readonly dispatcher: BridgeMethodDispatcher;
  private server: net.Server | null = null;
  private readonly activeClients = new Set<net.Socket>();
  private running = false;

  constructor(options: {
    socketPath: string;
    authToken?: string;
    dispatcher: BridgeMethodDispatcher;
  }) {
    this.socketPath = options.socketPath;
    this.authToken = options.authToken || crypto.randomBytes(32).toString("hex");
    this.dispatcher = options.dispatcher;
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
      try {
        if (fs.existsSync(this.socketPath)) {
          const st = fs.lstatSync(this.socketPath);
          if (st.isSocket()) {
            fs.unlinkSync(this.socketPath);
          }
        }
      } catch {
        // Ignore stale socket cleanup error
      }
    }

    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer((client) => {
        this.handleClient(client);
      });

      srv.once("error", (err) => {
        reject(err);
      });

      srv.listen(this.socketPath, () => {
        if (process.platform !== "win32") {
          try {
            fs.chmodSync(this.socketPath, 0o600);
          } catch {
            // Ignore chmod on unsupported fs
          }
        }
        this.server = srv;
        this.running = true;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.running = false;
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

    if (process.platform !== "win32") {
      try {
        if (fs.existsSync(this.socketPath) && fs.lstatSync(this.socketPath).isSocket()) {
          fs.unlinkSync(this.socketPath);
        }
      } catch {
        // Ignore cleanup failure
      }
    }
  }

  private handleClient(client: net.Socket): void {
    this.activeClients.add(client);
    let buffer = "";

    client.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_FRAME_BYTES) {
        this.writeResponse(client, {
          id: "overflow",
          ok: false,
          error: {
            code: "payload_too_large",
            message: "Vault Bridge request exceeded 2 MiB frame limit.",
          },
        });
        client.destroy();
        return;
      }

      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          void this.processLine(client, line);
        }
        newlineIdx = buffer.indexOf("\n");
      }
    });

    client.on("close", () => {
      this.activeClients.delete(client);
    });

    client.on("error", () => {
      this.activeClients.delete(client);
    });
  }

  private async processLine(client: net.Socket, line: string): Promise<void> {
    let req: VaultBridgeRequest;
    try {
      req = JSON.parse(line) as VaultBridgeRequest;
    } catch {
      this.writeResponse(client, {
        id: "invalid",
        ok: false,
        error: { code: "invalid_json", message: "Request line must be valid JSON." },
      });
      return;
    }

    const reqId = typeof req.id === "string" ? req.id : "req";
    if (!this.verifyToken(req.token)) {
      this.writeResponse(client, {
        id: reqId,
        ok: false,
        error: { code: "unauthorized", message: "Invalid Vault Control Bridge token." },
      });
      return;
    }

    if (typeof req.method !== "string" || !req.method.trim()) {
      this.writeResponse(client, {
        id: reqId,
        ok: false,
        error: { code: "invalid_request", message: "Missing RPC method name." },
      });
      return;
    }

    try {
      const result = await this.dispatcher(
        req.method.trim(),
        req.params && typeof req.params === "object" ? req.params : {},
        typeof req.caller === "string" && req.caller.trim()
          ? req.caller.trim().slice(0, 64)
          : "herdr-agent"
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
