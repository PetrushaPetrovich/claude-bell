/**
 * @summary Claude Bell — the client-side ear of the `bell` Claude Code plugin. The extension host runs where Claude Code runs (extensionKind workspace: local, SSH remote or WSL) and polls the hook's signal file (~/.claude/.claude-bell-signal, appended on every Stop / permission / idle event); on growth it posts "ring" to a webview view in the Panel, and the webview — which VS Code always renders on the USER's machine — synthesizes a two-tone chime with Web Audio, so no sound file and no server speakers are needed. While alive the extension refreshes a marker file (~/.claude/.claude-bell-extension, a timestamp every 20 s) that the hook reads to skip its own OS player, so a local session rings once, not twice. The view is revealed once at startup so its webview exists, and retainContextWhenHidden keeps it ringing after the user switches the Panel back to the terminal. Commands: claudeBell.test (chime now), claudeBell.toggle (enable/disable); a status-bar bell mirrors the state.
 * @route claude-bell extension | "no sound over SSH" · "rings twice" (marker file missing or stale) · "no sound at all" (view never revealed in this window, or the webview's AudioContext is suspended — the view shows a button to unlock it)
 * @example code --install-extension claude-bell-0.1.0.vsix
 */
const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const POLL_MS = 700;
const HEARTBEAT_MS = 20000;
const VIEW_ID = "claudeBell.player";

/** @type {vscode.WebviewView|null} */
let view = null;
/** @type {vscode.StatusBarItem|null} */
let status = null;
let pendingRings = 0;
let heartbeat = null;
let watchedPath = "";

/** @returns {vscode.WorkspaceConfiguration} */
const cfg = () => vscode.workspace.getConfiguration("claudeBell");

/** @returns {string} the signal file the hook appends to */
const signalPath = () => String(cfg().get("signalFile") || "") || path.join(os.homedir(), ".claude", ".claude-bell-signal");

/** @returns {string} the liveness marker the hook reads */
const markerPath = () => path.join(os.homedir(), ".claude", ".claude-bell-extension");

/**
 * @param {string} p
 * @returns {void} creates the file (and ~/.claude) when missing so polling has a target
 */
function ensureFile(p) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) fs.writeFileSync(p, "");
  } catch {
    void 0;
  }
}

/** @returns {void} rings the webview now, or queues one ring until the view exists */
function ring() {
  if (!cfg().get("enabled")) return;
  if (view) {
    view.webview.postMessage({ type: "ring", volume: Number(cfg().get("volume")) });
  } else {
    pendingRings = 1;
    vscode.commands.executeCommand(`${VIEW_ID}.focus`, { preserveFocus: true });
  }
}

/** @returns {void} */
function refreshStatus() {
  if (!status) return;
  const on = cfg().get("enabled");
  status.text = on ? "$(bell)" : "$(bell-slash)";
  status.tooltip = on ? "Claude Bell: on — click to disable" : "Claude Bell: off — click to enable";
  status.show();
}

/** @returns {void} writes the liveness marker the hook reads */
function beat() {
  try {
    fs.writeFileSync(markerPath(), String(Date.now()));
  } catch {
    void 0;
  }
}

/** @returns {void} (re)arms the poller on the configured signal file */
function watchSignal() {
  if (watchedPath) fs.unwatchFile(watchedPath);
  watchedPath = signalPath();
  ensureFile(watchedPath);
  fs.watchFile(watchedPath, { interval: POLL_MS }, (cur, prev) => {
    if (cur.size > prev.size || (cur.mtimeMs !== prev.mtimeMs && cur.size !== prev.size)) ring();
  });
}

/**
 * @param {vscode.Webview} webview
 * @returns {string} the player page: a Web Audio chime, an unlock button for a suspended AudioContext, one line of state
 */
function html(webview) {
  const nonce = String(Date.now());
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:8px 12px;font-size:12px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:4px 10px;border-radius:2px;cursor:pointer}
#state{opacity:.8;margin-top:6px}
</style></head><body>
<div>Claude Bell rings here when Claude Code finishes its turn or waits for you. Keep this view open in the Panel (any tab may be active).</div>
<div style="margin-top:8px"><button id="test">Play test chime</button> <button id="unlock" style="display:none">Enable sound</button></div>
<div id="state">ready</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let ctx = null;
const state = (t) => { document.getElementById("state").textContent = t; };
function ensureCtx() { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); return ctx; }
function tone(c, f, t0, dur, gain) {
  const o = c.createOscillator(); const g = c.createGain();
  o.type = "sine"; o.frequency.value = f;
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + dur + 0.05);
}
async function chime(volume) {
  const c = ensureCtx();
  if (c.state === "suspended") { try { await c.resume(); } catch (e) { void e; } }
  if (c.state !== "running") { document.getElementById("unlock").style.display = ""; state("sound is locked by the browser policy — click Enable sound once"); vscode.postMessage({ type: "locked" }); return; }
  const v = Math.max(0, Math.min(1, Number(volume) || 0.6)) * 0.5;
  const t = c.currentTime;
  tone(c, 880, t, 0.55, v); tone(c, 1320, t + 0.12, 0.7, v * 0.8);
  state("rang at " + new Date().toLocaleTimeString());
}
window.addEventListener("message", (e) => { if (e.data && e.data.type === "ring") chime(e.data.volume); });
document.getElementById("test").addEventListener("click", () => chime(0.6));
document.getElementById("unlock").addEventListener("click", async () => { await ensureCtx().resume(); document.getElementById("unlock").style.display = "none"; state("sound enabled"); vscode.postMessage({ type: "unlocked" }); });
vscode.postMessage({ type: "ready" });
</script></body></html>`;
}

/**
 * @param {vscode.ExtensionContext} context
 * @returns {void}
 */
function activate(context) {
  const provider = {
    /**
     * @param {vscode.WebviewView} v
     * @returns {void}
     */
    resolveWebviewView(v) {
      view = v;
      v.webview.options = { enableScripts: true };
      v.webview.html = html(v.webview);
      v.webview.onDidReceiveMessage((m) => {
        if (m?.type === "ready" && pendingRings) {
          pendingRings = 0;
          ring();
        }
        if (m?.type === "locked") vscode.window.showWarningMessage("Claude Bell: sound is locked until you click “Enable sound” in the Claude Bell panel once.");
      });
      v.onDidDispose(() => {
        view = null;
      });
    },
  };
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }));

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.command = "claudeBell.toggle";
  context.subscriptions.push(status);
  refreshStatus();

  context.subscriptions.push(vscode.commands.registerCommand("claudeBell.test", () => {
    if (view) view.webview.postMessage({ type: "ring", volume: Number(cfg().get("volume")) });
    else {
      pendingRings = 1;
      vscode.commands.executeCommand(`${VIEW_ID}.focus`, { preserveFocus: true });
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("claudeBell.toggle", async () => {
    await cfg().update("enabled", !cfg().get("enabled"), vscode.ConfigurationTarget.Global);
    refreshStatus();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("claudeBell.signalFile")) watchSignal();
    if (e.affectsConfiguration("claudeBell.enabled")) refreshStatus();
  }));

  watchSignal();
  beat();
  heartbeat = setInterval(beat, HEARTBEAT_MS);
  vscode.commands.executeCommand(`${VIEW_ID}.focus`, { preserveFocus: true });
}

/** @returns {void} */
function deactivate() {
  if (heartbeat) clearInterval(heartbeat);
  if (watchedPath) fs.unwatchFile(watchedPath);
  try {
    fs.unlinkSync(markerPath());
  } catch {
    void 0;
  }
}

module.exports = { activate, deactivate };
