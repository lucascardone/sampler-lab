//! Snap edit points to zero crossings so cuts don't click.

use super::AudioBuffer;

/// Mono "sum" at frame `i` (average of all channels). For stereo material a cut is
/// click-free when the summed signal is near zero; perfect per-channel zero crossings
/// rarely coincide, so this is the usual compromise.
fn mono_at(buf: &AudioBuffer, i: usize) -> f32 {
    let n = buf.num_channels().max(1) as f32;
    buf.channels.iter().map(|c| c[i]).sum::<f32>() / n
}

/// Find the zero crossing closest to `frame` within `±window` frames.
///
/// A crossing is a sign change between frames `i-1` and `i`; we return whichever of the
/// two is closer to zero. If there's no crossing in the window (e.g. DC offset or a long
/// silent/flat stretch), we fall back to the quietest frame in the window, which is still
/// the least clicky place to cut.
pub fn nearest_zero_crossing(buf: &AudioBuffer, frame: usize, window: usize) -> usize {
    let len = buf.num_frames();
    if len == 0 {
        return 0;
    }
    // Edges of the file are always valid cut points.
    if frame == 0 || frame >= len {
        return frame.min(len);
    }
    let lo = frame.saturating_sub(window).max(1);
    let hi = (frame + window).min(len - 1);

    let mut best: Option<(usize, usize)> = None; // (distance, frame)
    let mut quietest = (f32::INFINITY, frame);

    for i in lo..=hi {
        let a = mono_at(buf, i - 1);
        let b = mono_at(buf, i);
        if b.abs() < quietest.0 {
            quietest = (b.abs(), i);
        }
        let crosses = (a <= 0.0 && b > 0.0) || (a >= 0.0 && b < 0.0) || b == 0.0;
        if crosses {
            let cand = if a.abs() < b.abs() { i - 1 } else { i };
            let dist = cand.abs_diff(frame);
            if best.is_none_or(|(d, _)| dist < d) {
                best = Some((dist, cand));
            }
        }
    }
    best.map_or(quietest.1, |(_, f)| f)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(len: usize, period: f32) -> AudioBuffer {
        let s = (0..len)
            .map(|i| (i as f32 / period * std::f32::consts::TAU).sin())
            .collect();
        AudioBuffer::new(1000, vec![s])
    }

    #[test]
    fn snaps_to_nearby_crossing_of_sine() {
        // Period 100 → crossings every 50 frames (0, 50, 100, ...).
        let b = sine(1000, 100.0);
        assert_eq!(nearest_zero_crossing(&b, 47, 20), 50);
        assert_eq!(nearest_zero_crossing(&b, 104, 20), 100);
    }

    #[test]
    fn result_is_quiet() {
        let b = sine(1000, 37.3);
        for f in [13, 200, 555, 901] {
            let z = nearest_zero_crossing(&b, f, 30);
            assert!(b.channels[0][z].abs() < 0.1, "frame {z} not near zero");
            assert!(z.abs_diff(f) <= 30);
        }
    }

    #[test]
    fn falls_back_to_quietest_without_crossing() {
        let b = AudioBuffer::new(10, vec![vec![0.9, 0.8, 0.5, 0.7, 0.9, 0.9]]);
        assert_eq!(nearest_zero_crossing(&b, 3, 2), 2);
    }

    #[test]
    fn edges_are_kept() {
        let b = sine(100, 10.0);
        assert_eq!(nearest_zero_crossing(&b, 0, 10), 0);
        assert_eq!(nearest_zero_crossing(&b, 100, 10), 100);
        assert_eq!(nearest_zero_crossing(&b, 500, 10), 100);
    }
}
