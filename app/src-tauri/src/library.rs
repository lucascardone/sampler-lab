//! Sample library for the studio: every sample of every saved session, rendered on demand.
//!
//! The studio references samples by (session id, sample id), not by file, so editing a
//! sample's effects in the sample editor changes how it sounds in the song. Renders are
//! cached by a hash of everything that affects the sound (source file, range, effect
//! chain): an unchanged sample is never decoded twice, and an edited one gets a new file.

use crate::audio::analysis::{Analysis, analyze};
use crate::audio::decode;
use crate::audio::wav::{WavFormat, write_wav};
use crate::commands::{AppState, CmdResult, edit_project, err, open_session_id, sessions_root, with_open_project, write_project};
use crate::project::{Project, Sample, SourceKind};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySample {
    pub id: String,
    pub name: String,
    /// True for samples made from a separated stem (shown with the stem icon).
    pub is_stem: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySession {
    pub id: String,
    /// Name of the session's first file ("Shiver"), like the "Continuar" button.
    pub name: String,
    /// Last change, ms since epoch (newest sessions first).
    pub modified: u64,
    pub samples: Vec<LibrarySample>,
}

/// Read every `<root>/<id>/project.json`. Sessions without samples are left out, and
/// unreadable ones are skipped (a broken session shouldn't hide the rest).
pub fn scan_sessions(root: &Path) -> Vec<LibrarySession> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut out: Vec<LibrarySession> = entries
        .flatten()
        .filter_map(|e| {
            let file = e.path().join("project.json");
            let modified = std::fs::metadata(&file)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64);
            let p: Project = serde_json::from_slice(&std::fs::read(&file).ok()?).ok()?;
            if p.samples.is_empty() {
                return None;
            }
            let samples = p
                .samples
                .iter()
                .map(|s| LibrarySample {
                    id: s.id.clone(),
                    name: s.name.clone(),
                    is_stem: p.source(&s.source_id).is_ok_and(|src| matches!(src.kind, SourceKind::Stem { .. })),
                })
                .collect();
            let name = p
                .sources
                .iter()
                .find(|s| s.kind == SourceKind::File)
                .map(|s| s.name.clone())
                .unwrap_or_default();
            Some(LibrarySession { id: p.id.clone(), name, modified, samples })
        })
        .collect();
    out.sort_by_key(|s| std::cmp::Reverse(s.modified));
    out
}

/// Everything that changes how a sample sounds, hashed. Same key ⇒ same audio.
pub fn render_key(sample: &Sample, source_path: &Path) -> u64 {
    let mut h = DefaultHasher::new();
    source_path.hash(&mut h);
    (sample.range.start, sample.range.end).hash(&mut h);
    // Effects (including disabled ones, harmless) via their JSON: Op holds floats,
    // which don't implement Hash.
    serde_json::to_string(&sample.effects).unwrap_or_default().hash(&mut h);
    h.finish()
}

/// The last decoded source, so several samples cut from one song decode it once.
#[derive(Default)]
pub struct LibraryState {
    last_decoded: Mutex<Option<(PathBuf, Arc<crate::audio::AudioBuffer>)>>,
    /// Analyses by rendered file name (which encodes the render hash).
    analyses: Mutex<HashMap<String, Analysis>>,
}

#[tauri::command]
pub async fn library_list(app: AppHandle) -> CmdResult<Vec<LibrarySession>> {
    Ok(scan_sessions(&sessions_root(&app)?))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleAudio {
    /// Float WAV in the app cache, ready to fetch through the asset protocol.
    path: String,
    name: String,
}

/// Render a library sample (range + effects) to a cached WAV and return its path.
/// `stretch`: also time-stretch it to that factor of its duration (pitch unchanged).
#[tauri::command]
pub async fn library_sample_audio(
    app: AppHandle,
    state: State<'_, AppState>,
    lib: State<'_, LibraryState>,
    session_id: String,
    sample_id: String,
    stretch: Option<f64>,
) -> CmdResult<SampleAudio> {
    let base = base_render(&app, &state, &lib, &session_id, &sample_id)?;
    let Some(factor) = stretch.filter(|f| f.is_finite() && (f - 1.0).abs() > 1e-4) else { return Ok(base) };
    let factor = factor.clamp(0.25, 4.0);
    let base_path = PathBuf::from(&base.path);
    let stem = base_path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let path = base_path.with_file_name(format!("{stem}-x{factor:.4}.wav"));
    if !file_ok(&path) {
        let buf = decode::decode_file(&base_path).map_err(err)?;
        let out = tauri::async_runtime::spawn_blocking(move || crate::audio::stretch::stretch(&buf, factor)).await.map_err(err)?;
        write_atomic(&path, &out)?;
    }
    Ok(SampleAudio { path: path.to_string_lossy().into_owned(), name: base.name })
}

/// Note, key and tempo of a library sample (cached per rendered version).
#[tauri::command]
pub async fn library_analyze(
    app: AppHandle,
    state: State<'_, AppState>,
    lib: State<'_, LibraryState>,
    session_id: String,
    sample_id: String,
) -> CmdResult<Analysis> {
    let base = base_render(&app, &state, &lib, &session_id, &sample_id)?;
    if let Some(a) = lib.analyses.lock().unwrap().get(&base.path) {
        return Ok(a.clone());
    }
    let buf = decode::decode_file(Path::new(&base.path)).map_err(err)?;
    let a = tauri::async_runtime::spawn_blocking(move || analyze(&buf)).await.map_err(err)?;
    lib.analyses.lock().unwrap().insert(base.path, a.clone());
    Ok(a)
}

/// Rename a sample of any session (open or not). Returns the new library.
#[tauri::command]
pub async fn library_rename_sample(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    sample_id: String,
    name: String,
) -> CmdResult<Vec<LibrarySession>> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(err("Poné un nombre"));
    }
    edit_project(&app, &state, &session_id, |p| p.rename_sample(&sample_id, name).map_err(err))?;
    Ok(scan_sessions(&sessions_root(&app)?))
}

/// Delete a sample of any session (open or not). Returns the new library.
#[tauri::command]
pub async fn library_delete_sample(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    sample_id: String,
) -> CmdResult<Vec<LibrarySession>> {
    edit_project(&app, &state, &session_id, |p| p.delete_sample(&sample_id).map_err(err))?;
    Ok(scan_sessions(&sessions_root(&app)?))
}

/// Same file? (Windows paths ignore case.)
pub fn same_path(a: &Path, b: &Path) -> bool {
    a == b || (cfg!(windows) && a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()))
}

/// How many samples, across every saved session, were cut from `file`.
pub fn samples_cut_from(root: &Path, file: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else { return 0 };
    entries
        .flatten()
        .filter_map(|e| serde_json::from_slice::<Project>(&std::fs::read(e.path().join("project.json")).ok()?).ok())
        .map(|p| {
            let ids: Vec<&str> = p.sources.iter().filter(|s| same_path(&s.path, file)).map(|s| s.id.as_str()).collect();
            p.samples.iter().filter(|s| ids.contains(&s.source_id.as_str())).count()
        })
        .sum()
}

/// A file was renamed: point the sessions on disk that use it at the new name (and show
/// the new name). `skip`: the open session, which is updated in memory instead.
pub fn relink_sessions(root: &Path, old: &Path, new: &Path, skip: Option<&str>) -> CmdResult<usize> {
    let Ok(entries) = std::fs::read_dir(root) else { return Ok(0) };
    let mut changed = 0;
    for e in entries.flatten() {
        let file = e.path().join("project.json");
        let Some(mut p) = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<Project>(&b).ok()) else { continue };
        if skip == Some(p.id.as_str()) {
            continue;
        }
        if relink(&mut p, old, new) {
            write_project(&file, &p)?;
            changed += 1;
        }
    }
    Ok(changed)
}

/// Repoint `p`'s sources from `old` to `new`. True if anything changed.
pub fn relink(p: &mut Project, old: &Path, new: &Path) -> bool {
    let mut any = false;
    for src in p.sources.iter_mut().filter(|s| same_path(&s.path, old)) {
        src.path = new.to_path_buf();
        if src.kind == SourceKind::File {
            src.name = new.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        }
        any = true;
    }
    any
}

/// Repoint every session (the open one included) after a file rename.
pub fn relink_everywhere(app: &AppHandle, state: &AppState, old: &Path, new: &Path) -> CmdResult<()> {
    let open = open_session_id(state);
    // Only touch (and re-save) the open session when it actually uses the file.
    let uses = with_open_project(state, |p| p.sources.iter().any(|s| same_path(&s.path, old))).unwrap_or(false);
    if let (Some(id), true) = (&open, uses) {
        edit_project(app, state, id, |p| {
            relink(p, old, new);
            Ok(())
        })?;
    }
    relink_sessions(&sessions_root(app)?, old, new, open.as_deref())?;
    Ok(())
}

/// Make sure the sample's plain render (range + effects) is cached on disk.
fn base_render(app: &AppHandle, state: &AppState, lib: &LibraryState, session_id: &str, sample_id: &str) -> CmdResult<SampleAudio> {
    let (session_id, sample_id) = (session_id.to_string(), sample_id.to_string());
    let not_found = || err("Ese sample ya no existe (¿se borró?)");
    let cache = app.path().app_cache_dir().map_err(err)?.join("library");
    std::fs::create_dir_all(&cache).map_err(err)?;

    // 1. The open session lives in memory (with its decoded audio): use it directly.
    let open = with_open_project(state, |p| -> Option<CmdResult<SampleAudio>> {
        if p.id != session_id {
            return None;
        }
        let Ok(s) = p.sample(&sample_id) else { return Some(Err(not_found())) };
        let src = p.source(&s.source_id).ok()?;
        let path = path_of(&cache, &session_id, &sample_id, s, &src.path);
        if !file_ok(&path) {
            let written = p.render_sample(&sample_id).map_err(err).and_then(|buf| write_atomic(&path, &buf));
            if let Err(e) = written {
                return Some(Err(e));
            }
        }
        Some(Ok(SampleAudio { path: path.to_string_lossy().into_owned(), name: s.name.clone() }))
    })
    .flatten();
    if let Some(r) = open {
        return r;
    }

    // 2. Any other saved session: read project.json, decode just that sample's source.
    let dir = sessions_root(app)?.join(&session_id);
    let json = std::fs::read(dir.join("project.json")).map_err(|_| not_found())?;
    let mut project: Project = serde_json::from_slice(&json).map_err(err)?;
    let s = project.sample(&sample_id).map_err(|_| not_found())?.clone();
    let src = project.source(&s.source_id).map_err(|_| not_found())?.clone();
    let path = path_of(&cache, &session_id, &sample_id, &s, &src.path);
    if !file_ok(&path) {
        let cached = lib.last_decoded.lock().unwrap().as_ref().filter(|(p, _)| *p == src.path).map(|(_, b)| b.clone());
        let buf = match cached {
            Some(b) => b,
            None => {
                let b = Arc::new(decode::decode_file(&src.path).map_err(|_| {
                    err(format!("No se pudo abrir \"{}\" ({}). ¿Se movió o borró el archivo?", src.name, src.path.display()))
                })?);
                *lib.last_decoded.lock().unwrap() = Some((src.path.clone(), b.clone()));
                b
            }
        };
        project.set_buffer(&src.id, (*buf).clone());
        write_atomic(&path, &project.render_sample(&sample_id).map_err(err)?)?;
    }
    Ok(SampleAudio { path: path.to_string_lossy().into_owned(), name: s.name })
}

fn path_of(cache: &Path, session_id: &str, sample_id: &str, s: &Sample, source_path: &Path) -> PathBuf {
    cache.join(format!("{session_id}-{sample_id}-{:016x}.wav", render_key(s, source_path)))
}

fn file_ok(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.len() > 44)
}

/// Write-then-rename: the UI never fetches a half-written file.
fn write_atomic(path: &Path, buf: &crate::audio::AudioBuffer) -> CmdResult<()> {
    let tmp = path.with_extension("wav.tmp");
    write_wav(&tmp, buf, WavFormat::Float32).map_err(err)?;
    std::fs::rename(&tmp, path).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::ops::Op;
    use crate::audio::{AudioBuffer, FrameRange};

    fn project(id: &str, samples: usize) -> Project {
        let mut p = Project::new(id);
        let src = p.add_source(
            "Tema".into(),
            "C:/música/tema.mp3".into(),
            "prev.wav".into(),
            SourceKind::File,
            AudioBuffer::new(44100, vec![vec![0.0; 1000]]),
        );
        for i in 0..samples {
            p.add_sample(&src, FrameRange::new(i * 10, i * 10 + 100), None).unwrap();
        }
        p
    }

    fn save(root: &Path, p: &Project) {
        let dir = root.join(&p.id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("project.json"), serde_json::to_vec(p).unwrap()).unwrap();
    }

    #[test]
    fn scan_lists_sessions_with_samples_and_skips_broken_ones() {
        let root = tempfile::tempdir().unwrap();
        save(root.path(), &project("a", 2));
        save(root.path(), &project("empty", 0));
        std::fs::create_dir_all(root.path().join("broken")).unwrap();
        std::fs::write(root.path().join("broken/project.json"), b"{nope").unwrap();

        let list = scan_sessions(root.path());
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "a");
        assert_eq!(list[0].name, "Tema");
        assert_eq!(list[0].samples.len(), 2);
        assert!(!list[0].samples[0].is_stem);
        // A missing root is just an empty library.
        assert!(scan_sessions(&root.path().join("nope")).is_empty());
    }

    #[test]
    fn render_key_changes_with_anything_that_changes_the_sound() {
        let mut p = project("a", 1);
        let id = p.samples[0].id.clone();
        let src = Path::new("C:/música/tema.mp3");
        let k0 = render_key(p.sample(&id).unwrap(), src);
        assert_eq!(k0, render_key(p.sample(&id).unwrap(), src), "stable");
        assert_ne!(k0, render_key(p.sample(&id).unwrap(), Path::new("otro.mp3")));

        p.add_effect(&id, Op::Reverse { range: None }).unwrap();
        let k1 = render_key(p.sample(&id).unwrap(), src);
        assert_ne!(k0, k1);
        let eid = p.sample(&id).unwrap().effects[0].id.clone();
        p.set_effect_enabled(&id, &eid, false).unwrap();
        assert_ne!(k1, render_key(p.sample(&id).unwrap(), src));
    }

    #[test]
    fn renaming_a_file_relinks_the_sessions_that_use_it() {
        let root = tempfile::tempdir().unwrap();
        let mut a = project("a", 2);
        a.sources[0].path = "C:/Grab/Grabación 1.wav".into();
        save(root.path(), &a);
        save(root.path(), &project("b", 1));
        let old = Path::new("C:/Grab/Grabación 1.wav");
        assert_eq!(samples_cut_from(root.path(), old), 2);

        let new = Path::new("C:/Grab/Bajo lindo.wav");
        assert_eq!(relink_sessions(root.path(), old, new, None).unwrap(), 1);
        let back: Project = serde_json::from_slice(&std::fs::read(root.path().join("a/project.json")).unwrap()).unwrap();
        assert_eq!(back.sources[0].path, new);
        assert_eq!(back.sources[0].name, "Bajo lindo");
        assert_eq!(samples_cut_from(root.path(), old), 0);
        assert_eq!(samples_cut_from(root.path(), new), 2);
        // The open session is skipped (it's updated in memory).
        assert_eq!(relink_sessions(root.path(), new, old, Some("a")).unwrap(), 0);
    }
}
