//! Studio (song) persistence and export.
//!
//! The song itself is a JSON document owned by the UI (schema: docs/SONG_SCHEMA.md); the
//! core only stores it, so the format can grow without touching Rust. Audio for export is
//! rendered by the UI's audio engine (the same one you hear, so the file matches the
//! playback) and sent here as raw bytes to be written with the usual WAV options.

use crate::audio::AudioBuffer;
use crate::audio::wav::{ChannelMode, WavFormat, with_channels, write_wav};
use crate::commands::{CmdResult, err};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

fn song_path(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("songs").join("current.json"))
}

/// A note for the user about the last load (the song was damaged and recovered).
#[derive(Default)]
pub struct SongState {
    note: Mutex<Option<String>>,
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Load `current.json` from `dir`. If it can't be read it's never thrown away: it's kept
/// as `current.broken-<stamp>.json` and the last good copy (`current.bak.json`) takes its
/// place. Returns the song and, when something was recovered, a note for the user.
pub fn load_song_from(dir: &Path, stamp: &str) -> (Option<serde_json::Value>, Option<String>) {
    let current = dir.join("current.json");
    if !current.exists() {
        return (None, None);
    }
    if let Some(v) = read_json(&current) {
        return (Some(v), None);
    }
    let broken_name = format!("current.broken-{stamp}.json");
    let _ = std::fs::rename(&current, dir.join(&broken_name));
    let backup = dir.join("current.bak.json");
    match read_json(&backup) {
        Some(v) => {
            // Put it back as the current song, so it's there even if nothing is edited.
            let _ = std::fs::copy(&backup, &current);
            (Some(v), Some(format!("Tu canción estaba dañada: recuperé la última copia buena. La dañada quedó guardada aparte ({broken_name}).")))
        }
        None => (
            None,
            Some(format!("Tu canción estaba dañada y no había una copia buena, así que empezás una nueva. La dañada quedó guardada aparte ({broken_name}).")),
        ),
    }
}

/// Save `current.json` in `dir`, keeping the previous good version as `current.bak.json`.
pub fn save_song_to(dir: &Path, song: &serde_json::Value) -> CmdResult<()> {
    std::fs::create_dir_all(dir).map_err(err)?;
    let current = dir.join("current.json");
    if read_json(&current).is_some() {
        std::fs::copy(&current, dir.join("current.bak.json")).map_err(err)?;
    }
    let tmp = dir.join("current.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(song).map_err(err)?).map_err(err)?;
    std::fs::rename(&tmp, &current).map_err(err)
}

/// The saved song, if any.
#[tauri::command]
pub async fn song_load(app: AppHandle) -> CmdResult<Option<serde_json::Value>> {
    let path = song_path(&app)?;
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H.%M.%S").to_string();
    let (song, note) = load_song_from(path.parent().unwrap(), &stamp);
    if let (Some(note), Some(state)) = (note, app.try_state::<SongState>()) {
        *state.note.lock().unwrap() = Some(note);
    }
    Ok(song)
}

/// What happened on the last load, once (None if all was fine).
#[tauri::command]
pub fn song_recovery_note(state: State<'_, SongState>) -> Option<String> {
    state.note.lock().unwrap().take()
}

#[tauri::command]
pub async fn song_save(app: AppHandle, song: serde_json::Value) -> CmdResult<()> {
    let path = song_path(&app)?;
    save_song_to(path.parent().unwrap(), &song)
}

/// The user's own effect presets (not part of any song): `<app data>/fx-presets.json`.
fn fx_presets_path(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("fx-presets.json"))
}

#[tauri::command]
pub async fn fx_presets_load(app: AppHandle) -> CmdResult<serde_json::Value> {
    Ok(read_json(&fx_presets_path(&app)?).filter(|v| v.is_array()).unwrap_or_else(|| serde_json::json!([])))
}

#[tauri::command]
pub async fn fx_presets_save(app: AppHandle, presets: serde_json::Value) -> CmdResult<()> {
    if !presets.is_array() {
        return Err(err("Presets inválidos"));
    }
    let path = fx_presets_path(&app)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(err)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&presets).map_err(err)?).map_err(err)?;
    std::fs::rename(&tmp, &path).map_err(err)
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportMeta {
    pub path: String,
    pub sample_rate: u32,
    pub channels: usize,
    pub format: WavFormat,
    pub channel_mode: ChannelMode,
}

/// Payload layout (all little endian):
/// `u32 json_len | json (ExportMeta) | f32 samples, planar: all of channel 0, then 1…`
/// One binary message instead of JSON arrays: a 3-minute stereo song is ~70 MB of floats.
/// Split a `u32 json_len | json | data` payload.
fn split_payload<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<(T, &[u8]), String> {
    let bad = || "Datos de exportación inválidos".to_string();
    let len = u32::from_le_bytes(bytes.get(..4).ok_or_else(bad)?.try_into().unwrap()) as usize;
    let meta: T = serde_json::from_slice(bytes.get(4..4 + len).ok_or_else(bad)?).map_err(|e| e.to_string())?;
    Ok((meta, &bytes[4 + len..]))
}

pub fn parse_export(bytes: &[u8]) -> Result<(ExportMeta, AudioBuffer), String> {
    let bad = || "Datos de exportación inválidos".to_string();
    let (meta, data): (ExportMeta, _) = split_payload(bytes)?;
    if meta.channels == 0 || meta.sample_rate == 0 || !data.len().is_multiple_of(4 * meta.channels) {
        return Err(bad());
    }
    let samples: Vec<f32> = data.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect();
    let frames = samples.len() / meta.channels;
    let channels = samples.chunks_exact(frames.max(1)).take(meta.channels).map(<[f32]>::to_vec).collect();
    let buf = if frames == 0 {
        AudioBuffer::new(meta.sample_rate, vec![Vec::new(); meta.channels])
    } else {
        AudioBuffer::new(meta.sample_rate, channels)
    };
    Ok((meta, buf))
}

/// Write an export payload. `target` decides the final path from the requested one
/// (identity on the desktop; the phone's requests are redirected to a fixed folder).
pub fn write_export(bytes: &[u8], target: impl Fn(&str) -> CmdResult<PathBuf>) -> CmdResult<PathBuf> {
    let (meta, buf) = parse_export(bytes).map_err(err)?;
    let path = target(&meta.path)?;
    let buf = with_channels(&buf, meta.channel_mode);
    write_wav(&path, &buf, meta.format).map_err(err)?;
    Ok(path)
}

#[derive(Deserialize)]
struct SaveMeta {
    path: String,
}

/// Write a file payload (`{"path": …}` + contents), e.g. a MIDI export.
pub fn write_file_payload(bytes: &[u8], target: impl Fn(&str) -> CmdResult<PathBuf>) -> CmdResult<PathBuf> {
    let (meta, data): (SaveMeta, _) = split_payload(bytes).map_err(err)?;
    let path = target(&meta.path)?;
    std::fs::write(&path, data).map_err(err)?;
    Ok(path)
}

#[tauri::command]
pub async fn export_song(request: tauri::ipc::Request<'_>) -> CmdResult<()> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(err("Datos de exportación inválidos"));
    };
    write_export(bytes, |p| Ok(PathBuf::from(p))).map(|_| ())
}

/// Write any file the UI produced (e.g. a MIDI export). Same payload layout, with
/// `{"path": …}` as the JSON part and the file contents as data.
#[tauri::command]
pub async fn save_file(request: tauri::ipc::Request<'_>) -> CmdResult<()> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(err("Datos inválidos"));
    };
    write_file_payload(bytes, |p| Ok(PathBuf::from(p))).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_damaged_song_is_kept_and_the_backup_restored() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        assert_eq!(load_song_from(d, "t0"), (None, None), "no song yet");

        save_song_to(d, &serde_json::json!({"bpm": 90})).unwrap();
        save_song_to(d, &serde_json::json!({"bpm": 100})).unwrap();
        assert_eq!(read_json(&d.join("current.bak.json")).unwrap()["bpm"], 90, "backup = previous save");
        assert_eq!(load_song_from(d, "t1").0.unwrap()["bpm"], 100);

        // Corrupted (e.g. power cut, disk error): recovered from the backup, nothing lost.
        std::fs::write(d.join("current.json"), b"{\"bpm\": 1").unwrap();
        let (song, note) = load_song_from(d, "t2");
        assert_eq!(song.unwrap()["bpm"], 90);
        assert!(note.unwrap().contains("current.broken-t2.json"));
        assert_eq!(std::fs::read(d.join("current.broken-t2.json")).unwrap(), b"{\"bpm\": 1");
        assert_eq!(read_json(&d.join("current.json")).unwrap()["bpm"], 90, "restored as current");

        // Both bad: a new song, but the damaged file is still kept.
        std::fs::write(d.join("current.json"), b"nope").unwrap();
        std::fs::write(d.join("current.bak.json"), b"nope").unwrap();
        let (song, note) = load_song_from(d, "t3");
        assert!(song.is_none() && note.is_some());
        assert!(d.join("current.broken-t3.json").exists());
        // Saving after that doesn't treat the broken backup as good.
        save_song_to(d, &serde_json::json!({"bpm": 120})).unwrap();
        assert_eq!(load_song_from(d, "t4").0.unwrap()["bpm"], 120);
    }

    fn payload(meta: &str, samples: &[f32]) -> Vec<u8> {
        let mut out = (meta.len() as u32).to_le_bytes().to_vec();
        out.extend_from_slice(meta.as_bytes());
        for s in samples {
            out.extend_from_slice(&s.to_le_bytes());
        }
        out
    }

    const META: &str =
        r#"{"path":"C:/Música/beat.wav","sampleRate":48000,"channels":2,"format":"pcm24","channelMode":"stereo"}"#;

    #[test]
    fn parses_planar_payload() {
        let (meta, buf) = parse_export(&payload(META, &[0.1, 0.2, 0.3, -0.1, -0.2, -0.3])).unwrap();
        assert_eq!(meta.path, "C:/Música/beat.wav");
        assert_eq!((meta.sample_rate, meta.format, meta.channel_mode), (48000, WavFormat::Pcm24, ChannelMode::Stereo));
        assert_eq!(buf.channels, vec![vec![0.1, 0.2, 0.3], vec![-0.1, -0.2, -0.3]]);
    }

    #[test]
    fn rejects_truncated_or_misaligned_data() {
        assert!(parse_export(&[1, 0]).is_err());
        assert!(parse_export(&payload(META, &[0.1, 0.2, 0.3])).is_err(), "odd sample count for stereo");
        let mut p = payload(META, &[0.1, 0.2]);
        p.pop();
        assert!(parse_export(&p).is_err());
    }

    #[test]
    fn export_writes_wav_with_requested_options() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.wav");
        let meta = META.replace("C:/Música/beat.wav", &path.to_string_lossy().replace('\\', "/")).replace("stereo", "mono");
        let (meta, buf) = parse_export(&payload(&meta, &[0.5, 0.5, 0.0, 0.0])).unwrap();
        write_wav(Path::new(&meta.path), &with_channels(&buf, meta.channel_mode), meta.format).unwrap();
        let r = hound::WavReader::open(&path).unwrap();
        assert_eq!((r.spec().channels, r.spec().bits_per_sample, r.duration()), (1, 24, 2));
    }
}
