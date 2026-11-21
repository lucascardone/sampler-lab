/** 75.123 → "1:15.123" */
export function formatTime(secs: number): string {
  const s = Math.max(0, secs);
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(3).padStart(6, "0");
  return `${m}:${rest}`;
}

/** 75.4 → "1:15" (for durations in lists) */
export function formatShort(secs: number): string {
  const s = Math.max(0, secs);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return m > 0 ? `${m}:${Math.floor(rest).toString().padStart(2, "0")}` : `${rest.toFixed(1)} s`;
}

/** Rough "about N seconds/minutes" for ETAs. */
export function formatEta(secs: number | null | undefined): string {
  if (secs == null || !isFinite(secs)) return "";
  if (secs < 60) return `${Math.max(1, Math.round(secs))} s`;
  return `${Math.round(secs / 60)} min`;
}
