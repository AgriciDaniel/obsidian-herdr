import * as fs from "node:fs";
import * as path from "node:path";
import { createFakeDomEnvironment, type FakeDomNode } from "./helpers/fake-dom";

export const __mockMenus: Menu[] = [];
export const __mockModals: Modal[] = [];

export function resetObsidianUiMocks(): void {
  __mockMenus.length = 0;
  __mockModals.length = 0;
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

export class FileSystemAdapter {
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  getBasePath(): string {
    return this.basePath;
  }
}

export abstract class TAbstractFile {
  path: string;
  name: string;
  parent: TFolder | null = null;

  constructor(relPath: string) {
    this.path = normalizePath(relPath);
    this.name = path.posix.basename(this.path);
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class TFile extends TAbstractFile {
  basename: string;
  extension: string;
  stat: { ctime: number; mtime: number; size: number };

  constructor(relPath: string, size = 0, mtime = Date.now()) {
    super(relPath);
    const ext = path.posix.extname(this.name);
    this.extension = ext.replace(/^\./, "");
    this.basename = ext ? this.name.slice(0, -ext.length) : this.name;
    this.stat = { ctime: mtime, mtime, size };
  }
}

export class MarkdownView {
  file: TFile | null = null;
  editor = {
    selection: "",
    cursor: { line: 0, ch: 0 },
    getSelection(): string {
      return this.selection;
    },
    getCursor(): { line: number; ch: number } {
      return this.cursor;
    },
    replaceSelection(text: string): void {
      this.selection = text;
    },
    replaceRange(_text: string, _pos: { line: number; ch: number }): void {
      // Mock no-op
    },
  };
}

export class Notice {
  readonly message: string;
  constructor(message: string, _timeout?: number) {
    this.message = message;
  }
}

export function setIcon(_el: unknown, _iconId: string): void {
  // Mock no-op
}

export function requireApiVersion(_version: string): boolean {
  return true;
}

export class Component {
  registerEvent(_ref: unknown): void {}
  registerDomEvent(_el: unknown, _ev: string, _cb: unknown): void {}
  registerInterval(id: number): number {
    return id;
  }
  load(): void {}
  unload(): void {}
}

export class MarkdownRenderChild extends Component {
  containerEl: unknown;
  constructor(containerEl: unknown) {
    super();
    this.containerEl = containerEl;
  }
}

export class ItemView extends Component {
  app: unknown;
  leaf: unknown;
  contentEl: FakeDomNode;
  containerEl: FakeDomNode;
  constructor(leaf: unknown) {
    super();
    this.leaf = leaf;
    this.app = (leaf as { app?: unknown })?.app;
    const dom = createFakeDomEnvironment();
    this.containerEl = dom.createNode("div");
    this.contentEl = this.containerEl.createDiv();
  }
  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
  getIcon(): string {
    return "";
  }
  async setState(_state: unknown, _result: unknown): Promise<void> {}
}

export class BasesView extends Component {
  app: unknown;
  data: unknown;
  constructor(_controller: unknown) {
    super();
  }
}

export class Modal {
  app: unknown;
  contentEl: FakeDomNode;
  modalEl: FakeDomNode;
  scopeHandlers: Record<string, () => unknown> = {};
  scope = {
    register: (mods: string[], key: string, cb: () => unknown) => {
      const k = mods.length > 0 ? `${mods.join("+")}+${key}` : key;
      this.scopeHandlers[k] = cb;
      return cb;
    },
  };
  constructor(app: unknown) {
    this.app = app;
    const dom = createFakeDomEnvironment();
    this.modalEl = dom.createNode("div", { cls: "modal" });
    this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
    __mockModals.push(this);
  }
  open(): void {
    this.onOpen();
  }
  close(): void {
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

export class FuzzySuggestModal<T> extends Modal {
  placeholder = "";
  setPlaceholder(placeholder: string): void {
    this.placeholder = placeholder;
  }
  getItems(): T[] {
    return [];
  }
  getItemText(_item: T): string {
    return "";
  }
  onChooseItem(_item: T, _evt: unknown): void {}
}

export class Menu {
  items: Array<{
    title: string;
    icon?: string;
    disabled?: boolean;
    warning?: boolean;
    sep?: boolean;
    onClick?: () => void;
  }> = [];
  constructor() {
    __mockMenus.push(this);
  }
  addItem(cb: (item: {
    setTitle: (t: string) => unknown;
    setIcon: (i: string) => unknown;
    setSection: (s: string) => unknown;
    setDisabled: (d: boolean) => unknown;
    setWarning: (w: boolean) => unknown;
    onClick: (fn: () => void) => unknown;
  }) => void): this {
    const rec: {
      title: string;
      icon?: string;
      disabled?: boolean;
      warning?: boolean;
      onClick?: () => void;
    } = { title: "" };
    const api = {
      setTitle(t: string) { rec.title = t; return api; },
      setIcon(i: string) { rec.icon = i; return api; },
      setSection(_s: string) { return api; },
      setDisabled(d: boolean) { rec.disabled = Boolean(d); return api; },
      setWarning(w: boolean) { rec.warning = Boolean(w); return api; },
      onClick(fn: () => void) { rec.onClick = fn; return api; },
    };
    cb(api);
    this.items.push(rec);
    return this;
  }
  addSeparator(): this {
    this.items.push({ title: "", sep: true });
    return this;
  }
  showAtMouseEvent(_ev: unknown): void {}
  showAtPosition(_pos: { x: number; y: number }): void {}
}

export class Setting {
  settingEl: FakeDomNode;
  name = "";
  desc = "";
  buttons: Array<{ text: string; classes: string[]; handler?: () => void; buttonEl: FakeDomNode }> = [];
  dropdownOptions: Array<{ value: string; label: string }> = [];
  constructor(containerEl: unknown) {
    const parent = containerEl as Partial<FakeDomNode> | undefined;
    this.settingEl =
      typeof parent?.createDiv === "function"
        ? parent.createDiv({ cls: "setting-item" })
        : createFakeDomEnvironment().createNode("div", { cls: "setting-item" });
  }
  setName(name: string): this {
    this.name = name;
    this.settingEl.setAttr("data-setting-name", name);
    return this;
  }
  setDesc(desc: string): this {
    this.desc = desc;
    return this;
  }
  setHeading(): this {
    this.settingEl.addClass("setting-item-heading");
    return this;
  }
  setClass(cls: string): this {
    this.settingEl.addClass(cls);
    return this;
  }
  addText(cb: (c: Record<string, unknown>) => void): this {
    const inputEl = this.settingEl.createEl("input", { type: "text" });
    const c: Record<string, unknown> = { inputEl };
    c.setPlaceholder = (p: string) => { inputEl.placeholder = p; return c; };
    c.setValue = (v: string) => { inputEl.value = v; return c; };
    c.onChange = (fn: (v: string) => void) => {
      inputEl.addEventListener("input", () => fn(inputEl.value));
      return c;
    };
    cb(c);
    return this;
  }
  addTextArea(cb: (c: Record<string, unknown>) => void): this {
    const inputEl = this.settingEl.createEl("textarea");
    const c: Record<string, unknown> = { inputEl };
    c.setPlaceholder = (p: string) => { inputEl.placeholder = p; return c; };
    c.setValue = (v: string) => { inputEl.value = v; return c; };
    c.onChange = (fn: (v: string) => void) => {
      inputEl.addEventListener("input", () => fn(inputEl.value));
      return c;
    };
    cb(c);
    return this;
  }
  addDropdown(cb: (c: Record<string, unknown>) => void): this {
    const selectEl = this.settingEl.createEl("select");
    const c: Record<string, unknown> = { selectEl };
    c.addOption = (value: string, label: string) => {
      this.dropdownOptions.push({ value, label });
      selectEl.createEl("option", { text: label, attr: { value } });
      return c;
    };
    c.setValue = (v: string) => { selectEl.value = v; return c; };
    c.onChange = (fn: (v: string) => void) => {
      selectEl.addEventListener("change", () => fn(selectEl.value));
      return c;
    };
    cb(c);
    return this;
  }
  addToggle(cb: (c: Record<string, unknown>) => void): this {
    const toggleEl = this.settingEl.createDiv({ cls: "checkbox-container" });
    const c: Record<string, unknown> = { toggleEl };
    c.setValue = (v: boolean) => { toggleEl.setAttr("data-checked", v ? "true" : "false"); return c; };
    c.onChange = (fn: (v: boolean) => void) => {
      toggleEl.addEventListener("click", () => {
        const next = toggleEl.getAttr("data-checked") !== "true";
        toggleEl.setAttr("data-checked", next ? "true" : "false");
        fn(next);
      });
      return c;
    };
    cb(c);
    return this;
  }
  addButton(cb: (c: Record<string, unknown>) => void): this {
    const buttonEl = this.settingEl.createEl("button", { attr: { type: "button" } });
    const rec: { text: string; classes: string[]; handler?: () => void; buttonEl: FakeDomNode } = {
      text: "",
      classes: [],
      buttonEl,
    };
    const c: Record<string, unknown> = { buttonEl };
    c.setButtonText = (t: string) => {
      rec.text = t;
      buttonEl.setText(t);
      return c;
    };
    c.setCta = () => {
      rec.classes.push("mod-cta");
      buttonEl.addClass("mod-cta");
      return c;
    };
    c.setWarning = () => {
      rec.classes.push("mod-warning");
      buttonEl.addClass("mod-warning");
      return c;
    };
    c.setClass = (cls: string) => {
      rec.classes.push(cls);
      buttonEl.addClass(cls);
      return c;
    };
    c.setDisabled = (d: boolean) => {
      buttonEl.disabled = Boolean(d);
      return c;
    };
    c.onClick = (fn: () => void) => {
      rec.handler = fn;
      buttonEl.addEventListener("click", fn);
      return c;
    };
    cb(c);
    this.buttons.push(rec);
    return this;
  }
}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  id: string;
  name: string;
  containerEl: FakeDomNode;
  settingItems: unknown[] = [];
  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
    const p = plugin as { manifest?: { id?: string; name?: string } } | undefined;
    this.id = p?.manifest?.id || "herdr-obs";
    this.name = p?.manifest?.name || "Herdr";
    this.containerEl = createFakeDomEnvironment().createNode("div");
  }
  getSettingDefinitions(): unknown[] {
    return [];
  }
  getControlValue(_key: string): unknown {
    return undefined;
  }
  update(): void {
    this.settingItems = this.getSettingDefinitions();
  }
  display(): void {
    this.containerEl.empty();
    const defs = this.getSettingDefinitions();
    this.settingItems = defs;
    const renderItem = (raw: unknown): void => {
      const item = raw as {
        visible?: boolean | (() => boolean);
        items?: unknown[];
        render?: (setting: Setting, container: FakeDomNode) => void;
        name?: string;
        desc?: string;
        control?: { type?: string; key?: string; options?: Record<string, string> };
      };
      if (item.visible === false || (typeof item.visible === "function" && !item.visible())) {
        return;
      }
      if (item.items) {
        for (const child of item.items) {
          renderItem(child);
        }
        return;
      }
      const setting = new Setting(this.containerEl);
      if (item.render) {
        item.render(setting, this.containerEl);
        return;
      }
      if (item.name) setting.setName(item.name);
      if (item.desc) setting.setDesc(item.desc);
      if (item.control?.key) {
        const val = this.getControlValue(item.control.key);
        if (item.control.type === "dropdown" && item.control.options && !(String(val) in item.control.options)) {
          throw new Error(`Invalid dropdown value ${String(val)} for ${item.control.key}`);
        }
      }
    };
    for (const def of defs) {
      renderItem(def);
    }
  }
}

export class Plugin extends Component {
  app: unknown;
  manifest: Record<string, unknown> = {};
}

function parseSimpleFrontmatter(raw: string): {
  data: Record<string, unknown> | null;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) {
    return { data: null, body: raw };
  }
  const data: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const k = line.slice(0, colon).trim();
      const vRaw = line.slice(colon + 1).trim();
      try {
        data[k] = JSON.parse(vRaw);
      } catch {
        data[k] = vRaw.replace(/^["']|["']$/g, "");
      }
    }
  }
  return { data, body: match[2] };
}

function serializeSimpleFrontmatter(data: Record<string, unknown>, body: string): string {
  const keys = Object.keys(data);
  if (keys.length === 0) {
    return body;
  }
  const yamlLines = keys.map((k) => `${k}: ${JSON.stringify(data[k])}`);
  return `---\n${yamlLines.join("\n")}\n---\n${body}`;
}

export function createMockObsidianApp(vaultRoot: string, vaultName = "TestVault") {
  const files = new Map<string, TFile>();
  const folders = new Map<string, TFolder>();
  let activeFile: TFile | null = null;
  const executedCommands: string[] = [];

  const syncFromDisk = () => {
    files.clear();
    folders.clear();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        const abs = path.join(dir, entry.name);
        const rel = normalizePath(path.relative(vaultRoot, abs));
        if (entry.isDirectory()) {
          folders.set(rel, new TFolder(rel));
          walk(abs);
        } else if (entry.isFile()) {
          const st = fs.statSync(abs);
          files.set(rel, new TFile(rel, st.size, st.mtimeMs));
        }
      }
    };
    walk(vaultRoot);
  };

  syncFromDisk();

  const buildResolvedLinks = () => {
    const resolved: Record<string, Record<string, number>> = {};
    for (const [srcPath, f] of files.entries()) {
      if (f.extension !== "md") {
        continue;
      }
      resolved[srcPath] = {};
      const text = fs.readFileSync(path.join(vaultRoot, srcPath), "utf8");
      const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
      let m = re.exec(text);
      while (m !== null) {
        const targetRaw = m[1].trim();
        const targetCandidate = targetRaw.endsWith(".md") ? targetRaw : `${targetRaw}.md`;
        for (const candidatePath of files.keys()) {
          if (
            candidatePath === targetCandidate ||
            path.posix.basename(candidatePath) === path.posix.basename(targetCandidate)
          ) {
            resolved[srcPath][candidatePath] = (resolved[srcPath][candidatePath] || 0) + 1;
          }
        }
        m = re.exec(text);
      }
    }
    return resolved;
  };

  const vaultConfig: Record<string, unknown> = {};

  const app = {
    vault: {
      configDir: ".obsidian",
      config: vaultConfig,
      getConfig: (key: string) => vaultConfig[key],
      adapter: new FileSystemAdapter(vaultRoot),
      getName: () => vaultName,
      getFiles: () => Array.from(files.values()),
      getMarkdownFiles: () =>
        Array.from(files.values()).filter((f) => f.extension === "md"),
      getAbstractFileByPath: (relPath: string) => {
        const norm = normalizePath(relPath);
        return files.get(norm) || folders.get(norm) || null;
      },
      read: (file: TFile) =>
        Promise.resolve(fs.readFileSync(path.join(vaultRoot, file.path), "utf8")),
      cachedRead: (file: TFile) =>
        Promise.resolve(fs.readFileSync(path.join(vaultRoot, file.path), "utf8")),
      createFolder: (relPath: string) => {
        const norm = normalizePath(relPath);
        fs.mkdirSync(path.join(vaultRoot, norm), { recursive: true });
        const folder = new TFolder(norm);
        folders.set(norm, folder);
        return Promise.resolve(folder);
      },
      create: (relPath: string, content: string) => {
        const norm = normalizePath(relPath);
        const abs = path.join(vaultRoot, norm);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
        const st = fs.statSync(abs);
        const f = new TFile(norm, st.size, st.mtimeMs);
        files.set(norm, f);
        return Promise.resolve(f);
      },
      process: (file: TFile, fn: (data: string) => string) => {
        const abs = path.join(vaultRoot, file.path);
        const current = fs.readFileSync(abs, "utf8");
        const next = fn(current);
        fs.writeFileSync(abs, next, "utf8");
        const st = fs.statSync(abs);
        file.stat = { ctime: st.ctimeMs, mtime: st.mtimeMs, size: st.size };
        return Promise.resolve(next);
      },
      rename: (file: TFile, newPath: string) => {
        const oldNorm = file.path;
        const newNorm = normalizePath(newPath);
        const newAbs = path.join(vaultRoot, newNorm);
        fs.mkdirSync(path.dirname(newAbs), { recursive: true });
        fs.renameSync(path.join(vaultRoot, oldNorm), newAbs);
        syncFromDisk();
        return Promise.resolve();
      },
      trash: (file: TFile, _system: boolean) => {
        const trashDir = path.join(vaultRoot, ".trash");
        fs.mkdirSync(trashDir, { recursive: true });
        fs.renameSync(
          path.join(vaultRoot, file.path),
          path.join(trashDir, path.posix.basename(file.path))
        );
        syncFromDisk();
        return Promise.resolve();
      },
    },
    metadataCache: {
      get resolvedLinks() {
        return buildResolvedLinks();
      },
      unresolvedLinks: {} as Record<string, Record<string, number>>,
      getFileCache: (file: TFile) => {
        if (file.extension !== "md") {
          return null;
        }
        const raw = fs.readFileSync(path.join(vaultRoot, file.path), "utf8");
        const { data: frontmatter } = parseSimpleFrontmatter(raw);
        const tags: Array<{ tag: string }> = [];
        const tagRe = /(?:^|\s)(#[A-Za-z0-9_/-]+)/g;
        let tm = tagRe.exec(raw);
        while (tm !== null) {
          tags.push({ tag: tm[1] });
          tm = tagRe.exec(raw);
        }
        const headings: Array<{
          level: number;
          heading: string;
          position: { start: { line: number } };
        }> = [];
        const lines = raw.split(/\r?\n/);
        lines.forEach((line, idx) => {
          const hm = /^(#{1,6})\s+(.+)$/.exec(line);
          if (hm) {
            headings.push({
              level: hm[1].length,
              heading: hm[2].trim(),
              position: { start: { line: idx } },
            });
          }
        });
        return { frontmatter, tags, headings, links: [] };
      },
    },
    fileManager: {
      processFrontMatter: (file: TFile, fn: (fm: Record<string, unknown>) => void) => {
        const abs = path.join(vaultRoot, file.path);
        const raw = fs.readFileSync(abs, "utf8");
        const parsed = parseSimpleFrontmatter(raw);
        const fm = parsed.data ? { ...parsed.data } : {};
        fn(fm);
        const updated = serializeSimpleFrontmatter(fm, parsed.body);
        fs.writeFileSync(abs, updated, "utf8");
        syncFromDisk();
        return Promise.resolve();
      },
      renameFile: (file: TFile, newPath: string) => {
        const oldNorm = file.path;
        const newNorm = normalizePath(newPath);
        const oldBase = file.basename;
        const newAbs = path.join(vaultRoot, newNorm);
        fs.mkdirSync(path.dirname(newAbs), { recursive: true });
        fs.renameSync(path.join(vaultRoot, oldNorm), newAbs);
        syncFromDisk();
        const renamedFile = files.get(newNorm);
        if (renamedFile) {
          for (const other of files.values()) {
            if (other.extension === "md" && other.path !== newNorm) {
              const otherAbs = path.join(vaultRoot, other.path);
              const body = fs.readFileSync(otherAbs, "utf8");
              const updated = body.replace(
                new RegExp(`\\[\\[${oldBase}(\\|[^\\]]*)?\\]\\]`, "g"),
                `[[${renamedFile.basename}$1]]`
              );
              if (updated !== body) {
                fs.writeFileSync(otherAbs, updated, "utf8");
              }
            }
          }
        }
        return Promise.resolve();
      },
      trashFile: (file: TFile) => {
        const trashDir = path.join(vaultRoot, ".trash");
        fs.mkdirSync(trashDir, { recursive: true });
        fs.renameSync(
          path.join(vaultRoot, file.path),
          path.join(trashDir, path.posix.basename(file.path))
        );
        syncFromDisk();
        return Promise.resolve();
      },
    },
    workspace: {
      getActiveFile: () => activeFile,
      getActiveViewOfType: () => null,
      iterateAllLeaves: () => undefined,
      getLeaf: () => ({
        openFile: (f: TFile) => {
          activeFile = f;
          return Promise.resolve();
        },
      }),
      revealLeaf: () => Promise.resolve(),
    },
    commands: {
      commands: {
        "workspace:toggle-pin": { id: "workspace:toggle-pin", name: "Toggle pin" },
        "app:delete-file": { id: "app:delete-file", name: "Delete current file" },
      },
      executeCommandById: (id: string) => {
        if (id === "workspace:toggle-pin") {
          executedCommands.push(id);
          return true;
        }
        return false;
      },
    },
    _getExecutedCommands: () => executedCommands,
  };

  return app;
}
