/**
 * @summary Renders the four built-in chimes to WAV files (media/sounds/<name>.wav, 44.1 kHz, 16-bit mono) with the SAME formulas the panel synthesizes live — desk bell (five inharmonic partials with paired detuned oscillators, exponential decays and a 12 ms high-passed noise click), desk bell ×2, soft chime, two-tone — so the OS player and the panel preview produce one sound. Peak-normalized to 0.9; volume is the player's job. Run once per formula change and commit the files; the extension selftest refuses to package when a file is missing or malformed.
 * @route render-chimes | node scripts/render-chimes.mjs
 * @verdict Done | four files written, sizes and durations printed
 * @example node scripts/render-chimes.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 44100;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "media", "sounds");

/**
 * @param {Float32Array} buf
 * @param {number} f
 * @param {number} t0
 * @param {number} dur
 * @param {number} gain
 * @param {number} attack
 * @returns {void} sine with an exponential attack to gain and an exponential decay to silence at t0+dur
 */
function tone(buf, f, t0, dur, gain, attack = 0.01) {
  const start = Math.floor(t0 * RATE);
  const end = Math.min(buf.length, Math.floor((t0 + dur + 0.05) * RATE));
  for (let i = start; i < end; i++) {
    const t = i / RATE - t0;
    let env;
    if (t < attack) env = 0.0001 * Math.pow(gain / 0.0001, t / attack);
    else env = gain * Math.pow(0.0001 / gain, Math.min(1, (t - attack) / Math.max(0.001, dur - attack)));
    buf[i] += env * Math.sin(2 * Math.PI * f * t);
  }
}

/**
 * @param {Float32Array} buf
 * @param {number} t0
 * @param {number} f0
 * @param {number} gain
 * @param {number} decay
 * @returns {void} the desk bell strike: partials, detuned pairs, a high-passed noise click
 */
function strike(buf, t0, f0, gain, decay) {
  const parts = [[1, 1, 1], [2.0, 0.45, 0.6], [2.72, 0.3, 0.45], [4.1, 0.15, 0.3], [5.4, 0.08, 0.2]];
  const start = Math.floor(t0 * RATE);
  for (const [r, g, d] of parts) {
    for (const det of [-2.5, 2.5]) {
      const f = f0 * r + det;
      const peak = gain * g * 0.5;
      const dur = decay * d;
      const end = Math.min(buf.length, Math.floor((t0 + dur + 0.05) * RATE));
      for (let i = start; i < end; i++) {
        const t = i / RATE - t0;
        const env = t < 0.004 ? peak * (t / 0.004) : peak * Math.pow(0.0001 / peak, Math.min(1, (t - 0.004) / Math.max(0.001, dur - 0.004)));
        buf[i] += env * Math.sin(2 * Math.PI * f * t);
      }
    }
  }
  const n = Math.floor(0.012 * RATE);
  const rc = 1 / (2 * Math.PI * 3000);
  const a = rc / (rc + 1 / RATE);
  let y = 0;
  let xPrev = 0;
  let seed = 12345;
  for (let i = 0; i < n && start + i < buf.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const x = ((seed / 0x7fffffff) * 2 - 1) * (1 - i / n);
    y = a * (y + x - xPrev);
    xPrev = x;
    buf[start + i] += y * gain * 0.35;
  }
}

const GAIN = 0.5;
/** @type {Record<string, {seconds:number, render:(b:Float32Array)=>void}>} */
const CHIMES = {
  "desk": { seconds: 1.9, render: (b) => strike(b, 0, 1850, GAIN, 1.8) },
  "desk-double": { seconds: 2.0, render: (b) => { strike(b, 0, 1850, GAIN, 1.3); strike(b, 0.22, 1850, GAIN * 0.9, 1.7); } },
  "soft": { seconds: 1.5, render: (b) => { tone(b, 660, 0, 0.9, GAIN * 0.8, 0.03); tone(b, 880, 0.18, 1.2, GAIN * 0.7, 0.03); } },
  "classic": { seconds: 0.9, render: (b) => { tone(b, 880, 0, 0.55, GAIN); tone(b, 1320, 0.12, 0.7, GAIN * 0.8); } },
};

/**
 * @param {Float32Array} samples
 * @returns {Buffer} 16-bit PCM mono WAV
 */
function wav(samples) {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const norm = peak > 0 ? 0.9 / peak : 1;
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * norm * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, c] of Object.entries(CHIMES)) {
  const buf = new Float32Array(Math.floor(c.seconds * RATE));
  c.render(buf);
  const file = join(OUT, `${name}.wav`);
  const bytes = wav(buf);
  writeFileSync(file, bytes);
  console.log(`${name}.wav  ${c.seconds.toFixed(1)} s  ${(bytes.length / 1024).toFixed(0)} KB`);
}
console.log("Done: chimes rendered to", OUT);
