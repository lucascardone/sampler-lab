//! Decode any supported file (WAV, AIFF, FLAC, MP3, OGG, AAC/M4A, ALAC) to an AudioBuffer.

use super::AudioBuffer;
use std::fs::File;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CODEC_TYPE_NULL, DecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("no se pudo abrir el archivo: {0}")]
    Io(#[from] std::io::Error),
    #[error("formato no soportado o archivo dañado")]
    Unsupported,
    #[error("el archivo no tiene audio")]
    NoAudio,
    #[error("error al decodificar: {0}")]
    Decode(String),
}

pub fn decode_file(path: &Path) -> Result<AudioBuffer, DecodeError> {
    let file = File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            // Gapless: drop MP3/AAC encoder padding so times match what browsers/DAWs show.
            &FormatOptions { enable_gapless: true, ..Default::default() },
            &MetadataOptions::default(),
        )
        .map_err(|_| DecodeError::Unsupported)?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or(DecodeError::NoAudio)?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|_| DecodeError::Unsupported)?;

    let mut sample_rate = track.codec_params.sample_rate.unwrap_or(0);
    let mut channels: Vec<Vec<f32>> = Vec::new();
    let mut sbuf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // End of stream is reported as an UnexpectedEof I/O error.
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(DecodeError::Decode(e.to_string())),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            // A corrupt frame in an MP3 shouldn't kill the whole import; skip it.
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(DecodeError::Decode(e.to_string())),
        };
        let spec = *decoded.spec();
        let nch = spec.channels.count();
        if channels.is_empty() {
            channels = vec![Vec::new(); nch];
            sample_rate = spec.rate;
        }
        let needed = decoded.capacity() as u64;
        if sbuf.as_ref().is_none_or(|b| (b.capacity() as u64) < needed * nch as u64) {
            sbuf = Some(SampleBuffer::new(needed, spec));
        }
        let sb = sbuf.as_mut().unwrap();
        sb.copy_interleaved_ref(decoded);
        // De-interleave into planar channels.
        for (i, s) in sb.samples().iter().enumerate() {
            channels[i % nch].push(*s);
        }
    }

    if channels.is_empty() || channels[0].is_empty() || sample_rate == 0 {
        return Err(DecodeError::NoAudio);
    }
    Ok(AudioBuffer::new(sample_rate, channels))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::wav::{WavFormat, write_wav};

    #[test]
    fn decodes_wav_written_by_us() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("in.wav");
        let src = AudioBuffer::new(
            44100,
            vec![(0..1000).map(|i| (i as f32 / 1000.0) - 0.5).collect(), vec![0.25; 1000]],
        );
        write_wav(&p, &src, WavFormat::Pcm24).unwrap();

        let out = decode_file(&p).unwrap();
        assert_eq!(out.sample_rate, 44100);
        assert_eq!(out.num_channels(), 2);
        assert_eq!(out.num_frames(), 1000);
        for (a, b) in src.channels[0].iter().zip(&out.channels[0]) {
            assert!((a - b).abs() < 1e-5);
        }
    }

    /// Smoke test against real files (MP3, FLAC, M4A...). Not run by default:
    /// `SAMPLER_TEST_AUDIO="a.mp3;b.flac" cargo test -- --ignored real_files`
    #[test]
    #[ignore]
    fn decodes_real_files() {
        let list = std::env::var("SAMPLER_TEST_AUDIO").expect("set SAMPLER_TEST_AUDIO");
        for p in list.split(';').filter(|s| !s.is_empty()) {
            let b = decode_file(Path::new(p)).unwrap_or_else(|e| panic!("{p}: {e}"));
            println!("{p}: {} Hz, {} ch, {:.2} s, peak {:.3}", b.sample_rate, b.num_channels(), b.duration_secs(), b.peak());
            assert!(b.duration_secs() > 0.1);
            assert!(b.peak() > 0.0);
        }
    }

    #[test]
    fn garbage_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.wav");
        std::fs::write(&p, b"definitely not audio").unwrap();
        assert!(decode_file(&p).is_err());
    }
}
