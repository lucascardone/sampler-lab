import { describe, expect, it } from "vitest";
import {
  addChannel,
  addPattern,
  addClip,
  addTrack,
  allHits,
  audibleTracks,
  setTracksMix,
  audibleChannels,
  duplicatePattern,
  eventsAt,
  newSong,
  normalizeSong,
  removeChannel,
  removePattern,
  setPatternLength,
  setStep,
  stepSeconds,
  stepVelocity,
  songLength,
  playLength,
  removeClip,
  removeTrack,
  swingOffset,
  updateClip,
  updateChannel,
  fxActive,
  moreFxActive,
  NO_FX,
  SONG_VERSION,
  DEFAULT_MIX,
  channelIn,
  copyMixEverywhere,
  mixOf,
  mixStrips,
  setMix,
  stripKey,
  type DrumNames,
  type Song,
} from "./song";

const names: DrumNames = { kick: "Bombo", snare: "Caja", clap: "Palmas", hat: "Hi-hat", openHat: "Hi-hat abierto", rim: "Aro" };
const fresh = () => newSong(names);
const pat = (s: Song) => s.patterns.find((p) => p.id === s.currentPatternId)!;
/** Put pattern `id` on track `t` at bar `bar` for `bars` bars. */
const place = (s: Song, id: string, bar: number, bars = 1, t = 0) =>
  addClip(s, { kind: "pattern", patternId: id, trackId: s.tracks[t].id, start: bar * 16, length: bars * 16 });

describe("new song", () => {
  it("has the built-in kit, one empty 1-bar pattern, placed on the first of 4 tracks", () => {
    const s = fresh();
    expect(s.channels.map((c) => c.name)).toEqual(Object.values(names));
    expect(s.patterns).toHaveLength(1);
    expect(pat(s).steps).toBe(16);
    expect(s.tracks).toHaveLength(4);
    expect(s.clips).toEqual([
      expect.objectContaining({ kind: "pattern", patternId: s.currentPatternId, trackId: s.tracks[0].id, start: 0, length: 16 }),
    ]);
    expect(s.channels[0].fx).toEqual(NO_FX);
    expect(fxActive(s.channels[0].fx)).toBe(false);
    expect(allHits(s, "pattern")).toEqual([]);
  });

  it("generates unique ids", () => {
    let s = fresh();
    s = addChannel(s, { kind: "builtin", id: "kick" }, "otro");
    s = addPattern(s, "B");
    const ids = [...s.channels, ...s.patterns].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("steps", () => {
  it("toggles and clamps velocity, ignores out-of-range steps", () => {
    let s = fresh();
    const kick = s.channels[0].id;
    s = setStep(s, s.currentPatternId, kick, 0, 1);
    s = setStep(s, s.currentPatternId, kick, 4, 7);
    s = setStep(s, s.currentPatternId, kick, 99, 1);
    expect(stepVelocity(pat(s), kick, 0)).toBe(1);
    expect(stepVelocity(pat(s), kick, 4)).toBe(1);
    expect(pat(s).rows[kick]).toHaveLength(16);
    s = setStep(s, s.currentPatternId, kick, 0, 0);
    expect(stepVelocity(pat(s), kick, 0)).toBe(0);
  });

  it("is immutable (undo relies on it)", () => {
    const a = fresh();
    const b = setStep(a, a.currentPatternId, a.channels[0].id, 0, 1);
    expect(stepVelocity(pat(a), a.channels[0].id, 0)).toBe(0);
    expect(stepVelocity(pat(b), a.channels[0].id, 0)).toBe(1);
  });

  it("growing a pattern repeats it, shrinking cuts", () => {
    let s = fresh();
    const kick = s.channels[0].id;
    s = setStep(s, s.currentPatternId, kick, 2, 0.5);
    s = setPatternLength(s, s.currentPatternId, 32);
    expect(pat(s).steps).toBe(32);
    expect(stepVelocity(pat(s), kick, 2)).toBe(0.5);
    expect(stepVelocity(pat(s), kick, 18)).toBe(0.5);
    s = setPatternLength(s, s.currentPatternId, 16);
    expect(pat(s).rows[kick]).toHaveLength(16);
  });

  it("removing a channel removes its rows", () => {
    let s = fresh();
    const kick = s.channels[0].id;
    s = setStep(s, s.currentPatternId, kick, 0, 1);
    s = removeChannel(s, kick);
    expect(pat(s).rows[kick]).toBeUndefined();
    expect(s.channels.find((c) => c.id === kick)).toBeUndefined();
  });
});

describe("patterns and arrangement", () => {
  it("duplicate copies steps independently", () => {
    let s = fresh();
    const kick = s.channels[0].id;
    s = setStep(s, s.currentPatternId, kick, 0, 1);
    const first = s.currentPatternId;
    s = duplicatePattern(s, first, "Copia");
    expect(s.currentPatternId).not.toBe(first);
    s = setStep(s, s.currentPatternId, kick, 1, 1);
    expect(stepVelocity(s.patterns.find((p) => p.id === first)!, kick, 1)).toBe(0);
    expect(stepVelocity(pat(s), kick, 0)).toBe(1);
  });

  it("removing a pattern removes its clips; the last one stays", () => {
    let s = fresh();
    const a = s.currentPatternId;
    expect(removePattern(s, a)).toBe(s);
    s = addPattern(s, "B");
    const b = s.currentPatternId;
    s = place(place(s, b, 1), a, 2);
    s = removePattern(s, b);
    expect(s.clips.map((c) => c.kind === "pattern" && c.patternId)).toEqual([a, a]);
    expect(s.currentPatternId).toBe(a);
  });
});

describe("timeline", () => {
  it("song length runs to the end of the last clip, in whole bars", () => {
    let s = fresh();
    expect(songLength(s)).toBe(16);
    s = updateClip(s, s.clips[0].id, { start: 40, length: 3 });
    expect(songLength(s)).toBe(48);
    s = removeClip(s, s.clips[0].id);
    expect(songLength(s)).toBe(0);
    // Empty timeline: song mode plays the current pattern.
    expect(playLength(s, "song")).toBe(16);
  });

  it("clips on different tracks play together; a long clip repeats its pattern", () => {
    let s = fresh();
    const [kick, snare] = s.channels.map((c) => c.id);
    const a = s.currentPatternId;
    s = setStep(s, a, kick, 0, 1);
    s = addPattern(s, "B");
    const b = s.currentPatternId;
    s = setStep(s, b, snare, 4, 1);
    s = place(s, b, 0, 2, 1); // B on track 2, 2 bars (its 1-bar pattern twice)
    expect(eventsAt(s, "song", 0).hits.map((h) => h.channelId)).toEqual([kick]);
    expect(eventsAt(s, "song", 4).hits.map((h) => h.channelId)).toEqual([snare]);
    expect(eventsAt(s, "song", 20).hits.map((h) => h.channelId)).toEqual([snare]);
    expect(eventsAt(s, "song", 16).hits).toEqual([]); // A is only 1 bar
    expect(eventsAt(s, "song", 20).pos.patterns).toEqual({ [b]: 4 });
    // Pattern mode ignores the timeline.
    expect(eventsAt(s, "pattern", 4).pos.patterns).toEqual({ [b]: 4 });
  });

  it("audio clips start once, cut at the clip end, and resume mid-way", () => {
    let s = fresh();
    s = addChannel(s, { kind: "sample", sessionId: "s", sampleId: "x" }, "Loop");
    const loop = s.channels[s.channels.length - 1].id;
    s = addClip(s, { kind: "audio", channelId: loop, trackId: s.tracks[2].id, start: 16, length: 32 });
    expect(eventsAt(s, "song", 16).hits).toEqual([
      { channelId: loop, velocity: 1, offset: 0, note: 60, length: 32, audio: true, skip: 0 },
    ]);
    expect(eventsAt(s, "song", 20).hits).toEqual([]);
    expect(eventsAt(s, "song", 20, true).hits[0]).toMatchObject({ skip: 4, length: 28 });
    // Removing the channel removes its clips.
    expect(removeChannel(s, loop).clips.some((c) => c.kind === "audio")).toBe(false);
  });

  it("tracks: add and remove (with their clips)", () => {
    let s = addTrack(fresh(), "Voces");
    expect(s.tracks.map((t) => t.name)).toContain("Voces");
    s = removeTrack(s, s.tracks[0].id);
    expect(s.clips).toEqual([]);
  });
});

describe("timing", () => {
  it("16th note duration", () => {
    expect(stepSeconds(120)).toBeCloseTo(0.125);
    expect(stepSeconds(90)).toBeCloseTo(1 / 6);
  });

  it("swing delays only off-beat 16ths, up to a third of a step", () => {
    expect(swingOffset(0, 1, 120)).toBe(0);
    expect(swingOffset(1, 0, 120)).toBe(0);
    expect(swingOffset(1, 1, 120)).toBeCloseTo(0.125 / 3);
    expect(swingOffset(3, 0.5, 120)).toBeCloseTo(0.125 / 6);
  });

  it("all hits of a song pass have absolute times", () => {
    let s = fresh();
    const [kick, snare] = s.channels.map((c) => c.id);
    s = { ...s, bpm: 120, swing: 1 };
    s = setStep(s, s.currentPatternId, kick, 0, 1);
    s = setStep(s, s.currentPatternId, snare, 5, 0.7);
    s = addPattern(s, "B");
    s = setStep(s, s.currentPatternId, kick, 0, 1);
    s = place(s, s.currentPatternId, 1);
    const hits = allHits(s, "song");
    expect(hits.map((h) => [h.channelId, h.velocity])).toEqual([
      [kick, 1],
      [snare, 0.7],
      [kick, 1],
    ]);
    expect(hits[0].time).toBe(0);
    expect(hits[1].time).toBeCloseTo(5 * 0.125 + 0.125 / 3);
    expect(hits[2].time).toBeCloseTo(16 * 0.125);
  });

  it("solo beats mute", () => {
    let s = fresh();
    const [a, b, c] = s.channels.map((x) => x.id);
    s = updateChannel(s, a, { mute: true });
    expect(audibleChannels(s).has(a)).toBe(false);
    expect(audibleChannels(s).has(b)).toBe(true);
    s = updateChannel(s, c, { solo: true });
    expect([...audibleChannels(s)]).toEqual([c]);
  });
});

describe("normalizeSong", () => {
  it("round-trips a valid song", () => {
    let s = fresh();
    s = setStep(s, s.currentPatternId, s.channels[0].id, 3, 0.4);
    expect(normalizeSong(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("rejects garbage and repairs bad fields", () => {
    expect(normalizeSong(null)).toBeNull();
    expect(normalizeSong({ channels: [], patterns: [] })).toBeNull();
    const s = fresh();
    const kick = s.channels[0].id;
    const broken = {
      ...s,
      bpm: 9999,
      nextId: undefined,
      currentPatternId: "nope",
      clips: [...s.clips, { id: "clipX", kind: "pattern", patternId: "nope", trackId: s.tracks[0].id, start: 0, length: 16 }],
      channels: s.channels.map((c) => ({ ...c, volume: "x", pan: -7 })),
      patterns: [{ ...s.patterns[0], rows: { [kick]: [1, 2], ghost: [1] } }],
    };
    const n = normalizeSong(broken)!;
    expect(n.bpm).toBe(300);
    expect(n.channels[0].volume).toBe(0.8);
    expect(n.channels[0].pan).toBe(-1);
    expect(n.currentPatternId).toBe(s.patterns[0].id);
    expect(n.clips).toEqual(s.clips);
    expect(n.patterns[0].rows.ghost).toBeUndefined();
    expect(n.patterns[0].rows[kick].slice(0, 3)).toEqual([1, 1, 0]);
    expect(n.nextId).toBeGreaterThan(Math.max(...s.channels.map((c) => Number(c.id.slice(2)))));
  });
});

describe("piano roll notes", () => {
  it("steps convert to notes at the root note, and notes clear the steps", async () => {
    const { stepsToNotes, channelNotes, setNotes } = await import("./song");
    let s = fresh();
    const kick = s.channels[0].id;
    s = setStep(s, s.currentPatternId, kick, 0, 1);
    s = setStep(s, s.currentPatternId, kick, 8, 0.4);
    s = stepsToNotes(s, s.currentPatternId, kick);
    expect(channelNotes(pat(s), kick)).toEqual([
      { start: 0, length: 1, pitch: 60, velocity: 1 },
      { start: 8, length: 1, pitch: 60, velocity: 0.4 },
    ]);
    expect(pat(s).rows[kick]).toBeUndefined();
    // Notes are clipped to the pattern; empty list removes the entry.
    s = setNotes(s, s.currentPatternId, kick, [{ start: 14, length: 8, pitch: 200, velocity: 2 }]);
    expect(channelNotes(pat(s), kick)).toEqual([{ start: 14, length: 2, pitch: 127, velocity: 1 }]);
    s = setNotes(s, s.currentPatternId, kick, []);
    expect(pat(s).notes[kick]).toBeUndefined();
  });

  it("notes produce hits with pitch and length; growing repeats them", async () => {
    const { setNotes } = await import("./song");
    let s = fresh();
    s = addChannel(s, { kind: "synth", preset: "pad" }, "Pad");
    const pad = s.channels[s.channels.length - 1];
    expect(pad.gate).toBe(true);
    expect(s.channels[0].gate).toBe(false);
    s = setNotes(s, s.currentPatternId, pad.id, [
      { start: 0, length: 16, pitch: 57, velocity: 0.8 },
      { start: 0, length: 16, pitch: 60, velocity: 0.8 },
    ]);
    const hits = allHits(s, "pattern");
    expect(hits.map((h) => [h.note, h.length, h.time])).toEqual([
      [57, 16, 0],
      [60, 16, 0],
    ]);
    s = setPatternLength(s, s.currentPatternId, 32);
    expect(pat(s).notes[pad.id].map((n) => n.start)).toEqual([0, 0, 16, 16]);
    s = removeChannel(s, pad.id);
    expect(pat(s).notes[pad.id]).toBeUndefined();
  });

  it("old (v1) songs load with defaults", () => {
    const s = fresh();
    const v1 = JSON.parse(JSON.stringify(s));
    v1.version = 1;
    delete v1.key;
    delete v1.scale;
    for (const c of v1.channels) delete c.rootNote, delete c.gate;
    for (const p of v1.patterns) delete p.notes;
    const n = normalizeSong(v1)!;
    expect(n.version).toBe(SONG_VERSION);
    expect([n.key, n.scale]).toEqual([9, "minor"]);
    expect(n.channels[0]).toMatchObject({ rootNote: 60, gate: false });
    expect(n.patterns[0].notes).toEqual({});
  });
});

describe("v2 → v3 migration", () => {
  it("turns the pattern list into clips laid end to end", () => {
    const s = fresh();
    const v2: Record<string, unknown> = JSON.parse(JSON.stringify(s));
    const a = s.patterns[0].id;
    delete v2.tracks;
    delete v2.clips;
    delete v2.fx;
    v2.version = 2;
    v2.patterns = [...s.patterns, { id: "pat99", name: "B", steps: 32, rows: {}, notes: {} }];
    v2.arrangement = [a, "pat99", a];
    const n = normalizeSong(v2)!;
    expect(n.version).toBe(SONG_VERSION);
    expect(n.tracks).toHaveLength(4);
    expect(n.clips.map((c) => [c.kind === "pattern" && c.patternId, c.start, c.length, c.trackId])).toEqual([
      [a, 0, 16, n.tracks[0].id],
      ["pat99", 16, 32, n.tracks[0].id],
      [a, 48, 16, n.tracks[0].id],
    ]);
    expect(n.fx).toEqual({ delaySteps: 3, delayFeedback: 0.35, delayPingPong: false, reverbSize: "hall", limiter: true });
    expect(n.nextId).toBeGreaterThan(99);
  });
});

describe("warp (follow the song tempo)", () => {
  it("stretch factor and clip length follow the tempo only when on", async () => {
    const { warpFactor, stepsFor } = await import("./song");
    let s = addChannel(fresh(), { kind: "sample", sessionId: "s", sampleId: "x" }, "Loop");
    const ch = () => s.channels[s.channels.length - 1];
    expect(ch().warp).toEqual({ on: false, bpm: 0 });
    expect(warpFactor(ch(), 120)).toBe(1);
    s = updateChannel(s, ch().id, { warp: { on: true, bpm: 90 } });
    expect(warpFactor(ch(), 120)).toBeCloseTo(0.75);
    // A 2-bar loop at 90 BPM (5.333 s) is exactly 2 bars (32 steps) at any song tempo.
    expect(stepsFor(ch(), (2 * 4 * 60) / 90, 120)).toBe(32);
    expect(stepsFor(ch(), (2 * 4 * 60) / 90, 140)).toBe(32);
    // Drums and synths never warp.
    expect(warpFactor({ ...ch(), sound: { kind: "builtin", id: "kick" } }, 120)).toBe(1);
  });
});

describe("clip volume, fades and mute", () => {
  it("level follows gain and linear fades; no fade-out leaves the end alone", async () => {
    const { clipLevel } = await import("./song");
    const c = { gain: 0.5, fadeIn: 4, fadeOut: 8, muted: false, length: 32 };
    expect(clipLevel(c, 0)).toBe(0);
    expect(clipLevel(c, 2)).toBeCloseTo(0.25);
    expect(clipLevel(c, 10)).toBeCloseTo(0.5);
    expect(clipLevel(c, 28)).toBeCloseTo(0.25);
    expect(clipLevel(c, 32)).toBe(0);
    expect(clipLevel({ ...c, fadeIn: 0, fadeOut: 0 }, 40)).toBe(0.5);
  });

  it("updateClip clamps: fades fit in the clip, gain 0..1.5", async () => {
    const { updateClip } = await import("./song");
    let s = fresh();
    const id = s.clips[0].id;
    expect(s.clips[0]).toMatchObject({ gain: 1, fadeIn: 0, fadeOut: 0, muted: false });
    s = updateClip(s, id, { fadeIn: 12, fadeOut: 12, gain: 3 });
    expect(s.clips[0]).toMatchObject({ fadeIn: 12, fadeOut: 4, gain: 1.5 });
    // Shortening the clip shortens the fades too.
    s = updateClip(s, id, { length: 8 });
    expect(s.clips[0].fadeIn + s.clips[0].fadeOut).toBeLessThanOrEqual(8);
  });

  it("hits carry the clip mix; muted clips are silent but still show position", async () => {
    const { updateClip } = await import("./song");
    let s = fresh();
    const kick = s.channels[0].id;
    s = setStep(s, s.currentPatternId, kick, 0, 1);
    s = setStep(s, s.currentPatternId, kick, 8, 1);
    expect(eventsAt(s, "song", 0).hits[0].clip).toBeUndefined(); // untouched clip: no extra work
    s = updateClip(s, s.clips[0].id, { gain: 0.5, fadeOut: 8 });
    const h = eventsAt(s, "song", 8).hits[0];
    expect(h.clip).toMatchObject({ at: 8, mix: { gain: 0.5, fadeOut: 8, length: 16 } });
    s = updateClip(s, s.clips[0].id, { muted: true });
    expect(eventsAt(s, "song", 0).hits).toEqual([]);
    expect(eventsAt(s, "song", 0).pos.patterns).toEqual({ [s.currentPatternId]: 0 });
  });

  it("old clips load with neutral mix", () => {
    const s = fresh();
    const raw = JSON.parse(JSON.stringify(s));
    for (const c of raw.clips) delete c.gain, delete c.fadeIn, delete c.fadeOut, delete c.muted;
    expect(normalizeSong(raw)!.clips[0]).toMatchObject({ gain: 1, fadeIn: 0, fadeOut: 0, muted: false });
  });
});

describe("piano roll view of steps", () => {
  it("shows steps as notes without changing the song", async () => {
    const { displayNotes, channelNotes } = await import("./song");
    let s = fresh();
    const kick = s.channels[0];
    s = setStep(s, s.currentPatternId, kick.id, 4, 0.7);
    expect(displayNotes(pat(s), kick)).toEqual([{ start: 4, length: 1, pitch: 60, velocity: 0.7 }]);
    expect(channelNotes(pat(s), kick.id)).toEqual([]);
    expect(pat(s).rows[kick.id][4]).toBe(0.7);
  });
});

describe("effects (song v6)", () => {
  const names = { kick: "Bombo", snare: "Caja", clap: "Palmas", hat: "Hi-hat", openHat: "Hi-hat abierto", rim: "Aro" } as DrumNames;

  it("a v5 song loads with every new effect off, so it sounds the same", () => {
    const s = newSong(names, "P1");
    const v5 = JSON.parse(JSON.stringify({ ...s, version: 5 }));
    for (const c of v5.channels) c.fx = { low: 3, mid: 0, high: 0, comp: 0.2, reverb: 0.1, delay: 0 };
    delete v5.fx.reverbSize;
    delete v5.fx.delayPingPong;
    const n = normalizeSong(v5)!;
    expect(n.version).toBe(SONG_VERSION);
    expect(n.channels[0].fx).toEqual({ ...NO_FX, low: 3, comp: 0.2, reverb: 0.1 });
    expect(moreFxActive(n.channels[0].fx)).toBe(false);
    expect(n.fx.reverbSize).toBe("hall");
    expect(n.fx.delayPingPong).toBe(false);
  });

  it("bad values are fixed: unknown types off, ranges clamped, dangling ducking dropped", () => {
    const s = newSong(names, "P1");
    const [a, b] = s.channels;
    const raw = JSON.parse(JSON.stringify(s));
    raw.channels[0].fx = { ...NO_FX, drive: "nuclear", driveAmount: 9, width: -1, moveRate: 7, duckBy: a.id };
    raw.channels[1].fx = { ...NO_FX, duckBy: "ch-nope" };
    raw.channels[2].fx = { ...NO_FX, duckBy: b.id, filter: "high" };
    raw.fx.reverbSize = "galaxy";
    const n = normalizeSong(raw)!;
    expect(n.channels[0].fx.drive).toBe("off");
    expect(n.channels[0].fx.driveAmount).toBe(1);
    expect(n.channels[0].fx.width).toBe(0);
    expect(n.channels[0].fx.moveRate).toBe(NO_FX.moveRate);
    expect(n.channels[0].fx.duckBy).toBeNull(); // itself
    expect(n.channels[1].fx.duckBy).toBeNull(); // doesn't exist
    expect(n.channels[2].fx.duckBy).toBe(b.id);
    expect(n.fx.reverbSize).toBe("hall");
  });

  it("removing the channel others duck to turns their ducking off", () => {
    const s = newSong(names, "P1");
    const [kick, bass] = s.channels;
    const withDuck = updateChannel(s, bass.id, { fx: { ...NO_FX, duckBy: kick.id } });
    expect(fxActive(withDuck.channels[1].fx)).toBe(true);
    expect(removeChannel(withDuck, kick.id).channels[0].fx.duckBy).toBeNull();
  });

  it("an effect type left on 'off' with an amount doesn't count as active", () => {
    expect(fxActive({ ...NO_FX, driveAmount: 1, modAmount: 1 })).toBe(false);
    expect(fxActive({ ...NO_FX, drive: "soft" })).toBe(true);
    expect(fxActive({ ...NO_FX, width: 1.5 })).toBe(true);
  });
});

describe("track mute and solo", () => {
  /** Kick on step 0 of pattern 1, placed on tracks 0 and 1 (same bar). */
  const twoTracks = () => {
    let s = fresh();
    s = setStep(s, s.currentPatternId, s.channels[0].id, 0, 1);
    s = place(s, s.currentPatternId, 0, 1, 1);
    return s;
  };

  it("new tracks sound", () => {
    const s = fresh();
    expect(s.tracks.every((t) => !t.mute && !t.solo)).toBe(true);
    expect(audibleTracks(s).size).toBe(s.tracks.length);
  });

  it("a muted track is silent but still shows position", () => {
    let s = twoTracks();
    expect(eventsAt(s, "song", 0).hits).toHaveLength(2);
    s = setTracksMix(s, [s.tracks[0].id], { mute: true });
    expect(eventsAt(s, "song", 0).hits).toHaveLength(1);
    s = setTracksMix(s, [s.tracks[1].id], { mute: true });
    expect(eventsAt(s, "song", 0).hits).toEqual([]);
    expect(eventsAt(s, "song", 0).pos.patterns).toEqual({ [s.currentPatternId]: 0 });
    expect(allHits(s, "song")).toEqual([]);
  });

  it("solo wins over mute and applies to several tracks at once", () => {
    let s = twoTracks();
    const [a, b, c] = s.tracks.map((t) => t.id);
    s = setTracksMix(s, [a, b], { solo: true });
    expect([...audibleTracks(s)].sort()).toEqual([a, b].sort());
    s = setTracksMix(s, [a], { mute: true });
    expect(audibleTracks(s).has(a)).toBe(true); // soloed: mute ignored
    expect(audibleTracks(s).has(c)).toBe(false);
    s = setTracksMix(s, [a, b], { solo: false });
    expect(audibleTracks(s).has(a)).toBe(false);
    expect(audibleTracks(s).has(c)).toBe(true);
  });

  it("pattern mode ignores track mute", () => {
    let s = twoTracks();
    s = setTracksMix(s, s.tracks.map((t) => t.id), { mute: true });
    expect(eventsAt(s, "pattern", 0).hits).toHaveLength(1);
  });

  it("old tracks load sounding", () => {
    const raw = JSON.parse(JSON.stringify(fresh()));
    for (const t of raw.tracks) delete t.mute, delete t.solo;
    expect(normalizeSong(raw)!.tracks.every((t) => t.mute === false && t.solo === false)).toBe(true);
    raw.tracks[0].mute = 1;
    expect(normalizeSong(raw)!.tracks[0].mute).toBe(true);
  });
});

describe("volume, pan and effects per pattern (song v8)", () => {
  const kickOf = (s: Song) => s.channels[0].id;

  it("an effect on the kick of one pattern doesn't touch the kick of another", () => {
    let s = fresh();
    const a = s.currentPatternId;
    s = addPattern(s, "B");
    const b = s.currentPatternId;
    const kick = kickOf(s);
    s = setMix(s, b, kick, { fx: { ...NO_FX, reverb: 0.5 }, volume: 0.4 });
    expect(mixOf(s, b, kick).fx.reverb).toBe(0.5);
    expect(mixOf(s, b, kick).volume).toBe(0.4);
    expect(mixOf(s, a, kick)).toEqual(DEFAULT_MIX);
    // The channel's own mix (its audio clips) stays as it was.
    expect(mixOf(s, null, kick).fx).toEqual(NO_FX);
    expect(channelIn(s, s.channels[0], b).fx.reverb).toBe(0.5);
  });

  it("hits carry their pattern so the mixer uses its strip", () => {
    let s = fresh();
    const kick = kickOf(s);
    s = setStep(s, s.currentPatternId, kick, 0, 1);
    expect(eventsAt(s, "pattern", 0).hits[0].patternId).toBe(s.currentPatternId);
    const keys = mixStrips(s).map((x) => x.key);
    expect(keys).toContain(kick);
    expect(keys).toContain(stripKey(kick, s.currentPatternId));
  });

  it("only makes strips for patterns that play the channel (plus the one being edited)", () => {
    let s = fresh();
    const a = s.currentPatternId;
    const kick = kickOf(s);
    s = setStep(s, a, kick, 0, 1);
    s = addPattern(s, "B"); // now B is current, A only plays the kick
    const keys = mixStrips(s).map((x) => x.key);
    expect(keys).toContain(stripKey(kick, a));
    expect(keys).not.toContain(stripKey(s.channels[1].id, a));
    expect(keys).toContain(stripKey(s.channels[1].id, s.currentPatternId));
  });

  it("a new pattern keeps volume and pan but starts without effects; a copy keeps everything", () => {
    let s = fresh();
    const a = s.currentPatternId;
    const kick = kickOf(s);
    s = setMix(s, a, kick, { volume: 0.5, pan: -0.3, fx: { ...NO_FX, delay: 0.4 } });
    const added = addPattern(s, "B");
    expect(mixOf(added, added.currentPatternId, kick)).toEqual({ volume: 0.5, pan: -0.3, fx: NO_FX });
    const copied = duplicatePattern(s, a, "A2");
    expect(mixOf(copied, copied.currentPatternId, kick).fx.delay).toBe(0.4);
  });

  it("copies one pattern's mix to every pattern and the audio clips", () => {
    let s = fresh();
    const a = s.currentPatternId;
    s = addPattern(s, "B");
    const kick = kickOf(s);
    s = setMix(s, a, kick, { fx: { ...NO_FX, comp: 0.6 } });
    s = copyMixEverywhere(s, a, kick);
    expect(mixOf(s, s.currentPatternId, kick).fx.comp).toBe(0.6);
    expect(s.channels[0].fx.comp).toBe(0.6);
  });

  it("removing a channel drops its mixes and anyone ducking to it", () => {
    let s = fresh();
    const [kick, snare] = [s.channels[0].id, s.channels[1].id];
    s = setMix(s, s.currentPatternId, snare, { fx: { ...NO_FX, duckBy: kick } });
    s = removeChannel(s, kick);
    expect(pat(s).mix[kick]).toBeUndefined();
    expect(mixOf(s, s.currentPatternId, snare).fx.duckBy).toBeNull();
  });

  it("old songs (v7) give every pattern the channel's mix, so they sound the same", () => {
    const s = fresh();
    const v7 = JSON.parse(JSON.stringify(s));
    v7.version = 7;
    v7.channels[0].volume = 0.6;
    v7.channels[0].fx = { ...NO_FX, reverb: 0.3 };
    for (const p of v7.patterns) delete p.mix;
    const n = normalizeSong(v7)!;
    expect(n.version).toBe(SONG_VERSION);
    expect(n.patterns[0].mix[n.channels[0].id]).toEqual({ volume: 0.6, pan: 0, fx: { ...NO_FX, reverb: 0.3 } });
  });

  it("loading clamps pattern mixes and drops unknown channels", () => {
    const s = fresh();
    const raw = JSON.parse(JSON.stringify(s));
    raw.patterns[0].mix = { [s.channels[0].id]: { volume: 9, pan: -4, fx: { reverb: 3, duckBy: "nope" } }, ghost: { volume: 1 } };
    const n = normalizeSong(raw)!;
    expect(n.patterns[0].mix[s.channels[0].id]).toEqual({ volume: 1.25, pan: -1, fx: { ...NO_FX, reverb: 1 } });
    expect(n.patterns[0].mix.ghost).toBeUndefined();
  });
});

describe("glide (piano-roll notes that slide in)", () => {
  it("slides from the closest note of the previous onset, wrapping around the loop", async () => {
    const { glideFrom } = await import("./song");
    const notes = [
      { start: 0, length: 4, pitch: 48, velocity: 0.8 },
      { start: 0, length: 4, pitch: 64, velocity: 0.8 },
      { start: 4, length: 4, pitch: 62, velocity: 0.8, glide: 2 },
      { start: 8, length: 4, pitch: 50, velocity: 0.8, glide: 2 },
    ];
    expect(glideFrom(notes, 2)).toBe(64); // nearer than 48
    expect(glideFrom(notes, 3)).toBe(62);
    expect(glideFrom(notes, 0)).toBe(50); // first onset: from the last one (loop)
    expect(glideFrom([notes[2]], 0)).toBe(60); // alone: a whole tone below
  });

  it("gliding notes produce hits with where they slide from, capped at the note length", async () => {
    const { setNotes, channelNotes } = await import("./song");
    let s = addChannel(fresh(), { kind: "synth", preset: "lead" }, "Lead");
    const lead = s.channels[s.channels.length - 1].id;
    s = setNotes(s, s.currentPatternId, lead, [
      { start: 0, length: 4, pitch: 60, velocity: 0.8 },
      { start: 4, length: 2, pitch: 67, velocity: 0.8, glide: 4 },
      { start: 8, length: 2, pitch: 67, velocity: 0.8, glide: 1 },
    ]);
    const hits = allHits(s, "pattern").filter((h) => h.channelId === lead);
    expect(hits.map((h) => h.glide)).toEqual([undefined, { from: 60, steps: 2 }, undefined]); // same pitch: no slide
    expect(channelNotes(pat(s), lead)[1].glide).toBe(4);
  });

  it("loads old notes without glide and clamps bad values", () => {
    const s = addChannel(fresh(), { kind: "synth", preset: "lead" }, "Lead");
    const raw = JSON.parse(JSON.stringify(s));
    const id = s.channels[s.channels.length - 1].id;
    raw.patterns[0].notes[id] = [
      { start: 0, length: 4, pitch: 60, velocity: 0.8 },
      { start: 4, length: 4, pitch: 62, velocity: 0.8, glide: 9999 },
      { start: 8, length: 4, pitch: 64, velocity: 0.8, glide: "x" },
    ];
    const n = normalizeSong(raw)!;
    expect(n.patterns[0].notes[id].map((x) => x.glide)).toEqual([undefined, 128, undefined]);
  });
});
