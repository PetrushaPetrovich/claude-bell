/**
 * @summary Claude Bell — a self-contained chime for Claude Code inside VS Code. In a LOCAL window every ring goes through the OS player (player.js: WPF MediaPlayer via PowerShell, afplay, paplay — with volume, no user gesture needed) playing the bundled WAVs rendered from the panel's own formulas (media/sounds, scripts/render-chimes.mjs) or a sound from the person's LIBRARY — the folder ~/.claude/claude-bell/sounds (claudeBell.soundsFolder overrides): every audio file in it is one card in the panel; the «+» card opens a file picker and the panel decodes the file (any format the browser plays), trims silence, normalizes the peak and hands back a mono 16-bit WAV the extension writes into the folder; a file dropped into the folder by hand shows up too, and a non-WAV one is converted in place into <name>.wav (the original is removed) so paplay and SoundPlayer can play it; the × on a library card deletes the file after a confirm. The folder is watched (fs.watch + a 2 s poll) so the cards follow it. In a REMOTE window (SSH, WSL) the server has no speakers, so the ring is played by the panel's webview on the person's machine, which the browser keeps muted until one click inside the panel — the header shows Enable sound and a toast points there once. The extension host runs where Claude Code runs (extensionKind workspace: local, SSH remote or WSL); at activation it installs its OWN hook into Claude Code's ~/.claude/settings.json there (hook-install.js: plain shell one-liners on Stop and on Notification idle_prompt|permission_prompt that append one JSON line to the signal file — no plugin, no node, nothing pointing into the extension folder; claudeBell.installHook=false opts out, `vscode:uninstall` removes exactly those entries) and watches that signal file (~/.claude/.claude-bell-signal) two ways at once — a directory fs.watch and a 700 ms stat poll — comparing the size it saw last and reading the newest line to name the reason. While alive the extension refreshes a marker file (~/.claude/.claude-bell-extension, every 20 s) that the optional `bell` plugin reads to skip its own OS player; rings inside 2500 ms of each other collapse into one. The view is revealed once at startup so its webview exists, and retainContextWhenHidden keeps it alive after the Panel switches back to the terminal. Every step is one line in the «Claude Bell» output channel. The legacy claudeBell.soundFile setting is imported into the library once and cleared. Commands: claudeBell.test, claudeBell.toggle, claudeBell.addSound, claudeBell.installHook, claudeBell.removeHook; a status-bar bell mirrors the state and blinks on every ring.
 * @route claude-bell extension | "no sound over SSH" · "rings twice" (marker file missing or stale) · "no sound at all" → View → Output → Claude Bell · "hook not installed" → Claude Bell: Install hook into Claude Code · "where are my sounds" → ~/.claude/claude-bell/sounds
 * @example code --install-extension claude-bell-0.9.5.vsix
 */
const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const hookInstall = require("./hook-install.js");
const player = require("./player.js");

const BUILTIN_SOUNDS = ["desk", "desk-double", "soft", "classic"];
const FALLBACK_SOUND = "desk-double";
const AUDIO_EXT = new Set([".wav", ".mp3", ".ogg", ".oga", ".flac", ".m4a", ".aac", ".aiff", ".aif"]);
const CUSTOM_PREFIX = "custom:";

const POLL_MS = 700;
const FOLDER_POLL_MS = 2000;
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
/** @type {fs.FSWatcher|null} */
let folderWatcher = null;
let folderPoll = null;
let folderSnapshot = "";
let lockedToastShown = false;
let audioRunning = false;
let transcodeErrorShown = false;
/** @type {"installed"|"off"|"error"|"unknown"} */
let hookState = "unknown";
/** @type {{ts:number, reason:string}|null} */
let lastRing = null;
/** @type {Array<{sourcePath:string, target:"add"|"import", chooseAfter:boolean}>} */
let transcodeQueue = [];
/** @type {Set<string>} */
const transcodeInFlight = new Set();

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

/** @returns {string} the person's sound library folder */
const soundsFolder = () => String(cfg().get("soundsFolder") || "").trim() || path.join(os.homedir(), ".claude", "claude-bell", "sounds");

/**
 * @param {string} p
 * @returns {void}
 */
function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (e) {
    log(`mkdir failed ${p}: ${e?.message}`);
  }
}

/**
 * @returns {Array<{id:string, name:string, file:string, playable:string, ready:boolean}>} every audio file of the library, sorted by name; playable = the file itself for WAV, else its fresh cache twin or "" while it is still being prepared
 */
function listCustomSounds() {
  const dir = soundsFolder();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const rows = [];
  for (const n of names) {
    const ext = path.extname(n).toLowerCase();
    if (!AUDIO_EXT.has(ext) || n.startsWith(".")) continue;
    const file = path.join(dir, n);
    try {
      if (!fs.statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    const playable = ext === ".wav" ? file : "";
    rows.push({ id: CUSTOM_PREFIX + n, name: path.basename(n, ext), file, playable, ready: !!playable });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

/**
 * @param {string} id a sound id: a built-in name or custom:<file>
 * @returns {string} the file the OS player should play, or ""
 */
function fileForSound(id) {
  if (String(id).startsWith(CUSTOM_PREFIX)) {
    const row = listCustomSounds().find((r) => r.id === id);
    return row ? row.playable || row.file : "";
  }
  return bundledSound(String(id));
}

/** @type {Record<string, {seconds:number, origin:string}>|null} */
let soundManifest = null;

/** @returns {Record<string, {seconds:number, origin:string}>} media/sounds/manifest.json written by the build, {} when absent */
function bundledManifest() {
  if (soundManifest) return soundManifest;
  try {
    soundManifest = JSON.parse(fs.readFileSync(path.join(extensionUri.fsPath, "media", "sounds", "manifest.json"), "utf8"));
  } catch {
    soundManifest = {};
  }
  return soundManifest;
}

/**
 * @param {string} name a built-in sound name
 * @returns {string} the bundled WAV for it (desk when the name is unknown), or "" when the file is missing
 */
function bundledSound(name) {
  const n = BUILTIN_SOUNDS.includes(name) ? name : FALLBACK_SOUND;
  const p = path.join(extensionUri.fsPath, "media", "sounds", `${n}.wav`);
  try {
    return fs.statSync(p).isFile() ? p : "";
  } catch {
    return "";
  }
}

/**
 * @param {vscode.WebviewView} v
 * @returns {void} grants the webview access to the extension's folder, the library and its cache, and any file queued for transcoding
 */
function applyWebviewOptions(v) {
  const roots = [extensionUri, vscode.Uri.file(soundsFolder())];
  for (const q of transcodeQueue) roots.push(vscode.Uri.file(path.dirname(q.sourcePath)));
  for (const s of transcodeInFlight) roots.push(vscode.Uri.file(path.dirname(s)));
  v.webview.options = { enableScripts: true, localResourceRoots: roots };
}

/**
 * @param {vscode.WebviewView} v
 * @returns {object} the config message the webview renders from
 */
function configMessage(v) {
  const local = !vscode.env.remoteName;
  const custom = local ? listCustomSounds().map((r) => ({ id: r.id, name: r.name, ready: r.ready, url: v.webview.asWebviewUri(vscode.Uri.file(r.playable || r.file)).toString() })) : [];
  return {
    type: "config",
    enabled: !!cfg().get("enabled"),
    sound: String(cfg().get("sound") || "desk-double"),
    volume: Number(cfg().get("volume")),
    hook: hookState,
    host: vscode.env.remoteName || "local",
    local: !vscode.env.remoteName,
    sounds: Object.fromEntries(BUILTIN_SOUNDS.map((n) => [n, bundledSound(n) ? v.webview.asWebviewUri(vscode.Uri.file(bundledSound(n))).toString() : ""])),
    durations: Object.fromEntries(BUILTIN_SOUNDS.map((n) => [n, Number(bundledManifest()[n]?.seconds) || 0])),
    custom,
    folder: local ? soundsFolder() : "",
    lastRing,
  };
}

/** @returns {void} */
function pushConfig() {
  if (view) {
    applyWebviewOptions(view);
    view.webview.postMessage(configMessage(view));
  }
}

/**
 * @param {string} sourcePath an audio file anywhere on this machine
 * @param {"add"|"import"} target add = write <library>/<name>.wav from a file outside the library and choose it; import = convert a non-WAV file already in the library in place
 * @param {boolean} chooseAfter
 * @returns {void} asks the panel to decode the file into a normalized mono WAV; queued until the panel exists
 */
function requestTranscode(sourcePath, target, chooseAfter) {
  if (transcodeInFlight.has(sourcePath) || transcodeQueue.some((q) => q.sourcePath === sourcePath)) return;
  transcodeQueue.push({ sourcePath, target, chooseAfter });
  drainTranscodes("queued " + path.basename(sourcePath));
}

/**
 * @param {string} why
 * @returns {void} sends every queued transcode to the panel once it exists
 */
function drainTranscodes(why) {
  if (!transcodeQueue.length) return;
  if (!view) {
    log(`transcode waits for the panel (${transcodeQueue.length} queued) — ${why}`);
    vscode.commands.executeCommand(`${VIEW_ID}.focus`, { preserveFocus: true });
    return;
  }
  applyWebviewOptions(view);
  for (const q of transcodeQueue.splice(0)) {
    transcodeInFlight.add(q.sourcePath);
    view.webview.postMessage({ type: "transcode", url: view.webview.asWebviewUri(vscode.Uri.file(q.sourcePath)).toString(), name: path.basename(q.sourcePath), sourcePath: q.sourcePath, target: q.target, chooseAfter: q.chooseAfter });
    log(`transcode requested (${q.target}): ${q.sourcePath} — ${why}`);
  }
}

/**
 * @param {string} dir
 * @param {string} base
 * @returns {string} <dir>/<base>.wav, or <base> (2).wav … when taken
 */
function freeWavPath(dir, base) {
  let p = path.join(dir, `${base}.wav`);
  for (let i = 2; fs.existsSync(p) && i < 100; i++) p = path.join(dir, `${base} (${i}).wav`);
  return p;
}

/**
 * @param {{base64:string, seconds:number, name:string, sourcePath:string, target:string, chooseAfter:boolean}} m the panel's transcoded WAV
 * @returns {Promise<void>} writes it into the library (add) or the cache (cache), then refreshes the panel
 */
async function saveTranscoded(m) {
  transcodeInFlight.delete(m.sourcePath);
  try {
    const bytes = Buffer.from(String(m.base64 || ""), "base64");
    if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF") throw new Error("not a WAV");
    const base = path.basename(m.sourcePath, path.extname(m.sourcePath));
    if (m.target === "import") {
      const target = freeWavPath(soundsFolder(), base);
      fs.writeFileSync(target, bytes);
      try {
        fs.unlinkSync(m.sourcePath);
      } catch (e) {
        log(`original could not be removed (${e?.message})`);
      }
      log(`library file converted in place: ${path.basename(m.sourcePath)} → ${path.basename(target)} (${(Number(m.seconds) || 0).toFixed(2)} s)`);
      if (m.chooseAfter || String(cfg().get("sound")) === CUSTOM_PREFIX + path.basename(m.sourcePath)) await cfg().update("sound", CUSTOM_PREFIX + path.basename(target), vscode.ConfigurationTarget.Global);
    } else {
      ensureDir(soundsFolder());
      const target = freeWavPath(soundsFolder(), base);
      fs.writeFileSync(target, bytes);
      log(`sound added to the library: ${path.basename(target)} (${(Number(m.seconds) || 0).toFixed(2)} s, ${Math.round(bytes.length / 1024)} KB)`);
      vscode.window.setStatusBarMessage(`$(bell) Claude Bell: added ${path.basename(target)}`, 4000);
      if (m.chooseAfter) await cfg().update("sound", CUSTOM_PREFIX + path.basename(target), vscode.ConfigurationTarget.Global);
    }
  } catch (e) {
    log(`saving transcoded sound failed: ${e?.message}`);
  }
  refreshFolder("transcoded");
}

/**
 * @param {string} why
 * @returns {void} re-reads the library, prepares any non-WAV file lacking a fresh cache twin, and refreshes the panel when the listing changed
 */
function refreshFolder(why) {
  const rows = listCustomSounds();
  for (const r of rows) if (!r.ready) requestTranscode(r.file, "import", String(cfg().get("sound")) === r.id);
  const snap = JSON.stringify(rows.map((r) => [r.id, r.ready]));
  if (snap !== folderSnapshot) {
    folderSnapshot = snap;
    log(`library: ${rows.length} sound(s) — ${why}`);
    pushConfig();
  }
}

/** @returns {void} watches the library folder with fs.watch plus a slow poll */
function watchFolder() {
  const dir = soundsFolder();
  ensureDir(dir);
  if (folderWatcher) {
    try {
      folderWatcher.close();
    } catch {
      void 0;
    }
    folderWatcher = null;
  }
  if (folderPoll) clearInterval(folderPoll);
  try {
    folderWatcher = fs.watch(dir, () => refreshFolder("fs.watch"));
    folderWatcher.on("error", (e) => log(`library fs.watch error: ${e?.message}`));
  } catch (e) {
    log(`library fs.watch unavailable: ${e?.message}`);
  }
  folderPoll = setInterval(() => refreshFolder("poll"), FOLDER_POLL_MS);
  folderSnapshot = "";
  refreshFolder("watch");
}

/**
 * @param {string} id custom:<file>
 * @returns {Promise<void>} deletes the library file and its cache twin after a confirm; a deleted chosen sound falls back to the desk bell
 */
async function deleteSound(id) {
  const row = listCustomSounds().find((r) => r.id === id);
  if (!row) return;
  const pick = await vscode.window.showWarningMessage(`Delete “${row.name}” from your Claude Bell sounds? The file is removed from ${soundsFolder()}.`, { modal: true }, "Delete");
  if (pick !== "Delete") return;
  try {
    fs.unlinkSync(row.file);
    log(`sound deleted: ${row.file}`);
    if (String(cfg().get("sound")) === id) await cfg().update("sound", FALLBACK_SOUND, vscode.ConfigurationTarget.Global);
  } catch (e) {
    vscode.window.showWarningMessage(`Claude Bell: could not delete ${row.name} (${e?.message}).`);
  }
  refreshFolder("deleted");
}

/** @returns {Promise<void>} imports the legacy claudeBell.soundFile into the library once, then clears the setting */
async function migrateLegacyFile() {
  const legacy = String(cfg().get("soundFile") || "").trim();
  if (!legacy) return;
  try {
    if (fs.statSync(legacy).isFile()) {
      requestTranscode(legacy, "add", String(cfg().get("sound")) === "file");
      log(`importing legacy soundFile into the library: ${legacy}`);
    }
  } catch {
    log(`legacy soundFile missing, dropped: ${legacy}`);
    if (String(cfg().get("sound")) === "file") await cfg().update("sound", FALLBACK_SOUND, vscode.ConfigurationTarget.Global);
  }
  await cfg().update("soundFile", undefined, vscode.ConfigurationTarget.Global);
}

/**
 * @param {string} p
 * @returns {void} creates the file (and its folder) when missing so watching has a target
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
    return String(JSON.parse(lines[lines.length - 1] || "{}").event || "");
  } catch {
    return "";
  }
}

/**
 * @param {string} why
 * @param {string} [reason]
 * @returns {Promise<void>} plays the chosen sound: OS player in a local window (a failed play is retried once with the built-in desk bell), the panel in a remote one (a library sound absent on this machine falls back to the desk bell)
 */
async function ring(why, reason = "test") {
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
  let sound = String(cfg().get("sound") || "desk-double");
  const volume = Number(cfg().get("volume"));
  if (!vscode.env.remoteName) {
    if (view) view.webview.postMessage({ type: "ringInfo", reason, ts: lastRingTs });
    const desk = bundledSound(FALLBACK_SOUND);
    let file = fileForSound(sound);
    if (!file) {
      log(`sound "${sound}" is not on this machine — playing ${FALLBACK_SOUND} instead — ${why}`);
      file = desk;
    }
    if (!file) {
      log(`no sound file at all — ${why}`);
      return;
    }
    const code = await player.play(file, volume, log);
    log(`OS player: ${path.basename(file)} at volume ${volume} (${reason}) → exit ${code} — ${why}`);
    if (code !== 0 && desk && file !== desk) {
      const again = await player.play(desk, volume, log);
      log(`retry with ${FALLBACK_SOUND} → exit ${again}`);
    }
    return;
  }
  if (sound.startsWith(CUSTOM_PREFIX)) {
    log(`remote window: library sound "${sound}" is not available here — playing ${FALLBACK_SOUND} instead`);
    sound = FALLBACK_SOUND;
  }
  if (view) {
    view.webview.postMessage({ type: "ring", volume, sound, reason, ts: lastRingTs });
    log(`ring posted to webview (${sound}, ${reason}) — ${why}`);
    if (!audioRunning) lockedHint("webview audio not unlocked yet");
  } else {
    pendingRings = 1;
    log(`ring queued, view not resolved yet — revealing — ${why}`);
    vscode.commands.executeCommand(`${VIEW_ID}.focus`, { preserveFocus: true });
  }
}

/**
 * @param {string} why
 * @returns {void} on a remote window, where only the panel can reach the person's speakers, points once at the one click that unlocks its audio
 */
function lockedHint(why) {
  log(`panel audio locked — ${why}`);
  if (lockedToastShown) return;
  lockedToastShown = true;
  vscode.window.showInformationMessage("Claude Bell: in a remote window the browser allows sound only after one click inside the Claude Bell panel. Click it once and every later ring plays.", "Open Claude Bell").then((pick) => {
    if (pick) vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  });
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
  if (r.changed) vscode.window.showInformationMessage("Claude Bell: hook installed into Claude Code. It takes effect in new Claude Code conversations — in an open one, type /hooks once.");
  else log(`hook already current — ${why}`);
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
 * @returns {string} the panel: header with state, hook and last ring; one card per built-in sound and per library sound (× deletes), an add card; previews per card
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
b{font-weight:600}
.muted{color:var(--muted)}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.vol{display:flex;align-items:center;gap:6px}
input[type=range]{appearance:none;width:96px;height:3px;background:var(--line);border-radius:2px;outline:0;margin:0}
input[type=range]::-webkit-slider-thumb{appearance:none;width:12px;height:12px;border-radius:50%;background:var(--fg)}
input[type=range]:focus-visible::-webkit-slider-thumb{outline:1px solid var(--sel)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px;margin-top:10px}
.card{position:relative;border:1px solid var(--line);border-radius:4px;padding:9px 11px 8px;display:grid;gap:5px;background:var(--card);cursor:pointer;min-width:0}
.card:hover{border-color:var(--muted)}
.card.on{border-color:var(--sel);box-shadow:inset 0 0 0 1px var(--sel)}
.card:focus-visible{outline:1px solid var(--sel);outline-offset:1px}
.card .name{font-weight:600;display:flex;align-items:center;gap:6px;min-width:0}
.card .name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .name .check{width:12px;height:12px;display:none;flex:none}
.card.on .name .check{display:inline-block}
.card small{color:var(--muted);font-size:11.5px;line-height:1.35}
.foot{display:flex;justify-content:space-between;align-items:center;gap:6px;margin-top:2px}
.play,.del{width:26px;height:26px;border-radius:50%;border:1px solid var(--line);background:var(--btn2);color:var(--btn2-fg);display:inline-grid;place-items:center;cursor:pointer;padding:0;flex:none}
.play:hover,.del:hover{border-color:var(--muted)}
.play:focus-visible,.del:focus-visible{outline:1px solid var(--sel);outline-offset:1px}
.play svg,.del svg{width:12px;height:12px}
.del{position:absolute;top:6px;right:6px;width:20px;height:20px;opacity:0;transition:opacity .12s}
.card:hover .del,.card:focus-within .del{opacity:1}
.card.add{display:grid;place-items:center;border-style:dashed;min-height:96px;color:var(--muted)}
.card.add .addlabel{display:flex;align-items:center;gap:8px;white-space:nowrap;font-size:13px}
.card.add .plus{font-size:22px;line-height:1}
.card.add:hover{color:var(--fg)}
.btn{background:var(--btn);color:var(--btn-fg);border:0;border-radius:2px;padding:3px 9px;font:inherit;font-size:12px;cursor:pointer}
.btn:focus-visible{outline:1px solid var(--sel);outline-offset:1px}
#unlock{display:none}
body.locked:not(.local) #unlock{display:inline-block}
body.locked:not(.local) #tagline{display:none}
body.locked:not(.local) .dot{background:var(--warn)}
.folder{margin-top:8px;font-size:11.5px}
.folder a{color:var(--vscode-textLink-foreground);text-decoration:none;cursor:pointer}
</style></head><body>
<div class="head">
  <div class="state">
    <span class="dot" id="dot"></span><b id="enabled">Enabled</b>
    <span class="muted" id="tagline">rings when Claude Code finishes its turn or waits for you</span>
    <button class="btn" id="unlock" title="The browser allows sound only after a click inside this panel — once per VS Code window">Enable sound</button>
  </div>
  <div class="right">
    <span class="muted" id="hook"></span>
    <span class="muted" id="last"></span>
    <label class="vol muted" for="vol">Volume <input type="range" id="vol" min="0" max="100" value="60"></label>
  </div>
</div>
<div class="cards" id="cards"></div>
<div class="folder muted" id="folderline">Your sounds live in <a id="folder" title="Open the folder">…</a> — drop any .wav / .mp3 / .ogg / .flac there, or use +.</div>
<div class="folder muted" id="remoteline" style="display:none">Remote window: only the built-in sounds are available here. Your own sounds stay on your local machine and play there.</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let ctx = null;
let current = { sound: "desk", volume: 0.6, enabled: true, sounds: {}, durations: {}, custom: [], local: true, folder: "" };
const buffers = {};
const BUILTIN = [
  ["desk", "Desk bell", "Metallic strike, long decay — the reception counter bell", "1.8 s"],
  ["desk-double", "Desk bell ×2", "Two quick strikes", "2.0 s"],
  ["soft", "Soft chime", "Two gentle notes, like a system notification", "1.4 s"],
  ["classic", "Two-tone", "Short rising ding", "0.8 s"],
];
const RESUME_WAIT_MS = 250;
const $ = (id) => document.getElementById(id);
const PLAY = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 3l9 5-9 5z"/></svg>';
const CHECK = '<svg class="check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';
const CROSS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
async function playUrl(c, url, gain) {
  if (!buffers[url]) { const res = await fetch(url); buffers[url] = await c.decodeAudioData(await res.arrayBuffer()); }
  const src = c.createBufferSource(); src.buffer = buffers[url];
  const g = c.createGain(); g.gain.value = Math.max(0, Math.min(1, gain));
  src.connect(g); g.connect(c.destination); src.start(c.currentTime);
}
function setLockedUI(locked) { document.body.classList.toggle("locked", locked); }
function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.onstatechange = () => { const running = ctx.state === "running"; setLockedUI(!running); if (running) vscode.postMessage({ type: "unlocked" }); };
  }
  return ctx;
}
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
async function transcode(m) {
  try {
    const res = await fetch(m.url); const bytes = await res.arrayBuffer();
    const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const dec = Off ? new Off(1, 44100, 44100) : ensureCtx();
    const buf = await dec.decodeAudioData(bytes);
    const rate = buf.sampleRate; const n = buf.length; const ch = buf.numberOfChannels;
    const mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
    let end = n; while (end > 1 && Math.abs(mono[end - 1]) < 0.002) end--;
    end = Math.min(end + Math.floor(rate * 0.05), n, Math.floor(rate * 8));
    let start = 0; while (start < end - 1 && Math.abs(mono[start]) < 0.002) start++;
    start = Math.max(0, start - Math.floor(rate * 0.01));
    let peak = 0; for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(mono[i]));
    const norm = peak > 0 ? 0.9 / peak : 1;
    const len = end - start; const out = new DataView(new ArrayBuffer(44 + len * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); out.setUint32(4, 36 + len * 2, true); str(8, "WAVE"); str(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); str(36, "data"); out.setUint32(40, len * 2, true);
    for (let i = 0; i < len; i++) out.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(mono[start + i] * norm * 32767))), true);
    const u8 = new Uint8Array(out.buffer); let bin = ""; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    vscode.postMessage({ type: "transcoded", name: m.name, sourcePath: m.sourcePath, target: m.target, chooseAfter: !!m.chooseAfter, base64: btoa(bin), seconds: len / rate, rate });
  } catch (e) { vscode.postMessage({ type: "transcodeError", name: m.name, sourcePath: m.sourcePath, message: String(e && e.message || e) }); }
}
async function unlocked() {
  const c = ensureCtx();
  if (c.state !== "running") await Promise.race([c.resume().catch(() => {}), new Promise((r) => setTimeout(r, RESUME_WAIT_MS))]);
  const ok = c.state === "running";
  setLockedUI(!ok);
  return ok;
}
document.addEventListener("pointerdown", () => { unlocked(); }, true);
document.addEventListener("keydown", () => { unlocked(); }, true);
async function chime(volume, why, sound) {
  if (!(await unlocked())) { vscode.postMessage({ type: "locked", why }); return; }
  const c = ctx;
  const v = Math.max(0, Math.min(1, Number(volume) || 0.6)) * 0.5;
  let name = sound;
  let played = false;
  if (String(sound).startsWith("custom:")) {
    const row = (current.custom || []).find((r) => r.id === sound);
    if (row && row.url) { try { await playUrl(c, row.url, v * 2); played = true; } catch (e) { vscode.postMessage({ type: "fileError", message: String(e && e.message || e) }); } }
    if (!played) { name = "desk-double"; presets["desk-double"](c, c.currentTime, v); }
  } else {
    name = presets[sound] ? sound : "desk-double";
    const url = current.sounds && current.sounds[name];
    if (url) { try { await playUrl(c, url, v * 2); played = true; } catch (e) { void e; } }
    if (!played) presets[name](c, c.currentTime, v);
  }
  vscode.postMessage({ type: "rang", why, sound: name });
}
function fmt(ts) { const d = new Date(ts); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function cardHtml(id, name, desc, meta, deletable) {
  return '<div class="card" data-s="' + esc(id) + '" tabindex="0">' + (deletable ? '<button class="del" data-del="' + esc(id) + '" title="Delete this sound">' + CROSS + '</button>' : '') +
    '<div class="name">' + CHECK + '<span title="' + esc(name) + '">' + esc(name) + '</span></div><small>' + esc(desc) + '</small>' +
    '<div class="foot"><span class="muted">' + esc(meta) + '</span><button class="play" data-play="' + esc(id) + '" title="Play">' + PLAY + '</button></div></div>';
}
function renderCards() {
  let h = "";
  for (const [id, name, desc, meta] of BUILTIN) {
    const sec = current.durations && current.durations[id];
    h += cardHtml(id, name, desc, sec ? sec.toFixed(1) + " s" : meta, false);
  }
  if (current.local) {
    for (const r of current.custom || []) h += cardHtml(r.id, r.name, r.ready ? "Your sound" : "Preparing…", r.ready ? "own file" : "converting", true);
    h += '<div class="card add" id="add" tabindex="0" title="Add a sound file"><div class="addlabel"><span class="plus">+</span> Add sound</div></div>';
  }
  $("cards").innerHTML = h;
  document.querySelectorAll("[data-play]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); chime(current.volume, "preview", b.dataset.play); }));
  document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "deleteSound", id: b.dataset.del }); }));
  document.querySelectorAll(".card[data-s]").forEach((c) => {
    const choose = () => { current.sound = c.dataset.s; renderSelection(); vscode.postMessage({ type: "setSound", value: c.dataset.s }); };
    c.addEventListener("click", choose);
    c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); } });
  });
  const add = $("add");
  if (add) {
    const addIt = () => vscode.postMessage({ type: "addSound" });
    add.addEventListener("click", addIt);
    add.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); addIt(); } });
  }
  renderSelection();
}
function renderSelection() { document.querySelectorAll(".card[data-s]").forEach((c) => c.classList.toggle("on", c.dataset.s === current.sound)); }
function render() {
  document.body.classList.toggle("off", !current.enabled);
  document.body.classList.toggle("local", !!current.local);
  $("enabled").textContent = current.enabled ? "Enabled" : "Disabled";
  $("tagline").textContent = current.enabled ? (current.local ? "rings when Claude Code finishes its turn or waits for you" : "rings here (remote window) when Claude Code finishes its turn or waits for you") : "click the bell in the status bar to turn it back on";
  $("hook").textContent = current.hook === "installed" ? "hook: installed" : current.hook === "off" ? "hook: managed by you" : current.hook === "error" ? "hook: not installed" : "";
  $("hook").className = current.hook === "error" ? "" : "muted";
  $("last").textContent = current.lastRing ? "last ring " + fmt(current.lastRing.ts) + " · " + current.lastRing.reason : "no rings yet";
  $("vol").value = Math.round((Number(current.volume) || 0.6) * 100);
  $("folder").textContent = current.folder || "…";
  $("folderline").style.display = current.local ? "" : "none";
  $("remoteline").style.display = current.local ? "none" : "";
  renderCards();
}
window.addEventListener("message", (e) => {
  const m = e.data; if (!m) return;
  if (m.type === "ring") { current.lastRing = { ts: m.ts || Date.now(), reason: m.reason || "signal" }; render(); chime(m.volume, "signal", m.sound || current.sound); }
  if (m.type === "ringInfo") { current.lastRing = { ts: m.ts || Date.now(), reason: m.reason || "signal" }; render(); }
  if (m.type === "transcode") transcode(m);
  if (m.type === "config") { current = { ...current, ...m }; render(); }
});
$("folder").addEventListener("click", () => vscode.postMessage({ type: "openFolder" }));
$("vol").addEventListener("input", () => { current.volume = Number($("vol").value) / 100; });
$("vol").addEventListener("change", () => vscode.postMessage({ type: "setVolume", value: Number($("vol").value) / 100 }));
$("unlock").addEventListener("click", async () => { if (await unlocked()) vscode.postMessage({ type: "unlocked" }); });
render();
unlocked().then((ok) => vscode.postMessage({ type: "ready", audio: ok ? "running" : "suspended" }));
</script></body></html>`;
}

/** @returns {Promise<void>} the + flow: pick one or more audio files, transcode each into the library, choose the first */
async function addSound() {
  if (vscode.env.remoteName) {
    vscode.window.showInformationMessage("Claude Bell: in a remote window only the built-in sounds are available. Your own sounds live on your local machine.");
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: "Add to Claude Bell sounds",
    filters: { "Audio": ["wav", "mp3", "ogg", "oga", "flac", "m4a", "aac", "aiff", "aif"] },
  });
  if (!picked || !picked.length) return;
  picked.forEach((u, i) => requestTranscode(u.fsPath, "add", i === 0));
}

/**
 * @param {vscode.ExtensionContext} context
 * @returns {void}
 */
function activate(context) {
  extensionUri = context.extensionUri;
  out = vscode.window.createOutputChannel("Claude Bell");
  context.subscriptions.push(out);
  log(`activate — host ${vscode.env.remoteName || "local"} · home ${os.homedir()} · sounds ${soundsFolder()}`);

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
        if (m?.type !== "transcoded") log(`webview → ${JSON.stringify(m)}`);
        if (m?.type === "ready") {
          audioRunning = m.audio === "running";
          drainTranscodes("panel ready");
        }
        if (m?.type === "unlocked" || m?.type === "rang") audioRunning = true;
        if (m?.type === "locked") audioRunning = false;
        if (m?.type === "transcoded") saveTranscoded(m);
        if (m?.type === "transcodeError") {
          transcodeInFlight.delete(m.sourcePath);
          log(`transcode failed for ${m.name}: ${m.message}`);
          if (!transcodeErrorShown) {
            transcodeErrorShown = true;
            vscode.window.showWarningMessage(`Claude Bell: could not decode ${m.name} (${m.message}). Use .wav, .mp3, .ogg or .flac.`);
          }
        }
        if (m?.type === "setSound" && typeof m.value === "string") cfg().update("sound", m.value, vscode.ConfigurationTarget.Global).then(() => log(`sound=${m.value}`));
        if (m?.type === "setVolume" && Number.isFinite(Number(m.value))) cfg().update("volume", Math.max(0, Math.min(1, Number(m.value))), vscode.ConfigurationTarget.Global).then(() => log(`volume=${m.value}`));
        if (m?.type === "addSound") addSound();
        if (m?.type === "deleteSound" && typeof m.id === "string") deleteSound(m.id);
        if (m?.type === "openFolder") vscode.env.openExternal(vscode.Uri.file(soundsFolder()));
        if (m?.type === "fileError") vscode.window.showWarningMessage(`Claude Bell: could not play the sound (${m.message}).`);
      });
      v.onDidChangeVisibility(() => log(`webview visible=${v.visible}`));
      v.onDidDispose(() => {
        view = null;
        audioRunning = false;
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
  context.subscriptions.push(vscode.commands.registerCommand("claudeBell.addSound", addSound));
  context.subscriptions.push(vscode.commands.registerCommand("claudeBell.pickSoundFile", addSound));
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
    if (e.affectsConfiguration("claudeBell.soundsFolder") && !vscode.env.remoteName) watchFolder();
    if (e.affectsConfiguration("claudeBell")) pushConfig();
  }));

  watchSignal();
  ensureHook("activation");
  if (!vscode.env.remoteName) {
    watchFolder();
    migrateLegacyFile();
  } else {
    log("remote window: sound library disabled here, built-in sounds only");
  }
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
  if (folderPoll) clearInterval(folderPoll);
  if (watchedPath) fs.unwatchFile(watchedPath);
  for (const w of [dirWatcher, folderWatcher]) {
    try {
      if (w) w.close();
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
