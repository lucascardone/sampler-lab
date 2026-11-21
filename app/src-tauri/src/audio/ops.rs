//! Non-destructive edit operations. The editor keeps the original audio untouched and a
//! list of `Op`s; rendering = applying the ops in order to a copy of the original.

use super::{AudioBuffer, FrameRange};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Op {
    /// Keep only `range`, discard the rest.
    Trim { range: FrameRange },
    /// Change level by `db` decibels (in `range`, or everywhere).
    Gain { db: f32, range: Option<FrameRange> },
    /// Scale so the loudest sample hits `peak_db` dBFS (e.g. -0.3).
    Normalize { peak_db: f32, range: Option<FrameRange> },
    /// Fade from silence to full level across `range`.
    FadeIn { range: FrameRange },
    /// Fade from full level to silence across `range`.
    FadeOut { range: FrameRange },
    /// Play `range` (or everything) backwards.
    Reverse { range: Option<FrameRange> },
}

pub fn db_to_gain(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// Resolve an optional range to a concrete, clamped one over the whole buffer.
fn resolve(range: Option<FrameRange>, len: usize) -> FrameRange {
    range.unwrap_or(FrameRange::new(0, len)).clamped(len)
}

/// Fade curve: a quarter sine. Smoother than linear (no audible "corner" at the end)
/// and still reaches exactly 0 and 1 at the edges.
fn fade_curve(t: f32) -> f32 {
    (t.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2).sin()
}

fn apply_fade(buf: &mut AudioBuffer, range: FrameRange, fade_in: bool) {
    let r = range.clamped(buf.num_frames());
    let n = r.len();
    if n == 0 {
        return;
    }
    for ch in &mut buf.channels {
        for (i, s) in ch[r.start..r.end].iter_mut().enumerate() {
            // `t` goes 0 → 1 across the range; with n == 1 we treat it as fully faded.
            let t = if n == 1 { 0.0 } else { i as f32 / (n - 1) as f32 };
            let g = if fade_in { fade_curve(t) } else { fade_curve(1.0 - t) };
            *s *= g;
        }
    }
}

fn scale(buf: &mut AudioBuffer, r: FrameRange, gain: f32) {
    for ch in &mut buf.channels {
        ch[r.start..r.end].iter_mut().for_each(|s| *s *= gain);
    }
}

impl Op {
    /// Apply this op in place.
    pub fn apply(&self, buf: &mut AudioBuffer) {
        let len = buf.num_frames();
        match *self {
            Op::Trim { range } => {
                let r = range.clamped(len);
                for ch in &mut buf.channels {
                    ch.truncate(r.end);
                    ch.drain(..r.start);
                }
            }
            Op::Gain { db, range } => scale(buf, resolve(range, len), db_to_gain(db)),
            Op::Normalize { peak_db, range } => {
                let r = resolve(range, len);
                let peak = buf
                    .channels
                    .iter()
                    .flat_map(|c| c[r.start..r.end].iter())
                    .fold(0.0_f32, |m, s| m.max(s.abs()));
                // Silence can't be normalized; leave it alone instead of dividing by zero.
                if peak > 1e-9 {
                    scale(buf, r, db_to_gain(peak_db) / peak);
                }
            }
            Op::FadeIn { range } => apply_fade(buf, range, true),
            Op::FadeOut { range } => apply_fade(buf, range, false),
            Op::Reverse { range } => {
                let r = resolve(range, len);
                for ch in &mut buf.channels {
                    ch[r.start..r.end].reverse();
                }
            }
        }
    }

    /// Short key used by the UI to label history entries (translated on the frontend).
    pub fn label_key(&self) -> &'static str {
        match self {
            Op::Trim { .. } => "trim",
            Op::Gain { .. } => "gain",
            Op::Normalize { .. } => "normalize",
            Op::FadeIn { .. } => "fadeIn",
            Op::FadeOut { .. } => "fadeOut",
            Op::Reverse { .. } => "reverse",
        }
    }
}

/// Render: apply `ops` in order to a copy of `source`.
pub fn render(source: &AudioBuffer, ops: &[Op]) -> AudioBuffer {
    let mut out = source.clone();
    for op in ops {
        op.apply(&mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mono(samples: &[f32]) -> AudioBuffer {
        AudioBuffer::new(10, vec![samples.to_vec()])
    }

    fn approx(a: &[f32], b: &[f32]) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-5)
    }

    #[test]
    fn trim_keeps_range_on_all_channels() {
        let mut b = AudioBuffer::new(10, vec![vec![0., 1., 2., 3., 4.], vec![5., 6., 7., 8., 9.]]);
        Op::Trim { range: FrameRange::new(1, 4) }.apply(&mut b);
        assert_eq!(b.channels, vec![vec![1., 2., 3.], vec![6., 7., 8.]]);
    }

    #[test]
    fn trim_out_of_bounds_is_clamped() {
        let mut b = mono(&[0., 1., 2.]);
        Op::Trim { range: FrameRange::new(2, 99) }.apply(&mut b);
        assert_eq!(b.channels[0], vec![2.]);
    }

    #[test]
    fn gain_plus_6db_roughly_doubles() {
        let mut b = mono(&[0.25, -0.25]);
        Op::Gain { db: 6.0206, range: None }.apply(&mut b);
        assert!(approx(&b.channels[0], &[0.5, -0.5]));
    }

    #[test]
    fn gain_only_touches_range() {
        let mut b = mono(&[1., 1., 1., 1.]);
        Op::Gain { db: -120.0, range: Some(FrameRange::new(1, 3)) }.apply(&mut b);
        assert!(approx(&b.channels[0], &[1., 0., 0., 1.]));
    }

    #[test]
    fn normalize_hits_target_peak() {
        let mut b = AudioBuffer::new(10, vec![vec![0.1, -0.2], vec![0.05, 0.0]]);
        Op::Normalize { peak_db: 0.0, range: None }.apply(&mut b);
        assert!((b.peak() - 1.0).abs() < 1e-5);
        // Relative levels between channels are preserved.
        assert!(approx(&b.channels[1], &[0.25, 0.0]));
    }

    #[test]
    fn normalize_silence_is_noop() {
        let mut b = mono(&[0., 0., 0.]);
        Op::Normalize { peak_db: 0.0, range: None }.apply(&mut b);
        assert_eq!(b.channels[0], vec![0., 0., 0.]);
    }

    #[test]
    fn fade_in_starts_silent_and_ends_full() {
        let mut b = mono(&[1.; 5]);
        Op::FadeIn { range: FrameRange::new(0, 5) }.apply(&mut b);
        let c = &b.channels[0];
        assert!(c[0].abs() < 1e-6);
        assert!((c[4] - 1.0).abs() < 1e-6);
        assert!(c.windows(2).all(|w| w[0] <= w[1]), "fade-in must be monotonic");
    }

    #[test]
    fn fade_out_ends_silent_and_leaves_outside_untouched() {
        let mut b = mono(&[1.; 6]);
        Op::FadeOut { range: FrameRange::new(2, 6) }.apply(&mut b);
        let c = &b.channels[0];
        assert_eq!(&c[..2], &[1., 1.]);
        assert!((c[2] - 1.0).abs() < 1e-6);
        assert!(c[5].abs() < 1e-6);
    }

    #[test]
    fn reverse_range() {
        let mut b = mono(&[0., 1., 2., 3.]);
        Op::Reverse { range: Some(FrameRange::new(1, 4)) }.apply(&mut b);
        assert_eq!(b.channels[0], vec![0., 3., 2., 1.]);
    }

    #[test]
    fn render_does_not_mutate_source() {
        let src = mono(&[0., 1., 2., 3.]);
        let out = render(
            &src,
            &[Op::Reverse { range: None }, Op::Trim { range: FrameRange::new(0, 2) }],
        );
        assert_eq!(out.channels[0], vec![3., 2.]);
        assert_eq!(src.channels[0], vec![0., 1., 2., 3.]);
    }

    #[test]
    fn op_json_shape_is_stable() {
        // The frontend sends ops as JSON; lock the shape down.
        let op: Op = serde_json::from_str(r#"{"type":"gain","db":-3,"range":null}"#).unwrap();
        assert_eq!(op, Op::Gain { db: -3.0, range: None });
    }
}
