/**
 * @summary Claude Bell — the client-side ear of the `bell` Claude Code plugin. The extension host runs where Claude Code runs (extensionKind workspace: local, SSH remote or WSL) and watches the hook's signal file (~/.claude/.claude-bell-signal, appended on every Stop / permission / idle event) two ways at once — a directory fs.watch for the event-driven path and a 700 ms stat poll as the floor on network and WSL file systems — comparing the size it saw last, never the watcher's own prev/cur pair. On growth it posts "ring" to a webview view in the Panel, and the webview — which VS Code always renders on the USER's machine — synthesizes a two-tone chime with Web Audio, so no sound file and no server speakers are needed. The webview creates its AudioContext at load and tries to resume it; a context the browser keeps suspended shows an «Enable sound» button and the extension raises one toast, so a locked bell is never silent about it. While alive the extension refreshes a marker file (~/.claude/.claude-bell-extension, a timestamp every 20 s) that the hook reads to skip its own OS player, so a local session rings once, not twice. The view is revealed once at startup so its webview exists, and retainContextWhenHidden keeps it ringing after the user switches the Panel back to the terminal. Every step — activation, watcher arm, signal growth, ring posted, webview ready/rang/locked — is one line in the «Claude Bell» output channel, the first place to read when it is silent. Commands: claudeBell.test (chime now), claudeBell.toggle (enable/disable); a status-bar bell mirrors the state and blinks on every ring.
 * @route claude-bell extension | "no sound over SSH" · "rings twice" (marker file missing or stale) · "no sound at all" → View → Output → Claude Bell
 * @example code --install-extension claude-bell-0.1.1.vsix
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
/** @type {vscode.OutputChannel|null} */
let out = null;
let pendingRings = 0;
let heartbeat = null;
let watchedPath = "";
let lastSize = -1;
/** @type {fs.FSWatcher|null} */
let dirWatcher = null;
let lockedToastShown = false;

/**
 * @param {string} line
 * @returns {void}
 */
const log = (line) => {
  if (out) out.appendLine(`${new Date().toISOString()} ${line}`);
};

/** @returns {vscode.WorkspaceConfiguration} */
const cfg = () => vscode.workspace.getConfiguration("claudeBell");

/** @returns {string} the signal file the hook appends to */
const signalPath = () => String(cfg().get("signalFile") || "") || path.join(os.homedir(), ".claude", ".claude-bell-signal");

/** @returns {string} the liveness marker the hook reads */
const markerPath = () => path.join(os.homedir(), ".claude", ".claude-bell-extension");

/**
 * @param {string} p
 * @returns {void} creates the file (and ~/.claude) when missing so watching has a target
 */
function ensureFile(p) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) fs.writeFileSync(p, "");
  } catch (e) {
    log(`ensureFile failed: ${e?.message}`);
  }
}

/**
 * @param {string} why
 * @returns {void} rings the webview now, or queues one ring until the view exists
 */
function ring(why) {
  if (!cfg().get("enabled")) {
    log(`ring skipped (disabled) — ${why}`);
    return;
  }
  if (status) {
    status.text = "$(bell-dot)";
    setTimeout(refreshStatus, 1500);
  }
  if (view) {
    view.webview.postMessage({ type: "ring", volume: Number(cfg().get("volume")) });
    log(`ring posted to webview — ${why}`);
  } else {
    pendingRings = 1;
    log(`ring queued, view not resolved yet — revealing — ${why}`);
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
  } catch (e) {
    log(`marker write failed: ${e?.message}`);
  }
}

/**
 * @param {string} source
 * @returns {void} stats the signal file and rings when it grew since the size seen last
 */
function checkSignal(source) {
  let size = 0;
  try {
    size = fs.statSync(watchedPath).size;
  } catch {
    return;
  }
  if (lastSize < 0) {
    lastSize = size;
    return;
  }
  if (size !== lastSize) {
    const grew = size > lastSize;
    lastSize = size;
    if (grew) ring(`signal grew to ${size} bytes (${source})`);
    else log(`signal file restarted at ${size} bytes (${source})`);
  }
}

/** @returns {void} (re)arms both watchers on the configured signal file */
function watchSignal() {
  if (watchedPath) fs.unwatchFile(watchedPath);
  if (dirWatcher) {
    try {
      dirWatcher.close();
    } catch {
      void 0;
    }
    dirWatcher = null;
  }
  watchedPath = signalPath();
  ensureFile(watchedPath);
  lastSize = -1;
  checkSignal("arm");
  fs.watchFile(watchedPath, { interval: POLL_MS }, () => checkSignal("poll"));
  try {
    dirWatcher = fs.watch(path.dirname(watchedPath), (_ev, name) => {
      if (!name || String(name) === path.basename(watchedPath)) checkSignal("fs.watch");
    });
    dirWatcher.on("error", (e) => log(`fs.watch error: ${e?.message}`));
  } catch (e) {
    log(`fs.watch unavailable, poll only: ${e?.message}`);
  }
  log(`watching ${watchedPath} (size ${lastSize})`);
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
<div id="state">starting</div>
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
async function unlocked() {
  const c = ensureCtx();
  if (c.state === "suspended") { try { await c.resume(); } catch (e) { void e; } }
  const ok = c.state === "running";
  document.getElementById("unlock").style.display = ok ? "none" : "";
  return ok;
}
async function chime(volume, why) {
  if (!(await unlocked())) { state("sound is locked by the browser policy — click Enable sound once"); vscode.postMessage({ type: "locked", why }); return; }
  const c = ctx;
  const v = Math.max(0, Math.min(1, Number(volume) || 0.6)) * 0.5;
  const t = c.currentTime;
  tone(c, 880, t, 0.55, v); tone(c, 1320, t + 0.12, 0.7, v * 0.8);
  state("rang at " + new Date().toLocaleTimeString() + " (" + why + ")");
  vscode.postMessage({ type: "rang", why });
}
window.addEventListener("message", (e) => { if (e.data && e.data.type === "ring") chime(e.data.volume, "signal"); });
document.getElementById("test").addEventListener("click", () => chime(0.6, "button"));
document.getElementById("unlock").addEventListener("click", async () => { if (await unlocked()) { state("sound enabled"); vscode.postMessage({ type: "unlocked" }); } });
unlocked().then((ok) => { state(ok ? "ready" : "sound is locked by the browser policy — click Enable sound once"); vscode.postMessage({ type: "ready", audio: ok ? "running" : "suspended" }); });
</script></body></html>`;
}

/**
 * @param {vscode.ExtensionContext} context
 * @returns {void}
 */
function activate(context) {
  out = vscode.window.createOutputChannel("Claude Bell");
  context.subscriptions.push(out);
  log(`activate — host ${vscode.env.remoteName || "local"} · home ${os.homedir()}`);

  const provider = {
    /**
     * @param {vscode.WebviewView} v
     * @returns {void}
     */
    resolveWebviewView(v) {
      view = v;
      v.webview.options = { enableScripts: true };
      v.webview.html = html(v.webview);
      log("webview view resolved");
      v.webview.onDidReceiveMessage((m) => {
        log(`webview → ${JSON.stringify(m)}`);
        if (m?.type === "ready" && pendingRings) {
          pendingRings = 0;
          ring("queued ring after view resolved");
        }
        if (m?.type === "locked" && !lockedToastShown) {
          lockedToastShown = true;
          vscode.window.showWarningMessage("Claude Bell: sound is locked until you click “Enable sound” in the Claude Bell panel once.");
        }
      });
      v.onDidChangeVisibility(() => log(`webview visible=${v.visible}`));
      v.onDidDispose(() => {
        view = null;
        log("webview view disposed");
      });
    },
  };
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }));

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.command = "claudeBell.toggle";
  context.subscriptions.push(status);
  refreshStatus();

  context.subscriptions.push(vscode.commands.registerCommand("claudeBell.test", () => ring("test command")));
  context.subscriptions.push(vscode.commands.registerCommand("claudeBell.toggle", async () => {
    await cfg().update("enabled", !cfg().get("enabled"), vscode.ConfigurationTarget.Global);
    refreshStatus();
    log(`enabled=${cfg().get("enabled")}`);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("claudeBell.signalFile")) watchSignal();
    if (e.affectsConfiguration("claudeBell.enabled")) refreshStatus();
  }));

  watchSignal();
  beat();
  heartbeat = setInterval(beat, HEARTBEAT_MS);
  vscode.commands.executeCommand(`${VIEW_ID}.focus`, { preserveFocus: true }).then(
    () => log("view revealed at startup"),
    (e) => log(`view reveal failed: ${e?.message}`),
  );
}

/** @returns {void} */
function deactivate() {
  if (heartbeat) clearInterval(heartbeat);
  if (watchedPath) fs.unwatchFile(watchedPath);
  if (dirWatcher) {
    try {
      dirWatcher.close();
    } catch {
      void 0;
    }
  }
  try {
    fs.unlinkSync(markerPath());
  } catch {
    void 0;
  }
}

module.exports = { activate, deactivate };
