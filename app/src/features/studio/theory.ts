// Music theory helpers for the piano roll: scales, diatonic chords, progressions and
// arpeggios. Pure functions on MIDI note numbers (60 = C4 = Do central).

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const LATIN_NAMES = ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"];

/** "C4" for 60. */
export function noteName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

export type ScaleId = "major" | "minor" | "harmonicMinor" | "dorian" | "mixolydian";
export const SCALES: Record<ScaleId, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};
export const SCALE_IDS = Object.keys(SCALES) as ScaleId[];

const pc = (midi: number) => ((midi % 12) + 12) % 12;

/** Scale degree (0..6) of a note, or -1 if it's outside the scale. */
export function degreeOf(midi: number, key: number, scale: ScaleId): number {
  return SCALES[scale].indexOf(pc(midi - key));
}

export function inScale(midi: number, key: number, scale: ScaleId): boolean {
  return degreeOf(midi, key, scale) >= 0;
}

/** Move the lowest note up an octave, `n` times. */
export function invert(notes: number[], n: number): number[] {
  const out = [...notes].sort((a, b) => a - b);
  for (let i = 0; i < n % Math.max(1, out.length); i++) out.push(out.shift()! + 12);
  return out;
}

/**
 * The chord built on `root` by stacking scale thirds (3 or 4 notes): on a C in A minor
 * that's C–E–G. A root outside the scale gets a major triad (or dominant 7th).
 */
export function diatonicChord(root: number, key: number, scale: ScaleId, size: 3 | 4, inversion = 0): number[] {
  const deg = degreeOf(root, key, scale);
  let notes: number[];
  if (deg < 0) {
    notes = [0, 4, 7, 10].slice(0, size).map((i) => root + i);
  } else {
    const steps = SCALES[scale];
    notes = [0, 2, 4, 6].slice(0, size).map((k) => {
      const d = deg + k;
      const interval = steps[d % 7] + 12 * Math.floor(d / 7) - steps[deg];
      return root + interval;
    });
  }
  return invert(notes, inversion);
}

/** Chord symbol from a root and its notes: "Am", "G7", "Bdim", "Fmaj7". */
export function chordName(root: number, notes: number[]): string {
  const ints = new Set(notes.map((n) => pc(n - root)));
  const third = ints.has(4) ? 4 : ints.has(3) ? 3 : 0;
  const fifth = ints.has(7) ? 7 : ints.has(6) ? 6 : ints.has(8) ? 8 : 0;
  const seventh = ints.has(11) ? 11 : ints.has(10) ? 10 : ints.has(9) && fifth === 6 ? 9 : 0;
  const name = NOTE_NAMES[pc(root)];
  let q = "";
  if (third === 3 && fifth === 6) q = seventh === 10 ? "m7b5" : seventh === 9 ? "dim7" : "dim";
  else if (third === 4 && fifth === 8) q = "aug";
  else if (third === 3) q = seventh === 10 ? "m7" : seventh === 11 ? "m(maj7)" : "m";
  else q = seventh === 11 ? "maj7" : seventh === 10 ? "7" : "";
  return name + q;
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];

/** Roman numeral of a scale degree, upper case for major chords: "vi", "V", "vii°". */
export function numeral(deg: number, key: number, scale: ScaleId): string {
  const root = key + SCALES[scale][deg];
  const n = diatonicChord(root, key, scale, 3);
  const minor = n[1] - n[0] === 3;
  const dim = minor && n[2] - n[0] === 6;
  const r = ROMAN[deg];
  return dim ? `${r.toLowerCase()}°` : minor ? r.toLowerCase() : r;
}

/** Common progressions as scale degrees; they work in any scale (numerals adapt). */
export const PROGRESSIONS: number[][] = [
  [0, 4, 5, 3], // I–V–vi–IV (pop) / i–v–VI–iv
  [0, 5, 3, 4], // I–vi–IV–V (doo-wop)
  [5, 3, 0, 4], // vi–IV–I–V
  [1, 4, 0, 0], // ii–V–I (jazz)
  [0, 5, 2, 6], // i–VI–III–VII (minor epic)
  [0, 3, 4, 0], // i–iv–v–i
  [0, 6, 5, 6], // i–VII–VI–VII
  [0, 3, 0, 4], // I–IV–I–V (blues/rock)
];

export function progressionLabel(degrees: number[], key: number, scale: ScaleId): string {
  const romans = degrees.map((d) => numeral(d, key, scale)).join("–");
  const names = degrees
    .map((d) => {
      const root = key + SCALES[scale][d];
      return chordName(root, diatonicChord(root, key, scale, 3));
    })
    .join(" ");
  return `${romans}  ·  ${names}`;
}

export interface NoteLike {
  start: number;
  length: number;
  pitch: number;
  velocity: number;
}

/** Pick the inversion/octave of `chord` closest to `prev` (smooth voice leading). */
function closestVoicing(chord: number[], prev: number[] | null): number[] {
  if (!prev) return chord;
  const center = prev.reduce((a, b) => a + b, 0) / prev.length;
  let best = chord;
  let bestDist = Infinity;
  for (const shift of [-12, 0, 12]) {
    for (let inv = 0; inv < chord.length; inv++) {
      const v = invert(chord, inv).map((n) => n + shift);
      const c = v.reduce((a, b) => a + b, 0) / v.length;
      const d = Math.abs(c - center);
      if (d < bestDist - 1e-9) {
        bestDist = d;
        best = v;
      }
    }
  }
  return best;
}

export interface ProgressionOptions {
  key: number;
  scale: ScaleId;
  degrees: number[];
  /** Steps each chord lasts (16 = one bar). */
  every: number;
  /** Fill this many steps, repeating the progression. */
  steps: number;
  size: 3 | 4;
  /** Only the root of each chord, an octave lower: a bass line that follows the chords. */
  rootsOnly?: boolean;
  velocity?: number;
}

/** Notes of a progression filling a pattern, with smooth voice leading. */
export function progressionNotes(o: ProgressionOptions): NoteLike[] {
  const out: NoteLike[] = [];
  const base = 48 + o.key; // chords around C3–C4
  let prev: number[] | null = null;
  for (let i = 0, start = 0; start < o.steps; i++, start += o.every) {
    const deg = o.degrees[i % o.degrees.length];
    const root = base + SCALES[o.scale][deg];
    const length = Math.min(o.every, o.steps - start);
    const velocity = o.velocity ?? 0.8;
    if (o.rootsOnly) {
      out.push({ start, length, pitch: root - 12, velocity });
      continue;
    }
    const chord = closestVoicing(diatonicChord(root, o.key, o.scale, o.size), prev);
    prev = chord;
    for (const pitch of chord) out.push({ start, length, pitch, velocity });
  }
  return out;
}

export type ArpMode = "up" | "down" | "upDown";

/**
 * Turn chords (notes starting together) into arpeggios: the chord's notes one after
 * another, `rate` steps each, for as long as the chord lasted. Single notes stay as is.
 */
export function arpeggiate(notes: NoteLike[], rate: number, mode: ArpMode): NoteLike[] {
  const groups = new Map<number, NoteLike[]>();
  for (const n of notes) groups.set(n.start, [...(groups.get(n.start) ?? []), n]);
  const out: NoteLike[] = [];
  for (const [start, g] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (g.length < 2) {
      out.push(...g);
      continue;
    }
    const up = [...g].sort((a, b) => a.pitch - b.pitch);
    const order =
      mode === "up" ? up : mode === "down" ? [...up].reverse() : [...up, ...up.slice(1, -1).reverse()];
    const span = Math.max(...g.map((n) => n.length));
    for (let t = 0, i = 0; t < span; t += rate, i++) {
      const n = order[i % order.length];
      out.push({ start: start + t, length: Math.min(rate, span - t), pitch: n.pitch, velocity: n.velocity });
    }
  }
  return out;
}

/** Interval sets (from the root) of the chords we can name. */
const SHAPES = [
  [0, 4, 7],
  [0, 3, 7],
  [0, 3, 6],
  [0, 4, 8],
  [0, 4, 7, 11],
  [0, 4, 7, 10],
  [0, 3, 7, 10],
  [0, 3, 6, 10],
  [0, 3, 6, 9],
].map((s) => s.join(","));

/** Name the chord formed by these notes, whatever the inversion; null if it isn't one. */
export function detectChord(pitches: number[]): string | null {
  const pcs = [...new Set(pitches.map(pc))];
  if (pcs.length < 3) return null;
  for (const root of [...pitches].sort((a, b) => a - b).map(pc)) {
    const ints = pcs.map((p) => pc(p - root)).sort((a, b) => a - b);
    if (SHAPES.includes(ints.join(","))) return chordName(root, pcs.map((p) => p + 12 * (p < root ? 1 : 0)));
  }
  return null;
}
