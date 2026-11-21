//! "Conseguir más sonidos": a curated catalog of free, legally redistributable packs and
//! their one-click install.
//!
//! The curated list ships inside the app (`catalog.json` next to Cargo.toml); `CATALOG_URL`
//! can later point to a hosted copy with the bundled one as fallback. The
//! catalogs kept by other people (`online.rs`) are merged after it.
//! Installing = download over HTTPS (size-capped) → check SHA-256 when the source pins
//! one (GitHub archives can't: they rely on HTTPS + the size cap) → unzip only audio,
//! `.sfz` and license texts, refusing any path that would leave the pack → move into
//! `packs/<id>` in one rename. A failed or cancelled install leaves nothing behind.

use crate::commands::{CmdResult, err};
use crate::packs::{self, Pack, PackView, PACK_VERSION};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// A hosted catalog (none yet: decision D5). The bundled list is always available.
const CATALOG_URL: Option<&str> = None;
const BUNDLED: &str = include_str!("../catalog.json");
/// No pack may be bigger than this, whatever the catalog says.
const MAX_PACK_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub author: String,
    pub license: String,
    pub license_url: String,
    #[serde(default)]
    pub attribution: Option<String>,
    pub source_url: String,
    pub download_url: String,
    /// Exact for pinned entries; GitHub's estimate when `sha256` is empty.
    pub size_bytes: u64,
    /// Empty = not pinned (GitHub archives). The curated list always pins.
    #[serde(default)]
    pub sha256: String,
    /// Where the entry comes from: "curated" (catalog.json) | "oas" | "github".
    #[serde(default = "curated")]
    pub source: String,
}

fn curated() -> String {
    "curated".into()
}

/// What "Conseguir más" shows: every entry, and whether the online part is up to date.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogList {
    pub entries: Vec<CatalogEntry>,
    pub online_ok: bool,
}

pub fn parse_catalog(json: &str) -> CmdResult<Vec<CatalogEntry>> {
    let list: Vec<CatalogEntry> = serde_json::from_str(json).map_err(|e| err(format!("El catálogo está dañado: {e}")))?;
    Ok(list.into_iter().filter(|e| packs::valid_pack_id(&e.id) && e.download_url.starts_with("https://") && e.sha256.len() == 64).collect())
}

/// Copy at most `limit` bytes from `src` to `dst`, reporting progress; more than that is
/// an error (a server can't make us fill the disk). Returns the bytes copied.
pub fn copy_limited(
    src: &mut impl Read,
    dst: &mut impl Write,
    limit: u64,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> CmdResult<u64> {
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(err("Descarga cancelada"));
        }
        let n = src.read(&mut buf).map_err(|e| err(format!("Se cortó la descarga: {e}")))?;
        if n == 0 {
            return Ok(total);
        }
        total += n as u64;
        if total > limit {
            return Err(err("El paquete es más grande de lo esperado: se canceló por seguridad"));
        }
        dst.write_all(&buf[..n]).map_err(err)?;
        progress(total);
    }
}

pub fn sha256_file(path: &Path) -> CmdResult<String> {
    let mut f = std::fs::File::open(path).map_err(err)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(err)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Files kept from an archive: sounds, instruments and license/readme texts.
fn keep_entry(rel: &Path) -> bool {
    let ext = rel.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    packs::is_audio(rel) || ext == "sfz" || ext == "txt" || ext == "md"
}

/// Unzip `zip` into `dest` safely: entries with absolute paths, `..`, drive letters or
/// symlinks make the whole archive invalid; other file types are skipped. Returns the
/// extracted files (relative, "/"-separated).
pub fn extract_zip(zip: impl Read + std::io::Seek, dest: &Path, max_bytes: u64) -> CmdResult<Vec<String>> {
    let mut archive = zip::ZipArchive::new(zip).map_err(|e| err(format!("El archivo descargado no es un zip válido: {e}")))?;
    let mut out = Vec::new();
    let mut written = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(err)?;
        let name = entry.name().replace('\\', "/");
        if entry.is_dir() {
            continue;
        }
        let rel = packs::safe_relative(&name).filter(|_| !entry.is_symlink()).ok_or_else(|| err(format!("El paquete tiene una ruta peligrosa ({name}): no se instaló")))?;
        if !keep_entry(&rel) {
            continue;
        }
        written += entry.size();
        if written > max_bytes {
            return Err(err("El paquete descomprimido es demasiado grande"));
        }
        let to = dest.join(&rel);
        std::fs::create_dir_all(to.parent().unwrap()).map_err(err)?;
        let mut f = std::fs::File::create(&to).map_err(err)?;
        std::io::copy(&mut entry, &mut f).map_err(|e| err(format!("No se pudo descomprimir {name}: {e}")))?;
        out.push(rel.to_string_lossy().replace('\\', "/"));
    }
    out.sort();
    Ok(out)
}

/// Repositories that keep their audio in Git LFS give archives with tiny text "pointer"
/// files instead of sounds: such an instrument would be silent.
pub fn has_lfs_pointers(dir: &Path, files: &[String]) -> bool {
    files.iter().filter(|f| packs::is_audio(Path::new(f))).any(|f| {
        let p = dir.join(f);
        std::fs::metadata(&p).is_ok_and(|m| m.len() < 1024) && std::fs::read(&p).is_ok_and(|b| b.starts_with(b"version https://git-lfs"))
    })
}

/// Archives often wrap everything in one folder ("Piano-1.0/…"): drop it, so paths in the
/// pack are short. Returns the prefix removed ("" if none).
pub fn common_top_folder(files: &[String]) -> String {
    let first = files.first().and_then(|f| f.split_once('/')).map(|(d, _)| d.to_string());
    match first {
        Some(d) if files.iter().all(|f| f.starts_with(&format!("{d}/"))) => format!("{d}/"),
        _ => String::new(),
    }
}

/// Make the installed pack: items from the extracted files, metadata from the catalog.
pub fn build_pack(entry: &CatalogEntry, dir: &Path, files: &[String], installed_at: String) -> CmdResult<Pack> {
    let mut items = packs::plan_items(files, &packs::read_sfz_texts(dir, files));
    if items.is_empty() {
        return Err(err("El paquete no trae sonidos que la app pueda usar"));
    }
    for it in &mut items {
        if it.category == "other" {
            it.category = entry.category.clone();
        }
    }
    Ok(Pack {
        version: PACK_VERSION,
        id: entry.id.clone(),
        name: entry.name.clone(),
        author: entry.author.clone(),
        license: entry.license.clone(),
        license_url: Some(entry.license_url.clone()),
        source_url: Some(entry.source_url.clone()),
        origin: "catalog".into(),
        installed_at,
        items,
        plan: packs::PLAN_VERSION,
    })
}

/// Unzip a downloaded archive into staging, flatten a single top folder and write pack.json.
pub fn install_from_zip(root: &Path, entry: &CatalogEntry, zip_path: &Path, installed_at: String) -> CmdResult<Pack> {
    let staging = root.join(".tmp").join(format!("{}-x", entry.id));
    let _ = std::fs::remove_dir_all(&staging);
    let result = (|| -> CmdResult<Pack> {
        let raw = staging.join("raw");
        let files = extract_zip(std::fs::File::open(zip_path).map_err(err)?, &raw, MAX_PACK_BYTES * 3)?;
        let top = common_top_folder(&files);
        let content = if top.is_empty() { raw.clone() } else { raw.join(top.trim_end_matches('/')) };
        let files: Vec<String> = files.iter().map(|f| f[top.len()..].to_string()).collect();
        if has_lfs_pointers(&content, &files) {
            return Err(err("Este instrumento guarda sus sonidos de una forma (Git LFS) que la app no puede bajar. Probá con otro."));
        }
        let pack = build_pack(entry, &content, &files, installed_at)?;
        packs::write_pack_json(&content, &pack)?;
        let dest = root.join(&entry.id);
        if dest.exists() {
            std::fs::remove_dir_all(&dest).map_err(|e| err(format!("No se pudo reemplazar la versión anterior: {e}")))?;
        }
        std::fs::rename(&content, &dest).map_err(err)?;
        Ok(pack)
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Installs in progress (id → cancel flag).
#[derive(Default)]
pub struct CatalogState {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: String,
    /// "download" | "verify" | "extract"
    stage: &'static str,
    received: u64,
    total: u64,
}

/// The curated list (hosted copy if any, else the bundled one).
async fn curated_list() -> CmdResult<Vec<CatalogEntry>> {
    if let Some(url) = CATALOG_URL {
        let fetched = tauri::async_runtime::spawn_blocking(move || -> CmdResult<String> {
            let agent = ureq::AgentBuilder::new().https_only(true).timeout(std::time::Duration::from_secs(15)).build();
            agent.get(url).call().map_err(err)?.into_string().map_err(err)
        })
        .await
        .map_err(err)?;
        if let Ok(list) = fetched.and_then(|j| parse_catalog(&j)) {
            return Ok(list);
        }
    }
    parse_catalog(BUNDLED)
}

async fn full_list(app: &AppHandle, refresh: bool) -> CmdResult<CatalogList> {
    let curated = curated_list().await?;
    let app2 = app.clone();
    let (online, online_ok) = tauri::async_runtime::spawn_blocking(move || crate::online::online_entries(&app2, refresh)).await.map_err(err)??;
    Ok(CatalogList { entries: crate::online::merge(curated, vec![online]), online_ok })
}

/// Everything "Conseguir más" can install. `refresh` re-downloads the online catalogs
/// (otherwise they're cached for a day).
#[tauri::command]
pub async fn catalog_fetch(app: AppHandle, refresh: Option<bool>) -> CmdResult<CatalogList> {
    full_list(&app, refresh.unwrap_or(false)).await
}

/// Download and install a catalog pack, with `pack-progress` events.
#[tauri::command]
pub async fn pack_install(app: AppHandle, state: State<'_, CatalogState>, id: String) -> CmdResult<Vec<PackView>> {
    let entry = full_list(&app, false).await?.entries.into_iter().find(|e| e.id == id).ok_or_else(|| err("Ese paquete no está en el catálogo"))?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut running = state.running.lock().unwrap();
        if running.contains_key(&id) {
            return Err(err("Ese paquete ya se está descargando"));
        }
        running.insert(id.clone(), cancel.clone());
    }
    let root = packs::packs_root(&app)?;
    let app2 = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> CmdResult<()> {
        let tmp_dir = root.join(".tmp");
        std::fs::create_dir_all(&tmp_dir).map_err(err)?;
        let zip_path = tmp_dir.join(format!("{}.zip", entry.id));
        let emit = |stage: &'static str, received: u64| {
            let _ = app2.emit("pack-progress", Progress { id: entry.id.clone(), stage, received, total: entry.size_bytes });
        };
        let res = (|| -> CmdResult<()> {
            let agent = ureq::AgentBuilder::new().https_only(true).timeout_connect(std::time::Duration::from_secs(20)).build();
            let resp = agent.get(&entry.download_url).call().map_err(|e| err(format!("No se pudo descargar (¿hay internet?): {e}")))?;
            let mut file = std::fs::File::create(&zip_path).map_err(err)?;
            let pinned = !entry.sha256.is_empty();
            // Pinned sizes are exact; GitHub's are estimates of the repository, so leave room.
            let limit = if pinned { entry.size_bytes + entry.size_bytes / 20 + 1024 } else { (entry.size_bytes * 2).max(entry.size_bytes + 64 * 1024 * 1024) }.min(MAX_PACK_BYTES);
            let mut last = 0u64;
            copy_limited(&mut resp.into_reader(), &mut file, limit, &cancel, |n| {
                // Every ~1 MB is plenty for a progress bar.
                if n - last > 1_000_000 {
                    last = n;
                    emit("download", n);
                }
            })?;
            drop(file);
            if pinned {
                emit("verify", entry.size_bytes);
                let got = sha256_file(&zip_path)?;
                if !got.eq_ignore_ascii_case(&entry.sha256) {
                    return Err(err("El archivo descargado no es el esperado (no coincide la verificación): no se instaló"));
                }
            }
            emit("extract", entry.size_bytes);
            let stamp = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
            install_from_zip(&root, &entry, &zip_path, stamp)?;
            Ok(())
        })();
        let _ = std::fs::remove_file(&zip_path);
        res
    })
    .await
    .map_err(err)
    .and_then(|r| r);
    state.running.lock().unwrap().remove(&id);
    result?;
    Ok(packs::list_packs(&packs::packs_root(&app)?))
}

#[tauri::command]
pub fn pack_cancel(state: State<'_, CatalogState>, id: String) {
    if let Some(flag) = state.running.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, data) in entries {
            w.start_file(*name, opts).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    fn entry(id: &str) -> CatalogEntry {
        CatalogEntry {
            id: id.into(),
            name: "Piano".into(),
            description: "d".into(),
            category: "keys".into(),
            author: "A".into(),
            license: "CC0-1.0".into(),
            license_url: "https://x/l".into(),
            attribution: None,
            source_url: "https://x".into(),
            download_url: "https://x/p.zip".into(),
            size_bytes: 10,
            sha256: String::new(),
            source: "curated".into(),
        }
    }

    #[test]
    fn the_bundled_catalog_is_valid() {
        for e in parse_catalog(BUNDLED).unwrap() {
            assert!(e.download_url.starts_with("https://"), "{}", e.id);
            assert_eq!(e.sha256.len(), 64, "{}", e.id);
            assert!(e.size_bytes > 0 && e.size_bytes < MAX_PACK_BYTES, "{}", e.id);
            assert!(!e.license_url.is_empty(), "{}", e.id);
        }
        // Only HTTPS, valid ids.
        let list = parse_catalog(r#"[{"id":"ok","name":"a","description":"","category":"keys","author":"","license":"CC0-1.0","licenseUrl":"","sourceUrl":"","downloadUrl":"http://x","sizeBytes":1,"sha256":""}]"#).unwrap();
        assert!(list.is_empty());
        // A hosted curated list must pin every download.
        let list = parse_catalog(r#"[{"id":"ok","name":"a","description":"","category":"keys","author":"","license":"CC0-1.0","licenseUrl":"","sourceUrl":"","downloadUrl":"https://x","sizeBytes":1,"sha256":""}]"#).unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn downloads_are_capped_and_cancellable() {
        let never = AtomicBool::new(false);
        let mut out = Vec::new();
        let mut seen = 0;
        assert_eq!(copy_limited(&mut Cursor::new(vec![7u8; 1000]), &mut out, 1000, &never, |n| seen = n).unwrap(), 1000);
        assert_eq!(seen, 1000);
        assert!(copy_limited(&mut Cursor::new(vec![7u8; 1001]), &mut Vec::new(), 1000, &never, |_| {}).is_err());
        let stop = AtomicBool::new(true);
        assert!(copy_limited(&mut Cursor::new(vec![7u8; 10]), &mut Vec::new(), 1000, &stop, |_| {}).is_err());
    }

    /// Real network: `cargo test real_install -- --ignored`. Downloads the smallest
    /// catalog pack and installs it into a temp folder, exactly like the app.
    #[test]
    #[ignore]
    fn real_install_of_the_smallest_pack() {
        let e = parse_catalog(BUNDLED).unwrap().into_iter().min_by_key(|e| e.size_bytes).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("packs");
        std::fs::create_dir_all(root.join(".tmp")).unwrap();
        let zip_path = root.join(".tmp/p.zip");
        let agent = ureq::AgentBuilder::new().https_only(true).build();
        let resp = agent.get(&e.download_url).call().unwrap();
        let mut f = std::fs::File::create(&zip_path).unwrap();
        copy_limited(&mut resp.into_reader(), &mut f, e.size_bytes + 1024, &AtomicBool::new(false), |_| {}).unwrap();
        drop(f);
        assert_eq!(sha256_file(&zip_path).unwrap(), e.sha256);
        let pack = install_from_zip(&root, &e, &zip_path, "now".into()).unwrap();
        println!("{} → {:?}", e.id, pack.items.iter().map(|i| (&i.kind, &i.name)).collect::<Vec<_>>());
        assert!(pack.items.iter().any(|i| i.kind == "instrument"));
    }

    #[test]
    fn lfs_pointer_archives_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("packs");
        let zip_path = tmp.path().join("p.zip");
        let pointer: &[u8] = b"version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n";
        std::fs::write(&zip_path, zip_of(&[("R-main/p.sfz", b"<region> sample=c4.wav"), ("R-main/c4.wav", pointer)])).unwrap();
        let e = install_from_zip(&root, &entry("lfs"), &zip_path, "now".into()).unwrap_err();
        assert!(e.0.contains("LFS"), "{}", e.0);
        assert!(!root.join("lfs").exists());
    }

    #[test]
    fn sha256_matches_known_value() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("abc");
        std::fs::write(&p, b"abc").unwrap();
        assert_eq!(sha256_file(&p).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn zip_slip_and_symlinks_are_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["../evil.wav", "a/../../evil.wav", "/abs.wav", "C:/x.wav"] {
            let z = zip_of(&[("ok.wav", b"x"), (bad, b"x")]);
            assert!(extract_zip(Cursor::new(z), &tmp.path().join("out"), 1 << 20).is_err(), "{bad}");
        }
        assert!(!tmp.path().join("evil.wav").exists());
    }

    #[test]
    fn only_sounds_instruments_and_texts_are_extracted() {
        let tmp = tempfile::tempdir().unwrap();
        let z = zip_of(&[("Piano-1.0/piano.sfz", b"<region> sample=s/c4.wav"), ("Piano-1.0/s/c4.wav", b"RIFF"), ("Piano-1.0/LICENSE.txt", b"CC0"), ("Piano-1.0/run.exe", b"MZ")]);
        let files = extract_zip(Cursor::new(z), tmp.path(), 1 << 20).unwrap();
        assert_eq!(files, vec!["Piano-1.0/LICENSE.txt", "Piano-1.0/piano.sfz", "Piano-1.0/s/c4.wav"]);
        assert!(!tmp.path().join("Piano-1.0/run.exe").exists());
        assert_eq!(common_top_folder(&files), "Piano-1.0/");
        assert_eq!(common_top_folder(&["a.wav".into(), "d/b.wav".into()]), "");
        // Too big once unzipped.
        let big = zip_of(&[("a.wav", &[0u8; 2000])]);
        assert!(extract_zip(Cursor::new(big), &tmp.path().join("big"), 1000).is_err());
    }

    #[test]
    fn install_flattens_the_top_folder_and_lists_the_instrument() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("packs");
        let zip_path = tmp.path().join("p.zip");
        std::fs::write(&zip_path, zip_of(&[("Piano-1.0/piano.sfz", b"<region> sample=s/c4.wav"), ("Piano-1.0/s/c4.wav", b"RIFF"), ("Piano-1.0/kick.wav", b"RIFF")])).unwrap();
        let pack = install_from_zip(&root, &entry("free-piano"), &zip_path, "2026-01-01T00:00:00".into()).unwrap();
        assert_eq!(pack.origin, "catalog");
        assert_eq!(pack.license, "CC0-1.0");
        let kinds: Vec<&str> = pack.items.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds, vec!["instrument", "oneshot"]);
        assert!(root.join("free-piano/piano.sfz").is_file());
        assert!(root.join("free-piano/s/c4.wav").is_file());
        assert_eq!(packs::list_packs(&root).len(), 1);
        assert!(!root.join(".tmp/free-piano-x").exists(), "staging cleaned up");
        // Reinstalling replaces the old copy.
        install_from_zip(&root, &entry("free-piano"), &zip_path, "2026-01-02T00:00:00".into()).unwrap();
        assert_eq!(packs::list_packs(&root).len(), 1);
    }
}
