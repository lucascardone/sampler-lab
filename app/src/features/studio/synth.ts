// Built-in synthesizer: a few presets built from Web Audio oscillators, a low-pass
// filter with its own envelope, and an ADSR amp envelope. Works the same in a live
// AudioContext and an OfflineAudioContext (export), so playback == file.

import type { SynthPreset } from "./song";

interface Osc {
  type: OscillatorType;
  /** Octave offset. */
  octave: number;
  /** Cents (detuned pairs make it wide and warm). */
  detune: number;
  gain: number;
}

interface Preset {
  oscs: Osc[];
  /** Low-pass: base cutoff (Hz), resonance, extra cutoff at the attack and how fast it falls (s). */
  filter: { freq: number; q: number; env: number; decay: number };
  /** Attack, decay (s), sustain level (0–1), release (s). */
  amp: { a: number; d: number; s: number; r: number };
  gain: number;
}

const PRESETS: Record<SynthPreset, Preset> = {
  // 808-style sub bass: almost pure sine, long decay.
  sub: {
    oscs: [
      { type: "sine", octave: 0, detune: 0, gain: 1 },
      { type: "triangle", octave: 1, detune: 0, gain: 0.12 },
    ],
    filter: { freq: 1800, q: 0.5, env: 0, decay: 0.1 },
    amp: { a: 0.003, d: 1.2, s: 0.35, r: 0.25 },
    gain: 0.9,
  },
  bass: {
    oscs: [
      { type: "sawtooth", octave: 0, detune: 0, gain: 0.6 },
      { type: "square", octave: -1, detune: 0, gain: 0.4 },
    ],
    filter: { freq: 450, q: 4, env: 1800, decay: 0.18 },
    amp: { a: 0.004, d: 0.25, s: 0.6, r: 0.08 },
    gain: 0.55,
  },
  pad: {
    oscs: [
      { type: "sawtooth", octave: 0, detune: -9, gain: 0.4 },
      { type: "sawtooth", octave: 0, detune: 9, gain: 0.4 },
      { type: "triangle", octave: -1, detune: 0, gain: 0.3 },
    ],
    filter: { freq: 1500, q: 0.8, env: 600, decay: 1.2 },
    amp: { a: 0.35, d: 0.6, s: 0.75, r: 0.9 },
    gain: 0.3,
  },
  keys: {
    oscs: [
      { type: "triangle", octave: 0, detune: 0, gain: 0.6 },
      { type: "sine", octave: 1, detune: 0, gain: 0.25 },
      { type: "sine", octave: 0, detune: 4, gain: 0.3 },
    ],
    filter: { freq: 3500, q: 0.5, env: 0, decay: 0.1 },
    amp: { a: 0.004, d: 0.9, s: 0.35, r: 0.35 },
    gain: 0.45,
  },
  pluck: {
    oscs: [
      { type: "sawtooth", octave: 0, detune: -4, gain: 0.5 },
      { type: "sawtooth", octave: 0, detune: 4, gain: 0.5 },
    ],
    filter: { freq: 500, q: 2, env: 5000, decay: 0.12 },
    amp: { a: 0.002, d: 0.35, s: 0, r: 0.25 },
    gain: 0.4,
  },
  lead: {
    oscs: [
      { type: "square", octave: 0, detune: -6, gain: 0.45 },
      { type: "sawtooth", octave: 0, detune: 6, gain: 0.45 },
    ],
    filter: { freq: 2800, q: 2, env: 1500, decay: 0.3 },
    amp: { a: 0.01, d: 0.2, s: 0.7, r: 0.15 },
    gain: 0.3,
  },
};

/** Seconds a note keeps sounding after its end (for export tails). */
export function synthRelease(preset: SynthPreset): number {
  return PRESETS[preset].amp.r * 1.5;
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Play one note. `duration` is how long the key is held (s). Returns the oscillators so
 * the caller can stop them early (transport stop).
 */
export function synthVoice(
  ctx: BaseAudioContext,
  preset: SynthPreset,
  dest: AudioNode,
  when: number,
  duration: number,
  midi: number,
  velocity: number,
  glide?: Glide,
): OscillatorNode[] {
  const v = synthNoteOn(ctx, preset, dest, when, midi, velocity, glide);
  v.release(when + duration);
  return v.oscs;
}

/** Slide into the note: start at MIDI note `from` and arrive after `seconds`. */
export interface Glide {
  from: number;
  seconds: number;
}

export interface SynthNote {
  oscs: OscillatorNode[];
  /** Let go of the key at time `at` (the release starts there). */
  release: (at: number) => void;
}

/** Start a note that holds until `release` is called (live playing). */
export function synthNoteOn(
  ctx: BaseAudioContext,
  preset: SynthPreset,
  dest: AudioNode,
  when: number,
  midi: number,
  velocity: number,
  glide?: Glide,
): SynthNote {
  const p = PRESETS[preset];
  const { a, d, s, r } = p.amp;
  const peak = velocity * p.gain;

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, when);
  amp.gain.linearRampToValueAtTime(peak, when + a);
  amp.gain.setTargetAtTime(peak * s, when + a, d / 3);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = p.filter.q;
  // Higher notes open the filter a bit (keyboard tracking) so they don't sound muffled.
  const base = Math.min(18000, p.filter.freq * Math.pow(2, (midi - 48) / 24));
  filter.frequency.setValueAtTime(Math.min(18000, base + p.filter.env), when);
  filter.frequency.setTargetAtTime(base, when, p.filter.decay / 3);

  filter.connect(amp).connect(dest);
  const hz = midiToHz(midi);
  const oscs = p.oscs.map((o) => {
    const osc = ctx.createOscillator();
    osc.type = o.type;
    const f = hz * Math.pow(2, o.octave);
    if (glide && glide.seconds > 0) {
      // Exponential in Hz = a straight line in pitch, like a real glide.
      osc.frequency.setValueAtTime(midiToHz(glide.from) * Math.pow(2, o.octave), when);
      osc.frequency.exponentialRampToValueAtTime(f, when + glide.seconds);
    } else osc.frequency.value = f;
    osc.detune.value = o.detune;
    const g = ctx.createGain();
    g.gain.value = o.gain;
    osc.connect(g).connect(filter);
    osc.start(when);
    return osc;
  });
  let released = false;
  return {
    oscs,
    release: (at: number) => {
      if (released) return;
      released = true;
      const off = Math.max(at, when + a);
      amp.gain.setTargetAtTime(0, off, r / 4);
      for (const o of oscs) o.stop(off + r * 1.5);
    },
  };
}
