import { describe, expect, it } from "vitest";
import type { Note } from "./song";
import { scaleRun, snapToScale, transformNotes, type TransformContext } from "./transform";

const ctx: TransformContext = { steps: 16, key: 0, scale: "major", glide: 2 };
const n = (start: number, length: number, pitch: number, velocity = 0.8): Note => ({ start, length, pitch, velocity });
const shape = (list: Note[]) => list.map((x) => [x.start, x.length, x.pitch]);

describe("piano-roll transforms", () => {
  it("snaps to the scale and runs along it", () => {
    expect(snapToScale(61, 0, "major")).toBe(60); // C# → C (ties go down)
    expect(snapToScale(63, 0, "minor")).toBe(63);
    expect(scaleRun(60, 67, 0, "major")).toEqual([62, 64, 65]);
    expect(scaleRun(67, 60, 0, "major")).toEqual([65, 64, 62]);
    expect(scaleRun(60, 60, 0, "major")).toEqual([]);
  });

  it("glissando runs into the next note in the last steps of the note", () => {
    const out = transformNotes([n(0, 8, 60), n(8, 4, 67)], "glissando", ctx);
    expect(shape(out)).toEqual([
      [0, 5, 60],
      [5, 1, 62],
      [6, 1, 64],
      [7, 1, 65],
      [8, 4, 67],
    ]);
    // Not enough room: only the notes closest to the target, and the note keeps a step.
    expect(shape(transformNotes([n(0, 2, 60), n(2, 2, 72)], "glissando", ctx))).toEqual([
      [0, 1, 60],
      [1, 1, 71],
      [2, 2, 72],
    ]);
  });

  it("legato, staccato and chop change lengths", () => {
    const notes = [n(0, 1, 60), n(0, 1, 64), n(4, 2, 62), n(12, 3, 65)];
    expect(shape(transformNotes(notes, "legato", ctx))).toEqual([
      [0, 4, 60],
      [0, 4, 64],
      [4, 8, 62],
      [12, 3, 65],
    ]);
    expect(transformNotes(notes, "staccato", ctx).every((x) => x.length === 1)).toBe(true);
    expect(shape(transformNotes([{ ...n(0, 3, 60), glide: 1 }], "chop", ctx))).toEqual([
      [0, 1, 60],
      [1, 1, 60],
      [2, 1, 60],
    ]);
    expect(transformNotes([{ ...n(0, 3, 60), glide: 1 }], "chop", ctx).map((x) => x.glide)).toEqual([1, undefined, undefined]);
  });

  it("faster, slower and reverse move notes in time", () => {
    expect(shape(transformNotes([n(0, 4, 60), n(1, 1, 60), n(8, 3, 62)], "faster", ctx))).toEqual([
      [0, 2, 60],
      [4, 2, 62],
    ]);
    expect(shape(transformNotes([n(2, 4, 60)], "slower", ctx))).toEqual([[4, 8, 60]]);
    expect(shape(transformNotes([n(0, 4, 60), n(12, 2, 64)], "reverse", ctx))).toEqual([
      [2, 2, 64],
      [12, 4, 60],
    ]);
  });

  it("mirror flips the melody and keeps it in the scale; shuffle keeps rhythm", () => {
    expect(transformNotes([n(0, 1, 60), n(1, 1, 64), n(2, 1, 67)], "mirror", ctx).map((x) => x.pitch)).toEqual([67, 62, 60]);
    let i = 0;
    const seq = [0.9, 0.1];
    const out = transformNotes([n(0, 1, 60), n(4, 1, 62), n(8, 1, 64)], "shuffle", { ...ctx, random: () => seq[i++ % 2] });
    expect(out.map((x) => x.start)).toEqual([0, 4, 8]);
    expect([...out.map((x) => x.pitch)].sort()).toEqual([60, 62, 64]);
  });

  it("shapes velocity and toggles glides", () => {
    const notes = [n(0, 1, 60), n(15, 1, 60)];
    expect(transformNotes(notes, "crescendo", ctx).map((x) => x.velocity)).toEqual([0.35, 1]);
    expect(transformNotes(notes, "decrescendo", ctx).map((x) => +x.velocity.toFixed(2))).toEqual([1, 0.35]);
    const h = transformNotes(notes, "humanize", { ...ctx, random: () => 0.99 });
    expect(h.every((x) => x.velocity > 0.8 && x.velocity <= 1)).toBe(true);
    const g = transformNotes(notes, "glideAll", ctx);
    expect(g.map((x) => x.glide)).toEqual([2, 2]);
    expect(transformNotes(g, "glideNone", ctx).some((x) => "glide" in x)).toBe(false);
    expect(transformNotes([], "legato", ctx)).toEqual([]);
  });
});
