// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Daniel Agrici. Protected-area detection, shortcut gating, and inspect redaction for UI control.

import {
  UiControlError,
  findClosestElement,
  normalizeText,
  type InspectedElement,
} from "./types";

export const HERDR_TERMINAL_PROTECTED_SELECTOR =
  '.herdr-terminal-pane, [data-type="herdr-terminal-view"], .herdr-terminal-host, .xterm, .xterm-helper-textarea, [data-type="herdr-view"], .herdr-dashboard-pane, .herdr-embed-card, .herdr-bases-board, [data-type="herdr-agent-board"]';
export const COMMUNITY_PLUGIN_PROTECTED_SELECTOR =
  ".installed-plugins-container, .community-plugin-item, .community-plugins-container, .community-plugin-info, [data-plugin-id]";
export const SETTINGS_MODAL_PROTECTED_SELECTOR =
  '.mod-settings, .modal-container.mod-settings, .modal.mod-settings, [data-type="settings"]';
export const WINDOW_CONTROL_PROTECTED_SELECTOR =
  ".titlebar, .titlebar-button-container, .titlebar-button, .titlebar-close, .titlebar-minimize, .titlebar-maximize, .mod-close, .mod-minimize, .mod-maximize, .window-control, .window-controls";
export const APP_QUIT_PROTECTED_SELECTOR =
  '[data-command="app:quit"], [data-command-id="app:quit"], [data-value="app:quit"], [data-command="window:close"], [data-command-id="window:close"], [data-value="window:close"]';
export const SETTINGS_OPEN_PROTECTED_SELECTOR =
  '[data-command="app:open-settings"], [data-command-id="app:open-settings"], [data-value="app:open-settings"]';

const PROTECTED_COMMAND_IDS = new Set([
  "app:quit",
  "window:close",
  "app:open-settings",
  "app:reload",
  "app:toggle-dev-tools",
  "window:toggle-dev-tools",
  "app:show-debug-info",
  "app:delete-file",
  "app:open-vault",
  "community-plugins:browse",
]);

export interface RestrictedShortcutMatch {
  kind: "app_quit" | "settings" | "dev_or_reload";
  label: string;
  message: string;
}

export function isHerdrTerminalElement(el: Element | null | undefined): boolean {
  if (!el) {
    return false;
  }
  return Boolean(findClosestElement(el, HERDR_TERMINAL_PROTECTED_SELECTOR));
}

export function isProtectedCommandId(commandId: string): boolean {
  const normalized = commandId.trim().toLowerCase();
  return normalized !== "" && PROTECTED_COMMAND_IDS.has(normalized);
}

export function isProtectedSettingsElement(el: Element | null | undefined): boolean {
  if (!el) {
    return false;
  }
  if (
    findClosestElement(el, COMMUNITY_PLUGIN_PROTECTED_SELECTOR) ||
    findClosestElement(el, SETTINGS_MODAL_PROTECTED_SELECTOR) ||
    findClosestElement(el, SETTINGS_OPEN_PROTECTED_SELECTOR) ||
    Boolean(el.querySelector?.(SETTINGS_OPEN_PROTECTED_SELECTOR))
  ) {
    return true;
  }
  const ariaHost = findClosestElement(el, "[aria-label]") ?? el;
  const aria =
    typeof ariaHost.getAttribute === "function"
      ? (ariaHost.getAttribute("aria-label") ?? "").trim().toLowerCase()
      : "";
  if (aria === "settings" || aria === "open settings") {
    return true;
  }
  const modal = findClosestElement(el, '.modal, .modal-container, [role="dialog"]');
  if (modal) {
    try {
      if (
        modal.querySelector?.(".mod-settings, .installed-plugins-container, .vertical-tabs-container") ||
        modal.querySelector?.(".modal-title")?.textContent?.trim() === "Settings"
      ) {
        return true;
      }
    } catch {
      // Ignore query errors on minimal mocks.
    }
  }
  return false;
}

export function detectProtectedArea(el: Element | null | undefined): string | null {
  if (!el) {
    return null;
  }
  if (isHerdrTerminalElement(el)) {
    return "the Herdr terminal view";
  }
  if (findClosestElement(el, COMMUNITY_PLUGIN_PROTECTED_SELECTOR)) {
    return "community plugin settings and toggles";
  }
  if (findClosestElement(el, SETTINGS_MODAL_PROTECTED_SELECTOR)) {
    return "the Obsidian Settings modal";
  }
  if (findClosestElement(el, WINDOW_CONTROL_PROTECTED_SELECTOR)) {
    return "Obsidian window controls";
  }
  if (
    findClosestElement(el, APP_QUIT_PROTECTED_SELECTOR) ||
    Boolean(el.querySelector?.(APP_QUIT_PROTECTED_SELECTOR))
  ) {
    return "app quit controls";
  }
  if (
    findClosestElement(el, SETTINGS_OPEN_PROTECTED_SELECTOR) ||
    Boolean(el.querySelector?.(SETTINGS_OPEN_PROTECTED_SELECTOR))
  ) {
    return "Obsidian Settings controls";
  }
  const ariaHost = findClosestElement(el, "[aria-label]") ?? el;
  const aria =
    typeof ariaHost.getAttribute === "function"
      ? (ariaHost.getAttribute("aria-label") ?? "").trim().toLowerCase()
      : "";
  if (
    aria === "close window" ||
    aria === "minimize" ||
    aria === "maximize" ||
    aria === "restore" ||
    aria === "quit" ||
    aria === "quit obsidian"
  ) {
    return "Obsidian window and quit controls";
  }
  if (aria === "settings" || aria === "open settings") {
    return "Obsidian Settings controls";
  }
  const cmdMenu = findClosestElement(
    el,
    '.menu-item, .suggestion-item, [role="option"], [role="menuitem"]'
  );
  if (cmdMenu) {
    if (cmdMenu.querySelector?.(APP_QUIT_PROTECTED_SELECTOR)) {
      return "app quit controls";
    }
    if (cmdMenu.querySelector?.(SETTINGS_OPEN_PROTECTED_SELECTOR)) {
      return "Obsidian Settings controls";
    }
    const rawTitle =
      cmdMenu.querySelector?.(".menu-item-title, .suggestion-title")?.textContent ??
      cmdMenu.textContent ??
      "";
    const firstLine = normalizeText(rawTitle.split(/\r?\n/)[0]).toLowerCase();
    const unprefixed = firstLine.replace(/^[a-z0-9 _-]+:\s*/, "");
    if (
      firstLine === "quit" ||
      firstLine === "quit obsidian" ||
      firstLine === "close window" ||
      /^(?:quit obsidian|close window)\b/.test(firstLine) ||
      /^(?:quit obsidian|close window)\b/.test(unprefixed)
    ) {
      return "app quit controls";
    }
    if (
      firstLine.startsWith("herdr:") ||
      firstLine.startsWith("herdr ") ||
      firstLine === "open settings" ||
      /^(?:open settings|manage community plugins|toggle developer tools|reload app|open another vault|delete current file|show debug info)\b/.test(
        firstLine
      ) ||
      /^(?:open settings|manage community plugins|toggle developer tools|reload app|open another vault|delete current file|show debug info)\b/.test(
        unprefixed
      )
    ) {
      return "Obsidian Settings, Herdr, or developer controls";
    }
  }
  const modal = findClosestElement(el, '.modal, .modal-container, [role="dialog"]');
  if (modal) {
    try {
      if (
        modal.querySelector?.(".mod-settings, .installed-plugins-container, .vertical-tabs-container") ||
        modal.querySelector?.(".modal-title")?.textContent?.trim() === "Settings"
      ) {
        return "the Obsidian Settings modal";
      }
    } catch {
      // Ignore query errors on minimal mocks.
    }
  }
  return null;
}

export function isProtectedElement(el: Element | null | undefined): boolean {
  return detectProtectedArea(el) !== null;
}

export function isPasswordField(
  win: Pick<Window, "getComputedStyle"> | null | undefined,
  el: Element | null | undefined
): boolean {
  if (!el) {
    return false;
  }
  const tag = el.tagName?.toLowerCase() ?? "";
  if (tag === "input") {
    const typeAttr = (
      el.getAttribute?.("type") ??
      (el as HTMLInputElement).type ??
      ""
    ).toLowerCase();
    if (typeAttr === "password") {
      return true;
    }
    const autocomplete = (el.getAttribute?.("autocomplete") ?? "").toLowerCase();
    if (autocomplete.includes("password")) {
      return true;
    }
  }
  try {
    const style = win?.getComputedStyle?.(el);
    const sec =
      (style as { webkitTextSecurity?: string } | undefined)?.webkitTextSecurity ||
      style?.getPropertyValue?.("-webkit-text-security");
    if (sec && sec !== "none") {
      return true;
    }
  } catch {
    // Ignore on minimal mocks
  }
  return false;
}

export function isAppQuitShortcut(keyCode: string, modifiers: readonly string[]): boolean {
  if (keyCode === "Q") {
    return (modifiers.includes("control") || modifiers.includes("meta")) && !modifiers.includes("alt");
  }
  if (keyCode === "W") {
    return (
      (modifiers.includes("control") || modifiers.includes("meta")) &&
      modifiers.includes("shift") &&
      !modifiers.includes("alt")
    );
  }
  if (keyCode === "F4") {
    return modifiers.includes("alt");
  }
  return false;
}

export function isSettingsOpenShortcut(keyCode: string, modifiers: readonly string[]): boolean {
  return (
    keyCode === "," &&
    (modifiers.includes("control") || modifiers.includes("meta")) &&
    !modifiers.includes("alt") &&
    !modifiers.includes("shift")
  );
}

export function isDevToolsOrReloadShortcut(
  keyCode: string,
  modifiers: readonly string[]
): string | null {
  if (keyCode === "F12") {
    return "Developer Tools shortcut";
  }
  if (
    keyCode === "I" &&
    ((modifiers.includes("control") && modifiers.includes("shift")) ||
      (modifiers.includes("meta") && (modifiers.includes("alt") || modifiers.includes("shift"))))
  ) {
    return "Developer Tools shortcut";
  }
  if (
    keyCode === "F5" ||
    (keyCode === "R" &&
      (modifiers.includes("control") || modifiers.includes("meta")) &&
      !modifiers.includes("alt"))
  ) {
    return "app reload shortcut";
  }
  return null;
}

export function isRestrictedShortcut(
  keyCode: string,
  modifiers: readonly string[]
): RestrictedShortcutMatch | null {
  if (isAppQuitShortcut(keyCode, modifiers)) {
    return {
      kind: "app_quit",
      label: "app quit shortcut",
      message:
        "Refused ui.press_key for app quit shortcut. Ask the user to quit Obsidian manually, or enable allowUiInProtectedAreas in Herdr settings if explicitly authorized.",
    };
  }
  if (isSettingsOpenShortcut(keyCode, modifiers)) {
    return {
      kind: "settings",
      label: "Settings shortcut",
      message:
        "Refused ui.press_key for Settings shortcut. Ask the user to open Obsidian Settings manually, or enable allowUiInProtectedAreas in Herdr settings if explicitly authorized.",
    };
  }
  const devOrReload = isDevToolsOrReloadShortcut(keyCode, modifiers);
  if (devOrReload) {
    return {
      kind: "dev_or_reload",
      label: devOrReload,
      message: `Refused ui.press_key for ${devOrReload}. Enable allowUiInProtectedAreas in Herdr settings if explicitly authorized.`,
    };
  }
  return null;
}

export function redactProtectedInspectElement(
  element: InspectedElement,
  allowProtected: boolean
): InspectedElement {
  if (!element.protected || allowProtected) {
    return element;
  }
  return {
    selector: element.selector,
    tag: element.tag,
    role: element.role,
    label: element.label,
    text: "",
    disabled: element.disabled,
    protected: true,
    rect: element.rect,
    ...(element.notePath !== undefined ? { notePath: element.notePath } : {}),
    ...(element.pane !== undefined ? { pane: element.pane } : {}),
    ...(element.activePane !== undefined ? { activePane: element.activePane } : {}),
  };
}

/**
 * Enforces UI control safety boundaries: protected Obsidian/Herdr areas, password fields,
 * restricted shortcuts, hit-test target coverage checks, and inspect redaction.
 */
export class UiSafetyGuard {
  private readonly win: Window;
  private readonly getAllowUiInProtectedAreas: () => boolean;

  constructor(win: Window, getAllowUiInProtectedAreas: () => boolean) {
    this.win = win;
    this.getAllowUiInProtectedAreas = getAllowUiInProtectedAreas;
  }

  isProtectedAreasAllowed(): boolean {
    try {
      return this.getAllowUiInProtectedAreas() === true;
    } catch {
      return false;
    }
  }

  isHerdrTerminalElement(el: Element | null | undefined): boolean {
    return isHerdrTerminalElement(el);
  }

  isProtectedSettingsElement(el: Element | null | undefined): boolean {
    return isProtectedSettingsElement(el);
  }

  isProtectedCommandId(commandId: string): boolean {
    return isProtectedCommandId(commandId);
  }

  detectProtectedArea(el: Element | null | undefined): string | null {
    return detectProtectedArea(el);
  }

  isProtectedElement(el: Element | null | undefined): boolean {
    return isProtectedElement(el);
  }

  isPasswordField(el: Element | null | undefined): boolean {
    return isPasswordField(this.win, el);
  }

  isRestrictedShortcut(
    keyCode: string,
    modifiers: readonly string[]
  ): RestrictedShortcutMatch | null {
    return isRestrictedShortcut(keyCode, modifiers);
  }

  assertShortcutAllowed(keyCode: string, modifiers: readonly string[]): void {
    if (this.isProtectedAreasAllowed()) {
      return;
    }
    const restricted = isRestrictedShortcut(keyCode, modifiers);
    if (restricted) {
      throw new UiControlError("ui_protected_area", restricted.message);
    }
  }

  assertElementNotProtected(el: Element | null | undefined, action: string): void {
    if (this.isProtectedAreasAllowed()) {
      return;
    }
    const area = detectProtectedArea(el);
    if (!area) {
      return;
    }
    throw new UiControlError(
      "ui_protected_area",
      `Refused ui.${action} inside ${area}. Ask the user to operate protected controls manually, or enable allowUiInProtectedAreas in Herdr settings if explicitly authorized.`
    );
  }

  elementAtPoint(point: { x: number; y: number }): Element | null {
    try {
      let el = this.win.document.elementFromPoint?.(point.x, point.y) ?? null;
      for (let depth = 0; depth < 8 && el; depth += 1) {
        const sr = (
          el as Element & {
            shadowRoot?: { elementFromPoint?: (x: number, y: number) => Element | null } | null;
          }
        ).shadowRoot;
        const inner = sr?.elementFromPoint?.(point.x, point.y) ?? null;
        if (!inner || inner === el) {
          break;
        }
        el = inner;
      }
      return el;
    } catch {
      return null;
    }
  }

  isElementWithinContainer(el: Element, container: Element): boolean {
    if (el === container || Boolean(container.contains?.(el))) {
      return true;
    }
    try {
      return typeof el.closest === "function" && el.closest(".workspace-leaf") === container;
    } catch {
      return false;
    }
  }

  /**
   * Validates the topmost element under the dispatch point right before input delivery so
   * overlays (protected Settings/Terminal areas or ordinary covering modals) block the event.
   */
  assertPointReceiverSafe(
    point: { x: number; y: number },
    action: string,
    expectedContainer?: Element | null
  ): void {
    const hit = this.elementAtPoint(point);
    if (!hit) {
      const vw = this.win.innerWidth || 0;
      const vh = this.win.innerHeight || 0;
      const outOfViewport =
        point.x < 0 || point.y < 0 || (vw > 0 && point.x > vw) || (vh > 0 && point.y > vh);
      if (outOfViewport && expectedContainer) {
        throw new UiControlError(
          "ui_target_covered",
          `Target for ui.${action} is outside the hit-testable viewport.`
        );
      }
      return;
    }
    this.assertElementNotProtected(hit, action);
    if (expectedContainer && !this.isElementWithinContainer(hit, expectedContainer)) {
      throw new UiControlError(
        "ui_target_covered",
        `Target for ui.${action} is covered by another element.`
      );
    }
  }

  findSelectedActivationElements(
    activeEl: Element | null,
    queryAll: (selector: string) => Element[]
  ): Element[] {
    if (!activeEl) {
      return [];
    }
    const seen = new Set<Element>();
    const out: Element[] = [];
    const pushIfShown = (cand: Element | null | undefined): void => {
      if (!cand || seen.has(cand) || (cand as { isConnected?: boolean }).isConnected === false) {
        return;
      }
      if (typeof this.win.getComputedStyle === "function") {
        try {
          const style = this.win.getComputedStyle(cand);
          if (style?.display === "none" || style?.visibility === "hidden") {
            return;
          }
        } catch {
          // Ignore mock style errors.
        }
      }
      seen.add(cand);
      out.push(cand);
    };

    const doc = this.win.document as Document & { getElementById?: (id: string) => Element | null };
    const activeDescId =
      typeof activeEl.getAttribute === "function"
        ? (activeEl.getAttribute("aria-activedescendant") ?? "").trim()
        : "";
    if (activeDescId) {
      const byId =
        doc.getElementById?.(activeDescId) ??
        (() => {
          try {
            return doc.querySelector?.(`[id="${activeDescId.replace(/["\\]/g, "\\$&")}"]`) ?? null;
          } catch {
            return null;
          }
        })();
      pushIfShown(byId);
    }

    const scope = findClosestElement(
      activeEl,
      '.prompt, .modal-container, .modal, .suggestion-container, .menu, [role="dialog"], [role="menu"], [role="listbox"]'
    );
    const selectedSelector =
      '.suggestion-item.is-selected, .menu-item.selected, .menu-item.is-selected, [role="option"][aria-selected="true"], [role="menuitem"][aria-selected="true"], [role="menuitem"].is-selected, [aria-selected="true"], .is-selected';
    const scopeQueryAll = (scope as { querySelectorAll?: (sel: string) => ArrayLike<Element> } | null)
      ?.querySelectorAll;
    if (scope && typeof scopeQueryAll === "function") {
      try {
        for (const item of Array.from(scopeQueryAll.call(scope, selectedSelector))) {
          pushIfShown(item);
        }
      } catch {
        // Ignore query errors on minimal mocks.
      }
      // Portaled suggestion popups can live as top-level siblings outside .modal/.prompt.
      for (const item of queryAll(`.suggestion-container ${selectedSelector}`)) {
        pushIfShown(item);
      }
    } else if (
      findClosestElement(activeEl, ".prompt-input, .menu, .suggestion-container") ||
      (typeof activeEl.matches === "function" && activeEl.matches(".prompt-input"))
    ) {
      for (const item of queryAll(
        `.prompt ${selectedSelector}, .suggestion-container ${selectedSelector}, .menu ${selectedSelector}`
      )) {
        pushIfShown(item);
      }
    }
    return out;
  }

  redactProtectedInspectElement(element: InspectedElement): InspectedElement {
    return redactProtectedInspectElement(element, this.isProtectedAreasAllowed());
  }
}
