import { afterEach, describe, expect, it } from "vitest";
import {
  addChannel,
  addPattern,
  moveChannel,
  newSong,
  normalizeSong,
  removeChannel,
  setIdSuffix,
  setNotes,
  setStep,
  updateChannel,
  type DrumNames,
  type Song,
} from "../studio/song";
import { applyOps, applyOpsRaw, diffSong, isOps, touched } from "./ops";

const names: DrumNames = { kick: "Bombo", snare: "Caja", clap: "Palmas", hat: "Hi-hat", openHat: "Hi-hat abierto", rim: "Aro" };
const base = () => newSong(names);
const pat = (s: Song) => s.currentPatternId;
const ch = (s: Song, i: number) => s.channels[i].id;
/** Same music (view and id counter aside). */
const same = (a: Song, b: Song) => expect({ ...a, nextId: 0, currentPatternId: "" }).toEqual({ ...b, nextId: 0, currentPatternId: "" });

afterEach(() => setIdSuffix(""));

describe("diffSong / applyOps", () => {
  it("no change, no ops", () => {
    const s = base();
    expect(diffSong(s, s)).toEqual([]);
    expect(diffSong(s, { ...s, currentPatternId: "x", nextId: 99 })).toEqual([]);
  });

  it("a step is one small op, and applying it gives the same song", () => {
    // A row that already has a step (a brand-new row travels whole).
    const s = setStep(base(), pat(base()), ch(base(), 0), 0, 1);
    const n = setStep(s, pat(s), ch(s, 0), 4, 1);
    const ops = diffSong(s, n);
    expect(ops).toEqual([{ p: ["patterns", `#${pat(s)}`, "rows", ch(s, 0), 4], v: 1 }]);
    same(applyOps(s, ops), n);
  });

  it("round-trips many kinds of edits", () => {
    const s = setStep(base(), pat(base()), ch(base(), 1), 0, 1);
    let n = addChannel(s, { kind: "synth", preset: "bass" }, "Bajo");
    n = setNotes(n, pat(n), n.channels[6].id, [{ start: 0, length: 4, pitch: 40, velocity: 0.8 }]);
    n = updateChannel(n, ch(n, 2), { volume: 0.3, fx: { ...n.channels[2].fx, reverb: 0.5 } });
    n = removeChannel(n, ch(n, 3));
    n = moveChannel(n, ch(n, 0), 2);
    n = addPattern(n, "Patrón 2");
    n = { ...n, bpm: 98, swing: 0.2 };
    const ops = diffSong(s, n);
    same(applyOps(s, ops), n);
  });

  it("two people on two channels at the same time: nothing is lost", () => {
    const s = base();
    const a = setStep(s, pat(s), ch(s, 0), 0, 1);
    const b = updateChannel(s, ch(s, 1), { mute: true });
    // The host applies both, in whatever order they arrive.
    const host = applyOps(applyOps(s, diffSong(s, a)), diffSong(s, b));
    expect(host.patterns[0].rows[ch(s, 0)][0]).toBe(1);
    expect(host.channels[1].mute).toBe(true);
  });

  it("same value changed by two people: the last one wins", () => {
    const s = base();
    const a = updateChannel(s, ch(s, 0), { volume: 0.2 });
    const b = updateChannel(s, ch(s, 0), { volume: 1 });
    expect(applyOps(applyOps(s, diffSong(s, a)), diffSong(s, b)).channels[0].volume).toBe(1);
  });

  it("an edit to a channel someone else just deleted is dropped, the song stays valid", () => {
    const s = base();
    const gone = removeChannel(s, ch(s, 0));
    const edit = setStep(s, pat(s), ch(s, 0), 2, 1);
    const host = applyOps(applyOps(s, diffSong(s, gone)), diffSong(s, edit));
    expect(host.channels.some((c) => c.id === ch(s, 0))).toBe(false);
    expect(host.patterns[0].rows[ch(s, 0)]).toBeUndefined();
    expect(normalizeSong(host)).not.toBeNull();
  });

  it("two people adding channels at the same time keep both (ids with a letter)", () => {
    const s = base();
    const a = addChannel(s, { kind: "synth", preset: "pad" }, "Colchón");
    setIdSuffix("b");
    const b = addChannel(s, { kind: "synth", preset: "lead" }, "Lead");
    setIdSuffix("");
    expect(a.channels[6].id).not.toBe(b.channels[6].id);
    expect(b.channels[6].id).toMatch(/^ch\d+b$/);
    const host = applyOps(applyOps(s, diffSong(s, a)), diffSong(s, b));
    expect(host.channels.map((c) => c.name).slice(-2)).toEqual(["Colchón", "Lead"]);
    // The number in an id still counts for the next free id.
    expect(host.nextId).toBeGreaterThan(Number(b.channels[6].id.replace(/\D/g, "")));
  });

  it("reordering is its own op and survives someone else's add", () => {
    const s = base();
    const moved = moveChannel(s, ch(s, 0), 1);
    const ops = diffSong(s, moved);
    expect(ops.some((o) => "order" in o)).toBe(true);
    const added = addChannel(s, { kind: "synth", preset: "sub" }, "Sub");
    const host = applyOps(applyOps(s, diffSong(s, added)), ops);
    expect(host.channels.slice(0, 2).map((c) => c.id)).toEqual([ch(s, 1), ch(s, 0)]);
    expect(host.channels[host.channels.length - 1].name).toBe("Sub");
  });

  it("never touches what the other person is looking at", () => {
    const s = addPattern(base(), "Patrón 2");
    const mine = { ...s, currentPatternId: s.patterns[0].id };
    const theirs = applyOpsRaw(mine, [{ p: ["currentPatternId"], v: s.patterns[1].id }]);
    expect(theirs.currentPatternId).toBe(s.patterns[0].id);
  });

  it("undo = the inverse ops, applied later, only reverts your own change", () => {
    const s = base();
    const mine = updateChannel(s, ch(s, 0), { volume: 0.1 });
    const inverse = diffSong(mine, s);
    // A friend changes another channel meanwhile.
    const friend = applyOps(mine, diffSong(mine, updateChannel(mine, ch(mine, 1), { pan: -1 })));
    const undone = applyOps(friend, inverse);
    expect(undone.channels[0].volume).toBe(s.channels[0].volume);
    expect(undone.channels[1].pan).toBe(-1);
  });

  it("tells which channels and patterns an edit touched", () => {
    const s = base();
    const n = updateChannel(setStep(s, pat(s), ch(s, 2), 0, 1), ch(s, 4), { mute: true });
    const t = touched(diffSong(s, n));
    expect(t.channels.sort()).toEqual([ch(s, 2), ch(s, 4)].sort());
    expect(t.patterns).toEqual([pat(s)]);
  });

  it("checks ops coming from the network", () => {
    expect(isOps([{ p: ["bpm"], v: 100 }, { p: ["channels", "#ch1"], d: 1 }])).toBe(true);
    expect(isOps([{ p: "bpm", v: 1 }])).toBe(false);
    expect(isOps([{ p: [{}], v: 1 }])).toBe(false);
    expect(isOps("x")).toBe(false);
  });

  it("garbage values are clamped back into a valid song", () => {
    const s = base();
    const out = applyOps(s, [{ p: ["bpm"], v: 99999 }, { p: ["channels", `#${ch(s, 0)}`, "volume"], v: "x" }]);
    expect(out.bpm).toBeLessThanOrEqual(400);
    expect(typeof out.channels[0].volume).toBe("number");
  });
});
