/**
 * @summary The `vscode:uninstall` script VS Code runs after Claude Bell is uninstalled: removes exactly the hook entries the extension wrote into Claude Code's ~/.claude/settings.json (the ones carrying the claude-bell token) and nothing else; a missing or unreadable settings file is left alone.
 * @example node ./uninstall.js
 */
const { removeHooks } = require("./hook-install.js");

const r = removeHooks((line) => console.log(`[claude-bell] ${line}`));
console.log(`[claude-bell] uninstall: ${r.changed ? "hook removed" : r.error ? `nothing changed (${r.error})` : "no hook to remove"} — ${r.path}`);
