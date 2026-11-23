import { Notice, TFile, type App } from "obsidian";
import type { HerdrLayoutNode } from "../domain/types";
import { confirmAction } from "../ui/modals";
import type { HerdrCoordinator } from "./herdr-coordinator";

function countLayoutPanes(node: HerdrLayoutNode, depth = 0): number {
  if (depth > 32) {
    throw new Error("Layout tree exceeds maximum nesting depth (32).");
  }
  if (node.type === "pane") {
    return 1;
  }
  if (node.type === "split" && node.first && node.second) {
    return countLayoutPanes(node.first, depth + 1) + countLayoutPanes(node.second, depth + 1);
  }
  throw new Error("Invalid Herdr layout node structure.");
}

export async function saveTabLayoutToNote(
  app: App,
  coordinator: HerdrCoordinator,
  wsLabel: string,
  tabId: string,
  tabLabel: string
): Promise<void> {
  try {
    const exported = await coordinator.socket.exportLayout({ tabId });
    const safeWs =
      wsLabel.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
    const safeTab =
      tabLabel.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
      tabId.replace(/[^A-Za-z0-9_-]+/g, "-");
    const notePath = `Herdr Layouts/${safeWs}-${safeTab}.md`;
    const content = [
      "---",
      "type: herdr-layout",
      `workspace: "${wsLabel.replace(/"/g, "'")}"`,
      `tab: "${tabLabel.replace(/"/g, "'")}"`,
      "---",
      "",
      `# Herdr Layout: ${wsLabel} / ${tabLabel}`,
      "",
      "Open Mission Control -> More actions -> **Apply layout from note** while viewing this note to recreate this split tree.",
      "",
      "```json",
      JSON.stringify(exported, null, 2),
      "```",
      "",
    ].join("\n");

    await coordinator.vaultOps.dispatch(
      "vault.create_note",
      { path: notePath, content, overwrite: true },
      "mission-control-layout"
    );
    const created = app.vault.getAbstractFileByPath(notePath);
    if (created instanceof TFile) {
      await app.workspace.getLeaf("tab").openFile(created);
    }
    new Notice(`Saved Herdr layout to '${notePath}'.`);
  } catch (err) {
    new Notice(`Layout export failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function applyLayoutFromActiveNote(
  app: App,
  coordinator: HerdrCoordinator,
  workspaceId?: string
): Promise<void> {
  const activeFile = app.workspace.getActiveFile();
  if (!activeFile) {
    new Notice("Open a Markdown layout note first.");
    return;
  }
  try {
    const raw = await app.vault.cachedRead(activeFile);
    const fenceMatch = /```json\s*([\s\S]*?)```/i.exec(raw);
    const jsonBody = fenceMatch ? fenceMatch[1].trim() : raw.trim();
    const parsed = JSON.parse(jsonBody) as {
      root?: HerdrLayoutNode;
      type?: string;
    };
    const rootNode =
      parsed.root ??
      (parsed.type === "pane" || parsed.type === "split"
        ? (parsed as unknown as HerdrLayoutNode)
        : undefined);
    if (!rootNode) {
      new Notice("Active note does not contain a valid Herdr layout JSON root node.");
      return;
    }
    const paneCount = countLayoutPanes(rootNode);
    const confirmed = await confirmAction(app, {
      title: `Apply layout from '${activeFile.basename}'?`,
      body: `This will open ${paneCount} Herdr ${paneCount === 1 ? "pane" : "panes"} and run any pane commands defined in the note's JSON layout.`,
      confirmText: "Apply layout",
    });
    if (!confirmed) {
      return;
    }
    await coordinator.socket.applyLayout({
      root: rootNode,
      workspaceId,
      tabLabel: activeFile.basename.slice(0, 32),
      focus: true,
      env: coordinator.getBridgeEnv(),
    });
    await coordinator.refreshAll(false);
    new Notice(`Applied Herdr layout from '${activeFile.basename}'.`);
  } catch (err) {
    new Notice(`Layout apply failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
