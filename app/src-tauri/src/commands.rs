//! Tauri commands: the bridge between the React UI and the audio core.
//!
//! The UI speaks in seconds (that's what wavesurfer gives us); the core speaks in frames.
//! Conversion happens here. Every mutation autosaves the session to disk, so closing
//! the app never loses the samples you cut.

use crate::audio::ops::Op;
use crate::audio::wav::{ChannelMode, WavFormat, with_channels, write_wav};
use crate::audio::{AudioBuffer, FrameRange, decode, zero_cross};
use crate::project::{Effect, Project, SourceKind};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};

/// Seconds of extra audio fed to the separator on each side of a sample. Models produce
/// artifacts at the edges of their input; with context around, the part we keep is clean.
const SEPARATION_PAD_SECS: f64 = 2.0;

struct OpenSession {
    project: Project,
    /// Session folder: project.json, source previews, stems.
    dir: PathBuf,
    /// Separation context per sample: (padding before the sample, sample length), in frames.
    pending_separation: HashMap<String, (usize, usize)>,
}

#[derive(Default)]
pub struct AppState {
    session: Mutex<Option<OpenSession>>,
    counter: AtomicU64,
    last_sample_preview: Mutex<Option<PathBuf>>,
}

impl AppState {
    fn next(&self) -> u64 {
        self.counter.fetch_add(1, Ordering::Relaxed)
    }
}

/// Errors cross the IPC boundary as plain strings (already in Spanish for the user).
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct CmdError(pub(crate) String);

impl Serialize for CmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

pub(crate) fn err(m: impl ToString) -> CmdError {
    CmdError(m.to_string())
}

pub(crate) type CmdResult<T> = Result<T, CmdError>;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct SecRange {
    pub start: f64,
    pub end: f64,
}

fn to_frames(r: SecRange, sample_rate: u32) -> FrameRange {
    let sr = sample_rate as f64;
    FrameRange::new((r.start.max(0.0) * sr).round() as usize, (r.end.max(0.0) * sr).round() as usize)
}

/// An effect as the UI describes it (times in seconds, relative to the sample).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum OpRequest {
    Trim { range: SecRange },
    Gain { db: f32, range: Option<SecRange> },
    Normalize { peak_db: f32, range: Option<SecRange> },
    FadeIn { range: SecRange },
    FadeOut { range: SecRange },
    Reverse { range: Option<SecRange> },
}

impl OpRequest {
    fn to_op(&self, sample_rate: u32) -> Op {
        let f = |r: SecRange| to_frames(r, sample_rate);
        match *self {
            OpRequest::Trim { range } => Op::Trim { range: f(range) },
            OpRequest::Gain { db, range } => Op::Gain { db, range: range.map(f) },
            OpRequest::Normalize { peak_db, range } => Op::Normalize { peak_db, range: range.map(f) },
            OpRequest::FadeIn { range } => Op::FadeIn { range: f(range) },
            OpRequest::FadeOut { range } => Op::FadeOut { range: f(range) },
            OpRequest::Reverse { range } => Op::Reverse { range: range.map(f) },
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceView {
    id: String,
    name: String,
    kind: SourceKind,
    /// The audio file on disk (original file, recording, or stem).
    path: String,
    preview_path: String,
    duration: f64,
    sample_rate: u32,
    channels: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleView {
    id: String,
    name: String,
    source_id: String,
    /// Position in the source, seconds.
    start: f64,
    end: f64,
    sample_rate: u32,
    /// Effect ranges are in frames relative to the sample; divide by `sample_rate`.
    effects: Vec<Effect>,
    can_undo: bool,
    can_redo: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    id: String,
    sources: Vec<SourceView>,
    samples: Vec<SampleView>,
}

fn view(p: &Project) -> SessionView {
    let sources = p
        .sources
        .iter()
        .filter_map(|s| {
            let b = p.buffer(&s.id).ok()?;
            Some(SourceView {
                id: s.id.clone(),
                name: s.name.clone(),
                kind: s.kind.clone(),
                path: s.path.to_string_lossy().into_owned(),
                preview_path: s.preview_path.to_string_lossy().into_owned(),
                duration: b.duration_secs(),
                sample_rate: b.sample_rate,
                channels: b.num_channels(),
            })
        })
        .collect();
    let samples = p
        .samples
        .iter()
        .map(|s| {
            let sr = p.buffer(&s.source_id).map_or(44100, |b| b.sample_rate);
            SampleView {
                id: s.id.clone(),
                name: s.name.clone(),
                source_id: s.source_id.clone(),
                start: s.range.start as f64 / sr as f64,
                end: s.range.end as f64 / sr as f64,
                sample_rate: sr,
                effects: s.effects.clone(),
                can_undo: s.can_undo(),
                can_redo: s.can_redo(),
            }
        })
        .collect();
    SessionView { id: p.id.clone(), sources, samples }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderView {
    preview_path: String,
    duration: f64,
    sample_rate: u32,
    channels: usize,
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

pub(crate) fn sessions_root(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("sessions"))
}

fn last_session_pointer(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("last_session.txt"))
}

fn save(app: &AppHandle, s: &OpenSession) -> CmdResult<()> {
    let json = serde_json::to_vec_pretty(&s.project).map_err(err)?;
    // Write-then-rename so a crash mid-write never leaves a corrupt project file.
    let tmp = s.dir.join("project.json.tmp");
    std::fs::write(&tmp, json).map_err(err)?;
    std::fs::rename(&tmp, s.dir.join("project.json")).map_err(err)?;
    std::fs::write(last_session_pointer(app)?, s.dir.to_string_lossy().as_bytes()).map_err(err)?;
    Ok(())
}

/// Lock the session, run `f`, autosave, and return the new view.
fn mutate(
    app: &AppHandle,
    state: &AppState,
    f: impl FnOnce(&mut OpenSession) -> CmdResult<()>,
) -> CmdResult<SessionView> {
    let mut guard = state.session.lock().unwrap();
    let s = guard.as_mut().ok_or_else(|| err("No hay ninguna sesión abierta"))?;
    f(s)?;
    save(app, s)?;
    Ok(view(&s.project))
}

/// Run `f` on the open session's project, if there is one (used by the studio library).
pub(crate) fn with_open_project<T>(state: &AppState, f: impl FnOnce(&Project) -> T) -> Option<T> {
    state.session.lock().unwrap().as_ref().map(|s| f(&s.project))
}

fn with_session<T>(state: &AppState, f: impl FnOnce(&mut OpenSession) -> CmdResult<T>) -> CmdResult<T> {
    let mut guard = state.session.lock().unwrap();
    let s = guard.as_mut().ok_or_else(|| err("No hay ninguna sesión abierta"))?;
    f(s)
}

/// A session id as stored on disk (the folder name): digits, letters, `-` and `_` only.
pub(crate) fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Write a project.json the safe way (temp file, then rename).
pub(crate) fn write_project(file: &Path, p: &Project) -> CmdResult<()> {
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(p).map_err(err)?).map_err(err)?;
    std::fs::rename(&tmp, file).map_err(err)
}

/// Change any saved session's project. The open one is edited in memory (that's the copy
/// that gets saved) and the Samples tab hears about it ("session-changed"); the rest are
/// edited on disk.
pub(crate) fn edit_project(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    f: impl FnOnce(&mut Project) -> CmdResult<()>,
) -> CmdResult<()> {
    if !valid_session_id(session_id) {
        return Err(err("Esa sesión no existe"));
    }
    {
        let mut guard = state.session.lock().unwrap();
        if let Some(s) = guard.as_mut().filter(|s| s.project.id == session_id) {
            f(&mut s.project)?;
            save(app, s)?;
            let _ = app.emit("session-changed", view(&s.project));
            return Ok(());
        }
    }
    let file = sessions_root(app)?.join(session_id).join("project.json");
    let json = std::fs::read(&file).map_err(|_| err("Esa sesión ya no existe"))?;
    let mut p: Project = serde_json::from_slice(&json).map_err(err)?;
    f(&mut p)?;
    write_project(&file, &p)
}

/// Id of the open session, if any.
pub(crate) fn open_session_id(state: &AppState) -> Option<String> {
    with_open_project(state, |p| p.id.clone())
}

fn file_stem(p: &Path) -> String {
    p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "audio".into())
}

/// Make a user-provided name safe as a file name on every OS.
pub(crate) fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').to_string();
    if trimmed.is_empty() { "sample".into() } else { trimmed }
}

// ---------------------------------------------------------------------------
// Session commands
// ---------------------------------------------------------------------------

/// Import an audio file into a **new** session.
#[tauri::command]
pub async fn open_audio(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<SessionView> {
    let p = PathBuf::from(&path);
    let buf = decode::decode_file(&p).map_err(err)?;

    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let id = format!("{millis}");
    let dir = sessions_root(&app)?.join(&id);
    std::fs::create_dir_all(dir.join("previews")).map_err(err)?;

    // We draw our own decode (not the original file) so what you see/hear in the UI is
    // sample-exact with what we cut. 16-bit keeps it small for full songs.
    let mut project = Project::new(id);
    let preview = dir.join("previews").join(format!("source-{}.wav", state.next()));
    write_wav(&preview, &buf, WavFormat::Pcm16).map_err(err)?;
    project.add_source(file_stem(&p), p, preview, SourceKind::File, buf);

    let session = OpenSession { project, dir, pending_separation: HashMap::new() };
    save(&app, &session)?;
    let v = view(&session.project);
    *state.session.lock().unwrap() = Some(session);
    Ok(v)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    session: SessionView,
    source_id: String,
}

/// Add an audio file (e.g. a recording) to the **current** session, so samples from
/// several files live side by side. Starts a new session if none is open. Adding a file
/// that's already in the session just returns it.
#[tauri::command]
pub async fn add_audio(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<Added> {
    let p = PathBuf::from(&path);
    let has_session = state.session.lock().unwrap().is_some();
    if !has_session {
        let session = open_audio(app, state, path).await?;
        let source_id = session.sources[0].id.clone();
        return Ok(Added { session, source_id });
    }

    let existing = with_session(&state, |s| {
        Ok(s.project.sources.iter().find(|src| src.path == p && src.kind == SourceKind::File).map(|src| src.id.clone()))
    })?;
    if let Some(source_id) = existing {
        let session = with_session(&state, |s| Ok(view(&s.project)))?;
        return Ok(Added { session, source_id });
    }

    // Decode outside the lock: it can take a moment for long files.
    let buf = decode::decode_file(&p).map_err(err)?;
    let n = state.next();
    let mut source_id = String::new();
    let session = mutate(&app, &state, |s| {
        let preview = s.dir.join("previews").join(format!("source-{n}.wav"));
        write_wav(&preview, &buf, WavFormat::Pcm16).map_err(err)?;
        source_id = s.project.add_source(file_stem(&p), p.clone(), preview, SourceKind::File, buf);
        Ok(())
    })?;
    Ok(Added { session, source_id })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastSessionInfo {
    name: String,
    samples: usize,
}

/// Info about the last session (for a "Continuar" button), if there is one.
#[tauri::command]
pub async fn last_session(app: AppHandle) -> CmdResult<Option<LastSessionInfo>> {
    let Ok(dir) = std::fs::read_to_string(last_session_pointer(&app)?) else { return Ok(None) };
    let Ok(json) = std::fs::read(Path::new(dir.trim()).join("project.json")) else { return Ok(None) };
    let Ok(p) = serde_json::from_slice::<Project>(&json) else { return Ok(None) };
    let name = p.sources.first().map(|s| s.name.clone()).unwrap_or_default();
    Ok(Some(LastSessionInfo { name, samples: p.samples.len() }))
}

/// Reopen the last session: reload project.json and decode every source again.
#[tauri::command]
pub async fn restore_session(app: AppHandle, state: State<'_, AppState>) -> CmdResult<SessionView> {
    let dir = PathBuf::from(
        std::fs::read_to_string(last_session_pointer(&app)?)
            .map_err(|_| err("No hay una sesión anterior"))?
            .trim(),
    );
    let json = std::fs::read(dir.join("project.json")).map_err(|_| err("No se encontró la sesión anterior"))?;
    let mut project: Project = serde_json::from_slice(&json).map_err(err)?;

    let sources: Vec<(String, PathBuf, String)> =
        project.sources.iter().map(|s| (s.id.clone(), s.path.clone(), s.name.clone())).collect();
    for (id, path, name) in sources {
        let buf = decode::decode_file(&path)
            .map_err(|_| err(format!("No se pudo abrir \"{name}\" ({}). ¿Se movió o borró el archivo?", path.display())))?;
        project.set_buffer(&id, buf);
    }
    let session = OpenSession { project, dir, pending_separation: HashMap::new() };
    let v = view(&session.project);
    *state.session.lock().unwrap() = Some(session);
    Ok(v)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    session: SessionView,
    sample_id: String,
}

/// Save a selection of a source as a new sample.
#[tauri::command]
pub async fn create_sample(
    app: AppHandle,
    state: State<'_, AppState>,
    source_id: String,
    range: SecRange,
    name: Option<String>,
) -> CmdResult<Created> {
    let mut new_id = String::new();
    let session = mutate(&app, &state, |s| {
        let sr = s.project.buffer(&source_id).map_err(err)?.sample_rate;
        new_id = s.project.add_sample(&source_id, to_frames(range, sr), name).map_err(err)?;
        Ok(())
    })?;
    Ok(Created { session, sample_id: new_id })
}

#[tauri::command]
pub async fn rename_sample(app: AppHandle, state: State<'_, AppState>, sample_id: String, name: String) -> CmdResult<SessionView> {
    mutate(&app, &state, |s| s.project.rename_sample(&sample_id, name).map_err(err))
}

#[tauri::command]
pub async fn delete_sample(app: AppHandle, state: State<'_, AppState>, sample_id: String) -> CmdResult<SessionView> {
    mutate(&app, &state, |s| s.project.delete_sample(&sample_id).map_err(err))
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn add_effect(app: AppHandle, state: State<'_, AppState>, sample_id: String, op: OpRequest) -> CmdResult<SessionView> {
    mutate(&app, &state, |s| {
        let sr = s.project.buffer(&s.project.sample(&sample_id).map_err(err)?.source_id).map_err(err)?.sample_rate;
        let op = op.to_op(sr);
        if let Op::Trim { range } = op
            && range.is_empty()
        {
            return Err(err("La selección está vacía"));
        }
        s.project.add_effect(&sample_id, op).map(|_| ()).map_err(err)
    })
}

#[tauri::command]
pub async fn set_effect_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    sample_id: String,
    effect_id: String,
    enabled: bool,
) -> CmdResult<SessionView> {
    mutate(&app, &state, |s| s.project.set_effect_enabled(&sample_id, &effect_id, enabled).map_err(err))
}

#[tauri::command]
pub async fn remove_effect(app: AppHandle, state: State<'_, AppState>, sample_id: String, effect_id: String) -> CmdResult<SessionView> {
    mutate(&app, &state, |s| s.project.remove_effect(&sample_id, &effect_id).map_err(err))
}

#[tauri::command]
pub async fn move_effect(
    app: AppHandle,
    state: State<'_, AppState>,
    sample_id: String,
    effect_id: String,
    delta: i32,
) -> CmdResult<SessionView> {
    mutate(&app, &state, |s| s.project.move_effect(&sample_id, &effect_id, delta).map_err(err))
}

#[tauri::command]
pub async fn undo(app: AppHandle, state: State<'_, AppState>, sample_id: String) -> CmdResult<SessionView> {
    mutate(&app, &state, |s| s.project.undo(&sample_id).map(|_| ()).map_err(err))
}

#[tauri::command]
pub async fn redo(app: AppHandle, state: State<'_, AppState>, sample_id: String) -> CmdResult<SessionView> {
    mutate(&app, &state, |s| s.project.redo(&sample_id).map(|_| ()).map_err(err))
}

// ---------------------------------------------------------------------------
// Rendering, snapping, export
// ---------------------------------------------------------------------------

/// Render a sample (range + active effects) to a preview WAV for the UI.
#[tauri::command]
pub async fn render_sample(app: AppHandle, state: State<'_, AppState>, sample_id: String) -> CmdResult<RenderView> {
    let buf = with_session(&state, |s| s.project.render_sample(&sample_id).map_err(err))?;
    let dir = app.path().app_cache_dir().map_err(err)?.join("previews");
    std::fs::create_dir_all(&dir).map_err(err)?;
    // New name per render: defeats the webview cache. The previous one is deleted.
    let path = dir.join(format!("sample-{}.wav", state.next()));
    write_wav(&path, &buf, WavFormat::Float32).map_err(err)?;
    if let Some(old) = state.last_sample_preview.lock().unwrap().replace(path.clone()) {
        let _ = std::fs::remove_file(old);
    }
    Ok(RenderView {
        preview_path: path.to_string_lossy().into_owned(),
        duration: buf.duration_secs(),
        sample_rate: buf.sample_rate,
        channels: buf.num_channels(),
    })
}

/// What a time refers to: a source as-is, or a rendered sample.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    source_id: Option<String>,
    sample_id: Option<String>,
}

fn target_buffer(p: &Project, t: &Target) -> CmdResult<std::sync::Arc<AudioBuffer>> {
    match (&t.sample_id, &t.source_id) {
        (Some(id), _) => Ok(std::sync::Arc::new(p.render_sample(id).map_err(err)?)),
        (None, Some(id)) => p.buffer(id).map_err(err),
        _ => Err(err("Falta el audio de destino")),
    }
}

/// Move a time to the nearest zero crossing within `window_ms`. Returns seconds.
#[tauri::command]
pub async fn snap_to_zero(state: State<'_, AppState>, target: Target, times: Vec<f64>, window_ms: Option<f64>) -> CmdResult<Vec<f64>> {
    with_session(&state, |s| {
        let buf = target_buffer(&s.project, &target)?;
        let window = buf.secs_to_frames(window_ms.unwrap_or(10.0) / 1000.0);
        Ok(times
            .iter()
            .map(|&t| {
                let z = zero_cross::nearest_zero_crossing(&buf, buf.secs_to_frames(t), window);
                z as f64 / buf.sample_rate as f64
            })
            .collect())
    })
}

/// Export one sample (optionally only `range` of it) to `path`.
#[tauri::command]
pub async fn export_sample(
    state: State<'_, AppState>,
    sample_id: String,
    path: String,
    format: Option<WavFormat>,
    channels: Option<ChannelMode>,
    range: Option<SecRange>,
) -> CmdResult<()> {
    let mut buf = with_session(&state, |s| s.project.render_sample(&sample_id).map_err(err))?;
    if let Some(r) = range {
        Op::Trim { range: to_frames(r, buf.sample_rate) }.apply(&mut buf);
    }
    let buf = with_channels(&buf, channels.unwrap_or_default());
    write_wav(Path::new(&path), &buf, format.unwrap_or(WavFormat::Pcm24)).map_err(err)
}

/// Export every sample of the session into `dir` as "<name>.wav". Returns the paths.
#[tauri::command]
pub async fn export_all(
    state: State<'_, AppState>,
    dir: String,
    format: Option<WavFormat>,
    channels: Option<ChannelMode>,
) -> CmdResult<Vec<String>> {
    let renders = with_session(&state, |s| {
        s.project
            .samples
            .iter()
            .map(|smp| Ok((smp.name.clone(), s.project.render_sample(&smp.id).map_err(err)?)))
            .collect::<CmdResult<Vec<_>>>()
    })?;
    let dir = PathBuf::from(dir);
    let mut out = Vec::new();
    let mut used = std::collections::HashSet::new();
    for (name, buf) in renders {
        // Avoid overwriting when two samples share a name: "Hook", "Hook (2)", ...
        let base = safe_file_name(&name);
        let mut file = format!("{base}.wav");
        let mut n = 2;
        while !used.insert(file.to_lowercase()) || dir.join(&file).exists() {
            file = format!("{base} ({n}).wav");
            n += 1;
        }
        let path = dir.join(&file);
        let buf = with_channels(&buf, channels.unwrap_or_default());
        write_wav(&path, &buf, format.unwrap_or(WavFormat::Pcm24)).map_err(err)?;
        out.push(path.to_string_lossy().into_owned());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Separation (the Python engine does the ML; we prepare input and import results)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparationInput {
    input_path: String,
    out_dir: String,
    /// Length of the sample itself (without padding), seconds — for time estimates.
    duration: f64,
}

/// Write the sample's raw audio (no effects) with some context on both sides, for the
/// separator to process.
#[tauri::command]
pub async fn prepare_separation(state: State<'_, AppState>, sample_id: String) -> CmdResult<SeparationInput> {
    let n = state.next();
    with_session(&state, |s| {
        let smp = s.project.sample(&sample_id).map_err(err)?;
        let src = s.project.buffer(&smp.source_id).map_err(err)?;
        let r = smp.range.clamped(src.num_frames());
        let (start, end) = padded_window(r, src.num_frames(), src.secs_to_frames(SEPARATION_PAD_SECS));
        let padded = AudioBuffer::new(
            src.sample_rate,
            src.channels.iter().map(|c| c[start..end].to_vec()).collect(),
        );

        let job_dir = s.dir.join("separation").join(format!("{sample_id}-{n}"));
        std::fs::create_dir_all(&job_dir).map_err(err)?;
        let input = job_dir.join("input.wav");
        write_wav(&input, &padded, WavFormat::Float32).map_err(err)?;
        s.pending_separation.insert(sample_id.clone(), (r.start - start, r.len()));
        Ok(SeparationInput {
            input_path: input.to_string_lossy().into_owned(),
            out_dir: job_dir.join("raw").to_string_lossy().into_owned(),
            duration: r.len() as f64 / src.sample_rate as f64,
        })
    })
}

/// `range` grown by `pad` frames on each side, clamped to `[0, len)`.
fn padded_window(range: FrameRange, len: usize, pad: usize) -> (usize, usize) {
    (range.start.saturating_sub(pad), (range.end + pad).min(len))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemFile {
    pub stem: String,
    pub path: String,
}

/// Cut the separator's (padded) output back to the sample's exact length.
/// Returns the trimmed stem files, ready to audition.
#[tauri::command]
pub async fn import_stems(state: State<'_, AppState>, sample_id: String, stems: Vec<StemFile>) -> CmdResult<Vec<StemFile>> {
    let (pad, len) = with_session(&state, |s| {
        s.pending_separation
            .get(&sample_id)
            .copied()
            .ok_or_else(|| err("No hay una separación en curso para este sample"))
    })?;
    let mut out = Vec::new();
    for st in stems {
        let raw_path = PathBuf::from(&st.path);
        let mut buf = decode::decode_file(&raw_path).map_err(err)?;
        Op::Trim { range: FrameRange::new(pad, pad + len) }.apply(&mut buf);
        let dir = raw_path.parent().and_then(Path::parent).ok_or_else(|| err("Ruta inválida"))?.join("stems");
        std::fs::create_dir_all(&dir).map_err(err)?;
        let path = dir.join(format!("{}.wav", safe_file_name(&st.stem)));
        write_wav(&path, &buf, WavFormat::Float32).map_err(err)?;
        out.push(StemFile { stem: st.stem, path: path.to_string_lossy().into_owned() });
    }
    Ok(out)
}

/// Keep a stem: it becomes a new sample (with a copy of the parent's effects).
#[tauri::command]
pub async fn keep_stem(
    app: AppHandle,
    state: State<'_, AppState>,
    sample_id: String,
    stem: StemFile,
    name: String,
) -> CmdResult<Created> {
    let path = PathBuf::from(&stem.path);
    let buf = decode::decode_file(&path).map_err(err)?;
    let mut new_id = String::new();
    let session = mutate(&app, &state, |s| {
        let frames = buf.num_frames();
        let src = s.project.add_source(
            name.clone(),
            path.clone(),
            path.clone(),
            SourceKind::Stem { parent_sample_id: sample_id.clone(), stem: stem.stem.clone() },
            buf,
        );
        new_id = s.project.add_sample(&src, FrameRange::new(0, frames), Some(name)).map_err(err)?;
        s.project.copy_effects(&sample_id, &new_id).map_err(err)
    })?;
    Ok(Created { session, sample_id: new_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separation_padding_is_clamped_and_reversible() {
        // Middle of the file: full padding both sides.
        let r = FrameRange::new(1000, 2000);
        let (s, e) = padded_window(r, 10_000, 300);
        assert_eq!((s, e), (700, 2300));
        // Cropping the padded output by (r.start - s, r.len()) gives back exactly `r`.
        let padded: Vec<usize> = (s..e).collect();
        let (pad_before, len) = (r.start - s, r.len());
        assert_eq!(&padded[pad_before..pad_before + len], &(1000..2000).collect::<Vec<_>>()[..]);
        // Near the edges padding shrinks instead of going out of bounds.
        assert_eq!(padded_window(FrameRange::new(100, 9_900), 10_000, 300), (0, 10_000));
    }

    #[test]
    fn file_names_are_sanitized() {
        assert_eq!(safe_file_name("Hook: vox/1?"), "Hook_ vox_1_");
        assert_eq!(safe_file_name("  ..  "), "sample");
        assert_eq!(safe_file_name("Bajo · intro"), "Bajo · intro");
    }
}
