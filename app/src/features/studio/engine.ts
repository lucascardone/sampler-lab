// Studio audio engine (Web Audio).
//
// Timing: notes are scheduled slightly ahead on the audio clock ("lookahead"), so they
// land sample-accurately no matter what the UI thread is doing. The scheduler is woken
// by a Web Worker timer, because Windows/Chromium throttle page timers when the window
// is hidden (and Sampler Lab lives in the tray) — worker timers keep running.
//
// Export renders the same graph (mixer.ts) in an OfflineAudioContext: what you hear is
// what you get.

import { convertFileSrc } from "@tauri-apps/api/core";
import i18n from "../../i18n";
import type { PackInfo } from "../../lib/api";
import { expandIncludes, joinInside, parseSfz, pickZone, zonesToLoad, type Zone } from "./sfz";
import { api } from "../../lib/api";
import { synthClick, synthDrum } from "./drums";
import { Mixer, REVERB_LENGTH } from "./mixer";
import { limit } from "./limiter";
import { synthNoteOn, synthRelease, synthVoice, type Glide } from "./synth";
import {
  allHits,
  audibleChannels,
  clipLevel,
  eventsAt,
  mixStrips,
  playLength,
  stepSeconds,
  warpFactor,
  STEPS_PER_BAR,
  STEPS_PER_BEAT,
  type Channel,
  type ClipMix,
  type PlayMode,
  type Position,
  type SoundRef,
  type Song,
} from "./song";
import { waitsForBar } from "../jam/hush";

const LOOKAHEAD = 0.12; // seconds scheduled ahead
const TICK_MS = 25;
const START_DELAY = 0.06;

export type SoundStatus = { state: "loading" } | { state: "ready" } | { state: "error"; message: string };

export type Playhead = Position;

const WORKER_SRC = `let id = null;
onmessage = (e) => {
  clearInterval(id);
  if (e.data > 0) id = setInterval(() => postMessage(0), e.data);
};`;

/** Play a buffer once (metronome). */
function click(ctx: BaseAudioContext, buffer: AudioBuffer, dest: AudioNode, when: number): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(dest);
  src.start(when);
  return src;
}

/** Release of a gated sample note: short, just enough to avoid a click. */
const GATE_RELEASE = 0.03;

/** A multi-sample instrument (SFZ) with the recordings it plays, loaded. */
export interface Instrument {
  zones: (Zone & { buffer: AudioBuffer })[];
}

/** What a channel plays: one recording, or an instrument (a recording per key range). */
type Source = AudioBuffer | Instrument;

const isInstrument = (s: Source | undefined): s is Instrument => !!s && "zones" in s;

/** Longest a source can sound (for export tails). */
const sourceSeconds = (s: Source | undefined) =>
  !s ? 0 : isInstrument(s) ? Math.max(0, ...s.zones.map((z) => z.buffer.duration)) : s.duration;

/**
 * The recording, playback rate and level for a note. Plain sounds are repitched from the
 * channel's root note; instruments use the zone made for that key, so they stay natural.
 */
function voiceFor(
  ch: Pick<Channel, "rootNote" | "pitch">,
  source: Source | undefined,
  note: number,
): { buffer: AudioBuffer; rate: number; gain: number; release: number } | null {
  if (!source) return null;
  if (!isInstrument(source)) return { buffer: source, rate: Math.pow(2, (note - ch.rootNote + ch.pitch) / 12), gain: 1, release: GATE_RELEASE };
  const z = pickZone(source.zones, note + ch.pitch);
  if (!z) return null;
  return {
    buffer: z.buffer,
    rate: Math.pow(2, (note + ch.pitch - z.root) / 12 + z.tuneCents / 1200),
    gain: Math.pow(10, z.gainDb / 20),
    release: Math.max(GATE_RELEASE, Math.min(2, z.release)),
  };
}

/** A clip's volume/fades, placed in time: when the clip starts and how long a step is. */
interface ClipEnv {
  mix: ClipMix & { length: number };
  start: number;
  step: number;
}

/**
 * A gain node that shapes everything through it with the clip's level over time. The
 * level is piecewise linear in time, so ramps between its breakpoints are exact.
 */
function clipEnvelope(ctx: BaseAudioContext, env: ClipEnv, dest: AudioNode, from: number): GainNode {
  const g = ctx.createGain();
  g.connect(dest);
  const at = (t: number) => clipLevel(env.mix, (t - env.start) / env.step);
  g.gain.setValueAtTime(at(from), from);
  const { length, fadeIn, fadeOut } = env.mix;
  const points = [fadeIn, length - fadeOut, length].map((s) => env.start + s * env.step).filter((t) => t > from);
  for (const t of [...new Set(points)].sort((a, b) => a - b)) g.gain.linearRampToValueAtTime(at(t), t);
  return g;
}

interface NoteOpts {
  /** Always cut at the end of `duration` (audio clips), whatever the channel's gate. */
  forceGate?: boolean;
  /** Start this many seconds into the sound (audio clip resumed mid-way). */
  skip?: number;
  /** Shape the note with its clip's volume and fades. */
  clip?: ClipEnv;
  /** Slide in from another note (piano-roll glide). */
  glide?: Glide;
}

/**
 * Play a note on a channel: synths generate it; samples and drums are repitched by the
 * distance to the channel's root note (sampler-style: higher = faster and shorter).
 * `duration` 0 = one-shot (the whole sound plays).
 */
function playNote(
  ctx: BaseAudioContext,
  ch: Pick<Channel, "sound" | "rootNote" | "pitch" | "gate">,
  source: Source | undefined,
  dest: AudioNode,
  when: number,
  velocity: number,
  note: number,
  duration: number,
  opts: NoteOpts = {},
): AudioScheduledSourceNode[] {
  if (opts.clip) dest = clipEnvelope(ctx, opts.clip, dest, when);
  if (ch.sound.kind === "synth") {
    const glide = opts.glide && { ...opts.glide, from: opts.glide.from + ch.pitch };
    return synthVoice(ctx, ch.sound.preset, dest, when, duration || 0.25, note + ch.pitch, velocity, glide);
  }
  const voice = voiceFor(ch, source, note);
  if (!voice) return [];
  const { buffer, rate, release } = voice;
  const level = velocity * voice.gain;
  const offset = (opts.skip ?? 0) * rate;
  if (offset >= buffer.duration) return [];
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  if (opts.glide && opts.glide.seconds > 0) {
    // Same recording, sped up/slowed down from the starting note to this one.
    src.playbackRate.setValueAtTime(rate * Math.pow(2, (opts.glide.from - note) / 12), when);
    src.playbackRate.exponentialRampToValueAtTime(rate, when + opts.glide.seconds);
  } else src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = level;
  src.connect(g).connect(dest);
  src.start(when, offset);
  if (duration > 0 && (ch.gate || opts.forceGate)) {
    const off = when + duration;
    g.gain.setValueAtTime(level, off);
    // Instruments fade with their own release (a piano note dies away, not a click).
    g.gain.setTargetAtTime(0, off, release / 4);
    src.stop(off + release + 0.005);
  }
  return [src];
}

const soundId = (s: SoundRef) =>
  s.kind === "builtin"
    ? `builtin:${s.id}`
    : s.kind === "synth"
      ? `synth:${s.preset}`
      : s.kind === "sample"
        ? `sample:${s.sessionId}/${s.sampleId}`
        : `${s.kind}:${s.packId}/${s.itemId}`;

/** "C:\…\packs\x" + "Kicks/k1.wav" (the folder part of an .sfz is kept for its samples). */
const joinPath = (dir: string, rel: string) => `${dir.replace(/[\\/]+$/, "")}/${rel}`;
const dirOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

/** Key of a sound at a time-stretch factor ("sample:s/x@0.7500"). */
const keyOf = (s: SoundRef, factor: number) => (factor === 1 ? soundId(s) : `${soundId(s)}@${factor.toFixed(4)}`);

export interface RenderOptions {
  /** Let the last sounds (and reverb/delay) ring out; otherwise exact bar length. */
  tail: boolean;
  /** Render only this channel (a stem): no limiter, so stems add up to the mix. */
  solo?: string;
  /** Force the length (seconds), so all stems line up. */
  seconds?: number;
}

export class StudioEngine {
  readonly ctx = new AudioContext({ latencyHint: "interactive" });
  private mixer = new Mixer(this.ctx, this.ctx.destination);
  /** Decoded audio by key (builtin id or rendered file path). */
  private buffers = new Map<string, AudioBuffer>();
  /** Loaded multi-sample instruments by sound key. */
  private instruments = new Map<string, Instrument>();
  /** Installed sound packs by id (where their files are). */
  private packs = new Map<string, PackInfo>();
  /** Sound id → buffer key currently used for it. */
  private resolved = new Map<string, string>();
  private pending = new Map<string, Promise<void>>();
  private soundStatus = new Map<string, SoundStatus>();
  /** Base sound id → the last key that loaded for it (plays while a new stretch renders). */
  private lastReady = new Map<string, string>();
  private live = new Map<number, (at: number) => void>();
  private liveIds = 0;
  /** Pitch params of sounding live notes (with their own detune), for the pitch wheel. */
  private livePitch = new Set<{ param: AudioParam; base: number }>();
  private bendCents = 0;
  /** Modulation wheel: one shared vibrato LFO, its depth (cents) set by the wheel. */
  private vibrato: GainNode | null = null;
  private clicks: [AudioBuffer, AudioBuffer];

  private song: Song | null = null;
  private mode: PlayMode = "pattern";
  metronome = false;

  /**
   * "Tocar juntos" guest: sounds live on the host PC. `remoteFile` copies a host file here
   * (returns the local path) and `remoteSample` asks the host for a library sample.
   * Null = this PC's own files (normal).
   */
  private remoteFile: ((path: string) => Promise<string>) | null = null;
  private remoteSample: ((sessionId: string, sampleId: string, stretch?: number) => Promise<{ path: string }>) | null = null;
  /**
   * Room clock: the song position (steps, fractional) that must be *heard* at a given
   * AudioContext time. While playing, the scheduler is nudged to follow it.
   */
  private follow: ((ctxTime: number) => number) | null = null;
  /** In a room: while playing, a new song version is heard from the next bar on. */
  private barSync = false;
  /** The newest song, waiting for the next bar (barSync). */
  private queued: Song | null = null;
  /** Channels kept quiet on this PC only (a friend's part, in a room). */
  private hushed = new Set<string>();

  private worker: Worker;
  private playing = false;
  private nextAbs = 0;
  private nextTime = 0;
  private resume = false;
  private queue: (Playhead & { time: number })[] = [];
  private lastHead: Playhead | null = null;
  private voices = new Set<AudioScheduledSourceNode>();
  private listeners = new Set<() => void>();

  constructor() {
    const mk = (data: Float32Array) => {
      const b = new AudioBuffer({ length: data.length, sampleRate: this.ctx.sampleRate, numberOfChannels: 1 });
      b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      return b;
    };
    this.clicks = [mk(synthClick(this.ctx.sampleRate, true)), mk(synthClick(this.ctx.sampleRate, false))];
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
    this.worker = new Worker(url);
    this.worker.onmessage = () => this.schedule();
  }

  // ---- state for the UI ----

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((f) => f());
  }
  isPlaying() {
    return this.playing;
  }
  status(sound: SoundRef): SoundStatus {
    return this.soundStatus.get(soundId(sound)) ?? { state: "loading" };
  }
  /** Status of a channel's sound as it plays in the song (stretched if warped). */
  channelStatus(ch: Channel): SoundStatus {
    const latest = this.queued ?? this.song;
    const f = latest ? warpFactor(ch, latest.bpm) : 1;
    const exact = this.soundStatus.get(keyOf(ch.sound, f));
    if (exact?.state === "ready" || exact?.state === "error") return exact;
    // A new stretch is rendering: the previous version keeps playing meanwhile.
    return this.lastReady.has(soundId(ch.sound)) ? { state: "ready" } : (exact ?? this.status(ch.sound));
  }
  /** Load a sound now (e.g. to know its length before placing it). */
  ensureSound(sound: SoundRef): Promise<void> {
    return this.loadSound(sound, false);
  }

  /** Length of a loaded sound in seconds (null while loading, or for synths). */
  soundSeconds(sound: SoundRef): number | null {
    const s = this.bufferFor(sound);
    return s ? sourceSeconds(s) : null;
  }

  /** The installed packs (sounds of packs that just appeared get loaded). */
  setPacks(packs: PackInfo[]) {
    this.packs = new Map(packs.map((p) => [p.id, p]));
    if (this.song) void this.loadSounds(this.song, false);
  }

  /** Sounds from another PC (a room's host), or back to this PC's own (`null`). */
  setRemoteSounds(
    remote: { file: (path: string) => Promise<string>; sample: (sessionId: string, sampleId: string, stretch?: number) => Promise<{ path: string }> } | null,
  ) {
    this.remoteFile = remote?.file ?? null;
    this.remoteSample = remote?.sample ?? null;
    // What was loaded belongs to the other machine: forget everything but generated sounds.
    for (const [id, key] of [...this.resolved]) {
      if (id.startsWith("builtin:") || id.startsWith("synth:")) continue;
      this.resolved.delete(id);
      this.instruments.delete(key);
      this.soundStatus.delete(id);
    }
    for (const k of [...this.buffers.keys()]) if (!k.startsWith("builtin:")) this.buffers.delete(k);
    this.lastReady.clear();
    if (this.song) void this.loadSounds(this.song, false);
  }

  /** A file to fetch: this PC's own, or a copy of the host's. */
  private async fileUrl(path: string): Promise<string> {
    return convertFileSrc(this.remoteFile ? await this.remoteFile(path) : path);
  }

  private async decodeFile(path: string): Promise<AudioBuffer> {
    const cached = this.buffers.get(path);
    if (cached) return cached;
    const data = await fetch(await this.fileUrl(path)).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    const b = await this.ctx.decodeAudioData(data);
    this.buffers.set(path, b);
    return b;
  }

  /** A pack sound or instrument: the file(s) from the installed pack. */
  private async loadPackSound(sound: Extract<SoundRef, { kind: "pack" | "instrument" }>, id: string) {
    const pack = this.packs.get(sound.packId);
    const item = pack?.items.find((i) => i.id === sound.itemId);
    if (!pack || !item) throw new Error(i18n.t("packs.missingSound", { pack: sound.packId }));
    if (sound.kind === "pack") {
      if (!item.file) throw new Error(i18n.t("packs.missingSound", { pack: pack.name }));
      const path = joinPath(pack.dir, item.file);
      await this.decodeFile(path);
      this.resolved.set(id, path);
      return;
    }
    if (!item.sfz) throw new Error(i18n.t("packs.missingSound", { pack: pack.name }));
    const readText = async (path: string) =>
      fetch(await this.fileUrl(path)).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      });
    // Samples are often in a sibling folder ("../Samples/x.wav"), but Tauri's file protocol
    // refuses any path with "..": resolve it here, and never leave the pack's folder.
    const sfzRel = item.sfz.replace(/\\/g, "/");
    const sfzDir = dirOf(sfzRel) === sfzRel ? "" : dirOf(sfzRel);
    const inPack = (rel: string) => {
      const p = joinInside(sfzDir, rel);
      if (p === null) throw new Error(i18n.t("packs.missingSound", { pack: pack.name }));
      return joinPath(pack.dir, p);
    };
    const text = await expandIncludes(await readText(inPack(sfzRel.split("/").pop()!)), (rel) => readText(inPack(rel)));
    const loaded = await Promise.allSettled(
      zonesToLoad(parseSfz(text)).map(async (z) => ({ ...z, buffer: await this.decodeFile(inPack(z.file)) })),
    );
    const zones = loaded.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (!zones.length) throw new Error(i18n.t("packs.emptyInstrument", { name: item.name }));
    this.instruments.set(id, { zones });
    this.resolved.set(id, id);
  }

  // ---- song & sounds ----

  /** Give the engine the latest song (cheap: called on every edit). */
  setSong(song: Song, mode: PlayMode) {
    this.mode = mode;
    if (this.barSync && this.playing && this.song && this.song !== song && waitsForBar(this.song, song)) {
      // Heard from the next bar on (see `schedule`). Sounds load now so they're ready;
      // levels and FX follow at once, but who sounds stays as it is until the bar.
      this.queued = song;
      this.mixer.sync(song, this.audible(this.song), true);
    } else {
      this.queued = null;
      this.song = song;
      this.mixer.sync(song, this.audible(song), true);
    }
    this.loadSounds(song, false);
  }

  /**
   * Make sure every channel's audio is loaded. With `refresh`, library samples are
   * asked for again (the core returns a new file if the sample was edited).
   */
  loadSounds(song: Song, refresh: boolean): Promise<void> {
    const jobs = song.channels.map((ch) => {
      const f = warpFactor(ch, song.bpm);
      // Also the plain version: previews and the clip length need it.
      return Promise.all([this.loadSound(ch.sound, refresh), f !== 1 ? this.loadSound(ch.sound, refresh, f) : null]);
    });
    return Promise.all(jobs).then(() => {});
  }

  private loadSound(sound: SoundRef, refresh: boolean, factor = 1): Promise<void> {
    const id = keyOf(sound, factor);
    if (this.pending.has(id)) return this.pending.get(id)!;
    if (!refresh && this.resolved.has(id)) return Promise.resolve();
    const job = (async () => {
      if (!this.resolved.has(id)) this.setStatus(id, { state: "loading" });
      try {
        if (sound.kind === "synth") {
          this.resolved.set(id, id); // generated live, nothing to load
        } else if (sound.kind === "builtin") {
          const data = synthDrum(sound.id, this.ctx.sampleRate);
          const b = new AudioBuffer({ length: data.length, sampleRate: this.ctx.sampleRate, numberOfChannels: 1 });
          b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
          this.buffers.set(id, b);
          this.resolved.set(id, id);
        } else if (sound.kind === "pack" || sound.kind === "instrument") {
          await this.loadPackSound(sound, id);
        } else {
          const stretch = factor === 1 ? undefined : factor;
          const { path } = this.remoteSample
            ? await this.remoteSample(sound.sessionId, sound.sampleId, stretch)
            : await api.librarySampleAudio(sound.sessionId, sound.sampleId, stretch);
          if (!this.buffers.has(path)) {
            const data = await fetch(await this.fileUrl(path)).then((r) => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r.arrayBuffer();
            });
            this.buffers.set(path, await this.ctx.decodeAudioData(data));
          }
          const old = this.resolved.get(id);
          this.resolved.set(id, path);
          if (old && old !== path && ![...this.resolved.values()].includes(old)) this.buffers.delete(old);
        }
        this.lastReady.set(soundId(sound), id);
        this.setStatus(id, { state: "ready" });
      } catch (e) {
        this.resolved.delete(id);
        this.setStatus(id, { state: "error", message: String(e) });
      } finally {
        this.pending.delete(id);
      }
    })();
    this.pending.set(id, job);
    return job;
  }

  private setStatus(id: string, s: SoundStatus) {
    this.soundStatus.set(id, s);
    this.emit();
  }

  private bufferFor(sound: SoundRef, factor = 1): Source | undefined {
    const key = this.resolved.get(keyOf(sound, factor));
    return key ? (this.instruments.get(key) ?? this.buffers.get(key)) : undefined;
  }

  /** What a channel plays: its stretched version if warped (or the last one ready). */
  private bufferForCh(ch: Channel, bpm: number): Source | undefined {
    const f = warpFactor(ch, bpm);
    const exact = this.bufferFor(ch.sound, f);
    if (exact || f === 1) return exact;
    const last = this.lastReady.get(soundId(ch.sound));
    const key = last ? this.resolved.get(last) : undefined;
    return key ? this.buffers.get(key) : undefined;
  }

  /** How long sounds can keep ringing after the last bar (for the export tail). */
  private tailSeconds(song: Song): number {
    const sounds = song.channels.map((c) =>
      c.sound.kind === "synth"
        ? synthRelease(c.sound.preset)
        : // Lowest note used makes the slowest (longest) playback.
          sourceSeconds(this.bufferForCh(c, song.bpm)) / Math.pow(2, (lowestNote(song, c) - c.rootNote + c.pitch) / 12),
    );
    const sends = mixStrips(song).some(({ mix }) => mix.fx.reverb > 0 || mix.fx.delay > 0);
    return Math.max(0, ...sounds) + (sends ? REVERB_LENGTH[song.fx.reverbSize] + 1 : 0) + 0.1;
  }

  // ---- transport ----

  /** Start playing from `fromStep` (song mode: a position on the timeline). */
  async play(fromStep = 0) {
    this.takeQueued();
    if (this.playing || !this.song) return;
    await this.ctx.resume();
    this.playing = true;
    this.nextAbs = Math.max(0, fromStep);
    this.resume = fromStep > 0;
    this.nextTime = this.ctx.currentTime + START_DELAY;
    this.queue = [];
    this.lastHead = null;
    this.schedule();
    this.worker.postMessage(TICK_MS);
    this.emit();
  }

  /**
   * Room playback: song step `fromStep` is heard at context time `at` (which may already
   * have passed: then we join in the middle, on the right step). `follow` keeps us there.
   */
  async playAt(at: number, fromStep: number, follow: (ctxTime: number) => number) {
    this.takeQueued();
    if (!this.song) return;
    await this.ctx.resume();
    if (this.playing) this.stop();
    const dur = stepSeconds(this.song.bpm);
    const earliest = this.ctx.currentTime + START_DELAY;
    const late = at < earliest ? Math.ceil((earliest - at) / dur) : 0;
    this.playing = true;
    this.follow = follow;
    this.nextAbs = Math.max(0, Math.round(fromStep) + late);
    this.resume = this.nextAbs > 0;
    this.nextTime = at + late * dur;
    this.queue = [];
    this.lastHead = null;
    this.schedule();
    this.worker.postMessage(TICK_MS);
    this.emit();
  }

  /** Room: edits wait for the next bar while playing (on), or sound at once (off). */
  setBarSync(on: boolean) {
    this.barSync = on;
    if (!on) this.takeQueued();
  }

  /** Channels to keep quiet on this PC only (empty = hear everything). */
  setHushed(ids: Set<string>) {
    const same = ids.size === this.hushed.size && [...ids].every((id) => this.hushed.has(id));
    if (same) return;
    this.hushed = ids;
    if (this.song) this.mixer.sync(this.song, this.audible(this.song), true);
  }

  private audible(song: Song): Set<string> {
    const out = audibleChannels(song);
    for (const id of this.hushed) out.delete(id);
    return out;
  }

  /** Switch to the waiting song version now. */
  private takeQueued() {
    if (!this.queued) return;
    this.song = this.queued;
    this.queued = null;
    this.mixer.sync(this.song, this.audible(this.song), true);
  }

  /** Change how the room clock is followed (a new tempo, a new speaker delay). */
  setFollow(follow: ((ctxTime: number) => number) | null) {
    this.follow = follow;
  }

  /** An AudioContext time and when it is heard (for the room clock). */
  outputStamp(): { contextTime: number; performanceTime: number } {
    const s = this.ctx.getOutputTimestamp?.();
    if (s && s.contextTime !== undefined && s.performanceTime !== undefined && s.performanceTime > 0) {
      return { contextTime: s.contextTime, performanceTime: s.performanceTime };
    }
    return { contextTime: this.ctx.currentTime + (this.ctx.outputLatency || 0), performanceTime: performance.now() };
  }

  stop() {
    this.follow = null;
    this.takeQueued();
    if (!this.playing) return;
    this.playing = false;
    this.worker.postMessage(0);
    const t = this.ctx.currentTime;
    for (const v of this.voices) {
      try {
        v.stop(t + 0.005);
      } catch {
        /* already stopped */
      }
    }
    this.voices.clear();
    this.queue = [];
    this.lastHead = null;
    this.emit();
  }

  /** Audition a sound right now (library click). */
  async preview(sound: SoundRef, pitch = 0) {
    await this.previewNote({ sound, rootNote: 60, pitch, gate: false }, 60, 0.5);
  }

  /** Audition a note on a channel (piano roll keys and new notes). */
  async previewNote(ch: Pick<Channel, "sound" | "rootNote" | "pitch" | "gate">, note: number, seconds = 0.35) {
    await this.ctx.resume();
    await this.loadSound(ch.sound, false);
    const b = this.bufferFor(ch.sound);
    const dur = ch.sound.kind === "synth" || ch.gate ? seconds : 0;
    playNote(this.ctx, ch, b, this.mixer.master, this.ctx.currentTime, 0.9, note, dur).forEach((v) => this.track(v));
  }

  // ---- live playing (MIDI / computer keyboard) ----

  /** Start a held note on a channel (through its effects). Returns an id for `noteOff`. */
  noteOn(ch: Channel, note: number, velocity: number): number {
    void this.ctx.resume();
    const id = ++this.liveIds;
    // Live notes go through the channel's mix in the pattern being edited.
    const dest = this.mixer.input(ch.id, this.song?.currentPatternId) ?? this.mixer.master;
    const now = this.ctx.currentTime;
    if (ch.sound.kind === "synth") {
      const v = synthNoteOn(this.ctx, ch.sound.preset, dest, now, note + ch.pitch, velocity);
      v.oscs.forEach((o) => this.wheels(o, o.detune));
      this.live.set(id, v.release);
      return id;
    }
    const voice = voiceFor(ch, this.song ? this.bufferForCh(ch, this.song.bpm) : this.bufferFor(ch.sound), note);
    if (!voice) return id;
    const level = velocity * voice.gain;
    const src = this.ctx.createBufferSource();
    src.buffer = voice.buffer;
    src.playbackRate.value = voice.rate;
    const g = this.ctx.createGain();
    g.gain.value = level;
    src.connect(g).connect(dest);
    this.wheels(src, src.detune);
    src.start(now);
    // Gated channels stop when the key is released; one-shots (drums) ring out.
    this.live.set(id, (at) => {
      if (!ch.gate) return;
      g.gain.setValueAtTime(level, at);
      g.gain.setTargetAtTime(0, at, voice.release / 4);
      src.stop(at + voice.release + 0.005);
    });
    return id;
  }

  /** Pitch wheel, -1..1 → ±2 semitones on the notes being played live. */
  setBend(value: number) {
    this.bendCents = Math.max(-1, Math.min(1, value)) * 200;
    const now = this.ctx.currentTime;
    for (const p of this.livePitch) p.param.setTargetAtTime(p.base + this.bendCents, now, 0.008);
  }

  /** Modulation wheel, 0..1 → vibrato on the notes being played live (up to ±40 cents). */
  setModulation(value: number) {
    const depth = Math.max(0, Math.min(1, value)) * 40;
    if (!this.vibrato && depth === 0) return;
    this.vibratoNode().gain.setTargetAtTime(depth, this.ctx.currentTime, 0.02);
  }

  private vibratoNode(): GainNode {
    if (!this.vibrato) {
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 5.5;
      this.vibrato = this.ctx.createGain();
      this.vibrato.gain.value = 0;
      lfo.connect(this.vibrato);
      lfo.start();
      // Notes already held get it too.
      for (const p of this.livePitch) this.vibrato.connect(p.param);
    }
    return this.vibrato;
  }

  /** Hook a live voice's pitch to the wheels until it ends. */
  private wheels(src: AudioScheduledSourceNode, param: AudioParam) {
    const p = { param, base: param.value };
    param.value = p.base + this.bendCents;
    this.livePitch.add(p);
    this.vibrato?.connect(param);
    src.addEventListener("ended", () => {
      this.livePitch.delete(p);
      try {
        this.vibrato?.disconnect(param);
      } catch {
        /* already gone */
      }
    });
  }

  noteOff(id: number) {
    this.live.get(id)?.(this.ctx.currentTime);
    this.live.delete(id);
  }

  /**
   * Where playback is inside a pattern right now, in (fractional) steps, as heard
   * (output latency included). Null if that pattern isn't playing. For recording.
   */
  positionIn(patternId: string): number | null {
    if (!this.playing || !this.song) return null;
    this.playhead();
    const h = this.lastHead as (Playhead & { time?: number }) | null;
    const step = h?.patterns[patternId];
    if (!h || step === undefined || h.time === undefined) return null;
    const now = this.ctx.currentTime - (this.ctx.outputLatency || 0);
    return step + (now - h.time) / stepSeconds(this.song.bpm);
  }

  private track(v: AudioScheduledSourceNode) {
    this.voices.add(v);
    v.onended = () => this.voices.delete(v);
  }

  private schedule() {
    let song = this.song;
    if (!this.playing || !song) return;
    let total = playLength(song, this.mode);
    if (!total) return;
    let chById = new Map(song.channels.map((c) => [c.id, c]));
    const dur = stepSeconds(song.bpm);
    // In a room: stay on the room's clock. Small differences are nudged a couple of ms
    // per tick (inaudible); a big one (a new tempo, a hiccup) re-aligns at once.
    if (this.follow) {
      const behind = (this.follow(this.nextTime) - this.nextAbs) * dur;
      if (Math.abs(behind) > 0.08) {
        const t = this.ctx.currentTime + START_DELAY;
        const abs = Math.ceil(this.follow(t));
        this.nextAbs = Math.max(0, abs);
        this.nextTime = t + (abs - this.follow(t)) * dur;
      } else {
        this.nextTime -= Math.max(-0.002, Math.min(0.002, behind));
      }
    }
    // If the UI thread stalled, don't fire a burst of late notes: skip ahead.
    if (this.nextTime < this.ctx.currentTime - 0.05) {
      const behind = Math.ceil((this.ctx.currentTime - this.nextTime) / dur);
      this.nextAbs += behind;
      this.nextTime += behind * dur;
    }
    while (this.nextTime < this.ctx.currentTime + LOOKAHEAD) {
      // Room: the waiting song version starts with a bar (or the loop's start).
      if (this.queued && (this.nextAbs % total) % STEPS_PER_BAR === 0) {
        this.takeQueued();
        song = this.song!;
        total = playLength(song, this.mode);
        if (!total) return;
        chById = new Map(song.channels.map((c) => [c.id, c]));
      }
      const step = this.nextAbs % total;
      const { hits, pos } = eventsAt(song, this.mode, step, this.resume);
      const stepTime = this.nextTime;
      this.resume = false;
      for (const hit of hits) {
        const ch = chById.get(hit.channelId)!;
        this.mixer.duck(ch.id, this.nextTime + hit.offset);
        const input = this.mixer.input(ch.id, hit.patternId);
        if (!input) continue;
        playNote(this.ctx, ch, this.bufferForCh(ch, song.bpm), input, this.nextTime + hit.offset, hit.velocity, hit.note, hit.length * dur, {
          forceGate: hit.audio,
          skip: (hit.skip ?? 0) * dur,
          clip: hit.clip && { mix: hit.clip.mix, start: stepTime - hit.clip.at * dur, step: dur },
          glide: hit.glide && { from: hit.glide.from, seconds: hit.glide.steps * dur },
        }).forEach((v) => this.track(v));
      }
      if (this.metronome && step % STEPS_PER_BEAT === 0) {
        this.track(click(this.ctx, this.clicks[step % STEPS_PER_BAR === 0 ? 0 : 1], this.ctx.destination, this.nextTime));
      }
      this.queue.push({ ...pos, time: this.nextTime });
      this.nextAbs++;
      this.nextTime += dur;
    }
  }

  /** The step sounding right now (null when stopped). Call from requestAnimationFrame. */
  playhead(): Playhead | null {
    if (!this.playing) return null;
    const now = this.ctx.currentTime - (this.ctx.outputLatency || 0);
    let cur: (typeof this.queue)[number] | null = null;
    while (this.queue.length && this.queue[0].time <= now) cur = this.queue.shift()!;
    if (cur) this.lastHead = cur;
    return this.lastHead;
  }

  // ---- export ----

  /** Seconds a render will last (so stems can share one length). */
  renderSeconds(song: Song, mode: PlayMode, tail: boolean): number {
    return playLength(song, mode) * stepSeconds(song.bpm) + (tail ? this.tailSeconds(song) : 0);
  }

  /** Render one pass of the song (or the current pattern) offline. */
  async render(song: Song, mode: PlayMode, o: RenderOptions): Promise<AudioBuffer> {
    await this.loadSounds(song, true);
    const sr = this.ctx.sampleRate;
    const length = playLength(song, mode) * stepSeconds(song.bpm);
    const total = o.seconds ?? this.renderSeconds(song, mode, o.tail);
    const off = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * sr)), sr);
    const mixer = new Mixer(off, off.destination);
    const audible = o.solo ? new Set([o.solo]) : audibleChannels(song);
    mixer.sync(song, audible, false, o.solo ? false : song.fx.limiter);
    const chById = new Map(song.channels.map((c) => [c.id, c]));
    const dur = stepSeconds(song.bpm);
    for (const hit of allHits(song, mode)) {
      // Ducking follows every hit, even in a stem where the trigger itself isn't rendered.
      mixer.duck(hit.channelId, hit.time);
      if (o.solo && hit.channelId !== o.solo) continue;
      const ch = chById.get(hit.channelId)!;
      const stepTime = hit.time - hit.offset;
      playNote(off, ch, this.bufferForCh(ch, song.bpm), mixer.input(ch.id, hit.patternId)!, hit.time, hit.velocity, hit.note, hit.length * dur, {
        forceGate: hit.audio,
        clip: hit.clip && { mix: hit.clip.mix, start: stepTime - hit.clip.at * dur, step: dur },
        glide: hit.glide && { from: hit.glide.from, seconds: hit.glide.steps * dur },
      });
    }
    const out = await off.startRendering();
    // The live limiter (a Web Audio compressor) can let fast transients through; the
    // export gets a true look-ahead limiter so the file never clips.
    if (!o.solo && song.fx.limiter) {
      limit(Array.from({ length: out.numberOfChannels }, (_, i) => out.getChannelData(i)), sr);
    }
    return o.tail && o.seconds === undefined ? trimSilence(out, Math.ceil(length * sr)) : out;
  }

  /** Channels that actually play something in this render (for stems). */
  usedChannels(song: Song, mode: PlayMode): Channel[] {
    const used = new Set(allHits(song, mode).map((h) => h.channelId));
    const audible = audibleChannels(song);
    return song.channels.filter((c) => used.has(c.id) && audible.has(c.id));
  }
}

function lowestNote(song: Song, ch: Channel): number {
  let low = ch.rootNote;
  for (const p of song.patterns) for (const n of p.notes[ch.id] ?? []) low = Math.min(low, n.pitch);
  return low;
}

/** Cut trailing silence, keeping at least `minFrames`. */
function trimSilence(b: AudioBuffer, minFrames: number): AudioBuffer {
  const chans = Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));
  let end = b.length;
  while (end > minFrames && chans.every((c) => Math.abs(c[end - 1]) < 1e-4)) end--;
  if (end === b.length) return b;
  const out = new AudioBuffer({ length: Math.max(1, end), sampleRate: b.sampleRate, numberOfChannels: b.numberOfChannels });
  chans.forEach((c, i) => out.copyToChannel(c.subarray(0, end), i));
  return out;
}

let instance: StudioEngine | null = null;
/** One engine for the whole app (it keeps playing while you switch tabs). */
export function studioEngine(): StudioEngine {
  return (instance ??= new StudioEngine());
}
