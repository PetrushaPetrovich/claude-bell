#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @summary Deterministic selftest of bell.mjs — drives the REAL hook as a child process under a throwaway HOME with CLAUDE_BELL_SPY as its only ear and pins the contract: rings on Stop and records the ring in the stamp; silent when muted (CLAUDE_BELL_ENABLED=0), on a re-prompted Stop (stop_hook_active), on a Notification of another type and on a foreign event; rings on permission_prompt and on a type added through CLAUDE_BELL_NOTIFY; resolves the OS player per platform (powershell.exe SoundPlayer · afplay · paplay) and honours CLAUDE_BELL_SOUND with its quote escaped; one chime inside the debounce window; malformed stdin exits 0; stdout stays empty on every path.
 * @verdict Done | every scenario passed; fixture removed; exit 0
 * @verdict Blocked:assertion_failed | at least one scenario failed; fixture kept for forensics; exit 1
 * @example node plugins/bell/scripts/bell.selftest.mjs
 */

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "bell.mjs");
const T = mkdtempSync(join(tmpdir(), "claude-bell-"));
const CWD = join(T, "repo");
mkdirSync(CWD, { recursive: true });

let failures = 0;
let homes = 0;

/**
 * @param {string} label
 * @param {boolean} cond
 * @param {string} [detail]
 * @returns {void}
 */
const ok = (label, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "  ok " : "  FAIL"} ${label}${cond || !detail ? "" : ` — ${detail}`}`);
};

/** @returns {string} a fresh isolated HOME */
const freshHome = () => {
  const h = join(T, `home${homes++}`);
  mkdirSync(join(h, ".claude"), { recursive: true });
  return h;
};

/**
 * @param {any} payload stdin object, or a raw string for the malformed case
 * @param {Record<string,string>} envExtra
 * @param {string} [home]
 * @returns {{code:(number|null), stdout:string, lines:any[]}}
 */
const fire = (payload, envExtra = {}, home = freshHome()) => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_BELL_/.test(k)) env[k] = v;
  const spy = join(home, "spy.jsonl");
  Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_BELL_SPY: spy }, envExtra);
  const r = spawnSync(process.execPath, [HOOK], { input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", env, cwd: CWD });
  const lines = existsSync(spy) ? readFileSync(spy, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { code: r.status, stdout: String(r.stdout || ""), lines };
};

const STOP = { hook_event_name: "Stop", session_id: "s1", cwd: CWD };
const WIN_SOUND = "C:\\W\\Media\\Windows Notify.wav";
const CUSTOM_SOUND = "D:\\my's.wav";

let r = fire(STOP);
ok("Stop → one ring, no stdout", r.code === 0 && r.lines.length === 1 && r.lines[0].event === "Stop" && r.stdout === "", JSON.stringify(r));

r = fire(STOP, { CLAUDE_BELL_ENABLED: "0" });
ok("CLAUDE_BELL_ENABLED=0 → muted", r.code === 0 && r.lines.length === 0, JSON.stringify(r));

r = fire({ ...STOP, stop_hook_active: true });
ok("re-prompted Stop (stop_hook_active) → silent", r.code === 0 && r.lines.length === 0, JSON.stringify(r));

r = fire({ hook_event_name: "Notification", notification_type: "permission_prompt", cwd: CWD });
ok("Notification permission_prompt → rings", r.code === 0 && r.lines.length === 1 && r.lines[0].event === "Notification", JSON.stringify(r));

r = fire({ hook_event_name: "Notification", notification_type: "auth_success", cwd: CWD });
ok("Notification of another type → silent", r.code === 0 && r.lines.length === 0, JSON.stringify(r));

r = fire({ hook_event_name: "Notification", notification_type: "auth_success", cwd: CWD }, { CLAUDE_BELL_NOTIFY: "auth_success,idle_prompt" });
ok("CLAUDE_BELL_NOTIFY adds a type → rings", r.code === 0 && r.lines.length === 1, JSON.stringify(r));

r = fire({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd: CWD });
ok("foreign event → silent", r.code === 0 && r.lines.length === 0, JSON.stringify(r));

r = fire(STOP, { CLAUDE_BELL_PLATFORM: "win32", WINDIR: "C:\\W" });
ok("win32 → absolute powershell.exe, SoundPlayer over the stock chime with the Asterisk fallback, hidden window", r.lines.length === 1 && /[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/.test(r.lines[0].cmd) && r.lines[0].args.includes("Hidden") && r.lines[0].sound === WIN_SOUND && r.lines[0].args.at(-1).includes(`'${WIN_SOUND}'`) && r.lines[0].args.at(-1).includes("SystemSounds]::Asterisk"), JSON.stringify(r.lines));

const stampHome = freshHome();
r = fire(STOP, {}, stampHome);
let stamp = null;
try { stamp = JSON.parse(readFileSync(join(stampHome, ".claude", ".claude-bell-last"), "utf8")); } catch { stamp = null; }
ok("stamp records the last ring as {ts,event,code,ms}", !!stamp && stamp.event === "Stop" && stamp.code === "spy" && Number.isFinite(stamp.ts), JSON.stringify(stamp));
let signal = "";
try { signal = readFileSync(join(stampHome, ".claude", ".claude-bell-signal"), "utf8"); } catch { signal = ""; }
ok("every ring appends one JSON line to the signal file the VS Code extension polls", signal.trim().split("\n").length === 1 && JSON.parse(signal.trim()).event === "Stop", JSON.stringify(signal));

const extHome = freshHome();
writeFileSync(join(extHome, ".claude", ".claude-bell-extension"), String(Date.now()));
r = fire(STOP, {}, extHome);
let extStamp = null;
try { extStamp = JSON.parse(readFileSync(join(extHome, ".claude", ".claude-bell-last"), "utf8")); } catch { extStamp = null; }
ok("VS Code extension alive (fresh marker) → signal written, OS player skipped, stamp code extension", r.code === 0 && r.lines.length === 0 && extStamp?.code === "extension" && existsSync(join(extHome, ".claude", ".claude-bell-signal")), JSON.stringify({ lines: r.lines, extStamp }));

const staleHome = freshHome();
writeFileSync(join(staleHome, ".claude", ".claude-bell-extension"), String(Date.now() - 120000));
r = fire(STOP, {}, staleHome);
ok("stale marker (extension gone) → OS player rings again", r.code === 0 && r.lines.length === 1, JSON.stringify(r.lines));

r = fire(STOP, { CLAUDE_BELL_PLATFORM: "darwin" });
ok("darwin → afplay Glass.aiff", r.lines.length === 1 && r.lines[0].cmd === "afplay" && r.lines[0].args[0] === "/System/Library/Sounds/Glass.aiff", JSON.stringify(r.lines));

r = fire(STOP, { CLAUDE_BELL_PLATFORM: "linux" });
ok("linux → paplay freedesktop complete.oga", r.lines.length === 1 && r.lines[0].cmd === "paplay" && r.lines[0].args[0].endsWith("complete.oga"), JSON.stringify(r.lines));

r = fire(STOP, { CLAUDE_BELL_PLATFORM: "win32", CLAUDE_BELL_SOUND: CUSTOM_SOUND });
ok("CLAUDE_BELL_SOUND override reaches the player with its quote doubled", r.lines.length === 1 && r.lines[0].sound === CUSTOM_SOUND && r.lines[0].args.at(-1).includes("'D:\\my''s.wav'"), JSON.stringify(r.lines));

const debounceHome = freshHome();
fire(STOP, {}, debounceHome);
r = fire(STOP, {}, debounceHome);
ok("second Stop inside 1500 ms → one chime total", r.code === 0 && r.lines.length === 1, JSON.stringify(r.lines));

r = fire("{not json");
ok("malformed stdin → exit 0, silent", r.code === 0 && r.lines.length === 0 && r.stdout === "", JSON.stringify(r));

if (failures) {
  console.log(`Blocked:assertion_failed ${failures} scenario(s) failed — fixture kept at ${T}`);
  process.exit(1);
}
rmSync(T, { recursive: true, force: true });
console.log("Done: bell selftest — 17 scenarios passed");
