/**
 * @summary Claude Bell — a self-contained chime for Claude Code inside VS Code. The extension host runs where Claude Code runs (extensionKind workspace: local, SSH remote or WSL); at activation it installs its OWN hook into Claude Code's ~/.claude/settings.json there (hook-install.js: plain shell one-liners on Stop and on Notification idle_prompt|permission_prompt that append one JSON line to the signal file — no plugin, no node, nothing pointing into the extension folder; claudeBell.installHook=false opts out, `vscode:uninstall` removes exactly those entries) and watches that signal file (~/.claude/.claude-bell-signal) two ways at once — a directory fs.watch for the event-driven path and a 700 ms stat poll as the floor on network and WSL file systems — comparing the size it saw last, never the watcher's own prev/cur pair, and reading the newest line to name the reason (turn finished · waiting for permission · idle). On growth it posts "ring" to a webview view in the Panel, and the webview — which VS Code always renders on the USER's machine — plays the chosen sound: a Web Audio synthesis (desk bell, double desk bell, soft chime, two-tone) or the person's own audio file, decoded once and cached. The panel is a card per sound with its own play button, the chosen card highlighted; the header carries enabled state, hook state, the last ring with its reason, and a volume slider. The webview creates its AudioContext at load and tries to resume it; a context the browser keeps suspended shows an «Enable sound» button and the extension raises one toast, so a locked bell is never silent about it. While alive the extension refreshes a marker file (~/.claude/.claude-bell-extension, a timestamp every 20 s) that the optional `bell` plugin reads to skip its own OS player, so nothing rings twice; rings inside 2500 ms of each other collapse into one (two hooks answering one event land up to two seconds apart). The view is revealed once at startup so its webview exists, and retainContextWhenHidden keeps it ringing after the user switches the Panel back to the terminal. Every step — activation, hook install, watcher arm, signal growth, ring posted, webview ready/rang/locked — is one line in the «Claude Bell» output channel, the first place to read when it is silent. Commands: claudeBell.test, claudeBell.toggle, claudeBell.pickSoundFile, claudeBell.installHook, claudeBell.removeHook; a status-bar bell mirrors the state and blinks on every ring.
 * @route claude-bell extension | "no sound over SSH" · "rings twice" (marker file missing or stale) · "no sound at all" → View → Output → Claude Bell · "hook not installed" → Claude Bell: Install hook into Claude Code
 * @example code --install-extension claude-bell-0.5.4.vsix
 */
const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const hookInstall = require("./hook-install.js");

const POLL_MS = 700;
const HEARTBEAT_MS = 20000;
const RING_DEBOUNCE_MS = 2500;
const VIEW_ID = "claudeBell.player";

/** @type {vscode.WebviewView|null} */
let view = null;
/** @type {vscode.StatusBarItem|null} */
let status = null;
/** @type {vscode.OutputChannel|null} */
let out = null;
/** @type {vscode.Uri} */
let extensionUri;
let pendingRings = 0;
let heartbeat = null;
let watchedPath = "";
let lastSize = -1;
let lastRingTs = 0;
/** @type {fs.FSWatcher|null} */
let dirWatcher = null;
let lockedToastShown = false;
/** @type {"installed"|"off"|"error"|"unknown"} */
let hookState = "unknown";
/** @type {{ts:number, reason:string}|null} */
let lastRing = null;

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

/** @returns {string} the liveness marker the optional plugin reads */
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
 * @returns {object} the config message the webview renders from
 */
function configMessage(v) {
  const f = soundFile();
  return {
    type: "config",
    enabled: !!cfg().get("enabled"),
    sound: String(cfg().get("sound") || "desk"),
    volume: Number(cfg().get("volume")),
    fileUrl: f ? v.webview.asWebviewUri(vscode.Uri.file(f)).toString() : "",
    fileName: f ? path.basename(f) : "",
    hook: hookState,
    host: vscode.env.remoteName || "local",
    lastRing,
  };
}

/** @returns {void} */
function pushConfig() {
  if (view) view.webview.postMessage(configMessage(view));
}

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
 * @param {string} event the hook's event name from the newest signal line
 * @returns {string} the reason shown to the person
 */
function reasonOf(event) {
  if (event === "Stop") return "turn finished";
  if (event === "Notification") return "waiting for you";
  return event || "signal";
}

/** @returns {string} the event name of the newest signal line, or "" */
function newestEvent() {
  try {
    const text = fs.readFileSync(watchedPath, "utf8");
    const lines = text.trim().split("\n");
    const last = lines[lines.length - 1] || "";
    return String(JSON.parse(last).event || "");
  } catch {
    return "";
  }
}

/**
 * @param {string} why
 * @param {string} [reason]
 * @returns {void} rings the webview now, or queues one ring until the view exists
 */
function ring(why, reason = "test") {
  if (!cfg().get("enabled")) {
    log(`ring skipped (disabled) — ${why}`);
    return;
  }
  if (Date.now() - lastRingTs < RING_DEBOUNCE_MS) {
    log(`ring skipped (within ${RING_DEBOUNCE_MS} ms of the previous) — ${why}`);
    return;
  }
  lastRingTs = Date.now();
  lastRing = { ts: lastRingTs, reason };
  if (status) {
    status.text = "$(bell-dot)";
    setTimeout(refreshStatus, 1500);
  }
  if (view) {
    view.webview.postMessage({ type: "ring", volume: Number(cfg().get("volume")), sound: String(cfg().get("sound") || "desk"), reason, ts: lastRingTs });
    log(`ring posted to webview (${cfg().get("sound")}, ${reason}) — ${why}`);
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
    hookState = "off";
    log(`hook install skipped (claudeBell.installHook=false) — ${why}`);
    return;
  }
  const r = hookInstall.installHooks(signalPath(), log);
  if (r.error) {
    hookState = "error";
    vscode.window.showWarningMessage(`Claude Bell: could not write the Claude Code hook into ${r.path} (${r.error}). Fix that file or add the hook by hand — see the Claude Bell README.`);
    return;
  }
  hookState = "installed";
  if (r.changed) {
    vscode.window.showInformationMessage("Claude Bell: hook installed into Claude Code. It takes effect in new Claude Code conversations — in an open one, type /hooks once.");
  } else {
    log(`hook already current — ${why}`);
  }
}

/** @returns {void} writes the liveness marker the optional plugin reads */
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
    if (grew) ring(`signal grew to ${size} bytes (${source})`, reasonOf(newestEvent()));
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
 * @returns {string} the panel: header with state, hook and last ring; one card per sound with its own play button; the own-file card with a picker
 */
function html(webview) {
  const nonce = String(Date.now());
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource}; media-src ${webview.cspSource};">
<style>
:root{--fg:var(--vscode-foreground);--muted:var(--vscode-descriptionForeground);--line:var(--vscode-widget-border,var(--vscode-panel-border,rgba(128,128,128,.35)));--card:var(--vscode-editorWidget-background,var(--vscode-sideBar-background));--sel:var(--vscode-focusBorder);--btn:var(--vscode-button-background);--btn-fg:var(--vscode-button-foreground);--btn2:var(--vscode-button-secondaryBackground);--btn2-fg:var(--vscode-button-secondaryForeground);--ok:var(--vscode-testing-iconPassed,#4ec9b0);--warn:var(--vscode-editorWarning-foreground,#cca700);--font:var(--vscode-font-family);--mono:var(--vscode-editor-font-family,monospace)}
*{box-sizing:border-box}
body{margin:0;padding:10px 14px 12px;color:var(--fg);font-family:var(--font);font-size:12.5px;line-height:1.4}
body.off .cards{opacity:.55}
.head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.state{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);flex:none}
body.off .dot{background:var(--muted)}
.dot.warn{background:var(--warn)}
b{font-weight:600}
.muted{color:var(--muted)}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.vol{display:flex;align-items:center;gap:6px}
input[type=range]{appearance:none;width:96px;height:3px;background:var(--line);border-radius:2px;outline:0;margin:0}
input[type=range]::-webkit-slider-thumb{appearance:none;width:12px;height:12px;border-radius:50%;background:var(--fg)}
input[type=range]:focus-visible::-webkit-slider-thumb{outline:1px solid var(--sel)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px;margin-top:10px}
.card{border:1px solid var(--line);border-radius:4px;padding:9px 11px 8px;display:grid;gap:5px;background:var(--card);cursor:pointer;min-width:0}
.card:hover{border-color:var(--muted)}
.card.on{border-color:var(--sel);box-shadow:inset 0 0 0 1px var(--sel)}
.card:focus-visible{outline:1px solid var(--sel);outline-offset:1px}
.card .name{font-weight:600;display:flex;align-items:center;gap:6px}
.card .name .check{width:12px;height:12px;display:none}
.card.on .name .check{display:inline-block}
.card small{color:var(--muted);font-size:11.5px;line-height:1.35}
.card .file{font-family:var(--mono);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.foot{display:flex;justify-content:space-between;align-items:center;gap:6px;margin-top:2px}
.play{width:26px;height:26px;border-radius:50%;border:1px solid var(--line);background:var(--btn2);color:var(--btn2-fg);display:inline-grid;place-items:center;cursor:pointer;padding:0;flex:none}
.play:hover{border-color:var(--muted)}
.play:focus-visible{outline:1px solid var(--sel);outline-offset:1px}
.play svg{width:12px;height:12px}
.btn{background:var(--btn);color:var(--btn-fg);border:0;border-radius:2px;padding:3px 9px;font:inherit;font-size:12px;cursor:pointer}
.btn.sec{background:var(--btn2);color:var(--btn2-fg)}
.btn:focus-visible{outline:1px solid var(--sel);outline-offset:1px}
#unlock{display:none}
body.locked #unlock{display:inline-block}
</style></head><body>
<div class="head">
  <div class="state">
    <span class="dot" id="dot"></span><b id="enabled">Enabled</b>
    <span class="muted" id="tagline">rings when Claude Code finishes its turn or waits for you</span>
    <button class="btn" id="unlock">Enable sound</button>
  </div>
  <div class="right">
    <span class="muted" id="hook"></span>
    <span class="muted" id="last"></span>
    <label class="vol muted" for="vol">Volume <input type="range" id="vol" min="0" max="100" value="60"></label>
  </div>
</div>
<div class="cards" id="cards">
  <div class="card" data-s="desk" tabindex="0"><div class="name"><svg class="check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.2 3L13 4.5"/></svg>Desk bell</div><small>Metallic strike, long decay — the reception counter bell</small><div class="foot"><span class="muted">1.8 s</span><button class="play" data-play="desk" title="Play"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 3l9 5-9 5z"/></svg></button></div></div>
  <div class="card" data-s="desk-double" tabindex="0"><div class="name"><svg class="check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.2 3L13 4.5"/></svg>Desk bell ×2</div><small>Two quick strikes</small><div class="foot"><span class="muted">2.0 s</span><button class="play" data-play="desk-double" title="Play"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 3l9 5-9 5z"/></svg></button></div></div>
  <div class="card" data-s="soft" tabindex="0"><div class="name"><svg class="check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.2 3L13 4.5"/></svg>Soft chime</div><small>Two gentle notes, like a system notification</small><div class="foot"><span class="muted">1.4 s</span><button class="play" data-play="soft" title="Play"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 3l9 5-9 5z"/></svg></button></div></div>
  <div class="card" data-s="classic" tabindex="0"><div class="name"><svg class="check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.2 3L13 4.5"/></svg>Two-tone</div><small>Short rising ding</small><div class="foot"><span class="muted">0.8 s</span><button class="play" data-play="classic" title="Play"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 3l9 5-9 5z"/></svg></button></div></div>
  <div class="card" data-s="file" tabindex="0"><div class="name"><svg class="check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.2 3L13 4.5"/></svg>Your own file</div><div class="file muted" id="fileName">No file chosen</div><div class="foot"><button class="btn sec" id="pick">Choose…</button><button class="play" data-play="file" title="Play"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 3l9 5-9 5z"/></svg></button></div></div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let ctx = null;
let current = { sound: "desk", volume: 0.6, fileUrl: "", fileName: "", enabled: true };
let fileBuffer = null;
let fileBufferUrl = "";
const $ = (id) => document.getElementById(id);
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
async function unlocked() {
  const c = ensureCtx();
  if (c.state === "suspended") { try { await c.resume(); } catch (e) { void e; } }
  const ok = c.state === "running";
  document.body.classList.toggle("locked", !ok);
  return ok;
}
async function chime(volume, why, sound) {
  if (!(await unlocked())) { vscode.postMessage({ type: "locked", why }); return; }
  const c = ctx;
  const v = Math.max(0, Math.min(1, Number(volume) || 0.6)) * 0.5;
  let name = presets[sound] ? sound : sound === "file" ? "file" : "desk";
  if (name === "file") {
    let played = false;
    try { played = await playFile(c, c.currentTime, v); } catch (e) { vscode.postMessage({ type: "fileError", message: String(e && e.message || e) }); }
    if (!played) { name = "desk"; presets.desk(c, c.currentTime, v); }
  } else {
    presets[name](c, c.currentTime, v);
  }
  vscode.postMessage({ type: "rang", why, sound: name });
}
function fmt(ts) { const d = new Date(ts); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function render() {
  document.body.classList.toggle("off", !current.enabled);
  $("enabled").textContent = current.enabled ? "Enabled" : "Disabled";
  $("tagline").textContent = current.enabled ? "rings when Claude Code finishes its turn or waits for you" : "click the bell in the status bar to turn it back on";
  $("hook").textContent = current.hook === "installed" ? "hook: installed" : current.hook === "off" ? "hook: managed by you" : current.hook === "error" ? "hook: not installed" : "";
  $("hook").className = current.hook === "error" ? "" : "muted";
  $("last").textContent = current.lastRing ? "last ring " + fmt(current.lastRing.ts) + " · " + current.lastRing.reason : "no rings yet";
  $("fileName").textContent = current.fileName || "No file chosen";
  $("fileName").classList.toggle("muted", !current.fileName);
  $("vol").value = Math.round((Number(current.volume) || 0.6) * 100);
  document.querySelectorAll(".card").forEach((c) => c.classList.toggle("on", c.dataset.s === current.sound));
}
window.addEventListener("message", (e) => {
  const m = e.data; if (!m) return;
  if (m.type === "ring") { current.lastRing = { ts: m.ts || Date.now(), reason: m.reason || "signal" }; render(); chime(m.volume, "signal", m.sound || current.sound); }
  if (m.type === "config") { current = { ...current, ...m }; render(); }
});
document.querySelectorAll("[data-play]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); chime(current.volume, "preview", b.dataset.play); }));
document.querySelectorAll(".card").forEach((c) => {
  const choose = () => { current.sound = c.dataset.s; render(); vscode.postMessage({ type: "setSound", value: c.dataset.s }); if (c.dataset.s === "file" && !current.fileName) vscode.postMessage({ type: "pickFile" }); };
  c.addEventListener("click", choose);
  c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); } });
});
$("pick").addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "pickFile" }); });
$("vol").addEventListener("input", () => { current.volume = Number($("vol").value) / 100; });
$("vol").addEventListener("change", () => vscode.postMessage({ type: "setVolume", value: Number($("vol").value) / 100 }));
$("unlock").addEventListener("click", async () => { if (await unlocked()) vscode.postMessage({ type: "unlocked" }); });
render();
unlocked().then((ok) => vscode.postMessage({ type: "ready", audio: ok ? "running" : "suspended" }));
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
      setTimeout(pushConfig, 400);
      v.webview.onDidReceiveMessage((m) => {
        log(`webview → ${JSON.stringify(m)}`);
        if (m?.type === "ready" && pendingRings) {
          pendingRings = 0;
          ring("queued ring after view resolved");
        }
        if (m?.type === "setSound" && typeof m.value === "string") {
          cfg().update("sound", m.value, vscode.ConfigurationTarget.Global).then(() => log(`sound=${m.value}`));
        }
        if (m?.type === "setVolume" && Number.isFinite(Number(m.value))) {
          cfg().update("volume", Math.max(0, Math.min(1, Number(m.value))), vscode.ConfigurationTarget.Global).then(() => log(`volume=${m.value}`));
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

  context.subscriptions.push(vscode.commands.registerCommand("claudeBell.test", () => ring("test command", "test")));
  context.subscriptions.push(vscode.commands.registerCommand("claudeBell.toggle", async () => {
    const next = !cfg().get("enabled");
    await cfg().update("enabled", next, vscode.ConfigurationTarget.Global);
    refreshStatus();
    log(`enabled=${next}`);
    vscode.window.setStatusBarMessage(next ? "$(bell) Claude Bell: on" : "$(bell-slash) Claude Bell: off — click the bell in the status bar to turn it back on", 4000);
    pushConfig();
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
    hookState = r.error ? "error" : "installed";
    pushConfig();
    vscode.window.showInformationMessage(r.error ? `Claude Bell: hook not installed — ${r.error}` : r.changed ? `Claude Bell: hook installed into ${r.path}. New Claude Code conversations ring; in an open one type /hooks.` : `Claude Bell: hook already present in ${r.path}.`);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("claudeBell.removeHook", () => {
    const r = hookInstall.removeHooks(log);
    if (!r.error) hookState = "off";
    pushConfig();
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
        hookState = "off";
        log(`installHook turned off — ${r.changed ? "hook removed" : "nothing to remove"}`);
      }
    }
    if (e.affectsConfiguration("claudeBell.enabled")) refreshStatus();
    if (e.affectsConfiguration("claudeBell.soundFile") && view) applyWebviewOptions(view);
    if (e.affectsConfiguration("claudeBell")) pushConfig();
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
