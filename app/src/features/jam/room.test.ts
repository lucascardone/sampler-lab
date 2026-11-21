// A whole room in memory: one host, one guest, and a fake network in between (the
// Rust relay replaced by direct calls). Checks that both end up with the same song.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const handlers: Record<string, Handler> = {};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const later = (f: () => void) => setTimeout(f, 0);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: Handler) => {
    handlers[event] = cb;
    return () => {
      if (handlers[event] === cb) delete handlers[event];
    };
  }),
}));

vi.mock("../../lib/api", () => ({
  api: {
    jamHostStart: vi.fn(async (name: string) => ({ code: "1234", name, port: 1, address: "192.168.0.2" })),
    jamHostStop: vi.fn(async () => {}),
    jamHostSend: vi.fn(async (_to: number | null, msg: unknown) => later(() => handlers["jam-guest"]?.({ payload: { msg: clone(msg) } }))),
    jamJoin: vi.fn(async (_a: string, _c: string, name: string) => {
      later(() => handlers["jam-host"]?.({ payload: { kind: "join", peer: 1, name } }));
      return 1;
    }),
    jamGuestSend: vi.fn(async (msg: unknown) => later(() => handlers["jam-host"]?.({ payload: { kind: "msg", peer: 1, msg: clone(msg) } }))),
    jamLeave: vi.fn(async () => {}),
    jamScan: vi.fn(async () => []),
    songSave: vi.fn(async () => {}),
    songLoad: vi.fn(async () => null),
  },
}));

import { addPattern, newSong, setIdSuffix, setStep, updateChannel, addChannel, type DrumNames, type Song } from "../studio/song";
import { JamRoom, suffixFor, type SongLink } from "./room";

const names: DrumNames = { kick: "Bombo", snare: "Caja", clap: "Palmas", hat: "Hi-hat", openHat: "Hi-hat abierto", rim: "Aro" };

/** A tiny stand-in for useSong: holds a song, edits go through the room. */
function store(room: JamRoom, initial: Song) {
  let song = initial;
  const link: SongLink = {
    current: () => song,
    fromRoom: (s) => {
      song = { ...s, currentPatternId: song.patterns.some((p) => p.id === song.currentPatternId) && s.patterns.some((p) => p.id === song.currentPatternId) ? song.currentPatternId : s.currentPatternId };
    },
    saveNow: async () => {},
    reloadOwn: async () => {
      song = initial;
    },
    clearHistory: () => {},
  };
  room.attach(link);
  return {
    get: () => song,
    edit: (fn: (s: Song) => Song) => {
      const next = fn(song);
      room.localEdit(song, next);
      song = next;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const music = (s: Song) => ({ ...s, currentPatternId: "", nextId: 0 });

describe("a room with a host and a guest", () => {
  let host: JamRoom;
  let guest: JamRoom;
  beforeEach(() => {
    host = new JamRoom();
    guest = new JamRoom();
  });
  afterEach(async () => {
    await guest.leave();
    await host.leave();
    setIdSuffix("");
  });

  it("the guest gets the host's song, edits merge both ways, and both end equal", async () => {
    const h = store(host, addPattern(newSong(names), "Patrón 2"));
    const own = newSong(names);
    const g = store(guest, own);
    await host.open("Lucas");
    await guest.join("192.168.0.2", "1234", "Ana");
    await flush();
    expect(guest.get().joining).toBe(false);
    expect(guest.get().roomName).toBe("Lucas");
    expect(music(g.get())).toEqual(music(h.get()));
    expect(host.get().peers.map((p) => p.name)).toEqual(["Lucas", "Ana"]);

    // At the same time: the guest lights a step, the host mutes another channel.
    const pid = h.get().patterns[0].id;
    g.edit((s) => setStep(s, pid, s.channels[0].id, 2, 1));
    h.edit((s) => updateChannel(s, s.channels[1].id, { mute: true }));
    // And both add a channel: different ids, both kept.
    g.edit((s) => addChannel(s, { kind: "synth", preset: "lead" }, "Lead de Ana"));
    setIdSuffix("");
    h.edit((s) => addChannel(s, { kind: "synth", preset: "pad" }, "Colchón"));
    await flush();

    expect(music(g.get())).toEqual(music(h.get()));
    expect(h.get().patterns[0].rows[h.get().channels[0].id][2]).toBe(1);
    expect(h.get().channels[1].mute).toBe(true);
    expect(h.get().channels.map((c) => c.name)).toEqual(expect.arrayContaining(["Lead de Ana", "Colchón"]));
    // The host saw who touched what.
    expect(host.get().focus[1]?.channels.length).toBeGreaterThan(0);
  });

  it("looking at another pattern stays personal", async () => {
    const h = store(host, addPattern(newSong(names), "Patrón 2"));
    const g = store(guest, newSong(names));
    await host.open("Lucas");
    await guest.join("x", "1234", "Ana");
    await flush();
    // The host is on "Patrón 2" (just created); the guest goes to the first one.
    const hostView = h.get().currentPatternId;
    const second = h.get().patterns[0].id;
    expect(second).not.toBe(hostView);
    g.edit((s) => ({ ...s, currentPatternId: second }));
    guest.view(second);
    h.edit((s) => ({ ...s, bpm: 101 }));
    await flush();
    expect(g.get().currentPatternId).toBe(second);
    expect(h.get().currentPatternId).toBe(hostView);
    expect(g.get().bpm).toBe(101);
    expect(host.get().peers.find((p) => p.id === 1)?.patternId).toBe(second);
  });

  it("play from the guest starts everybody, on the host's clock", async () => {
    store(host, newSong(names));
    store(guest, newSong(names));
    await host.open("Lucas");
    await guest.join("x", "1234", "Ana");
    await flush();
    guest.requestTransport({ playing: true, mode: "pattern", patternId: "", fromStep: 0 });
    await flush();
    expect(host.get().transport.playing).toBe(true);
    expect(guest.get().transport).toEqual(host.get().transport);
    // Tempo change while playing: same position, new speed.
    const before = host.get().transport;
    host.localEdit({ ...newSong(names) }, { ...newSong(names), bpm: 140 });
    await flush();
    expect(host.get().transport.bpm).toBe(140);
    expect(host.get().transport.at).toBeGreaterThanOrEqual(before.at - 1000);
    guest.requestTransport({ playing: false, mode: "pattern", patternId: "", fromStep: 0 });
    await flush();
    expect(guest.get().transport.playing).toBe(false);
  });

  it("coming back with the same name keeps your letters (your channels stay yours)", async () => {
    store(host, newSong(names));
    await host.open("Lucas");
    const hostEvent = (payload: unknown) => handlers["jam-host"]?.({ payload });
    hostEvent({ kind: "join", peer: 1, name: "Ana" });
    hostEvent({ kind: "leave", peer: 1 });
    hostEvent({ kind: "join", peer: 2, name: "Ana" });
    hostEvent({ kind: "join", peer: 3, name: "Juan" });
    const by = (n: string) => host.get().peers.find((p) => p.name === n);
    expect(by("Ana")?.suffix).toBe("b");
    expect(by("Ana")?.id).toBe(2);
    expect(by("Juan")?.suffix).toBe("d");
    // Hushing is personal and resets when the room closes.
    host.hushPerson("b", true);
    expect(host.get().hush.people).toEqual(["b"]);
    host.setOnlyMine(true);
    expect(host.get().hush).toEqual({ onlyMine: true, people: [] });
    await host.leave();
    expect(host.get().hush).toEqual({ onlyMine: false, people: [] });
  });

  it("leaving gives the guest its own song back", async () => {
    store(host, newSong(names));
    const own = updateChannel(newSong(names), "ch1", { name: "Mi bombo" });
    const g = store(guest, own);
    await host.open("Lucas");
    await guest.join("x", "1234", "Ana");
    await flush();
    expect(g.get().channels[0].name).toBe("Bombo");
    await guest.leave();
    expect(g.get().channels[0].name).toBe("Mi bombo");
    expect(guest.get().role).toBe("off");
  });
});

describe("id letters", () => {
  it("are unique per guest and letters only", () => {
    const seen = new Set<string>();
    for (let i = 1; i < 200; i++) {
      const s = suffixFor(i);
      expect(s).toMatch(/^[b-z]+$/);
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
    expect(suffixFor(0)).toBe("");
  });
});
