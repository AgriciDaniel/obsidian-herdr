import * as fs from "node:fs";
import * as path from "node:path";
import type { App } from "obsidian";
import type {
  AgentInfo,
  HerdrPluginSettings,
  PaneInfo,
  SessionSnapshot,
  VaultAuditEntry,
  VaultPermissionMode,
} from "../../domain/types";
import type { CoordinatorState, HerdrCoordinator } from "../../services/herdr-coordinator";

export type DashboardTabId = "agents" | "vault" | "doctor";

export const DOCTOR_CLI_RUNTIMES = ["codex", "claude", "agy", "gemini", "opencode"] as const;

export interface TierMeta {
  id: VaultPermissionMode;
  label: string;
  description: string;
}

export const VAULT_TIERS: readonly TierMeta[] = [
  {
    id: "off",
    label: "Off",
    description: "Agents cannot read or change anything in this vault.",
  },
  {
    id: "read-only",
    label: "Read only",
    description: "Agents can read and search notes, but cannot change files or control Obsidian.",
  },
  {
    id: "read-write",
    label: "Edit notes",
    description:
      "Agents can create, edit, rename, and trash notes with undo, but cannot run commands or click the UI.",
  },
  {
    id: "full",
    label: "Full control",
    description:
      "Agents can edit notes, run Obsidian commands, and control the window when UI control is enabled.",
  },
];

const EDIT_ACTIVITY_METHODS = new Set<string>([
  "vault.create_note",
  "vault.update_note",
  "vault.patch_frontmatter",
  "vault.rename_note",
  "vault.trash_note",
  "canvas.upsert_node",
  "editor.insert_at_cursor",
  "editor.replace_selection",
]);

export function tierLabelFor(mode: VaultPermissionMode, bridgeRunning: boolean): string {
  if (!bridgeRunning || mode === "off") {
    return "Off";
  }
  return VAULT_TIERS.find((t) => t.id === mode)?.label ?? mode;
}

export function isEditActivity(entry: VaultAuditEntry): boolean {
  return Boolean(entry.snapshot) || EDIT_ACTIVITY_METHODS.has(entry.method);
}

export function normalizeTabId(raw: unknown): DashboardTabId | null {
  if (raw === "agents" || raw === "topology" || raw === "dispatch") {
    return "agents";
  }
  if (raw === "vault" || raw === "bridge") {
    return "vault";
  }
  if (raw === "doctor") {
    return "doctor";
  }
  return null;
}

export async function isExecutableFileAsync(target: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(target);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform !== "win32") {
      await fs.promises.access(target, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export async function findExecutableInDirsAsync(
  name: string,
  dirs: string[]
): Promise<string | null> {
  const names =
    process.platform === "win32" && !path.extname(name)
      ? [".exe", ".cmd", ".bat", ".com"].map((ext) => name + ext)
      : [name];
  for (const dir of dirs) {
    for (const file of names) {
      const candidate = path.join(dir, file);
      if (await isExecutableFileAsync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function addKvRow(parent: HTMLElement, key: string, value: string): void {
  parent.createSpan({ cls: "herdr-mc-kv-key", text: key });
  parent.createSpan({ cls: "herdr-mc-kv-val", text: value });
}

export function resolveActiveWorkspaceId(
  snap: SessionSnapshot | null,
  selectedWorkspaceId: string
): string {
  if (!snap || snap.workspaces.length === 0) {
    return "";
  }
  if (
    selectedWorkspaceId &&
    snap.workspaces.some((w) => w.workspace_id === selectedWorkspaceId)
  ) {
    return selectedWorkspaceId;
  }
  return snap.focused_workspace_id || snap.workspaces[0].workspace_id;
}

export function resolveActiveTabForWorkspace(
  snap: SessionSnapshot | null,
  workspaceId: string
): SessionSnapshot["tabs"][number] | null {
  if (!snap || snap.tabs.length === 0) {
    return null;
  }
  const wsTabs = workspaceId
    ? snap.tabs.filter((t) => t.workspace_id === workspaceId)
    : snap.tabs;
  if (wsTabs.length === 0) {
    return snap.tabs[0];
  }
  return (
    wsTabs.find((t) => t.tab_id === snap.focused_tab_id) ||
    wsTabs.find((t) => t.focused) ||
    wsTabs[0]
  );
}

export function resolveAgentDisplayLabel(agent: AgentInfo, panes: PaneInfo[]): string {
  const pane = panes.find((p) => p.pane_id === agent.pane_id);
  if (pane?.label && pane.label.trim()) {
    return pane.label.trim();
  }
  return agent.name || agent.display_agent || agent.agent || agent.pane_id;
}

export function shortenPathTail(rawPath: string | null | undefined, maxLen = 42): string {
  if (!rawPath) {
    return "";
  }
  const clean = rawPath.trim();
  if (clean.length <= maxLen) {
    return clean;
  }
  return `...${clean.slice(clean.length - (maxLen - 3))}`;
}

export function wireRovingKeyboardNav(buttons: HTMLButtonElement[]): void {
  for (let i = 0; i < buttons.length; i += 1) {
    const btn = buttons[i];
    btn.addEventListener("keydown", (ev: KeyboardEvent) => {
      let nextIdx = -1;
      if (ev.key === "ArrowRight" || ev.key === "ArrowDown") {
        nextIdx = (i + 1) % buttons.length;
      } else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") {
        nextIdx = (i - 1 + buttons.length) % buttons.length;
      } else if (ev.key === "Home") {
        nextIdx = 0;
      } else if (ev.key === "End") {
        nextIdx = buttons.length - 1;
      }
      if (nextIdx >= 0 && nextIdx !== i) {
        ev.preventDefault();
        const target = buttons[nextIdx];
        target.focus?.();
        target.click?.();
      }
    });
  }
}

export interface DashboardTabHost {
  readonly app: App;
  readonly coordinator: HerdrCoordinator;
  readonly getSettings: () => HerdrPluginSettings;
  readonly updateSettings: (patch: Partial<HerdrPluginSettings>) => Promise<void>;
  readonly openTerminalLeaf: (opts?: {
    profileId?: string;
    agentTarget?: string;
    sessionName?: string;
    split?: boolean;
  }) => Promise<void>;
  readonly promptDrafts: Map<string, string>;
  readonly sendingPromptTargets: Set<string>;
  readonly renderedPromptInputs: Map<string, HTMLTextAreaElement>;
  readonly renderedAgentPills: Map<string, HTMLElement>;
  readonly renderedAgentRows: Map<string, HTMLElement>;
  readonly renderedAgentSubs: Map<string, HTMLElement>;
  readonly renderedLayoutPanes: Map<
    string,
    { el: HTMLElement; dotEl?: HTMLElement; subEl?: HTMLElement; focused: boolean }
  >;
  getSelectedWorkspaceId(): string;
  setSelectedWorkspaceId(id: string): void;
  getSelectedAgentKey(): string;
  setSelectedAgentKey(key: string): void;
  getPromptDraft(): string;
  setPromptDraft(draft: string): void;
  getLiveTailTarget(): string;
  getLiveTailText(): string;
  getLiveTailAgentId(): string;
  consumeLiveTailAutoScroll(): boolean;
  clearLiveTail(): void;
  getShowAllActivity(): boolean;
  setShowAllActivity(show: boolean): void;
  createTrackedDetails(parent: HTMLElement, sectionId: string, cls?: string): HTMLDetailsElement;
  renderDashboard(): void;
  handleStartSession(): Promise<void>;
  openSpawnModal(defaultKind?: string, switchToAgents?: boolean): void;
  openAgentMenu(ev: MouseEvent, agent: AgentInfo, targetId: string, sessionName: string): void;
  openPaneMenu(ev: MouseEvent, paneId: string, agent: AgentInfo | undefined, sessionName: string): void;
  promptSingleAgent(target: string, prompt: string): Promise<boolean>;
  loadAgentTail(target: string): Promise<void>;
  runBridgeSelfTest(): Promise<void>;
  getCachedCliChecks(
    state: CoordinatorState
  ): Array<{ label: string; status: "ready" | "missing" | "off" | "Checking..."; detail: string }>;
}
