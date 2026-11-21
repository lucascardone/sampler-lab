//! Recording UX: tray icon, record/stop, the recordings folder, and its listing.
//!
//! The app lives in the system tray ("iconos ocultos"). Left-click on the icon starts or
//! stops a recording; right-click opens a small menu. Recordings go to one folder
//! (default: Música/Sampler Lab) that the app lists so they're one click away.

use crate::recorder::{Finished, Recording, Tick};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

const TRAY_ID: &str = "main";

#[derive(Default)]
pub struct CaptureState {
    recording: Mutex<Option<Recording>>,
    record_item: Mutex<Option<MenuItem<Wry>>>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    recordings_dir: Option<PathBuf>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let p = settings_path(app)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, serde_json::to_vec_pretty(s).unwrap()).map_err(|e| e.to_string())
}

/// Where recordings are saved (created if missing).
pub fn recordings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = match load_settings(app).recordings_dir {
        Some(d) => d,
        None => app
            .path()
            .audio_dir()
            .or_else(|_| app.path().document_dir())
            .map_err(|e| e.to_string())?
            .join("Sampler Lab"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear la carpeta de grabaciones: {e}"))?;
    Ok(dir)
}

fn fmt_secs(s: f64) -> String {
    let s = s.max(0.0) as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

/// A 32×32 red dot: the tray icon while recording (drawn here, no asset needed).
fn recording_icon() -> Image<'static> {
    const N: u32 = 32;
    let mut rgba = vec![0u8; (N * N * 4) as usize];
    let c = (N as f32 - 1.0) / 2.0;
    for y in 0..N {
        for x in 0..N {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            // Anti-aliased edge: alpha fades over the last pixel of the radius.
            let alpha = (13.5 - d).clamp(0.0, 1.0);
            let i = ((y * N + x) * 4) as usize;
            rgba[i..i + 4].copy_from_slice(&[229, 57, 53, (alpha * 255.0) as u8]);
        }
    }
    Image::new_owned(rgba, N, N)
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let record = MenuItem::with_id(app, "record", "● Grabar", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Abrir Sampler Lab", true, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", "Abrir carpeta de grabaciones", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&record, &sep1, &show, &folder, &sep2, &quit])?;
    *app.state::<CaptureState>().record_item.lock().unwrap() = Some(record);

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Sampler Lab — clic para grabar")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "record" => toggle_and_report(app),
            "show" => show_main_window(app),
            "folder" => {
                if let Ok(dir) = recordings_dir(app) {
                    let _ = tauri_plugin_opener::open_path(&dir, None::<&str>);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_and_report(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Reflect the recording state on the tray icon, tooltip and menu.
fn refresh_tray(app: &AppHandle, recording: Option<f64>) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        match recording {
            Some(secs) => {
                let _ = tray.set_icon(Some(recording_icon()));
                let _ = tray.set_tooltip(Some(format!("Grabando {} — clic para parar", fmt_secs(secs))));
            }
            None => {
                let _ = tray.set_icon(app.default_window_icon().cloned());
                let _ = tray.set_tooltip(Some("Sampler Lab — clic para grabar"));
            }
        }
    }
    if let Some(item) = app.state::<CaptureState>().record_item.lock().unwrap().as_ref() {
        let _ = item.set_text(if recording.is_some() { "■ Parar y guardar" } else { "● Grabar" });
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ---------------------------------------------------------------------------
// Recording control (shared by tray and UI)
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    recording: bool,
    seconds: f64,
    dir: String,
}

fn status(app: &AppHandle) -> RecordingStatus {
    let rec = app.state::<CaptureState>();
    let guard = rec.recording.lock().unwrap();
    RecordingStatus {
        recording: guard.is_some(),
        seconds: guard.as_ref().map_or(0.0, |r| r.started.elapsed().as_secs_f64()),
        dir: recordings_dir(app).map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

fn start(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<CaptureState>();
    let mut guard = state.recording.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }
    let name = chrono::Local::now().format("Grabación %Y-%m-%d %H.%M.%S.wav").to_string();
    let path = recordings_dir(app)?.join(name);
    let tick_app = app.clone();
    let rec = Recording::start(path, move |t: Tick| {
        let _ = tick_app.emit("recording-tick", t);
        refresh_tray(&tick_app, Some(t.seconds));
    })?;
    *guard = Some(rec);
    drop(guard);
    refresh_tray(app, Some(0.0));
    let _ = app.emit("recording-state", status(app));
    Ok(())
}

fn stop(app: &AppHandle) -> Result<Option<Finished>, String> {
    let rec = app.state::<CaptureState>().recording.lock().unwrap().take();
    let Some(rec) = rec else { return Ok(None) };
    let result = rec.stop();
    refresh_tray(app, None);
    let _ = app.emit("recording-state", status(app));
    let finished = result?;
    let _ = app.emit("recording-saved", &finished);
    Ok(Some(finished))
}

fn toggle_and_report(app: &AppHandle) {
    let recording = app.state::<CaptureState>().recording.lock().unwrap().is_some();
    let result = if recording { stop(app).map(|_| ()) } else { start(app) };
    if let Err(e) = result {
        let _ = app.emit("recording-error", e);
        // The window may be hidden: bring it up so the error is seen.
        show_main_window(app);
    }
}

/// Finish any recording in progress (on app exit) so the file isn't left half-written.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<CaptureState>()
        && let Some(rec) = state.recording.lock().unwrap().take()
    {
        let _ = rec.stop();
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn recording_status(app: AppHandle) -> RecordingStatus {
    status(&app)
}

#[tauri::command]
pub fn start_recording(app: AppHandle) -> Result<RecordingStatus, String> {
    start(&app)?;
    Ok(status(&app))
}

#[tauri::command]
pub fn stop_recording(app: AppHandle) -> Result<Option<Finished>, String> {
    stop(&app)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFile {
    path: String,
    name: String,
    seconds: f64,
    /// Unix time in milliseconds.
    modified: u64,
}

/// WAV files in the recordings folder, newest first.
pub fn list_dir(dir: &Path) -> Vec<RecordingFile> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<RecordingFile> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("wav")))
        .filter_map(|p| {
            let modified = std::fs::metadata(&p)
                .and_then(|m| m.modified())
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis() as u64;
            // The header has the length: no need to decode the audio.
            let seconds = hound::WavReader::open(&p)
                .map(|r| r.duration() as f64 / r.spec().sample_rate as f64)
                .unwrap_or(0.0);
            Some(RecordingFile {
                name: p.file_stem()?.to_string_lossy().into_owned(),
                path: p.to_string_lossy().into_owned(),
                seconds,
                modified,
            })
        })
        .collect();
    out.sort_by_key(|f| std::cmp::Reverse(f.modified));
    out
}

#[tauri::command]
pub fn list_recordings(app: AppHandle) -> Result<Vec<RecordingFile>, String> {
    let dir = recordings_dir(&app)?;
    let current = app
        .state::<CaptureState>()
        .recording
        .lock()
        .unwrap()
        .as_ref()
        .map(|r| r.path.clone());
    // Hide the file that's being written right now.
    Ok(list_dir(&dir).into_iter().filter(|f| Some(PathBuf::from(&f.path)) != current).collect())
}

#[tauri::command]
pub fn set_recordings_dir(app: AppHandle, dir: String) -> Result<RecordingStatus, String> {
    let mut s = load_settings(&app);
    s.recordings_dir = Some(PathBuf::from(dir));
    save_settings(&app, &s)?;
    recordings_dir(&app)?;
    Ok(status(&app))
}

#[tauri::command]
pub fn open_recordings_dir(app: AppHandle) -> Result<(), String> {
    let dir = recordings_dir(&app)?;
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| e.to_string())
}

/// A recording the UI points at: must be a WAV inside the recordings folder, and not the
/// one being written right now.
fn recording_file(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let dir = recordings_dir(app)?;
    let inside = p.parent().and_then(|d| d.canonicalize().ok()).is_some_and(|d| Some(d) == dir.canonicalize().ok());
    let wav = p.extension().is_some_and(|x| x.eq_ignore_ascii_case("wav"));
    if !inside || !wav || !p.is_file() {
        return Err("Esa grabación ya no está en la carpeta".into());
    }
    let current = app.state::<CaptureState>().recording.lock().unwrap().as_ref().map(|r| r.path.clone());
    if current.is_some_and(|c| crate::library::same_path(&c, &p)) {
        return Err("Esa grabación todavía se está grabando".into());
    }
    Ok(p)
}

/// Rename `file` (same folder, keeps .wav). Returns the new path.
pub fn rename_wav(file: &Path, name: &str) -> Result<PathBuf, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Poné un nombre".into());
    }
    let new = file.with_file_name(format!("{}.wav", crate::commands::safe_file_name(name)));
    if new == file {
        return Ok(new);
    }
    // Same name in another case is the same file on Windows: allowed (just a case change).
    if new.exists() && !crate::library::same_path(&new, file) {
        return Err(format!("Ya hay una grabación que se llama \"{name}\""));
    }
    std::fs::rename(file, &new).map_err(|e| format!("No se pudo renombrar: {e}"))?;
    Ok(new)
}

/// Rename a recording. Sessions that use it are relinked so their samples keep working.
#[tauri::command]
pub fn rename_recording(
    app: AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
    path: String,
    name: String,
) -> Result<Vec<RecordingFile>, String> {
    let old = recording_file(&app, &path)?;
    let new = rename_wav(&old, &name)?;
    crate::library::relink_everywhere(&app, &state, &old, &new).map_err(|e| e.0)?;
    list_recordings(app)
}

/// How many samples (in any session) were cut from this recording.
#[tauri::command]
pub fn recording_usage(app: AppHandle, path: String) -> Result<usize, String> {
    let root = crate::commands::sessions_root(&app).map_err(|e| e.0)?;
    Ok(crate::library::samples_cut_from(&root, Path::new(&path)))
}

/// Send a recording to the Recycle Bin (recoverable from there).
#[tauri::command]
pub fn delete_recording(app: AppHandle, path: String) -> Result<Vec<RecordingFile>, String> {
    let file = recording_file(&app, &path)?;
    trash::delete(&file).map_err(|e| format!("No se pudo mandar a la papelera: {e}"))?;
    list_recordings(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_keeps_the_folder_and_refuses_clashes() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("Grabación 1.wav");
        let b = dir.path().join("Otra.wav");
        std::fs::write(&a, b"x").unwrap();
        std::fs::write(&b, b"y").unwrap();
        assert!(rename_wav(&a, "   ").is_err());
        assert!(rename_wav(&a, "Otra").is_err(), "name taken");
        let n = rename_wav(&a, "Bajo: sucio?").unwrap();
        assert_eq!(n, dir.path().join("Bajo_ sucio_.wav"));
        assert!(n.is_file() && !a.exists());
        // Same name again: nothing to do.
        assert_eq!(rename_wav(&n, "Bajo_ sucio_").unwrap(), n);
    }

    #[test]
    fn lists_only_wavs_newest_first_with_duration() {
        let dir = tempfile::tempdir().unwrap();
        let mk = |name: &str, frames: usize| {
            let p = dir.path().join(name);
            let spec = hound::WavSpec { channels: 1, sample_rate: 1000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
            let mut w = hound::WavWriter::create(&p, spec).unwrap();
            for _ in 0..frames {
                w.write_sample(0i16).unwrap();
            }
            w.finalize().unwrap();
        };
        mk("old.wav", 1500);
        std::thread::sleep(std::time::Duration::from_millis(20));
        mk("new.WAV", 500);
        std::fs::write(dir.path().join("notes.txt"), "x").unwrap();

        let list = list_dir(dir.path());
        assert_eq!(list.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["new", "old"]);
        assert!((list[0].seconds - 0.5).abs() < 1e-9);
        assert!((list[1].seconds - 1.5).abs() < 1e-9);
    }

    #[test]
    fn tray_icon_is_a_round_dot() {
        let img = recording_icon();
        let px = |x: u32, y: u32| img.rgba()[((y * 32 + x) * 4 + 3) as usize];
        assert_eq!(px(16, 16), 255, "center opaque");
        assert_eq!(px(0, 0), 0, "corner transparent");
    }
}
