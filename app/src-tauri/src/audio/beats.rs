//! Beat grid of a whole track (work in progress: F5.1 spike measurements live here for now).

#[cfg(test)]
mod spike {
    use crate::audio::AudioBuffer;
    use crate::audio::stretch::stretch;
    use std::f32::consts::PI;
    use std::time::Instant;

    /// `SAMPLER_TEST_AUDIO="a.mp3;b.mp3" cargo test spike_real -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn spike_real_files() {
        let Ok(list) = std::env::var("SAMPLER_TEST_AUDIO") else { return };
        for path in list.split(';').filter(|s| !s.is_empty()) {
            let t = Instant::now();
            let buf = crate::audio::decode::decode_file(std::path::Path::new(path)).unwrap();
            let decode = t.elapsed().as_secs_f32();
            let mb = buf.num_frames() * buf.num_channels() * 4 / 1_000_000;
            println!("{path}\n  {} Hz, {} ch, {:.1} s, {mb} MB as f32; decode {decode:.2} s", buf.sample_rate, buf.num_channels(), buf.duration_secs());
            let t = Instant::now();
            let a = crate::audio::analysis::analyze(&buf);
            println!("  analyze (existing, whole file): {:.2} s → tempo {:?} key {:?}", t.elapsed().as_secs_f32(), a.tempo, a.key);
            for factor in [1.0 / 1.06, 1.06] {
                let t = Instant::now();
                let s = stretch(&buf, factor);
                println!("  stretch ×{factor:.4}: {:.2} s ({:.1} s out)", t.elapsed().as_secs_f32(), s.duration_secs());
            }
        }
    }

    /// Four-on-the-floor: an impulse + decaying 55 Hz "kick" on every beat, noise hats on the
    /// off-beats and a sustained chord, so WSOLA has tonal material to align on.
    fn groove(sr: u32, bpm: f32, secs: f32) -> (Vec<f32>, Vec<usize>) {
        let n = (sr as f32 * secs) as usize;
        let mut x = vec![0.0f32; n];
        for (i, v) in x.iter_mut().enumerate() {
            let t = i as f32 / sr as f32;
            *v = 0.08 * ((2.0 * PI * 220.0 * t).sin() + (2.0 * PI * 277.2 * t).sin() + (2.0 * PI * 329.6 * t).sin());
        }
        let beat = 60.0 / bpm;
        let mut kicks = Vec::new();
        let mut seed = 7u32;
        let mut k = 0;
        loop {
            let t = k as f32 * beat / 2.0;
            let s = (t * sr as f32).round() as usize;
            if s + 8000 >= n {
                break;
            }
            if k % 2 == 0 {
                kicks.push(s);
                x[s] += 0.9;
                for i in 0..8000 {
                    let tt = i as f32 / sr as f32;
                    x[s + i] += (2.0 * PI * 55.0 * tt).sin() * (-tt / 0.08).exp() * 0.6;
                }
            } else {
                for i in 0..1500 {
                    let tt = i as f32 / sr as f32;
                    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                    x[s + i] += (seed as f32 / u32::MAX as f32 - 0.5) * (-tt / 0.01).exp() * 0.3;
                }
            }
            k += 1;
        }
        (x, kicks)
    }

    #[test]
    #[ignore]
    fn spike_wsola_jitter() {
        let sr = 44100;
        let (x, kicks) = groove(sr, 126.0, 40.0);
        let buf = AudioBuffer::new(sr, vec![x]);
        for factor in [1.0 / 1.06, 1.0 / 1.03, 1.03, 1.06, 1.12, 0.8] {
            let t = Instant::now();
            let y = stretch(&buf, factor);
            let secs = t.elapsed().as_secs_f32();
            let y = &y.channels[0];
            let (mut worst, mut sum, mut sum_abs, mut weak, mut doubled) = (0.0f32, 0.0f32, 0.0f32, 0, 0);
            let win = (sr as f32 * 0.03) as isize;
            for &k in &kicks[2..kicks.len() - 2] {
                let expect = (k as f64 * factor) as isize;
                let lo = (expect - win).max(0) as usize;
                let hi = ((expect + win) as usize).min(y.len());
                // The impulse is the only place where two consecutive samples jump by ~0.9.
                let mut jumps: Vec<(usize, f32)> = (lo + 1..hi).map(|i| (i, y[i] - y[i - 1])).filter(|j| j.1 > 0.2).collect();
                jumps.sort_by(|a, b| b.1.total_cmp(&a.1));
                let Some(&(pos, amp)) = jumps.first() else {
                    weak += 1;
                    continue;
                };
                if amp < 0.6 {
                    weak += 1;
                }
                if jumps.iter().any(|j| (j.0 as isize - pos as isize).abs() > 8 && j.1 > 0.25) {
                    doubled += 1;
                }
                let off = (pos as isize - expect) as f32 / sr as f32 * 1000.0;
                worst = worst.max(off.abs());
                sum += off;
                sum_abs += off.abs();
            }
            let n = (kicks.len() - 4) as f32;
            println!(
                "×{factor:.4}: {secs:.2} s for 40 s mono · kick timing: mean {:+.2} ms, mean|.| {:.2} ms, worst {worst:.2} ms · weak {weak} · doubled {doubled} of {n}",
                sum / n,
                sum_abs / n
            );
        }
    }
}
