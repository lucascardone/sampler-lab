// Catalog search (Spanish words find English names via the category) and formatting.
import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../../lib/api";
import { filterCatalog, fold, formatDuration, formatMB } from "./catalogFilter";

const entry = (id: string, name: string, category: string, description = ""): CatalogEntry => ({
  id,
  name,
  description,
  category,
  author: "Karoryfer",
  license: "CC0-1.0",
  licenseUrl: "",
  sourceUrl: "",
  downloadUrl: "",
  sizeBytes: 1,
  sha256: "",
  source: "github",
});

const LABELS: Record<string, string> = { bass: "Bajos", drums: "Baterías", keys: "Teclados" };
const label = (c: string) => LABELS[c] ?? c;

describe("filterCatalog", () => {
  const list = [entry("a", "Meatbass", "bass", "Bass guitar"), entry("b", "Big rusty drums", "drums"), entry("c", "Osiris Piano", "keys")];

  it("finds English names with Spanish words through the category label", () => {
    expect(filterCatalog(list, "all", "bajo", label).map((e) => e.id)).toEqual(["a"]);
    expect(filterCatalog(list, "all", "batería", label).map((e) => e.id)).toEqual(["b"]);
    expect(filterCatalog(list, "all", "PIANO", label).map((e) => e.id)).toEqual(["c"]);
  });

  it("combines category and every word", () => {
    expect(filterCatalog(list, "drums", "", label).map((e) => e.id)).toEqual(["b"]);
    expect(filterCatalog(list, "all", "big drums", label).map((e) => e.id)).toEqual(["b"]);
    expect(filterCatalog(list, "keys", "drums", label)).toEqual([]);
    expect(filterCatalog(list, "all", "  ", label)).toHaveLength(3);
  });
});

describe("formatting", () => {
  it("folds accents", () => expect(fold("Batería ÁÉ")).toBe("bateria ae"));
  it("formats durations", () => {
    expect(formatDuration(420)).toBe("0,4 s");
    expect(formatDuration(12_400)).toBe("12 s");
    expect(formatDuration(65_000)).toBe("1:05");
    expect(formatDuration(null)).toBe("");
  });
  it("formats sizes", () => {
    expect(formatMB(812_644)).toBe("1 MB");
    expect(formatMB(1_283_000_000)).toBe("1.3 GB");
  });
});
