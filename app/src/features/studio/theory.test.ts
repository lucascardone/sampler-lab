import { describe, expect, it } from "vitest";
import {
  arpeggiate,
  chordName,
  degreeOf,
  diatonicChord,
  inScale,
  invert,
  noteName,
  numeral,
  progressionLabel,
  progressionNotes,
} from "./theory";

const C = 0, A = 9;

describe("notes and scales", () => {
  it("names notes like DAWs do (60 = C4)", () => {
    expect(noteName(60)).toBe("C4");
    expect(noteName(57)).toBe("A3");
    expect(noteName(61)).toBe("C#4");
    expect(noteName(24)).toBe("C1");
  });

  it("knows which notes are in a scale", () => {
    expect(inScale(64, C, "major")).toBe(true); // E
    expect(inScale(63, C, "major")).toBe(false); // D#
    expect(inScale(60, A, "minor")).toBe(true); // C in A minor
    expect(degreeOf(57, A, "minor")).toBe(0);
    expect(degreeOf(68, A, "harmonicMinor")).toBe(6); // G#
  });
});

describe("chords", () => {
  it("builds diatonic triads and sevenths", () => {
    expect(diatonicChord(60, C, "major", 3)).toEqual([60, 64, 67]); // C
    expect(diatonicChord(62, C, "major", 3)).toEqual([62, 65, 69]); // Dm
    expect(diatonicChord(71, C, "major", 3)).toEqual([71, 74, 77]); // Bdim
    expect(diatonicChord(67, C, "major", 4)).toEqual([67, 71, 74, 77]); // G7
    expect(diatonicChord(64, A, "harmonicMinor", 3)).toEqual([64, 68, 71]); // E (major V)
  });

  it("out-of-scale roots get a major chord", () => {
    expect(diatonicChord(61, C, "major", 3)).toEqual([61, 65, 68]);
  });

  it("inverts", () => {
    expect(invert([60, 64, 67], 1)).toEqual([64, 67, 72]);
    expect(invert([60, 64, 67], 2)).toEqual([67, 72, 76]);
    expect(diatonicChord(60, C, "major", 3, 1)).toEqual([64, 67, 72]);
  });

  it("names chords", () => {
    const name = (root: number, size: 3 | 4) => chordName(root, diatonicChord(root, C, "major", size));
    expect([60, 62, 64, 65, 67, 69, 71].map((r) => name(r, 3))).toEqual(["C", "Dm", "Em", "F", "G", "Am", "Bdim"]);
    expect([60, 62, 67, 71].map((r) => name(r, 4))).toEqual(["Cmaj7", "Dm7", "G7", "Bm7b5"]);
    // Inversions keep the name (root passed explicitly).
    expect(chordName(57, invert([57, 60, 64], 2))).toBe("Am");
  });

  it("roman numerals follow the scale", () => {
    expect([0, 1, 4, 5, 6].map((d) => numeral(d, C, "major"))).toEqual(["I", "ii", "V", "vi", "vii°"]);
    expect([0, 2, 4].map((d) => numeral(d, A, "minor"))).toEqual(["i", "III", "v"]);
    expect(numeral(4, A, "harmonicMinor")).toBe("V");
  });

  it("labels progressions with chord names in the key", () => {
    expect(progressionLabel([0, 4, 5, 3], C, "major")).toBe("I–V–vi–IV  ·  C G Am F");
    expect(progressionLabel([0, 5, 2, 6], A, "minor")).toBe("i–VI–III–VII  ·  Am F C G");
  });
});

describe("progressions", () => {
  it("fills the pattern, one chord per bar, repeating", () => {
    const notes = progressionNotes({ key: C, scale: "major", degrees: [0, 4], every: 16, steps: 64, size: 3 });
    expect(notes).toHaveLength(12);
    expect([...new Set(notes.map((n) => n.start))]).toEqual([0, 16, 32, 48]);
    expect(notes.every((n) => n.length === 16)).toBe(true);
  });

  it("voice-leads: consecutive chords stay close", () => {
    const notes = progressionNotes({ key: C, scale: "major", degrees: [0, 4, 5, 3], every: 16, steps: 64, size: 3 });
    const centers = [0, 16, 32, 48].map((s) => {
      const c = notes.filter((n) => n.start === s).map((n) => n.pitch);
      return c.reduce((a, b) => a + b, 0) / c.length;
    });
    for (let i = 1; i < centers.length; i++) expect(Math.abs(centers[i] - centers[i - 1])).toBeLessThanOrEqual(4);
    // The G chord's notes are still G, B, D in some inversion.
    const g = notes.filter((n) => n.start === 16).map((n) => n.pitch % 12).sort((a, b) => a - b);
    expect(g).toEqual([2, 7, 11]);
  });

  it("roots only: a bass line an octave lower", () => {
    const notes = progressionNotes({ key: A, scale: "minor", degrees: [0, 5], every: 8, steps: 16, size: 3, rootsOnly: true });
    expect(notes.map((n) => [n.start, n.pitch, n.length])).toEqual([
      [0, 45, 8],
      [8, 53, 8],
    ]);
  });

  it("cuts the last chord at the pattern end", () => {
    const notes = progressionNotes({ key: C, scale: "major", degrees: [0], every: 16, steps: 24, size: 3 });
    expect(notes.filter((n) => n.start === 16).every((n) => n.length === 8)).toBe(true);
  });
});

describe("arpeggiator", () => {
  const chord = [60, 64, 67].map((pitch) => ({ start: 0, length: 8, pitch, velocity: 0.8 }));

  it("up / down / up-down", () => {
    expect(arpeggiate(chord, 2, "up").map((n) => n.pitch)).toEqual([60, 64, 67, 60]);
    expect(arpeggiate(chord, 2, "down").map((n) => n.pitch)).toEqual([67, 64, 60, 67]);
    expect(arpeggiate(chord, 1, "upDown").map((n) => n.pitch)).toEqual([60, 64, 67, 64, 60, 64, 67, 64]);
  });

  it("keeps timing inside the chord and leaves single notes alone", () => {
    const melody = { start: 8, length: 4, pitch: 72, velocity: 1 };
    const out = arpeggiate([...chord, melody], 3, "up");
    expect(out.map((n) => [n.start, n.length])).toEqual([
      [0, 3],
      [3, 3],
      [6, 2],
      [8, 4],
    ]);
  });
});

describe("detectChord", () => {
  it("names chords in any inversion and octave spread", async () => {
    const { detectChord } = await import("./theory");
    expect(detectChord([57, 60, 64])).toBe("Am");
    expect(detectChord([64, 69, 72])).toBe("Am"); // 1st inversion
    expect(detectChord([55, 59, 62, 65])).toBe("G7");
    expect(detectChord([48, 64, 67, 72])).toBe("C"); // doubled root
    expect(detectChord([60, 62, 64])).toBeNull();
    expect(detectChord([60, 67])).toBeNull();
  });
});
