import { describe, expect, it } from "vitest";
import { applyPreset, BUILTIN_PRESETS, findKick, makeUserPreset, parseUserPresets } from "./fxPresets";
import { fxActive, newSong, NO_FX, normalizeFx, updateChannel, type DrumNames } from "./song";

const names = { kick: "Bombo", snare: "Caja", clap: "Palmas", hat: "Hi-hat", openHat: "Hi-hat abierto", rim: "Aro" } as DrumNames;
const preset = (id: string) => BUILTIN_PRESETS.find((p) => p.id === id)!;

describe("effect presets", () => {
  it("every built-in preset is valid and (except 'Sin efectos') changes the sound", () => {
    const song = newSong(names, "P1");
    const ch = song.channels[1];
    for (const p of BUILTIN_PRESETS) {
      const fx = applyPreset(p, ch, song);
      expect(normalizeFx(fx), p.id).toEqual(fx); // nothing out of range
      expect(fxActive(fx), p.id).toBe(p.id !== "none");
    }
  });

  it("'Sin efectos' clears everything, ducking included; other presets keep the ducking source", () => {
    const song = newSong(names, "P1");
    const [kick, snare] = song.channels;
    const s = updateChannel(song, snare.id, { fx: { ...NO_FX, drive: "hard", duckBy: kick.id } });
    const ch = s.channels[1];
    expect(applyPreset(preset("none"), ch, s)).toEqual(NO_FX);
    expect(applyPreset(preset("lofi"), ch, s).duckBy).toBe(kick.id);
    expect(applyPreset(preset("lofi"), ch, s).drive).toBe("crush"); // replaces, doesn't mix
  });

  it("'Bombeo' ducks to the kick (never to itself)", () => {
    const song = newSong(names, "P1");
    const [kick, snare] = song.channels;
    expect(applyPreset(preset("pump"), snare, song).duckBy).toBe(kick.id);
    expect(findKick(song, kick.id)).toBeNull();
  });

  it("user presets round-trip without the channel-specific ducking source", () => {
    const fx = { ...NO_FX, mod: "flanger" as const, modAmount: 0.8, duckBy: "ch-1" };
    const p = makeUserPreset("Mi flanger", fx);
    const [back] = parseUserPresets(JSON.parse(JSON.stringify([p])));
    expect(back.name).toBe("Mi flanger");
    expect(back.fx.mod).toBe("flanger");
    expect("duckBy" in back.fx).toBe(false);
    expect(back.duckToKick).toBe(true);
    expect(parseUserPresets([{ id: "x", name: "  ", fx: {} }, null, "nope", { name: "sin id" }])).toEqual([]);
  });
});
