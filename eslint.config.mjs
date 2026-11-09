import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: [
            "Obsidian",
            "Herdr",
            "obs-herdr",
            "Claude",
            "Claude Code",
            "Codex",
            "OpenCode",
            "Gemini",
            "Antigravity",
            "Cursor CLI",
            "Grok",
            "Copilot",
            "Devin",
            "Kimi",
            "Qwen",
            "Pi",
            "Hermes Agent",
            "Factory Droid",
            "Qwen Code",
            "Kilo Code",
            "Mastra Code",
            "Oh My Pi",
            "Git",
            "GitHub",
            "Markdown",
            "Bases",
            "Canvas",
            "Python",
            "PowerShell",
            "Linux",
            "macOS",
            "Windows",
            "Unix",
            "Mission Control",
            "Vault Control Bridge",
            "xterm.js",
            "APIs"
          ],
          acronyms: [
            "AI",
            "PTY",
            "TUI",
            "CLI",
            "API",
            "RPC",
            "IPC",
            "MCP",
            "SSH",
            "OSC",
            "ANSI",
            "CWD",
            "PID",
            "ID",
            "URI",
            "URL",
            "JSON",
            "NDJSON",
            "TOML",
            "YAML",
            "UTF",
            "CSS",
            "DOM",
            "RW",
            "RO",
            "SHA",
            "BSP",
            "EOF"
          ],
          enforceCamelCaseLower: true
        }
      ]
    },
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname
      }
    }
  }
);
