// Standard MIDI File export: the song's notes and steps, one track per channel, so the
// beat and the chords can be taken to any DAW (and played with other instruments there).

import { allHits, clipLevel, type BuiltinDrum, type Channel, type PlayMode, type Song } from "./song";

export const PPQ = 96; // ticks per quarter note
const TICKS_PER_STEP = PPQ / 4;

/** General MIDI drum notes, so the built-in kit maps to any drum plugin. */
export const GM_DRUMS: Record<BuiltinDrum, number> = { kick: 36, rim: 37, snare: 38, clap: 39, hat: 42, openHat: 46 };

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  for (n >>= 7; n > 0; n >>= 7) out.unshift((n & 0x7f) | 0x80);
  return out;
}

const text = (s: string) => [...new TextEncoder().encode(s)];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

function chunk(type: string, data: number[]): number[] {
  return [...text(type), ...u32(data.length), ...data];
}

interface Ev {
  tick: number;
  /** Sort order at the same tick: note-offs before note-ons. */
  order: number;
  bytes: number[];
}

function track(events: Ev[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const data: number[] = [];
  let last = 0;
  for (const e of events) {
    data.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  data.push(0, 0xff, 0x2f, 0); // end of track
  return chunk("MTrk", data);
}

function nameEvent(name: string): Ev {
  const t = text(name);
  return { tick: 0, order: -1, bytes: [0xff, 0x03, ...vlq(t.length), ...t] };
}

/** Type-1 MIDI file of one pass of the song (or the current pattern). Audio clips are skipped. */
export function songToMidi(song: Song, mode: PlayMode, title = "Sampler Lab"): Uint8Array {
  const tempo = Math.round(60_000_000 / song.bpm);
  const conductor = track([
    nameEvent(title),
    { tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff] },
    { tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] }, // 4/4
  ]);

  const hits = allHits(song, mode).filter((h) => !h.audio);
  const tracks: number[][] = [];
  let melodic = 0;
  for (const ch of song.channels) {
    const mine = hits.filter((h) => h.channelId === ch.id);
    if (!mine.length) continue;
    const drum = ch.sound.kind === "builtin";
    // Channel 10 (index 9) is drums in General MIDI; melodic channels skip it.
    const idx = drum ? 0 : melodic++ % 15;
    const midiCh = drum ? 9 : idx >= 9 ? idx + 1 : idx;
    const events: Ev[] = [nameEvent(ch.name)];
    for (const h of mine) {
      const note = clampNote(drumNote(ch) ?? h.note + ch.pitch);
      const start = Math.round((h.time / (60 / song.bpm)) * PPQ);
      const len = Math.max(1, Math.round((h.length || 1) * TICKS_PER_STEP));
      // Clip volume/fades become velocity (MIDI has no per-note fade).
      const level = h.clip ? clipLevel(h.clip.mix, h.clip.at) : 1;
      const vel = Math.max(1, Math.min(127, Math.round(h.velocity * level * 127)));
      events.push({ tick: start, order: 1, bytes: [0x90 | midiCh, note, vel] });
      events.push({ tick: start + len, order: 0, bytes: [0x80 | midiCh, note, 0] });
    }
    tracks.push(track(events));
  }
  const header = chunk("MThd", [0, 1, 0, tracks.length + 1, (PPQ >> 8) & 0xff, PPQ & 0xff]);
  return new Uint8Array([...header, ...conductor, ...tracks.flat()]);
}

function drumNote(ch: Channel): number | null {
  return ch.sound.kind === "builtin" ? GM_DRUMS[ch.sound.id] : null;
}

const clampNote = (n: number) => Math.max(0, Math.min(127, Math.round(n)));
