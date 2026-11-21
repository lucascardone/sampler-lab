// "Tocar juntos": the room, as seen from this PC. One instance for the app (like the
// audio engine). React reads it through `useJam()` (useJam.ts).
//
// The host's song is the truth. Each edit travels as ops (ops.ts):
// - host: applies its own and its guests' edits, numbers them (`rev`) and sends them to
//   every guest;
// - guest: shows its own edits right away (pending) and sends them; when the host's
//   numbered list comes back, it rebuilds "host song + my edits not confirmed yet".
// Play / stop / tempo / which pattern sounds is one shared Transport (clock.ts), decided
// by the host. Network: src-tauri/src/jam.rs (events `jam-host` / `jam-guest`).

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import i18n from "../../i18n";
import { api, type JamRoomFound } from "../../lib/api";
import { normalizeSong, setIdSuffix, type PlayMode, type Song } from "../studio/song";
import { ClockSync, isTransport, retempo, startAt, stopAt, STOPPED, wallNow, type Transport } from "./clock";
import { NO_HUSH, type Hush } from "./hush";
import { applyOps, diffSong, isOps, touched, type Op } from "./ops";

export type Role = "off" | "host" | "guest";

/** One person in the room (the host is id 0). */
export interface Peer {
  id: number;
  name: string;
  color: string;
  /** Letter(s) added to the ids this person creates. */
  suffix: string;
  /** Pattern they are looking at. */
  patternId?: string;
}

/** What someone touched last, for the colored dots. */
export interface Focus {
  channels: string[];
  patterns: string[];
  at: number;
}

export interface JamState {
  role: Role;
  /** Guest: joined, waiting for the song. */
  joining: boolean;
  roomName: string;
  /** Host: code and address to tell friends. */
  code: string;
  address: string;
  /** Host: this PC's Tailscale address, for friends at home ("" if off). */
  vpnAddress: string;
  /** Host: the invite for friends at other homes ("" until asked for). */
  invite: string;
  me: number;
  peers: Peer[];
  transport: Transport;
  focus: Record<number, Focus>;
  /** Changes when the room's sounds change (a guest brought one). */
  packsVersion: number;
  /** Guest: the connection broke (room name, to offer reconnecting). */
  lost: string | null;
  /** This PC's speaker delay (ms), for Bluetooth speakers. */
  delayMs: number;
  /** Whose part this PC doesn't hear (personal, never sent). */
  hush: Hush;
}

/** How the room reaches the song store (useSong registers one). */
export interface SongLink {
  current(): Song | null;
  /** A song that came from the room: no undo step; saved only when this PC is the host. */
  fromRoom(song: Song, save: boolean): void;
  /** Save the user's own song right now (before a guest replaces it with the room's). */
  saveNow(): Promise<void>;
  /** Back to the user's own song (leaving a room as a guest). */
  reloadOwn(): Promise<void>;
  clearHistory(): void;
}

export type TransportRequest = { playing: boolean; mode: PlayMode; patternId: string; fromStep: number };

/** Person colors (host first). Distinct from each other on the dark theme. */
export const PEOPLE = ["#ffc061", "#73b7ff", "#f48fc6", "#5fd4c4", "#c4e06a", "#b39dff", "#ff8a7a", "#e6c48f"];

/** Id letters for a guest: 1 → "b", 2 → "c" … 25 → "z", 26 → "bb"… (host = ""). */
export function suffixFor(peer: number): string {
  if (peer <= 0) return "";
  let n = peer;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(98 + ((n - 1) % 25)) + out; // b..z
    n = Math.floor((n - 1) / 25);
  }
  return out;
}

const DELAY_KEY = "sampler-lab.jam.delay";
const NAME_KEY = "sampler-lab.jam.name";

function readNumber(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

export function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode */
  }
}

type Msg = Record<string, unknown> & { t?: string };

export class JamRoom {
  private s: JamState = {
    role: "off",
    joining: false,
    roomName: "",
    code: "",
    address: "",
    vpnAddress: "",
    invite: "",
    me: 0,
    peers: [],
    transport: STOPPED,
    focus: {},
    packsVersion: 0,
    lost: null,
    delayMs: readNumber(DELAY_KEY),
    hush: NO_HUSH,
  };
  private listeners = new Set<() => void>();
  private link: SongLink | null = null;
  private unlisten: UnlistenFn | null = null;
  private notifyFn: (text: string, error?: boolean) => void = () => {};
  readonly clock = new ClockSync();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  // host
  private rev = 0;
  /** Someone who comes back with the same name keeps their letters and color. */
  private known = new Map<string, { suffix: string; color: string }>();
  // guest
  private confirmed: Song | null = null;
  private pending: { seq: number; ops: Op[] }[] = [];
  private seq = 0;
  private lastJoin: { address: string; code: string; name: string } | null = null;
  /** The end of the connection is expected (we left, or the host said it closed). */
  private quietEnd = false;

  // ---- state for React ----

  get = () => this.s;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  private set(patch: Partial<JamState>) {
    this.s = { ...this.s, ...patch };
    this.listeners.forEach((f) => f());
  }

  attach(link: SongLink | null) {
    this.link = link;
  }
  onNotice(fn: (text: string, error?: boolean) => void) {
    this.notifyFn = fn;
  }
  private notify(key: string, opts: Record<string, unknown> = {}, error = false) {
    this.notifyFn(i18n.t(key, opts), error);
  }

  get role() {
    return this.s.role;
  }
  /** Host time now (the room's clock). */
  hostNow(): number {
    return wallNow() + (this.s.role === "guest" ? this.clock.offset : 0);
  }
  get clockOffset(): number {
    return this.s.role === "guest" ? this.clock.offset : 0;
  }

  setDelay(ms: number) {
    const delayMs = Math.max(0, Math.min(500, Math.round(ms)));
    try {
      localStorage.setItem(DELAY_KEY, String(delayMs));
    } catch {
      /* private mode */
    }
    this.set({ delayMs });
  }

  /** Host: open the room to friends at other homes (internet). Returns the invite. */
  async inviteFromHome(): Promise<string> {
    if (this.s.role !== "host") return "";
    const invite = await api.jamHostInternet();
    if (this.s.role === "host") this.set({ invite });
    return invite;
  }

  /** My id letters (whose channels are "mine"). */
  get mine(): string {
    return this.s.peers.find((p) => p.id === this.s.me)?.suffix ?? "";
  }

  /** Hear (or not) one person's part, on this PC only. */
  hushPerson(suffix: string, quiet: boolean) {
    const people = this.s.hush.people.filter((x) => x !== suffix);
    this.set({ hush: { onlyMine: false, people: quiet ? [...people, suffix] : people } });
  }

  /** Hear only my own part on this PC (or everyone again). */
  setOnlyMine(on: boolean) {
    this.set({ hush: { onlyMine: on, people: [] } });
  }

  /** Name of a pattern of the current song ("" if gone). */
  patternName(id: string): string {
    return this.link?.current()?.patterns.find((p) => p.id === id)?.name ?? "";
  }

  peerName(id: number): string {
    return this.s.peers.find((p) => p.id === id)?.name ?? "";
  }

  // ---- edits from this PC (called by useSong) ----

  /** The user changed the song from `prev` to `next`. */
  localEdit(prev: Song, next: Song) {
    if (this.s.role === "off" || this.s.joining) return;
    const ops = diffSong(prev, next);
    if (!ops.length) return;
    if (this.s.role === "host") {
      this.rev++;
      this.broadcast({ t: "ops", rev: this.rev, peer: 0, ops });
      this.afterSongChange(next);
    } else {
      this.seq++;
      this.pending.push({ seq: this.seq, ops });
      api.jamGuestSend({ t: "ops", seq: this.seq, ops }).catch(() => {});
    }
  }

  /** The pattern this PC is looking at (shown to the others). */
  view(patternId: string) {
    if (this.s.role === "host") {
      this.setPeer(0, { patternId });
      this.broadcast({ t: "peers", peers: this.s.peers });
    } else if (this.s.role === "guest" && !this.s.joining) {
      api.jamGuestSend({ t: "view", patternId }).catch(() => {});
    }
  }

  /** Play / stop / pattern or song mode, for everybody. */
  requestTransport(req: TransportRequest) {
    if (this.s.role === "host") this.applyTransport(req);
    else if (this.s.role === "guest") api.jamGuestSend({ t: "transport", ...req }).catch(() => {});
  }

  // ---- host ----

  async open(name: string) {
    saveName(name);
    await this.listenTo("jam-host", (p) => this.onHostEvent(p as Msg));
    let info;
    try {
      info = await api.jamHostStart(name);
    } catch (e) {
      this.stopListening();
      throw e;
    }
    const song = this.link?.current();
    setIdSuffix("");
    this.rev = 0;
    this.known.clear();
    this.set({
      role: "host",
      joining: false,
      lost: null,
      roomName: info.name,
      code: info.code,
      address: info.address,
      vpnAddress: info.vpnAddress ?? "",
      invite: "",
      me: 0,
      peers: [{ id: 0, name: info.name, color: PEOPLE[0], suffix: "", patternId: song?.currentPatternId }],
      transport: { ...STOPPED, bpm: song?.bpm ?? 120, patternId: song?.currentPatternId ?? "" },
      focus: {},
      hush: NO_HUSH,
    });
  }

  private broadcast(msg: Msg, to: number | null = null) {
    api.jamHostSend(to, msg).catch(() => {});
  }

  private setPeer(id: number, patch: Partial<Peer>) {
    this.set({ peers: this.s.peers.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  }

  private onHostEvent(e: Msg) {
    if (this.s.role !== "host") return;
    const peer = Number(e.peer);
    switch (e.kind) {
      case "join": {
        const name = String(e.name ?? "");
        // Back with the same name (reconnected): same letters, so their channels stay theirs.
        const back = this.known.get(name);
        const reuse = back && !this.s.peers.some((x) => x.suffix === back.suffix);
        const p: Peer = reuse ? { id: peer, name, ...back } : { id: peer, name, color: PEOPLE[peer % PEOPLE.length], suffix: suffixFor(peer) };
        if (name && !reuse) this.known.set(name, { suffix: p.suffix, color: p.color });
        this.set({ peers: [...this.s.peers.filter((x) => x.id !== peer), p] });
        this.broadcast(
          { t: "welcome", you: p, room: { name: this.s.roomName }, rev: this.rev, song: this.link?.current(), transport: this.s.transport, peers: this.s.peers },
          peer,
        );
        this.broadcast({ t: "peers", peers: this.s.peers });
        this.notify("jam.joined", { name: p.name });
        break;
      }
      case "leave": {
        const name = this.peerName(peer);
        const focus = { ...this.s.focus };
        delete focus[peer];
        this.set({ peers: this.s.peers.filter((x) => x.id !== peer), focus });
        this.broadcast({ t: "peers", peers: this.s.peers });
        if (name) this.notify("jam.left", { name });
        break;
      }
      case "upload":
        this.set({ packsVersion: this.s.packsVersion + 1 });
        this.broadcast({ t: "packs" });
        this.notify("jam.uploaded", { name: this.peerName(peer), sound: String(e.name ?? "") });
        break;
      case "msg":
        this.onGuestMsg(peer, (e.msg ?? {}) as Msg);
        break;
    }
  }

  private onGuestMsg(peer: number, m: Msg) {
    switch (m.t) {
      case "ops": {
        const cur = this.link?.current();
        if (!cur || !isOps(m.ops)) return;
        const next = applyOps(cur, m.ops);
        this.link?.fromRoom(next, true);
        this.rev++;
        this.broadcast({ t: "ops", rev: this.rev, peer, seq: m.seq, ops: m.ops });
        this.markFocus(peer, m.ops);
        this.afterSongChange(next);
        break;
      }
      case "transport":
        this.applyTransport({
          playing: !!m.playing,
          mode: m.mode === "song" ? "song" : "pattern",
          patternId: typeof m.patternId === "string" ? m.patternId : this.s.transport.patternId,
          fromStep: Math.max(0, Number(m.fromStep) || 0),
        });
        break;
      case "ping":
        this.broadcast({ t: "pong", t0: m.t0, host: wallNow() }, peer);
        break;
      case "view":
        if (typeof m.patternId === "string") {
          this.setPeer(peer, { patternId: m.patternId });
          this.broadcast({ t: "peers", peers: this.s.peers });
        }
        break;
    }
  }

  /** A tempo change while playing re-anchors the clock (same position, new speed). */
  private afterSongChange(song: Song) {
    const t = this.s.transport;
    if (song.bpm === t.bpm) return;
    const next = t.playing ? retempo(t, song.bpm, wallNow()) : { ...t, bpm: song.bpm };
    this.set({ transport: next });
    this.broadcast({ t: "transport", transport: next });
  }

  private applyTransport(req: TransportRequest) {
    const t = this.s.transport;
    const now = wallNow();
    const bpm = this.link?.current()?.bpm ?? t.bpm;
    let next: Transport;
    if (!req.playing) next = stopAt({ ...t, mode: req.mode, patternId: req.patternId || t.patternId }, now);
    else if (!t.playing) next = startAt({ ...t, mode: req.mode, patternId: req.patternId || t.patternId, bpm }, req.fromStep, now);
    // Already playing: switch pattern or mode without losing the beat.
    else next = { ...t, mode: req.mode, patternId: req.patternId || t.patternId };
    this.set({ transport: next });
    this.broadcast({ t: "transport", transport: next });
  }

  // ---- guest ----

  scan(): Promise<JamRoomFound[]> {
    return api.jamScan();
  }

  async join(address: string, code: string, name: string) {
    saveName(name);
    this.lastJoin = { address, code, name };
    await this.link?.saveNow();
    await this.listenTo("jam-guest", (p) => this.onGuestEvent(p as { msg?: Msg; closed?: boolean }));
    this.quietEnd = false;
    this.set({ role: "guest", joining: true, lost: null, peers: [], focus: {}, transport: STOPPED, hush: NO_HUSH });
    try {
      const me = await api.jamJoin(address, code, name);
      this.set({ me });
    } catch (e) {
      this.stopListening();
      this.set({ role: "off", joining: false });
      throw e;
    }
    this.startPings();
  }

  async reconnect() {
    if (!this.lastJoin) return;
    const { address, code, name } = this.lastJoin;
    await this.join(address, code, name);
  }

  private startPings() {
    this.stopPings();
    let n = 0;
    const ping = () => {
      if (this.s.role !== "guest") return this.stopPings();
      api.jamGuestSend({ t: "ping", t0: wallNow() }).catch(() => {});
    };
    ping();
    // A quick burst for a first estimate, then now and then (clocks drift slowly).
    this.pingTimer = setInterval(() => {
      ping();
      if (++n === 8 && this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(ping, 3000);
      }
    }, 150);
  }

  private stopPings() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** Rebuild what this guest sees: the host's song plus its own edits not confirmed yet. */
  private showGuestSong() {
    if (!this.confirmed) return;
    const view = this.pending.reduce((s, p) => applyOps(s, p.ops), this.confirmed);
    this.link?.fromRoom(view, false);
  }

  private onGuestEvent(e: { msg?: Msg; closed?: boolean }) {
    if (this.s.role !== "guest") return;
    if (e.closed) return void this.connectionLost();
    const m = e.msg ?? {};
    switch (m.t) {
      case "welcome": {
        const you = (m.you ?? {}) as Peer;
        const song = normalizeSong(m.song);
        if (!song) return;
        setIdSuffix(you.suffix ?? "z");
        this.confirmed = song;
        this.pending = [];
        this.seq = 0;
        this.link?.clearHistory();
        this.link?.fromRoom(song, false);
        this.set({
          joining: false,
          me: Number(you.id ?? this.s.me),
          roomName: String((m.room as { name?: string } | undefined)?.name ?? ""),
          peers: Array.isArray(m.peers) ? (m.peers as Peer[]) : [],
          transport: isTransport(m.transport) ? m.transport : STOPPED,
        });
        this.view(song.currentPatternId);
        break;
      }
      case "ops": {
        if (!this.confirmed || !isOps(m.ops)) return;
        this.confirmed = applyOps(this.confirmed, m.ops);
        const peer = Number(m.peer);
        if (peer === this.s.me) this.pending = this.pending.filter((p) => p.seq > Number(m.seq));
        else this.markFocus(peer, m.ops);
        this.showGuestSong();
        break;
      }
      case "transport":
        if (isTransport(m.transport)) this.set({ transport: m.transport });
        break;
      case "peers":
        if (Array.isArray(m.peers)) this.set({ peers: m.peers as Peer[] });
        break;
      case "pong":
        this.clock.add(Number(m.t0), Number(m.host), wallNow());
        break;
      case "packs":
        this.set({ packsVersion: this.s.packsVersion + 1 });
        break;
      case "bye":
        if (m.reason === "closed") {
          this.quietEnd = true;
          this.notify("jam.closedByHost", { name: this.s.roomName });
        }
        break;
    }
  }

  private async connectionLost() {
    const name = this.s.roomName;
    const quiet = this.quietEnd;
    await this.backToOwn();
    if (!quiet) this.set({ lost: name || i18n.t("jam.theRoom") });
  }

  private async backToOwn() {
    this.stopPings();
    this.stopListening();
    setIdSuffix("");
    this.confirmed = null;
    this.pending = [];
    this.set({ role: "off", joining: false, peers: [], focus: {}, transport: STOPPED, code: "", address: "", vpnAddress: "", invite: "", hush: NO_HUSH });
    this.link?.clearHistory();
    await this.link?.reloadOwn();
  }

  dismissLost() {
    this.set({ lost: null });
  }

  /** Leave (guest) or close (host) the room. */
  async leave() {
    if (this.s.role === "host") {
      await api.jamHostStop().catch(() => {});
      this.stopListening();
      this.set({ role: "off", peers: [], focus: {}, transport: STOPPED, code: "", address: "", vpnAddress: "", invite: "", hush: NO_HUSH });
      this.link?.clearHistory();
    } else if (this.s.role === "guest") {
      this.quietEnd = true;
      await api.jamLeave().catch(() => {});
      await this.backToOwn();
    }
  }

  /** Guest: bring a sound file of this PC to the room. */
  upload(path: string) {
    return api.jamGuestUpload(path);
  }

  // ---- shared ----

  private markFocus(peer: number, ops: Op[]) {
    const t = touched(ops);
    if (!t.channels.length && !t.patterns.length) return;
    this.set({ focus: { ...this.s.focus, [peer]: { ...t, at: Date.now() } } });
  }

  private async listenTo(event: string, fn: (payload: unknown) => void) {
    this.stopListening();
    try {
      this.unlisten = await listen(event, (e) => fn(e.payload));
    } catch {
      /* outside Tauri */
    }
  }

  private stopListening() {
    this.unlisten?.();
    this.unlisten = null;
  }
}

let room: JamRoom | null = null;
export function jamRoom(): JamRoom {
  return (room ??= new JamRoom());
}
