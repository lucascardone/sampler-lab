//! Time-stretch without changing pitch (WSOLA: waveform-similarity overlap-add).
//!
//! The output is built from overlapping windowed grains of the input. Grains are taken
//! at the stretched rate, and each one is shifted a little (within a tolerance) to the
//! spot whose waveform best continues the previous grain, so the seams don't phase.
//! It's simple and robust for loops, drums and voices at moderate ratios (±30%);
//! extreme ratios get "grainy", which is the nature of the method.
//!
//! The alignment is computed on the mono mix and applied to every channel, so the
//! stereo image stays intact.

use super::AudioBuffer;

const FRAME: usize = 2048;
const HOP: usize = FRAME / 2; // synthesis hop (50% overlap)
const TOLERANCE: usize = 512;
/// Correlation is computed on a decimated signal (fast), then refined at full rate.
const DECIM: usize = 4;

/// Stretch to `factor` × the original duration (0.5 = twice as fast, 2 = half speed).
pub fn stretch(buf: &AudioBuffer, factor: f64) -> AudioBuffer {
    let n = buf.num_frames();
    if (factor - 1.0).abs() < 1e-4 || n < FRAME * 2 {
        return buf.clone();
    }
    let factor = factor.clamp(0.25, 4.0);
    let out_len = (n as f64 * factor).round() as usize;
    let mono: Vec<f32> = (0..n)
        .map(|i| buf.channels.iter().map(|c| c[i]).sum::<f32>() / buf.num_channels() as f32)
        .collect();
    let deci: Vec<f32> = mono.chunks(DECIM).map(|c| c.iter().sum::<f32>() / c.len() as f32).collect();
    let win: Vec<f32> = (0..FRAME)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FRAME as f32).cos())
        .collect();

    let mut out = vec![vec![0.0f32; out_len + FRAME]; buf.num_channels()];
    let mut norm = vec![0.0f32; out_len + FRAME];
    // Where the previous grain was taken from (to know what "continuing it" means).
    let mut prev_src: isize = 0;
    let mut k = 0usize;
    loop {
        let out_pos = k * HOP;
        if out_pos >= out_len {
            break;
        }
        // Nominal input position for this output position.
        let nominal = (out_pos as f64 / factor) as isize;
        let src = if k == 0 {
            0
        } else {
            best_offset(&mono, &deci, prev_src + HOP as isize, nominal, n)
        };
        for (ch, o) in buf.channels.iter().zip(out.iter_mut()) {
            for i in 0..FRAME {
                let s = src + i as isize;
                if s >= 0 && (s as usize) < n {
                    o[out_pos + i] += ch[s as usize] * win[i];
                }
            }
        }
        for i in 0..FRAME {
            norm[out_pos + i] += win[i];
        }
        prev_src = src;
        k += 1;
    }
    for o in out.iter_mut() {
        for (v, w) in o.iter_mut().zip(&norm) {
            if *w > 1e-3 {
                *v /= w;
            }
        }
        o.truncate(out_len);
    }
    AudioBuffer::new(buf.sample_rate, out)
}

/// Position within `nominal ± TOLERANCE` whose start best matches the natural
/// continuation of the previous grain (`target`).
fn best_offset(mono: &[f32], deci: &[f32], target: isize, nominal: isize, n: usize) -> isize {
    let lo = (nominal - TOLERANCE as isize).max(0);
    let hi = (nominal + TOLERANCE as isize).min(n as isize - FRAME as isize).max(lo);
    if target < 0 || target as usize + HOP > n {
        return nominal.clamp(lo, hi);
    }
    let len = HOP / DECIM; // compare the overlapping half
    let corr = |a: usize, b: usize, data: &[f32], l: usize| -> f32 {
        if a + l > data.len() || b + l > data.len() {
            return f32::MIN;
        }
        let (mut s, mut ea, mut eb) = (0.0f32, 1e-9f32, 1e-9f32);
        for i in 0..l {
            let (x, y) = (data[a + i], data[b + i]);
            s += x * y;
            ea += x * x;
            eb += y * y;
        }
        s / (ea * eb).sqrt()
    };
    // Coarse search on the decimated signal.
    let t = target as usize / DECIM;
    let mut best = (f32::MIN, nominal.clamp(lo, hi));
    let mut p = lo;
    while p <= hi {
        let c = corr(t, p as usize / DECIM, deci, len);
        if c > best.0 {
            best = (c, p);
        }
        p += DECIM as isize;
    }
    // Refine at full rate around the coarse winner.
    let (mut fine, center) = (f32::MIN, best.1);
    let mut chosen = center;
    for p in (center - DECIM as isize).max(lo)..=(center + DECIM as isize).min(hi) {
        let c = corr(target as usize, p as usize, mono, HOP);
        if c > fine {
            fine = c;
            chosen = p;
        }
    }
    chosen
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    const SR: u32 = 44100;

    fn sine(f: f32, secs: f32) -> Vec<f32> {
        (0..(SR as f32 * secs) as usize).map(|i| (2.0 * PI * f * i as f32 / SR as f32).sin() * 0.5).collect()
    }

    /// Dominant frequency by counting zero crossings (fine for a pure tone).
    fn freq(x: &[f32]) -> f32 {
        let core = &x[x.len() / 10..x.len() * 9 / 10];
        let crossings = core.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
        crossings as f32 / 2.0 / (core.len() as f32 / SR as f32)
    }

    #[test]
    fn changes_length_not_pitch() {
        let b = AudioBuffer::new(SR, vec![sine(440.0, 2.0)]);
        for factor in [0.75, 1.3] {
            let s = stretch(&b, factor);
            assert_eq!(s.num_frames(), (b.num_frames() as f64 * factor).round() as usize);
            let f = freq(&s.channels[0]);
            assert!((f - 440.0).abs() < 440.0 * 0.01, "factor {factor}: {f} Hz");
        }
    }

    #[test]
    fn output_is_smooth_and_keeps_level() {
        let b = AudioBuffer::new(SR, vec![sine(220.0, 2.0)]);
        let s = stretch(&b, 1.25);
        let x = &s.channels[0];
        // No clicks: consecutive samples of a 220 Hz sine at 0.5 never jump much.
        let max_step = 2.0 * PI * 220.0 / SR as f32 * 0.5 * 1.5;
        let worst = x.windows(2).skip(SR as usize / 10).take(x.len() - SR as usize / 5).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max);
        assert!(worst < max_step, "jump {worst} > {max_step}");
        let rms = |v: &[f32]| (v.iter().map(|a| a * a).sum::<f32>() / v.len() as f32).sqrt();
        assert!((rms(x) - rms(&b.channels[0])).abs() < 0.03);
    }

    #[test]
    fn keeps_rhythm_positions() {
        // Clicks every 0.5 s; stretched ×1.2 they should land every 0.6 s.
        let mut x = vec![0.0f32; SR as usize * 3];
        for k in 0..6 {
            let s = k * SR as usize / 2;
            for i in 0..200 {
                x[s + i] = (1.0 - i as f32 / 200.0) * if i % 2 == 0 { 0.9 } else { -0.9 };
            }
        }
        let s = stretch(&AudioBuffer::new(SR, vec![x]), 1.2);
        let y = &s.channels[0];
        for k in 1..5 {
            let expect = (k as f32 * 0.6 * SR as f32) as usize;
            let win = &y[expect - 2000..expect + 2000];
            let (pos, _) = win.iter().enumerate().fold((0, 0.0f32), |a, (i, v)| if v.abs() > a.1 { (i, v.abs()) } else { a });
            let off_ms = (pos as f32 - 2000.0) / SR as f32 * 1000.0;
            assert!(off_ms.abs() < 25.0, "click {k} off by {off_ms} ms");
        }
    }

    #[test]
    fn stereo_channels_stay_aligned_and_identity_is_exact() {
        let l = sine(330.0, 1.0);
        let b = AudioBuffer::new(SR, vec![l.clone(), l.iter().map(|v| -v).collect()]);
        let s = stretch(&b, 0.8);
        for i in 0..s.num_frames() {
            assert!((s.channels[0][i] + s.channels[1][i]).abs() < 1e-5);
        }
        assert_eq!(stretch(&b, 1.0), b);
    }
}
