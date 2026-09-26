/**
 * @summary The self-contained hook of Claude Bell — how the extension gets its signal from Claude Code WITHOUT a separate plugin: it writes two hook entries into Claude Code's user settings (~/.claude/settings.json on the machine where Claude Code runs, which is the extension host's machine) — Stop, and Notification matched on idle_prompt|permission_prompt — whose command is a plain shell one-liner appending one JSON line to the signal file: bash everywhere Git Bash exists (on Windows that is the shell Claude Code already needs for its Bash tool, and PowerShell's script execution policy never touches it), PowerShell pinned through the `shell` field only on a Windows box without Git Bash; no node, no path into the extension folder, so a VS Code update never breaks it. Every entry carries the token `claude-bell`, so the install is idempotent (ours are replaced, everything else in settings.json is kept byte-for-byte, the write is atomic through a temp file) and the uninstall script can remove exactly ours. A Stop that carries stop_hook_active is skipped inside the command itself, so a re-prompted turn never rings. An unreadable settings.json is left untouched and reported, never overwritten.
 * @route claude-bell hook-install | installHooks(signalPath, log) · removeHooks(log) · commands(signalPath, platform) — extension.js at activation and on the claudeBell.installHook / signalFile settings, uninstall.js on `vscode:uninstall`
 * @verdict {changed:boolean, path:string, error?:string} | changed=true when settings.json was written; error names why nothing was written
 * @example node -e "require('./hook-install.js').installHooks(require('os').homedir()+'/.claude/.claude-bell-signal', console.log)"
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TOKEN = "claude-bell";
const NOTIFY_MATCHER = "idle_prompt|permission_prompt";

/** @returns {string} Claude Code's user settings on this machine */
const settingsPath = () => path.join(os.homedir(), ".claude", "settings.json");

/** @returns {boolean} whether Git Bash is installed — then Claude Code on Windows runs hooks through bash, the same shell it needs for its own Bash tool, and the bash one-liner is the safer form (PowerShell's script execution policy never applies to it) */
function gitBashPresent() {
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe"),
  ];
  return candidates.some((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * @param {string} signal absolute signal file path on this machine
 * @param {string} platform process.platform of the host
 * @returns {{stop:string, notif:string, shell:(string|null)}} the two hook commands and the shell they need
 */
function commands(signal, platform) {
  if (platform === "win32" && !gitBashPresent()) {
    const f = signal.replace(/'/g, "''");
    const dir = `New-Item -ItemType Directory -Force -Path (Split-Path -Parent '${f}') | Out-Null;`;
    const line = (ev) => `Add-Content -LiteralPath '${f}' -Value ('{"ts":'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+',"event":"${ev}"}')`;
    return {
      stop: `$null='${TOKEN}'; $i=[Console]::In.ReadToEnd(); if($i -notmatch '"stop_hook_active"\\s*:\\s*true'){ ${dir} ${line("Stop")} }`,
      notif: `$null='${TOKEN}'; ${dir} ${line("Notification")}`,
      shell: "powershell",
    };
  }
  const posix = platform === "win32" ? signal.replace(/\\/g, "/") : signal;
  const q = `'${posix.replace(/'/g, "'\\''")}'`;
  const line = (ev) => `mkdir -p "$(dirname ${q})"; printf '{"ts":%s000,"event":"${ev}"}\\n' "$(date +%s)" >> ${q}`;
  return {
    stop: `: ${TOKEN}; if ! cat | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then ${line("Stop")}; fi`,
    notif: `: ${TOKEN}; ${line("Notification")}`,
    shell: null,
  };
}

/**
 * @param {any} group one matcher group of a hooks event array
 * @returns {boolean} whether the group is Claude Bell's own
 */
const isOurs = (group) => JSON.stringify(group || {}).includes(TOKEN);

/**
 * @param {(line:string)=>void} log
 * @returns {{settings:any, path:string, error?:string}} the parsed settings, {} when the file is missing, error when it exists but is unreadable
 */
function readSettings(log) {
  const p = settingsPath();
  if (!fs.existsSync(p)) return { settings: {}, path: p };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return { settings: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}, path: p };
  } catch (e) {
    log(`settings.json unreadable, left untouched: ${e?.message}`);
    return { settings: null, path: p, error: String(e?.message || e) };
  }
}

/**
 * @param {string} p
 * @param {any} settings
 * @returns {void} atomic write through a temp file beside the target
 */
function writeSettings(p, settings) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${TOKEN}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

/**
 * @param {string} signal absolute signal file path on this machine
 * @param {(line:string)=>void} log
 * @returns {{changed:boolean, path:string, error?:string}}
 */
function installHooks(signal, log) {
  const r = readSettings(log);
  if (!r.settings) return { changed: false, path: r.path, error: r.error };
  const s = r.settings;
  const c = commands(signal, process.platform);
  const entry = (cmd, matcher) => {
    const h = { type: "command", command: cmd, async: true, timeout: 10 };
    if (c.shell) h.shell = c.shell;
    const g = { hooks: [h] };
    if (matcher) g.matcher = matcher;
    return g;
  };
  const want = { Stop: entry(c.stop), Notification: entry(c.notif, NOTIFY_MATCHER) };
  s.hooks = s.hooks && typeof s.hooks === "object" && !Array.isArray(s.hooks) ? s.hooks : {};
  let changed = false;
  for (const ev of Object.keys(want)) {
    const arr = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : [];
    const ours = arr.filter(isOurs);
    const same = ours.length === 1 && JSON.stringify(ours[0]) === JSON.stringify(want[ev]);
    if (!same) {
      s.hooks[ev] = [...arr.filter((g) => !isOurs(g)), want[ev]];
      changed = true;
    }
  }
  if (changed) {
    writeSettings(r.path, s);
    log(`hook installed into ${r.path} (${c.shell || "bash"})`);
  }
  return { changed, path: r.path };
}

/**
 * @param {(line:string)=>void} log
 * @returns {{changed:boolean, path:string, error?:string}}
 */
function removeHooks(log) {
  const r = readSettings(log);
  if (!r.settings) return { changed: false, path: r.path, error: r.error };
  const s = r.settings;
  let changed = false;
  if (s.hooks && typeof s.hooks === "object") {
    for (const ev of Object.keys(s.hooks)) {
      const arr = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : [];
      const kept = arr.filter((g) => !isOurs(g));
      if (kept.length !== arr.length) {
        changed = true;
        if (kept.length) s.hooks[ev] = kept;
        else delete s.hooks[ev];
      }
    }
    if (!Object.keys(s.hooks).length) delete s.hooks;
  }
  if (changed) {
    writeSettings(r.path, s);
    log(`hook removed from ${r.path}`);
  }
  return { changed, path: r.path };
}

module.exports = { installHooks, removeHooks, commands, settingsPath, TOKEN };
