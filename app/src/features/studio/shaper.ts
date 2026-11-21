// Distortion curves for a WaveShaperNode ("Saturación", "Distorsión", "Crujido digital").
// Pure functions so they can be tested without audio.
import type { DriveType } from "./song";

const SIZE = 2049; // odd: the middle sample is exactly 0 in, 0 out

/** The transfer curve for a drive type and amount (0..1). Input and output in [-1, 1]. */
export function driveCurve(type: Exclude<DriveType, "off">, amount: number): Float32Array<ArrayBuffer> {
  const a = Math.max(0, Math.min(1, amount));
  const curve = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    const x = (i / (SIZE - 1)) * 2 - 1;
    curve[i] = shape(type, a, x);
  }
  return curve;
}

function shape(type: Exclude<DriveType, "off">, a: number, x: number): number {
  switch (type) {
    case "soft": {
      // Tube-like: rounds the peaks off smoothly. k → 0 is a straight line.
      const k = 0.001 + a * 12;
      return Math.tanh(k * x) / Math.tanh(k);
    }
    case "hard": {
      // Pushes the signal into a much harder knee: buzzy, aggressive.
      const k = 1 + a * 30;
      const y = k * x;
      return y / Math.pow(1 + Math.pow(Math.abs(y), 8), 1 / 8);
    }
    case "crush": {
      // Fewer bits: 10 bits (barely there) down to 3 (very crunchy).
      const bits = 10 - a * 7;
      const levels = Math.pow(2, bits - 1);
      // Round away from zero on both sides (Math.round alone is lopsided for negatives).
      return Math.max(-1, Math.min(1, (Math.sign(x) * Math.round(Math.abs(x) * levels)) / levels));
    }
  }
}

/** Level after the shaper, so turning the drive up doesn't just make it louder. */
export function driveMakeup(type: Exclude<DriveType, "off">, amount: number): number {
  return type === "crush" ? 1 : 1 / (1 + 1.5 * Math.max(0, Math.min(1, amount)));
}
