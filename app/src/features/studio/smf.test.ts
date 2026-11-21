import { describe, expect, it } from "vitest";
import { GM_DRUMS, PPQ, songToMidi } from "./smf";
import { addChannel, newSong, setNotes, setStep, type DrumNames } from "./song";

const names: DrumNames = { kick: "Bombo", snare: "Caja", clap: "Palmas", hat: "Hi-hat", openHat: "Hi-hat abierto", rim: "Aro" };

/** Minimal SMF reader: tracks → list of [absTick, status, d1, d2] for channel messages. */
function read(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer);
  const str = (o: number) => String.fromCharCode(...bytes.slice(o, o + 4));
  expect(str(0)).toBe("MThd");
  const ntrk = v.getUint16(10);
  const ppq = v.getUint16(12);
  let o = 14;
  const tracks: { name: string; tempo?: number; events: number[][] }[] = [];
  for (let t = 0; t < ntrk; t++) {
    expect(str(o)).toBe("MTrk");
    const len = v.getUint32(o + 4);
    let p = o + 8;
    const end = p + len;
    let tick = 0;
    const tr: { name: string; tempo?: number; events: number[][] } = { name: "", events: [] };
    while (p < end) {
      let d = 0;
      let b;
      do {
        b = bytes[p++];
        d = (d << 7) | (b & 0x7f);
      } while (b & 0x80);
      tick += d;
      const st = bytes[p++];
      if (st === 0xff) {
        const type = bytes[p++];
        const l = bytes[p++];
        if (type === 0x03) tr.name = new TextDecoder().decode(bytes.slice(p, p + l));
        if (type === 0x51) tr.tempo = (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2];
        p += l;
      } else {
        tr.events.push([tick, st, bytes[p], bytes[p + 1]]);
        p += 2;
      }
    }
    tracks.push(tr);
    o = end;
  }
  return { ppq, tracks };
}

describe("MIDI export", () => {
  it("writes tempo, a drum track on channel 10 and a melodic track", () => {
    let s = { ...newSong(names), bpm: 120 };
    const kick = s.channels[0].id;
    s = setStep(s, s.currentPatternId, kick, 0, 1);
    s = setStep(s, s.currentPatternId, kick, 8, 0.5);
    s = addChannel(s, { kind: "synth", preset: "pad" }, "Pad");
    const pad = s.channels[s.channels.length - 1].id;
    s = setNotes(s, s.currentPatternId, pad, [
      { start: 0, length: 16, pitch: 57, velocity: 0.8 },
      { start: 0, length: 16, pitch: 60, velocity: 0.8 },
    ]);
    const { ppq, tracks } = read(songToMidi(s, "pattern", "Mi beat"));
    expect(ppq).toBe(PPQ);
    expect(tracks.map((t) => t.name)).toEqual(["Mi beat", "Bombo", "Pad"]);
    expect(tracks[0].tempo).toBe(500000); // 120 BPM

    const drums = tracks[1].events;
    expect(drums.filter((e) => e[1] === 0x99).map((e) => [e[0], e[2], e[3]])).toEqual([
      [0, GM_DRUMS.kick, 127],
      [PPQ * 2, GM_DRUMS.kick, 64],
    ]);
    const pads = tracks[2].events;
    const ons = pads.filter((e) => (e[1] & 0xf0) === 0x90);
    const offs = pads.filter((e) => (e[1] & 0xf0) === 0x80);
    expect(ons.map((e) => e[2])).toEqual([57, 60]);
    expect(offs.every((e) => e[0] === PPQ * 4)).toBe(true); // a whole bar
    expect(ons[0][1] & 0x0f).not.toBe(9);
  });

  it("note-offs come before note-ons at the same tick (repeated notes don't get cut)", () => {
    let s = newSong(names);
    s = addChannel(s, { kind: "synth", preset: "keys" }, "Keys");
    const k = s.channels[s.channels.length - 1].id;
    s = setNotes(s, s.currentPatternId, k, [
      { start: 0, length: 4, pitch: 60, velocity: 1 },
      { start: 4, length: 4, pitch: 60, velocity: 1 },
    ]);
    const ev = read(songToMidi(s, "pattern")).tracks[1].events.filter((e) => e[0] === PPQ);
    expect(ev.map((e) => e[1] & 0xf0)).toEqual([0x80, 0x90]);
  });

  it("an empty song is still a valid file", () => {
    const { tracks } = read(songToMidi(newSong(names), "pattern"));
    expect(tracks).toHaveLength(1);
  });
});
