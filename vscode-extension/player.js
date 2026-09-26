/**
 * @summary The OS player of Claude Bell — plays a sound file through the operating system of the machine the extension host runs on, with volume, and needs no user gesture (unlike the panel's webview, which the browser keeps muted until a click). win32: PowerShell with WPF MediaPlayer (wav/mp3, volume 0..1, waits for the natural duration, falls back to SoundPlayer for wav when WPF is unavailable) run as a -Command so the script execution policy never applies; darwin: afplay -v; linux: paplay --volume, aplay as the fallback. Pure command builder + one spawn, stdio ignored, never throws.
 * @route claude-bell player | playerCommand(platform, file, volume) · play(file, volume, log) — extension.js ring() on a local window
 * @verdict {cmd, args} | the invocation for the platform; play() logs a spawn error and otherwise returns after spawning
 * @example node -e "require('./player.js').play(require('path').resolve('media/sounds/desk.wav'), 0.6, console.log)"
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

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
    const ps = "$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName PresentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([Uri]'" + uri + "'); $t = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $t -lt 40) { Start-Sleep -Milliseconds 50; $t++ }; $p.Volume = " + v.toFixed(2) + "; $p.Play(); $ms = if ($p.NaturalDuration.HasTimeSpan) { [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 300 } else { 3000 }; Start-Sleep -Milliseconds $ms; $p.Close() } catch { (New-Object System.Media.SoundPlayer '" + wavPath + "').PlaySync() }";
    const exe = path.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return { cmd: exe, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", ps] };
  }
  if (platform === "darwin") return { cmd: "afplay", args: ["-v", v.toFixed(2), file] };
  return { cmd: "paplay", args: [`--volume=${Math.round(v * 65536)}`, file] };
}

/**
 * @param {string} file
 * @param {number} volume
 * @param {(line:string)=>void} log
 * @returns {void}
 */
function play(file, volume, log) {
  const { cmd, args } = playerCommand(process.platform, file, volume);
  try {
    const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
    child.on("error", (e) => {
      if (process.platform === "linux" && cmd === "paplay") {
        try {
          spawn("aplay", ["-q", file], { stdio: "ignore" }).on("error", (e2) => log(`OS player failed: ${e2?.message}`));
        } catch (e2) {
          log(`OS player failed: ${e2?.message}`);
        }
      } else {
        log(`OS player failed: ${e?.message}`);
      }
    });
  } catch (e) {
    log(`OS player failed: ${e?.message}`);
  }
}

module.exports = { playerCommand, play };
