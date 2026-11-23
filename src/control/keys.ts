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
  F1: { keyCode: "F1", text: null },
  F2: { keyCode: "F2", text: null },
  F3: { keyCode: "F3", text: null },
  F4: { keyCode: "F4", text: null },
  F5: { keyCode: "F5", text: null },
  F6: { keyCode: "F6", text: null },
  F7: { keyCode: "F7", text: null },
  F8: { keyCode: "F8", text: null },
  F9: { keyCode: "F9", text: null },
  F10: { keyCode: "F10", text: null },
  F11: { keyCode: "F11", text: null },
  F12: { keyCode: "F12", text: null },
};

const NAMED_KEY_ALIASES: Record<string, { keyCode: string; text: string | null }> = (() => {
  const map: Record<string, { keyCode: string; text: string | null }> = {};
  for (const [name, spec] of Object.entries(NAMED_KEYS)) {
    map[name.toLowerCase()] = spec;
  }
  map.return = NAMED_KEYS.Enter;
  map.esc = NAMED_KEYS.Escape;
  map.del = NAMED_KEYS.Delete;
  map.left = NAMED_KEYS.ArrowLeft;
  map.right = NAMED_KEYS.ArrowRight;
  map.up = NAMED_KEYS.ArrowUp;
  map.down = NAMED_KEYS.ArrowDown;
  map.pgup = NAMED_KEYS.PageUp;
  map.pgdn = NAMED_KEYS.PageDown;
  map.spacebar = NAMED_KEYS.Space;
  return map;
})();

const DIGIT_SHIFTED: Record<string, string> = {
  "0": ")",
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
};

const SHIFTED_DIGIT_KEYS = new Set(Object.values(DIGIT_SHIFTED));

const PUNCTUATION_SHIFTED: Record<string, string> = {
  "=": "+",
  "-": "_",
  "[": "{",
  "]": "}",
  ";": ":",
  "'": "\"",
  ",": "<",
  ".": ">",
  "/": "?",
  "\\": "|",
  "`": "~",
};

const SHIFTED_PUNCTUATION_KEYS = new Set(Object.values(PUNCTUATION_SHIFTED));

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

  const named = NAMED_KEYS[key] ?? NAMED_KEY_ALIASES[key.toLowerCase()];
  if (named) {
    return { keyCode: named.keyCode, text: producesText ? named.text : null, modifiers: ordered };
  }
  if (/^[a-zA-Z]$/.test(key)) {
    const upper = key.toUpperCase();
    const ch = mods.has("shift") ? upper : key.toLowerCase();
    return { keyCode: upper, text: producesText ? ch : null, modifiers: ordered };
  }
  if (/^[0-9]$/.test(key)) {
    const ch = mods.has("shift") ? DIGIT_SHIFTED[key] : key;
    return { keyCode: key, text: producesText ? ch : null, modifiers: ordered };
  }
  if (SHIFTED_DIGIT_KEYS.has(key)) {
    return { keyCode: key, text: producesText ? key : null, modifiers: ordered };
  }
  if (Object.prototype.hasOwnProperty.call(PUNCTUATION_SHIFTED, key)) {
    const ch = mods.has("shift") ? PUNCTUATION_SHIFTED[key] : key;
    return { keyCode: key, text: producesText ? ch : null, modifiers: ordered };
  }
  if (SHIFTED_PUNCTUATION_KEYS.has(key)) {
    return { keyCode: key, text: producesText ? key : null, modifiers: ordered };
  }
  throw new Error(
    `Unsupported key '${key}'. Use a letter, a digit, or one of: ${SUPPORTED_KEY_NAMES.join(", ")}. Use ui.type for text.`
  );
}
