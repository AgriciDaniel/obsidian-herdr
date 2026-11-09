export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type SplitDirection = "right" | "down";

export type PaneDirection = "left" | "right" | "up" | "down";

export type ReadSource = "visible" | "recent" | "recent_unwrapped" | "detection";

export type VaultPermissionMode = "off" | "read-only" | "read-write" | "full";

export type TerminalProfileKind =
  | "herdr-vault"
  | "herdr-agent"
  | "herdr-remote"
  | "shell";

export interface TerminalProfile {
  id: string;
  name: string;
  kind: TerminalProfileKind;
  sessionName?: string;
  remoteTarget?: string;
  agentTarget?: string;
  shellPath?: string;
  shellArgs?: string[];
  cwdMode: "vault-root" | "active-note-folder" | "custom";
  customCwd?: string;
}

export interface AgentSessionInfo {
  source: string;
  agent: string;
  kind: "id" | "path";
  value: string;
}

export interface PaneScrollInfo {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
}

export interface WorkspaceWorktreeInfo {
  repo_key: string;
  repo_name: string;
  repo_root: string;
  checkout_path: string;
  is_linked_worktree: boolean;
}

export interface WorkspaceInfo {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
  tokens?: Record<string, string>;
  worktree?: WorkspaceWorktreeInfo | null;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
}

export interface PaneInfo {
  pane_id: string;
  workspace_id?: string;
  tab_id?: string;
  label?: string | null;
  focused: boolean;
  cwd?: string | null;
  foreground_cwd?: string | null;
  agent?: string | null;
  display_agent?: string | null;
  agent_status: AgentStatus;
  agent_session?: AgentSessionInfo | null;
  revision: number;
  scroll?: PaneScrollInfo | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  tokens?: Record<string, string>;
  state_labels?: Record<string, string>;
}

export interface AgentInfo {
  pane_id: string;
  workspace_id?: string;
  tab_id?: string;
  name?: string | null;
  agent?: string | null;
  display_agent?: string | null;
  agent_status: AgentStatus;
  agent_session?: AgentSessionInfo | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  focused: boolean;
  interactive_ready: boolean;
  launch_pending: boolean;
  revision: number;
  state_change_seq: number;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  tokens?: Record<string, string>;
}

export interface PaneLayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneLayoutPane {
  pane_id: string;
  focused: boolean;
  rect: PaneLayoutRect;
}

export interface PaneLayoutSplit {
  id: string;
  direction: SplitDirection;
  ratio: number;
  rect: PaneLayoutRect;
}

export interface PaneLayoutSnapshot {
  workspace_id: string;
  tab_id: string;
  zoomed: boolean;
  area: PaneLayoutRect;
  focused_pane_id: string;
  panes: PaneLayoutPane[];
  splits: PaneLayoutSplit[];
}

export interface SessionSnapshot {
  version: string;
  protocol: number;
  focused_workspace_id: string | null;
  focused_tab_id: string | null;
  focused_pane_id: string | null;
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  layouts: PaneLayoutSnapshot[];
  agents: AgentInfo[];
}

export interface HerdrNamedSession {
  name: string;
  status: string;
  directory: string;
  socket: string;
}

export interface HerdrStatusPayload {
  client: {
    version: string | null;
    channel: string | null;
    protocol: number | null;
    binary: string | null;
    session: string | null;
  };
  server: {
    status: string;
    running: boolean;
    version: string | null;
    protocol: number | null;
    socket: string | null;
    session: string | null;
    restart_needed: boolean;
  };
}

export interface HerdrIntegrationRow {
  target: string;
  installed: boolean;
  path: string;
}

export interface InstalledHerdrPlugin {
  plugin_id: string;
  id?: string;
  name: string;
  version?: string;
  enabled: boolean;
  manifest_path: string;
  plugin_root?: string;
  description?: string | null;
  warnings?: string[];
}

export interface WorktreeRecord {
  workspace_id?: string | null;
  open_workspace_id?: string | null;
  label?: string;
  branch?: string | null;
  path: string;
  is_main?: boolean;
  is_linked_worktree?: boolean;
  repo_root?: string;
}

export type HerdrLayoutNode =
  | {
      type: "pane";
      pane_id?: string | null;
      label?: string | null;
      cwd?: string | null;
      command?: string[] | null;
      env?: Record<string, string>;
    }
  | {
      type: "split";
      direction: SplitDirection;
      ratio: number;
      first: HerdrLayoutNode;
      second: HerdrLayoutNode;
    };

export interface HerdrLayoutDescription {
  workspace_id: string;
  tab_id: string;
  zoomed: boolean;
  focused_pane_id: string;
  root: HerdrLayoutNode;
}

export interface Osc7501Status {
  state: AgentStatus;
  progress?: number | null;
  message?: string | null;
  updatedAt: number;
}

export interface VaultBridgeRequest {
  id: string;
  token: string;
  method: string;
  params?: Record<string, unknown>;
  caller?: string;
}

export interface VaultBridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface VaultMutationSnapshot {
  kind: "created" | "modified" | "renamed";
  path: string;
  previousPath?: string;
  previousContent?: string;
}

export interface VaultAuditEntry {
  id: string;
  timestamp: number;
  method: string;
  caller: string;
  targetPath?: string;
  allowed: boolean;
  summary: string;
  snapshot?: VaultMutationSnapshot;
  undone?: boolean;
}

export interface HerdrPluginSettings {
  schemaVersion: number;
  herdrBinaryPath: string;
  defaultSessionName: string;
  customSocketPath: string;
  autoConnectSocket: boolean;
  autoReportVaultMetadata: boolean;
  notifyOnAgentBlocked: boolean;
  notifyOnAgentDone: boolean;
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalScrollback: number;
  terminalCursorBlink: boolean;
  defaultProfileId: string;
  profiles: TerminalProfile[];
  vaultBridgeEnabled: boolean;
  vaultPermissionMode: VaultPermissionMode;
  allowHiddenConfigReads: boolean;
  allowUiControl: boolean;
  defaultAgentKind: string;
  showOfflinePreviewWhenStopped: boolean;
}

export const DEFAULT_PROFILES: TerminalProfile[] = [
  {
    id: "herdr-vault",
    name: "Herdr vault session",
    kind: "herdr-vault",
    cwdMode: "vault-root",
  },
  {
    id: "shell-vault",
    name: "Interactive shell (vault root)",
    kind: "shell",
    cwdMode: "vault-root",
  },
  {
    id: "shell-note",
    name: "Interactive shell (active note folder)",
    kind: "shell",
    cwdMode: "active-note-folder",
  },
];

export const DEFAULT_SETTINGS: HerdrPluginSettings = {
  schemaVersion: 1,
  herdrBinaryPath: "",
  defaultSessionName: "",
  customSocketPath: "",
  autoConnectSocket: true,
  autoReportVaultMetadata: true,
  notifyOnAgentBlocked: true,
  notifyOnAgentDone: false,
  terminalFontFamily: "",
  terminalFontSize: 13,
  terminalScrollback: 5000,
  terminalCursorBlink: true,
  defaultProfileId: "herdr-vault",
  profiles: DEFAULT_PROFILES,
  vaultBridgeEnabled: true,
  vaultPermissionMode: "read-write",
  allowHiddenConfigReads: false,
  allowUiControl: false,
  defaultAgentKind: "claude",
  showOfflinePreviewWhenStopped: true,
};

export function migrateSettings(raw: unknown): HerdrPluginSettings {
  if (!raw || typeof raw !== "object") {
    return {
      ...DEFAULT_SETTINGS,
      profiles: DEFAULT_PROFILES.map((p) => ({ ...p })),
    };
  }
  const src = raw as Partial<HerdrPluginSettings>;
  const validModes: VaultPermissionMode[] = ["off", "read-only", "read-write", "full"];
  const mode: VaultPermissionMode =
    typeof src.vaultPermissionMode === "string" &&
    validModes.includes(src.vaultPermissionMode)
      ? src.vaultPermissionMode
      : DEFAULT_SETTINGS.vaultPermissionMode;

  const fontSize =
    typeof src.terminalFontSize === "number" && Number.isFinite(src.terminalFontSize)
      ? Math.min(28, Math.max(9, Math.round(src.terminalFontSize)))
      : DEFAULT_SETTINGS.terminalFontSize;

  const scrollback =
    typeof src.terminalScrollback === "number" && Number.isFinite(src.terminalScrollback)
      ? Math.min(50000, Math.max(500, Math.round(src.terminalScrollback)))
      : DEFAULT_SETTINGS.terminalScrollback;

  const profiles =
    Array.isArray(src.profiles) && src.profiles.length > 0
      ? src.profiles.filter(
          (p): p is TerminalProfile =>
            Boolean(p) &&
            typeof p.id === "string" &&
            typeof p.name === "string" &&
            typeof p.kind === "string"
        )
      : DEFAULT_PROFILES.map((p) => ({ ...p }));

  return {
    schemaVersion: 1,
    herdrBinaryPath: typeof src.herdrBinaryPath === "string" ? src.herdrBinaryPath.trim() : "",
    defaultSessionName:
      typeof src.defaultSessionName === "string" ? src.defaultSessionName.trim() : "",
    customSocketPath:
      typeof src.customSocketPath === "string" ? src.customSocketPath.trim() : "",
    autoConnectSocket:
      typeof src.autoConnectSocket === "boolean"
        ? src.autoConnectSocket
        : DEFAULT_SETTINGS.autoConnectSocket,
    autoReportVaultMetadata:
      typeof src.autoReportVaultMetadata === "boolean"
        ? src.autoReportVaultMetadata
        : DEFAULT_SETTINGS.autoReportVaultMetadata,
    notifyOnAgentBlocked:
      typeof src.notifyOnAgentBlocked === "boolean"
        ? src.notifyOnAgentBlocked
        : DEFAULT_SETTINGS.notifyOnAgentBlocked,
    notifyOnAgentDone:
      typeof src.notifyOnAgentDone === "boolean"
        ? src.notifyOnAgentDone
        : DEFAULT_SETTINGS.notifyOnAgentDone,
    terminalFontFamily:
      typeof src.terminalFontFamily === "string" ? src.terminalFontFamily.trim() : "",
    terminalFontSize: fontSize,
    terminalScrollback: scrollback,
    terminalCursorBlink:
      typeof src.terminalCursorBlink === "boolean"
        ? src.terminalCursorBlink
        : DEFAULT_SETTINGS.terminalCursorBlink,
    defaultProfileId:
      typeof src.defaultProfileId === "string" && src.defaultProfileId
        ? src.defaultProfileId
        : DEFAULT_SETTINGS.defaultProfileId,
    profiles: profiles.length > 0 ? profiles : DEFAULT_PROFILES.map((p) => ({ ...p })),
    vaultBridgeEnabled:
      typeof src.vaultBridgeEnabled === "boolean"
        ? src.vaultBridgeEnabled
        : DEFAULT_SETTINGS.vaultBridgeEnabled,
    vaultPermissionMode: mode,
    allowHiddenConfigReads:
      typeof src.allowHiddenConfigReads === "boolean"
        ? src.allowHiddenConfigReads
        : DEFAULT_SETTINGS.allowHiddenConfigReads,
    allowUiControl:
      typeof src.allowUiControl === "boolean"
        ? src.allowUiControl
        : DEFAULT_SETTINGS.allowUiControl,
    defaultAgentKind:
      typeof src.defaultAgentKind === "string" && src.defaultAgentKind.trim()
        ? src.defaultAgentKind.trim()
        : DEFAULT_SETTINGS.defaultAgentKind,
    showOfflinePreviewWhenStopped:
      typeof src.showOfflinePreviewWhenStopped === "boolean"
        ? src.showOfflinePreviewWhenStopped
        : DEFAULT_SETTINGS.showOfflinePreviewWhenStopped,
  };
}
