// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Daniel Agrici. Part of the UI control module, ported from Obsidian Control Center.
// See src/control/LICENSE and the NOTICE file in the repository root.

/** Electron accelerator-style modifier names accepted by `webContents.sendInputEvent`. */
export type InputModifier = "shift" | "control" | "alt" | "meta";

export interface KeyPress {
  /** Value for Electron `keyCode` on keyDown and keyUp. */
  keyCode: string;
  /** Character to send as a `char` event, or null when the press produces no text. */
  text: string | null;
  modifiers: InputModifier[];
}

const NAMED_KEYS: Record<string, { keyCode: string; text: string | null }> = {
  Enter: { keyCode: "Enter", text: "\r" },
  Tab: { keyCode: "Tab", text: null },
  Escape: { keyCode: "Escape", text: null },
  Backspace: { keyCode: "Backspace", text: null },
  Delete: { keyCode: "Delete", text: null },
  ArrowLeft: { keyCode: "Left", text: null },
  ArrowUp: { keyCode: "Up", text: null },
  ArrowRight: { keyCode: "Right", text: null },
  ArrowDown: { keyCode: "Down", text: null },
  Home: { keyCode: "Home", text: null },
  End: { keyCode: "End", text: null },
  PageUp: { keyCode: "PageUp", text: null },
  PageDown: { keyCode: "PageDown", text: null },
  Space: { keyCode: "Space", text: " " },
};

export const SUPPORTED_KEY_NAMES = Object.keys(NAMED_KEYS);

const MODIFIER_ALIASES: Record<string, InputModifier | "mod"> = {
  control: "control",
  ctrl: "control",
  alt: "alt",
  option: "alt",
  shift: "shift",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  mod: "mod",
};

/**
 * Maps a named key, letter, or digit plus modifiers to an Electron key press.
 * `Mod` resolves to Cmd on macOS and Ctrl elsewhere, matching Obsidian hotkeys.
 * Free text belongs in `ui.type`; this only sends single key presses.
 */
export function buildKeyPress(
  key: string,
  modifiers: readonly string[] = [],
  platform: string = process.platform
): KeyPress {
  const mods = new Set<InputModifier>();
  for (const raw of modifiers) {
    const alias = MODIFIER_ALIASES[String(raw).toLowerCase()];
    if (!alias) {
      throw new Error(`Unknown modifier '${String(raw)}'. Use Mod, Ctrl, Alt, Shift, or Meta.`);
    }
    mods.add(alias === "mod" ? (platform === "darwin" ? "meta" : "control") : alias);
  }
  const ordered = (["shift", "control", "alt", "meta"] as const).filter((m) => mods.has(m));
  const producesText = !mods.has("control") && !mods.has("alt") && !mods.has("meta");

  const named = NAMED_KEYS[key];
  if (named) {
    return { keyCode: named.keyCode, text: producesText ? named.text : null, modifiers: ordered };
  }
  if (/^[a-zA-Z]$/.test(key)) {
    const upper = key.toUpperCase();
    const ch = mods.has("shift") ? upper : key.toLowerCase();
    return { keyCode: upper, text: producesText ? ch : null, modifiers: ordered };
  }
  if (/^[0-9]$/.test(key)) {
    return { keyCode: key, text: producesText ? key : null, modifiers: ordered };
  }
  throw new Error(
    `Unsupported key '${key}'. Use a letter, a digit, or one of: ${SUPPORTED_KEY_NAMES.join(", ")}. Use ui.type for text.`
  );
}
