// "Tocar juntos": one clock for the room. Every PC plays its own copy of the song;
// they agree on *when* step N sounds.
//
// - The host's clock is the reference. Guests estimate the difference with pings
//   (NTP style: of the last few, trust the one with the shortest round trip).
// - The shared transport says "step `step` sounds at host time `at`, at `bpm`". Each PC
//   turns that into its own AudioContext time, using the context's output timestamp so
//   its speaker latency is taken into account, plus a manual delay for Bluetooth.
//
// Pure (no Web Audio objects needed): tested in clock.test.ts.

import { stepSeconds, type PlayMode } from "../studio/song";

/** Milliseconds on this PC's wall clock, high resolution. */
export const wallNow = () => performance.timeOrigin + performance.now();

/** What the whole room is playing. */
export interface Transport {
  playing: boolean;
  mode: PlayMode;
  /** Pattern that sounds in pattern mode (each person may be looking at another one). */
  patternId: string;
  bpm: number;
  /** Song position (in steps, can be fractional) at host time `at`. */
  step: number;
  /** Host wall-clock milliseconds. */
  at: number;
}

export const STOPPED: Transport = { playing: false, mode: "pattern", patternId: "", bpm: 120, step: 0, at: 0 };

/** Position (steps) at host time `hostMs`. */
export function stepAt(t: Transport, hostMs: number): number {
  if (!t.playing) return t.step;
  return t.step + (hostMs - t.at) / (stepSeconds(t.bpm) * 1000);
}

/** Same position, new tempo from `hostMs` on (a tempo change while playing). */
export function retempo(t: Transport, bpm: number, hostMs: number): Transport {
  return { ...t, step: stepAt(t, hostMs), at: hostMs, bpm };
}

/** Start playing at `fromStep`, `leadMs` from now so every PC gets the message first. */
export function startAt(t: Transport, fromStep: number, hostMs: number, leadMs = 300): Transport {
  return { ...t, playing: true, step: fromStep, at: hostMs + leadMs };
}

export function stopAt(t: Transport, hostMs: number): Transport {
  return { ...t, playing: false, step: 0, at: hostMs };
}

export function isTransport(x: unknown): x is Transport {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  return (
    typeof t.playing === "boolean" &&
    (t.mode === "pattern" || t.mode === "song") &&
    typeof t.patternId === "string" &&
    [t.bpm, t.step, t.at].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    (t.bpm as number) > 0
  );
}

/** Clock offset estimate: host time = local time + offset. */
export class ClockSync {
  private samples: { rtt: number; offset: number }[] = [];
  constructor(private keep = 8) {}

  /** A ping sent at local `t0`, answered with host time `host`, back at local `t1`. */
  add(t0: number, host: number, t1: number) {
    const rtt = t1 - t0;
    if (!(rtt >= 0) || rtt > 2000) return;
    this.samples.push({ rtt, offset: host - (t0 + t1) / 2 });
    if (this.samples.length > this.keep) this.samples.shift();
  }

  get ready() {
    return this.samples.length >= 3;
  }

  /** Offset of the fastest round trip (the least delayed by the network). */
  get offset(): number {
    if (!this.samples.length) return 0;
    return this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
  }

  /** Round trip of that sample (ms): how precise the estimate is. */
  get rtt(): number {
    if (!this.samples.length) return Infinity;
    return Math.min(...this.samples.map((s) => s.rtt));
  }
}

/** `AudioContext.getOutputTimestamp()`: a context time and the moment it is heard. */
export interface OutputStamp {
  contextTime: number;
  /** In `performance.now()` milliseconds. */
  performanceTime: number;
}

/**
 * The AudioContext time at which something must be scheduled so it is *heard* at host
 * time `hostMs`. `delayMs` = how late this PC's speakers sound (Bluetooth): we schedule
 * that much earlier.
 */
export function hostToContext(hostMs: number, offset: number, stamp: OutputStamp, timeOrigin: number, delayMs = 0): number {
  const localPerf = hostMs - offset - timeOrigin;
  return stamp.contextTime + (localPerf - stamp.performanceTime) / 1000 - delayMs / 1000;
}

/** The inverse: host time at which context time `ctxTime` is heard. */
export function contextToHost(ctxTime: number, offset: number, stamp: OutputStamp, timeOrigin: number, delayMs = 0): number {
  return (ctxTime - stamp.contextTime + delayMs / 1000) * 1000 + stamp.performanceTime + timeOrigin + offset;
}
