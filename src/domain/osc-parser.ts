import type { AgentStatus, Osc7501Status } from "./types";

export interface OscStreamEvents {
  onTitle?: (title: string) => void;
  onCwd?: (cwd: string) => void;
  onProgramStatus?: (status: Osc7501Status) => void;
}

const VALID_STATES = new Set<AgentStatus>(["idle", "working", "blocked", "done", "unknown"]);

/**
 * Non-destructive streaming parser for terminal OSC sequences:
 * - OSC 0 / OSC 2: window and icon title
 * - OSC 7: current working directory (file://hostname/path)
 * - OSC 7501: Program Status Protocol (key=value;... or bare state)
 *
 * Raw bytes are never modified; callers pass decoded chunks for metadata observation.
 */
export class OscStreamObserver {
  private buffer = "";
  private readonly handlers: OscStreamEvents;

  constructor(handlers: OscStreamEvents) {
    this.handlers = handlers;
  }

  feed(chunk: string): void {
    if (!chunk) {
      return;
    }
    if (!this.buffer && !chunk.includes("\x1b]")) {
      return;
    }
    this.buffer += chunk;
    if (this.buffer.length > 16384) {
      this.buffer = this.buffer.slice(-4096);
    }

    let searchFrom = 0;
    while (searchFrom < this.buffer.length) {
      const start = this.buffer.indexOf("\x1b]", searchFrom);
      if (start === -1) {
        this.buffer = "";
        return;
      }

      const belEnd = this.buffer.indexOf("\x07", start + 2);
      const stEnd = this.buffer.indexOf("\x1b\\", start + 2);
      let endIdx = -1;
      let terminatorLen = 1;

      if (belEnd !== -1 && (stEnd === -1 || belEnd < stEnd)) {
        endIdx = belEnd;
        terminatorLen = 1;
      } else if (stEnd !== -1) {
        endIdx = stEnd;
        terminatorLen = 2;
      }

      if (endIdx === -1) {
        this.buffer = this.buffer.slice(start);
        return;
      }

      const payload = this.buffer.slice(start + 2, endIdx);
      this.dispatchOsc(payload);
      searchFrom = endIdx + terminatorLen;
    }

    this.buffer = "";
  }

  private dispatchOsc(payload: string): void {
    const semi = payload.indexOf(";");
    if (semi === -1) {
      return;
    }
    const code = payload.slice(0, semi).trim();
    const body = payload.slice(semi + 1);

    if (code === "0" || code === "2") {
      const sanitized = this.sanitizeControlChars(body).slice(0, 200);
      if (sanitized) {
        this.handlers.onTitle?.(sanitized);
      }
      return;
    }

    if (code === "7") {
      const parsedCwd = parseOsc7Path(body);
      if (parsedCwd) {
        this.handlers.onCwd?.(parsedCwd);
      }
      return;
    }

    if (code === "7501") {
      const status = parseOsc7501(body);
      if (status) {
        this.handlers.onProgramStatus?.(status);
      }
    }
  }

  private sanitizeControlChars(text: string): string {
    let out = "";
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charCodeAt(i);
      if (ch >= 32 && ch !== 127) {
        out += text[i];
      }
    }
    return out.trim();
  }
}

export function parseOsc7Path(uri: string): string | null {
  const trimmed = uri.trim();
  if (!trimmed.startsWith("file://")) {
    return null;
  }
  const rest = trimmed.slice("file://".length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) {
    return null;
  }
  const rawPath = rest.slice(slashIdx);
  try {
    const decoded = decodeURIComponent(rawPath);
    if (/^\/[A-Za-z]:\//.test(decoded)) {
      return decoded.slice(1);
    }
    return decoded;
  } catch {
    return rawPath;
  }
}

export function parseOsc7501(body: string): Osc7501Status | null {
  const trimmed = body.trim();
  if (!trimmed) {
    return null;
  }

  // Support JSON or semicolon key=value or bare state keyword
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const rawField =
        typeof parsed.state === "string"
          ? parsed.state
          : typeof parsed.status === "string"
            ? parsed.status
            : "";
      const rawState = rawField.toLowerCase();
      const mapped = normalizeOscState(rawState);
      if (!mapped) {
        return null;
      }
      const progress =
        typeof parsed.progress === "number" && Number.isFinite(parsed.progress)
          ? Math.max(0, Math.min(100, parsed.progress))
          : null;
      const message = typeof parsed.message === "string" ? parsed.message.slice(0, 200) : null;
      return { state: mapped, progress, message, updatedAt: Date.now() };
    } catch {
      return null;
    }
  }

  const parts = trimmed.split(";");
  let state: AgentStatus | null = null;
  let progress: number | null = null;
  let message: string | null = null;

  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      const candidate = normalizeOscState(part.trim().toLowerCase());
      if (candidate && !state) {
        state = candidate;
      }
      continue;
    }
    const key = part.slice(0, eq).trim().toLowerCase();
    const val = part.slice(eq + 1).trim();
    if (key === "state" || key === "status") {
      state = normalizeOscState(val.toLowerCase());
    } else if (key === "progress") {
      const num = Number(val);
      if (Number.isFinite(num)) {
        progress = Math.max(0, Math.min(100, num));
      }
    } else if (key === "message" || key === "msg" || key === "label") {
      try {
        message = decodeURIComponent(val).slice(0, 200);
      } catch {
        message = val.slice(0, 200);
      }
    }
  }

  if (!state) {
    return null;
  }
  return { state, progress, message, updatedAt: Date.now() };
}

function normalizeOscState(raw: string): AgentStatus | null {
  if (VALID_STATES.has(raw as AgentStatus)) {
    return raw as AgentStatus;
  }
  if (raw === "running" || raw === "busy" || raw === "active") {
    return "working";
  }
  if (raw === "waiting" || raw === "input" || raw === "approval" || raw === "error") {
    return "blocked";
  }
  if (raw === "ready" || raw === "clear" || raw === "none") {
    return "idle";
  }
  if (raw === "complete" || raw === "completed" || raw === "success") {
    return "done";
  }
  return null;
}
