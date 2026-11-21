// Pure helpers that keep the Studio sidebar tidy when a pack brings hundreds of sounds:
// split a pack into small folders on its own (instruments, then one folder per kind of
// sound, else per sub-folder of the pack), search everything at once, and remember which
// folders the user left open.
import type { PackItem } from "../../lib/api";
import { fold } from "../packs/catalogFilter";

/** Packs with up to this many sounds are shown as one plain list. */
export const FLAT_MAX = 12;
/** Rows drawn per list before a "Mostrar más" button (long lists stay light). */
export const PAGE = 40;

export interface ItemGroup {
  /** Stable within the pack: "instruments", "cat:drums" or "dir:Kicks". */
  key: string;
  /** What to show: a category id ("drums") for "cat:" groups, the folder name for "dir:". */
  label: string;
  items: PackItem[];
}

const pathOf = (i: PackItem) => (i.file ?? i.sfz ?? "").replace(/\\/g, "/");
const dirParts = (i: PackItem) => pathOf(i).split("/").slice(0, -1);

/** The items a pack lists (hidden = kept only for old songs). */
export const visibleItems = (items: PackItem[]) => items.filter((i) => !i.hidden);

/**
 * How to show a pack's sounds: `null` = one plain list (small pack, or nothing to split
 * by); otherwise folders. Instruments go first in their own folder; loose sounds are split
 * by kind (category) when there are several kinds, else by the pack's own sub-folders.
 */
export function groupItems(items: PackItem[]): ItemGroup[] | null {
  const visible = visibleItems(items);
  if (visible.length <= FLAT_MAX) return null;
  const instruments = visible.filter((i) => i.kind === "instrument");
  const sounds = visible.filter((i) => i.kind !== "instrument");
  const groups: ItemGroup[] = [];
  if (instruments.length) groups.push({ key: "instruments", label: "instruments", items: instruments });

  const byCategory = splitBy(sounds, (i) => i.category || "other");
  if (byCategory.size > 1) {
    const order = [...byCategory.keys()].sort((a, b) => (a === "other" ? 1 : b === "other" ? -1 : a.localeCompare(b)));
    for (const c of order) groups.push({ key: `cat:${c}`, label: c, items: byCategory.get(c)! });
  } else if (sounds.length) {
    // One kind only: use the pack's folders, below the part every sound shares.
    const common = commonDirs(sounds);
    const byDir = splitBy(sounds, (i) => dirParts(i)[common] ?? "");
    if (byDir.size > 1) {
      const order = [...byDir.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, undefined, { numeric: true })));
      for (const d of order) groups.push({ key: `dir:${d}`, label: d, items: byDir.get(d)! });
    } else {
      groups.push({ key: "sounds", label: "", items: sounds });
    }
  }
  // A single folder is just an extra click.
  return groups.length > 1 ? groups : null;
}

function splitBy(items: PackItem[], key: (i: PackItem) => string): Map<string, PackItem[]> {
  const m = new Map<string, PackItem[]>();
  for (const i of items) {
    const k = key(i);
    const list = m.get(k);
    if (list) list.push(i);
    else m.set(k, [i]);
  }
  return m;
}

/** How many leading folders every item shares. */
function commonDirs(items: PackItem[]): number {
  const first = dirParts(items[0]);
  let n = 0;
  while (n < first.length && items.every((i) => dirParts(i)[n]?.toLowerCase() === first[n].toLowerCase())) n++;
  return n;
}

/** True if `text` contains every word of `query` (no accents, any case; "bombos" ≈ "bombo"). */
export function matches(text: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold(text);
  return words.every((w) => hay.includes(w) || hay.includes(w.replace(/s$/, "")));
}

// ---- open/closed folders, remembered per computer ----

const STORE_KEY = "samplerlab.library.open";

/** Folder id → open. Missing ids use the folder's default. */
export type OpenState = Record<string, boolean>;

export function loadOpen(): OpenState {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as OpenState) : {};
  } catch {
    return {};
  }
}

export function saveOpen(s: OpenState) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    // Private mode or blocked storage: folders just won't be remembered.
  }
}
