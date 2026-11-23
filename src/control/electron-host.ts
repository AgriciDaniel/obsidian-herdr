// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Daniel Agrici. Part of the UI control module, ported from Obsidian Control Center.
// See src/control/LICENSE and the NOTICE file in the repository root.

import electron from "electron";
import type { WebContentsLike } from "./ui-control";

type CachedWebContentsLike = WebContentsLike & {
  isDestroyed?: () => boolean;
};

interface ElectronRemoteLike {
  getCurrentWebContents?: () => CachedWebContentsLike | null | undefined;
}

let cachedWebContents: CachedWebContentsLike | null = null;

/**
 * Returns the main window's WebContents through the `remote` module that Obsidian
 * desktop ships. Caches the resolved reference and revalidates if `isDestroyed()`
 * is true or missing. Returns null when unavailable, so UI tools report a clear
 * error instead of breaking the rest of the plugin.
 */
export function getObsidianWebContents(): WebContentsLike | null {
  if (cachedWebContents) {
    try {
      if (
        typeof cachedWebContents.isDestroyed === "function" &&
        !cachedWebContents.isDestroyed()
      ) {
        return cachedWebContents;
      }
    } catch {
      // Cached reference threw; re-resolve below.
    }
    cachedWebContents = null;
  }
  try {
    const remote = (electron as { remote?: ElectronRemoteLike } | undefined)?.remote;
    const wc = remote?.getCurrentWebContents?.();
    if (
      wc &&
      typeof wc.capturePage === "function" &&
      typeof wc.sendInputEvent === "function" &&
      (typeof wc.isDestroyed !== "function" || !wc.isDestroyed())
    ) {
      if (typeof wc.isDestroyed === "function") {
        cachedWebContents = wc;
      }
      return wc;
    }
  } catch {
    // Fall through: UI control unavailable in this build
  }
  return null;
}
