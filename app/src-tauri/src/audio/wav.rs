//! WAV writing.

use super::AudioBuffer;
use hound::{SampleFormat, WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WavFormat {
    Pcm16,
    Pcm24,
    Float32,
}

/// Channel layout of an exported file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ChannelMode {
    #[default]
    Stereo,
    Mono,
}

/// Convert to the requested layout.
/// - Mono: average of all channels ((L+R)/2), so a centered sound keeps its level.
/// - Stereo: a mono source is duplicated to L/R; stereo stays as is; more than two
///   channels keep the first two.
pub fn with_channels(buf: &AudioBuffer, mode: ChannelMode) -> AudioBuffer {
    let n = buf.num_channels();
    match mode {
        ChannelMode::Mono => {
            if n <= 1 {
                return buf.clone();
            }
            let frames = buf.num_frames();
            let mut out = vec![0.0f32; frames];
            for ch in &buf.channels {
                for (o, s) in out.iter_mut().zip(ch) {
                    *o += s;
                }
            }
            out.iter_mut().for_each(|s| *s /= n as f32);
            AudioBuffer::new(buf.sample_rate, vec![out])
        }
        ChannelMode::Stereo => match n {
            0 => buf.clone(),
            1 => AudioBuffer::new(buf.sample_rate, vec![buf.channels[0].clone(), buf.channels[0].clone()]),
            _ => AudioBuffer::new(buf.sample_rate, buf.channels[..2].to_vec()),
        },
    }
}

/// Write `buf` as an interleaved WAV. Integer formats clip to [-1, 1]; float keeps
/// overs intact (used for the internal preview so the waveform shows real levels).
pub fn write_wav(path: &Path, buf: &AudioBuffer, format: WavFormat) -> Result<(), hound::Error> {
    let (bits, sample_format) = match format {
        WavFormat::Pcm16 => (16, SampleFormat::Int),
        WavFormat::Pcm24 => (24, SampleFormat::Int),
        WavFormat::Float32 => (32, SampleFormat::Float),
    };
    let spec = WavSpec {
        channels: buf.num_channels() as u16,
        sample_rate: buf.sample_rate,
        bits_per_sample: bits,
        sample_format,
    };
    let mut w = WavWriter::create(path, spec)?;
    let frames = buf.num_frames();
    match format {
        WavFormat::Float32 => {
            for i in 0..frames {
                for ch in &buf.channels {
                    w.write_sample(ch[i])?;
                }
            }
        }
        WavFormat::Pcm16 | WavFormat::Pcm24 => {
            let max = ((1i64 << (bits - 1)) - 1) as f32;
            for i in 0..frames {
                for ch in &buf.channels {
                    // Plain rounding, no dither: 24-bit noise floor makes dither irrelevant
                    // for samples, and it keeps exports bit-exact/reproducible.
                    let v = (ch[i].clamp(-1.0, 1.0) * max).round() as i32;
                    w.write_sample(v)?;
                }
            }
        }
    }
    w.finalize()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm24_roundtrip_and_clipping() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.wav");
        let b = AudioBuffer::new(48000, vec![vec![0.0, 0.5, 2.0], vec![-0.5, -2.0, 0.25]]);
        write_wav(&p, &b, WavFormat::Pcm24).unwrap();

        let mut r = hound::WavReader::open(&p).unwrap();
        let spec = r.spec();
        assert_eq!((spec.channels, spec.sample_rate, spec.bits_per_sample), (2, 48000, 24));
        let s: Vec<i32> = r.samples::<i32>().map(Result::unwrap).collect();
        let max = (1 << 23) - 1;
        // Interleaved L R L R ...; overs clipped to full scale.
        assert_eq!(s, vec![0, -(max + 1) / 2, (max + 1) / 2, -max, max, max / 4 + 1]);
    }

    #[test]
    fn mono_is_the_average_of_channels() {
        let b = AudioBuffer::new(10, vec![vec![1.0, 0.5, -1.0], vec![1.0, -0.5, 0.0]]);
        let m = with_channels(&b, ChannelMode::Mono);
        assert_eq!(m.channels, vec![vec![1.0, 0.0, -0.5]]);
        // Already mono: unchanged.
        assert_eq!(with_channels(&m, ChannelMode::Mono), m);
    }

    #[test]
    fn stereo_duplicates_mono_and_keeps_stereo() {
        let m = AudioBuffer::new(10, vec![vec![0.1, 0.2]]);
        assert_eq!(with_channels(&m, ChannelMode::Stereo).channels, vec![vec![0.1, 0.2], vec![0.1, 0.2]]);
        let quad = AudioBuffer::new(10, vec![vec![1.0], vec![2.0], vec![3.0], vec![4.0]]);
        assert_eq!(with_channels(&quad, ChannelMode::Stereo).channels, vec![vec![1.0], vec![2.0]]);
    }

    #[test]
    fn mono_export_writes_one_channel() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("m.wav");
        let b = AudioBuffer::new(44100, vec![vec![0.5; 100], vec![0.0; 100]]);
        write_wav(&p, &with_channels(&b, ChannelMode::Mono), WavFormat::Pcm24).unwrap();
        let r = hound::WavReader::open(&p).unwrap();
        assert_eq!((r.spec().channels, r.spec().bits_per_sample, r.duration()), (1, 24, 100));
    }

    #[test]
    fn float32_keeps_overs() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.wav");
        let b = AudioBuffer::new(44100, vec![vec![1.5, -0.25]]);
        write_wav(&p, &b, WavFormat::Float32).unwrap();
        let s: Vec<f32> = hound::WavReader::open(&p)
            .unwrap()
            .samples::<f32>()
            .map(Result::unwrap)
            .collect();
        assert_eq!(s, vec![1.5, -0.25]);
    }
}
