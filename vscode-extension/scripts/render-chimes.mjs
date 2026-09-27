/**
 * @summary Builds the four built-in chimes into media/sounds/<name>.wav (44.1 kHz, 16-bit mono, peak 0.9) plus media/sounds/manifest.json with each one's seconds and origin. A name that has a licensed recording in media/sounds-licensed/<name>.wav (a folder git never sees — those files may ship inside the package but not be redistributed as files) is converted from it: PCM WAV decoded (16/24/32-bit int or 32-bit float), downmixed to mono, silence trimmed at both ends, capped at 8 s, normalized. A name without one is synthesized with the SAME formulas the panel plays live — desk bell (inharmonic partials, detuned pairs, a high-passed click), desk bell ×2, soft chime, two-tone. Runs before every package so the folder is always complete.
 * @route render-chimes | node scripts/render-chimes.mjs
 * @verdict Done | four files and the manifest written, each with its seconds and origin printed
 * @verdict Blocked:licensed_unreadable | a licensed file is present but not PCM WAV — fix or remove it; exit 1
 * @example node scripts/render-chimes.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 44100;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "media", "sounds");
const LICENSED = join(ROOT, "media", "sounds-licensed");

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
    const env = t < attack ? 0.0001 * Math.pow(gain / 0.0001, t / attack) : gain * Math.pow(0.0001 / gain, Math.min(1, (t - attack) / Math.max(0.001, dur - attack)));
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
const SYNTH = {
  "desk": { seconds: 1.9, render: (b) => strike(b, 0, 1850, GAIN, 1.8) },
  "desk-double": { seconds: 2.0, render: (b) => { strike(b, 0, 1850, GAIN, 1.3); strike(b, 0.22, 1850, GAIN * 0.9, 1.7); } },
  "soft": { seconds: 1.5, render: (b) => { tone(b, 660, 0, 0.9, GAIN * 0.8, 0.03); tone(b, 880, 0.18, 1.2, GAIN * 0.7, 0.03); } },
  "classic": { seconds: 0.9, render: (b) => { tone(b, 880, 0, 0.55, GAIN); tone(b, 1320, 0.12, 0.7, GAIN * 0.8); } },
};

/**
 * @param {Buffer} b a PCM WAV file
 * @returns {{rate:number, mono:Float32Array}} decoded, downmixed to mono
 */
function decodeWav(b) {
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { tag: b.readUInt16LE(off + 8), ch: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === "data") {
      data = { off: off + 8, sz: Math.min(sz, b.length - off - 8) };
      break;
    }
    off += 8 + sz + (sz % 2);
  }
  if (!fmt || !data) throw new Error("fmt or data chunk missing");
  if (fmt.tag === 0xfffe) fmt.tag = fmt.bits === 32 ? 3 : 1;
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.sz / (bytes * fmt.ch));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const p = data.off + (i * fmt.ch + c) * bytes;
      let v;
      if (fmt.tag === 3 && fmt.bits === 32) v = b.readFloatLE(p);
      else if (fmt.bits === 16) v = b.readInt16LE(p) / 32768;
      else if (fmt.bits === 24) v = ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) << 8 >> 8) / 8388608;
      else if (fmt.bits === 32) v = b.readInt32LE(p) / 2147483648;
      else if (fmt.bits === 8) v = (b[p] - 128) / 128;
      else throw new Error(`unsupported bit depth ${fmt.bits}`);
      acc += v;
    }
    mono[i] = acc / fmt.ch;
  }
  return { rate: fmt.rate, mono };
}

/**
 * @param {Float32Array} src
 * @param {number} from
 * @returns {Float32Array} linear resample to RATE
 */
function resample(src, from) {
  if (from === RATE) return src;
  const n = Math.floor((src.length * RATE) / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * from) / RATE;
    const j = Math.floor(x);
    const t = x - j;
    out[i] = (src[j] || 0) * (1 - t) + (src[j + 1] || 0) * t;
  }
  return out;
}

/**
 * @param {Float32Array} s
 * @returns {Float32Array} silence trimmed at both ends (10 ms lead, 50 ms tail kept), capped at 8 s
 */
function trim(s) {
  let end = s.length;
  while (end > 1 && Math.abs(s[end - 1]) < 0.002) end--;
  end = Math.min(end + Math.floor(RATE * 0.05), s.length, RATE * 8);
  let start = 0;
  while (start < end - 1 && Math.abs(s[start]) < 0.002) start++;
  start = Math.max(0, start - Math.floor(RATE * 0.01));
  return s.subarray(start, end);
}

/**
 * @param {Float32Array} samples
 * @returns {Buffer} 16-bit PCM mono WAV, peak-normalized to 0.9
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
/** @type {Record<string, {seconds:number, origin:string}>} */
const manifest = {};
for (const [name, c] of Object.entries(SYNTH)) {
  const licensed = join(LICENSED, `${name}.wav`);
  let samples;
  let origin;
  if (existsSync(licensed)) {
    try {
      const d = decodeWav(readFileSync(licensed));
      samples = trim(resample(d.mono, d.rate));
      origin = "licensed recording";
    } catch (e) {
      console.log(`Blocked:licensed_unreadable ${licensed}: ${e.message}`);
      process.exit(1);
    }
  } else {
    samples = new Float32Array(Math.floor(c.seconds * RATE));
    c.render(samples);
    origin = "synthesized";
  }
  const bytes = wav(samples);
  writeFileSync(join(OUT, `${name}.wav`), bytes);
  const seconds = samples.length / RATE;
  manifest[name] = { seconds: Math.round(seconds * 100) / 100, origin };
  console.log(`${name}.wav  ${seconds.toFixed(2)} s  ${(bytes.length / 1024).toFixed(0)} KB  (${origin})`);
}
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("Done: chimes built into", OUT);
