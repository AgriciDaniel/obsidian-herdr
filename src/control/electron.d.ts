// SPDX-License-Identifier: Apache-2.0
// Minimal ambient declaration: Obsidian desktop provides "electron" at runtime.
declare module "electron" {
  const electron: unknown;
  export default electron;
}
