import { describe, expect, it } from "vitest";
import { synthClick, synthDrum } from "./drums";
import { BUILTIN_DRUMS } from "./song";

const SR = 48000;
const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
/** Zero crossings per second: a rough "brightness" measure. */
const zcr = (x: Float32Array) => {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 !== x[i] < 0) n++;
  return (n * SR) / x.length;
};

describe("built-in drums", () => {
  it.each(BUILTIN_DRUMS)("%s is audible, never clips and ends in silence", (id) => {
    const x = synthDrum(id, SR);
    expect(x.length).toBeGreaterThan(SR * 0.05);
    expect(peak(x)).toBeGreaterThan(0.5);
    expect(peak(x)).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(Math.abs(x[x.length - 1])).toBeLessThan(1e-3);
    expect(x.every(Number.isFinite)).toBe(true);
  });

  it("is deterministic (playback == export)", () => {
    for (const id of BUILTIN_DRUMS) expect(synthDrum(id, SR)).toEqual(synthDrum(id, SR));
  });

  it("sounds like what it is: kick is low, hats are bright, open hat is longer", () => {
    expect(zcr(synthDrum("kick", SR))).toBeLessThan(300);
    expect(zcr(synthDrum("hat", SR))).toBeGreaterThan(5000);
    expect(synthDrum("openHat", SR).length).toBeGreaterThan(synthDrum("hat", SR).length * 3);
  });

  it("works at 44.1 kHz too", () => {
    expect(synthDrum("kick", 44100).length).toBe(22050);
  });

  it("metronome accent is higher", () => {
    expect(zcr(synthClick(SR, true))).toBeGreaterThan(zcr(synthClick(SR, false)));
  });
});
