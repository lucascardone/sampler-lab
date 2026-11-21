// SFZ instruments (the open multi-sample format): a text file that maps audio files to
// key and velocity ranges. We read a small, common subset — enough for free piano,
// strings and drum instruments — and ignore everything else silently.
//
// Supported: <control> default_path · <global>/<master>/<group>/<region> inheritance ·
// sample, lokey, hikey, key, pitch_keycenter, lovel, hivel, tune, transpose, volume,
// ampeg_release, #define $VAR, #include (via `expandIncludes`), keyswitches (only the
// default articulation plays: sw_default/sw_last). Skipped: release-triggered regions and
// built-in waves ("*sine"). Not supported (ignored): loops, filters, LFOs, round robin,
// sequences, scripts.

export interface Zone {
  /** Sample path relative to the .sfz file's folder ("/" separators). */
  file: string;
  lo: number;
  hi: number;
  /** The MIDI note the sample plays at its own pitch. */
  root: number;
  loVel: number;
  hiVel: number;
  tuneCents: number;
  gainDb: number;
  /** Release time in seconds (fade when the note ends). */
  release: number;
}

const NOTE_OFFSETS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** "c4" → 60, "f#3" → 54, "eb2" → 39, "60" → 60. SFZ uses C4 = 60. */
export function parseNote(v: string): number | null {
  const s = v.trim().toLowerCase();
  if (/^-?\d+$/.test(s)) return Number(s);
  const m = s.match(/^([a-g])([#b]?)(-?\d+)$/);
  if (!m) return null;
  return NOTE_OFFSETS[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (Number(m[3]) + 1) * 12;
}

type Opcodes = Record<string, string>;

/** Split "a=1 b=some file.wav c=3" into opcodes (values may contain spaces). */
function opcodes(text: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /([A-Za-z0-9_$]+)=/g;
  const marks: { key: string; start: number; valueStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) marks.push({ key: m[1], start: m.index, valueStart: m.index + m[0].length });
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    out.push([mk.key, text.slice(mk.valueStart, end).trim()]);
  });
  return out;
}

/** "a/b" + "../c/d.sfz" → "a/c/d.sfz"; null if it climbs out of the instrument's folder. */
export function joinInside(base: string, rel: string): string | null {
  const parts = base.split("/").filter(Boolean);
  for (const seg of rel.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Paste the files an SFZ pulls in with `#include "x.sfz"` (big instruments split their
 * articulations that way). Paths are relative to the top file's folder, like sfizz; `read`
 * gets a file by that relative path. Missing files are skipped; nesting stops at 8 levels.
 */
export async function expandIncludes(text: string, read: (rel: string) => Promise<string>, open: string[] = []): Promise<string> {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*#include\s+"([^"]+)"/);
    if (!m) {
      out.push(line);
      continue;
    }
    const rel = joinInside("", m[1]);
    // `open`: the files being pasted right now, so a file that includes itself stops.
    if (!rel || open.length >= 8 || open.includes(rel.toLowerCase())) continue;
    try {
      out.push(await expandIncludes(await read(rel), read, [...open, rel.toLowerCase()]));
    } catch {
      // A missing fragment: play what's there.
    }
  }
  return out.join("\n");
}

export function parseSfz(text: string): Zone[] {
  const defines: Record<string, string> = {};
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, ""));
  // #define $NAME value
  const body = lines
    .filter((l) => {
      const d = l.match(/^\s*#define\s+(\$\w+)\s+(.+?)\s*$/);
      if (d) defines[d[1]] = d[2];
      return !d && !/^\s*#include/.test(l);
    })
    .join("\n")
    .replace(/\$\w+/g, (v) => defines[v] ?? v);

  let control: Opcodes = {};
  let global: Opcodes = {};
  let master: Opcodes = {};
  let group: Opcodes = {};
  let current: Opcodes | null = null;
  let header = "";
  const regions: Opcodes[] = [];

  const flush = () => {
    if (header === "region" && current) regions.push({ ...global, ...master, ...group, ...current });
  };
  // Tokens: <header> or text between headers.
  const parts = body.split(/(<[a-z_]+>)/i);
  for (const part of parts) {
    const h = part.match(/^<([a-z_]+)>$/i);
    if (h) {
      flush();
      header = h[1].toLowerCase();
      current = {};
      if (header === "control") control = current;
      else if (header === "global") (global = current), (master = {}), (group = {});
      else if (header === "master") (master = current), (group = {});
      else if (header === "group") group = current;
      continue;
    }
    if (!current) continue;
    for (const [k, v] of opcodes(part)) current[k.toLowerCase()] = v;
  }
  flush();

  const prefix = (control.default_path ?? "").replace(/\\/g, "/");
  const num = (o: Opcodes, k: string, d: number) => {
    const v = o[k];
    if (v === undefined) return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const note = (o: Opcodes, k: string) => (o[k] !== undefined ? parseNote(o[k]) : null);

  // Keyswitched instruments stack every articulation on the same keys: keep the default
  // one (sw_default; else the lowest switch), and regions that aren't switched at all.
  const swDefault = control.sw_default ?? regions.find((r) => r.sw_default !== undefined)?.sw_default;
  const switches = regions.map((r) => (r.sw_last !== undefined ? parseNote(r.sw_last) : null)).filter((n): n is number => n !== null);
  const wanted = swDefault !== undefined && switches.includes(parseNote(swDefault) ?? -1) ? parseNote(swDefault) : switches.length ? Math.min(...switches) : null;
  const playable = regions.filter(
    (r) =>
      r.sample &&
      !r.sample.startsWith("*") &&
      (r.trigger ?? "attack").toLowerCase() !== "release" &&
      (r.sw_last === undefined || parseNote(r.sw_last) === wanted),
  );

  const zones: Zone[] = [];
  for (const r of playable) {
    const key = note(r, "key");
    const lo = note(r, "lokey") ?? key ?? 0;
    const hi = note(r, "hikey") ?? key ?? 127;
    const transpose = num(r, "transpose", 0);
    zones.push({
      file: (prefix + r.sample.replace(/\\/g, "/")).replace(/^\.\//, ""),
      lo: Math.max(0, Math.min(127, lo)),
      hi: Math.max(0, Math.min(127, hi)),
      root: (note(r, "pitch_keycenter") ?? key ?? 60) - transpose,
      loVel: num(r, "lovel", 1),
      hiVel: num(r, "hivel", 127),
      tuneCents: num(r, "tune", 0),
      gainDb: num(r, "volume", 0),
      release: Math.max(0.01, num(r, "ampeg_release", 0.03)),
    });
  }
  return zones;
}

/**
 * The zones worth loading: for each key range, only the velocity layer that covers a
 * medium velocity (v1 plays one layer; loading every layer of a big piano is GBs).
 */
export function zonesToLoad(zones: Zone[], velocity = 90): Zone[] {
  const byRange = new Map<string, Zone[]>();
  for (const z of zones) {
    const k = `${z.lo}-${z.hi}`;
    byRange.set(k, [...(byRange.get(k) ?? []), z]);
  }
  const out: Zone[] = [];
  for (const list of byRange.values()) {
    out.push(list.find((z) => velocity >= z.loVel && velocity <= z.hiVel) ?? list[Math.floor(list.length / 2)]);
  }
  return out;
}

/** The zone that plays a note: the one whose range contains it, else the nearest root. */
export function pickZone<Z extends Zone>(zones: Z[], note: number): Z | undefined {
  let best: Z | undefined;
  let bestD = Infinity;
  for (const z of zones) {
    const inside = note >= z.lo && note <= z.hi;
    const d = inside ? Math.abs(note - z.root) - 1000 : Math.min(Math.abs(note - z.lo), Math.abs(note - z.hi));
    if (d < bestD) (bestD = d), (best = z);
  }
  return best;
}
