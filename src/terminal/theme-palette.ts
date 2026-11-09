import type { ITheme } from "@xterm/xterm";

function readCssVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const val = styles.getPropertyValue(name).trim();
  return val || fallback;
}

/**
 * Builds an xterm.js color palette synchronized with Obsidian's active light or dark theme
 * CSS custom properties.
 */
export function buildObsidianXtermTheme(hostEl?: HTMLElement): ITheme {
  const isDark =
    typeof document !== "undefined" && document.body.classList.contains("theme-dark");

  if (typeof window === "undefined" || typeof document === "undefined") {
    return isDark ? DARK_FALLBACK_THEME : LIGHT_FALLBACK_THEME;
  }

  const target = hostEl || document.body;
  const styles = window.getComputedStyle(target);

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
    selectionBackground: isDark ? "rgba(122, 162, 247, 0.28)" : "rgba(9, 105, 218, 0.20)",
    black: isDark ? "#15161e" : "#24292f",
    red,
    green,
    yellow,
    blue,
    magenta: purple,
    cyan,
    white: isDark ? "#a9b1d6" : "#6e7781",
    brightBlack: isDark ? "#565f89" : "#57606a",
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: purple,
    brightCyan: cyan,
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
  ordered: string[]
): void {
  if (!raw || raw.includes("var(")) {
    return;
  }
  for (const token of raw.split(",")) {
    const cleaned = token.trim().replace(/^['"]+|['"]+$/g, "").trim();
    if (!cleaned) {
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

  if (customOverride && customOverride.trim()) {
    appendSanitizedFontTokens(customOverride, seen, ordered);
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const target = hostEl || document.body;
    const styles = window.getComputedStyle(target);
    const obsidianFontVars = [
      styles.getPropertyValue("--font-monospace-override"),
      styles.getPropertyValue("--font-monospace-theme"),
      styles.getPropertyValue("--font-monospace"),
      styles.getPropertyValue("--font-monospace-default"),
    ];

    for (const raw of obsidianFontVars) {
      appendSanitizedFontTokens(raw, seen, ordered);
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
