//! The session model: sources (audio files / stems) and the samples cut from them.
//!
//! - A **source** is decoded audio: the imported file, or a stem produced by separation.
//! - A **sample** is a range of a source plus its own **effect chain**. Effects can be
//!   toggled, removed and reordered at any time; the sample is re-rendered from the
//!   untouched source every time (non-destructive).
//! - Each sample has its own undo/redo of its effect chain.
//!
//! This module has no Tauri dependency so it can be unit-tested directly.

use crate::audio::ops::{Op, render};
use crate::audio::{AudioBuffer, FrameRange};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("No se encontró el audio de origen")]
    SourceNotFound,
    #[error("No se encontró el sample")]
    SampleNotFound,
    #[error("No se encontró el efecto")]
    EffectNotFound,
    #[error("La selección está vacía")]
    EmptyRange,
}

pub type Result<T> = std::result::Result<T, ProjectError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SourceKind {
    /// A file the user imported (or, in Fase 3, a recording).
    File,
    /// A stem separated from a sample.
    Stem { parent_sample_id: String, stem: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub name: String,
    /// Where the audio lives on disk (original file, or the stem WAV in the session folder).
    pub path: PathBuf,
    /// WAV the UI loads to draw/play it (decoded by us, so times line up exactly).
    pub preview_path: PathBuf,
    pub kind: SourceKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub id: String,
    pub enabled: bool,
    pub op: Op,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub id: String,
    pub name: String,
    pub source_id: String,
    /// Range within the source, in source frames.
    pub range: FrameRange,
    pub effects: Vec<Effect>,
    #[serde(skip)]
    undo: Vec<Vec<Effect>>,
    #[serde(skip)]
    redo: Vec<Vec<Effect>>,
}

impl Sample {
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
}

/// Max undo steps kept per sample.
const UNDO_LIMIT: usize = 200;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    next_id: u64,
    pub sources: Vec<Source>,
    pub samples: Vec<Sample>,
    /// Decoded audio per source id. Not persisted: rebuilt from `Source::path` on load.
    #[serde(skip)]
    buffers: HashMap<String, Arc<AudioBuffer>>,
}

impl Project {
    pub fn new(id: impl Into<String>) -> Self {
        Self { id: id.into(), ..Default::default() }
    }

    fn gen_id(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}{}", self.next_id)
    }

    // ---- sources ----

    pub fn add_source(
        &mut self,
        name: String,
        path: PathBuf,
        preview_path: PathBuf,
        kind: SourceKind,
        buffer: AudioBuffer,
    ) -> String {
        let id = self.gen_id("src");
        self.buffers.insert(id.clone(), Arc::new(buffer));
        self.sources.push(Source { id: id.clone(), name, path, preview_path, kind });
        id
    }

    /// Attach decoded audio to a source loaded from disk.
    pub fn set_buffer(&mut self, source_id: &str, buffer: AudioBuffer) {
        self.buffers.insert(source_id.to_string(), Arc::new(buffer));
    }

    pub fn source(&self, id: &str) -> Result<&Source> {
        self.sources.iter().find(|s| s.id == id).ok_or(ProjectError::SourceNotFound)
    }

    pub fn buffer(&self, source_id: &str) -> Result<Arc<AudioBuffer>> {
        self.buffers.get(source_id).cloned().ok_or(ProjectError::SourceNotFound)
    }

    // ---- samples ----

    pub fn add_sample(&mut self, source_id: &str, range: FrameRange, name: Option<String>) -> Result<String> {
        let len = self.buffer(source_id)?.num_frames();
        let range = range.clamped(len);
        if range.is_empty() {
            return Err(ProjectError::EmptyRange);
        }
        let id = self.gen_id("smp");
        let name = name.unwrap_or_else(|| format!("Sample {}", self.samples.len() + 1));
        self.samples.push(Sample {
            id: id.clone(),
            name,
            source_id: source_id.to_string(),
            range,
            effects: Vec::new(),
            undo: Vec::new(),
            redo: Vec::new(),
        });
        Ok(id)
    }

    pub fn sample(&self, id: &str) -> Result<&Sample> {
        self.samples.iter().find(|s| s.id == id).ok_or(ProjectError::SampleNotFound)
    }

    fn sample_mut(&mut self, id: &str) -> Result<&mut Sample> {
        self.samples.iter_mut().find(|s| s.id == id).ok_or(ProjectError::SampleNotFound)
    }

    pub fn rename_sample(&mut self, id: &str, name: String) -> Result<()> {
        self.sample_mut(id)?.name = name;
        Ok(())
    }

    /// Delete a sample. Stem sources nobody uses anymore are dropped too (their files
    /// stay in the session folder; cleaning those up is the library's job in Fase 4).
    pub fn delete_sample(&mut self, id: &str) -> Result<()> {
        let before = self.samples.len();
        self.samples.retain(|s| s.id != id);
        if self.samples.len() == before {
            return Err(ProjectError::SampleNotFound);
        }
        let used: Vec<String> = self.samples.iter().map(|s| s.source_id.clone()).collect();
        let buffers = &mut self.buffers;
        self.sources.retain(|src| {
            let keep = src.kind == SourceKind::File || used.contains(&src.id);
            if !keep {
                buffers.remove(&src.id);
            }
            keep
        });
        Ok(())
    }

    // ---- effects (all undoable) ----

    /// Run `f` on a sample's effect chain, recording the previous chain for undo.
    fn edit_effects<T>(&mut self, sample_id: &str, f: impl FnOnce(&mut Vec<Effect>) -> Result<T>) -> Result<T> {
        let s = self.sample_mut(sample_id)?;
        let before = s.effects.clone();
        let out = f(&mut s.effects)?;
        if s.effects != before {
            s.undo.push(before);
            if s.undo.len() > UNDO_LIMIT {
                s.undo.remove(0);
            }
            s.redo.clear();
        }
        Ok(out)
    }

    pub fn add_effect(&mut self, sample_id: &str, op: Op) -> Result<String> {
        let id = self.gen_id("fx");
        let eid = id.clone();
        self.edit_effects(sample_id, move |fx| {
            fx.push(Effect { id: eid, enabled: true, op });
            Ok(())
        })?;
        Ok(id)
    }

    pub fn set_effect_enabled(&mut self, sample_id: &str, effect_id: &str, enabled: bool) -> Result<()> {
        self.edit_effects(sample_id, |fx| {
            let e = fx.iter_mut().find(|e| e.id == effect_id).ok_or(ProjectError::EffectNotFound)?;
            e.enabled = enabled;
            Ok(())
        })
    }

    pub fn remove_effect(&mut self, sample_id: &str, effect_id: &str) -> Result<()> {
        self.edit_effects(sample_id, |fx| {
            let i = fx.iter().position(|e| e.id == effect_id).ok_or(ProjectError::EffectNotFound)?;
            fx.remove(i);
            Ok(())
        })
    }

    /// Move an effect up (`delta < 0`) or down (`delta > 0`) in the chain.
    pub fn move_effect(&mut self, sample_id: &str, effect_id: &str, delta: i32) -> Result<()> {
        self.edit_effects(sample_id, |fx| {
            let i = fx.iter().position(|e| e.id == effect_id).ok_or(ProjectError::EffectNotFound)?;
            let j = (i as i64 + delta as i64).clamp(0, fx.len() as i64 - 1) as usize;
            let e = fx.remove(i);
            fx.insert(j, e);
            Ok(())
        })
    }

    pub fn undo(&mut self, sample_id: &str) -> Result<bool> {
        let s = self.sample_mut(sample_id)?;
        let Some(prev) = s.undo.pop() else { return Ok(false) };
        s.redo.push(std::mem::replace(&mut s.effects, prev));
        Ok(true)
    }

    pub fn redo(&mut self, sample_id: &str) -> Result<bool> {
        let s = self.sample_mut(sample_id)?;
        let Some(next) = s.redo.pop() else { return Ok(false) };
        s.undo.push(std::mem::replace(&mut s.effects, next));
        Ok(true)
    }

    /// Copy another sample's effect chain (used so stems keep the parent's fades etc.).
    pub fn copy_effects(&mut self, from: &str, to: &str) -> Result<()> {
        let fx = self.sample(from)?.effects.clone();
        let mut fx: Vec<Effect> = fx;
        for e in &mut fx {
            e.id = self.gen_id("fx");
        }
        self.sample_mut(to)?.effects = fx;
        Ok(())
    }

    // ---- rendering ----

    /// The sample's raw audio: its range of the source, no effects.
    pub fn raw_sample(&self, sample_id: &str) -> Result<AudioBuffer> {
        let s = self.sample(sample_id)?;
        let src = self.buffer(&s.source_id)?;
        let r = s.range.clamped(src.num_frames());
        Ok(AudioBuffer::new(
            src.sample_rate,
            src.channels.iter().map(|c| c[r.start..r.end].to_vec()).collect(),
        ))
    }

    /// The sample as it sounds: range + enabled effects, in order.
    pub fn render_sample(&self, sample_id: &str) -> Result<AudioBuffer> {
        let raw = self.raw_sample(sample_id)?;
        let s = self.sample(sample_id)?;
        let ops: Vec<Op> = s.effects.iter().filter(|e| e.enabled).map(|e| e.op.clone()).collect();
        Ok(render(&raw, &ops))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> (Project, String) {
        let mut p = Project::new("t");
        let buf = AudioBuffer::new(10, vec![(0..10).map(|i| i as f32).collect()]);
        let src = p.add_source("song".into(), "song.mp3".into(), "p.wav".into(), SourceKind::File, buf);
        (p, src)
    }

    #[test]
    fn several_samples_from_one_source() {
        let (mut p, src) = project();
        let a = p.add_sample(&src, FrameRange::new(0, 3), None).unwrap();
        let b = p.add_sample(&src, FrameRange::new(5, 8), Some("Hook".into())).unwrap();
        assert_eq!(p.render_sample(&a).unwrap().channels[0], vec![0., 1., 2.]);
        assert_eq!(p.render_sample(&b).unwrap().channels[0], vec![5., 6., 7.]);
        assert_eq!(p.sample(&a).unwrap().name, "Sample 1");
        assert_eq!(p.sample(&b).unwrap().name, "Hook");
    }

    #[test]
    fn empty_range_is_rejected() {
        let (mut p, src) = project();
        assert!(matches!(p.add_sample(&src, FrameRange::new(4, 4), None), Err(ProjectError::EmptyRange)));
    }

    #[test]
    fn effects_are_per_sample() {
        let (mut p, src) = project();
        let a = p.add_sample(&src, FrameRange::new(0, 3), None).unwrap();
        let b = p.add_sample(&src, FrameRange::new(0, 3), None).unwrap();
        p.add_effect(&a, Op::Reverse { range: None }).unwrap();
        assert_eq!(p.render_sample(&a).unwrap().channels[0], vec![2., 1., 0.]);
        assert_eq!(p.render_sample(&b).unwrap().channels[0], vec![0., 1., 2.]);
    }

    #[test]
    fn toggle_and_remove_any_effect() {
        let (mut p, src) = project();
        let s = p.add_sample(&src, FrameRange::new(1, 5), None).unwrap(); // 1 2 3 4
        let rev = p.add_effect(&s, Op::Reverse { range: None }).unwrap(); // 4 3 2 1
        let _trim = p.add_effect(&s, Op::Trim { range: FrameRange::new(0, 2) }).unwrap(); // 4 3
        assert_eq!(p.render_sample(&s).unwrap().channels[0], vec![4., 3.]);

        // Disable the *first* effect: the later one still applies.
        p.set_effect_enabled(&s, &rev, false).unwrap();
        assert_eq!(p.render_sample(&s).unwrap().channels[0], vec![1., 2.]);

        p.set_effect_enabled(&s, &rev, true).unwrap();
        p.remove_effect(&s, &rev).unwrap();
        assert_eq!(p.render_sample(&s).unwrap().channels[0], vec![1., 2.]);
        assert_eq!(p.sample(&s).unwrap().effects.len(), 1);
    }

    #[test]
    fn reorder_changes_result() {
        let (mut p, src) = project();
        let s = p.add_sample(&src, FrameRange::new(1, 5), None).unwrap(); // 1 2 3 4
        let rev = p.add_effect(&s, Op::Reverse { range: None }).unwrap();
        p.add_effect(&s, Op::Trim { range: FrameRange::new(0, 2) }).unwrap();
        p.move_effect(&s, &rev, 1).unwrap(); // trim first → 1 2, then reverse → 2 1
        assert_eq!(p.render_sample(&s).unwrap().channels[0], vec![2., 1.]);
    }

    #[test]
    fn undo_covers_toggle_remove_and_reorder() {
        let (mut p, src) = project();
        let s = p.add_sample(&src, FrameRange::new(0, 4), None).unwrap();
        let fx = p.add_effect(&s, Op::Reverse { range: None }).unwrap();
        p.set_effect_enabled(&s, &fx, false).unwrap();
        p.remove_effect(&s, &fx).unwrap();
        assert!(p.sample(&s).unwrap().effects.is_empty());

        assert!(p.undo(&s).unwrap()); // back: present but disabled
        assert!(!p.sample(&s).unwrap().effects[0].enabled);
        assert!(p.undo(&s).unwrap()); // enabled again
        assert!(p.sample(&s).unwrap().effects[0].enabled);
        assert!(p.undo(&s).unwrap()); // gone
        assert!(!p.undo(&s).unwrap());
        assert!(p.redo(&s).unwrap());
        assert_eq!(p.sample(&s).unwrap().effects.len(), 1);
    }

    #[test]
    fn deleting_last_stem_sample_drops_stem_source() {
        let (mut p, src) = project();
        let parent = p.add_sample(&src, FrameRange::new(0, 4), None).unwrap();
        let stem_src = p.add_source(
            "voz".into(),
            "v.wav".into(),
            "v.wav".into(),
            SourceKind::Stem { parent_sample_id: parent.clone(), stem: "vocals".into() },
            AudioBuffer::new(10, vec![vec![0.; 4]]),
        );
        let stem_sample = p.add_sample(&stem_src, FrameRange::new(0, 4), None).unwrap();
        p.delete_sample(&stem_sample).unwrap();
        assert!(p.source(&stem_src).is_err());
        assert!(p.source(&src).is_ok(), "imported files are never dropped");
    }

    #[test]
    fn serde_roundtrip_keeps_chain_but_not_buffers() {
        let (mut p, src) = project();
        let s = p.add_sample(&src, FrameRange::new(0, 4), None).unwrap();
        p.add_effect(&s, Op::Gain { db: -3.0, range: None }).unwrap();
        let json = serde_json::to_string(&p).unwrap();
        let mut q: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(q.sample(&s).unwrap().effects, p.sample(&s).unwrap().effects);
        assert!(q.render_sample(&s).is_err(), "buffers must be reloaded");
        q.set_buffer(&src, AudioBuffer::new(10, vec![vec![1.; 10]]));
        assert_eq!(q.render_sample(&s).unwrap().num_frames(), 4);
        // ids keep counting after reload (no collisions)
        let fx = q.add_effect(&s, Op::Reverse { range: None }).unwrap();
        assert!(p.sample(&s).unwrap().effects.iter().all(|e| e.id != fx));
    }
}
