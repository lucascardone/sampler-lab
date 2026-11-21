//! Sound packs: folders of sounds and multi-sample instruments the Studio can use.
//!
//! Each pack lives in `<app data>/packs/<id>/` with a `pack.json` that says what's inside
//! and under which license (format: docs/PACK_SCHEMA.md). Packs come from the user's own
//! folders (copied, so songs keep working if the folder moves) or, later, from a curated
//! catalog. Nothing in a pack is ever executed: only audio files, `.sfz` instrument
//! descriptions and license texts are kept.

use crate::commands::{CmdResult, err, safe_file_name};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const PACK_VERSION: u32 = 1;
/// How items were planned. 2 = `#include` understood: instrument fragments and the
/// recordings they use are no longer listed. Older packs are re-planned once (`replan`).
pub const PLAN_VERSION: u32 = 2;
/// Audio a pack may hold (what the WebView can decode).
pub const AUDIO_EXTS: &[&str] = &["wav", "flac", "ogg", "mp3", "m4a", "aif", "aiff"];
/// Imports bigger than this are refused (a sound pack, not a music library).
const MAX_IMPORT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_IMPORT_FILES: usize = 3000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Credit {
    pub author: String,
    pub license: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackItem {
    pub id: String,
    pub name: String,
    /// "oneshot" (a single sound or loop) | "instrument" (an SFZ multi-sample instrument).
    pub kind: String,
    /// Relative to the pack folder ("/" separators). One-shots.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// Relative to the pack folder. Instruments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sfz: Option<String>,
    /// drums | bass | keys | strings | winds | synth | fx | vocals | other
    #[serde(default = "other")]
    pub category: String,
    /// Per-item author/license when it differs from the pack's (e.g. Freesound sounds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit: Option<Credit>,
    /// Not listed in the library, kept only so songs that already use it still load
    /// (recordings of an instrument that older versions listed as loose sounds).
    #[serde(default, skip_serializing_if = "is_false")]
    pub hidden: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn other() -> String {
    "other".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub author: String,
    /// SPDX-like id: CC0-1.0, CC-BY-4.0, CC-BY-NC-4.0, … or "own" (the user's own sounds).
    pub license: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    /// "folder" | "catalog" | "zip" | "freesound"
    pub origin: String,
    pub installed_at: String,
    pub items: Vec<PackItem>,
    /// `PLAN_VERSION` the items were planned with (0 = before it existed).
    #[serde(default)]
    pub plan: u32,
}

/// A pack as the UI sees it: plus the absolute folder, to load its files.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackView {
    #[serde(flatten)]
    pub pack: Pack,
    pub dir: String,
}

pub fn packs_root(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("packs"))
}

/// Pack ids are folder names: letters, digits, `-` and `_` only.
pub fn valid_pack_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A readable id from a name ("Mis Bombos!" → "mis-bombos"), unique among `taken`.
pub fn pack_id_for(name: &str, taken: &HashSet<String>) -> String {
    let mut base = String::new();
    for c in name.to_lowercase().chars() {
        let c = match c {
            'á' | 'à' | 'ä' => 'a',
            'é' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'ï' => 'i',
            'ó' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'ü' => 'u',
            'ñ' => 'n',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            base.push(c);
        } else if !base.ends_with('-') && !base.is_empty() {
            base.push('-');
        }
    }
    let base: String = base.trim_end_matches('-').chars().take(40).collect();
    let base = if base.is_empty() { "paquete".to_string() } else { base };
    let mut id = base.clone();
    let mut n = 2;
    while taken.contains(&id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

/// Every installed pack (broken or foreign folders are skipped), sorted by name.
pub fn list_packs(root: &Path) -> Vec<PackView> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut out: Vec<PackView> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let dir = e.path();
            let name = dir.file_name()?.to_string_lossy().into_owned();
            if !valid_pack_id(&name) {
                return None; // ".tmp" and anything that isn't ours
            }
            let pack: Pack = serde_json::from_slice(&std::fs::read(dir.join("pack.json")).ok()?).ok()?;
            (pack.id == name).then(|| PackView { pack: replan(&dir, pack), dir: dir.to_string_lossy().into_owned() })
        })
        .collect();
    out.sort_by_key(|p| p.pack.name.to_lowercase());
    out
}

/// A relative path from a pack file that stays inside the pack (no `..`, no absolute
/// paths, no drive letters). Shared with archive extraction.
pub fn safe_relative(rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel);
    if rel.is_empty() || rel.contains(':') {
        return None;
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

pub fn is_audio(p: &Path) -> bool {
    AUDIO_EXTS.contains(&ext_of(p).as_str())
}

/// Guess a category from a file's path ("Kicks/808 kick.wav" → drums).
pub fn guess_category(rel: &str) -> String {
    let l = rel.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| l.contains(w));
    if has(&["808", "bass", "bajo", "sub"]) {
        "bass"
    } else if has(&["kick", "bombo", "snare", "caja", "hat", "clap", "palma", "perc", "tom", "cymbal", "crash", "ride", "rim", "drum", "bateria", "batería", "shaker"]) {
        "drums"
    } else if has(&["piano", "keys", "rhodes", "organ", "organo", "órgano", "teclad"]) {
        "keys"
    } else if has(&["string", "cuerda", "violin", "viola", "cello", "guitar", "guitarra"]) {
        "strings"
    } else if has(&["flute", "flauta", "sax", "trumpet", "trompeta", "brass", "horn", "wind", "viento", "clarinet"]) {
        "winds"
    } else if has(&["vox", "vocal", "voz", "voice", "choir", "coro"]) {
        "vocals"
    } else if has(&["synth", "lead", "pad", "pluck", "arp"]) {
        "synth"
    } else if has(&["fx", "riser", "sweep", "impact", "noise", "efecto"]) {
        "fx"
    } else {
        "other"
    }
    .into()
}

/// "kick_01-hard.wav" → "Kick 01 hard".
pub fn pretty_name(rel: &str) -> String {
    let stem = Path::new(rel).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let spaced: String = stem.chars().map(|c| if c == '_' || c == '-' || c == '.' { ' ' } else { c }).collect();
    // Split CamelCase ("UprightPianoKW" → "Upright Piano KW") and drop dates/versions
    // ("20220221", "v1", "001") that only make sense to the author.
    let mut split = String::new();
    let chars: Vec<char> = spaced.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if i > 0 && c.is_uppercase() && chars[i - 1].is_lowercase() {
            split.push(' ');
        }
        split.push(c);
    }
    let is_noise = |w: &str| {
        let digits = w.chars().filter(|c| c.is_ascii_digit()).count();
        (digits >= 6 && digits == w.len()) || (w.len() > 1 && (w.starts_with('v') || w.starts_with('V')) && w[1..].chars().all(|c| c.is_ascii_digit()))
    };
    let kept: Vec<&str> = split.split_whitespace().filter(|w| !is_noise(w)).collect();
    let words: Vec<&str> = if kept.is_empty() { split.split_whitespace().collect() } else { kept };
    let joined = words.join(" ");
    let mut cs = joined.chars();
    match cs.next() {
        Some(f) => f.to_uppercase().collect::<String>() + cs.as_str(),
        None => "Sonido".into(),
    }
}

/// The audio files an SFZ text points to, relative to the folder of the `.sfz`
/// (`default_path` + `sample=`), normalised with "/" separators. Only to know which files
/// belong to instruments; the full parser lives in the UI (`studio/sfz.ts`).
pub fn sfz_samples(text: &str) -> Vec<String> {
    let mut default_path = String::new();
    let mut out = Vec::new();
    // Opcode values may contain spaces (file names), so a value runs until the next
    // "opcode=" or header on the line.
    for raw in text.lines() {
        let line = raw.split("//").next().unwrap_or("");
        let mut rest = line;
        while let Some(eq) = rest.find('=') {
            let key = rest[..eq].rsplit(|c: char| c.is_whitespace() || c == '>').next().unwrap_or("").trim();
            let after = &rest[eq + 1..];
            // Value ends where the next "word=" starts.
            let end = after
                .match_indices('=')
                .next()
                .and_then(|(i, _)| after[..i].rfind(|c: char| c.is_whitespace()))
                .unwrap_or(after.len());
            let end = after[..end].find('<').unwrap_or(end);
            let value = after[..end].trim().replace('\\', "/");
            match key {
                "default_path" => default_path = value,
                "sample" if !value.is_empty() => out.push(format!("{default_path}{value}")),
                _ => {}
            }
            rest = &after[end..];
        }
    }
    out
}

/// Join a path relative to `base_dir` (both "/"-separated, relative to the pack) and
/// resolve `.`/`..` without leaving the pack. None if it escapes.
pub fn join_inside(base_dir: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = base_dir.split('/').filter(|s| !s.is_empty()).collect();
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// The `#include "file.sfz"` targets of an SFZ text, as written ("/" separators).
pub fn sfz_includes(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| {
            let rest = l.trim_start().strip_prefix("#include")?.trim_start().strip_prefix('"')?;
            Some(rest[..rest.find('"')?].replace('\\', "/"))
        })
        .collect()
}

/// An SFZ text with its `#include`s pasted in place. Like sfizz, include paths are relative
/// to the folder of the top file (`top_dir`). `included` collects every file pulled in.
/// Missing files are skipped; cycles and deep nesting stop at a few levels.
pub fn expand_sfz(text: &str, top_dir: &str, texts: &HashMap<String, &str>, included: &mut HashSet<String>) -> String {
    fn go(text: &str, top_dir: &str, texts: &HashMap<String, &str>, included: &mut HashSet<String>, depth: usize, out: &mut String) {
        for line in text.lines() {
            let inc = sfz_includes(line);
            match inc.first() {
                Some(rel) if depth < 8 => {
                    if let Some(p) = join_inside(top_dir, rel) {
                        let key = p.to_lowercase();
                        included.insert(key.clone());
                        if let Some(t) = texts.get(&key) {
                            go(t, top_dir, texts, included, depth + 1, out);
                        }
                    }
                }
                Some(_) => {}
                None => {
                    out.push_str(line);
                    out.push('\n');
                }
            }
        }
    }
    let mut out = String::new();
    go(text, top_dir, texts, included, 0, &mut out);
    out
}

/// The `.sfz` files among `files`, with their text (unreadable ones are skipped).
pub fn read_sfz_texts(dir: &Path, files: &[String]) -> Vec<(String, String)> {
    files
        .iter()
        .filter(|f| f.to_lowercase().ends_with(".sfz"))
        .filter_map(|f| Some((f.clone(), std::fs::read_to_string(dir.join(f)).ok()?)))
        .collect()
}

/// What to list for a set of files (relative, "/"-separated): every `.sfz` that no other
/// `.sfz` includes is an instrument (included ones are fragments of it); audio files used
/// by an instrument are not listed again as one-shots.
pub fn plan_items(files: &[String], sfz_texts: &[(String, String)]) -> Vec<PackItem> {
    let texts: HashMap<String, &str> = sfz_texts.iter().map(|(p, t)| (p.to_lowercase(), t.as_str())).collect();
    let dir_of = |p: &str| p.rsplit_once('/').map_or(String::new(), |(d, _)| d.to_string());
    // Files some other file includes (resolving each as if it were the top file is enough
    // to find them; the real expansion below resolves nested includes correctly).
    let mut fragments: HashSet<String> = HashSet::new();
    for (sfz, text) in sfz_texts {
        let mut inc = HashSet::new();
        expand_sfz(text, &dir_of(sfz), &texts, &mut inc);
        inc.remove(&sfz.to_lowercase());
        fragments.extend(inc);
    }
    let tops: Vec<&(String, String)> = sfz_texts.iter().filter(|(p, _)| !fragments.contains(&p.to_lowercase())).collect();
    // Everything includes everything (a cycle): fall back to listing them all.
    let tops = if tops.is_empty() { sfz_texts.iter().collect() } else { tops };

    let mut used: HashSet<String> = HashSet::new();
    let mut items = Vec::new();
    let mut ids: HashSet<String> = HashSet::new();
    let mut unique = |base: &str| {
        let base = pack_id_for(base, &HashSet::new());
        let mut id = base.clone();
        let mut n = 2;
        while ids.contains(&id) {
            id = format!("{base}-{n}");
            n += 1;
        }
        ids.insert(id.clone());
        id
    };
    for (sfz, text) in tops {
        let dir = dir_of(sfz);
        let full = expand_sfz(text, &dir, &texts, &mut HashSet::new());
        for s in sfz_samples(&full) {
            if let Some(p) = join_inside(&dir, &s) {
                used.insert(p.to_lowercase());
            }
        }
        items.push(PackItem {
            id: unique(sfz),
            name: pretty_name(sfz),
            kind: "instrument".into(),
            file: None,
            sfz: Some(sfz.clone()),
            category: guess_category(sfz),
            credit: None,
            hidden: false,
        });
    }
    for f in files {
        if !is_audio(Path::new(f)) || used.contains(&f.to_lowercase()) {
            continue;
        }
        items.push(PackItem {
            id: unique(f),
            name: pretty_name(f),
            kind: "oneshot".into(),
            file: Some(f.clone()),
            sfz: None,
            category: guess_category(f),
            credit: None,
            hidden: false,
        });
    }
    items
}

/// Packs planned before `#include` was understood listed instrument fragments as
/// instruments and the instrument's recordings as hundreds of loose sounds. Plan them again
/// once from the files on disk. Items that drop out stay in `pack.json` as `hidden`, so a
/// song that already uses one still loads; ids and names of the rest don't change.
pub fn replan(dir: &Path, mut pack: Pack) -> Pack {
    // Only packs with instruments can be affected; the rest are left alone (and not
    // rewritten, so this never races with a write to "Sonidos de internet").
    if pack.plan >= PLAN_VERSION || !pack.items.iter().any(|i| i.kind == "instrument") {
        return pack;
    }
    {
        let Ok((files, _)) = scan_folder(dir, false) else { return pack };
        let fresh = plan_items(&files, &read_sfz_texts(dir, &files));
        if fresh.is_empty() {
            return pack;
        }
        let path_of = |i: &PackItem| i.sfz.as_deref().or(i.file.as_deref()).unwrap_or("").to_lowercase();
        let keep: HashSet<String> = fresh.iter().map(path_of).collect();
        let known: HashSet<String> = pack.items.iter().map(path_of).collect();
        let mut ids: HashSet<String> = pack.items.iter().map(|i| i.id.clone()).collect();
        for it in &mut pack.items {
            it.hidden = !keep.contains(&path_of(it));
        }
        for mut it in fresh.into_iter().filter(|i| !known.contains(&path_of(i))) {
            let base = it.id.clone();
            let mut n = 2;
            while ids.contains(&it.id) {
                it.id = format!("{base}-{n}");
                n += 1;
            }
            ids.insert(it.id.clone());
            pack.items.push(it);
        }
    }
    pack.plan = PLAN_VERSION;
    let _ = write_pack_json(dir, &pack);
    pack
}

/// Audio and `.sfz` files under `dir` (relative, "/"-separated), with their total size.
/// `limited`: refuse folders over the import caps (off for packs already installed).
fn scan_folder(dir: &Path, limited: bool) -> CmdResult<(Vec<String>, u64)> {
    fn walk(root: &Path, dir: &Path, depth: usize, limited: bool, out: &mut Vec<String>, bytes: &mut u64) -> CmdResult<()> {
        if depth > 8 {
            return Ok(());
        }
        let entries = std::fs::read_dir(dir).map_err(|e| err(format!("No se pudo leer la carpeta: {e}")))?;
        for e in entries.flatten() {
            let p = e.path();
            let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                walk(root, &p, depth + 1, limited, out, bytes)?;
            } else if is_audio(&p) || ext_of(&p) == "sfz" {
                *bytes += meta.len();
                if limited && (out.len() >= MAX_IMPORT_FILES || *bytes > MAX_IMPORT_BYTES) {
                    return Err(err("La carpeta es demasiado grande para un paquete (más de 3000 sonidos o 2 GB)"));
                }
                let rel = p.strip_prefix(root).map_err(err)?.to_string_lossy().replace('\\', "/");
                out.push(rel);
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    let mut bytes = 0;
    walk(dir, dir, 0, limited, &mut out, &mut bytes)?;
    out.sort();
    Ok((out, bytes))
}

fn now_iso() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Write `pack.json` the safe way.
pub fn write_pack_json(dir: &Path, pack: &Pack) -> CmdResult<()> {
    let tmp = dir.join("pack.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(pack).map_err(err)?).map_err(err)?;
    std::fs::rename(&tmp, dir.join("pack.json")).map_err(err)
}

/// Copy a folder's sounds into a new pack. Built in `<root>/.tmp/` and moved into place
/// at the end, so a failed import leaves nothing behind.
pub fn import_folder(root: &Path, src: &Path, name: &str) -> CmdResult<Pack> {
    if !src.is_dir() {
        return Err(err("Esa carpeta no existe"));
    }
    let (files, _) = scan_folder(src, true)?;
    let items = plan_items(&files, &read_sfz_texts(src, &files));
    if items.is_empty() {
        return Err(err("No encontré sonidos en esa carpeta (WAV, FLAC, OGG, MP3, AIFF o instrumentos .sfz)"));
    }

    let taken: HashSet<String> = list_packs(root).into_iter().map(|p| p.pack.id).collect();
    let name = name.trim();
    let name = if name.is_empty() { src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() } else { name.to_string() };
    let id = pack_id_for(&name, &taken);
    let staging = root.join(".tmp").join(&id);
    let _ = std::fs::remove_dir_all(&staging);
    let result = (|| -> CmdResult<Pack> {
        for f in &files {
            let rel = safe_relative(f).ok_or_else(|| err("Nombre de archivo inválido"))?;
            let to = staging.join(&rel);
            std::fs::create_dir_all(to.parent().unwrap()).map_err(err)?;
            std::fs::copy(src.join(&rel), &to).map_err(|e| err(format!("No se pudo copiar {f}: {e}")))?;
        }
        let pack = Pack {
            version: PACK_VERSION,
            id: id.clone(),
            name: safe_file_name(&name),
            author: String::new(),
            license: "own".into(),
            license_url: None,
            source_url: None,
            origin: "folder".into(),
            installed_at: now_iso(),
            items,
            plan: PLAN_VERSION,
        };
        write_pack_json(&staging, &pack)?;
        std::fs::rename(&staging, root.join(&id)).map_err(err)?;
        Ok(pack)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn packs_list(app: AppHandle) -> CmdResult<Vec<PackView>> {
    Ok(list_packs(&packs_root(&app)?))
}

/// Copy a folder of the user's sounds as a new pack.
#[tauri::command]
pub async fn pack_import_folder(app: AppHandle, path: String, name: String) -> CmdResult<Vec<PackView>> {
    let root = packs_root(&app)?;
    std::fs::create_dir_all(&root).map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || import_folder(&root, Path::new(&path), &name).map(|_| list_packs(&root)))
        .await
        .map_err(err)?
}

/// Send a pack to the Recycle Bin. Songs that use it still open (the sounds show as missing).
#[tauri::command]
pub async fn pack_delete(app: AppHandle, id: String) -> CmdResult<Vec<PackView>> {
    if !valid_pack_id(&id) {
        return Err(err("Ese paquete no existe"));
    }
    let root = packs_root(&app)?;
    let dir = root.join(&id);
    if !dir.join("pack.json").is_file() {
        return Err(err("Ese paquete no existe"));
    }
    if trash::delete(&dir).is_err() {
        std::fs::remove_dir_all(&dir).map_err(|e| err(format!("No se pudo borrar el paquete: {e}")))?;
    }
    Ok(list_packs(&root))
}

/// Rename a pack (what the library shows).
#[tauri::command]
pub async fn pack_rename(app: AppHandle, id: String, name: String) -> CmdResult<Vec<PackView>> {
    let name = name.trim();
    if !valid_pack_id(&id) || name.is_empty() {
        return Err(err("Poné un nombre"));
    }
    let root = packs_root(&app)?;
    let dir = root.join(&id);
    let mut pack: Pack = serde_json::from_slice(&std::fs::read(dir.join("pack.json")).map_err(|_| err("Ese paquete no existe"))?).map_err(err)?;
    pack.name = name.to_string();
    write_pack_json(&dir, &pack)?;
    Ok(list_packs(&root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_names() {
        let taken: HashSet<String> = ["mis-bombos".to_string()].into();
        assert_eq!(pack_id_for("Mis Bombos!", &HashSet::new()), "mis-bombos");
        assert_eq!(pack_id_for("Mis Bombos!", &taken), "mis-bombos-2");
        assert_eq!(pack_id_for("Batería ñandú", &HashSet::new()), "bateria-nandu");
        assert_eq!(pack_id_for("!!!", &HashSet::new()), "paquete");
        assert!(valid_pack_id("vcsl-keys") && !valid_pack_id("../x") && !valid_pack_id(".tmp"));
        assert_eq!(pretty_name("Kicks/kick_01-hard.wav"), "Kick 01 hard");
        assert_eq!(pretty_name("UprightPianoKW-20220221.sfz"), "Upright Piano KW");
        assert_eq!(pretty_name("FingerBassYR 20190930.sfz"), "Finger Bass YR");
        assert_eq!(pretty_name("cowsynth_fancy_pad.sfz"), "Cowsynth fancy pad");
        assert_eq!(pretty_name("20190930.wav"), "20190930");
        assert_eq!(guess_category("Drums/Kick 808.wav"), "bass"); // 808 wins: it's usually a bass
        assert_eq!(guess_category("one shots/Snare 2.wav"), "drums");
        assert_eq!(guess_category("Rhodes C3.wav"), "keys");
        assert_eq!(guess_category("weird.wav"), "other");
    }

    #[test]
    fn paths_never_leave_the_pack() {
        assert_eq!(safe_relative("a/b.wav"), Some(PathBuf::from("a/b.wav")));
        assert_eq!(safe_relative("./a.wav"), Some(PathBuf::from("a.wav")));
        for bad in ["../x.wav", "a/../../x", "/etc/passwd", "C:/Windows/x.wav", "C:x", ""] {
            assert_eq!(safe_relative(bad), None, "{bad}");
        }
        assert_eq!(join_inside("inst", "samples/c4.wav").as_deref(), Some("inst/samples/c4.wav"));
        assert_eq!(join_inside("inst", "../shared/c4.wav").as_deref(), Some("shared/c4.wav"));
        assert_eq!(join_inside("", "../x.wav"), None);
    }

    #[test]
    fn sfz_sample_references() {
        let sfz = "<control> default_path=Samples\\Piano/\n<region> sample=C4 soft.wav lokey=58 hikey=62 pitch_keycenter=60\n<region>sample=D4.wav key=62 // comment sample=nope.wav\n";
        assert_eq!(sfz_samples(sfz), vec!["Samples/Piano/C4 soft.wav", "Samples/Piano/D4.wav"]);
    }

    #[test]
    fn instruments_hide_their_samples_from_the_one_shots() {
        let files: Vec<String> = ["Piano/piano.sfz", "Piano/s/C4.wav", "Piano/s/D4.wav", "Kick.wav", "readme.txt"].map(String::from).to_vec();
        let sfz = vec![("Piano/piano.sfz".to_string(), "<region> sample=s/C4.wav\n<region> sample=s/D4.wav".to_string())];
        let items = plan_items(&files, &sfz);
        let kinds: Vec<(&str, &str)> = items.iter().map(|i| (i.kind.as_str(), i.name.as_str())).collect();
        assert_eq!(kinds, vec![("instrument", "Piano"), ("oneshot", "Kick")]);
        assert_eq!(items[0].category, "keys");
        assert_eq!(items[1].category, "drums");
    }

    /// Layout of sfzinstruments' War Tuba: top programs `#include` fragments in subfolders,
    /// and sample paths are relative to the top file's folder.
    fn tuba_files() -> (Vec<String>, Vec<(String, String)>) {
        let files: Vec<String> =
            ["Programs/1-solo.sfz", "Programs/legato/sus.sfz", "Programs/legato/fx.sfz", "Samples/a.wav", "Samples/b.wav", "Samples/c.wav", "Extra/hit.wav"]
                .map(String::from)
                .to_vec();
        let sfz = vec![
            ("Programs/1-solo.sfz".to_string(), "<global> sw_default=25\n#include \"legato/sus.sfz\"\n#include \"legato/fx.sfz\"\n".to_string()),
            ("Programs/legato/sus.sfz".to_string(), "<region> sample=..\\Samples\\a.wav\n<region> sample=../Samples/b.wav".to_string()),
            ("Programs/legato/fx.sfz".to_string(), "<region> sample=../Samples/c.wav".to_string()),
        ];
        (files, sfz)
    }

    #[test]
    fn included_fragments_are_part_of_their_instrument() {
        let (files, sfz) = tuba_files();
        assert_eq!(sfz_includes("#include \"legato/sus.sfz\"\n  #include \"x\\y.sfz\"\n// #include \"no.sfz\""), vec!["legato/sus.sfz", "x/y.sfz"]);
        let items = plan_items(&files, &sfz);
        let kinds: Vec<(&str, &str)> = items.iter().map(|i| (i.kind.as_str(), i.name.as_str())).collect();
        assert_eq!(kinds, vec![("instrument", "1 solo"), ("oneshot", "Hit")]);
        // A cycle doesn't hang and still lists something.
        let cyc = vec![("a.sfz".to_string(), "#include \"b.sfz\"".to_string()), ("b.sfz".to_string(), "#include \"a.sfz\"".to_string())];
        assert_eq!(plan_items(&["a.sfz".into(), "b.sfz".into()], &cyc).len(), 2);
    }

    #[test]
    fn old_packs_are_replanned_once_keeping_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("tuba");
        let (files, sfz) = tuba_files();
        for f in &files {
            let p = dir.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            let text = sfz.iter().find(|(n, _)| n == f).map_or("RIFF", |(_, t)| t.as_str());
            std::fs::write(p, text).unwrap();
        }
        // What the old planner made: every .sfz an instrument, every sample a one-shot.
        let old = |path: &str, kind: &str| PackItem {
            id: pack_id_for(path, &HashSet::new()),
            name: pretty_name(path),
            kind: kind.into(),
            file: (kind == "oneshot").then(|| path.to_string()),
            sfz: (kind == "instrument").then(|| path.to_string()),
            category: "winds".into(),
            credit: None,
            hidden: false,
        };
        let pack = Pack {
            version: 1,
            id: "tuba".into(),
            name: "War Tuba".into(),
            author: String::new(),
            license: "CC0-1.0".into(),
            license_url: None,
            source_url: None,
            origin: "catalog".into(),
            installed_at: String::new(),
            items: files.iter().map(|f| old(f, if f.ends_with(".sfz") { "instrument" } else { "oneshot" })).collect(),
            plan: 0,
        };
        let ids: Vec<String> = pack.items.iter().map(|i| i.id.clone()).collect();
        let pack = replan(&dir, pack);
        assert_eq!(pack.plan, PLAN_VERSION);
        assert_eq!(pack.items.iter().map(|i| i.id.clone()).collect::<Vec<_>>(), ids, "ids kept for old songs");
        let shown: Vec<&str> = pack.items.iter().filter(|i| !i.hidden).map(|i| i.name.as_str()).collect();
        assert_eq!(shown, vec!["1 solo", "Hit"]);
        assert_eq!(pack.items[0].category, "winds", "old metadata kept");
        // Written back, so it's done once.
        let saved: Pack = serde_json::from_slice(&std::fs::read(dir.join("pack.json")).unwrap()).unwrap();
        assert_eq!(saved, pack);
    }

    #[test]
    fn import_copies_sounds_into_a_new_pack() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, root) = (tmp.path().join("Mis sonidos"), tmp.path().join("packs"));
        std::fs::create_dir_all(src.join("Bombos")).unwrap();
        std::fs::write(src.join("Bombos/kick 1.wav"), b"RIFF").unwrap();
        std::fs::write(src.join("pad.flac"), b"fLaC").unwrap();
        std::fs::write(src.join("notes.docx"), b"x").unwrap();

        let pack = import_folder(&root, &src, "").unwrap();
        assert_eq!(pack.name, "Mis sonidos");
        assert_eq!(pack.origin, "folder");
        assert_eq!(pack.items.len(), 2);
        assert!(root.join(&pack.id).join("Bombos/kick 1.wav").is_file());
        assert!(!root.join(&pack.id).join("notes.docx").exists());
        let listed = list_packs(&root);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].pack, pack);

        // Same name again: a second pack, not an overwrite.
        let again = import_folder(&root, &src, "Mis sonidos").unwrap();
        assert_ne!(again.id, pack.id);
        // A folder with nothing usable: clear error, nothing left behind.
        let empty = tmp.path().join("vacía");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(import_folder(&root, &empty, "x").is_err());
        assert_eq!(list_packs(&root).len(), 2);
    }
}
