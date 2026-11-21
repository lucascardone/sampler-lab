import { describe, expect, it } from "vitest";
import { stepSeconds } from "../studio/song";
import { ClockSync, contextToHost, hostToContext, isTransport, retempo, startAt, stepAt, stopAt, STOPPED } from "./clock";

describe("room clock", () => {
  it("keeps the offset of the fastest round trip", () => {
    const c = new ClockSync();
    // Host is 1000 ms ahead; slow pings are skewed, fast ones are right.
    c.add(0, 1000 + 40, 100); // rtt 100, offset 990
    c.add(200, 1200 + 2, 204); // rtt 4, offset 1000
    c.add(300, 1300 + 30, 360); // rtt 60, offset 1000
    expect(c.ready).toBe(true);
    expect(c.offset).toBe(1000);
    expect(c.rtt).toBe(4);
    c.add(500, 0, 400); // negative rtt: ignored
    expect(c.rtt).toBe(4);
  });

  it("position follows the tempo and survives a tempo change", () => {
    const step = stepSeconds(120) * 1000; // 125 ms at 120 BPM
    const t = startAt(STOPPED, 0, 10_000, 300);
    expect(t.at).toBe(10_300);
    expect(stepAt(t, 10_300 + 4 * step)).toBeCloseTo(4);
    const faster = retempo(t, 240, 10_300 + 8 * step);
    expect(stepAt(faster, 10_300 + 8 * step)).toBeCloseTo(8);
    expect(stepAt(faster, 10_300 + 8 * step + step)).toBeCloseTo(10); // twice as fast now
    expect(stopAt(faster, 20_000).playing).toBe(false);
    expect(stepAt(stopAt(faster, 20_000), 99_999)).toBe(0);
  });

  it("maps host time to the audio clock and back", () => {
    const stamp = { contextTime: 5, performanceTime: 2000 };
    const origin = 1_700_000_000_000;
    // Local wall = origin + 2000 when the context is at 5 s. Host is 250 ms ahead.
    const host = origin + 2000 + 250 + 1000; // one second later, in host time
    expect(hostToContext(host, 250, stamp, origin)).toBeCloseTo(6);
    expect(hostToContext(host, 250, stamp, origin, 100)).toBeCloseTo(5.9);
    expect(contextToHost(6, 250, stamp, origin)).toBeCloseTo(host);
    expect(contextToHost(hostToContext(host, 250, stamp, origin, 80), 250, stamp, origin, 80)).toBeCloseTo(host);
  });

  it("checks transports coming from the network", () => {
    expect(isTransport(STOPPED)).toBe(true);
    expect(isTransport({ ...STOPPED, bpm: 0 })).toBe(false);
    expect(isTransport({ ...STOPPED, mode: "x" })).toBe(false);
    expect(isTransport(null)).toBe(false);
  });
});
