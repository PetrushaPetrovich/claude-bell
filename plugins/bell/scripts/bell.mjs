#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @summary The bell of the `bell` plugin — a short system chime at the two moments a human is waited for: Claude Code finished its turn (Stop; a re-prompted Stop carrying stop_hook_active is not a wait and stays silent) or stopped on a prompt only the human can answer (Notification of type permission_prompt or idle_prompt). Installed means on; CLAUDE_BELL_ENABLED=0 mutes it without uninstalling. Every ring is first appended as one JSON line to ~/.claude/.claude-bell-signal — the feed the Claude Bell VS Code extension polls to chime on the USER's machine over SSH or WSL; when that extension is alive (its marker ~/.claude/.claude-bell-extension refreshed within 60 s) the OS player below is skipped and the stamp says code "extension", so a local session rings once; when the extension has also installed its own hook into ~/.claude/settings.json (entries carrying the claude-bell token) that hook already writes the signal line, so this plugin writes nothing at all and the stamp says code "extension-hook" — one event, one line, one ring. Otherwise the player is the OS's own — PowerShell System.Media.SoundPlayer on win32 behind a hidden window, with the built-in Asterisk system sound as the fallback when the file cannot be played, afplay on darwin, paplay on linux. The hook WAITS for the player to finish (about a second; the hook is registered async, so the turn is never delayed) because a child left detached dies with the hook process on some hosts — a bell that exits first rings nothing. The sound defaults to a stock system chime per platform and CLAUDE_BELL_SOUND overrides it; CLAUDE_BELL_NOTIFY (comma-separated) overrides the Notification types that ring. Rings at most once per 1500 ms via the stamp ~/.claude/.claude-bell-last, which also records the last ring's player exit code and duration — the first thing to read when «it does not ring». CLAUDE_BELL_SPY=<file> routes the resolved player command into that file instead of the speakers — the selftest's only ear. Every failure path is silent exit 0; stdout is never written, so the conversation never sees this hook.
 * @route bell | "play a sound when Claude finishes" · "why is it silent" (read ~/.claude/.claude-bell-last: code 0 = the player ran, then check the output device; no file = the hook never fired, reload hooks) · node bell.mjs --play — hear the chime now
 * @verdict ring | a waiting event and the debounce window passed: the player ran to its end (or one spy line was written); the stamp holds {ts,event,code,ms}; exit 0, no stdout
 * @verdict silent | muted, stop_hook_active, another Notification type, another event, inside the debounce window, malformed stdin, or ANY error — exit 0, no stdout, nothing spawned
 * @verdict play | --play: rings once regardless of mute and debounce; exit 0
 * @example printf '{"hook_event_name":"Stop"}' | node bell.mjs
 * @example printf '{"hook_event_name":"Notification","notification_type":"permission_prompt"}' | CLAUDE_BELL_SPY=/tmp/bell.jsonl node bell.mjs
 * @example node bell.mjs --play
 */

const DEBOUNCE_MS = 1500;
const PLAYER_CEILING_MS = 8000;
const MARKER_FRESH_MS = 60000;
const SIGNAL_CAP_BYTES = 65536;
const DEFAULT_NOTIFY_TYPES = ["permission_prompt", "idle_prompt"];

/** @returns {never} */
const done = () => process.exit(0);

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {Set<string>} the Notification types that ring — CLAUDE_BELL_NOTIFY, else the two prompt types
 */
export function notifyTypes(env) {
  const raw = String(env.CLAUDE_BELL_NOTIFY || "").split(",").map((s) => s.trim()).filter(Boolean);
  return new Set(raw.length ? raw : DEFAULT_NOTIFY_TYPES);
}

/**
 * @param {any} p parsed hook payload
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean} whether this event is a moment the human is waited for
 */
export function isWaitingEvent(p, env) {
  const ev = String(p?.hook_event_name || "");
  if (ev === "Stop") return p?.stop_hook_active !== true;
  if (ev === "Notification") return notifyTypes(env).has(String(p?.notification_type || ""));
  return false;
}

/**
 * @param {string} platform
 * @param {NodeJS.ProcessEnv} env
 * @returns {string} CLAUDE_BELL_SOUND, else the platform's stock chime
 */
export function soundPath(platform, env) {
  if (env.CLAUDE_BELL_SOUND) return String(env.CLAUDE_BELL_SOUND);
  if (platform === "win32") return join(env.WINDIR || env.SystemRoot || "C:\\Windows", "Media", "Windows Notify.wav");
  if (platform === "darwin") return "/System/Library/Sounds/Glass.aiff";
  return "/usr/share/sounds/freedesktop/stereo/complete.oga";
}

/**
 * @param {string} platform
 * @param {string} sound
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{cmd:string, args:string[]}} the OS's own player invocation; on win32 the absolute PowerShell path so PATH never decides, with the Asterisk system sound as the in-script fallback
 */
export function playerCommand(platform, sound, env = process.env) {
  if (platform === "win32") {
    const q = sound.replace(/'/g, "''");
    const ps = `try { (New-Object System.Media.SoundPlayer '${q}').PlaySync() } catch { [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 700 }`;
    const exe = join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return { cmd: exe, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", ps] };
  }
  if (platform === "darwin") return { cmd: "afplay", args: [sound] };
  return { cmd: "paplay", args: [sound] };
}

/** @returns {string} the stamp path — the last ring's record and the debounce anchor */
const stampPath = () => join(homedir(), ".claude", ".claude-bell-last");

/** @returns {string} the signal file the Claude Bell VS Code extension polls — one JSON line per ring */
const signalPath = () => join(homedir(), ".claude", ".claude-bell-signal");

/** @returns {string} the liveness marker the Claude Bell VS Code extension refreshes every 20 s */
const markerPath = () => join(homedir(), ".claude", ".claude-bell-extension");

/**
 * @param {string} event
 * @returns {void} appends one signal line; a file past SIGNAL_CAP_BYTES is restarted from this line
 */
function signalWrite(event) {
  try {
    mkdirSync(join(homedir(), ".claude"), { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), event }) + "\n";
    let size = 0;
    try {
      size = statSync(signalPath()).size;
    } catch {
      size = 0;
    }
    if (size > SIGNAL_CAP_BYTES) writeFileSync(signalPath(), line);
    else appendFileSync(signalPath(), line);
  } catch {
    void 0;
  }
}

/** @returns {boolean} whether the Claude Bell VS Code extension has installed its OWN hook into ~/.claude/settings.json (entries carrying the claude-bell token) — then that hook already writes the signal line and this plugin must not write a second one */
export function extensionHookInstalled() {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
    return JSON.stringify(s?.hooks || {}).includes("claude-bell");
  } catch {
    return false;
  }
}

/** @returns {boolean} whether the Claude Bell VS Code extension refreshed its marker within MARKER_FRESH_MS — then IT rings on the user's machine and the OS player stays quiet */
export function extensionAlive() {
  try {
    const t = Number(readFileSync(markerPath(), "utf8"));
    return Number.isFinite(t) && Date.now() - t < MARKER_FRESH_MS;
  } catch {
    return false;
  }
}

/**
 * @param {object} record {ts,event,code?,ms?}
 * @returns {void}
 */
function writeStamp(record) {
  try {
    mkdirSync(join(homedir(), ".claude"), { recursive: true });
    writeFileSync(stampPath(), JSON.stringify(record));
  } catch {
    void 0;
  }
}

/** @returns {number} the ts of the last ring, 0 when unknown */
function lastRingTs() {
  try {
    const raw = readFileSync(stampPath(), "utf8");
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    const j = JSON.parse(raw);
    return Number(j?.ts) || 0;
  } catch {
    return 0;
  }
}

/**
 * @param {string} event
 * @returns {Promise<void>} runs the player to its end and records {ts,event,code,ms}; in spy mode writes one spy line and a code "spy" stamp
 */
async function ring(event) {
  const platform = process.env.CLAUDE_BELL_PLATFORM || process.platform;
  const sound = soundPath(platform, process.env);
  const { cmd, args } = playerCommand(platform, sound, process.env);
  const t0 = Date.now();
  writeStamp({ ts: t0, event, code: "pending", ms: 0 });
  if (extensionAlive() && extensionHookInstalled()) {
    writeStamp({ ts: t0, event, code: "extension-hook", ms: 0 });
    return;
  }
  signalWrite(event);
  if (extensionAlive()) {
    writeStamp({ ts: t0, event, code: "extension", ms: 0 });
    return;
  }
  if (process.env.CLAUDE_BELL_SPY) {
    appendFileSync(process.env.CLAUDE_BELL_SPY, JSON.stringify({ ts: t0, event, platform, sound, cmd, args }) + "\n");
    writeStamp({ ts: t0, event, code: "spy", ms: 0 });
    return;
  }
  const code = await new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
      const ceiling = setTimeout(() => {
        try {
          child.kill();
        } catch {
          void 0;
        }
        resolve("timeout");
      }, PLAYER_CEILING_MS);
      child.on("error", (e) => {
        clearTimeout(ceiling);
        resolve(`spawn_error:${e.code || e.message}`);
      });
      child.on("exit", (c) => {
        clearTimeout(ceiling);
        resolve(c ?? "killed");
      });
    } catch (e) {
      resolve(`spawn_error:${e?.code || e?.message || "unknown"}`);
    }
  });
  writeStamp({ ts: t0, event, code, ms: Date.now() - t0 });
}

/** @returns {string} stdin, whole, or "" */
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  if (process.argv.includes("--play")) {
    await ring("play");
    done();
  }
  if (process.env.CLAUDE_BELL_ENABLED === "0") done();
  let payload = null;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    done();
  }
  if (!isWaitingEvent(payload, process.env)) done();
  if (Date.now() - lastRingTs() < DEBOUNCE_MS) done();
  await ring(String(payload.hook_event_name));
  done();
}
