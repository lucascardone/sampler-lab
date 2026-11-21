import { describe, expect, it } from "vitest";
import { cutoffHz, disconnectStrip, duckFloor, moveCents, resonanceQ, widthGains, type Strip } from "./mixer";
import { driveCurve, driveMakeup } from "./shaper";

describe("mixer strips", () => {
  it("removing a channel unplugs every node of its strip, optional blocks included", () => {
    const unplugged: string[] = [];
    let stopped = 0;
    let disposed = 0;
    const node = (name: string) => ({ disconnect: () => unplugged.push(name), stop: () => stopped++ }) as unknown as AudioNode;
    const base = ["input", "low", "mid", "high", "comp", "fader", "duck", "pan", "rev", "dly"] as const;
    const strip = {
      ...Object.fromEntries(base.map((n) => [n, node(n)])),
      drive: { shaper: node("shaper"), post: node("post"), key: "" },
      filter: { filter: node("filter"), osc: node("osc"), depth: node("depth") },
      mod: { dispose: () => disposed++ },
      modType: "chorus",
      width: { nodes: [node("w1"), node("w2")] },
    } as unknown as Strip;
    disconnectStrip(strip);
    expect(unplugged.sort()).toEqual([...base, "shaper", "post", "filter", "osc", "depth", "w1", "w2"].sort());
    expect(stopped).toBe(1); // the movement LFO
    expect(disposed).toBe(1); // the chorus
  });
});

describe("effect curves", () => {
  for (const type of ["soft", "hard", "crush"] as const) {
    it(`${type}: bounded, odd-symmetric and growing`, () => {
      for (const amount of [0, 0.5, 1]) {
        const c = driveCurve(type, amount);
        const n = c.length;
        expect(c[(n - 1) / 2]).toBeCloseTo(0, 6);
        for (let i = 0; i < n; i++) {
          expect(Math.abs(c[i])).toBeLessThanOrEqual(1 + 1e-6);
          expect(c[i]).toBeCloseTo(-c[n - 1 - i], 5);
          if (i > 0) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1] - 1e-6);
        }
      }
    });
  }

  it("at amount 0 saturation is (almost) a straight line; at 1 it squashes", () => {
    const at = (c: Float32Array, x: number) => c[Math.round(((x + 1) / 2) * (c.length - 1))];
    const zero = driveCurve("soft", 0);
    for (const x of [-0.8, -0.3, 0.2, 0.6]) expect(at(zero, x)).toBeCloseTo(x, 2);
    const full = driveCurve("soft", 1);
    expect(at(full, 0.2)).toBeGreaterThan(0.9); // quiet parts pushed way up
    expect(driveMakeup("soft", 1)).toBeLessThan(driveMakeup("soft", 0)); // and turned down after
  });

  it("crush has few distinct levels at full amount", () => {
    const levels = new Set(Array.from(driveCurve("crush", 1), (v) => v.toFixed(4)));
    expect(levels.size).toBeLessThanOrEqual(9); // 3 bits: -4..4 steps
  });

  it("filter, movement, width and ducking map to sensible values", () => {
    expect(cutoffHz(0)).toBeCloseTo(40);
    expect(cutoffHz(1)).toBeCloseTo(18000);
    expect(cutoffHz(0.5)).toBeGreaterThan(700); // geometric middle ≈ 850 Hz
    expect(cutoffHz(0.5)).toBeLessThan(1000);
    expect(resonanceQ(0)).toBeCloseTo(0.7);
    expect(moveCents(1)).toBe(2400);
    expect(widthGains(1)).toEqual([1, 0, 0, 1]); // untouched
    expect(widthGains(0)).toEqual([0.5, 0.5, 0.5, 0.5]); // mono
    const [ll, rl] = widthGains(2);
    expect(ll - rl).toBe(2); // side doubled
    expect(duckFloor(0)).toBe(1);
    expect(duckFloor(1)).toBeCloseTo(0.1);
  });
});
