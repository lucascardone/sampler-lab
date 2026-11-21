//! Musical analysis of a sample: its note (pitch), key and tempo.
//!
//! - **Pitch**: YIN on the loudest parts → the note a sample "is" (so the studio can tune
//!   it: its root note).
//! - **Key**: chromagram (energy per pitch class) correlated with the Krumhansl–Kessler
//!   major/minor profiles.
//! - **Tempo**: onset strength (spectral flux) → autocorrelation, with a mild preference
//!   for tempos around 120 BPM (like most beat trackers), and the best lag refined.
//!
//! Every result comes with a confidence 0..1; the UI only acts on confident ones.

use super::AudioBuffer;
use rustfft::{FftPlanner, num_complex::Complex};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pitch {
    /// Nearest MIDI note (69 = A4).
    pub midi: i32,
    /// Deviation from that note, -50..50 cents.
    pub cents: f32,
    pub hz: f32,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Key {
    /// 0 = C … 11 = B.
    pub tonic: u8,
    pub minor: bool,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tempo {
    pub bpm: f32,
    /// The other reading of the same pulse (double or half): trackers can't always tell
    /// "half-time 70" from "138". The UI offers it as a one-click alternative.
    pub alternative: f32,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub pitch: Option<Pitch>,
    pub key: Option<Key>,
    pub tempo: Option<Tempo>,
    pub duration: f64,
}

pub fn analyze(buf: &AudioBuffer) -> Analysis {
    let mono = mono(buf);
    let sr = buf.sample_rate as f32;
    Analysis {
        pitch: detect_pitch(&mono, sr),
        key: detect_key(&mono, sr),
        tempo: detect_tempo(&mono, sr),
        duration: buf.duration_secs(),
    }
}

fn mono(buf: &AudioBuffer) -> Vec<f32> {
    let n = buf.num_frames();
    let ch = buf.num_channels().max(1) as f32;
    (0..n).map(|i| buf.channels.iter().map(|c| c[i]).sum::<f32>() / ch).collect()
}

fn hann(n: usize) -> Vec<f32> {
    (0..n).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos()).collect()
}

/// Magnitude spectra of overlapping Hann-windowed frames.
fn stft(x: &[f32], size: usize, hop: usize) -> Vec<Vec<f32>> {
    if x.len() < size {
        return Vec::new();
    }
    let fft = FftPlanner::new().plan_fft_forward(size);
    let win = hann(size);
    let mut buf = vec![Complex::new(0.0f32, 0.0); size];
    (0..=(x.len() - size) / hop)
        .map(|f| {
            let s = f * hop;
            for i in 0..size {
                buf[i] = Complex::new(x[s + i] * win[i], 0.0);
            }
            fft.process(&mut buf);
            buf[..size / 2].iter().map(|c| c.norm()).collect()
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Pitch (YIN)
// ---------------------------------------------------------------------------

const YIN_THRESHOLD: f32 = 0.15;

/// YIN on one frame: (f0 Hz, aperiodicity 0..1), or None if nothing periodic.
fn yin(frame: &[f32], sr: f32, fmin: f32, fmax: f32) -> Option<(f32, f32)> {
    let w = frame.len() / 2;
    let tau_min = (sr / fmax).floor().max(2.0) as usize;
    let tau_max = ((sr / fmin).ceil() as usize).min(w - 1);
    if tau_min >= tau_max {
        return None;
    }
    // Difference function and its cumulative-mean normalization.
    let mut d = vec![0.0f32; tau_max + 2];
    for (tau, dv) in d.iter_mut().enumerate().take(tau_max + 2).skip(1) {
        let mut s = 0.0;
        for j in 0..w {
            let diff = frame[j] - frame[j + tau];
            s += diff * diff;
        }
        *dv = s;
    }
    let mut cmnd = vec![1.0f32; tau_max + 2];
    let mut running = 0.0;
    for tau in 1..tau_max + 2 {
        running += d[tau];
        cmnd[tau] = if running > 0.0 { d[tau] * tau as f32 / running } else { 1.0 };
    }
    // First dip under the threshold (avoids octave errors), else the global minimum.
    let mut best = None;
    let mut tau = tau_min;
    while tau <= tau_max {
        if cmnd[tau] < YIN_THRESHOLD {
            while tau < tau_max && cmnd[tau + 1] < cmnd[tau] {
                tau += 1;
            }
            best = Some(tau);
            break;
        }
        tau += 1;
    }
    let tau = best.unwrap_or_else(|| (tau_min..=tau_max).min_by(|&a, &b| cmnd[a].total_cmp(&cmnd[b])).unwrap());
    let ap = cmnd[tau];
    if ap > 0.45 {
        return None;
    }
    // Parabolic interpolation around the minimum for sub-sample accuracy.
    let (a, b, c) = (cmnd[tau - 1], cmnd[tau], cmnd[tau + 1]);
    let den = a - 2.0 * b + c;
    let shift = if den.abs() > 1e-9 { 0.5 * (a - c) / den } else { 0.0 };
    Some((sr / (tau as f32 + shift.clamp(-1.0, 1.0)), ap))
}

pub fn detect_pitch(x: &[f32], sr: f32) -> Option<Pitch> {
    const W: usize = 4096; // half-window 2048 → down to ~25 Hz at 48 kHz
    if x.len() < W {
        return None;
    }
    let hop = W / 2;
    let rms: Vec<(usize, f32)> = (0..=(x.len() - W) / hop)
        .map(|f| {
            let s = &x[f * hop..f * hop + W];
            (f * hop, (s.iter().map(|v| v * v).sum::<f32>() / W as f32).sqrt())
        })
        .collect();
    let loudest = rms.iter().map(|r| r.1).fold(0.0, f32::max);
    if loudest < 1e-3 {
        return None;
    }
    // Analyze the loud frames (up to 24, the loudest first).
    let mut frames: Vec<_> = rms.into_iter().filter(|r| r.1 > loudest * 0.3).collect();
    frames.sort_by(|a, b| b.1.total_cmp(&a.1));
    frames.truncate(24);
    let found: Vec<(f32, f32)> = frames.iter().filter_map(|&(s, _)| yin(&x[s..s + W], sr, 30.0, 2000.0)).collect();
    if found.is_empty() {
        return None;
    }
    // Median in the log domain, then how many frames agree with it (±50 cents).
    let mut notes: Vec<f32> = found.iter().map(|(f, _)| 69.0 + 12.0 * (f / 440.0).log2()).collect();
    notes.sort_by(f32::total_cmp);
    let median = notes[notes.len() / 2];
    let agree: Vec<&(f32, f32)> = found
        .iter()
        .filter(|(f, _)| (69.0 + 12.0 * (f / 440.0).log2() - median).abs() <= 0.5)
        .collect();
    let mean_ap = agree.iter().map(|(_, a)| a).sum::<f32>() / agree.len() as f32;
    let confidence = (agree.len() as f32 / frames.len() as f32) * (1.0 - mean_ap).clamp(0.0, 1.0);
    let midi_f = agree.iter().map(|(f, _)| 69.0 + 12.0 * (f / 440.0).log2()).sum::<f32>() / agree.len() as f32;
    let midi = midi_f.round() as i32;
    Some(Pitch {
        midi,
        cents: ((midi_f - midi as f32) * 100.0).clamp(-50.0, 50.0),
        hz: 440.0 * 2f32.powf((midi_f - 69.0) / 12.0),
        confidence,
    })
}

// ---------------------------------------------------------------------------
// Key (chroma + Krumhansl–Kessler)
// ---------------------------------------------------------------------------

const MAJOR: [f32; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR: [f32; 12] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

pub fn chroma(x: &[f32], sr: f32) -> [f32; 12] {
    const N: usize = 8192;
    let mut c = [0.0f32; 12];
    for spec in stft(x, N, N / 2) {
        for (bin, m) in spec.iter().enumerate().skip(1) {
            let f = bin as f32 * sr / N as f32;
            if !(55.0..=5000.0).contains(&f) {
                continue;
            }
            let pc = ((69.0 + 12.0 * (f / 440.0).log2()).round() as i32).rem_euclid(12) as usize;
            // Log compression: a loud bass shouldn't drown everything else. But the bass
            // line counts double: it's what tells A minor from C major (same notes).
            let w = if f < 260.0 { 2.0 } else { 1.0 };
            c[pc] += w * (1.0 + 100.0 * m).ln();
        }
    }
    c
}

fn pearson(a: &[f32; 12], b: &[f32; 12]) -> f32 {
    let ma = a.iter().sum::<f32>() / 12.0;
    let mb = b.iter().sum::<f32>() / 12.0;
    let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
    for i in 0..12 {
        num += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma).powi(2);
        db += (b[i] - mb).powi(2);
    }
    if da <= 0.0 || db <= 0.0 { 0.0 } else { num / (da * db).sqrt() }
}

pub fn detect_key(x: &[f32], sr: f32) -> Option<Key> {
    let c = chroma(x, sr);
    if c.iter().sum::<f32>() <= 0.0 {
        return None;
    }
    let mut scores: Vec<(f32, u8, bool)> = Vec::with_capacity(24);
    for tonic in 0..12u8 {
        for (minor, prof) in [(false, &MAJOR), (true, &MINOR)] {
            let mut rot = [0.0f32; 12];
            for i in 0..12 {
                rot[(i + tonic as usize) % 12] = prof[i];
            }
            scores.push((pearson(&c, &rot), tonic, minor));
        }
    }
    scores.sort_by(|a, b| b.0.total_cmp(&a.0));
    let (best, tonic, minor) = scores[0];
    if best <= 0.0 {
        return None;
    }
    // Clear winner and a good fit = confident. Relative keys (C / Am) are often close.
    let margin = (best - scores[1].0).max(0.0);
    let confidence = (best * 0.7 + (margin * 4.0).min(1.0) * 0.3).clamp(0.0, 1.0);
    Some(Key { tonic, minor, confidence })
}

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

/// Onset strength per frame (spectral flux of the log spectrum) and the frame rate.
pub fn onset_envelope(x: &[f32], sr: f32) -> (Vec<f32>, f32) {
    const N: usize = 2048;
    let hop = (sr / 100.0).round() as usize; // ~100 frames per second
    let spec = stft(x, N, hop);
    let mut env = Vec::with_capacity(spec.len());
    let mut prev: Option<Vec<f32>> = None;
    for s in spec {
        let logm: Vec<f32> = s.iter().map(|m| (1.0 + 1000.0 * m).ln()).collect();
        let flux = match &prev {
            Some(p) => logm.iter().zip(p).map(|(a, b)| (a - b).max(0.0)).sum::<f32>(),
            None => 0.0,
        };
        env.push(flux);
        prev = Some(logm);
    }
    // Remove the slow trend so only the "hits" remain.
    let w = 16;
    let detr: Vec<f32> = (0..env.len())
        .map(|i| {
            let lo = i.saturating_sub(w);
            let hi = (i + w + 1).min(env.len());
            let mean = env[lo..hi].iter().sum::<f32>() / (hi - lo) as f32;
            (env[i] - mean).max(0.0)
        })
        .collect();
    (detr, sr / hop as f32)
}

pub fn detect_tempo(x: &[f32], sr: f32) -> Option<Tempo> {
    // Under ~2.5 s there aren't enough beats to tell.
    if (x.len() as f32) < sr * 2.5 {
        return None;
    }
    let (env, fps) = onset_envelope(x, sr);
    let n = env.len();
    let lag_for = |bpm: f32| 60.0 * fps / bpm;
    let (min_lag, max_lag) = (lag_for(200.0).floor() as usize, (lag_for(60.0).ceil() as usize).min(n / 2));
    if min_lag < 2 || max_lag <= min_lag + 2 {
        return None;
    }
    let energy: f32 = env.iter().map(|v| v * v).sum();
    if energy <= 0.0 {
        return None;
    }
    let ac: Vec<f32> = (0..=max_lag + 1)
        .map(|lag| env[..n - lag].iter().zip(&env[lag..]).map(|(a, b)| a * b).sum::<f32>() / energy)
        .collect();
    // A tempo is the lag *and its multiples*: summing them favors the true beat over
    // its half/double, then a log-gaussian prior around 120 BPM breaks remaining ties.
    let score = |lag: usize| -> f32 {
        let mut s = 0.0;
        for k in 1..=4 {
            let l = lag * k;
            if l <= max_lag + 1 {
                s += ac[l] / k as f32;
            }
        }
        let bpm = 60.0 * fps / lag as f32;
        let prior = (-0.5 * ((bpm / 120.0).log2() / 0.9).powi(2)).exp();
        s * (0.6 + 0.4 * prior)
    };
    let best = (min_lag..=max_lag).max_by(|&a, &b| score(a).total_cmp(&score(b)))?;
    // Refine with a parabola on the autocorrelation around the best lag.
    let (a, b, c) = (ac[best - 1], ac[best], ac[best + 1]);
    let den = a - 2.0 * b + c;
    let shift = if den.abs() > 1e-9 { (0.5 * (a - c) / den).clamp(-0.5, 0.5) } else { 0.0 };
    let bpm = 60.0 * fps / (best as f32 + shift);
    // Peakiness of the autocorrelation at that lag vs. its typical value.
    let mean = ac[min_lag..=max_lag].iter().sum::<f32>() / (max_lag - min_lag + 1) as f32;
    let confidence = ((b - mean) / (b + 1e-9)).clamp(0.0, 1.0);
    // Without percussion, very fast "tempos" are usually the eighth-note pulse.
    let (bpm, confidence) = if bpm > 180.0 { (bpm / 2.0, confidence * 0.7) } else { (bpm, confidence) };
    let alternative = if bpm < 100.0 { bpm * 2.0 } else { bpm / 2.0 };
    let r = |v: f32| (v * 10.0).round() / 10.0;
    Some(Tempo { bpm: r(bpm), alternative: r(alternative), confidence })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    const SR: f32 = 44100.0;

    fn tone(freqs: &[f32], secs: f32, harmonics: usize) -> Vec<f32> {
        let n = (SR * secs) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / SR;
                freqs
                    .iter()
                    .map(|f| (1..=harmonics).map(|h| (2.0 * PI * f * h as f32 * t).sin() / h as f32).sum::<f32>())
                    .sum::<f32>()
                    * 0.2
            })
            .collect()
    }

    fn hz(midi: f32) -> f32 {
        440.0 * 2f32.powf((midi - 69.0) / 12.0)
    }

    #[test]
    fn pitch_of_sine_and_harmonic_tones() {
        let p = detect_pitch(&tone(&[220.0], 1.0, 1), SR).unwrap();
        assert_eq!(p.midi, 57, "A3");
        assert!(p.cents.abs() < 5.0 && p.confidence > 0.8, "{p:?}");
        // Rich low tone (a bass): fundamental, not an overtone.
        let p = detect_pitch(&tone(&[hz(40.0)], 1.0, 8), SR).unwrap();
        assert_eq!(p.midi, 40, "{p:?}");
        // Slightly flat note: reports the cents.
        let p = detect_pitch(&tone(&[hz(64.0 - 0.2)], 1.0, 3), SR).unwrap();
        assert_eq!(p.midi, 64);
        assert!((p.cents + 20.0).abs() < 4.0, "{p:?}");
    }

    #[test]
    fn noise_and_silence_have_no_confident_pitch() {
        assert!(detect_pitch(&vec![0.0; 44100], SR).is_none());
        let mut seed = 1u32;
        let noise: Vec<f32> = (0..44100)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (seed as f32 / u32::MAX as f32 - 0.5) * 0.5
            })
            .collect();
        assert!(detect_pitch(&noise, SR).is_none_or(|p| p.confidence < 0.4));
    }

    /// Chords of a progression, one per second.
    fn progression(chords: &[&[f32]]) -> Vec<f32> {
        chords.iter().flat_map(|c| tone(&c.iter().map(|&m| hz(m)).collect::<Vec<_>>(), 1.0, 3)).collect()
    }

    #[test]
    fn key_of_progressions() {
        // Am F C G (i–VI–III–VII in A minor), bass on the tonic first.
        let am = progression(&[&[45.0, 57.0, 60.0, 64.0], &[41.0, 57.0, 60.0, 65.0], &[48.0, 55.0, 60.0, 64.0], &[43.0, 55.0, 59.0, 62.0], &[45.0, 57.0, 60.0, 64.0]]);
        let k = detect_key(&am, SR).unwrap();
        assert_eq!((k.tonic, k.minor), (9, true), "{k:?}");
        // D major: D G A D.
        let d = progression(&[&[50.0, 62.0, 66.0, 69.0], &[43.0, 62.0, 67.0, 71.0], &[45.0, 61.0, 64.0, 69.0], &[50.0, 62.0, 66.0, 69.0]]);
        let k = detect_key(&d, SR).unwrap();
        assert_eq!((k.tonic, k.minor), (2, false), "{k:?}");
    }

    /// A drum loop: kicks on beats, hats on 8ths, at `bpm`.
    fn beat(bpm: f32, secs: f32) -> Vec<f32> {
        let n = (SR * secs) as usize;
        let mut x = vec![0.0f32; n];
        let beat = 60.0 / bpm;
        let mut seed = 7u32;
        let mut t = 0.0;
        let mut k = 0;
        while t < secs {
            let s = (t * SR) as usize;
            let kick = k % 2 == 0;
            let len = if kick { 6000 } else { 1500 };
            for i in 0..len.min(n.saturating_sub(s)) {
                let tt = i as f32 / SR;
                x[s + i] += if kick {
                    (2.0 * PI * 60.0 * tt).sin() * (-tt / 0.08).exp() * 0.8
                } else {
                    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                    (seed as f32 / u32::MAX as f32 - 0.5) * (-tt / 0.01).exp() * 0.4
                };
            }
            t += beat / 2.0;
            k += 1;
        }
        x
    }

    #[test]
    fn tempo_of_drum_loops() {
        for bpm in [90.0, 120.0, 128.0, 140.0] {
            let t = detect_tempo(&beat(bpm, 12.0), SR).unwrap();
            assert!((t.bpm - bpm).abs() < 1.0, "{bpm}: {t:?}");
            assert!(t.confidence > 0.3, "{bpm}: {t:?}");
        }
        // Too short to tell.
        assert!(detect_tempo(&beat(120.0, 1.5), SR).is_none());
    }

    #[test]
    fn analyze_combines_everything() {
        let b = AudioBuffer::new(44100, vec![tone(&[220.0], 3.0, 2), tone(&[220.0], 3.0, 2)]);
        let a = analyze(&b);
        assert_eq!(a.pitch.unwrap().midi, 57);
        assert!((a.duration - 3.0).abs() < 1e-3);
    }
}

#[cfg(test)]
mod real_files {
    /// Manual check on real music: `SAMPLER_TEST_AUDIO=a.mp3;b.wav cargo test --release real_music -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_music() {
        let Ok(list) = std::env::var("SAMPLER_TEST_AUDIO") else { return };
        for path in list.split(';') {
            let buf = crate::audio::decode::decode_file(std::path::Path::new(path)).unwrap();
            let t = std::time::Instant::now();
            let a = super::analyze(&buf);
            println!("{path}\n  {a:?}\n  ({:.2} s de análisis para {:.0} s de audio)", t.elapsed().as_secs_f32(), a.duration);
        }
    }
}
