import * as path from "node:path";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import {
  ItemView,
  MarkdownView,
  Notice,
  TFile,
  setIcon,
  type ViewStateResult,
  type WorkspaceLeaf,
} from "obsidian";
import { OscStreamObserver } from "../domain/osc-parser";
import { quoteShellPathForPlatform } from "../domain/shell-quote";
import {
  DEFAULT_PROFILES,
  type AgentStatus,
  type HerdrPluginSettings,
  type TerminalProfile,
} from "../domain/types";
import type { HerdrCoordinator } from "../services/herdr-coordinator";
import { VaultTerminalLinkProvider } from "../terminal/link-provider";
import { PtySession, shouldFallbackMissingHerdr } from "../terminal/pty-host";
import {
  buildObsidianXtermTheme,
  resolveTerminalFontFamily,
} from "../terminal/theme-palette";

export const VIEW_TYPE_HERDR_TERMINAL = "herdr-terminal-view";

const PTY_HIGH_WATERMARK_BYTES = 256 * 1024;
const PTY_LOW_WATERMARK_BYTES = 64 * 1024;

interface FlowControllablePty {
  pause?: () => void;
  resume?: () => void;
}

export interface HerdrTerminalViewState extends Record<string, unknown> {
  profileId?: string;
  customAgentTarget?: string;
  sessionOverride?: string;
  cwdOverride?: string;
}

export class HerdrTerminalView extends ItemView {
  private readonly coordinator: HerdrCoordinator;
  private readonly getSettings: () => HerdrPluginSettings;

  private profileId = "herdr-vault";
  private customAgentTarget = "";
  private sessionOverride = "";
  private cwdOverride = "";
  private unsubCoord: (() => void) | null = null;

  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private searchAddon: SearchAddon | null = null;
  private pty: PtySession | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private fitTimer: number | null = null;
  private pendingInitTimer: number | null = null;
  private ptyLaunchSeq = 0;
  private startingPty = false;
  private pendingWrites: string[] = [];

  private currentTitle = "Herdr terminal";
  private currentCwd: string | null = null;
  private currentProgramState: AgentStatus = "idle";
  private currentProgramMessage: string | undefined = undefined;
  private searchVisible = false;
  private lastActiveMarkdownView: MarkdownView | null = null;
  private lastProfileDropdownSig = "";
  private lastCustomFontOverride: string | null = null;

  private headerStatusBadgeEl: HTMLElement | null = null;
  private headerCwdEl: HTMLElement | null = null;
  private profileSelectEl: HTMLSelectElement | null = null;
  private searchBarEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  private xtermMountEl: HTMLElement | null = null;
  private exitBannerEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    coordinator: HerdrCoordinator,
    getSettings: () => HerdrPluginSettings
  ) {
    super(leaf);
    this.coordinator = coordinator;
    this.getSettings = getSettings;
    this.profileId = getSettings().defaultProfileId || "herdr-vault";
  }

  getViewType(): string {
    return VIEW_TYPE_HERDR_TERMINAL;
  }

  getDisplayText(): string {
    return this.currentTitle || "Herdr terminal";
  }

  getIcon(): string {
    return "terminal";
  }

  getState(): Record<string, unknown> {
    return {
      profileId: this.profileId,
      customAgentTarget: this.customAgentTarget,
      sessionOverride: this.sessionOverride,
      cwdOverride: this.cwdOverride,
    };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    if (state && typeof state === "object") {
      const s = state as HerdrTerminalViewState;
      if (typeof s.profileId === "string" && s.profileId) {
        this.profileId = s.profileId;
      }
      if (typeof s.customAgentTarget === "string") {
        this.customAgentTarget = s.customAgentTarget;
      }
      if (typeof s.sessionOverride === "string") {
        this.sessionOverride = s.sessionOverride;
      }
      if (typeof s.cwdOverride === "string") {
        this.cwdOverride = s.cwdOverride;
      }
    }
    await super.setState(state, result);
    if (this.xtermMountEl) {
      this.clearPendingInitTimer();
      this.syncProfileDropdown();
      this.restartPtySession();
    }
  }

  onOpen(): Promise<void> {
    const root = this.contentEl;
    const doc = root.doc;
    const win = root.win;
    root.empty();
    root.addClass("herdr-root", "herdr-terminal-pane");

    this.lastProfileDropdownSig = "";
    this.lastActiveMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);

    this.buildToolbar(root);
    this.buildSearchBar(root);

    this.exitBannerEl = root.createDiv({ cls: "herdr-terminal-exit-banner herdr-is-hidden" });
    this.xtermMountEl = root.createDiv({ cls: "herdr-terminal-host" });

    this.mountXterm(this.xtermMountEl);
    this.clearPendingInitTimer();
    this.pendingInitTimer = win.setTimeout(() => {
      this.pendingInitTimer = null;
      if (!this.xtermMountEl) {
        return;
      }
      void this.startPtyForSelectedProfile().catch((err: unknown) => {
        console.warn("[herdr-obs] Terminal PTY startup failed:", err);
      });
    }, 0);

    this.unsubCoord = this.coordinator.onChange(() => {
      this.syncRuntimeSettings(false);
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) {
          this.lastActiveMarkdownView = leaf.view;
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        this.syncTheme();
      })
    );

    this.registerDomEvent(doc, "visibilitychange", () => {
      if (!doc.hidden) {
        this.scheduleFit();
      }
    });

    this.registerDomEvent(root, "dragover", (ev: DragEvent) => {
      ev.preventDefault();
    });

    this.registerDomEvent(root, "drop", (ev: DragEvent) => {
      const textData = ev.dataTransfer?.getData("text/plain")?.trim();
      if (textData && this.pty?.isRunning()) {
        ev.preventDefault();
        const resolvedDrop = this.resolveDroppedPath(textData);
        this.pty.write(quoteShellPathForPlatform(resolvedDrop, process.platform) + " ");
      }
    });

    return Promise.resolve();
  }

  onClose(): Promise<void> {
    const win = this.contentEl.win;
    this.ptyLaunchSeq += 1;
    this.startingPty = false;
    this.pendingWrites = [];
    this.clearPendingInitTimer();
    this.unsubCoord?.();
    this.unsubCoord = null;
    if (this.fitTimer !== null) {
      win.clearTimeout(this.fitTimer);
      this.fitTimer = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.pty) {
      this.pty.dispose();
      this.pty = null;
    }
    if (this.searchAddon) {
      this.searchAddon.dispose();
      this.searchAddon = null;
    }
    if (this.fitAddon) {
      this.fitAddon.dispose();
      this.fitAddon = null;
    }
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = null;
    }
    this.headerStatusBadgeEl = null;
    this.headerCwdEl = null;
    this.profileSelectEl = null;
    this.searchBarEl = null;
    this.searchInputEl = null;
    this.xtermMountEl = null;
    this.exitBannerEl = null;
    this.lastActiveMarkdownView = null;
    this.lastProfileDropdownSig = "";
    this.lastCustomFontOverride = null;
    this.contentEl.empty();
    return Promise.resolve();
  }

  private clearPendingInitTimer(): void {
    if (this.pendingInitTimer !== null) {
      this.contentEl.win.clearTimeout(this.pendingInitTimer);
      this.pendingInitTimer = null;
    }
  }

  focusTerminal(): void {
    this.terminal?.focus();
  }

  sendTextToPty(text: string): void {
    if (this.pty?.isRunning()) {
      this.pty.write(text);
      this.terminal?.focus();
      return;
    }
    if (this.startingPty || this.pendingInitTimer !== null) {
      this.pendingWrites.push(text);
      this.terminal?.focus();
      return;
    }
    new Notice("Terminal session is not running. Reconnect first.");
  }

  private buildToolbar(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "herdr-terminal-toolbar" });

    const leftGroup = bar.createDiv({ cls: "herdr-toolbar-group" });
    const select = leftGroup.createEl("select", {
      cls: "dropdown herdr-profile-select",
      attr: { "aria-label": "Select terminal profile" },
    });
    this.profileSelectEl = select;
    this.syncProfileDropdown();

    select.addEventListener("change", () => {
      this.profileId = select.value;
      if (this.profileId !== "__agent_attach__") {
        this.customAgentTarget = "";
      }
      this.cwdOverride = "";
      this.restartPtySession();
    });

    this.headerStatusBadgeEl = leftGroup.createSpan({
      cls: "herdr-status-pill herdr-status-idle",
      text: "idle",
    });

    this.headerCwdEl = leftGroup.createSpan({
      cls: "herdr-cwd-chip",
      text: this.app.vault.getName(),
    });

    const rightGroup = bar.createDiv({ cls: "herdr-toolbar-group" });

    this.createIconBtn(rightGroup, "file-input", "Paste active note path", () => {
      this.pasteActiveNotePath();
    });

    const sendSelBtn = this.createIconBtn(
      rightGroup,
      "send",
      "Send editor selection to terminal",
      () => {
        this.sendActiveSelection();
      }
    );
    sendSelBtn.addEventListener("mousedown", (ev: MouseEvent) => {
      ev.preventDefault();
    });

    this.createIconBtn(rightGroup, "search", "Find in terminal", () => {
      this.toggleSearchBar();
    });

    this.createIconBtn(rightGroup, "eraser", "Clear terminal viewport", () => {
      this.terminal?.clear();
    });

    this.createIconBtn(rightGroup, "rotate-cw", "Reconnect or restart terminal", () => {
      this.restartPtySession();
    });
  }

  private buildSearchBar(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "herdr-terminal-search herdr-is-hidden" });
    this.searchBarEl = bar;

    const input = bar.createEl("input", {
      type: "text",
      cls: "herdr-search-input",
      placeholder: "Find in terminal output...",
      attr: { "aria-label": "Find in terminal output" },
    });
    this.searchInputEl = input;

    input.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        if (ev.shiftKey) {
          this.searchAddon?.findPrevious(input.value);
        } else {
          this.searchAddon?.findNext(input.value);
        }
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        this.toggleSearchBar(false);
        this.terminal?.focus();
      }
    });

    const prevBtn = bar.createEl("button", { text: "Prev", cls: "herdr-btn-compact" });
    prevBtn.addEventListener("click", () => {
      this.searchAddon?.findPrevious(input.value);
    });

    const nextBtn = bar.createEl("button", { text: "Next", cls: "herdr-btn-compact" });
    nextBtn.addEventListener("click", () => {
      this.searchAddon?.findNext(input.value);
    });

    const closeBtn = bar.createEl("button", { text: "Close", cls: "herdr-btn-compact" });
    closeBtn.addEventListener("click", () => {
      this.toggleSearchBar(false);
      this.terminal?.focus();
    });
  }

  private createIconBtn(
    parent: HTMLElement,
    iconName: string,
    label: string,
    onClick: () => void
  ): HTMLButtonElement {
    const btn = parent.createEl("button", {
      cls: "clickable-icon herdr-icon-btn",
      attr: { "aria-label": label, title: label, type: "button" },
    });
    setIcon(btn, iconName);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private mountXterm(hostEl: HTMLElement): void {
    const doc = this.contentEl.doc;
    const win = this.contentEl.win;
    const settings = this.getSettings();
    this.lastCustomFontOverride = settings.terminalFontFamily;
    const term = new Terminal({
      cursorBlink: settings.terminalCursorBlink,
      fontSize: settings.terminalFontSize,
      scrollback: settings.terminalScrollback,
      fontFamily: resolveTerminalFontFamily(hostEl, settings.terminalFontFamily),
      allowProposedApi: true,
      convertEol: false,
      macOptionIsMeta: true,
      theme: buildObsidianXtermTheme(hostEl),
    });

    const fit = new FitAddon();
    const search = new SearchAddon();
    const webLinks = new WebLinksAddon((_event, uri) => {
      if (uri.startsWith("http://") || uri.startsWith("https://")) {
        win.open(uri, "_blank", "noopener,noreferrer");
      }
    });

    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(webLinks);

    term.registerLinkProvider(
      new VaultTerminalLinkProvider({
        app: this.app,
        terminal: term,
        getVaultRoot: () => this.coordinator.vaultOps.getVaultBasePath(),
        getCurrentCwd: () => this.currentCwd,
      })
    );

    term.open(hostEl);

    term.onData((data) => {
      this.pty?.write(data);
    });

    term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === "f") {
        if (ev.type === "keydown") {
          this.toggleSearchBar(true);
        }
        return false;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === "c") {
        if (ev.type === "keydown" && term.hasSelection()) {
          void win.navigator.clipboard.writeText(term.getSelection()).catch((err: unknown) => {
            console.warn("[herdr-obs] Terminal clipboard copy failed:", err);
          });
        }
        return false;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === "v") {
        if (ev.type === "keydown") {
          void win.navigator.clipboard
            .readText()
            .then((clip) => {
              if (clip) {
                this.pty?.write(clip);
              }
            })
            .catch((err: unknown) => {
              console.warn("[herdr-obs] Terminal clipboard paste failed:", err);
            });
        }
        return false;
      }
      return true;
    });

    this.terminal = term;
    this.fitAddon = fit;
    this.searchAddon = search;

    this.resizeObserver = new ResizeObserver(() => {
      if (!doc.hidden) {
        this.scheduleFit();
      }
    });
    this.resizeObserver.observe(hostEl);
    this.scheduleFit();
  }

  private async startPtyForSelectedProfile(): Promise<void> {
    const launchId = ++this.ptyLaunchSeq;
    this.startingPty = true;
    this.pty?.dispose();
    this.pty = null;
    this.exitBannerEl?.addClass("herdr-is-hidden");

    try {
      const profile = this.resolveSelectedProfile();
      if (
        (profile.kind === "herdr-vault" || profile.kind === "herdr-agent") &&
        !profile.sessionName?.trim() &&
        this.coordinator.cli.getBinaryPath() &&
        !this.coordinator.getState().serverRunning
      ) {
        try {
          await this.coordinator.startVaultHerdrSession();
        } catch {
          // Fall through to direct TUI launch
        }
        if (launchId !== this.ptyLaunchSeq || !this.xtermMountEl) {
          return;
        }
      }

      await this.coordinator.ensureBridgeReady();
      if (launchId !== this.ptyLaunchSeq || !this.xtermMountEl) {
        return;
      }

      const spawnSpec = this.coordinator.resolveSpawnCommandForProfile(
        profile,
        this.cwdOverride || undefined
      );
      this.currentCwd = spawnSpec.cwd;
      this.updateHeaderCwd(spawnSpec.cwd);

      if (shouldFallbackMissingHerdr(profile.kind, this.coordinator.cli.getBinaryPath())) {
        this.terminal?.writeln(
          "\x1b[33m[Herdr binary not detected on PATH. Falling back to interactive shell with Vault Control Bridge enabled.]\x1b[0m"
        );
        const fallbackShell = this.coordinator.resolveSpawnCommandForProfile({
          id: "shell-fallback",
          name: "Shell",
          kind: "shell",
          cwdMode: "vault-root",
        });
        spawnSpec.command = fallbackShell.command;
        spawnSpec.args = fallbackShell.args;
      }

      this.currentProgramState = "idle";
      this.currentProgramMessage = undefined;

      const oscObserver = new OscStreamObserver({
        onTitle: (title) => {
          this.currentTitle = title;
          this.updateLeafHeader();
        },
        onCwd: (cwd) => {
          this.currentCwd = cwd;
          this.updateHeaderCwd(cwd);
        },
        onProgramStatus: (status) => {
          this.currentProgramState = status.state;
          this.currentProgramMessage = status.message || undefined;
          this.refreshStatusBadge();
        },
      });

      const cols = this.terminal?.cols || 96;
      const rows = this.terminal?.rows || 28;

      let pendingWriteBytes = 0;
      let ptyPaused = false;
      let session: PtySession | null = null;

      session = new PtySession({
        command: spawnSpec.command,
        args: spawnSpec.args,
        cwd: spawnSpec.cwd,
        cols,
        rows,
        env: spawnSpec.env,
        onData: (chunk) => {
          oscObserver.feed(chunk);
          const term = this.terminal;
          if (!term) {
            return;
          }
          const chunkBytes = chunk.length;
          pendingWriteBytes += chunkBytes;
          if (!ptyPaused && pendingWriteBytes > PTY_HIGH_WATERMARK_BYTES) {
            ptyPaused = true;
            (session as unknown as FlowControllablePty | null)?.pause?.();
          }
          term.write(chunk, () => {
            pendingWriteBytes = Math.max(0, pendingWriteBytes - chunkBytes);
            if (ptyPaused && pendingWriteBytes < PTY_LOW_WATERMARK_BYTES) {
              ptyPaused = false;
              (session as unknown as FlowControllablePty | null)?.resume?.();
            }
          });
        },
        onExit: (code, signal) => {
          this.currentProgramState = "idle";
          this.currentProgramMessage = undefined;
          this.updateStatusBadge("idle", undefined, "exited");
          this.showExitBanner(code, signal);
          void this.coordinator.refreshAll(false).catch((err: unknown) => {
            console.warn("[herdr-obs] Post-exit refresh failed:", err);
          });
        },
      });

      this.pty = session;

      if (this.pendingWrites.length > 0 && session.isRunning()) {
        const queued = this.pendingWrites.splice(0, this.pendingWrites.length);
        for (const text of queued) {
          session.write(text);
        }
      }

      this.refreshStatusBadge();
      this.scheduleFit();
      void this.coordinator.refreshAll(false).catch((err: unknown) => {
        console.warn("[herdr-obs] Post-launch refresh failed:", err);
      });
    } finally {
      if (launchId === this.ptyLaunchSeq) {
        this.startingPty = false;
        // Text queued for a start that failed or was refused must not be
        // replayed into a session started later (it could run a command).
        if (this.pendingInitTimer === null && !this.pty?.isRunning()) {
          this.pendingWrites = [];
        }
      }
    }
  }

  restartPtySession(): void {
    this.terminal?.reset();
    void this.startPtyForSelectedProfile().catch((err: unknown) => {
      console.warn("[herdr-obs] Terminal PTY restart failed:", err);
    });
    this.terminal?.focus();
  }

  private showExitBanner(code: number | null, signal: string | null): void {
    if (!this.exitBannerEl) {
      return;
    }
    this.exitBannerEl.empty();
    this.exitBannerEl.removeClass("herdr-is-hidden");
    const desc =
      signal !== null
        ? `Process exited (${signal}). Background Herdr sessions stay alive.`
        : `Process exited (code ${code ?? 0}). Background Herdr sessions stay alive.`;
    this.exitBannerEl.createSpan({ text: desc });
    const btn = this.exitBannerEl.createEl("button", {
      text: "Reconnect",
      cls: "mod-cta herdr-btn-compact",
    });
    btn.addEventListener("click", () => {
      this.restartPtySession();
    });
  }

  private getAvailableProfiles(): TerminalProfile[] {
    const configured = this.getSettings().profiles;
    return configured && configured.length > 0 ? configured : DEFAULT_PROFILES;
  }

  private resolveSelectedProfile(): TerminalProfile {
    if (this.profileId === "__agent_attach__" && this.customAgentTarget) {
      return {
        id: "__agent_attach__",
        name: `Attach ${this.customAgentTarget}`,
        kind: "herdr-agent",
        agentTarget: this.customAgentTarget,
        sessionName: this.sessionOverride || undefined,
        cwdMode: "vault-root",
      };
    }
    const profiles = this.getAvailableProfiles();
    const found = profiles.find((p) => p.id === this.profileId) || profiles[0];
    if (this.sessionOverride && found.kind === "herdr-vault") {
      return { ...found, sessionName: this.sessionOverride };
    }
    return found;
  }

  private scheduleFit(): void {
    const win = this.contentEl.win;
    if (this.fitTimer !== null) {
      win.clearTimeout(this.fitTimer);
    }
    this.fitTimer = win.setTimeout(() => {
      this.fitTimer = null;
      if (
        !this.xtermMountEl ||
        !this.fitAddon ||
        !this.terminal ||
        this.xtermMountEl.clientWidth < 40 ||
        this.xtermMountEl.clientHeight < 40
      ) {
        return;
      }
      try {
        this.fitAddon.fit();
        this.pty?.resize(this.terminal.cols, this.terminal.rows);
      } catch {
        // Ignore transient layout error
      }
    }, 50);
  }

  private syncTheme(): void {
    if (!this.terminal || !this.xtermMountEl) {
      return;
    }
    this.terminal.options.theme = buildObsidianXtermTheme(this.xtermMountEl);
    this.syncRuntimeSettings(true);
  }

  private syncRuntimeSettings(forceFontRefresh = false): void {
    this.syncProfileDropdown();
    this.refreshStatusBadge();
    if (!this.terminal) {
      return;
    }
    const settings = this.getSettings();
    let needsFit = false;
    if (forceFontRefresh || this.lastCustomFontOverride !== settings.terminalFontFamily) {
      this.lastCustomFontOverride = settings.terminalFontFamily;
      const nextFont = resolveTerminalFontFamily(
        this.xtermMountEl || undefined,
        settings.terminalFontFamily
      );
      if (this.terminal.options.fontFamily !== nextFont) {
        this.terminal.options.fontFamily = nextFont;
        needsFit = true;
      }
    }
    if (this.terminal.options.fontSize !== settings.terminalFontSize) {
      this.terminal.options.fontSize = settings.terminalFontSize;
      needsFit = true;
    }
    if (this.terminal.options.scrollback !== settings.terminalScrollback) {
      this.terminal.options.scrollback = settings.terminalScrollback;
    }
    if (this.terminal.options.cursorBlink !== settings.terminalCursorBlink) {
      this.terminal.options.cursorBlink = settings.terminalCursorBlink;
    }
    if (needsFit) {
      this.scheduleFit();
    }
  }

  private syncProfileDropdown(): void {
    const select = this.profileSelectEl;
    if (!select) {
      return;
    }
    const profiles = this.getAvailableProfiles();
    const signature =
      profiles.map((prof) => `${prof.id}\0${prof.name}`).join("\n") +
      `\0__attach__:${this.customAgentTarget}`;

    if (signature !== this.lastProfileDropdownSig) {
      this.lastProfileDropdownSig = signature;
      select.empty();
      for (const prof of profiles) {
        const opt = select.createEl("option", { text: prof.name, value: prof.id });
        if (prof.id === this.profileId && !this.customAgentTarget) {
          opt.selected = true;
        }
      }
      if (this.customAgentTarget) {
        const customOpt = select.createEl("option", {
          text: `Attach: ${this.customAgentTarget}`,
          value: "__agent_attach__",
        });
        customOpt.selected = true;
        this.profileId = "__agent_attach__";
      }
      return;
    }

    const desiredValue = this.customAgentTarget ? "__agent_attach__" : this.profileId;
    if (this.customAgentTarget) {
      this.profileId = "__agent_attach__";
    }
    if (select.value !== desiredValue) {
      select.value = desiredValue;
    }
  }

  private resolveDroppedPath(rawText: string): string {
    const vaultBase = this.coordinator.vaultOps.getVaultBasePath();
    if (rawText.startsWith("obsidian://")) {
      try {
        const parsed = new URL(rawText);
        const fileParam = parsed.searchParams.get("file");
        if (fileParam && fileParam.trim()) {
          const trimmed = fileParam.trim();
          const target =
            this.app.metadataCache.getFirstLinkpathDest(trimmed, "") ??
            this.app.vault.getAbstractFileByPath(trimmed);
          if (target instanceof TFile) {
            return vaultBase ? path.join(vaultBase, target.path) : target.path;
          }
          return vaultBase ? path.join(vaultBase, trimmed) : trimmed;
        }
      } catch {
        // Fall through to raw text
      }
    }
    return rawText;
  }

  private toggleSearchBar(force?: boolean): void {
    this.searchVisible = force !== undefined ? force : !this.searchVisible;
    this.searchBarEl?.toggleClass("herdr-is-hidden", !this.searchVisible);
    if (this.searchVisible) {
      this.searchInputEl?.focus();
      this.searchInputEl?.select();
    }
  }

  private pasteActiveNotePath(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active vault note is open.");
      return;
    }
    const quoted = quoteShellPathForPlatform(file.path, process.platform);
    this.sendTextToPty(quoted + " ");
  }

  private sendActiveSelection(): void {
    const activeMd = this.app.workspace.getActiveViewOfType(MarkdownView);
    const trackedMd =
      this.lastActiveMarkdownView &&
      this.lastActiveMarkdownView.containerEl?.isConnected
        ? this.lastActiveMarkdownView
        : null;
    const mdView = activeMd ?? trackedMd;
    const sel = mdView?.editor.getSelection() || "";
    if (!sel.trim()) {
      new Notice("Select text in an active Markdown editor first.");
      return;
    }
    this.sendTextToPty(sel);
  }

  private refreshStatusBadge(): void {
    if (!this.pty?.isRunning()) {
      this.updateStatusBadge("idle");
      return;
    }
    if (this.currentProgramState !== "idle") {
      this.updateStatusBadge(this.currentProgramState, this.currentProgramMessage);
      return;
    }
    const profile = this.resolveSelectedProfile();
    if (profile.kind === "herdr-vault" || profile.kind === "herdr-agent") {
      const allAgents = this.coordinator.getState().snapshot?.agents ?? [];
      const target = (this.customAgentTarget || profile.agentTarget || "").trim();
      const agents =
        profile.kind === "herdr-agent" && target
          ? allAgents.filter((a) => a.name === target || a.pane_id === target)
          : allAgents;
      if (agents.some((a) => a.agent_status === "blocked")) {
        this.updateStatusBadge("blocked");
        return;
      }
      if (agents.some((a) => a.agent_status === "working")) {
        this.updateStatusBadge("working");
        return;
      }
      if (agents.some((a) => a.agent_status === "done")) {
        this.updateStatusBadge("done");
        return;
      }
      this.updateStatusBadge("done", undefined, "connected");
      return;
    }
    this.updateStatusBadge("idle", undefined, "ready");
  }

  private updateStatusBadge(state: AgentStatus, message?: string, customLabel?: string): void {
    if (!this.headerStatusBadgeEl) {
      return;
    }
    const baseText = customLabel || state;
    this.headerStatusBadgeEl.className = `herdr-status-pill herdr-status-${state}`;
    this.headerStatusBadgeEl.setText(message ? `${baseText}: ${message}` : baseText);
  }

  private updateHeaderCwd(cwd: string): void {
    if (!this.headerCwdEl) {
      return;
    }
    const short = cwd.length > 38 ? `...${cwd.slice(-35)}` : cwd;
    this.headerCwdEl.setText(short);
    this.headerCwdEl.setAttr("title", cwd);
  }

  private updateLeafHeader(): void {
    const leafInternal = this.leaf as unknown as { updateHeader?: () => void };
    if (typeof leafInternal.updateHeader === "function") {
      leafInternal.updateHeader();
    }
  }
}
