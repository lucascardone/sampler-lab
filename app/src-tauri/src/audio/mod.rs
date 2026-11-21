//! Core audio types and DSP. Everything in here is pure (no Tauri, no I/O except
//! `decode`/`wav`) so it can be unit-tested with `cargo test`.

pub mod analysis;
pub mod beats;
pub mod decode;
pub mod ops;
pub mod stretch;
pub mod wav;
pub mod zero_cross;

use serde::{Deserialize, Serialize};

/// In-memory audio, stored planar: `channels[c][frame]`. Samples are f32 in [-1, 1]
/// nominally, but values outside that range are allowed until export (so gain → normalize
/// round-trips without losing information).
#[derive(Debug, Clone, PartialEq)]
pub struct AudioBuffer {
    pub sample_rate: u32,
    pub channels: Vec<Vec<f32>>,
}

impl AudioBuffer {
    pub fn new(sample_rate: u32, channels: Vec<Vec<f32>>) -> Self {
        debug_assert!(
            channels.windows(2).all(|w| w[0].len() == w[1].len()),
            "all channels must have the same length"
        );
        Self { sample_rate, channels }
    }

    pub fn num_channels(&self) -> usize {
        self.channels.len()
    }

    pub fn num_frames(&self) -> usize {
        self.channels.first().map_or(0, Vec::len)
    }

    pub fn duration_secs(&self) -> f64 {
        self.num_frames() as f64 / self.sample_rate as f64
    }

    /// Highest absolute sample value across all channels.
    pub fn peak(&self) -> f32 {
        self.channels
            .iter()
            .flat_map(|c| c.iter())
            .fold(0.0_f32, |m, s| m.max(s.abs()))
    }

    pub fn secs_to_frames(&self, secs: f64) -> usize {
        (secs.max(0.0) * self.sample_rate as f64).round() as usize
    }
}

/// A half-open frame range `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrameRange {
    pub start: usize,
    pub end: usize,
}

impl FrameRange {
    pub fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }

    /// Clamp to `[0, len)` and make sure `start <= end`.
    pub fn clamped(self, len: usize) -> Self {
        let a = self.start.min(len);
        let b = self.end.min(len);
        Self { start: a.min(b), end: a.max(b) }
    }

    pub fn len(&self) -> usize {
        self.end - self.start
    }

    pub fn is_empty(&self) -> bool {
        self.end <= self.start
    }
}
