// The song: a pure data model (no audio, no React) so it can be tested, saved as JSON
// and, later, played by a different engine. Schema documented in docs/SONG_SCHEMA.md.
//
// FL Studio-style: channels (one sound each, with its mixer strip and effects) +
// patterns (steps or piano-roll notes per channel) + a timeline of tracks where pattern
// clips and audio clips are placed. Time unit inside a pattern is the step: a 16th
// note in 4/4, so a bar has 16 steps.

import { SCALES, type NoteLike, type ScaleId } from "./theory";

export const STEPS_PER_BAR = 16;
export const STEPS_PER_BEAT = 4;
export const SONG_VERSION = 8;

export type BuiltinDrum = "kick" | "snare" | "clap" | "hat" | "openHat" | "rim";
export const BUILTIN_DRUMS: BuiltinDrum[] = ["kick", "snare", "clap", "hat", "openHat", "rim"];

export type SynthPreset = "bass" | "sub" | "pad" | "lead" | "pluck" | "keys";
export const SYNTH_PRESETS: SynthPreset[] = ["sub", "bass", "pad", "keys", "pluck", "lead"];

export type SoundRef =
  | { kind: "builtin"; id: BuiltinDrum }
  /** Built-in synthesizer (melodic). */
  | { kind: "synth"; preset: SynthPreset }
  /** A sample from the library: sessions are referenced, not copied, so edits carry over. */
  | { kind: "sample"; sessionId: string; sampleId: string }
  /** A one-shot or loop from an installed sound pack. */
  | { kind: "pack"; packId: string; itemId: string }
  /** A multi-sample instrument (SFZ) from a pack: the right recording for each note. */
  | { kind: "instrument"; packId: string; itemId: string };

/** A sound reference as loaded from disk, checked (null if it isn't one we know). */
export function normalizeSound(raw: unknown): SoundRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  switch (r.kind) {
    case "builtin":
      return BUILTIN_DRUMS.includes(r.id as BuiltinDrum) ? { kind: "builtin", id: r.id as BuiltinDrum } : null;
    case "synth":
      return SYNTH_PRESETS.includes(r.preset as SynthPreset) ? { kind: "synth", preset: r.preset as SynthPreset } : null;
    case "sample":
      return str(r.sessionId) && str(r.sampleId) ? { kind: "sample", sessionId: r.sessionId as string, sampleId: r.sampleId as string } : null;
    case "pack":
    case "instrument":
      return str(r.packId) && str(r.itemId) ? { kind: r.kind, packId: r.packId as string, itemId: r.itemId as string } : null;
    default:
      return null;
  }
}

export interface Channel {
  id: string;
  name: string;
  sound: SoundRef;
  /**
   * volume / pan / fx here are the channel's mix for its *audio clips* (the sound placed
   * straight on the timeline). Inside a pattern the pattern's own mix is used instead
   * (`Pattern.mix`, see `mixOf`).
   * Linear gain, 0..1.25 (0.8 by default leaves headroom for several channels).
   */
  volume: number;
  /** -1 (left) .. 1 (right). */
  pan: number;
  /** Semitones; repitches the sound (speeds it up or down, like a sampler). */
  pitch: number;
  /**
   * The note the sound plays at its original speed (MIDI, 60 = C4). A piano-roll note
   * N plays the sample repitched by N - rootNote semitones.
   */
  rootNote: number;
  /** Piano-roll notes stop the sound when they end (otherwise it plays to its end). */
  gate: boolean;
  fx: ChannelFx;
  /**
   * Follow the song tempo: the sound is time-stretched (pitch kept) from its own tempo
   * `bpm` to the song's. For loops and phrases. bpm 0 = unknown.
   */
  warp: { on: boolean; bpm: number };
  mute: boolean;
  solo: boolean;
}

export type DriveType = "off" | "soft" | "hard" | "crush";
export type FilterType = "off" | "low" | "high";
export type ModType = "off" | "chorus" | "flanger" | "phaser";
export type ReverbSize = "room" | "hall" | "huge";
export const DRIVE_TYPES: DriveType[] = ["off", "soft", "hard", "crush"];
export const FILTER_TYPES: FilterType[] = ["off", "low", "high"];
export const MOD_TYPES: ModType[] = ["off", "chorus", "flanger", "phaser"];
export const REVERB_SIZES: ReverbSize[] = ["room", "hall", "huge"];
/** "Movimiento" cycle lengths, in steps (1/8 note … 4 bars). */
export const MOVE_RATES = [2, 4, 8, 16, 32, 64];

/**
 * Per-channel effects, in the order the sound goes through them:
 * drive → EQ → filter (+ movement) → modulation → compressor → volume → ducking → width →
 * pan → sends. NO_FX = untouched sound.
 */
export interface ChannelFx {
  /** EQ gains in dB, -12..12: low shelf (200 Hz), mid peak (1 kHz), high shelf (5 kHz). */
  low: number;
  mid: number;
  high: number;
  /** Compression amount 0..1 (0 = off). */
  comp: number;
  /** Send levels 0..1 to the shared reverb and delay. */
  reverb: number;
  delay: number;
  /** Saturación (soft) | Distorsión (hard) | Crujido digital (crush, bit reduction). */
  drive: DriveType;
  driveAmount: number;
  /** Pasa-bajos (low) or pasa-altos (high). */
  filter: FilterType;
  /** 0..1, exponential 40 Hz..18 kHz. */
  cutoff: number;
  /** 0..1 → Q 0.7..12. */
  resonance: number;
  /** "Movimiento": 0..1 depth of a tempo-synced sweep of the cutoff. */
  move: number;
  /** Length of one movement cycle, in steps (one of MOVE_RATES). */
  moveRate: number;
  mod: ModType;
  modAmount: number;
  /** Stereo width 0..2: 1 = as is, 0 = mono, 2 = extra wide. */
  width: number;
  /** "Bombeo": this channel ducks every time that channel plays (null = off). */
  duckBy: string | null;
  duckAmount: number;
}
export const NO_FX: ChannelFx = {
  low: 0,
  mid: 0,
  high: 0,
  comp: 0,
  reverb: 0,
  delay: 0,
  drive: "off",
  driveAmount: 0.5,
  filter: "off",
  cutoff: 0.6,
  resonance: 0.2,
  move: 0,
  moveRate: 16,
  mod: "off",
  modAmount: 0.5,
  width: 1,
  duckBy: null,
  duckAmount: 0.6,
};

/** True if anything in the chain changes the sound (amounts of "off" blocks don't count). */
export function fxActive(fx: ChannelFx): boolean {
  return (
    fx.low !== 0 ||
    fx.mid !== 0 ||
    fx.high !== 0 ||
    fx.comp > 0 ||
    fx.reverb > 0 ||
    fx.delay > 0 ||
    (fx.drive !== "off" && fx.driveAmount > 0) ||
    fx.filter !== "off" ||
    (fx.mod !== "off" && fx.modAmount > 0) ||
    fx.width !== 1 ||
    (fx.duckBy !== null && fx.duckAmount > 0)
  );
}

/** True if one of the effects under "Más" is on. */
export function moreFxActive(fx: ChannelFx): boolean {
  return fx.drive !== "off" || fx.filter !== "off" || fx.mod !== "off" || fx.width !== 1 || fx.duckBy !== null;
}

/** A channel's volume, pan and effects in one pattern (or for its audio clips). */
export interface ChannelMix {
  volume: number;
  pan: number;
  fx: ChannelFx;
}
export const DEFAULT_MIX: ChannelMix = { volume: 0.8, pan: 0, fx: NO_FX };

/** Shared effects (the reverb and delay every channel can send to) and the master. */
export interface SongFx {
  /** Delay time in steps (3 = dotted eighth, the classic). */
  delaySteps: number;
  delayFeedback: number;
  /** Repeats bounce left-right. */
  delayPingPong: boolean;
  reverbSize: ReverbSize;
  /** Limiter on the master: keeps the mix from clipping. */
  limiter: boolean;
}

export interface Track {
  id: string;
  name: string;
  /** Silence everything on this track (song mode). */
  mute: boolean;
  /** Only soloed tracks sound (solo wins over mute, like channels). */
  solo: boolean;
}

/** Per-clip mix: volume, fades and mute (fade lengths in steps). */
export interface ClipMix {
  /** Linear gain 0..1.5 (1 = as is). */
  gain: number;
  fadeIn: number;
  fadeOut: number;
  muted: boolean;
}
export const CLIP_MIX: ClipMix = { gain: 1, fadeIn: 0, fadeOut: 0, muted: false };

/** Something placed on the timeline. Times in steps. */
export type Clip = { id: string; trackId: string; start: number; length: number } & ClipMix & (
  | { kind: "pattern"; patternId: string }
  /** A channel's sound played as-is from the clip start (a loop, a phrase, a stem). */
  | { kind: "audio"; channelId: string }
);

export interface Pattern {
  id: string;
  name: string;
  /** Length in steps (16 per bar). */
  steps: number;
  /** Per channel id: one velocity per step, 0 = off, (0, 1] = on. Missing row = empty. */
  rows: Record<string, number[]>;
  /** Per channel id: piano-roll notes. A channel uses steps or notes in a pattern. */
  notes: Record<string, Note[]>;
  /**
   * Per channel id: its volume, pan and effects in this pattern, so the kick of "Estribillo"
   * can have reverb and the kick of "Intro" not. Missing entry = DEFAULT_MIX.
   */
  mix: Record<string, ChannelMix>;
}

/**
 * A piano-roll note. Times in steps (16ths); pitch is a MIDI note number.
 * `glide` (steps, optional): the note starts at the pitch of the note before it and slides
 * into its own pitch over that many steps (capped at the note's length). See glideFrom.
 */
export type Note = NoteLike & { glide?: number };

/** Longest glide stored (steps); playback also caps it at the note's length. */
export const MAX_GLIDE = 128;

export interface Song {
  version: number;
  bpm: number;
  /** 0 = straight, 1 = full triplet feel. Delays every second 16th. */
  swing: number;
  masterVolume: number;
  channels: Channel[];
  patterns: Pattern[];
  tracks: Track[];
  clips: Clip[];
  fx: SongFx;
  /** Pattern being edited. */
  currentPatternId: string;
  /** Key (0 = C … 11 = B) and scale: the piano roll highlights it and builds chords in it. */
  key: number;
  scale: ScaleId;
  nextId: number;
}

export type PlayMode = "pattern" | "song";

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/** Default channel names for the built-in kit (Spanish; the UI may translate). */
export type DrumNames = Record<BuiltinDrum, string>;

/** Default track name (the UI shows its own label, this is what gets saved). */
export const trackName = (n: number) => `Pista ${n}`;

export function newSong(drumNames: DrumNames, patternName = "Patrón 1"): Song {
  let song: Song = {
    version: SONG_VERSION,
    bpm: 120,
    swing: 0,
    masterVolume: 0.8,
    channels: [],
    patterns: [],
    tracks: [],
    clips: [],
    fx: { delaySteps: 3, delayFeedback: 0.35, delayPingPong: false, reverbSize: "hall", limiter: true },
    currentPatternId: "",
    key: 9, // A minor: all white keys, a classic for beats
    scale: "minor",
    nextId: 1,
  };
  for (const d of BUILTIN_DRUMS) song = addChannel(song, { kind: "builtin", id: d }, drumNames[d]);
  song = addPattern(song, patternName);
  for (let i = 1; i <= 4; i++) song = addTrack(song, trackName(i));
  return addClip(song, { kind: "pattern", patternId: song.currentPatternId, trackId: song.tracks[0].id, start: 0, length: STEPS_PER_BAR });
}

/**
 * In a "Tocar juntos" room every guest adds a letter to the ids it creates ("ch12b"), so
 * two people adding a channel at the same time never get the same id. Empty outside a
 * room (and for the host), so songs look exactly as before. Only letters: code that reads
 * the number of an id (`replace(/\D/g, "")`) keeps working.
 */
let idSuffix = "";
export function setIdSuffix(suffix: string) {
  idSuffix = suffix.replace(/[^a-z]/g, "");
}

function genId(song: Song, prefix: string): [Song, string] {
  return [{ ...song, nextId: song.nextId + 1 }, `${prefix}${song.nextId}${idSuffix}`];
}

export function addChannel(song: Song, sound: SoundRef, name: string): Song {
  const [s, id] = genId(song, "ch");
  const ch: Channel = {
    id,
    name,
    sound,
    volume: 0.8,
    pan: 0,
    pitch: 0,
    rootNote: 60,
    // Drums and pack one-shots ring out; samples, instruments and synths follow the note length.
    gate: sound.kind !== "builtin" && sound.kind !== "pack",
    fx: { ...NO_FX },
    warp: { on: false, bpm: 0 },
    mute: false,
    solo: false,
  };
  return { ...s, channels: [...s.channels, ch] };
}

export function updateChannel(song: Song, id: string, patch: Partial<Omit<Channel, "id">>): Song {
  return { ...song, channels: song.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

export function removeChannel(song: Song, id: string): Song {
  return {
    ...song,
    // Nobody keeps ducking to a channel that's gone.
    channels: song.channels
      .filter((c) => c.id !== id)
      .map((c) => (c.fx.duckBy === id ? { ...c, fx: { ...c.fx, duckBy: null } } : c)),
    clips: song.clips.filter((c) => !(c.kind === "audio" && c.channelId === id)),
    patterns: song.patterns.map((p) => {
      const rows = { ...p.rows };
      const notes = { ...p.notes };
      delete rows[id];
      delete notes[id];
      const mix: Record<string, ChannelMix> = {};
      for (const [k, m] of Object.entries(p.mix)) {
        if (k !== id) mix[k] = m.fx.duckBy === id ? { ...m, fx: { ...m.fx, duckBy: null } } : m;
      }
      return { ...p, rows, notes, mix };
    }),
  };
}

export function moveChannel(song: Song, id: string, delta: number): Song {
  const i = song.channels.findIndex((c) => c.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= song.channels.length) return song;
  const channels = [...song.channels];
  [channels[i], channels[j]] = [channels[j], channels[i]];
  return { ...song, channels };
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/**
 * A new, empty pattern. Volume and pan carry over from the pattern being edited (the
 * balance you already made stays); effects start off.
 */
export function addPattern(song: Song, name: string, steps = STEPS_PER_BAR): Song {
  const [s, id] = genId(song, "pat");
  const from = song.patterns.find((p) => p.id === song.currentPatternId);
  const mix: Record<string, ChannelMix> = {};
  for (const [k, m] of Object.entries(from?.mix ?? {})) mix[k] = { volume: m.volume, pan: m.pan, fx: { ...NO_FX } };
  return { ...s, patterns: [...s.patterns, { id, name, steps, rows: {}, notes: {}, mix }], currentPatternId: id };
}

export function duplicatePattern(song: Song, id: string, name: string): Song {
  const src = song.patterns.find((p) => p.id === id);
  if (!src) return song;
  const [s, newId] = genId(song, "pat");
  const rows = Object.fromEntries(Object.entries(src.rows).map(([k, v]) => [k, [...v]]));
  const notes = Object.fromEntries(Object.entries(src.notes).map(([k, v]) => [k, v.map((n) => ({ ...n }))]));
  const mix = Object.fromEntries(Object.entries(src.mix).map(([k, m]) => [k, { ...m, fx: { ...m.fx } }]));
  const copy = { id: newId, name, steps: src.steps, rows, notes, mix };
  const i = s.patterns.indexOf(src);
  return { ...s, patterns: [...s.patterns.slice(0, i + 1), copy, ...s.patterns.slice(i + 1)], currentPatternId: newId };
}

/** Delete a pattern (and its clips in the timeline). The last pattern can't be removed. */
export function removePattern(song: Song, id: string): Song {
  if (song.patterns.length <= 1) return song;
  const i = song.patterns.findIndex((p) => p.id === id);
  if (i < 0) return song;
  const patterns = song.patterns.filter((p) => p.id !== id);
  const current = song.currentPatternId === id ? patterns[Math.max(0, i - 1)].id : song.currentPatternId;
  const clips = song.clips.filter((c) => !(c.kind === "pattern" && c.patternId === id));
  return { ...song, patterns, clips, currentPatternId: current };
}

export function updatePattern(song: Song, id: string, patch: Partial<Pick<Pattern, "name">>): Song {
  return { ...song, patterns: song.patterns.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
}

/**
 * Change a pattern's length. Growing repeats what's there (a 1-bar beat becomes the
 * same beat twice, ready to vary); shrinking cuts the end.
 */
export function setPatternLength(song: Song, id: string, steps: number): Song {
  return {
    ...song,
    patterns: song.patterns.map((p) => {
      if (p.id !== id || p.steps === steps) return p;
      const rows = Object.fromEntries(
        Object.entries(p.rows).map(([ch, row]) => [ch, Array.from({ length: steps }, (_, i) => row[i % p.steps] ?? 0)]),
      );
      const notes = Object.fromEntries(
        Object.entries(p.notes).map(([ch, list]) => {
          const out: Note[] = [];
          for (let offset = 0; offset < steps; offset += p.steps) {
            for (const n of list) {
              const start = n.start + offset;
              if (start < steps) out.push({ ...n, start, length: Math.min(n.length, steps - start) });
            }
          }
          return [ch, out];
        }),
      );
      return { ...p, steps, rows, notes };
    }),
  };
}

/** Set one step's velocity (0 = off). */
export function setStep(song: Song, patternId: string, channelId: string, step: number, velocity: number): Song {
  return {
    ...song,
    patterns: song.patterns.map((p) => {
      if (p.id !== patternId || step < 0 || step >= p.steps) return p;
      const row = Array.from({ length: p.steps }, (_, i) => p.rows[channelId]?.[i] ?? 0);
      row[step] = Math.max(0, Math.min(1, velocity));
      return { ...p, rows: { ...p.rows, [channelId]: row } };
    }),
  };
}

export function stepVelocity(p: Pattern, channelId: string, step: number): number {
  return p.rows[channelId]?.[step] ?? 0;
}

export function clearRow(song: Song, patternId: string, channelId: string): Song {
  return {
    ...song,
    patterns: song.patterns.map((p) => {
      if (p.id !== patternId) return p;
      const rows = { ...p.rows };
      const notes = { ...p.notes };
      delete rows[channelId];
      delete notes[channelId];
      return { ...p, rows, notes };
    }),
  };
}

// ---------------------------------------------------------------------------
// Per-pattern mix
// ---------------------------------------------------------------------------

/** Where a mix lives: a pattern id, or null for the channel's audio clips. */
export type MixScope = string | null;

/** A channel's volume, pan and effects in a pattern (null = its audio clips). */
export function mixOf(song: Song, patternId: MixScope, channelId: string): ChannelMix {
  if (patternId === null) {
    const ch = song.channels.find((c) => c.id === channelId);
    return ch ? { volume: ch.volume, pan: ch.pan, fx: ch.fx } : DEFAULT_MIX;
  }
  return song.patterns.find((p) => p.id === patternId)?.mix[channelId] ?? DEFAULT_MIX;
}

/** The channel as it sounds in that scope (its volume, pan and fx swapped in). */
export function channelIn(song: Song, ch: Channel, patternId: MixScope): Channel {
  const m = mixOf(song, patternId, ch.id);
  return { ...ch, volume: m.volume, pan: m.pan, fx: m.fx };
}

/** Change a channel's volume, pan or effects in one pattern (null = its audio clips). */
export function setMix(song: Song, patternId: MixScope, channelId: string, patch: Partial<ChannelMix>): Song {
  if (patternId === null) return updateChannel(song, channelId, patch);
  return {
    ...song,
    patterns: song.patterns.map((p) =>
      p.id === patternId ? { ...p, mix: { ...p.mix, [channelId]: { ...(p.mix[channelId] ?? DEFAULT_MIX), ...patch } } } : p,
    ),
  };
}

/** Copy a channel's mix from one scope to every pattern and to its audio clips. */
export function copyMixEverywhere(song: Song, from: MixScope, channelId: string): Song {
  const m = mixOf(song, from, channelId);
  const copy = () => ({ volume: m.volume, pan: m.pan, fx: { ...m.fx } });
  const s = updateChannel(song, channelId, copy());
  return { ...s, patterns: s.patterns.map((p) => ({ ...p, mix: { ...p.mix, [channelId]: copy() } })) };
}

/** True if the pattern plays this channel (steps or notes). */
export function patternUses(p: Pattern, channelId: string): boolean {
  return (p.rows[channelId]?.some((v) => v > 0) ?? false) || (p.notes[channelId]?.length ?? 0) > 0;
}

/** Mixer strip id for a channel in a scope. */
export const stripKey = (channelId: string, patternId: MixScope) => (patternId === null ? channelId : `${channelId}@${patternId}`);

export interface StripSpec {
  key: string;
  channelId: string;
  mix: ChannelMix;
}

/**
 * Every mixer strip the song needs: one per channel (its audio clips, and the fallback),
 * plus one per channel in each pattern that plays it — and in the pattern being edited,
 * for live playing. Patterns that don't use a channel cost nothing.
 */
export function mixStrips(song: Song): StripSpec[] {
  const out: StripSpec[] = [];
  for (const ch of song.channels) out.push({ key: ch.id, channelId: ch.id, mix: { volume: ch.volume, pan: ch.pan, fx: ch.fx } });
  for (const p of song.patterns) {
    for (const ch of song.channels) {
      if (p.id !== song.currentPatternId && !patternUses(p, ch.id)) continue;
      out.push({ key: stripKey(ch.id, p.id), channelId: ch.id, mix: p.mix[ch.id] ?? DEFAULT_MIX });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Piano roll notes
// ---------------------------------------------------------------------------

export function channelNotes(p: Pattern, channelId: string): Note[] {
  return p.notes[channelId] ?? [];
}

/** Keep a note inside the pattern; null if nothing of it is left. */
function fit(n: Note, steps: number): Note | null {
  const start = Math.max(0, Math.round(n.start));
  const length = Math.min(Math.max(1, Math.round(n.length)), steps - start);
  if (start >= steps || length < 1) return null;
  const out: Note = {
    start,
    length,
    pitch: Math.max(0, Math.min(127, Math.round(n.pitch))),
    velocity: Math.max(0.05, Math.min(1, n.velocity)),
  };
  const glide = Math.round(Number(n.glide) || 0);
  if (glide > 0) out.glide = Math.min(MAX_GLIDE, glide);
  return out;
}

/**
 * The pitch a gliding note slides from: the closest-pitched note of the previous onset
 * (notes starting together count as one onset). The first onset of the pattern takes the
 * last one, as the pattern loops. With nothing else in the pattern, it scoops up a whole tone.
 */
export function glideFrom(notes: Note[], index: number): number {
  const n = notes[index];
  let prev = -Infinity;
  let last = -Infinity;
  for (const m of notes) {
    if (m.start < n.start && m.start > prev) prev = m.start;
    if (m.start !== n.start && m.start > last) last = m.start;
  }
  const at = prev > -Infinity ? prev : last;
  if (at === -Infinity) return n.pitch - 2;
  let best = notes.find((m) => m.start === at)!.pitch;
  for (const m of notes) if (m.start === at && Math.abs(m.pitch - n.pitch) < Math.abs(best - n.pitch)) best = m.pitch;
  return best;
}

/** Replace a channel's notes in a pattern (clipped to the pattern; its steps are cleared). */
export function setNotes(song: Song, patternId: string, channelId: string, notes: Note[]): Song {
  return {
    ...song,
    patterns: song.patterns.map((p) => {
      if (p.id !== patternId) return p;
      const list = notes.map((n) => fit(n, p.steps)).filter((n): n is Note => n !== null);
      const rows = { ...p.rows };
      delete rows[channelId];
      const all = { ...p.notes };
      if (list.length) all[channelId] = list;
      else delete all[channelId];
      return { ...p, rows, notes: all };
    }),
  };
}

/**
 * What the piano roll shows for a channel: its notes, or — if it only has steps — those
 * steps as notes at its root note. Nothing changes until you edit: then the steps are
 * replaced by the notes (setNotes clears the row).
 */
export function displayNotes(p: Pattern, ch: Pick<Channel, "id" | "rootNote">): Note[] {
  const own = channelNotes(p, ch.id);
  if (own.length) return own;
  return (p.rows[ch.id] ?? []).flatMap((v, i) => (v > 0 ? [{ start: i, length: 1, pitch: ch.rootNote, velocity: v }] : []));
}

/**
 * Switch a channel to the piano roll in a pattern: its steps become notes at the
 * channel's root note, one step long.
 */
export function stepsToNotes(song: Song, patternId: string, channelId: string): Song {
  const p = song.patterns.find((x) => x.id === patternId);
  const ch = song.channels.find((c) => c.id === channelId);
  const row = p?.rows[channelId];
  if (!p || !ch || !row || channelNotes(p, channelId).length) return song;
  const notes = row.flatMap((v, i) => (v > 0 ? [{ start: i, length: 1, pitch: ch.rootNote, velocity: v }] : []));
  return setNotes(song, patternId, channelId, notes);
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export function addTrack(song: Song, name: string): Song {
  const [s, id] = genId(song, "trk");
  return { ...s, tracks: [...s.tracks, { id, name, mute: false, solo: false }] };
}

/** Mute / solo several tracks at once (the timeline's "elegidas" bar). */
export function setTracksMix(song: Song, ids: Iterable<string>, patch: Partial<Pick<Track, "mute" | "solo">>): Song {
  const set = new Set(ids);
  return { ...song, tracks: song.tracks.map((t) => (set.has(t.id) ? { ...t, ...patch } : t)) };
}

/** Tracks that sound: solo wins over mute. */
export function audibleTracks(song: Song): Set<string> {
  const anySolo = song.tracks.some((t) => t.solo);
  return new Set(song.tracks.filter((t) => (anySolo ? t.solo : !t.mute)).map((t) => t.id));
}

export function renameTrack(song: Song, id: string, name: string): Song {
  return { ...song, tracks: song.tracks.map((t) => (t.id === id ? { ...t, name } : t)) };
}

/** Remove a track and everything on it. */
export function removeTrack(song: Song, id: string): Song {
  return { ...song, tracks: song.tracks.filter((t) => t.id !== id), clips: song.clips.filter((c) => c.trackId !== id) };
}

type Placement<K> = Omit<Extract<Clip, { kind: K }>, "id" | keyof ClipMix> & Partial<ClipMix>;
export type NewClip = Placement<"pattern"> | Placement<"audio">;

export function addClip(song: Song, clip: NewClip): Song {
  const [s, id] = genId(song, "clip");
  const c = {
    ...CLIP_MIX,
    ...clip,
    id,
    start: Math.max(0, Math.round(clip.start)),
    length: Math.max(1, Math.round(clip.length)),
  } as Clip;
  return { ...s, clips: [...s.clips, c] };
}

export function updateClip(
  song: Song,
  id: string,
  patch: Partial<Pick<Clip, "start" | "length" | "trackId"> & ClipMix>,
): Song {
  return {
    ...song,
    clips: song.clips.map((c) => {
      if (c.id !== id) return c;
      const length = Math.max(1, Math.round(patch.length ?? c.length));
      // Fades can't be longer than the clip, together.
      const fadeIn = Math.max(0, Math.min(length, Math.round(patch.fadeIn ?? c.fadeIn)));
      const fadeOut = Math.max(0, Math.min(length - fadeIn, Math.round(patch.fadeOut ?? c.fadeOut)));
      return {
        ...c,
        ...patch,
        start: Math.max(0, Math.round(patch.start ?? c.start)),
        length,
        fadeIn,
        fadeOut,
        gain: Math.max(0, Math.min(1.5, patch.gain ?? c.gain)),
      };
    }),
  };
}

/**
 * A clip's level at `pos` steps from its start: its gain shaped by linear fades.
 * Without fade-out the end isn't touched (sounds ring past the clip end, as usual).
 */
export function clipLevel(c: ClipMix & { length: number }, pos: number): number {
  let g = c.gain;
  if (c.fadeIn > 0) g *= Math.max(0, Math.min(1, pos / c.fadeIn));
  if (c.fadeOut > 0) g *= Math.max(0, Math.min(1, (c.length - pos) / c.fadeOut));
  return g;
}

/** True if the clip changes the sound at all (so the engine can skip the extra work). */
export function clipShapes(c: ClipMix): boolean {
  return c.gain !== 1 || c.fadeIn > 0 || c.fadeOut > 0;
}

export function removeClip(song: Song, id: string): Song {
  return { ...song, clips: song.clips.filter((c) => c.id !== id) };
}

/** Song length in steps: up to the end of the last clip, rounded up to a whole bar. */
export function songLength(song: Song): number {
  const end = Math.max(0, ...song.clips.map((c) => c.start + c.length));
  return Math.ceil(end / STEPS_PER_BAR) * STEPS_PER_BAR;
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export function stepSeconds(bpm: number): number {
  return 60 / bpm / STEPS_PER_BEAT;
}

/** Swing delay for a step: every second 16th is pushed late, up to 1/3 step (triplet). */
export function swingOffset(stepInPattern: number, swing: number, bpm: number): number {
  return stepInPattern % 2 === 1 ? (Math.max(0, Math.min(1, swing)) * stepSeconds(bpm)) / 3 : 0;
}

/** What's playing: song mode with an empty timeline plays the current pattern. */
export function effectiveMode(song: Song, mode: PlayMode): PlayMode {
  return mode === "song" && songLength(song) > 0 ? "song" : "pattern";
}

function currentPattern(song: Song): Pattern | undefined {
  return song.patterns.find((p) => p.id === song.currentPatternId) ?? song.patterns[0];
}

/**
 * Time-stretch factor for a channel's sound at the song tempo (1 = untouched).
 * A 90 BPM loop in a 120 BPM song plays at 0.75× its length.
 */
export function warpFactor(ch: Channel, bpm: number): number {
  return ch.warp.on && ch.warp.bpm > 0 && ch.sound.kind === "sample" ? ch.warp.bpm / bpm : 1;
}

/** Length in steps of a sound lasting `seconds` (at its own tempo if warped). */
export function stepsFor(ch: Channel, seconds: number, bpm: number): number {
  return Math.max(1, Math.round((seconds * warpFactor(ch, bpm)) / stepSeconds(bpm)));
}

/** Steps in one pass (the loop length). */
export function playLength(song: Song, mode: PlayMode): number {
  return effectiveMode(song, mode) === "song" ? songLength(song) : (currentPattern(song)?.steps ?? 0);
}

/** Channels that sound: solo wins over mute, like every DAW. */
export function audibleChannels(song: Song): Set<string> {
  const anySolo = song.channels.some((c) => c.solo);
  return new Set(song.channels.filter((c) => (anySolo ? c.solo : !c.mute)).map((c) => c.id));
}

export interface Hit {
  channelId: string;
  velocity: number;
  /** Seconds after the step's straight (unswung) time. */
  offset: number;
  /** MIDI note (a step plays the channel's root note). */
  note: number;
  /** Length in steps; 0 = one-shot (a step: the sound plays to its end). */
  length: number;
  /** Audio clip: played as-is and always cut at the clip end. */
  audio?: boolean;
  /** Audio clip resumed mid-way: steps already elapsed (start the sound that far in). */
  skip?: number;
  /** The clip it comes from, and how far into it (steps) this hit starts. Song mode only. */
  clip?: { mix: ClipMix & { length: number }; at: number };
  /** Pattern it comes from (its mix is used); absent for audio clips. */
  patternId?: string;
  /** Slide in: start at MIDI note `from` and reach `note` after `steps` steps. */
  glide?: { from: number; steps: number };
}

/** Where playback is: step in the song and, for each pattern sounding, its own step. */
export interface Position {
  songStep: number;
  patterns: Record<string, number>;
}

/**
 * Everything that starts at `step` (0 ≤ step < playLength) and where we are.
 * `resume`: playback starts here, so audio clips already under way are started mid-way.
 */
export function eventsAt(song: Song, mode: PlayMode, step: number, resume = false): { hits: Hit[]; pos: Position } {
  if (effectiveMode(song, mode) === "pattern") {
    const p = currentPattern(song);
    if (!p) return { hits: [], pos: { songStep: step, patterns: {} } };
    return { hits: hitsAt(song, p, step), pos: { songStep: step, patterns: { [p.id]: step } } };
  }
  const byId = new Map(song.patterns.map((p) => [p.id, p]));
  const chById = new Map(song.channels.map((c) => [c.id, c]));
  const hits: Hit[] = [];
  const patterns: Record<string, number> = {};
  const audible = audibleTracks(song);
  for (const c of song.clips) {
    if (step < c.start || step >= c.start + c.length) continue;
    const at = step - c.start;
    const clip = clipShapes(c) ? { mix: c, at } : undefined;
    const silent = c.muted || !audible.has(c.trackId);
    if (c.kind === "pattern") {
      const p = byId.get(c.patternId);
      if (!p) continue;
      const ps = at % p.steps; // a clip longer than its pattern repeats it
      patterns[p.id] = ps;
      if (silent) continue;
      for (const h of hitsAt(song, p, ps)) hits.push(clip ? { ...h, clip } : h);
    } else if ((at === 0 || resume) && !silent) {
      const ch = chById.get(c.channelId);
      if (!ch) continue;
      const h: Hit = { channelId: ch.id, velocity: 1, offset: 0, note: ch.rootNote, length: c.length - at, audio: true, skip: at };
      hits.push(clip ? { ...h, clip } : h);
    }
  }
  return { hits, pos: { songStep: step, patterns } };
}

/** Notes triggered at one step of a pattern. Mute/solo are applied by the mixer, not here. */
export function hitsAt(song: Song, pattern: Pattern, step: number): Hit[] {
  const offset = swingOffset(step, song.swing, song.bpm);
  const hits: Hit[] = [];
  for (const ch of song.channels) {
    const v = stepVelocity(pattern, ch.id, step);
    if (v > 0) hits.push({ channelId: ch.id, velocity: v, offset, note: ch.rootNote, length: 0, patternId: pattern.id });
    const list = pattern.notes[ch.id] ?? [];
    list.forEach((n, i) => {
      if (n.start !== step) return;
      const h: Hit = { channelId: ch.id, velocity: n.velocity, offset, note: n.pitch, length: n.length, patternId: pattern.id };
      if (n.glide) {
        const from = glideFrom(list, i);
        if (from !== n.pitch) h.glide = { from, steps: Math.min(n.glide, n.length) };
      }
      hits.push(h);
    });
  }
  return hits;
}

/** Every hit of one full pass, with absolute times (for export). */
export function allHits(song: Song, mode: PlayMode): (Hit & { time: number })[] {
  const dur = stepSeconds(song.bpm);
  const out: (Hit & { time: number })[] = [];
  const n = playLength(song, mode);
  for (let i = 0; i < n; i++) {
    for (const h of eventsAt(song, mode, i).hits) out.push({ ...h, time: i * dur + h.offset });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const clamp = (v: unknown, lo: number, hi: number, dflt: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;

const oneOf = <T extends string>(v: unknown, options: readonly T[], dflt: T): T =>
  options.includes(v as T) ? (v as T) : dflt;

/** A channel's effects, filled in and clamped (older songs get everything off). */
export function normalizeFx(raw: Partial<ChannelFx> | undefined): ChannelFx {
  const f = raw ?? {};
  return {
    low: clamp(f.low, -12, 12, 0),
    mid: clamp(f.mid, -12, 12, 0),
    high: clamp(f.high, -12, 12, 0),
    comp: clamp(f.comp, 0, 1, 0),
    reverb: clamp(f.reverb, 0, 1, 0),
    delay: clamp(f.delay, 0, 1, 0),
    drive: oneOf(f.drive, DRIVE_TYPES, "off"),
    driveAmount: clamp(f.driveAmount, 0, 1, NO_FX.driveAmount),
    filter: oneOf(f.filter, FILTER_TYPES, "off"),
    cutoff: clamp(f.cutoff, 0, 1, NO_FX.cutoff),
    resonance: clamp(f.resonance, 0, 1, NO_FX.resonance),
    move: clamp(f.move, 0, 1, 0),
    moveRate: MOVE_RATES.includes(f.moveRate as number) ? (f.moveRate as number) : NO_FX.moveRate,
    mod: oneOf(f.mod, MOD_TYPES, "off"),
    modAmount: clamp(f.modAmount, 0, 1, NO_FX.modAmount),
    width: clamp(f.width, 0, 2, 1),
    duckBy: typeof f.duckBy === "string" ? f.duckBy : null,
    duckAmount: clamp(f.duckAmount, 0, 1, NO_FX.duckAmount),
  };
}

/**
 * Make a loaded (possibly old or hand-edited) song safe to use: fill missing fields,
 * clamp ranges, drop dangling references. Returns null if it isn't a song at all.
 */
export function normalizeSong(raw: unknown): Song | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Song>;
  if (!Array.isArray(r.channels) || !Array.isArray(r.patterns) || r.patterns.length === 0) return null;
  const channels: Channel[] = r.channels
    .filter((c) => c && typeof c.id === "string" && normalizeSound(c.sound) !== null)
    .map((c) => ({
      id: c.id,
      name: String(c.name ?? ""),
      sound: normalizeSound(c.sound)!,
      volume: clamp(c.volume, 0, 1.25, 0.8),
      pan: clamp(c.pan, -1, 1, 0),
      pitch: Math.round(clamp(c.pitch, -24, 24, 0)),
      rootNote: Math.round(clamp(c.rootNote, 0, 127, 60)),
      gate: typeof c.gate === "boolean" ? c.gate : c.sound?.kind !== "builtin",
      warp: { on: !!c.warp?.on && clamp(c.warp?.bpm, 0, 400, 0) > 0, bpm: clamp(c.warp?.bpm, 0, 400, 0) },
      fx: normalizeFx(c.fx),
      mute: !!c.mute,
      solo: !!c.solo,
    }));
  const ids = new Set(channels.map((c) => c.id));
  const dropBadDuck = (fx: ChannelFx, own: string) => {
    if (fx.duckBy !== null && (fx.duckBy === own || !ids.has(fx.duckBy))) fx.duckBy = null;
  };
  for (const c of channels) dropBadDuck(c.fx, c.id);
  const patterns: Pattern[] = r.patterns
    .filter((p) => p && typeof p.id === "string")
    .map((p) => {
      const steps = Math.round(clamp(p.steps, 1, STEPS_PER_BAR * 8, STEPS_PER_BAR));
      const rows: Record<string, number[]> = {};
      for (const [ch, row] of Object.entries(p.rows ?? {})) {
        if (ids.has(ch) && Array.isArray(row)) rows[ch] = Array.from({ length: steps }, (_, i) => clamp(row[i], 0, 1, 0));
      }
      const notes: Record<string, Note[]> = {};
      for (const [ch, list] of Object.entries(p.notes ?? {})) {
        if (!ids.has(ch) || !Array.isArray(list)) continue;
        const ok = list
          .filter((n) => n && typeof n === "object")
          .map((n) =>
            fit(
              {
                start: clamp(n.start, 0, steps, 0),
                length: clamp(n.length, 1, steps, 1),
                pitch: clamp(n.pitch, 0, 127, 60),
                velocity: clamp(n.velocity, 0, 1, 0.8),
                glide: clamp(n.glide, 0, MAX_GLIDE, 0),
              },
              steps,
            ),
          )
          .filter((n): n is Note => n !== null);
        if (ok.length) notes[ch] = ok;
      }
      const mix: Record<string, ChannelMix> = {};
      if (p.mix && typeof p.mix === "object") {
        for (const [ch, m] of Object.entries(p.mix)) {
          if (!ids.has(ch) || !m || typeof m !== "object") continue;
          mix[ch] = { volume: clamp(m.volume, 0, 1.25, 0.8), pan: clamp(m.pan, -1, 1, 0), fx: normalizeFx(m.fx) };
          dropBadDuck(mix[ch].fx, ch);
        }
      } else {
        // v7 → v8: the mix lived on the channel. Every pattern starts with it, so old
        // songs sound exactly as before.
        for (const c of channels) mix[c.id] = { volume: c.volume, pan: c.pan, fx: { ...c.fx } };
      }
      return { id: p.id, name: String(p.name ?? ""), steps, rows, notes, mix };
    });
  if (!patterns.length) return null;
  const pids = new Set(patterns.map((p) => p.id));
  const legacy = raw as { arrangement?: unknown };

  let tracks: Track[] = Array.isArray(r.tracks)
    ? r.tracks
        .filter((t) => t && typeof t.id === "string")
        .map((t) => ({ id: t.id, name: String(t.name ?? ""), mute: !!t.mute, solo: !!t.solo }))
    : [];
  let clips: Clip[] = [];
  if (Array.isArray(r.clips)) {
    const tids = new Set(tracks.map((t) => t.id));
    clips = r.clips
      .filter(
        (c) =>
          c &&
          typeof c.id === "string" &&
          tids.has(c.trackId) &&
          (c.kind === "pattern" ? pids.has(c.patternId) : c.kind === "audio" && ids.has(c.channelId)),
      )
      .map((c) => {
        const length = Math.round(clamp(c.length, 1, 1e6, 16));
        const fadeIn = Math.round(clamp(c.fadeIn, 0, length, 0));
        return {
          ...c,
          start: Math.round(clamp(c.start, 0, 1e6, 0)),
          length,
          gain: clamp(c.gain, 0, 1.5, 1),
          fadeIn,
          fadeOut: Math.round(clamp(c.fadeOut, 0, length - fadeIn, 0)),
          muted: !!c.muted,
        };
      });
  }
  // v2 → v3: the pattern list becomes clips laid end to end on the first track.
  let migrated = 0;
  if (!tracks.length) {
    tracks = [1, 2, 3, 4].map((n) => ({ id: `trk-m${n}`, name: trackName(n), mute: false, solo: false }));
    if (Array.isArray(legacy.arrangement)) {
      let at = 0;
      for (const pid of legacy.arrangement) {
        const p = patterns.find((x) => x.id === pid);
        if (!p) continue;
        clips.push({ id: `clip-m${++migrated}`, trackId: tracks[0].id, start: at, length: p.steps, kind: "pattern", patternId: p.id, ...CLIP_MIX });
        at += p.steps;
      }
    }
  }
  return {
    version: SONG_VERSION,
    bpm: clamp(r.bpm, 20, 300, 120),
    swing: clamp(r.swing, 0, 1, 0),
    masterVolume: clamp(r.masterVolume, 0, 1.25, 0.8),
    channels,
    patterns,
    tracks,
    clips,
    fx: {
      delaySteps: Math.round(clamp(r.fx?.delaySteps, 1, 16, 3)),
      delayFeedback: clamp(r.fx?.delayFeedback, 0, 0.9, 0.35),
      delayPingPong: !!r.fx?.delayPingPong,
      reverbSize: oneOf(r.fx?.reverbSize, REVERB_SIZES, "hall"),
      limiter: typeof r.fx?.limiter === "boolean" ? r.fx.limiter : true,
    },
    currentPatternId: pids.has(r.currentPatternId ?? "") ? r.currentPatternId! : patterns[0].id,
    key: Math.round(clamp(r.key, 0, 11, 9)),
    scale: r.scale && r.scale in SCALES ? r.scale : "minor",
    nextId: Math.max(
      typeof r.nextId === "number" ? r.nextId : 1,
      // Never reuse an id even if nextId was lost.
      ...[...channels, ...patterns, ...tracks, ...clips].map((x) => Number(x.id.replace(/\D/g, "")) + 1 || 1),
    ),
  };
}
