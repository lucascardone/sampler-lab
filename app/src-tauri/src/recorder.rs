//! Record what the computer is playing (system audio) straight to a WAV file.
//!
//! - **Windows**: WASAPI loopback (cpal opens the default *output* device as an input).
//! - **Linux**: works if the PulseAudio/PipeWire "monitor" is the default input (TODO: pick it
//!   explicitly). **macOS**: needs a loopback driver such as BlackHole for now (Fase 3b).
//!
//! Audio is written to disk while recording (not kept in RAM), so long recordings are fine.
//! WASAPI only delivers audio while something is playing: if you pause the song, the
//! recording simply doesn't grow — no long silent gaps.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample};
use hound::{SampleFormat as WavFmt, WavSpec, WavWriter};
use serde::Serialize;
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Below this peak level a whole recording counts as silence (nothing was playing, or the
/// player blocks capture, like DRM-protected video).
const SILENCE_PEAK: f32 = 1e-4;
/// How often the recording thread reports progress.
const TICK: Duration = Duration::from_millis(250);

/// Live info for the UI / tray while recording.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tick {
    pub seconds: f64,
    /// Peak level since the previous tick, 0..1 (to show that sound is coming in).
    pub level: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub path: PathBuf,
    pub seconds: f64,
    /// True if nothing audible was captured (the file is deleted in that case).
    pub silent: bool,
}

/// Writes interleaved f32 blocks to a 24-bit WAV and keeps simple stats. Separate from the
/// device code so it can be tested without a sound card.
pub struct RecordingWriter {
    writer: WavWriter<BufWriter<File>>,
    channels: u16,
    sample_rate: u32,
    frames: u64,
    peak: f32,
    tick_peak: f32,
}

impl RecordingWriter {
    pub fn create(path: &Path, channels: u16, sample_rate: u32) -> Result<Self, String> {
        let spec = WavSpec { channels, sample_rate, bits_per_sample: 24, sample_format: WavFmt::Int };
        let writer = WavWriter::create(path, spec).map_err(|e| e.to_string())?;
        Ok(Self { writer, channels, sample_rate, frames: 0, peak: 0.0, tick_peak: 0.0 })
    }

    pub fn write(&mut self, interleaved: &[f32]) -> Result<(), String> {
        const MAX: f32 = 8_388_607.0; // 2^23 - 1
        for &s in interleaved {
            let a = s.abs();
            self.peak = self.peak.max(a);
            self.tick_peak = self.tick_peak.max(a);
            self.writer
                .write_sample((s.clamp(-1.0, 1.0) * MAX).round() as i32)
                .map_err(|e| e.to_string())?;
        }
        self.frames += (interleaved.len() / self.channels as usize) as u64;
        Ok(())
    }

    pub fn seconds(&self) -> f64 {
        self.frames as f64 / self.sample_rate as f64
    }

    /// Peak since the last call (resets).
    pub fn take_tick_peak(&mut self) -> f32 {
        std::mem::take(&mut self.tick_peak)
    }

    /// Finalize the file. Silent recordings are deleted.
    pub fn finish(self, path: &Path) -> Result<Finished, String> {
        let seconds = self.seconds();
        let silent = self.frames == 0 || self.peak < SILENCE_PEAK;
        self.writer.finalize().map_err(|e| e.to_string())?;
        if silent {
            let _ = std::fs::remove_file(path);
        }
        Ok(Finished { path: path.to_path_buf(), seconds, silent })
    }
}

/// A recording in progress. Dropping it without `stop` still finalizes the file.
pub struct Recording {
    pub path: PathBuf,
    pub started: Instant,
    stop_tx: mpsc::Sender<()>,
    handle: Option<JoinHandle<Result<Finished, String>>>,
}

impl Recording {
    /// Start recording system audio into `path`. `on_tick` is called ~4×/s from the
    /// recording thread.
    pub fn start(path: PathBuf, on_tick: impl Fn(Tick) + Send + 'static) -> Result<Self, String> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let thread_path = path.clone();

        // cpal streams aren't Send on every platform: build, run and drop the stream on
        // this one thread.
        let handle = std::thread::Builder::new()
            .name("recorder".into())
            .spawn(move || run(thread_path, stop_rx, ready_tx, on_tick))
            .map_err(|e| e.to_string())?;

        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self { path, started: Instant::now(), stop_tx, handle: Some(handle) }),
            Ok(Err(e)) => {
                let _ = handle.join();
                Err(e)
            }
            Err(_) => Err("El dispositivo de audio no respondió".into()),
        }
    }

    pub fn stop(mut self) -> Result<Finished, String> {
        self.stop_inner()
    }

    fn stop_inner(&mut self) -> Result<Finished, String> {
        let _ = self.stop_tx.send(());
        match self.handle.take() {
            Some(h) => h.join().map_err(|_| "El grabador se cerró inesperadamente".to_string())?,
            None => Err("La grabación ya terminó".into()),
        }
    }
}

impl Drop for Recording {
    fn drop(&mut self) {
        if self.handle.is_some() {
            let _ = self.stop_inner();
        }
    }
}

fn run(
    path: PathBuf,
    stop_rx: Receiver<()>,
    ready_tx: mpsc::Sender<Result<(), String>>,
    on_tick: impl Fn(Tick),
) -> Result<Finished, String> {
    let setup = || -> Result<(cpal::Stream, Receiver<Vec<f32>>, RecordingWriter), String> {
        let host = cpal::default_host();
        let device = capture_device(&host)?;
        let config = device
            .default_output_config()
            .or_else(|_| device.default_input_config())
            .map_err(|e| format!("No se pudo leer el formato de audio: {e}"))?;
        let channels = config.channels();
        let writer = RecordingWriter::create(&path, channels, config.sample_rate().0)?;

        // Generous queue (~10 s at typical block sizes): the disk thread never blocks the
        // audio callback; if the disk stalls longer than that, blocks are dropped.
        let (tx, rx) = mpsc::sync_channel::<Vec<f32>>(1024);
        let stream_config: cpal::StreamConfig = config.clone().into();
        let stream = match config.sample_format() {
            SampleFormat::F32 => build::<f32>(&device, &stream_config, tx),
            SampleFormat::I16 => build::<i16>(&device, &stream_config, tx),
            SampleFormat::I32 => build::<i32>(&device, &stream_config, tx),
            SampleFormat::U16 => build::<u16>(&device, &stream_config, tx),
            other => return Err(format!("Formato de audio no soportado: {other}")),
        }?;
        stream.play().map_err(|e| format!("No se pudo empezar a grabar: {e}"))?;
        Ok((stream, rx, writer))
    };

    let (stream, rx, mut writer) = match setup() {
        Ok(v) => {
            let _ = ready_tx.send(Ok(()));
            v
        }
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            let _ = ready_tx.send(Err(e.clone()));
            return Err(e);
        }
    };

    let mut last_tick = Instant::now();
    let result = loop {
        if stop_rx.try_recv().is_ok() {
            break Ok(());
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(block) => {
                if let Err(e) = writer.write(&block) {
                    break Err(e);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break Err("Se desconectó el dispositivo de audio".into()),
        }
        if last_tick.elapsed() >= TICK {
            last_tick = Instant::now();
            on_tick(Tick { seconds: writer.seconds(), level: writer.take_tick_peak() });
        }
    };

    drop(stream);
    // Keep whatever arrived before the stream stopped.
    while let Ok(block) = rx.try_recv() {
        let _ = writer.write(&block);
    }
    let finished = writer.finish(&path)?;
    result.map(|_| finished)
}

/// The device whose sound we capture.
fn capture_device(host: &cpal::Host) -> Result<cpal::Device, String> {
    #[cfg(windows)]
    {
        // Loopback: an output device used as input records what it plays.
        host.default_output_device().ok_or_else(|| "No hay un dispositivo de salida de audio".to_string())
    }
    #[cfg(not(windows))]
    {
        // Linux: select the "Monitor of ..." source as default input. macOS: BlackHole.
        host.default_input_device().ok_or_else(|| "No hay un dispositivo de entrada de audio".to_string())
    }
}

fn build<T>(device: &cpal::Device, config: &cpal::StreamConfig, tx: SyncSender<Vec<f32>>) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: cpal::FromSample<T>,
{
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                let block: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
                let _ = tx.try_send(block); // never block the audio thread
            },
            |e| eprintln!("recorder stream error: {e}"),
            None,
        )
        .map_err(|e| format!("No se pudo abrir la captura de audio: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writer_counts_frames_and_keeps_audio() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("r.wav");
        let mut w = RecordingWriter::create(&p, 2, 48_000).unwrap();
        w.write(&[0.5, -0.5, 0.25, -0.25]).unwrap();
        w.write(&vec![0.1; 48_000 * 2]).unwrap();
        assert!((w.seconds() - (48_002.0 / 48_000.0)).abs() < 1e-9);
        assert!((w.take_tick_peak() - 0.5).abs() < 1e-6);
        assert_eq!(w.take_tick_peak(), 0.0, "tick peak resets");
        let f = w.finish(&p).unwrap();
        assert!(!f.silent);
        let r = hound::WavReader::open(&p).unwrap();
        assert_eq!((r.spec().channels, r.spec().sample_rate, r.spec().bits_per_sample), (2, 48_000, 24));
        assert_eq!(r.duration(), 48_002);
    }

    #[test]
    fn silent_recordings_are_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.wav");
        let mut w = RecordingWriter::create(&p, 2, 44_100).unwrap();
        w.write(&vec![0.0; 44_100 * 2]).unwrap();
        let f = w.finish(&p).unwrap();
        assert!(f.silent);
        assert!(!p.exists());

        let p2 = dir.path().join("empty.wav");
        let f2 = RecordingWriter::create(&p2, 2, 44_100).unwrap().finish(&p2).unwrap();
        assert!(f2.silent && !p2.exists());
    }

    /// Records 2 s of real system audio. Play something first, then:
    /// `cargo test -- --ignored records_system_audio --nocapture`
    #[test]
    #[ignore]
    fn records_system_audio() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("live.wav");
        let ticks = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let t2 = ticks.clone();
        let rec = Recording::start(p.clone(), move |_| {
            t2.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        })
        .unwrap();
        std::thread::sleep(Duration::from_secs(2));
        let f = rec.stop().unwrap();
        println!("{f:?}, ticks={}", ticks.load(std::sync::atomic::Ordering::Relaxed));
        assert!(ticks.load(std::sync::atomic::Ordering::Relaxed) >= 4);
    }
}
