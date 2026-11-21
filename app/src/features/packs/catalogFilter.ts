// Pure helpers for "Conseguir más": filter the (now large) instrument catalog by category
// and by a search the user types in Spanish or English, and format sizes/durations.
import type { CatalogEntry } from "../../lib/api";

/** Lowercase, no accents: "Batería" → "bateria". */
export const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/**
 * Entries in `category` ("all" = any) whose name, description, author or category label
 * contains every word of `query`. `categoryLabel` gives the Spanish label of a category,
 * so "bajo" finds the bass instruments even though their names are in English.
 */
export function filterCatalog(entries: CatalogEntry[], category: string, query: string, categoryLabel: (c: string) => string): CatalogEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (category !== "all" && e.category !== category) return false;
    if (words.length === 0) return true;
    const hay = fold(`${e.name} ${e.description} ${e.author} ${categoryLabel(e.category)}`);
    // "bajo" should match "Bajos", "bateria" "Baterías": compare without a trailing s.
    return words.every((w) => hay.includes(w) || hay.includes(w.replace(/s$/, "")));
  });
}

export const formatMB = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

/** "0,4 s" for short hits, "1:05" from a minute up. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
