import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { App, WorkspaceLeaf } from "obsidian";
import { migrateSettings, type TerminalProfile } from "../src/domain/types";
import type { CoordinatorState, HerdrCoordinator } from "../src/services/herdr-coordinator";
import { HerdrDashboardView } from "../src/ui/dashboard-view";
import { HerdrTerminalView } from "../src/ui/terminal-view";
import {
  DispatchNoteModal,
  SelectProfileModal,
  SpawnAgentModal,
  confirmAction,
} from "../src/ui/modals";
import { HerdrSettingTab } from "../src/ui/settings-tab";
import { findAllNodes, type FakeDomNode } from "./helpers/fake-dom";
import {
  TFile,
  __mockMenus,
  __mockModals,
  resetObsidianUiMocks,
} from "./obsidian-mock";

function makeLiveState(over?: Partial<CoordinatorState>): CoordinatorState {
  return {
    binaryPath: "/usr/bin/herdr",
    activeSessionName: "vault-test",
    socketPath: "/tmp/herdr.sock",
    serverRunning: true,
    socketSubscribed: true,
    usingOfflinePreview: false,
    protocolWarning: null,
    snapshot: {
      version: "0.8.2",
      protocol: 20,
      focused_workspace_id: "w1",
      focused_tab_id: "w1:t1",
      focused_pane_id: "w1:p1",
      workspaces: [
        {
          workspace_id: "w1",
          number: 1,
          label: "Vault",
          focused: true,
          pane_count: 2,
          tab_count: 1,
          active_tab_id: "w1:t1",
          agent_status: "blocked",
        },
      ],
      tabs: [
        {
          tab_id: "w1:t1",
          workspace_id: "w1",
          number: 1,
          label: "Main",
          focused: true,
          pane_count: 2,
          agent_status: "blocked",
        },
      ],
      panes: [
        {
          pane_id: "w1:p1",
          tab_id: "w1:t1",
          label: "agyA",
          focused: true,
          agent_status: "working",
          terminal_title_stripped: "Running vitest",
          cwd: "/home/dev/vault",
          revision: 1,
        },
        {
          pane_id: "w1:p2",
          tab_id: "w1:t1",
          label: "agyB",
          focused: false,
          agent_status: "blocked",
          terminal_title_stripped: "Approve bash command?",
          cwd: "/home/dev/vault",
          revision: 1,
        },
      ],
      layouts: [
        {
          workspace_id: "w1",
          tab_id: "w1:t1",
          zoomed: false,
          focused_pane_id: "w1:p1",
          area: { x: 0, y: 0, width: 100, height: 100 },
          panes: [
            { pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 50, height: 100 } },
            { pane_id: "w1:p2", focused: false, rect: { x: 50, y: 0, width: 50, height: 100 } },
          ],
          splits: [],
        },
      ],
      agents: [
        {
          pane_id: "w1:p1",
          name: "agy-1",
          agent: "claude",
          agent_status: "working",
          interactive_ready: true,
          launch_pending: false,
          focused: true,
          revision: 1,
          state_change_seq: 1,
        },
        {
          pane_id: "w1:p2",
          name: "agy-2",
          agent: "codex",
          agent_status: "blocked",
          interactive_ready: true,
          launch_pending: false,
          focused: false,
          revision: 1,
          state_change_seq: 1,
        },
      ],
    },
    statusPayload: {
      client: { version: "0.8.2", protocol: 20 },
      server: { running: true, version: "0.8.2", protocol: 20, restart_needed: true },
    },
    sessions: [
      { name: "vault-test", status: "running", directory: "/v", socket: "/tmp/herdr.sock" },
      { name: "old-session", status: "stopped", directory: "/old", socket: "/tmp/old.sock" },
    ],
    integrations: [{ target: "claude", installed: true }],
    installedPlugins: [],
    worktrees: [],
    bridgeRunning: true,
    bridgeSocketPath: "/tmp/b.sock",
    cliScriptPath: "/tmp/obs-herdr",
    herdrPluginManifestPath: "/tmp/herdr-plugin.toml",
    lastError: null,
    lastUpdated: Date.now(),
    ...over,
  };
}

describe("UI Views & Phase 5/6 Interactive Halftone Mission Control", () => {
  it("renders interactive halftone Mission Control, preserves prompt drafts across refreshes, supports keyboard roving tabs, spatial pane actions, Vault button links, and Doctor restart alert", async () => {
    resetObsidianUiMocks();
    const state = makeLiveState();
    const listeners = new Set<() => void>();
    const attachedTargets: Array<{ agentTarget?: string; sessionName?: string }> = [];
    let tailCalls = 0;
    let openedFile: unknown = null;

    const noteFile = new TFile("Notes/Plan.md", 120);
    const audit = [
      {
        id: "1",
        timestamp: Date.now(),
        method: "vault.info",
        caller: "a",
        allowed: true,
        summary: "Read info",
      },
      {
        id: "2",
        timestamp: Date.now(),
        method: "vault.update_note",
        caller: "a",
        targetPath: "Notes/Plan.md",
        allowed: true,
        summary: "Edited Notes/Plan.md",
        snapshot: { kind: "modified", path: "Notes/Plan.md", previousContent: "" },
      },
    ];

    const coord = {
      getState: () => state,
      onChange: (cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      refreshAll: async () => undefined,
      vaultOps: {
        onAuditUpdated: () => () => undefined,
        getAuditLog: () => audit,
        clearAuditLog: () => undefined,
        getVaultBasePath: () => "/v",
      },
      socket: {
        focusPane: async () => undefined,
        readAgent: async () => {
          tailCalls += 1;
          return "line 1\nline 2";
        },
        zoomPane: async () => undefined,
      },
      getBridgeEnv: () => ({}),
    } as unknown as HerdrCoordinator;

    const leaf = {
      app: {
        vault: {
          getAbstractFileByPath: (p: string) => (p === "Notes/Plan.md" ? noteFile : null),
        },
        workspace: {
          getLeaf: () => ({
            openFile: async (f: unknown) => {
              openedFile = f;
            },
          }),
        },
      },
    } as unknown as WorkspaceLeaf;

    const settings = migrateSettings({ vaultPermissionMode: "full", allowUiControl: true });
    const view = new HerdrDashboardView({
      leaf,
      coordinator: coord,
      getSettings: () => settings,
      updateSettings: async () => undefined,
      openTerminalLeaf: async (opts) => {
        attachedTargets.push({ agentTarget: opts?.agentTarget, sessionName: opts?.sessionName });
      },
    });

    await view.onOpen();
    const root = view.contentEl as unknown as FakeDomNode;

    // 1. Halftone header crown + roving tabindex on tabs
    assert.equal(findAllNodes(root, (n) => n.classList.contains("herdr-mc-crown")).length, 1);
    const tabs = findAllNodes(root, (n) => n.classList.contains("herdr-mc-tab"));
    assert.deepEqual(tabs.map((t) => t.textContent), ["Agents", "Vault", "Doctor"]);
    assert.equal(tabs[0].getAttr("tabindex"), "0");
    assert.equal(tabs[1].getAttr("tabindex"), "-1");

    // 2. Blocked attention banner carries role=alert and context hint + Peek button
    const alerts = findAllNodes(root, (n) => n.getAttr("role") === "alert");
    assert.equal(alerts.length, 1);
    const ctxHints = findAllNodes(alerts[0], (n) => n.classList.contains("herdr-blocked-context"));
    assert.equal(ctxHints[0]?.textContent, "Approve bash command?");

    // 3. Typing inside agent composer textarea preserves focus & draft across live status refresh
    const inputs = findAllNodes(root, (n) => n.tagName === "TEXTAREA" && n.classList.contains("herdr-prompt-input"));
    assert.equal(inputs.length, 2);
    inputs[0].focus();
    inputs[0].value = "Keep writing this draft";
    inputs[0].setSelectionRange(10, 10);
    inputs[0].dispatchEvent({ type: "input" });

    // Trigger live status update without structural change -> in-place update preserves exact textarea element!
    state.snapshot!.agents[0].agent_status = "done";
    for (const cb of listeners) cb();
    assert.equal(root.ownerDocument.activeElement, inputs[0], "Focused prompt composer must stay mounted during live updates");
    assert.equal(inputs[0].value, "Keep writing this draft");

    // 4. Spatial halftone pane board: accessible non-nested pane select + real dock buttons
    const panes = findAllNodes(root, (n) => n.classList.contains("herdr-mc-layoutmap-pane"));
    assert.equal(panes.length, 2);
    assert.equal(panes[0].tagName, "DIV", "Spatial pane wrapper must be a non-button container");
    const selectBtns = findAllNodes(panes[0], (n) => n.tagName === "BUTTON" && n.classList.contains("herdr-mc-pane-select"));
    assert.equal(selectBtns.length, 1);
    selectBtns[0].dispatchEvent({ type: "dblclick" });
    assert.equal(attachedTargets.length, 1);
    assert.equal(attachedTargets[0].agentTarget, "agy-1");

    const dockBtns = findAllNodes(panes[0], (n) => n.tagName === "BUTTON" && n.classList.contains("herdr-mc-dock-btn"));
    assert.equal(dockBtns.length, 3, "Hover dock exposes 3 real <button> controls (Attach, Peek, Zoom)");
    dockBtns[1].click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(tailCalls, 1);

    // Right-click on spatial pane opens context menu
    panes[0].dispatchEvent({ type: "contextmenu", preventDefault: () => undefined });
    assert.ok(__mockMenus.length >= 1);

    // 5. ArrowRight keyboard navigation on tablist switches to Vault tab and preserves focus
    tabs[0].focus();
    tabs[0].dispatchEvent({ type: "keydown", key: "ArrowRight", preventDefault: () => undefined });
    const statChips = findAllNodes(root, (n) => n.classList.contains("herdr-mc-stat-chip"));
    assert.ok(statChips.some((c) => c.textContent === "Bridge live"));
    assert.ok(statChips.some((c) => c.textContent === "UI control on"));
    const activeTabAfterArrow = root.ownerDocument.activeElement as unknown as FakeDomNode | null;
    assert.equal(activeTabAfterArrow?.getAttr("data-herdr-focus-id"), "tab:vault", "Roving tab focus must survive re-render");

    // Activity note link is a real <button type="button">
    const noteBtns = findAllNodes(root, (n) => n.tagName === "BUTTON" && n.classList.contains("herdr-mc-log-link"));
    assert.equal(noteBtns.length, 1);
    noteBtns[0].click();
    assert.equal(openedFile, noteFile);

    // 6. Switch to Doctor tab and verify restart_needed alert banner
    const doctorTab = findAllNodes(root, (n) => n.classList.contains("herdr-mc-tab") && n.textContent === "Doctor")[0];
    doctorTab.click();
    const doctorAlerts = findAllNodes(root, (n) => n.getAttr("role") === "alert");
    assert.ok(
      doctorAlerts.some((a) =>
        findAllNodes(a, (x) => x.textContent.includes("Herdr server restart recommended")).length > 0
      ),
      "Doctor tab must surface server.restart_needed as role=alert"
    );

    await view.onClose();
  });

  it("supports FuzzySuggestModal in SelectProfileModal, Mod+Enter and installed-first ordering in SpawnAgentModal, and direct confirmAction/HerdrSettingTab checks", async () => {
    resetObsidianUiMocks();
    const profiles: TerminalProfile[] = [
      { id: "p1", name: "Vault Herdr", kind: "herdr-vault", cwdMode: "vault-root" },
      { id: "p2", name: "Local Shell", kind: "shell", cwdMode: "vault-root" },
    ];
    let chosen: TerminalProfile | null = null;
    const selector = new SelectProfileModal({} as App, profiles, (p) => {
      chosen = p;
    });
    assert.equal(selector.getItems().length, 2);
    assert.equal(selector.getItemText(profiles[0]), "Vault Herdr (herdr-vault)");
    selector.onChooseItem(profiles[1]);
    assert.equal(chosen?.id, "p2");

    // SpawnAgentModal groups installed runtimes first and wires Mod+Enter
    const state = makeLiveState();
    let spawnedKind = "";
    const coord = {
      getState: () => state,
      splitAndStartAgent: async (opts: { agentKind: string }) => {
        spawnedKind = opts.agentKind;
      },
    } as unknown as HerdrCoordinator;
    const spawnModal = new SpawnAgentModal({} as App, coord, "claude");
    spawnModal.open();
    const spawnDom = spawnModal.contentEl as unknown as FakeDomNode;
    const options = findAllNodes(spawnDom, (n) => n.tagName === "OPTION");
    assert.ok(options[0]?.textContent.includes("(installed)"), "Installed runtime must be listed first");
    const modEnter = (spawnModal as unknown as { scopeHandlers: Record<string, () => void> }).scopeHandlers["Mod+Enter"];
    assert.ok(typeof modEnter === "function", "SpawnAgentModal must register Mod+Enter");
    modEnter();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(spawnedKind, "claude");

    // DispatchNoteModal registers Mod+Enter
    const dispatchModal = new DispatchNoteModal(
      {
        workspace: {
          getActiveFile: () => new TFile("Spec.md", 42),
          getActiveViewOfType: () => null,
        },
      } as unknown as App,
      coord,
      { defaultTarget: "agy-1", selectionOnly: true }
    );
    dispatchModal.open();
    assert.ok(
      typeof (dispatchModal as unknown as { scopeHandlers: Record<string, () => void> }).scopeHandlers["Mod+Enter"] === "function"
    );

    // confirmAction direct test without esbuild subprocess
    resetObsidianUiMocks();
    const pConfirm = confirmAction({} as App, {
      title: "Stop session?",
      body: "All agents stop.",
      confirmText: "Stop session",
      danger: true,
    });
    const m1 = __mockModals[0];
    const warnBtns = findAllNodes(m1.contentEl, (n) => n.tagName === "BUTTON" && n.classList.contains("mod-warning"));
    assert.equal(warnBtns.length, 1);
    warnBtns[0].click();
    assert.equal(await pConfirm, true);

    // HerdrSettingTab direct test without esbuild subprocess
    const settings = migrateSettings({ vaultPermissionMode: "full", allowUiControl: true, showAgentCursors: true });
    const plugin = {
      manifest: { id: "herdr-obs", name: "Herdr Mission Control" },
      settings,
      async saveAndApplySettings(patch: Partial<typeof settings>) {
        Object.assign(settings, patch);
      },
    };
    const tab = new HerdrSettingTab({} as App, plugin as unknown as never);
    tab.update();
    tab.display();
    assert.equal(tab.getControlValue("uiTypingSpeed"), "visible");
    await tab.setControlValue("uiTypingSpeed", "fast");
    assert.equal(settings.uiTypingSpeed, "fast");
  });
});

describe("Terminal view input queue", () => {
  it("drops text queued during a terminal start that fails, so it is never typed into a later session", async () => {
    type Internals = {
      startingPty: boolean;
      pendingWrites: string[];
      pendingInitTimer: number | null;
      ptyLaunchSeq: number;
      pty: null;
      terminal: null;
      exitBannerEl: null;
      resolveSelectedProfile: () => never;
      sendTextToPty: (text: string) => void;
      startPtyForSelectedProfile: () => Promise<void>;
    };
    const view = Object.create(HerdrTerminalView.prototype) as Internals;
    view.startingPty = true;
    view.pendingWrites = [];
    view.pendingInitTimer = null;
    view.ptyLaunchSeq = 0;
    view.pty = null;
    view.terminal = null;
    view.exitBannerEl = null;
    view.sendTextToPty("rm -rf build\n");
    assert.deepEqual(view.pendingWrites, ["rm -rf build\n"]);

    view.resolveSelectedProfile = () => {
      throw new Error("refused executable");
    };
    await assert.rejects(() => view.startPtyForSelectedProfile(), /refused executable/);
    assert.equal(view.startingPty, false);
    assert.deepEqual(view.pendingWrites, []);
  });
});
