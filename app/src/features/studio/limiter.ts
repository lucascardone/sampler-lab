// Look-ahead brick-wall limiter for exports. Web Audio's compressor (used live) can let
// fast transients through; this one guarantees no sample exceeds the ceiling, so a
// limited export never clips.
//
// Gain is computed from the peak of all channels (linked, keeps the stereo image), drops
// linearly over the look-ahead window *before* a peak, and recovers slowly after it.

export interface LimiterOptions {
  /** Max absolute sample value (0.98 ≈ -0.2 dBFS). */
  ceiling?: number;
  lookaheadMs?: number;
  releaseMs?: number;
}

/** Limit in place. Returns the lowest gain applied (1 = nothing touched). */
export function limit(channels: Float32Array[], sampleRate: number, o: LimiterOptions = {}): number {
  const ceiling = o.ceiling ?? 0.98;
  const n = channels[0]?.length ?? 0;
  if (!n) return 1;
  const attack = Math.max(1, Math.round(((o.lookaheadMs ?? 5) / 1000) * sampleRate));
  const release = Math.max(1, Math.round(((o.releaseMs ?? 80) / 1000) * sampleRate));

  // Gain each sample needs on its own.
  const g = new Float32Array(n);
  let needed = false;
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const ch of channels) p = Math.max(p, Math.abs(ch[i]));
    g[i] = p > ceiling ? ceiling / p : 1;
    if (g[i] < 1) needed = true;
  }
  if (!needed) return 1;

  // Backward pass: start lowering the gain `attack` samples before a peak (look-ahead).
  const down = 1 / attack;
  for (let i = n - 2; i >= 0; i--) g[i] = Math.min(g[i], g[i + 1] + down);
  // Forward pass: recover slowly after it (no pumping clicks).
  const up = 1 / release;
  for (let i = 1; i < n; i++) g[i] = Math.min(g[i], g[i - 1] + up);

  let min = 1;
  for (let i = 0; i < n; i++) {
    min = Math.min(min, g[i]);
    for (const ch of channels) ch[i] *= g[i];
  }
  return min;
}
