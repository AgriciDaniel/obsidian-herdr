// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Daniel Agrici. Part of the UI control module, ported from Obsidian Control Center.
// See src/control/LICENSE and the NOTICE file in the repository root.

import electron from "electron";
import type { WebContentsLike } from "./ui-control";

interface ElectronRemoteLike {
  getCurrentWebContents?: () => WebContentsLike | null | undefined;
}

/**
 * Returns the main window's WebContents through the `remote` module that Obsidian
 * desktop ships. Returns null when it is missing, so UI tools report a clear error
 * instead of breaking the rest of the plugin.
 */
export function getObsidianWebContents(): WebContentsLike | null {
  try {
    const remote = (electron as { remote?: ElectronRemoteLike } | undefined)?.remote;
    const wc = remote?.getCurrentWebContents?.();
    if (wc && typeof wc.capturePage === "function" && typeof wc.sendInputEvent === "function") {
      return wc;
    }
  } catch {
    // Fall through: UI control unavailable in this build
  }
  return null;
}
