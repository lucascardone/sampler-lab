// Built-in drum kit, synthesized in code (no bundled samples, no license questions).
// Pure functions returning mono Float32Arrays: deterministic (seeded noise), so what you
// hear while playing is bit-identical to the exported file.

import type { BuiltinDrum } from "./song";

/** Small seeded PRNG (mulberry32): same noise every time. */
function noise(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1;
  };
}

/** RBJ biquad filter, in place. */
function biquad(x: Float32Array, sr: number, type: "highpass" | "bandpass" | "lowpass", freq: number, q: number) {
  const w = (2 * Math.PI * freq) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  let b0: number, b1: number, b2: number;
  if (type === "lowpass") [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  else if (type === "highpass") [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  else [b0, b1, b2] = [alpha, 0, -alpha];
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i];
    y2 = y1; y1 = y;
    x[i] = y;
  }
}

/** Scale to `peak` and fade the last few ms so the end never clicks. */
function finish(x: Float32Array, sr: number, peak = 0.9): Float32Array {
  let max = 0;
  for (const v of x) max = Math.max(max, Math.abs(v));
  const g = max > 0 ? peak / max : 0;
  const fade = Math.min(x.length, Math.round(sr * 0.005));
  for (let i = 0; i < x.length; i++) {
    const f = i >= x.length - fade ? (x.length - i) / fade : 1;
    x[i] *= g * f;
  }
  return x;
}

const env = (t: number, tau: number) => Math.exp(-t / tau);

function kick(sr: number): Float32Array {
  const x = new Float32Array(Math.round(sr * 0.5));
  let phase = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    const f = 45 + 110 * Math.exp(-t / 0.035); // pitch drop: the "thump"
    phase += (2 * Math.PI * f) / sr;
    const click = t < 0.004 ? (1 - t / 0.004) * 0.3 : 0;
    x[i] = Math.sin(phase) * env(t, 0.16) + click;
  }
  return finish(x, sr);
}

function snare(sr: number): Float32Array {
  const x = new Float32Array(Math.round(sr * 0.28));
  const n = new Float32Array(x.length);
  const rnd = noise(2);
  for (let i = 0; i < n.length; i++) n[i] = rnd();
  biquad(n, sr, "highpass", 1800, 0.7);
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    const tone = Math.sin(2 * Math.PI * 185 * t) * env(t, 0.045) + Math.sin(2 * Math.PI * 330 * t) * env(t, 0.02) * 0.4;
    x[i] = tone * 0.7 + n[i] * env(t, 0.07);
  }
  return finish(x, sr);
}

function clap(sr: number): Float32Array {
  const x = new Float32Array(Math.round(sr * 0.32));
  const rnd = noise(3);
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    // Three quick bursts then a tail: several hands, slightly out of sync.
    let e = env(Math.max(0, t - 0.02), 0.09) * (t >= 0.02 ? 1 : 0);
    for (const d of [0, 0.008, 0.016]) if (t >= d && t < d + 0.008) e = Math.max(e, env(t - d, 0.004));
    x[i] = rnd() * e;
  }
  biquad(x, sr, "bandpass", 1200, 0.9);
  return finish(x, sr);
}

function hat(sr: number, open: boolean): Float32Array {
  const x = new Float32Array(Math.round(sr * (open ? 0.6 : 0.09)));
  const rnd = noise(open ? 5 : 4);
  // Metallic part: detuned squares (the classic drum-machine recipe) + noise.
  const freqs = [263, 400, 421, 474, 587, 845].map((f) => f * 1.6);
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    let m = 0;
    for (const f of freqs) m += Math.sign(Math.sin(2 * Math.PI * f * t));
    x[i] = (m / freqs.length) * 0.6 + rnd() * 0.5;
  }
  biquad(x, sr, "highpass", 7000, 0.7);
  biquad(x, sr, "highpass", 7000, 0.7);
  const tau = open ? 0.17 : 0.022;
  for (let i = 0; i < x.length; i++) x[i] *= env(i / sr, tau);
  return finish(x, sr, open ? 0.7 : 0.75);
}

function rim(sr: number): Float32Array {
  const x = new Float32Array(Math.round(sr * 0.07));
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    x[i] = (Math.sin(2 * Math.PI * 1700 * t) * 0.6 + Math.sin(2 * Math.PI * 520 * t)) * env(t, 0.012);
  }
  return finish(x, sr, 0.8);
}

export function synthDrum(id: BuiltinDrum, sampleRate: number): Float32Array {
  switch (id) {
    case "kick": return kick(sampleRate);
    case "snare": return snare(sampleRate);
    case "clap": return clap(sampleRate);
    case "hat": return hat(sampleRate, false);
    case "openHat": return hat(sampleRate, true);
    case "rim": return rim(sampleRate);
  }
}

/** Metronome tick (higher on the first beat of the bar). Never exported. */
export function synthClick(sampleRate: number, accent: boolean): Float32Array {
  const x = new Float32Array(Math.round(sampleRate * 0.03));
  const f = accent ? 1600 : 1100;
  for (let i = 0; i < x.length; i++) {
    const t = i / sampleRate;
    x[i] = Math.sin(2 * Math.PI * f * t) * env(t, 0.006);
  }
  return finish(x, sampleRate, 0.5);
}
