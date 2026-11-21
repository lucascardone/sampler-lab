import { describe, expect, it } from "vitest";
import { patternColor } from "./colors";

describe("patternColor", () => {
  it("is stable and gives neighbouring patterns clearly different hues", () => {
    expect(patternColor("pat7")).toBe(patternColor("pat7"));
    const hue = (id: string) => Number(/hsl\((\d+)/.exec(patternColor(id))![1]);
    for (let n = 1; n < 30; n++) {
      const d = Math.abs(hue(`pat${n}`) - hue(`pat${n + 1}`));
      expect(Math.min(d, 360 - d)).toBeGreaterThan(60);
    }
  });
});
