/**
 * @summary The OS player of Claude Bell — plays a sound file through the operating system of the machine the extension host runs on, with volume, and needs no user gesture (unlike the panel's webview, which the browser keeps muted until a click). win32: PowerShell with WPF MediaPlayer (wav/mp3, volume 0..1, waits for the natural duration, falls back to SoundPlayer for wav when WPF is unavailable) run as a -Command so the script execution policy never applies; darwin: afplay -v; linux: paplay --volume, aplay as the fallback. play() RESOLVES WITH THE PLAYER'S EXIT CODE — 0 means the player ran the file to its end, anything else (a missing player, a bad file, a 20 s timeout) tells the caller to retry with a built-in sound. Pure command builder + one spawn, stdio ignored, never throws.
 * @route claude-bell player | playerCommand(platform, file, volume) · play(file, volume, log) → Promise<number> — extension.js ring() on a local window
 * @verdict 0 | the player exited cleanly after playing
 * @verdict -1 | the player could not be started (spawn error); -2 | killed after 20 s; -3 | the file does not exist; N | the player's own non-zero exit (win32: a file WPF cannot open throws before playing, so a silent zero never hides a missing sound)
 * @example node -e "require('./player.js').play(require('path').resolve('media/sounds/desk.wav'), 0.6, console.log).then(console.log)"
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

const CEILING_MS = 20000;

/**
 * @param {string} platform process.platform
 * @param {string} file absolute path of a wav/mp3/ogg file on this machine
 * @param {number} volume 0..1
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{cmd:string, args:string[]}}
 */
function playerCommand(platform, file, volume, env = process.env) {
  const v = Math.max(0, Math.min(1, Number(volume) || 0));
  if (platform === "win32") {
    const uri = "file:///" + file.replace(/\\/g, "/").replace(/'/g, "''");
    const wavPath = file.replace(/'/g, "''");
    const ps = "$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName PresentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([Uri]'" + uri + "'); $t = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $t -lt 40) { Start-Sleep -Milliseconds 50; $t++ }; if (-not $p.NaturalDuration.HasTimeSpan) { throw 'no media' }; $p.Volume = " + v.toFixed(2) + "; $p.Play(); $ms = if ($p.NaturalDuration.HasTimeSpan) { [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 300 } else { 3000 }; Start-Sleep -Milliseconds $ms; $p.Close() } catch { (New-Object System.Media.SoundPlayer '" + wavPath + "').PlaySync() }";
    const exe = path.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return { cmd: exe, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", ps] };
  }
  if (platform === "darwin") return { cmd: "afplay", args: ["-v", v.toFixed(2), file] };
  return { cmd: "paplay", args: [`--volume=${Math.round(v * 65536)}`, file] };
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {(line:string)=>void} log
 * @returns {Promise<number>} the process exit code, -1 when it could not start, -2 when killed at the ceiling
 */
function run(cmd, args, log) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };
    try {
      const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
      const ceiling = setTimeout(() => {
        try {
          child.kill();
        } catch {
          void 0;
        }
        log(`OS player killed after ${CEILING_MS} ms: ${cmd}`);
        finish(-2);
      }, CEILING_MS);
      child.on("error", (e) => {
        clearTimeout(ceiling);
        log(`OS player could not start (${cmd}): ${e?.message}`);
        finish(-1);
      });
      child.on("exit", (code) => {
        clearTimeout(ceiling);
        finish(code === null ? -1 : code);
      });
    } catch (e) {
      log(`OS player failed: ${e?.message}`);
      finish(-1);
    }
  });
}

/**
 * @param {string} file
 * @param {number} volume
 * @param {(line:string)=>void} log
 * @returns {Promise<number>} the exit code of the player that ran (linux: aplay's when paplay is absent)
 */
async function play(file, volume, log) {
  try {
    if (!require("node:fs").statSync(file).isFile()) throw new Error("not a file");
  } catch {
    log(`OS player: file missing ${file}`);
    return -3;
  }
  const { cmd, args } = playerCommand(process.platform, file, volume);
  const code = await run(cmd, args, log);
  if (code === -1 && process.platform === "linux" && cmd === "paplay") return run("aplay", ["-q", file], log);
  return code;
}

module.exports = { playerCommand, play };
