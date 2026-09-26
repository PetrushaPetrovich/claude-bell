/**
 * @summary Deterministic selftest of the Claude Bell extension, run before every package (`npm run package`) so a broken panel never ships: (1) loads extension.js under a mocked `vscode` module and renders the panel page exactly as resolveWebviewView does; (2) runs the page in jsdom with a mocked acquireVsCodeApi and AudioContext and asserts the script boots — posts `ready`, renders the header from a config message, highlights the chosen card, plays on a `ring` message and on a card's play button (a `rang` message comes back), reports `setSound` when a card is chosen — and that every element id the script touches exists in the markup; (3) exercises hook-install.js against a throwaway HOME: foreign hooks and settings survive, the install is idempotent, removal takes only ours, and the generated bash and PowerShell commands append exactly one line for a live Stop and none for a re-prompted one.
 * @verdict Done | every assertion passed; exit 0
 * @verdict Blocked:assertion_failed | at least one assertion failed, named on stdout; exit 1
 * @example node selftest.mjs
 */
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
let failures = 0;
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

/* 1. Render the panel page from the real extension.js under a mocked vscode module. */
const Module = require("module");
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") {
    return {
      Uri: { file: (p) => ({ fsPath: p, toString: () => `file://${p}` }) },
      window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }), createStatusBarItem: () => ({ show() {}, dispose() {} }) },
      workspace: { getConfiguration: () => ({ get: () => undefined }) },
      commands: {},
      env: {},
      StatusBarAlignment: { Right: 2 },
      ConfigurationTarget: { Global: 1 },
    };
  }
  return origLoad.call(this, request, ...rest);
};
const src = readFileSync(join(HERE, "extension.js"), "utf8");
const probePath = join(HERE, ".selftest-extension.cjs");
writeFileSync(probePath, src.replace("module.exports = { activate, deactivate };", "module.exports = { activate, deactivate, html };"));
let page = "";
try {
  const ext = require(probePath);
  page = ext.html({ cspSource: "vscode-resource:", asWebviewUri: (u) => u });
} finally {
  rmSync(probePath, { force: true });
}
ok("extension.js loads under a mocked vscode module and renders the panel page", page.length > 1000, `${page.length} chars`);
const script = (page.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/) || [])[1] || "";
let syntaxError = "";
try {
  new Function(script);
} catch (e) {
  syntaxError = e.message;
}
ok("panel script has no syntax error", !syntaxError, syntaxError);
const ids = [...new Set([...script.matchAll(/\$\("([A-Za-z]+)"\)|getElementById\("([A-Za-z]+)"\)/g)].map((m) => m[1] || m[2]))];
const missing = ids.filter((id) => !page.includes(`id="${id}"`));
ok(`every element id the script touches exists in the markup (${ids.length} ids)`, missing.length === 0, missing.join(", "));

/* 2. Boot the page in jsdom with mocked acquireVsCodeApi and AudioContext. */
const posted = [];
const dom = new JSDOM(page, { runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
w.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) });
class FakeNode { connect() { return this; } start() {} stop() {} }
class FakeParam { setValueAtTime() {} linearRampToValueAtTime() {} exponentialRampToValueAtTime() {} }
let gestureSeen = false;
class FakeAudioContext {
  constructor() { this.state = FakeAudioContext.startSuspended ? "suspended" : "running"; this.currentTime = 0; this.sampleRate = 44100; this.destination = {}; this.onstatechange = null; }
  resume() {
    if (!FakeAudioContext.startSuspended || gestureSeen) { this.state = "running"; if (this.onstatechange) this.onstatechange(); return Promise.resolve(); }
    return new Promise(() => {});
  }
  createOscillator() { const o = new FakeNode(); o.frequency = { value: 0 }; o.type = "sine"; return o; }
  createGain() { const g = new FakeNode(); g.gain = new FakeParam(); g.gain.value = 1; return g; }
  createBiquadFilter() { const f = new FakeNode(); f.frequency = { value: 0 }; f.type = ""; return f; }
  createBuffer(_c, len) { return { getChannelData: () => new Float32Array(len) }; }
  createBufferSource() { const s = new FakeNode(); s.buffer = null; return s; }
}
w.AudioContext = FakeAudioContext;
let runtimeError = "";
try {
  w.eval(script);
} catch (e) {
  runtimeError = e.message;
}
ok("panel script runs without a runtime error", !runtimeError, runtimeError);
const tick = () => new Promise((r) => setTimeout(r, 30));
await tick();
ok("page posts `ready` with audio running after boot", posted.some((m) => m.type === "ready" && m.audio === "running"), JSON.stringify(posted));
w.postMessage({ type: "config", enabled: true, sound: "soft", volume: 0.4, fileUrl: "", fileName: "", hook: "installed", host: "local", lastRing: { ts: 1700000000000, reason: "turn finished" } }, "*");
await tick();
const doc = w.document;
ok("header renders enabled state, hook state and last ring from a config message", doc.getElementById("enabled").textContent === "Enabled" && doc.getElementById("hook").textContent === "hook: installed" && doc.getElementById("last").textContent.includes("turn finished"), `${doc.getElementById("enabled").textContent} | ${doc.getElementById("hook").textContent} | ${doc.getElementById("last").textContent}`);
ok("the chosen card is highlighted", doc.querySelector('.card[data-s="soft"]').classList.contains("on") && !doc.querySelector('.card[data-s="desk"]').classList.contains("on"));
ok("volume slider follows the config", doc.getElementById("vol").value === "40", doc.getElementById("vol").value);
posted.length = 0;
w.postMessage({ type: "ring", volume: 0.5, sound: "soft", reason: "turn finished", ts: Date.now() }, "*");
await tick();
ok("a `ring` message plays and reports `rang`", posted.some((m) => m.type === "rang" && m.sound === "soft"), JSON.stringify(posted));
posted.length = 0;
doc.querySelector('.card[data-s="desk-double"] .play').click();
await tick();
ok("a card's play button previews that sound", posted.some((m) => m.type === "rang" && m.sound === "desk-double" && m.why === "preview"), JSON.stringify(posted));
posted.length = 0;
doc.querySelector('.card[data-s="desk"]').click();
await tick();
ok("clicking a card saves it as the sound", posted.some((m) => m.type === "setSound" && m.value === "desk") && doc.querySelector('.card[data-s="desk"]').classList.contains("on"), JSON.stringify(posted));
w.postMessage({ type: "config", enabled: false, sound: "desk", volume: 0.5, fileUrl: "", fileName: "", hook: "installed", host: "local", lastRing: null }, "*");
await tick();
ok("disabled state is visible in the header", doc.getElementById("enabled").textContent === "Disabled" && doc.body.classList.contains("off"));
dom.window.close();

/* 2b. The browser's autoplay rule: a suspended AudioContext whose resume() never settles until a click. */
FakeAudioContext.startSuspended = true;
gestureSeen = false;
const posted2 = [];
const dom2 = new JSDOM(page, { runScripts: "outside-only", pretendToBeVisual: true });
const w2 = dom2.window;
w2.acquireVsCodeApi = () => ({ postMessage: (m) => posted2.push(m) });
w2.AudioContext = FakeAudioContext;
w2.eval(script);
await new Promise((r) => setTimeout(r, 400));
ok("suspended audio: boot still posts `ready` (audio suspended) instead of hanging", posted2.some((m) => m.type === "ready" && m.audio === "suspended"), JSON.stringify(posted2));
ok("suspended audio: the Enable sound button is shown", w2.document.body.classList.contains("locked"));
posted2.length = 0;
w2.postMessage({ type: "ring", volume: 0.5, sound: "desk", reason: "turn finished", ts: Date.now() }, "*");
await new Promise((r) => setTimeout(r, 400));
ok("suspended audio: a ring reports `locked` instead of playing silently", posted2.some((m) => m.type === "locked") && !posted2.some((m) => m.type === "rang"), JSON.stringify(posted2));
posted2.length = 0;
gestureSeen = true;
w2.document.body.dispatchEvent(new w2.Event("pointerdown", { bubbles: true }));
await new Promise((r) => setTimeout(r, 400));
ok("a click anywhere in the panel unlocks audio and reports `unlocked`", posted2.some((m) => m.type === "unlocked") && !w2.document.body.classList.contains("locked"), JSON.stringify(posted2));
posted2.length = 0;
w2.postMessage({ type: "ring", volume: 0.5, sound: "desk", reason: "turn finished", ts: Date.now() }, "*");
await new Promise((r) => setTimeout(r, 400));
ok("after the unlock a ring plays", posted2.some((m) => m.type === "rang"), JSON.stringify(posted2));
dom2.window.close();
FakeAudioContext.startSuspended = false;

/* 3. hook-install.js against a throwaway HOME. */
const hook = require(join(HERE, "hook-install.js"));
const H = mkdtempSync(join(tmpdir(), "claude-bell-selftest-"));
mkdirSync(join(H, ".claude"), { recursive: true });
writeFileSync(join(H, ".claude", "settings.json"), JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo someone-else" }] }] } }));
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = H;
process.env.USERPROFILE = H;
const homedirBefore = require("node:os").homedir();
const settingsPath = join(H, ".claude", "settings.json");
const sig = join(H, ".claude", ".claude-bell-signal");
const quiet = () => {};
const a = hook.installHooks(sig, quiet);
const b = hook.installHooks(sig, quiet);
const s1 = JSON.parse(readFileSync(settingsPath, "utf8"));
ok("hook install writes once and is idempotent", a.changed === true && b.changed === false && homedirBefore === H, `${a.changed}/${b.changed} home=${homedirBefore}`);
ok("foreign settings and hooks survive the install", s1.model === "opus" && s1.hooks.Stop.some((g) => JSON.stringify(g).includes("someone-else")));
ok("our Stop and Notification entries are present, Notification matched on the prompt types", s1.hooks.Stop.some((g) => JSON.stringify(g).includes("claude-bell")) && s1.hooks.Notification?.[0]?.matcher === "idle_prompt|permission_prompt");
const r = hook.removeHooks(quiet);
const s2 = JSON.parse(readFileSync(settingsPath, "utf8"));
ok("removal takes only our entries", r.changed === true && !JSON.stringify(s2).includes("claude-bell") && s2.hooks.Stop.length === 1);
process.env.HOME = saved.HOME;
process.env.USERPROFILE = saved.USERPROFILE;

/* 4. The generated hook commands, live in bash (and PowerShell on Windows). */
const bashSig = join(H, "sig-bash.jsonl").split("\\").join("/");
const c = hook.commands(bashSig, "linux");
const bashOk = spawnSync("bash", ["-c", c.stop], { input: '{"stop_hook_active":false}', encoding: "utf8" });
spawnSync("bash", ["-c", c.stop], { input: '{"stop_hook_active": true}', encoding: "utf8" });
spawnSync("bash", ["-c", c.notif], { input: "", encoding: "utf8" });
if (bashOk.error) {
  console.log("  skip bash command test — bash not available");
} else {
  const lines = existsSync(join(H, "sig-bash.jsonl")) ? readFileSync(join(H, "sig-bash.jsonl"), "utf8").trim().split("\n") : [];
  ok("bash hook: live Stop and Notification append one line each, a re-prompted Stop appends none", lines.length === 2 && lines[0].includes('"Stop"') && lines[1].includes('"Notification"'), JSON.stringify(lines));
}
if (process.platform === "win32") {
  const psSig = join(H, "sig-ps.jsonl");
  const ps = hook.commands(psSig, "win32-force-powershell");
  const run = (cmd, input) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { input, encoding: "utf8" });
  if (ps.shell === "powershell") {
    run(ps.stop, '{"stop_hook_active":false}');
    run(ps.stop, '{"stop_hook_active":true}');
    run(ps.notif, "{}");
    const lines = existsSync(psSig) ? readFileSync(psSig, "utf8").trim().split("\n") : [];
    ok("PowerShell hook: live Stop and Notification append one line each, a re-prompted Stop appends none", lines.length === 2, JSON.stringify(lines));
  }
}
rmSync(H, { recursive: true, force: true });

if (failures) {
  console.log(`Blocked:assertion_failed ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("Done: claude-bell extension selftest passed");
