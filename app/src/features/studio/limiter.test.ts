import { describe, expect, it } from "vitest";
import { limit } from "./limiter";

const SR = 48000;
const peak = (chs: Float32Array[]) => Math.max(...chs.map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));

describe("limiter", () => {
  it("never lets a sample over the ceiling, even a single-sample spike", () => {
    const l = new Float32Array(SR).map((_, i) => 0.5 * Math.sin(i / 10));
    const r = l.slice();
    l[20000] = 1.8;
    r[30000] = -2.5;
    const min = limit([l, r], SR, { ceiling: 0.98 });
    expect(peak([l, r])).toBeLessThanOrEqual(0.98 + 1e-6);
    expect(min).toBeCloseTo(0.98 / 2.5, 3);
  });

  it("leaves quiet audio bit-identical", () => {
    const x = new Float32Array(1000).map((_, i) => 0.9 * Math.sin(i));
    const copy = x.slice();
    expect(limit([x], SR)).toBe(1);
    expect(x).toEqual(copy);
  });

  it("is smooth: gain ramps down before the peak and recovers after", () => {
    const x = new Float32Array(SR).fill(0.5);
    x[24000] = 2; // needs gain 0.49 there
    limit([x], SR, { ceiling: 0.98, lookaheadMs: 5, releaseMs: 80 });
    // Well before the look-ahead window: untouched.
    expect(x[24000 - 400]).toBeCloseTo(0.5, 6);
    // Inside the window: already ducking.
    expect(x[24000 - 100]).toBeLessThan(0.5);
    // Recovered fully after the release time.
    expect(x[24000 + 0.09 * SR]).toBeCloseTo(0.5, 6);
    // No step bigger than the ramp allows (no clicks).
    for (let i = 23700; i < 24000 + 5000; i++) {
      if (i === 24000 || i === 24001) continue;
      expect(Math.abs(x[i] - x[i - 1])).toBeLessThan(0.01);
    }
  });

  it("keeps the stereo image (same gain on both channels)", () => {
    const l = new Float32Array(100).fill(1.5);
    const r = new Float32Array(100).fill(0.75);
    limit([l, r], SR);
    for (let i = 0; i < 100; i++) expect(l[i] / r[i]).toBeCloseTo(2, 5);
  });
});
