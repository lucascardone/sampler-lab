import { describe, expect, it } from "vitest";
import type { PackInfo } from "../../lib/api";
import { addChannel, newSong, type DrumNames } from "../studio/song";
import { creditsText, songCredits } from "./credits";

const names = { kick: "Bombo", snare: "Caja", clap: "Palmas", hat: "Hi-hat", openHat: "Hi-hat abierto", rim: "Aro" } as DrumNames;

const pack = (id: string, license: string, items: PackInfo["items"]): PackInfo => ({
  version: 1,
  id,
  name: id.toUpperCase(),
  author: `Autor ${id}`,
  license,
  sourceUrl: `https://x/${id}`,
  origin: "catalog",
  installedAt: "",
  items,
  dir: "C:/p",
});

describe("song credits", () => {
  it("lists pack sounds once, with the right author/license; own sounds and missing packs left out", () => {
    let s = newSong(names, "P1");
    s = addChannel(s, { kind: "instrument", packId: "piano", itemId: "grand" }, "Piano");
    s = addChannel(s, { kind: "instrument", packId: "piano", itemId: "grand" }, "Piano 2");
    s = addChannel(s, { kind: "pack", packId: "fs", itemId: "fs-1" }, "Lluvia");
    s = addChannel(s, { kind: "pack", packId: "mine", itemId: "k" }, "Mi bombo");
    s = addChannel(s, { kind: "pack", packId: "gone", itemId: "x" }, "Perdido");
    const packs = [
      pack("piano", "CC0-1.0", [{ id: "grand", name: "Piano de cola", kind: "instrument", sfz: "g.sfz", category: "keys" }]),
      pack("fs", "CC0-1.0", [{ id: "fs-1", name: "Lluvia", kind: "oneshot", file: "1.ogg", category: "fx", credit: { author: "ana", license: "CC-BY-4.0", url: "https://freesound.org/s/1/" } }]),
      pack("mine", "own", [{ id: "k", name: "Bombo", kind: "oneshot", file: "k.wav", category: "drums" }]),
    ];
    const c = songCredits(s, packs);
    expect(c.map((x) => [x.sound, x.author, x.license, x.required])).toEqual([
      ["Piano de cola", "Autor piano", "CC0-1.0", false],
      ["Lluvia", "ana", "CC-BY-4.0", true],
    ]);
    const txt = creditsText("Mi tema", c, { heading: "Créditos", by: "de", license: "licencia" });
    expect(txt.split("\r\n")[2]).toBe("- Lluvia (FS) — de ana — licencia CC-BY-4.0 — https://freesound.org/s/1/");
  });
});
