// Sidebar organisation: packs split themselves into small folders, and search.
import { describe, expect, it } from "vitest";
import type { PackItem } from "../../lib/api";
import { FLAT_MAX, groupItems, matches, visibleItems } from "./libraryTree";

const sound = (file: string, category = "other", extra: Partial<PackItem> = {}): PackItem => ({
  id: file,
  name: file.split("/").pop()!,
  kind: "oneshot",
  file,
  category,
  ...extra,
});
const inst = (sfz: string, category = "keys"): PackItem => ({ id: sfz, name: sfz, kind: "instrument", sfz, category });
const many = (n: number, make: (i: number) => PackItem) => Array.from({ length: n }, (_, i) => make(i));

describe("groupItems", () => {
  it("keeps small packs as one list", () => {
    expect(groupItems(many(FLAT_MAX, (i) => sound(`k${i}.wav`, "drums")))).toBeNull();
  });

  it("puts instruments first, then one folder per kind of sound", () => {
    const items = [...many(10, (i) => sound(`a/k${i}.wav`, "drums")), ...many(5, (i) => sound(`a/x${i}.wav`)), sound("a/b.wav", "bass"), inst("p.sfz")];
    const g = groupItems(items)!;
    expect(g.map((x) => [x.key, x.items.length])).toEqual([
      ["instruments", 1],
      ["cat:bass", 1],
      ["cat:drums", 10],
      ["cat:other", 5],
    ]);
  });

  it("uses the pack's own folders when every sound is the same kind", () => {
    const items = [...many(8, (i) => sound(`Pack/Kicks/k${i}.wav`, "drums")), ...many(8, (i) => sound(`Pack/Snares/s${i}.wav`, "drums")), sound("Pack/loose.wav", "drums")];
    expect(groupItems(items)!.map((x) => [x.label, x.items.length])).toEqual([
      ["Kicks", 8],
      ["Snares", 8],
      ["", 1],
    ]);
  });

  it("doesn't make a single folder, and leaves out hidden items", () => {
    const items = many(30, (i) => sound(`s/k${i}.wav`, "drums"));
    expect(groupItems(items)).toBeNull();
    const hidden = [...many(3, (i) => inst(`p${i}.sfz`)), ...many(500, (i) => sound(`Samples/${i}.wav`, "winds", { hidden: true }))];
    expect(visibleItems(hidden)).toHaveLength(3);
    expect(groupItems(hidden)).toBeNull();
  });
});

describe("matches", () => {
  it("ignores accents, case and a plural s, and needs every word", () => {
    expect(matches("Batería 808 · Bombo grave", "bateria")).toBe(true);
    expect(matches("Bombo grave", "BOMBOS")).toBe(true);
    expect(matches("Bombo grave", "bombo agudo")).toBe(false);
    expect(matches("anything", "  ")).toBe(true);
  });
});
