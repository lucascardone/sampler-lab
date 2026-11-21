// Pad colors: every sound keeps one color everywhere (its row, lit steps, piano-roll
// notes, clips, inspector), like the pads of a hardware sampler. Derived from the
// channel id, so a sound keeps its color when others are added or removed.

export const PADS = ["#ff8a7a", "#ffc061", "#c4e06a", "#5fd4c4", "#73b7ff", "#b39dff", "#f48fc6", "#e6c48f"];

export function padColor(channelId: string): string {
  const n = Number(channelId.replace(/\D/g, "")) || 0;
  // ch1 (the kick of a new song) gets the first color.
  return PADS[(n - 1 + PADS.length) % PADS.length];
}

/**
 * A stable color per pattern id (its clips, its swatch in the pattern list). Ids are
 * sequential ("pat3", "pat4"), so hues step by the golden angle: neighbours look apart.
 */
export function patternColor(id: string): string {
  const n = Number(id.replace(/\D/g, ""));
  let h = 0;
  if (Number.isFinite(n) && /\d/.test(id)) h = (n * 137.508) % 360;
  else for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  // Light enough that the dark label on a clip keeps ≥4.5:1 contrast at every hue.
  return `hsl(${Math.round(h)} 60% 70%)`;
}
