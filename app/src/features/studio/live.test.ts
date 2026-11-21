import { describe, expect, it } from "vitest";
import { KEY_MAP, recordedNote } from "./useLiveInput";

describe("recording live notes", () => {
  it("quantizes to the 16th grid", () => {
    expect(recordedNote(3.8, 6.1, 16, 60, 0.8)).toEqual({ start: 4, length: 2, pitch: 60, velocity: 0.8 });
    expect(recordedNote(4.2, 4.3, 16, 60, 1)).toMatchObject({ start: 4, length: 1 }); // tap = 1 step min
  });

  it("handles notes released after the loop wrapped, and pressed just before the end", () => {
    // Pressed at 14, released at 2 of the next pass (16 steps): 4 steps long, cut at the pattern end.
    expect(recordedNote(14, 2, 16, 60, 1)).toMatchObject({ start: 14, length: 2 });
    // Pressed at 15.7 → rounds to 16 → wraps to step 0.
    expect(recordedNote(15.7, 17, 16, 60, 1)).toMatchObject({ start: 0 });
  });

  it("computer keyboard covers an octave and a third, in order", () => {
    const semis = Object.values(KEY_MAP);
    expect(semis).toEqual([...Array(17).keys()]);
  });
});
