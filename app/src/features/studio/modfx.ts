// Modulation effects for a channel ("Chorus", "Flanger", "Phaser"), built from native
// Web Audio nodes so they sound the same live and in an OfflineAudioContext export.
// Each block: input → (dry + modulated wet) → output.
import type { ModType } from "./song";

export interface ModFx {
  input: GainNode;
  output: GainNode;
  /** Amount 0..1 (wet level). */
  set(amount: number, smooth: boolean): void;
  dispose(): void;
}

export function createModFx(ctx: BaseAudioContext, type: Exclude<ModType, "off">, amount: number): ModFx {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry).connect(output);
  wet.connect(output);
  const oscs: OscillatorNode[] = [];
  const nodes: AudioNode[] = [input, output, dry, wet];
  const lfo = (hz: number, depth: number, target: AudioParam) => {
    const o = ctx.createOscillator();
    o.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.value = depth;
    o.connect(g).connect(target);
    o.start(0);
    oscs.push(o);
    nodes.push(o, g);
  };

  let dryLevel = (_a: number) => 1;
  let wetLevel = (a: number) => a;

  if (type === "chorus") {
    // Two short, slowly wobbling delays, one per side: thicker and wider.
    for (const side of [-1, 1]) {
      const d = ctx.createDelay(0.1);
      d.delayTime.value = 0.02;
      const p = ctx.createStereoPanner();
      p.pan.value = side * 0.8;
      input.connect(d).connect(p).connect(wet);
      lfo(0.6 + (side > 0 ? 0.13 : 0), 0.005 * side, d.delayTime);
      nodes.push(d, p);
    }
    wetLevel = (a) => a * 0.6;
  } else if (type === "flanger") {
    // A very short delay sweeping with feedback: the "jet plane" whoosh.
    const d = ctx.createDelay(0.05);
    d.delayTime.value = 0.003;
    const fb = ctx.createGain();
    fb.gain.value = 0.6;
    input.connect(d).connect(wet);
    d.connect(fb).connect(d);
    lfo(0.2, 0.0022, d.delayTime);
    nodes.push(d, fb);
    wetLevel = (a) => a * 0.7;
  } else {
    // Phaser: four all-pass filters swept together, mixed with the dry sound.
    let prev: AudioNode = input;
    for (let i = 0; i < 4; i++) {
      const ap = ctx.createBiquadFilter();
      ap.type = "allpass";
      ap.frequency.value = 900;
      ap.Q.value = 0.7;
      prev.connect(ap);
      prev = ap;
      lfo(0.35, 650, ap.frequency);
      nodes.push(ap);
    }
    prev.connect(wet);
    dryLevel = (a) => 1 - a * 0.4;
    wetLevel = (a) => a * 0.6;
  }

  const set = (a: number, smooth: boolean) => {
    const now = ctx.currentTime;
    for (const [param, v] of [
      [dry.gain, dryLevel(a)],
      [wet.gain, wetLevel(a)],
    ] as const) {
      if (smooth) param.setTargetAtTime(v, now, 0.02);
      else param.value = v;
    }
  };
  set(amount, false);

  return {
    input,
    output,
    set,
    dispose() {
      for (const o of oscs) o.stop();
      for (const n of nodes) n.disconnect();
    },
  };
}
