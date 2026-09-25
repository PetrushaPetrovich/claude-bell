#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @summary The bell of the `bell` plugin — a short system chime at the two moments a human is waited for: Claude Code finished its turn (Stop; a re-prompted Stop carrying stop_hook_active is not a wait and stays silent) or stopped on a prompt only the human can answer (Notification of type permission_prompt or idle_prompt). Installed means on; CLAUDE_BELL_ENABLED=0 mutes it without uninstalling. The player is the OS's own — PowerShell System.Media.SoundPlayer on win32 behind a hidden window, afplay on darwin, paplay on linux — spawned detached and unref'd so the hook exits at once; the sound defaults to a stock system chime per platform and CLAUDE_BELL_SOUND overrides it; CLAUDE_BELL_NOTIFY (comma-separated) overrides the Notification types that ring. Rings at most once per 1500 ms (stamp ~/.claude/.claude-bell-last) so a Stop followed by an idle Notification is one chime. CLAUDE_BELL_SPY=<file> routes the resolved player command into that file instead of the speakers — the selftest's only ear. Every failure path is silent exit 0; stdout is never written, so the conversation never sees this hook.
 * @route bell | "play a sound when Claude finishes" · "why is it silent" (CLAUDE_BELL_ENABLED=0 · sound file missing · another Notification type) · node bell.mjs --play — hear the chime now
 * @verdict ring | a waiting event and the debounce window passed: ONE detached player process spawned, or one spy line written; exit 0, no stdout
 * @verdict silent | muted, stop_hook_active, another Notification type, another event, inside the debounce window, malformed stdin, or ANY error — exit 0, no stdout, nothing spawned
 * @verdict play | --play: rings once regardless of mute and debounce; exit 0
 * @example printf '{"hook_event_name":"Stop"}' | node bell.mjs
 * @example printf '{"hook_event_name":"Notification","notification_type":"permission_prompt"}' | CLAUDE_BELL_SPY=/tmp/bell.jsonl node bell.mjs
 * @example node bell.mjs --play
 */

const DEBOUNCE_MS = 1500;
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
 * @returns {{cmd:string, args:string[]}} the OS's own player invocation
 */
export function playerCommand(platform, sound) {
  if (platform === "win32") {
    const ps = `(New-Object System.Media.SoundPlayer '${sound.replace(/'/g, "''")}').PlaySync()`;
    return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps] };
  }
  if (platform === "darwin") return { cmd: "afplay", args: [sound] };
  return { cmd: "paplay", args: [sound] };
}

/** @returns {boolean} true when the previous ring is older than DEBOUNCE_MS; stamps this ring */
function debouncePassed() {
  const dir = join(homedir(), ".claude");
  const stamp = join(dir, ".claude-bell-last");
  const now = Date.now();
  try {
    const last = Number(readFileSync(stamp, "utf8"));
    if (Number.isFinite(last) && now - last < DEBOUNCE_MS) return false;
  } catch {
    void 0;
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(stamp, String(now));
  } catch {
    void 0;
  }
  return true;
}

/**
 * @param {string} event
 * @returns {void} one detached player process, or one spy line when CLAUDE_BELL_SPY names a file
 */
function ring(event) {
  const platform = process.env.CLAUDE_BELL_PLATFORM || process.platform;
  const sound = soundPath(platform, process.env);
  const { cmd, args } = playerCommand(platform, sound);
  if (process.env.CLAUDE_BELL_SPY) {
    appendFileSync(process.env.CLAUDE_BELL_SPY, JSON.stringify({ ts: Date.now(), event, platform, sound, cmd, args }) + "\n");
    return;
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => void 0);
    child.unref();
  } catch {
    void 0;
  }
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
    ring("play");
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
  if (!debouncePassed()) done();
  ring(String(payload.hook_event_name));
  done();
}
