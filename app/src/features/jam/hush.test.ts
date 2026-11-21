// Whose part this PC hears, and when a new song version waits for the bar.
import { describe, expect, it } from "vitest";
import { newSong, type DrumNames, type Song } from "../studio/song";
import { channelOwner, hushedChannels, NO_HUSH, waitsForBar } from "./hush";

const names: DrumNames = { kick: "Bombo", snare: "Caja", clap: "Palmas", hat: "Hi-hat", openHat: "Hi-hat abierto", rim: "Aro" };

function withChannels(ids: string[]): Song {
  const s = newSong(names);
  return { ...s, channels: ids.map((id) => ({ ...s.channels[0], id })) };
}

describe("channelOwner", () => {
  it("reads the id letters", () => {
    expect(channelOwner("ch12")).toBe("");
    expect(channelOwner("ch12b")).toBe("b");
    expect(channelOwner("ch3bb")).toBe("bb");
  });
});

describe("hushedChannels", () => {
  const song = withChannels(["ch1", "ch2b", "ch3c", "ch4b"]);
  it("hears everything by default", () => {
    expect(hushedChannels(song, "b", NO_HUSH).size).toBe(0);
  });
  it("silences one person's channels", () => {
    expect([...hushedChannels(song, "", { onlyMine: false, people: ["b"] })]).toEqual(["ch2b", "ch4b"]);
  });
  it("only mine keeps my channels (host: the ones without letters)", () => {
    expect([...hushedChannels(song, "c", { onlyMine: true, people: [] })]).toEqual(["ch1", "ch2b", "ch4b"]);
    expect([...hushedChannels(song, "", { onlyMine: true, people: [] })]).toEqual(["ch2b", "ch3c", "ch4b"]);
  });
  it("never silences my own part", () => {
    expect(hushedChannels(song, "b", { onlyMine: false, people: ["b"] }).size).toBe(0);
  });
});

describe("waitsForBar", () => {
  it("edits wait, tempo changes don't", () => {
    const s = newSong(names);
    expect(waitsForBar(s, { ...s, masterVolume: 0.5 })).toBe(true);
    expect(waitsForBar(s, { ...s, bpm: s.bpm + 1 })).toBe(false);
  });
});
