/**
 * @summary Claude Bell — a self-contained chime for Claude Code inside VS Code. The extension host runs where Claude Code runs (extensionKind workspace: local, SSH remote or WSL); at activation it installs its OWN hook into Claude Code's ~/.claude/settings.json there (hook-install.js: plain shell one-liners on Stop and on Notification idle_prompt|permission_prompt that append one JSON line to the signal file — no plugin, no node, nothing pointing into the extension folder; claudeBell.installHook=false opts out, `vscode:uninstall` removes exactly those entries) and watches that signal file (~/.claude/.claude-bell-signal) two ways at once — a directory fs.watch for the event-driven path and a 700 ms stat poll as the floor on network and WSL file systems — comparing the size it saw last, never the watcher's own prev/cur pair. On growth it posts "ring" to a webview view in the Panel, and the webview — which VS Code always renders on the USER's machine — synthesizes a two-tone chime with Web Audio, so no sound file and no server speakers are needed. The webview creates its AudioContext at load and tries to resume it; a context the browser keeps suspended shows an «Enable sound» button and the extension raises one toast, so a locked bell is never silent about it. While alive the extension refreshes a marker file (~/.claude/.claude-bell-extension, a timestamp every 20 s) that the hook reads to skip its own OS player, so a local session rings once, not twice. The view is revealed once at startup so its webview exists, and retainContextWhenHidden keeps it ringing after the user switches the Panel back to the terminal. Every step — activation, watcher arm, signal growth, ring posted, webview ready/rang/locked — is one line in the «Claude Bell» output channel, the first place to read when it is silent. Commands: claudeBell.test (chime now), claudeBell.toggle (enable/disable); a status-bar bell mirrors the state and blinks on every ring.
 * @route claude-bell extension | "no sound over SSH" · "rings twice" (marker file missing or stale) · "no sound at all" → View → Output → Claude Bell · "hook not installed" → Claude Bell: Install hook into Claude Code
 * @example code --install-extension claude-bell-0.4.0.vsix
 */
const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const hookInstall = require("./hook-install.js");

const POLL_MS = 700;
const RING_DEBOUNCE_MS = 1200;
let lastRingTs = 0;
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

/** @returns {string} the person's own sound file (claudeBell.soundFile) when it exists on the extension host, else "" */
function soundFile() {
  const p = String(cfg().get("soundFile") || "").trim();
  if (!p) return "";
  try {
    return fs.statSync(p).isFile() ? p : "";
  } catch {
    return "";
  }
}

/**
 * @param {vscode.WebviewView} v
 * @returns {void} grants the webview access to the folder of the person's sound file and the extension's own folder
 */
function applyWebviewOptions(v) {
  const roots = [extensionUri];
  const f = soundFile();
  if (f) roots.push(vscode.Uri.file(path.dirname(f)));
  v.webview.options = { enableScripts: true, localResourceRoots: roots };
}

/**
 * @param {vscode.WebviewView} v
 * @returns {{type:string, sound:string, volume:number, fileUrl:string, fileName:string}} the config message the webview renders from
 */
function configMessage(v) {
  const f = soundFile();
  return {
    type: "config",
    sound: String(cfg().get("sound") || "desk"),
    volume: Number(cfg().get("volume")),
    fileUrl: f ? v.webview.asWebviewUri(vscode.Uri.file(f)).toString() : "",
    fileName: f ? path.basename(f) : "",
  };
}

/** @type {vscode.Uri} */
let extensionUri;

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
  if (Date.now() - lastRingTs < RING_DEBOUNCE_MS) {
    log(`ring skipped (within ${RING_DEBOUNCE_MS} ms of the previous) — ${why}`);
    return;
  }
  lastRingTs = Date.now();
  if (status) {
    status.text = "$(bell-dot)";
    setTimeout(refreshStatus, 1500);
  }
  if (view) {
    view.webview.postMessage({ type: "ring", volume: Number(cfg().get("volume")), sound: String(cfg().get("sound") || "desk") });
    log(`ring posted to webview (${cfg().get("sound")}) — ${why}`);
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

/**
 * @param {string} why
 * @returns {void} installs or refreshes Claude Bell's own hook in Claude Code's settings when claudeBell.installHook is on; a first install raises one toast about new conversations
 */
function ensureHook(why) {
  if (!cfg().get("installHook")) {
    log(`hook install skipped (claudeBell.installHook=false) — ${why}`);
    return;
  }
  const r = hookInstall.installHooks(signalPath(), log);
  if (r.error) {
    vscode.window.showWarningMessage(`Claude Bell: could not write the Claude Code hook into ${r.path} (${r.error}). Fix that file or add the hook by hand — see the Claude Bell README.`);
    return;
  }
  if (r.changed) {
    vscode.window.showInformationMessage("Claude Bell: hook installed into Claude Code. It takes effect in new Claude Code conversations — in an open one, type /hooks once.");
  } else {
    log(`hook already current — ${why}`);
  }
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource}; media-src ${webview.cspSource};">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:8px 12px;font-size:12px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:4px 10px;border-radius:2px;cursor:pointer}
#state{opacity:.8;margin-top:6px}
</style></head><body>
<div>Claude Bell rings here when Claude Code finishes its turn or waits for you. Keep this view open in the Panel (any tab may be active).</div>
<div style="margin-top:8px">
  <select id="preset">
    <option value="desk">Reception desk bell — one strike</option>
    <option value="desk-double">Reception desk bell — two strikes</option>
    <option value="soft">Soft chime (two gentle notes)</option>
    <option value="classic">Classic two-tone</option>
    <option value="file" id="fileopt">Your own file (none chosen)</option>
  </select>
  <button id="test">Preview</button>
  <button id="use">Use this sound</button>
  <button id="pick">Choose file…</button>
  <button id="unlock" style="display:none">Enable sound</button>
</div>
<div id="state">starting</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let ctx = null;
let current = { sound: "desk", volume: 0.6, fileUrl: "", fileName: "" };
let fileBuffer = null;
let fileBufferUrl = "";
const state = (t) => { document.getElementById("state").textContent = t; };
const sel = document.getElementById("preset");
async function playFile(c, t0, v) {
  if (!current.fileUrl) return false;
  if (!fileBuffer || fileBufferUrl !== current.fileUrl) {
    const res = await fetch(current.fileUrl);
    fileBuffer = await c.decodeAudioData(await res.arrayBuffer());
    fileBufferUrl = current.fileUrl;
  }
  const src = c.createBufferSource(); src.buffer = fileBuffer;
  const g = c.createGain(); g.gain.value = Math.max(0, Math.min(1, v * 2));
  src.connect(g); g.connect(c.destination); src.start(t0);
  return true;
}
function ensureCtx() { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); return ctx; }
function tone(c, f, t0, dur, gain, attack) {
  const o = c.createOscillator(); const g = c.createGain();
  o.type = "sine"; o.frequency.value = f;
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain, t0 + (attack || 0.01)); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + dur + 0.05);
}
function strike(c, t0, f0, gain, decay) {
  const parts = [[1, 1, 1], [2.0, 0.45, 0.6], [2.72, 0.3, 0.45], [4.1, 0.15, 0.3], [5.4, 0.08, 0.2]];
  for (const [r, g, d] of parts) for (const det of [-2.5, 2.5]) {
    const o = c.createOscillator(); o.type = "sine"; o.frequency.value = f0 * r + det;
    const e = c.createGain();
    e.gain.setValueAtTime(0.0001, t0); e.gain.linearRampToValueAtTime(gain * g * 0.5, t0 + 0.004); e.gain.exponentialRampToValueAtTime(0.0001, t0 + decay * d);
    o.connect(e); e.connect(c.destination); o.start(t0); o.stop(t0 + decay * d + 0.05);
  }
  const n = c.createBuffer(1, Math.floor(c.sampleRate * 0.012), c.sampleRate); const d = n.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = c.createBufferSource(); src.buffer = n;
  const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 3000;
  const ng = c.createGain(); ng.gain.value = gain * 0.35;
  src.connect(hp); hp.connect(ng); ng.connect(c.destination); src.start(t0);
}
const presets = {
  "desk": (c, t, v) => strike(c, t, 1850, v, 1.8),
  "desk-double": (c, t, v) => { strike(c, t, 1850, v, 1.3); strike(c, t + 0.22, 1850, v * 0.9, 1.7); },
  "soft": (c, t, v) => { tone(c, 660, t, 0.9, v * 0.8, 0.03); tone(c, 880, t + 0.18, 1.2, v * 0.7, 0.03); },
  "classic": (c, t, v) => { tone(c, 880, t, 0.55, v); tone(c, 1320, t + 0.12, 0.7, v * 0.8); },
};
async function unlocked() {
  const c = ensureCtx();
  if (c.state === "suspended") { try { await c.resume(); } catch (e) { void e; } }
  const ok = c.state === "running";
  document.getElementById("unlock").style.display = ok ? "none" : "";
  return ok;
}
async function chime(volume, why, sound) {
  if (!(await unlocked())) { state("sound is locked by the browser policy — click Enable sound once"); vscode.postMessage({ type: "locked", why }); return; }
  const c = ctx;
  const v = Math.max(0, Math.min(1, Number(volume) || 0.6)) * 0.5;
  let name = presets[sound] ? sound : sound === "file" ? "file" : "desk";
  if (name === "file") {
    let played = false;
    try { played = await playFile(c, c.currentTime, v); } catch (e) { vscode.postMessage({ type: "fileError", message: String(e && e.message || e) }); }
    if (!played) { name = "desk"; presets.desk(c, c.currentTime, v); state("own file not playable — fell back to desk bell"); }
  } else {
    presets[name](c, c.currentTime, v);
  }
  state("rang at " + new Date().toLocaleTimeString() + " (" + why + ", " + (name === "file" ? current.fileName : name) + ")");
  vscode.postMessage({ type: "rang", why, sound: name });
}
window.addEventListener("message", (e) => {
  if (!e.data) return;
  if (e.data.type === "ring") chime(e.data.volume, "signal", e.data.sound || current.sound);
  if (e.data.type === "config") {
    current = { sound: e.data.sound || "desk", volume: Number(e.data.volume) || 0.6, fileUrl: e.data.fileUrl || "", fileName: e.data.fileName || "" };
    document.getElementById("fileopt").textContent = current.fileName ? "Your own file: " + current.fileName : "Your own file (none chosen — click Choose file…)";
    sel.value = current.sound;
    state("sound: " + (current.sound === "file" ? current.fileName || "file (none chosen)" : current.sound));
  }
  if (e.data.type === "enabled") state(e.data.value ? "enabled" : "disabled — click the bell in the status bar to turn it back on");
});
document.getElementById("test").addEventListener("click", () => chime(current.volume, "preview", sel.value));
document.getElementById("use").addEventListener("click", () => { current.sound = sel.value; vscode.postMessage({ type: "setSound", value: sel.value }); state("sound saved: " + sel.value); });
document.getElementById("pick").addEventListener("click", () => vscode.postMessage({ type: "pickFile" }));
document.getElementById("unlock").addEventListener("click", async () => { if (await unlocked()) { state("sound enabled"); vscode.postMessage({ type: "unlocked" }); } });
unlocked().then((ok) => { state(ok ? "ready" : "sound is locked by the browser policy — click Enable sound once"); vscode.postMessage({ type: "ready", audio: ok ? "running" : "suspended" }); });
</script></body></html>`;
}

/**
 * @param {vscode.ExtensionContext} context
 * @returns {void}
 */
function activate(context) {
  extensionUri = context.extensionUri;
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
      applyWebviewOptions(v);
      v.webview.html = html(v.webview);
      log("webview view resolved");
      setTimeout(() => {
        v.webview.postMessage(configMessage(v));
        if (!cfg().get("enabled")) v.webview.postMessage({ type: "enabled", value: false });
      }, 500);
      v.webview.onDidReceiveMessage((m) => {
        log(`webview → ${JSON.stringify(m)}`);
        if (m?.type === "ready" && pendingRings) {
          pendingRings = 0;
          ring("queued ring after view resolved");
        }
        if (m?.type === "setSound" && typeof m.value === "string") {
          cfg().update("sound", m.value, vscode.ConfigurationTarget.Global).then(() => log(`sound=${m.value}`));
        }
        if (m?.type === "pickFile") vscode.commands.executeCommand("claudeBell.pickSoundFile");
        if (m?.type === "fileError") vscode.window.showWarningMessage(`Claude Bell: could not play the chosen file (${m.message}). Use a .wav, .mp3 or .ogg on the machine where Claude Code runs.`);
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
    const next = !cfg().get("enabled");
    await cfg().update("enabled", next, vscode.ConfigurationTarget.Global);
    refreshStatus();
    log(`enabled=${next}`);
    vscode.window.setStatusBarMessage(next ? "$(bell) Claude Bell: on" : "$(bell-slash) Claude Bell: off — click the bell in the status bar to turn it back on", 4000);
    if (view) view.webview.postMessage({ type: "enabled", value: next });
  }));
  context.subscriptions.push(vscode.commands.registerCommand("claudeBell.pickSoundFile", async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Use as Claude Bell sound",
      filters: { "Audio": ["wav", "mp3", "ogg", "oga", "m4a", "flac"] },
    });
    if (!picked || !picked[0]) return;
    await cfg().update("soundFile", picked[0].fsPath, vscode.ConfigurationTarget.Global);
    await cfg().update("sound", "file", vscode.ConfigurationTarget.Global);
    log(`soundFile=${picked[0].fsPath}`);
    vscode.window.setStatusBarMessage(`$(bell) Claude Bell: ${path.basename(picked[0].fsPath)}`, 4000);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("claudeBell.installHook", () => {
    const r = hookInstall.installHooks(signalPath(), log);
    vscode.window.showInformationMessage(r.error ? `Claude Bell: hook not installed — ${r.error}` : r.changed ? `Claude Bell: hook installed into ${r.path}. New Claude Code conversations ring; in an open one type /hooks.` : `Claude Bell: hook already present in ${r.path}.`);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("claudeBell.removeHook", () => {
    const r = hookInstall.removeHooks(log);
    vscode.window.showInformationMessage(r.error ? `Claude Bell: hook not removed — ${r.error}` : r.changed ? `Claude Bell: hook removed from ${r.path}.` : `Claude Bell: no hook of ours in ${r.path}.`);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("claudeBell.signalFile")) {
      watchSignal();
      ensureHook("signalFile changed");
    }
    if (e.affectsConfiguration("claudeBell.installHook")) {
      if (cfg().get("installHook")) ensureHook("installHook turned on");
      else {
        const r = hookInstall.removeHooks(log);
        log(`installHook turned off — ${r.changed ? "hook removed" : "nothing to remove"}`);
      }
    }
    if (e.affectsConfiguration("claudeBell.enabled")) refreshStatus();
    if ((e.affectsConfiguration("claudeBell.sound") || e.affectsConfiguration("claudeBell.volume") || e.affectsConfiguration("claudeBell.soundFile")) && view) {
      if (e.affectsConfiguration("claudeBell.soundFile")) applyWebviewOptions(view);
      view.webview.postMessage(configMessage(view));
    }
  }));

  watchSignal();
  ensureHook("activation");
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
