import type { ITheme } from "@xterm/xterm";

function resolveCssVars(
  styles: CSSStyleDeclaration,
  raw: string,
  depth = 0
): string {
  if (!raw || !raw.includes("var(") || depth >= 8) {
    return raw;
  }
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const idx = raw.indexOf("var(", i);
    if (idx === -1) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, idx);
    let cursor = idx + 4;
    let parenDepth = 1;
    let commaIdx = -1;
    while (cursor < raw.length && parenDepth > 0) {
      const ch = raw[cursor];
      if (ch === "(") {
        parenDepth += 1;
      } else if (ch === ")") {
        parenDepth -= 1;
      } else if (ch === "," && parenDepth === 1 && commaIdx === -1) {
        commaIdx = cursor;
      }
      cursor += 1;
    }
    if (parenDepth !== 0) {
      out += raw.slice(idx);
      break;
    }
    const endParen = cursor - 1;
    const varName = (commaIdx === -1
      ? raw.slice(idx + 4, endParen)
      : raw.slice(idx + 4, commaIdx)
    ).trim();
    const fallback = commaIdx === -1 ? "" : raw.slice(commaIdx + 1, endParen).trim();
    const resolved = varName.startsWith("--")
      ? styles.getPropertyValue(varName).trim()
      : "";
    out += resolved
      ? resolveCssVars(styles, resolved, depth + 1)
      : resolveCssVars(styles, fallback, depth + 1);
    i = cursor;
  }
  return out;
}

function readCssVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const raw = styles.getPropertyValue(name).trim();
  if (!raw) {
    return fallback;
  }
  const resolved = resolveCssVars(styles, raw).trim();
  if (!resolved || resolved.includes("var(")) {
    return fallback;
  }
  return resolved;
}

function parseRgbColor(color: string): [number, number, number] | null {
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  const rgbMatch = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i.exec(color.trim());
  if (rgbMatch) {
    return [
      Math.min(255, Number(rgbMatch[1])),
      Math.min(255, Number(rgbMatch[2])),
      Math.min(255, Number(rgbMatch[3])),
    ];
  }
  return null;
}

function deriveBrightAnsiColor(
  baseColor: string,
  isDark: boolean,
  fallbackBright: string
): string {
  const rgb = parseRgbColor(baseColor);
  if (!rgb) {
    return fallbackBright;
  }
  const ratio = isDark ? 0.24 : 0.18;
  const mix = (c: number) => Math.min(255, Math.max(0, Math.round(c + (255 - c) * ratio)));
  const toHex = (c: number) => c.toString(16).padStart(2, "0");
  return `#${toHex(mix(rgb[0]))}${toHex(mix(rgb[1]))}${toHex(mix(rgb[2]))}`;
}

/**
 * Builds an xterm.js color palette synchronized with Obsidian's active light or dark theme
 * CSS custom properties.
 */
export function buildObsidianXtermTheme(hostEl?: HTMLElement): ITheme {
  const doc = hostEl?.ownerDocument ?? (typeof document !== "undefined" ? document : undefined);
  const win = doc?.defaultView ?? (typeof window !== "undefined" ? window : undefined);
  const isDark = Boolean(doc?.body?.classList.contains("theme-dark"));

  if (!doc || !win) {
    return isDark ? DARK_FALLBACK_THEME : LIGHT_FALLBACK_THEME;
  }

  const target = hostEl || doc.body;
  const styles = win.getComputedStyle(target);

  const bg = readCssVar(
    styles,
    "--background-primary",
    isDark ? "#1a1b26" : "#ffffff"
  );
  const fg = readCssVar(styles, "--text-normal", isDark ? "#dcddde" : "#1f2328");
  const accent = readCssVar(
    styles,
    "--interactive-accent",
    isDark ? "#7aa2f7" : "#0969da"
  );
  const selectionFallback = isDark
    ? "rgba(122, 162, 247, 0.28)"
    : "rgba(9, 105, 218, 0.20)";
  const selectionBackground = readCssVar(styles, "--text-selection", selectionFallback);

  const red = readCssVar(styles, "--color-red", isDark ? "#f7768e" : "#cf222e");
  const green = readCssVar(styles, "--color-green", isDark ? "#9ece6a" : "#1a7f37");
  const yellow = readCssVar(styles, "--color-yellow", isDark ? "#e0af68" : "#9a6700");
  const blue = readCssVar(styles, "--color-blue", isDark ? "#7aa2f7" : "#0969da");
  const purple = readCssVar(styles, "--color-purple", isDark ? "#bb9af7" : "#8250df");
  const cyan = readCssVar(styles, "--color-cyan", isDark ? "#7dcfff" : "#1b7c83");

  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground,
    black: isDark ? "#15161e" : "#24292f",
    red,
    green,
    yellow,
    blue,
    magenta: purple,
    cyan,
    white: isDark ? "#a9b1d6" : "#6e7781",
    brightBlack: isDark ? "#565f89" : "#57606a",
    brightRed: deriveBrightAnsiColor(red, isDark, isDark ? "#ff9db0" : "#e5484d"),
    brightGreen: deriveBrightAnsiColor(green, isDark, isDark ? "#b9e887" : "#2ea043"),
    brightYellow: deriveBrightAnsiColor(yellow, isDark, isDark ? "#f0c987" : "#bf8700"),
    brightBlue: deriveBrightAnsiColor(blue, isDark, isDark ? "#9ab8ff" : "#218bff"),
    brightMagenta: deriveBrightAnsiColor(purple, isDark, isDark ? "#d1b8ff" : "#a475f9"),
    brightCyan: deriveBrightAnsiColor(cyan, isDark, isDark ? "#a4e2ff" : "#3192aa"),
    brightWhite: isDark ? "#c0caf5" : "#1f2328",
  };
}

const DARK_FALLBACK_THEME: ITheme = {
  background: "#1a1b26",
  foreground: "#dcddde",
  cursor: "#7aa2f7",
  selectionBackground: "rgba(122, 162, 247, 0.28)",
};

const LIGHT_FALLBACK_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#1f2328",
  cursor: "#0969da",
  selectionBackground: "rgba(9, 105, 218, 0.20)",
};

const BLOCKED_CANVAS_FAMILIES = new Set([
  "??",
  "ui-monospace",
  "sans-serif",
  "serif",
  "system-ui",
  "inherit",
  "initial",
  "unset",
]);

const DEFAULT_CANVAS_MONO_FALLBACKS = [
  '"DejaVu Sans Mono"',
  '"Liberation Mono"',
  '"Cascadia Mono"',
  '"SFMono-Regular"',
  '"Menlo"',
  '"Monaco"',
  '"Consolas"',
  '"Source Code Pro"',
  '"JetBrainsMono Nerd Font Mono"',
  '"JetBrains Mono"',
  "monospace",
];

function appendSanitizedFontTokens(
  raw: string,
  seen: Set<string>,
  ordered: string[],
  styles?: CSSStyleDeclaration
): void {
  if (!raw) {
    return;
  }
  const expanded = styles ? resolveCssVars(styles, raw) : raw;
  for (const token of expanded.split(",")) {
    const cleaned = token.trim().replace(/^['"]+|['"]+$/g, "").trim();
    if (!cleaned || cleaned.includes("var(")) {
      continue;
    }
    const lower = cleaned.toLowerCase();
    if (BLOCKED_CANVAS_FAMILIES.has(lower) || lower === "monospace") {
      continue;
    }
    if (!seen.has(lower)) {
      seen.add(lower);
      ordered.push(/[\s-]/.test(cleaned) ? `"${cleaned}"` : cleaned);
    }
  }
}

/**
 * Resolves a concrete HTML5 Canvas 2D compatible font-family list matching Obsidian's
 * active font configuration (--font-monospace-override, --font-monospace-theme, --font-monospace).
 * xterm.js assigns rawOptions.fontFamily directly to CanvasRenderingContext2D.font,
 * which rejects CSS var(...) expressions and proportional ui-monospace aliases on Linux.
 */
export function resolveTerminalFontFamily(
  hostEl?: HTMLElement,
  customOverride?: string
): string {
  const seen = new Set<string>();
  const ordered: string[] = [];

  const doc = hostEl?.ownerDocument ?? (typeof document !== "undefined" ? document : undefined);
  const win = doc?.defaultView ?? (typeof window !== "undefined" ? window : undefined);
  const styles = doc && win ? win.getComputedStyle(hostEl || doc.body) : undefined;

  if (customOverride && customOverride.trim()) {
    appendSanitizedFontTokens(customOverride, seen, ordered, styles);
  }

  if (styles) {
    const obsidianFontVars = [
      styles.getPropertyValue("--font-monospace-override"),
      styles.getPropertyValue("--font-monospace-theme"),
      styles.getPropertyValue("--font-monospace"),
      styles.getPropertyValue("--font-monospace-default"),
    ];

    for (const raw of obsidianFontVars) {
      appendSanitizedFontTokens(raw, seen, ordered, styles);
    }
  }

  for (const fallback of DEFAULT_CANVAS_MONO_FALLBACKS) {
    const lower = fallback.replace(/^['"]+|['"]+$/g, "").toLowerCase();
    if (lower === "monospace") {
      continue;
    }
    if (!seen.has(lower)) {
      seen.add(lower);
      ordered.push(fallback);
    }
  }

  ordered.push("monospace");
  return ordered.join(", ");
}
