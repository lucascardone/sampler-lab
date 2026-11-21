// "Tocar juntos": a song edit as a list of small operations ("this step is now on",
// "this channel's reverb is 0.4"), instead of the whole song. Two people changing
// different things merge cleanly; when two people change the same value, the last one
// to reach the host wins.
//
// Paths address the song structurally. Arrays of objects with an `id` (channels,
// patterns, tracks, clips) are addressed by id ("#ch3"), never by position, so an op
// still points at the right thing after someone else adds or removes items. Arrays of
// numbers of the same length (a pattern row) are addressed per index. Anything else is
// replaced as a whole (a channel's list of piano-roll notes, a sound reference).
//
// Pure: no React, no network. Tested in ops.test.ts.

import { normalizeSong, type Song } from "../studio/song";

/** A path segment: "#<id>" (keyed array item), an array index, or an object key. */
export type Seg = string | number;

export type Op =
  /** Set (or add) the value at the path. */
  | { p: Seg[]; v: unknown }
  /** Remove the item / key at the path. */
  | { p: Seg[]; d: 1 }
  /** The keyed array at the path, in this order (items not listed keep their place at the end). */
  | { p: Seg[]; order: string[] };

/** Per-person, never shared: what you're looking at, and your own id counter. */
const LOCAL_KEYS = new Set(["currentPatternId", "nextId", "version"]);

type Obj = Record<string, unknown>;

const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const hasId = (x: unknown): x is Obj & { id: string } => isObj(x) && typeof x.id === "string";
const isKeyed = (x: unknown): x is (Obj & { id: string })[] => Array.isArray(x) && x.every(hasId);
const isNumbers = (x: unknown): x is number[] => Array.isArray(x) && x.every((n) => typeof n === "number");

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as Obj).filter((k) => (a as Obj)[k] !== undefined);
  const kb = Object.keys(b as Obj).filter((k) => (b as Obj)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Obj)[k], (b as Obj)[k]));
}

function diffInto(a: unknown, b: unknown, path: Seg[], out: Op[]) {
  if (deepEqual(a, b)) return;
  // Two non-empty-or-empty keyed lists (an empty list is "keyed" too).
  if (isKeyed(a) && isKeyed(b) && (a.length > 0 || b.length > 0)) {
    const before = new Map(a.map((x) => [x.id, x]));
    const after = new Set(b.map((x) => x.id));
    for (const item of b) {
      const old = before.get(item.id);
      if (old === undefined) out.push({ p: [...path, `#${item.id}`], v: item });
      else diffInto(old, item, [...path, `#${item.id}`], out);
    }
    for (const item of a) if (!after.has(item.id)) out.push({ p: [...path, `#${item.id}`], d: 1 });
    // Applying the adds appends them; say the order only if that isn't already right.
    const expected = [...a.map((x) => x.id).filter((id) => after.has(id)), ...b.map((x) => x.id).filter((id) => !before.has(id))];
    const wanted = b.map((x) => x.id);
    if (!deepEqual(expected, wanted)) out.push({ p: path, order: wanted });
    return;
  }
  if (isNumbers(a) && isNumbers(b) && a.length === b.length) {
    b.forEach((v, i) => {
      if (a[i] !== v) out.push({ p: [...path, i], v });
    });
    return;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(b)) {
      if (path.length === 0 && LOCAL_KEYS.has(k)) continue;
      if (b[k] === undefined) continue;
      if (!(k in a) || a[k] === undefined) out.push({ p: [...path, k], v: b[k] });
      else diffInto(a[k], b[k], [...path, k], out);
    }
    for (const k of Object.keys(a)) {
      if (path.length === 0 && LOCAL_KEYS.has(k)) continue;
      if (a[k] !== undefined && (!(k in b) || b[k] === undefined)) out.push({ p: [...path, k], d: 1 });
    }
    return;
  }
  out.push({ p: path, v: b });
}

/** What changed from `prev` to `next`, as ops (view fields and the id counter left out). */
export function diffSong(prev: Song, next: Song): Op[] {
  const out: Op[] = [];
  diffInto(prev, next, [], out);
  return out;
}

const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));

/** Apply one op to `node` (copy-on-write). Ops pointing at something gone do nothing. */
function applyAt(node: unknown, op: Op, i: number): unknown {
  const path = op.p;
  if (i === path.length) {
    if (!("order" in op) || !isKeyed(node)) return node;
    const byId = new Map(node.map((x) => [x.id, x]));
    const listed = op.order.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
    const rest = node.filter((x) => !op.order.includes(x.id));
    return [...listed, ...rest];
  }
  const seg = path[i];
  const last = i === path.length - 1 && !("order" in op);
  if (typeof seg === "string" && seg.startsWith("#")) {
    if (!Array.isArray(node)) return node;
    const id = seg.slice(1);
    const at = node.findIndex((x) => hasId(x) && x.id === id);
    if (last) {
      if ("d" in op) return at < 0 ? node : node.filter((_, k) => k !== at);
      if (!("v" in op)) return node;
      const copy = [...node];
      if (at < 0) copy.push(clone(op.v));
      else copy[at] = clone(op.v);
      return copy;
    }
    if (at < 0) return node;
    const child = applyAt(node[at], op, i + 1);
    if (child === node[at]) return node;
    const copy = [...node];
    copy[at] = child;
    return copy;
  }
  if (typeof seg === "number") {
    if (!Array.isArray(node) || seg < 0 || seg >= node.length) return node;
    if (last) {
      if (!("v" in op)) return node;
      const copy = [...node];
      copy[seg] = clone(op.v);
      return copy;
    }
    const child = applyAt(node[seg], op, i + 1);
    if (child === node[seg]) return node;
    const copy = [...node];
    copy[seg] = child;
    return copy;
  }
  if (!isObj(node)) return node;
  if (last) {
    if ("d" in op) {
      if (!(seg in node)) return node;
      const copy = { ...node };
      delete copy[seg];
      return copy;
    }
    return "v" in op ? { ...node, [seg]: clone(op.v) } : node;
  }
  if (!(seg in node)) return node;
  const child = applyAt(node[seg], op, i + 1);
  return child === node[seg] ? node : { ...node, [seg]: child };
}

/** Apply ops without checking the result (for tests and for chaining). */
export function applyOpsRaw<T>(doc: T, ops: Op[]): T {
  let out: unknown = doc;
  for (const op of ops) {
    if (!op || !Array.isArray(op.p)) continue;
    // Never let a peer change what *you* are looking at.
    if (op.p.length > 0 && typeof op.p[0] === "string" && LOCAL_KEYS.has(op.p[0])) continue;
    out = applyAt(out, op, 0);
  }
  return out as T;
}

/**
 * Apply ops to a song and keep it valid (`normalizeSong` drops rows of removed channels,
 * clamps values, fixes the open pattern). Keeps `song`'s own view and id counter.
 */
export function applyOps(song: Song, ops: Op[]): Song {
  if (!ops.length) return song;
  const raw = applyOpsRaw(song, ops);
  if (raw === song) return song;
  const next = normalizeSong(raw);
  if (!next) return song;
  return { ...next, nextId: Math.max(next.nextId, song.nextId) };
}

/** Channel and pattern ids an op touches (for "who is touching what" dots). */
export function touched(ops: Op[]): { channels: string[]; patterns: string[] } {
  const channels = new Set<string>();
  const patterns = new Set<string>();
  const id = (s: Seg | undefined) => (typeof s === "string" && s.startsWith("#") ? s.slice(1) : undefined);
  for (const op of ops) {
    const [root, a, b, c] = op.p;
    if (root === "channels" && id(a)) channels.add(id(a)!);
    if (root === "patterns" && id(a)) {
      patterns.add(id(a)!);
      // patterns/#p/rows/<channel>/…, patterns/#p/notes/<channel> or patterns/#p/mix/<channel>/…
      if ((b === "rows" || b === "notes" || b === "mix") && typeof c === "string") channels.add(c);
    }
  }
  return { channels: [...channels], patterns: [...patterns] };
}

/** True if a list looks like ops (messages from the network are checked). */
export function isOps(x: unknown): x is Op[] {
  return (
    Array.isArray(x) &&
    x.length < 50_000 &&
    x.every((o) => isObj(o) && Array.isArray(o.p) && o.p.every((s) => typeof s === "string" || typeof s === "number") && ("v" in o || "d" in o || Array.isArray(o.order)))
  );
}
