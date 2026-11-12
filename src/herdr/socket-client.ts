import * as net from "node:net";
import * as fs from "node:fs";
import type {
  AgentInfo,
  AgentStatus,
  HerdrLayoutDescription,
  HerdrLayoutNode,
  InstalledHerdrPlugin,
  PaneInfo,
  ReadSource,
  SessionSnapshot,
  SplitDirection,
  TabInfo,
  WorkspaceInfo,
  WorktreeRecord,
} from "../domain/types";

/**
 * Herdr 0.9.5 uses interprocess 2.4.4 GenericNamespaced on Windows:
 * the namespace prefix is prepended to the exact logical socket path.
 * The on-disk .sock file is only a server identity marker, not a socket.
 * Do not normalize slashes/case or read the marker as an endpoint.
 */
export function resolveHerdrSocketEndpoint(
  socketPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (!socketPath || platform !== "win32" || /^\\\\[.?]\\pipe\\/i.test(socketPath)) {
    return socketPath;
  }
  return "\\\\.\\pipe\\" + socketPath;
}

export function isHerdrSocketPresent(
  socketPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!socketPath) return false;
  if (platform === "win32" && /^\\\\[.?]\\pipe\\/i.test(socketPath)) return true;
  try {
    const stat = fs.statSync(socketPath);
    // Presence is a discovery hint only; successful RPC establishes liveness.
    return platform === "win32" ? stat.isFile() : stat.isSocket();
  } catch {
    return false;
  }
}

export interface HerdrRpcErrorBody {
  code?: string;
  message?: string;
  details?: unknown;
}

export class HerdrSocketError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrSocketError";
    this.code = code;
  }
}

export interface HerdrEventNotification {
  event: string;
  data: Record<string, unknown>;
}

const DEFAULT_SUBSCRIPTIONS = [
  { type: "workspace.created" },
  { type: "workspace.updated" },
  { type: "workspace.renamed" },
  { type: "workspace.closed" },
  { type: "workspace.focused" },
  { type: "worktree.created" },
  { type: "worktree.opened" },
  { type: "worktree.removed" },
  { type: "tab.created" },
  { type: "tab.closed" },
  { type: "tab.focused" },
  { type: "tab.renamed" },
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.updated" },
  { type: "pane.focused" },
  { type: "pane.moved" },
  { type: "pane.exited" },
  { type: "pane.agent_detected" },
  { type: "layout.updated" },
];

/**
 * Newline-delimited JSON client for Herdr's local Unix socket / Windows named pipe API.
 */
export class HerdrSocketClient {
  private socketPath: string;
  private reqSeq = 0;
  private subSocket: net.Socket | null = null;
  private subBuffer = "";
  private disposed = false;
  private reconnectTimer: number | null = null;
  private readonly eventListeners = new Set<(ev: HerdrEventNotification) => void>();
  private readonly stateListeners = new Set<(connected: boolean) => void>();
  private connected = false;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  setSocketPath(nextPath: string): void {
    if (this.socketPath === nextPath) {
      return;
    }
    this.socketPath = nextPath;
    if (this.subSocket) {
      this.stopSubscription();
      this.startSubscription();
    }
  }

  isSubscribed(): boolean {
    return this.connected;
  }

  getConnectionPath(): string {
    return resolveHerdrSocketEndpoint(this.socketPath);
  }

  isSocketPresent(): boolean {
    return isHerdrSocketPresent(this.socketPath);
  }

  onEvent(listener: (ev: HerdrEventNotification) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onConnectionState(listener: (connected: boolean) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /**
   * Sends a single request over a short-lived socket connection and resolves its typed result.
   */
  request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 8000
  ): Promise<T> {
    if (!this.socketPath) {
      return Promise.reject(
        new HerdrSocketError("no_socket_path", "No Herdr socket path is configured.")
      );
    }

    const reqId = `obs_${Date.now()}_${(this.reqSeq += 1)}`;
    const payload = JSON.stringify({ id: reqId, method, params }) + "\n";

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let buffer = "";

      const socket = net.createConnection({ path: this.getConnectionPath() });
      const timer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(
            new HerdrSocketError(
              "socket_timeout",
              `Herdr request '${method}' timed out after ${timeoutMs}ms.`
            )
          );
        }
      }, timeoutMs);

      const finish = (err: Error | null, value?: T) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        socket.end();
        socket.destroy();
        if (err) {
          reject(err);
        } else {
          resolve(value as T);
        }
      };

      socket.on("connect", () => {
        socket.write(payload, "utf8");
      });

      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let newlineIdx = buffer.indexOf("\n");
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line) {
            try {
              const parsed = JSON.parse(line) as {
                id?: string;
                result?: T;
                error?: HerdrRpcErrorBody;
              };
              if (parsed.id === reqId) {
                if (parsed.error) {
                  finish(
                    new HerdrSocketError(
                      parsed.error.code || "rpc_error",
                      parsed.error.message || `Herdr rejected '${method}'.`
                    )
                  );
                } else {
                  finish(null, parsed.result);
                }
                return;
              }
            } catch (parseErr) {
              finish(
                new HerdrSocketError(
                  "invalid_json",
                  `Malformed JSON from Herdr socket: ${String(parseErr)}`
                )
              );
              return;
            }
          }
          newlineIdx = buffer.indexOf("\n");
        }
      });

      socket.on("error", (err: NodeJS.ErrnoException) => {
        finish(
          new HerdrSocketError(
            err.code || "socket_error",
            `Could not connect to Herdr endpoint (${this.getConnectionPath()}): ${err.message}`
          )
        );
      });

      socket.on("close", () => {
        if (!settled) {
          finish(
            new HerdrSocketError(
              "socket_closed",
              `Herdr socket closed before answering '${method}'.`
            )
          );
        }
      });
    });
  }

  async ping(): Promise<{ version: string; protocol: number }> {
    const res = await this.request<{ version: string; protocol: number }>("ping", {}, 3000);
    return { version: res.version, protocol: res.protocol };
  }

  async stopServer(): Promise<void> {
    await this.request("server.stop", {}, 5000);
  }

  async getSnapshot(): Promise<SessionSnapshot> {
    const res = await this.request<{ snapshot: SessionSnapshot }>("session.snapshot", {});
    return res.snapshot;
  }

  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    const res = await this.request<{ workspaces: WorkspaceInfo[] }>("workspace.list", {});
    return res.workspaces ?? [];
  }

  async createWorkspace(options: {
    label?: string;
    cwd?: string;
    focus?: boolean;
    env?: Record<string, string>;
  }): Promise<{ workspace: WorkspaceInfo; tab: TabInfo; root_pane: PaneInfo }> {
    return this.request("workspace.create", {
      label: options.label ?? null,
      cwd: options.cwd ?? null,
      focus: options.focus ?? true,
      ...(options.env ? { env: options.env } : {}),
    });
  }

  async focusWorkspace(workspaceId: string): Promise<void> {
    await this.request("workspace.focus", { workspace_id: workspaceId });
  }

  async renameWorkspace(workspaceId: string, label: string): Promise<void> {
    await this.request("workspace.rename", { workspace_id: workspaceId, label });
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    await this.request("workspace.close", { workspace_id: workspaceId });
  }

  async reportWorkspaceMetadata(
    workspaceId: string,
    tokens: Record<string, string | null>,
    ttlMs = 120000
  ): Promise<void> {
    await this.request("workspace.report_metadata", {
      workspace_id: workspaceId,
      source: "user:obsidian-herdr",
      tokens,
      ttl_ms: ttlMs,
    });
  }

  async listWorktrees(workspaceId?: string, cwd?: string): Promise<WorktreeRecord[]> {
    const params: Record<string, unknown> = {};
    if (workspaceId) {
      params.workspace_id = workspaceId;
    } else if (cwd) {
      params.cwd = cwd;
    }
    const res = await this.request<{ worktrees: WorktreeRecord[] }>("worktree.list", params);
    return res.worktrees ?? [];
  }

  async createWorktree(options: {
    branch: string;
    workspaceId?: string;
    cwd?: string;
    focus?: boolean;
  }): Promise<{ workspace: WorkspaceInfo; tab: TabInfo; root_pane: PaneInfo }> {
    const params: Record<string, unknown> = {
      branch: options.branch,
      focus: options.focus ?? true,
    };
    if (options.workspaceId) {
      params.workspace_id = options.workspaceId;
    } else if (options.cwd) {
      params.cwd = options.cwd;
    }
    return this.request("worktree.create", params, 15000);
  }

  async openWorktree(options: {
    path?: string;
    branch?: string;
    cwd?: string;
    workspaceId?: string;
    label?: string;
    focus?: boolean;
  }): Promise<{ workspace: WorkspaceInfo; tab: TabInfo; root_pane: PaneInfo }> {
    return this.request(
      "worktree.open",
      {
        path: options.path ?? null,
        branch: options.branch ?? null,
        cwd: options.cwd ?? null,
        workspace_id: options.workspaceId ?? null,
        label: options.label ?? null,
        focus: options.focus ?? true,
      },
      15000
    );
  }

  async removeWorktree(workspaceId: string, force = false): Promise<void> {
    await this.request("worktree.remove", { workspace_id: workspaceId, force }, 15000);
  }

  async exportLayout(options?: {
    tabId?: string;
    paneId?: string;
  }): Promise<HerdrLayoutDescription> {
    const res = await this.request<{ layout: HerdrLayoutDescription }>("layout.export", {
      tab_id: options?.tabId ?? null,
      pane_id: options?.paneId ?? null,
    });
    return res.layout;
  }

  async applyLayout(options: {
    root: HerdrLayoutNode;
    workspaceId?: string;
    tabId?: string;
    tabLabel?: string;
    focus?: boolean;
  }): Promise<HerdrLayoutDescription> {
    const res = await this.request<{ layout: HerdrLayoutDescription }>("layout.apply", {
      root: options.root,
      workspace_id: options.workspaceId ?? null,
      tab_id: options.tabId ?? null,
      tab_label: options.tabLabel ?? null,
      focus: options.focus ?? true,
    });
    return res.layout;
  }

  async createTab(options: {
    workspaceId?: string;
    label?: string;
    cwd?: string;
    focus?: boolean;
    env?: Record<string, string>;
  }): Promise<{ tab: TabInfo; root_pane: PaneInfo }> {
    return this.request("tab.create", {
      workspace_id: options.workspaceId ?? null,
      label: options.label ?? null,
      cwd: options.cwd ?? null,
      focus: options.focus ?? true,
      ...(options.env ? { env: options.env } : {}),
    });
  }

  async focusTab(tabId: string): Promise<void> {
    await this.request("tab.focus", { tab_id: tabId });
  }

  async renameTab(tabId: string, label: string): Promise<void> {
    await this.request("tab.rename", { tab_id: tabId, label });
  }

  async closeTab(tabId: string): Promise<void> {
    await this.request("tab.close", { tab_id: tabId });
  }

  async splitPane(options: {
    targetPaneId?: string;
    workspaceId?: string;
    direction: SplitDirection;
    cwd?: string;
    focus?: boolean;
    ratio?: number;
    env?: Record<string, string>;
  }): Promise<PaneInfo> {
    const res = await this.request<{ pane: PaneInfo }>("pane.split", {
      target_pane_id: options.targetPaneId ?? null,
      workspace_id: options.workspaceId ?? null,
      direction: options.direction,
      cwd: options.cwd ?? null,
      focus: options.focus ?? false,
      ratio: options.ratio ?? null,
      ...(options.env ? { env: options.env } : {}),
    });
    return res.pane;
  }

  async focusPane(paneId: string): Promise<void> {
    await this.request("pane.focus", { pane_id: paneId });
  }

  async zoomPane(paneId: string, mode: "toggle" | "on" | "off" = "toggle"): Promise<void> {
    await this.request("pane.zoom", { pane_id: paneId, mode });
  }

  async closePane(paneId: string): Promise<void> {
    await this.request("pane.close", { pane_id: paneId });
  }

  async sendPaneText(paneId: string, text: string): Promise<void> {
    await this.request("pane.send_text", { pane_id: paneId, text });
  }

  async sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    await this.request("pane.send_keys", { pane_id: paneId, keys });
  }

  async readPane(
    paneId: string,
    source: ReadSource = "recent_unwrapped",
    lines = 80
  ): Promise<string> {
    const res = await this.request<{ read: { text: string } }>("pane.read", {
      pane_id: paneId,
      source,
      lines,
      format: "text",
      strip_ansi: true,
    });
    return res.read?.text ?? "";
  }

  async listAgents(): Promise<AgentInfo[]> {
    const res = await this.request<{ agents: AgentInfo[] }>("agent.list", {});
    return res.agents ?? [];
  }

  async getAgent(target: string): Promise<AgentInfo> {
    const res = await this.request<{ agent: AgentInfo }>("agent.get", { target });
    return res.agent;
  }

  async readAgent(
    target: string,
    source: ReadSource = "recent_unwrapped",
    lines = 80
  ): Promise<string> {
    const res = await this.request<{ read: { text: string } }>("agent.read", {
      target,
      source,
      lines,
      format: "text",
      strip_ansi: true,
    });
    return res.read?.text ?? "";
  }

  async startAgent(options: {
    name: string;
    kind: string;
    paneId: string;
    args?: string[];
    timeoutMs?: number;
  }): Promise<AgentInfo> {
    const budgetMs = options.timeoutMs ?? 30000;
    const res = await this.request<{ agent: AgentInfo }>(
      "agent.start",
      {
        name: options.name,
        kind: options.kind,
        pane_id: options.paneId,
        args: options.args ?? [],
        timeout_ms: budgetMs,
      },
      budgetMs + 4000
    );

    let latest = res.agent;
    if (latest.interactive_ready || latest.agent_status === "blocked") {
      return latest;
    }

    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      await new Promise((r) => window.setTimeout(r, 180));
      try {
        latest = await this.getAgent(options.name);
      } catch (err) {
        const tail = await this.readPane(options.paneId, "recent_unwrapped", 10).catch(() => "");
        const msg = err instanceof Error ? err.message : String(err);
        throw new HerdrSocketError(
          "agent_start_failed",
          `Agent '${options.kind}' (${options.name}) did not stay active in ${options.paneId}: ${msg}${tail.trim() ? ` | ${tail.trim()}` : ""}`
        );
      }

      if (latest.interactive_ready || latest.agent_status === "blocked") {
        return latest;
      }

      if (!latest.launch_pending && latest.agent !== options.kind) {
        const tail = await this.readPane(options.paneId, "recent_unwrapped", 10).catch(() => "");
        throw new HerdrSocketError(
          "agent_start_failed",
          `Agent '${options.kind}' failed to start in ${options.paneId}.${tail.trim() ? ` Output: ${tail.trim()}` : ""}`
        );
      }
    }

    return latest;
  }

  async promptAgent(
    target: string,
    text: string,
    waitOptions?: { until?: AgentStatus[]; timeout_ms?: number } | null
  ): Promise<AgentInfo> {
    const timeoutBudget = waitOptions?.timeout_ms ? waitOptions.timeout_ms + 5000 : 12000;
    try {
      const res = await this.request<{ agent: AgentInfo }>(
        "agent.prompt",
        {
          target,
          text,
          wait: waitOptions ?? null,
        },
        timeoutBudget
      );
      return res.agent;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not an active named agent/i.test(msg) && /^w\d+:p\d+$/.test(target)) {
        await this.sendPaneText(target, text);
        await this.sendPaneKeys(target, ["enter"]);
        const agents = await this.listAgents();
        const matched = agents.find((a) => a.pane_id === target);
        if (matched) {
          return matched;
        }
      }
      throw err;
    }
  }

  async sendAgentKeys(target: string, keys: string[]): Promise<void> {
    await this.request("agent.send_keys", { target, keys });
  }

  async focusAgent(target: string): Promise<void> {
    await this.request("agent.focus", { target });
  }

  async explainAgent(target: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("agent.explain", { target });
  }

  async setAgentView(options: {
    source: string;
    label?: string;
    filter?: Record<string, unknown> | null;
    sort?: Array<Record<string, unknown>>;
  }): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("agent.view.set", {
      source: options.source,
      label: options.label ?? null,
      filter: options.filter ?? null,
      ...(options.sort ? { sort: options.sort } : {}),
    });
  }

  async clearAgentView(source?: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("agent.view.clear", {
      source: source ?? null,
    });
  }

  async showNotification(
    title: string,
    body?: string,
    sound: "none" | "done" | "request" = "none"
  ): Promise<boolean> {
    const res = await this.request<{ shown: boolean }>("notification.show", {
      title: title.slice(0, 80),
      body: body ? body.slice(0, 240) : null,
      sound,
    });
    return Boolean(res.shown);
  }

  async listPlugins(): Promise<InstalledHerdrPlugin[]> {
    const res = await this.request<{ plugins: InstalledHerdrPlugin[] }>("plugin.list", {});
    return res.plugins ?? [];
  }

  async linkPlugin(manifestOrDirPath: string, enabled = true): Promise<InstalledHerdrPlugin> {
    const res = await this.request<{ plugin: InstalledHerdrPlugin }>("plugin.link", {
      path: manifestOrDirPath,
      enabled,
    });
    return res.plugin;
  }

  async unlinkPlugin(pluginId: string): Promise<boolean> {
    const res = await this.request<{ removed: boolean }>("plugin.unlink", {
      plugin_id: pluginId,
    });
    return Boolean(res.removed);
  }

  startSubscription(): void {
    if (this.disposed || this.subSocket || !this.socketPath) {
      return;
    }

    const sock = net.createConnection({ path: this.getConnectionPath() });
    this.subSocket = sock;
    this.subBuffer = "";

    sock.on("connect", () => {
      const subId = `sub_${Date.now()}`;
      const subReq =
        JSON.stringify({
          id: subId,
          method: "events.subscribe",
          params: { subscriptions: DEFAULT_SUBSCRIPTIONS },
        }) + "\n";
      sock.write(subReq, "utf8");
      this.setConnected(true);
    });

    sock.on("data", (chunk: Buffer) => {
      this.subBuffer += chunk.toString("utf8");
      if (this.subBuffer.length > 512 * 1024) {
        this.subBuffer = "";
      }
      let idx = this.subBuffer.indexOf("\n");
      while (idx !== -1) {
        const line = this.subBuffer.slice(0, idx).trim();
        this.subBuffer = this.subBuffer.slice(idx + 1);
        if (line) {
          try {
            const msg = JSON.parse(line) as {
              event?: string;
              data?: Record<string, unknown>;
            };
            if (typeof msg.event === "string") {
              const ev: HerdrEventNotification = {
                event: msg.event,
                data: msg.data ?? {},
              };
              for (const listener of this.eventListeners) {
                listener(ev);
              }
            }
          } catch {
            // Ignore malformed frame
          }
        }
        idx = this.subBuffer.indexOf("\n");
      }
    });

    sock.on("error", () => {
      this.setConnected(false);
    });

    sock.on("close", () => {
      if (this.subSocket === sock) {
        this.subSocket = null;
      }
      this.setConnected(false);
      this.scheduleReconnect();
    });
  }

  stopSubscription(): void {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.subSocket) {
      const sock = this.subSocket;
      this.subSocket = null;
      sock.removeAllListeners();
      sock.destroy();
    }
    this.setConnected(false);
  }

  dispose(): void {
    this.disposed = true;
    this.stopSubscription();
    this.eventListeners.clear();
    this.stateListeners.clear();
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) {
      return;
    }
    this.connected = value;
    for (const listener of this.stateListeners) {
      listener(value);
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed) {
        this.startSubscription();
      }
    }, 3500);
  }
}
