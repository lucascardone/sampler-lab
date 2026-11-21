// Mixer graph (Web Audio), the same for live playback and export:
//
//   voices → [drive] → EQ low/mid/high → [filter (+movement)] → [modulation] → compressor
//          → fader → duck → [width] → pan ─┬──────────────────→ master → limiter → out
//                                           ├→ reverb send → reverb ↗
//                                           └→ delay send  → delay  ↗ (normal or ping-pong)
//
// Blocks in [brackets] only exist while they're turned on, so many channels with no
// effects cost no more than before. There is one strip per channel (its audio clips) plus
// one per channel in each pattern that plays it, because every pattern has its own mix
// (`Pattern.mix`): the kick of one pattern can have reverb while the kick of another doesn't. Reverb and delay are shared "return" effects (like
// Ableton's returns or FL's sends): each channel decides how much it sends to them.

import { createModFx, type ModFx } from "./modfx";
import { driveCurve, driveMakeup } from "./shaper";
import { mixStrips, stepSeconds, stripKey, type ChannelFx, type ChannelMix, type ReverbSize, type Song } from "./song";

interface DriveBlock {
  shaper: WaveShaperNode;
  post: GainNode;
  /** type + amount the curve was built for (curves are rebuilt only when these change). */
  key: string;
}

interface FilterBlock {
  filter: BiquadFilterNode;
  /** "Movimiento": LFO → filter.detune (cents). */
  osc: OscillatorNode;
  depth: GainNode;
}

interface WidthBlock {
  input: GainNode;
  /** L→L, R→L, L→R, R→R. */
  gains: [GainNode, GainNode, GainNode, GainNode];
  output: ChannelMergerNode;
  nodes: AudioNode[];
}

export interface Strip {
  input: GainNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  comp: DynamicsCompressorNode;
  fader: GainNode;
  /** "Bombeo": automated by `Mixer.duck`. */
  duck: GainNode;
  pan: StereoPannerNode;
  rev: GainNode;
  dly: GainNode;
  drive: DriveBlock | null;
  filter: FilterBlock | null;
  mod: ModFx | null;
  modType: string;
  width: WidthBlock | null;
}

/** Every node of a strip, optional blocks included. */
function stripNodes(s: Strip): AudioNode[] {
  const out: AudioNode[] = [s.input, s.low, s.mid, s.high, s.comp, s.fader, s.duck, s.pan, s.rev, s.dly];
  if (s.drive) out.push(s.drive.shaper, s.drive.post);
  if (s.filter) out.push(s.filter.filter, s.filter.osc, s.filter.depth);
  if (s.width) out.push(...s.width.nodes);
  return out;
}

/** Unplug every node of a strip so nothing of a removed channel stays alive. */
export function disconnectStrip(s: Strip) {
  if (s.filter) s.filter.osc.stop();
  s.mod?.dispose();
  for (const node of stripNodes(s)) node.disconnect();
}

/** Seconds each reverb size rings. */
export const REVERB_LENGTH: Record<ReverbSize, number> = { room: 0.8, hall: 2.4, huge: 5 };
/** The default (hall) reverb length. */
export const REVERB_SECONDS = REVERB_LENGTH.hall;

/** Stereo reverb impulse: decaying noise, darker as it fades. Seeded: same every time. */
export function reverbImpulse(sampleRate: number, seconds = REVERB_SECONDS): AudioBuffer {
  const length = Math.round(sampleRate * seconds);
  const ir = new AudioBuffer({ length, sampleRate, numberOfChannels: 2 });
  for (let ch = 0; ch < 2; ch++) {
    let seed = 1234 + ch * 777;
    const data = ir.getChannelData(ch);
    let lp = 0;
    const pre = Math.round(sampleRate * 0.012); // pre-delay: keeps the dry sound clear
    for (let i = pre; i < length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const n = seed / 4294967296 - 0.5;
      const t = (i - pre) / sampleRate;
      // One-pole low-pass closing over time: high frequencies die first, like a real room.
      const k = Math.max(0.05, 0.9 - t / seconds);
      lp += k * (n - lp);
      data[i] = lp * Math.exp((-6.9 * t) / seconds);
    }
  }
  return ir;
}

const impulses = new Map<string, AudioBuffer>();
function impulseFor(sampleRate: number, size: ReverbSize): AudioBuffer {
  const key = `${sampleRate}-${size}`;
  let ir = impulses.get(key);
  if (!ir) impulses.set(key, (ir = reverbImpulse(sampleRate, REVERB_LENGTH[size])));
  return ir;
}

/** Filter cutoff 0..1 → Hz, exponential 40 Hz..18 kHz (equal steps sound equal). */
export const cutoffHz = (v: number) => 40 * Math.pow(18000 / 40, Math.max(0, Math.min(1, v)));
/** Resonance 0..1 → Q. */
export const resonanceQ = (v: number) => 0.7 + Math.max(0, Math.min(1, v)) * 11.3;
/** Movement depth 0..1 → cents of sweep (up to ±2 octaves). */
export const moveCents = (v: number) => Math.max(0, Math.min(1, v)) * 2400;

/** Width gains [L→L, R→L, L→R, R→R] for a mid/side width (1 = unchanged, 0 = mono). */
export function widthGains(w: number): [number, number, number, number] {
  const a = 0.5 * (1 + w);
  const b = 0.5 * (1 - w);
  return [a, b, b, a];
}

/** How deep a duck goes for an amount 0..1 (gain at the bottom). */
export const duckFloor = (amount: number) => 1 - Math.max(0, Math.min(1, amount)) * 0.9;

type Param = AudioParam;

export class Mixer {
  readonly master: GainNode;
  readonly strips = new Map<string, Strip>();
  private limiter: DynamicsCompressorNode;
  private reverbIn: GainNode;
  private conv: ConvolverNode;
  private reverbSize: ReverbSize = "hall";
  private delayIn: GainNode;
  private delay: DelayNode;
  private feedback: GainNode;
  private delayOut: GainNode;
  private ppL: DelayNode;
  private ppR: DelayNode;
  private ppFeedback: GainNode;
  private ppOut: GainNode;
  /** Source channel id → channels that duck when it plays (and by how much). */
  private duckers = new Map<string, { strip: Strip; amount: number }[]>();

  constructor(
    private ctx: BaseAudioContext,
    out: AudioNode,
  ) {
    this.master = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.master.connect(this.limiter).connect(out);

    this.reverbIn = ctx.createGain();
    this.conv = ctx.createConvolver();
    this.conv.buffer = impulseFor(ctx.sampleRate, this.reverbSize);
    const revOut = ctx.createGain();
    revOut.gain.value = 0.9;
    this.reverbIn.connect(this.conv).connect(revOut).connect(this.master);

    // Normal delay: each repeat a little darker.
    this.delayIn = ctx.createGain();
    this.delay = ctx.createDelay(4);
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 3500;
    this.feedback = ctx.createGain();
    this.delayOut = ctx.createGain();
    this.delayOut.gain.value = 0.7;
    this.delayIn.connect(this.delay).connect(tone);
    tone.connect(this.feedback).connect(this.delay);
    tone.connect(this.delayOut).connect(this.master);

    // Ping-pong: left, then right, then left… (only heard when turned on).
    this.ppL = ctx.createDelay(4);
    this.ppR = ctx.createDelay(4);
    const toneL = ctx.createBiquadFilter();
    toneL.type = "lowpass";
    toneL.frequency.value = 3500;
    const panL = ctx.createStereoPanner();
    panL.pan.value = -0.9;
    const panR = ctx.createStereoPanner();
    panR.pan.value = 0.9;
    this.ppFeedback = ctx.createGain();
    this.ppOut = ctx.createGain();
    this.ppOut.gain.value = 0;
    this.delayIn.connect(this.ppL).connect(toneL);
    toneL.connect(panL).connect(this.ppOut);
    toneL.connect(this.ppR);
    this.ppR.connect(panR).connect(this.ppOut);
    this.ppR.connect(this.ppFeedback).connect(this.ppL);
    this.ppOut.connect(this.master);
  }

  private set(p: Param, v: number, smooth: boolean) {
    if (smooth) p.setTargetAtTime(v, this.ctx.currentTime, 0.015);
    else p.value = v;
  }

  private createStrip(): Strip {
    const c = this.ctx;
    const input = c.createGain();
    const low = c.createBiquadFilter();
    low.type = "lowshelf";
    low.frequency.value = 200;
    const mid = c.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1000;
    mid.Q.value = 0.8;
    const high = c.createBiquadFilter();
    high.type = "highshelf";
    high.frequency.value = 5000;
    const comp = c.createDynamicsCompressor();
    comp.knee.value = 6;
    comp.attack.value = 0.005;
    comp.release.value = 0.12;
    const fader = c.createGain();
    const duck = c.createGain();
    const pan = c.createStereoPanner();
    const rev = c.createGain();
    const dly = c.createGain();
    low.connect(mid).connect(high);
    comp.connect(fader).connect(duck);
    pan.connect(this.master);
    pan.connect(rev).connect(this.reverbIn);
    pan.connect(dly).connect(this.delayIn);
    const s: Strip = { input, low, mid, high, comp, fader, duck, pan, rev, dly, drive: null, filter: null, mod: null, modType: "off", width: null };
    this.wire(s);
    return s;
  }

  /** (Re)connect the chain through whichever optional blocks exist. */
  private wire(s: Strip) {
    s.input.disconnect();
    s.high.disconnect();
    s.duck.disconnect();
    s.drive?.post.disconnect();
    s.filter?.filter.disconnect();
    s.mod?.output.disconnect();
    s.width?.output.disconnect();

    let at: AudioNode = s.input;
    if (s.drive) {
      at.connect(s.drive.shaper);
      at = s.drive.post;
    }
    at.connect(s.low);
    at = s.high;
    if (s.filter) {
      at.connect(s.filter.filter);
      at = s.filter.filter;
    }
    if (s.mod) {
      at.connect(s.mod.input);
      at = s.mod.output;
    }
    at.connect(s.comp);
    at = s.duck;
    if (s.width) {
      at.connect(s.width.input);
      at = s.width.output;
    }
    at.connect(s.pan);
  }

  /** Create or remove the optional blocks this channel needs. True if the chain changed. */
  private shapeStrip(s: Strip, fx: ChannelFx): boolean {
    const c = this.ctx;
    let changed = false;

    const wantDrive = fx.drive !== "off";
    if (wantDrive && !s.drive) {
      const shaper = c.createWaveShaper();
      const post = c.createGain();
      shaper.connect(post);
      s.drive = { shaper, post, key: "" };
      changed = true;
    } else if (!wantDrive && s.drive) {
      s.drive.shaper.disconnect();
      s.drive.post.disconnect();
      s.drive = null;
      changed = true;
    }

    const wantFilter = fx.filter !== "off";
    if (wantFilter && !s.filter) {
      const filter = c.createBiquadFilter();
      const osc = c.createOscillator();
      const depth = c.createGain();
      depth.gain.value = 0;
      osc.connect(depth).connect(filter.detune);
      osc.start(0); // offline renders start at phase 0: exports are repeatable
      s.filter = { filter, osc, depth };
      changed = true;
    } else if (!wantFilter && s.filter) {
      s.filter.osc.stop();
      for (const n of [s.filter.filter, s.filter.osc, s.filter.depth]) n.disconnect();
      s.filter = null;
      changed = true;
    }

    if (fx.mod !== s.modType) {
      s.mod?.dispose();
      s.mod = fx.mod === "off" ? null : createModFx(c, fx.mod, fx.modAmount);
      s.modType = fx.mod;
      changed = true;
    }

    const wantWidth = fx.width !== 1;
    if (wantWidth && !s.width) {
      // Force stereo first: a mono sound is copied to both sides (else "R" would be silent).
      const input = c.createGain();
      input.channelCount = 2;
      input.channelCountMode = "explicit";
      input.channelInterpretation = "speakers";
      const split = c.createChannelSplitter(2);
      const merge = c.createChannelMerger(2);
      const gains = [c.createGain(), c.createGain(), c.createGain(), c.createGain()] as WidthBlock["gains"];
      input.connect(split);
      split.connect(gains[0], 0).connect(merge, 0, 0);
      split.connect(gains[1], 1).connect(merge, 0, 0);
      split.connect(gains[2], 0).connect(merge, 0, 1);
      split.connect(gains[3], 1).connect(merge, 0, 1);
      s.width = { input, gains, output: merge, nodes: [input, split, merge, ...gains] };
      changed = true;
    } else if (!wantWidth && s.width) {
      for (const n of s.width.nodes) n.disconnect();
      s.width = null;
      changed = true;
    }
    return changed;
  }

  private applyStrip(s: Strip, mix: ChannelMix, audible: boolean, smooth: boolean, bpm: number) {
    const fx = mix.fx;
    if (this.shapeStrip(s, fx)) this.wire(s);
    this.set(s.low.gain, fx.low, smooth);
    this.set(s.mid.gain, fx.mid, smooth);
    this.set(s.high.gain, fx.high, smooth);
    // Compression: more amount = lower threshold and higher ratio. 0 = transparent.
    this.set(s.comp.threshold, fx.comp > 0 ? -fx.comp * 40 : 0, smooth);
    this.set(s.comp.ratio, 1 + fx.comp * 11, smooth);
    this.set(s.fader.gain, audible ? mix.volume : 0, smooth);
    this.set(s.pan.pan, mix.pan, smooth);
    this.set(s.rev.gain, fx.reverb, smooth);
    this.set(s.dly.gain, fx.delay, smooth);

    if (s.drive && fx.drive !== "off") {
      const key = `${fx.drive}:${fx.driveAmount.toFixed(3)}`;
      if (s.drive.key !== key) {
        s.drive.shaper.curve = driveCurve(fx.drive, fx.driveAmount);
        s.drive.shaper.oversample = fx.drive === "crush" ? "none" : "4x";
        s.drive.key = key;
      }
      this.set(s.drive.post.gain, driveMakeup(fx.drive, fx.driveAmount), smooth);
    }
    if (s.filter && fx.filter !== "off") {
      s.filter.filter.type = fx.filter === "low" ? "lowpass" : "highpass";
      this.set(s.filter.filter.frequency, cutoffHz(fx.cutoff), smooth);
      this.set(s.filter.filter.Q, resonanceQ(fx.resonance), smooth);
      this.set(s.filter.depth.gain, moveCents(fx.move), smooth);
      this.set(s.filter.osc.frequency, 1 / (fx.moveRate * stepSeconds(bpm)), smooth);
    }
    s.mod?.set(fx.modAmount, smooth);
    if (s.width) widthGains(fx.width).forEach((g, i) => this.set(s.width!.gains[i].gain, g, smooth));
  }

  /** Bring the graph in line with the song. `limiter` overrides the song setting (stems). */
  sync(song: Song, audible: Set<string>, smooth: boolean, limiter = song.fx.limiter) {
    const specs = mixStrips(song);
    const keep = new Set<string>();
    this.duckers.clear();
    for (const spec of specs) {
      keep.add(spec.key);
      let s = this.strips.get(spec.key);
      if (!s) {
        s = this.createStrip();
        this.strips.set(spec.key, s);
      }
      this.applyStrip(s, spec.mix, audible.has(spec.channelId), smooth, song.bpm);
      const fx = spec.mix.fx;
      if (fx.duckBy !== null && fx.duckAmount > 0) {
        const list = this.duckers.get(fx.duckBy) ?? [];
        list.push({ strip: s, amount: fx.duckAmount });
        this.duckers.set(fx.duckBy, list);
      }
    }
    // Strips of removed channels, or of patterns that stopped using a channel.
    for (const [key, s] of this.strips) {
      if (!keep.has(key)) {
        disconnectStrip(s);
        this.strips.delete(key);
      }
    }

    this.set(this.master.gain, song.masterVolume, smooth);
    const delayTime = Math.min(4, song.fx.delaySteps * stepSeconds(song.bpm));
    for (const d of [this.delay, this.ppL, this.ppR]) this.set(d.delayTime, delayTime, smooth);
    this.set(this.feedback.gain, song.fx.delayFeedback, smooth);
    this.set(this.ppFeedback.gain, song.fx.delayFeedback, smooth);
    this.set(this.delayOut.gain, song.fx.delayPingPong ? 0 : 0.7, smooth);
    this.set(this.ppOut.gain, song.fx.delayPingPong ? 0.7 : 0, smooth);
    if (song.fx.reverbSize !== this.reverbSize) {
      this.reverbSize = song.fx.reverbSize;
      this.conv.buffer = impulseFor(this.ctx.sampleRate, this.reverbSize);
    }
    const l = this.limiter;
    // A brick-wall-ish limiter just under 0 dBFS; "off" = threshold 0, ratio 1 (does nothing).
    this.set(l.threshold, limiter ? -1 : 0, smooth);
    this.set(l.ratio, limiter ? 20 : 1, smooth);
    l.knee.value = 0;
    l.attack.value = 0.001;
    l.release.value = 0.1;
  }

  /**
   * A hit of `channelId` at `time`: channels that "pump" with it dip and come back.
   * Scheduled automation, so it's sample-exact and identical in the export.
   */
  duck(channelId: string, time: number) {
    for (const { strip, amount } of this.duckers.get(channelId) ?? []) {
      const g = strip.duck.gain;
      g.setTargetAtTime(duckFloor(amount), time, 0.004);
      g.setTargetAtTime(1, time + 0.035, 0.07);
    }
  }

  /** Where a channel's sound goes: its strip in that pattern, else its own (audio clips). */
  input(channelId: string, patternId?: string): AudioNode | undefined {
    return (patternId !== undefined ? this.strips.get(stripKey(channelId, patternId)) : undefined)?.input ?? this.strips.get(channelId)?.input;
  }
}
