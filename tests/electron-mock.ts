// Stand-in for Electron in the test bundle. The plugin reads `remote` from it and copes
// with it being absent, which is what this gives.
const electron: Record<string, unknown> = {};
export default electron;
