// Piano-roll "Transformar" menu: one-click rewrites of a channel's notes in a pattern,
// in the spirit of Ableton's MIDI transformations but with no knobs. Every transform is a
// pure function Note[] → Note[]; the caller stores the result with setNotes (which also
// clips notes to the pattern), so each one is a single undo step.
import type { Note } from "./song";
import { inScale, type ScaleId } from "./theory";

export type TransformId =
  | "legato"
  | "staccato"
  | "chop"
  | "reverse"
  | "faster"
  | "slower"
  | "snapScale"
  | "mirror"
  | "shuffle"
  | "glissando"
  | "crescendo"
  | "decrescendo"
  | "humanize"
  | "glideAll"
  | "glideNone";

/** How the menu groups them (group id = i18n key under roll.tf.groups). */
export const TRANSFORM_GROUPS: { id: string; items: TransformId[] }[] = [
  { id: "glide", items: ["glideAll", "glissando", "glideNone"] },
  { id: "time", items: ["legato", "staccato", "chop", "faster", "slower", "reverse"] },
  { id: "pitch", items: ["snapScale", "mirror", "shuffle"] },
  { id: "velocity", items: ["crescendo", "decrescendo", "humanize"] },
];

export interface TransformContext {
  /** Pattern length (steps). */
  steps: number;
  key: number;
  scale: ScaleId;
  /** Glide length (steps) that "glideAll" gives every note. */
  glide: number;
  /** Random source in [0, 1) (tests pass a seeded one). */
  random?: () => number;
}

const byTime = (a: Note, b: Note) => a.start - b.start || a.pitch - b.pitch;

/** Distinct onsets (start steps), in order. */
const onsets = (notes: Note[]) => [...new Set(notes.map((n) => n.start))].sort((a, b) => a - b);

/** Drop notes that landed on the same start and pitch as an earlier one. */
function dedupe(notes: Note[]): Note[] {
  const seen = new Set<string>();
  return notes.filter((n) => {
    const k = `${n.start}:${n.pitch}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Nearest note of the scale (ties go down). */
export function snapToScale(pitch: number, key: number, scale: ScaleId): number {
  for (let d = 0; d < 12; d++) {
    if (inScale(pitch - d, key, scale)) return pitch - d;
    if (inScale(pitch + d, key, scale)) return pitch + d;
  }
  return pitch;
}

/** Scale notes strictly between a and b, in the order you'd play them going from a to b. */
export function scaleRun(a: number, b: number, key: number, scale: ScaleId): number[] {
  const out: number[] = [];
  const dir = Math.sign(b - a);
  for (let p = a + dir; dir !== 0 && p !== b; p += dir) if (inScale(p, key, scale)) out.push(p);
  return out;
}

/**
 * Glissando: the melody (the top note of each onset) runs along the scale into the next
 * note, 1/16 per note, in the last steps of each note. The note keeps at least one step.
 */
function glissando(notes: Note[], ctx: TransformContext): Note[] {
  const starts = onsets(notes);
  const out = notes.map((n) => ({ ...n }));
  const top = (s: number) => out.filter((n) => n.start === s).reduce((a, b) => (b.pitch > a.pitch ? b : a));
  const added: Note[] = [];
  for (let i = 0; i + 1 < starts.length; i++) {
    const a = top(starts[i]);
    const b = top(starts[i + 1]);
    const room = Math.min(a.length, b.start - a.start) - 1;
    const run = scaleRun(a.pitch, b.pitch, ctx.key, ctx.scale);
    const k = Math.min(room, run.length);
    if (k <= 0) continue;
    const end = Math.min(a.start + a.length, b.start);
    a.length = end - a.start - k;
    run.slice(-k).forEach((pitch, j) => added.push({ start: end - k + j, length: 1, pitch, velocity: Math.max(0.3, a.velocity * 0.85) }));
  }
  return dedupe([...out, ...added]).sort(byTime);
}

/** Pitches flipped upside down around the middle of the melody, kept in the scale. */
function mirror(notes: Note[], ctx: TransformContext): Note[] {
  const ps = notes.map((n) => n.pitch);
  const axis = Math.min(...ps) + Math.max(...ps);
  return dedupe(
    notes.map((n) => {
      const p = axis - n.pitch;
      return { ...n, pitch: inScale(n.pitch, ctx.key, ctx.scale) ? snapToScale(p, ctx.key, ctx.scale) : p };
    }),
  );
}

function shuffle(notes: Note[], random: () => number): Note[] {
  const ps = notes.map((n) => n.pitch);
  for (let i = ps.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ps[i], ps[j]] = [ps[j], ps[i]];
  }
  return dedupe(notes.map((n, i) => ({ ...n, pitch: ps[i] })));
}

/** Rewrite the notes; returns them unchanged if the transform doesn't apply. */
export function transformNotes(notes: Note[], id: TransformId, ctx: TransformContext): Note[] {
  if (!notes.length) return notes;
  const random = ctx.random ?? Math.random;
  const last = Math.max(1, ctx.steps - 1);
  switch (id) {
    case "legato": {
      // Each note lasts until the next onset (the last one keeps its length).
      const starts = onsets(notes);
      return notes.map((n) => {
        const next = starts.find((s) => s > n.start);
        return next === undefined ? n : { ...n, length: next - n.start };
      });
    }
    case "staccato":
      return notes.map((n) => ({ ...n, length: 1 }));
    case "chop":
      // A long note becomes repeated 1/16 notes (a glide stays on the first one).
      return notes.flatMap((n) =>
        Array.from({ length: n.length }, (_, k) => {
          const { glide, ...rest } = n;
          return k === 0 && glide ? { ...rest, length: 1, glide } : { ...rest, start: n.start + k, length: 1 };
        }),
      );
    case "faster":
      return dedupe(notes.map((n) => ({ ...n, start: Math.floor(n.start / 2), length: Math.max(1, Math.round(n.length / 2)) })));
    case "slower":
      return notes.map((n) => ({ ...n, start: n.start * 2, length: n.length * 2 }));
    case "reverse":
      return notes.map((n) => ({ ...n, start: Math.max(0, ctx.steps - n.start - n.length) })).sort(byTime);
    case "snapScale":
      return dedupe(notes.map((n) => ({ ...n, pitch: snapToScale(n.pitch, ctx.key, ctx.scale) })));
    case "mirror":
      return mirror(notes, ctx);
    case "shuffle":
      return shuffle(notes, random);
    case "glissando":
      return glissando(notes, ctx);
    case "crescendo":
      return notes.map((n) => ({ ...n, velocity: 0.35 + (0.65 * Math.min(n.start, last)) / last }));
    case "decrescendo":
      return notes.map((n) => ({ ...n, velocity: 1 - (0.65 * Math.min(n.start, last)) / last }));
    case "humanize":
      return notes.map((n) => ({ ...n, velocity: Math.max(0.2, Math.min(1, n.velocity + (random() - 0.5) * 0.3)) }));
    case "glideAll":
      return notes.map((n) => ({ ...n, glide: ctx.glide }));
    case "glideNone":
      return notes.map(({ glide: _, ...n }) => n);
  }
}
