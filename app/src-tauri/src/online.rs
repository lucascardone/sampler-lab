//! Catalogs kept by other people, so the app is not limited to a list we write by hand.
//!
//! Instruments: three public, machine-readable sources of free SFZ instruments, merged
//! with the bundled curated list (`catalog.rs`) and de-duplicated by GitHub repository:
//!   1. the Open Audio Stack registry (licenses reviewed, size + SHA-256 pinned),
//!   2. the `sfzinstruments` GitHub organisation,
//!   3. the `freepats` GitHub organisation.
//! Only entries whose license is clearly free (CC0, CC-BY, CC-BY-SA, Unlicense, MIT, BSD)
//! are kept: no license, "NOASSERTION", GPL and non-commercial ones are left out. The
//! merged list is cached for a day in the app cache dir (GitHub allows 60 anonymous calls
//! an hour) and the cache is also the offline fallback.
//!
//! Single sounds: Openverse (WordPress' search of openly licensed media; it indexes
//! Freesound, Wikimedia and others). No API key needed; anonymous use is limited to about
//! 20 searches a minute and 200 a day per PC. "Agregar" downloads that one file into the
//! "Sonidos de internet" pack, with its author, license and page as the item's credit.

use crate::catalog::CatalogEntry;
use crate::commands::{CmdResult, err, safe_file_name};
use crate::packs::{self, Credit, Pack, PackItem, PackView, PACK_VERSION};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

const OAS_URL: &str = "https://open-audio-stack.github.io/open-audio-stack-registry/plugins/index.json";
const GITHUB_ORGS: &[(&str, &str)] = &[("sfzinstruments", "sfzinstruments"), ("freepats", "FreePats")];
const OPENVERSE_URL: &str = "https://api.openverse.org/v1/audio/";
/// Generic client name (no personal data), required by the GitHub API.
const USER_AGENT: &str = "SamplerLab-desktop";
const CACHE_FILE: &str = "online-catalog.json";
const CACHE_SECS: i64 = 24 * 3600;
/// Same cap as catalog.rs: no instrument bigger than this.
const MAX_INSTRUMENT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// A single sound bigger than this is not a "sound" (and would eat the disk).
const MAX_SOUND_BYTES: u64 = 40 * 1024 * 1024;
pub const ONLINE_PACK_ID: &str = "sonidos-de-internet";
const PAGE_SIZE: u32 = 20;
/// Openverse gives anonymous clients at most 240 results per search.
const MAX_RESULTS: u32 = 240;

/// Repositories in those organisations that are not instruments.
const NOT_INSTRUMENTS: &[&str] = &["mappings", "sfzinstruments.github.io", "sfztemplates", "documentation", "old-tools", "freepats-tools", "legato_vocal_tutorial"];

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .https_only(true)
        .user_agent(USER_AGENT)
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(30))
        .build()
}

// ---------------------------------------------------------------------------
// Licenses
// ---------------------------------------------------------------------------

const FREE_LICENSES: &[&str] = &["CC0-1.0", "CC-BY-3.0", "CC-BY-4.0", "CC-BY-SA-3.0", "CC-BY-SA-4.0", "Unlicense", "MIT", "BSD-2-Clause", "BSD-3-Clause"];

/// The canonical SPDX id if `id` (any case) is a license we accept, else None.
pub fn free_license(id: &str) -> Option<&'static str> {
    FREE_LICENSES.iter().copied().find(|l| l.eq_ignore_ascii_case(id.trim()))
}

pub fn license_url(spdx: &str) -> String {
    let cc = |kind: &str, v: &str| format!("https://creativecommons.org/licenses/{kind}/{v}/");
    match spdx {
        "CC0-1.0" => "https://creativecommons.org/publicdomain/zero/1.0/".into(),
        "PDM" => "https://creativecommons.org/publicdomain/mark/1.0/".into(),
        s if s.starts_with("CC-BY-SA-") => cc("by-sa", &s[9..]),
        s if s.starts_with("CC-BY-") => cc("by", &s[6..]),
        s => format!("https://spdx.org/licenses/{s}.html"),
    }
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

/// "https://github.com/Owner/Repo/anything" → "owner/repo".
pub fn repo_key(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://github.com/")?;
    let mut parts = rest.split('/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let repo = parts.next().filter(|s| !s.is_empty())?.trim_end_matches(".git");
    Some(format!("{owner}/{repo}").to_lowercase())
}

/// A pack id from any text: lowercase letters, digits and `-`, at most 80 chars.
fn slug_id(prefix: &str, text: &str) -> String {
    let mut s = String::from(prefix);
    for c in text.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') {
            s.push('-');
        }
    }
    s.trim_end_matches('-').chars().take(80).collect()
}

fn category_of(text: &str) -> String {
    let c = packs::guess_category(text);
    if c == "other" {
        // A few instrument words the file-name guesser doesn't know.
        let l = text.to_lowercase();
        let has = |w: &[&str]| w.iter().any(|x| l.contains(x));
        if has(&["tuba", "bagpipe", "ocarina", "accordion", "pipes", "shofar"]) {
            return "winds".into();
        }
        if has(&["marimba", "bells", "zither", "banjo", "mandolin", "ukulele", "harp", "lyre", "erhu"]) {
            return "strings".into();
        }
    }
    c
}

/// Entries of the Open Audio Stack registry that are free SFZ instruments in a zip.
pub fn parse_oas(json: &str) -> Vec<CatalogEntry> {
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(json) else { return Vec::new() };
    let mut out = Vec::new();
    for (slug, pkg) in map {
        let Some(ver) = pkg["version"].as_str().and_then(|v| pkg["versions"].get(v)) else { continue };
        if ver["type"].as_str() != Some("sampler") {
            continue; // effects and synth plugins, not sample instruments
        }
        let Some(license) = ver["license"].as_str().and_then(free_license) else { continue };
        let files = ver["files"].as_array().cloned().unwrap_or_default();
        let Some(file) = files.iter().find(|f| {
            let contains_sfz = f["contains"].as_array().is_some_and(|c| c.iter().any(|x| x == "sfz"));
            let url = f["url"].as_str().unwrap_or("");
            contains_sfz && url.starts_with("https://") && url.to_lowercase().ends_with(".zip")
        }) else {
            continue;
        };
        let size = file["size"].as_u64().unwrap_or(0);
        let sha = file["sha256"].as_str().unwrap_or("").to_lowercase();
        if size == 0 || size > MAX_INSTRUMENT_BYTES || sha.len() != 64 {
            continue;
        }
        let text = |k: &str| ver[k].as_str().unwrap_or("").trim().to_string();
        let tags: Vec<String> = ver["tags"].as_array().map(|t| t.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        let download = file["url"].as_str().unwrap().to_string();
        let source = Some(text("url")).filter(|u| u.starts_with("https://")).unwrap_or_else(|| download.clone());
        out.push(CatalogEntry {
            id: slug_id("oas-", &slug),
            name: text("name"),
            description: text("description"),
            // Tags ("Drums", "Keys"…) are more reliable than free text.
            category: Some(category_of(&tags.join(" "))).filter(|c| c != "other").unwrap_or_else(|| category_of(&format!("{} {}", text("name"), text("description")))),
            author: text("author"),
            license: license.into(),
            license_url: license_url(license),
            attribution: None,
            source_url: source,
            download_url: download,
            size_bytes: size,
            sha256: sha,
            source: "oas".into(),
        });
    }
    out
}

/// "karoryfer.squidpipes" → ("Karoryfer", "Squidpipes"); "upright-piano-KW" → (org, "Upright piano KW").
fn split_repo_name(repo: &str, org_label: &str) -> (String, String) {
    let (author, rest) = match repo.split_once('.') {
        Some((a, r)) if !r.is_empty() => {
            let a = a.split('-').next().unwrap_or(a);
            let mut cs = a.chars();
            let a = cs.next().map(|f| f.to_uppercase().collect::<String>() + cs.as_str()).unwrap_or_default();
            (a, r.replace('.', "-"))
        }
        _ => (org_label.to_string(), repo.to_string()),
    };
    (author, packs::pretty_name(&format!("{rest}.x")))
}

/// Repositories of one GitHub organisation (`/orgs/<org>/repos`) that are free instruments.
/// Their archive has no fixed checksum, so `sha256` is empty and `size_bytes` is GitHub's
/// estimate (the download is capped generously around it).
pub fn parse_github(json: &str, org_label: &str) -> Vec<CatalogEntry> {
    let Ok(Value::Array(repos)) = serde_json::from_str::<Value>(json) else { return Vec::new() };
    let mut out = Vec::new();
    for r in repos {
        let name = r["name"].as_str().unwrap_or("");
        let full = r["full_name"].as_str().unwrap_or("");
        if name.is_empty() || full.is_empty() || NOT_INSTRUMENTS.iter().any(|n| n.eq_ignore_ascii_case(name)) {
            continue;
        }
        let Some(license) = r["license"]["spdx_id"].as_str().and_then(free_license) else { continue };
        let size = r["size"].as_u64().unwrap_or(0) * 1024;
        if size < 64 * 1024 || size > MAX_INSTRUMENT_BYTES {
            continue;
        }
        let desc = r["description"].as_str().unwrap_or("").trim();
        let desc = desc.trim_end_matches(" - SFZ instrument").trim().to_string();
        let topics: Vec<&str> = r["topics"].as_array().map(|t| t.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
        let (author, pretty) = split_repo_name(name, org_label);
        out.push(CatalogEntry {
            id: slug_id("gh-", full),
            name: pretty,
            description: desc.clone(),
            category: category_of(&format!("{name} {desc} {}", topics.join(" "))),
            author,
            license: license.into(),
            license_url: license_url(license),
            attribution: None,
            source_url: format!("https://github.com/{full}"),
            download_url: format!("https://github.com/{full}/archive/HEAD.zip"),
            size_bytes: size,
            sha256: String::new(),
            source: "github".into(),
        });
    }
    out
}

/// Curated entries first (they're checked by hand), then the rest from lightest to
/// heaviest; one entry per GitHub repository (the first source wins).
pub fn merge(curated: Vec<CatalogEntry>, online: Vec<Vec<CatalogEntry>>) -> Vec<CatalogEntry> {
    let mut seen_repo: HashSet<String> = HashSet::new();
    let mut seen_id: HashSet<String> = HashSet::new();
    let mut keep = |e: &CatalogEntry| {
        let key = repo_key(&e.source_url).or_else(|| repo_key(&e.download_url));
        let fresh_repo = key.map_or(true, |k| seen_repo.insert(k));
        fresh_repo && seen_id.insert(e.id.clone())
    };
    let mut out: Vec<CatalogEntry> = curated.into_iter().filter(|e| keep(e)).collect();
    let mut rest: Vec<CatalogEntry> = online.into_iter().flatten().filter(|e| keep(e)).collect();
    rest.sort_by_key(|e| e.size_bytes);
    out.extend(rest);
    out
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cache {
    fetched_at: i64,
    entries: Vec<CatalogEntry>,
}

fn cache_path(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_cache_dir().map_err(err)?.join(CACHE_FILE))
}

fn read_cache(path: &Path) -> Option<Cache> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn fetch_all() -> Result<Vec<Vec<CatalogEntry>>, String> {
    let a = agent();
    let get = |url: &str| -> Result<String, String> { a.get(url).call().map_err(|e| e.to_string())?.into_string().map_err(|e| e.to_string()) };
    let mut lists = vec![parse_oas(&get(OAS_URL)?)];
    for (org, label) in GITHUB_ORGS {
        let json = get(&format!("https://api.github.com/orgs/{org}/repos?per_page=100&type=public"))?;
        lists.push(parse_github(&json, label));
    }
    Ok(lists)
}

/// The online instruments: from the cache while it is fresh (unless `refresh`), else
/// downloaded again. Returns the entries and whether the list is up to date.
pub fn online_entries(app: &AppHandle, refresh: bool) -> CmdResult<(Vec<CatalogEntry>, bool)> {
    let path = cache_path(app)?;
    let cached = read_cache(&path);
    let now = chrono::Utc::now().timestamp();
    if let Some(c) = &cached {
        if !refresh && now - c.fetched_at < CACHE_SECS {
            return Ok((c.entries.clone(), true));
        }
    }
    match fetch_all() {
        Ok(lists) => {
            let entries: Vec<CatalogEntry> = lists.into_iter().flatten().collect();
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
                let tmp = path.with_extension("json.tmp");
                if let Ok(bytes) = serde_json::to_vec(&Cache { fetched_at: now, entries: entries.clone() }) {
                    if std::fs::write(&tmp, bytes).is_ok() {
                        let _ = std::fs::rename(&tmp, &path);
                    }
                }
            }
            Ok((entries, true))
        }
        // Offline (or rate-limited): the last list we saw, marked as not up to date.
        Err(_) => Ok((cached.map(|c| c.entries).unwrap_or_default(), false)),
    }
}

// ---------------------------------------------------------------------------
// Single sounds (Openverse)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineSound {
    pub id: String,
    pub title: String,
    pub author: String,
    /// CC0-1.0 | CC-BY-x.y | PDM
    pub license: String,
    pub license_url: String,
    /// The audio file (what "Escuchar" plays and "Agregar" downloads).
    pub url: String,
    /// The sound's page at its source: the credit link.
    pub page_url: String,
    pub duration_ms: Option<u64>,
    pub filetype: String,
    pub size_bytes: Option<u64>,
    /// freesound | wikimedia_audio | jamendo | …
    pub source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundPage {
    pub results: Vec<OnlineSound>,
    pub has_more: bool,
}

const SOUND_EXTS: &[&str] = &["mp3", "ogg", "wav", "flac"];

/// Openverse's license code + version → our SPDX-like id; None if not free enough.
fn openverse_license(code: &str, version: &str) -> Option<String> {
    match code {
        "cc0" => Some("CC0-1.0".into()),
        "pdm" => Some("PDM".into()),
        "by" if !version.is_empty() && version.chars().all(|c| c.is_ascii_digit() || c == '.') => Some(format!("CC-BY-{version}")),
        _ => None,
    }
}

fn ext_from(filetype: &str, url: &str) -> Option<String> {
    let ft = filetype.to_lowercase();
    if SOUND_EXTS.contains(&ft.as_str()) {
        return Some(ft);
    }
    let path = url.split(['?', '#']).next().unwrap_or("");
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_lowercase())?;
    SOUND_EXTS.contains(&ext.as_str()).then_some(ext)
}

pub fn parse_openverse(json: &str, page: u32) -> CmdResult<SoundPage> {
    let v: Value = serde_json::from_str(json).map_err(|_| err("La búsqueda devolvió algo que no se entiende"))?;
    let mut results = Vec::new();
    for r in v["results"].as_array().cloned().unwrap_or_default() {
        let s = |k: &str| r[k].as_str().unwrap_or("").trim().to_string();
        if r["mature"].as_bool() == Some(true) {
            continue;
        }
        let Some(license) = openverse_license(&s("license"), &s("license_version")) else { continue };
        let url = s("url");
        let page_url = s("foreign_landing_url");
        let Some(ext) = ext_from(&s("filetype"), &url) else { continue };
        if !url.starts_with("https://") || s("id").is_empty() {
            continue;
        }
        let title = Some(s("title")).filter(|t| !t.is_empty()).unwrap_or_else(|| "Sonido".into());
        let lic_url = Some(s("license_url")).filter(|u| u.starts_with("https://")).unwrap_or_else(|| license_url(&license));
        results.push(OnlineSound {
            id: s("id"),
            title,
            author: s("creator"),
            license,
            license_url: lic_url,
            url: url.clone(),
            page_url: if page_url.starts_with("https://") { page_url } else { url },
            duration_ms: r["duration"].as_u64(),
            filetype: ext,
            size_bytes: r["filesize"].as_u64(),
            source: s("source"),
        });
    }
    let page_count = v["page_count"].as_u64().unwrap_or(0) as u32;
    let has_more = page < page_count && page * PAGE_SIZE < MAX_RESULTS;
    Ok(SoundPage { results, has_more })
}

/// The item a downloaded sound becomes in the "Sonidos de internet" pack.
pub fn sound_item(s: &OnlineSound, file: String) -> PackItem {
    PackItem {
        id: sound_item_id(&s.id),
        name: s.title.chars().take(60).collect(),
        kind: "oneshot".into(),
        file: Some(file),
        sfz: None,
        category: packs::guess_category(&s.title),
        credit: Some(Credit { author: if s.author.is_empty() { "?".into() } else { s.author.clone() }, license: s.license.clone(), url: Some(s.page_url.clone()) }),
        hidden: false,
    }
}

pub fn sound_item_id(openverse_id: &str) -> String {
    slug_id("ov-", &openverse_id.chars().take(18).collect::<String>())
}

fn empty_online_pack() -> Pack {
    Pack {
        version: PACK_VERSION,
        id: ONLINE_PACK_ID.into(),
        name: "Sonidos de internet".into(),
        author: String::new(),
        // Each sound carries its own credit (author + license).
        license: "mixed".into(),
        license_url: None,
        source_url: Some("https://openverse.org".into()),
        origin: "online".into(),
        installed_at: chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
        items: Vec::new(),
        plan: packs::PLAN_VERSION,
    }
}

/// Put an already-downloaded file (`tmp`) into the online pack, creating the pack if needed.
pub fn add_to_online_pack(root: &Path, s: &OnlineSound, tmp: &Path) -> CmdResult<()> {
    let dir = root.join(ONLINE_PACK_ID);
    std::fs::create_dir_all(&dir).map_err(err)?;
    let mut pack: Pack = std::fs::read(dir.join("pack.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(empty_online_pack);
    let item_id = sound_item_id(&s.id);
    if pack.items.iter().any(|i| i.id == item_id) {
        let _ = std::fs::remove_file(tmp);
        return Ok(());
    }
    let base: String = safe_file_name(&s.title).chars().take(50).collect();
    let file = format!("{} [{}].{}", base.trim(), &item_id[3..item_id.len().min(11)], s.filetype);
    std::fs::rename(tmp, dir.join(&file)).map_err(err)?;
    pack.items.push(sound_item(s, file));
    packs::write_pack_json(&dir, &pack)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The last search results by id (so "Agregar" only downloads what Openverse listed),
/// and a lock so two adds don't write pack.json at the same time.
#[derive(Default)]
pub struct OnlineState {
    seen: Mutex<HashMap<String, OnlineSound>>,
    writing: Arc<Mutex<()>>,
}

#[tauri::command]
pub async fn sound_search(state: State<'_, OnlineState>, query: String, long: bool, page: u32) -> CmdResult<SoundPage> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(SoundPage { results: Vec::new(), has_more: false });
    }
    let page = page.clamp(1, MAX_RESULTS / PAGE_SIZE);
    let body = tauri::async_runtime::spawn_blocking(move || -> CmdResult<String> {
        let resp = agent()
            .get(OPENVERSE_URL)
            .query("q", &q)
            .query("license", "cc0,by,pdm")
            .query("length", if long { "short" } else { "shortest" })
            .query("mature", "false")
            .query("page", &page.to_string())
            .query("page_size", &PAGE_SIZE.to_string())
            .call();
        match resp {
            Ok(r) => r.into_string().map_err(err),
            Err(ureq::Error::Status(429, _)) => Err(err("Hiciste muchas búsquedas seguidas. Esperá un minuto (o, si ya buscaste mucho hoy, probá mañana).")),
            Err(ureq::Error::Status(code, _)) => Err(err(format!("El buscador de sonidos no respondió bien ({code}). Probá de nuevo en un rato."))),
            Err(_) => Err(err("No se pudo buscar. ¿Hay internet?")),
        }
    })
    .await
    .map_err(err)??;
    let result = parse_openverse(&body, page)?;
    let mut seen = state.seen.lock().unwrap();
    if seen.len() > 2000 {
        seen.clear();
    }
    for s in &result.results {
        seen.insert(s.id.clone(), s.clone());
    }
    Ok(result)
}

/// Download one search result into the "Sonidos de internet" pack. Returns every pack.
#[tauri::command]
pub async fn sound_add(app: AppHandle, state: State<'_, OnlineState>, id: String) -> CmdResult<Vec<PackView>> {
    let sound = state.seen.lock().unwrap().get(&id).cloned().ok_or_else(|| err("Buscalo de nuevo y volvé a tocar Agregar"))?;
    let root = packs::packs_root(&app)?;
    let lock = state.writing.clone();
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<Vec<PackView>> {
        let tmp_dir = root.join(".tmp");
        std::fs::create_dir_all(&tmp_dir).map_err(err)?;
        let tmp = tmp_dir.join(format!("{}.part", sound_item_id(&sound.id)));
        let res = (|| -> CmdResult<()> {
            let resp = agent().get(&sound.url).call().map_err(|_| err("No se pudo bajar el sonido. ¿Hay internet?"))?;
            let mut f = std::fs::File::create(&tmp).map_err(err)?;
            let never = std::sync::atomic::AtomicBool::new(false);
            let n = crate::catalog::copy_limited(&mut resp.into_reader(), &mut f, MAX_SOUND_BYTES, &never, |_| {})
                .map_err(|_| err("Ese sonido es demasiado largo para agregarlo (más de 40 MB)"))?;
            if n == 0 {
                return Err(err("El sonido llegó vacío"));
            }
            drop(f);
            let _guard = lock.lock().unwrap();
            add_to_online_pack(&root, &sound, &tmp)
        })();
        let _ = std::fs::remove_file(&tmp);
        res?;
        Ok(packs::list_packs(&root))
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real network: `cargo test real_online -- --ignored --nocapture`. Prints what the
    /// live sources give today.
    #[test]
    #[ignore]
    fn real_online_sources() {
        let lists = fetch_all().unwrap();
        let curated = crate::catalog::parse_catalog(include_str!("../catalog.json")).unwrap();
        println!("oas {} · sfzinstruments {} · freepats {}", lists[0].len(), lists[1].len(), lists[2].len());
        let merged = merge(curated, lists);
        let mut by_cat: HashMap<&str, usize> = HashMap::new();
        for e in &merged {
            *by_cat.entry(e.category.as_str()).or_default() += 1;
            println!("{:8} {:10} {:>6} MB  {:12} {} — {}", e.source, e.category, e.size_bytes / 1_000_000, e.license, e.name, e.author);
        }
        println!("total {} {:?}", merged.len(), by_cat);
        assert!(merged.len() > 50);
        assert!(merged.iter().all(|e| packs::valid_pack_id(&e.id)));
        let body = agent().get(OPENVERSE_URL).query("q", "snare").query("license", "cc0,by,pdm").query("length", "shortest").query("page_size", "20").call().unwrap().into_string().unwrap();
        let page = parse_openverse(&body, 1).unwrap();
        println!("openverse: {} results, more={}", page.results.len(), page.has_more);
        assert!(!page.results.is_empty());
    }

    /// Real network: installs the two smallest GitHub instruments the way the app does.
    #[test]
    #[ignore]
    fn real_online_install_from_github() {
        let mut gh: Vec<CatalogEntry> = fetch_all().unwrap().into_iter().flatten().filter(|e| e.source == "github").collect();
        gh.sort_by_key(|e| e.size_bytes);
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("packs");
        std::fs::create_dir_all(root.join(".tmp")).unwrap();
        for e in gh.iter().take(2) {
            let zip_path = root.join(".tmp/p.zip");
            let resp = agent().get(&e.download_url).call().unwrap();
            let mut f = std::fs::File::create(&zip_path).unwrap();
            let n = crate::catalog::copy_limited(&mut resp.into_reader(), &mut f, e.size_bytes * 2 + (64 << 20), &std::sync::atomic::AtomicBool::new(false), |_| {}).unwrap();
            drop(f);
            let pack = crate::catalog::install_from_zip(&root, e, &zip_path, "now".into()).unwrap();
            println!("{} ({} bytes, estimate {}) → {:?}", e.id, n, e.size_bytes, pack.items.iter().map(|i| (&i.kind, &i.name)).collect::<Vec<_>>());
            assert!(pack.items.iter().any(|i| i.kind == "instrument"));
        }
    }

    #[test]
    fn only_clearly_free_licenses_pass() {
        assert_eq!(free_license("cc0-1.0"), Some("CC0-1.0"));
        assert_eq!(free_license("CC-BY-SA-4.0"), Some("CC-BY-SA-4.0"));
        assert_eq!(free_license("unlicense"), Some("Unlicense"));
        for bad in ["NOASSERTION", "GPL-2.0", "CC-BY-NC-4.0", "other", ""] {
            assert_eq!(free_license(bad), None, "{bad}");
        }
        assert_eq!(license_url("CC-BY-SA-4.0"), "https://creativecommons.org/licenses/by-sa/4.0/");
        assert_eq!(license_url("CC-BY-3.0"), "https://creativecommons.org/licenses/by/3.0/");
    }

    #[test]
    fn repo_keys_match_across_url_shapes() {
        assert_eq!(repo_key("https://github.com/FreePats/upright-piano-KW").as_deref(), Some("freepats/upright-piano-kw"));
        assert_eq!(repo_key("https://github.com/freepats/upright-piano-KW/releases/download/v1/x.zip").as_deref(), Some("freepats/upright-piano-kw"));
        assert_eq!(repo_key("https://example.com/a/b"), None);
    }

    #[test]
    fn github_repos_become_entries_without_checksum() {
        let json = r#"[
          {"name":"karoryfer.squidpipes","full_name":"sfzinstruments/karoryfer.squidpipes","license":{"spdx_id":"CC0-1.0"},"size":43000,"description":"Karoryfer Samples open source instrument Squidpipes","topics":[]},
          {"name":"upright-piano-KW","full_name":"freepats/upright-piano-KW","license":{"spdx_id":"CC0-1.0"},"size":33000,"description":"Upright piano KW - SFZ instrument","topics":["sfz"]},
          {"name":"SalamanderGrandPiano","full_name":"sfzinstruments/SalamanderGrandPiano","license":{"spdx_id":"NOASSERTION"},"size":730000,"description":"x","topics":[]},
          {"name":"Krumhorn","full_name":"sfzinstruments/Krumhorn","license":null,"size":500,"description":"x","topics":[]},
          {"name":"mappings","full_name":"sfzinstruments/mappings","license":{"spdx_id":"CC0-1.0"},"size":900,"description":"x","topics":[]}
        ]"#;
        let list = parse_github(json, "FreePats");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "Squidpipes");
        assert_eq!(list[0].author, "Karoryfer");
        assert_eq!(list[0].category, "winds");
        assert_eq!(list[0].download_url, "https://github.com/sfzinstruments/karoryfer.squidpipes/archive/HEAD.zip");
        assert!(list[0].sha256.is_empty());
        assert_eq!(list[1].name, "Upright piano KW");
        assert_eq!(list[1].description, "Upright piano KW");
        assert_eq!(list[1].author, "FreePats");
        assert_eq!(list[1].category, "keys");
        assert!(list.iter().all(|e| packs::valid_pack_id(&e.id)));
    }

    #[test]
    fn oas_keeps_free_sfz_zips_with_checksums() {
        let sha = "a".repeat(64);
        let json = format!(
            r#"{{
          "sfzinstruments/war-tuba": {{"version":"1","versions":{{"1":{{"type":"sampler","name":"War Tuba","author":"Karoryfer","description":"A tuba","license":"cc-by-4.0","tags":["Brass"],"url":"https://github.com/sfzinstruments/karoryfer.war-tuba",
              "files":[{{"contains":["sfz","flac"],"url":"https://github.com/sfzinstruments/karoryfer.war-tuba/releases/download/v1/t.zip","size":1000,"sha256":"{sha}"}}]}}}}}},
          "zyn/zyn": {{"version":"1","versions":{{"1":{{"name":"Zyn","license":"gpl-2.0","files":[{{"contains":["vst3"],"url":"https://x/z.zip","size":10,"sha256":"{sha}"}}]}}}}}},
          "x/fx": {{"version":"1","versions":{{"1":{{"type":"effect","name":"Fx","license":"mit","files":[{{"contains":["sfz"],"url":"https://x/f.zip","size":10,"sha256":"{sha}"}}]}}}}}},
          "x/nosha": {{"version":"1","versions":{{"1":{{"type":"sampler","name":"N","license":"cc0-1.0","files":[{{"contains":["sfz"],"url":"https://x/n.zip","size":10,"sha256":""}}]}}}}}}
        }}"#
        );
        let list = parse_oas(&json);
        assert_eq!(list.len(), 1);
        let e = &list[0];
        assert_eq!((e.name.as_str(), e.license.as_str(), e.category.as_str(), e.source.as_str()), ("War Tuba", "CC-BY-4.0", "winds", "oas"));
        assert_eq!(e.sha256.len(), 64);
        assert!(packs::valid_pack_id(&e.id));
    }

    #[test]
    fn merge_dedupes_by_repo_and_puts_curated_first() {
        let mk = |id: &str, src: &str, size: u64, source: &str| CatalogEntry {
            id: id.into(),
            name: id.into(),
            description: String::new(),
            category: "keys".into(),
            author: String::new(),
            license: "CC0-1.0".into(),
            license_url: String::new(),
            attribution: None,
            source_url: src.into(),
            download_url: format!("{src}/archive/HEAD.zip"),
            size_bytes: size,
            sha256: String::new(),
            source: source.into(),
        };
        let curated = vec![mk("piano", "https://github.com/freepats/upright-piano-KW", 30, "curated")];
        let oas = vec![mk("oas-big", "https://github.com/sfzinstruments/big", 900, "oas")];
        let gh = vec![
            mk("gh-dup", "https://github.com/FreePats/upright-piano-kw", 30, "github"),
            mk("gh-big", "https://github.com/sfzinstruments/big", 900, "github"),
            mk("gh-small", "https://github.com/sfzinstruments/small", 5, "github"),
        ];
        let ids: Vec<String> = merge(curated, vec![oas, gh]).into_iter().map(|e| e.id).collect();
        assert_eq!(ids, vec!["piano", "gh-small", "oas-big"]);
    }

    #[test]
    fn openverse_results_keep_only_free_https_audio() {
        let json = r#"{"result_count":3,"page_count":5,"results":[
          {"id":"abc-123","title":"Kick","creator":"ana","license":"cc0","license_version":"1.0","license_url":"https://creativecommons.org/publicdomain/zero/1.0/","url":"https://cdn.freesound.org/previews/1/1-hq.mp3","foreign_landing_url":"https://freesound.org/s/1","duration":420,"filetype":"mp3","filesize":9000,"source":"freesound","mature":false},
          {"id":"nc","title":"NC","creator":"b","license":"by-nc","license_version":"4.0","url":"https://x/a.mp3","foreign_landing_url":"https://x","filetype":"mp3","source":"freesound"},
          {"id":"by","title":"","creator":"c","license":"by","license_version":"3.0","url":"https://upload.wikimedia.org/a.ogg?x=1","foreign_landing_url":"https://commons.wikimedia.org/a","filetype":null,"source":"wikimedia_audio"},
          {"id":"http","title":"H","creator":"d","license":"cc0","license_version":"1.0","url":"http://x/a.mp3","filetype":"mp3","source":"x"}
        ]}"#;
        let page = parse_openverse(json, 1).unwrap();
        assert!(page.has_more);
        assert_eq!(page.results.len(), 2);
        assert_eq!(page.results[0].license, "CC0-1.0");
        assert_eq!(page.results[0].duration_ms, Some(420));
        assert_eq!(page.results[1].license, "CC-BY-3.0");
        assert_eq!(page.results[1].filetype, "ogg");
        assert_eq!(page.results[1].title, "Sonido");
        assert_eq!(page.results[1].license_url, "https://creativecommons.org/licenses/by/3.0/");
        assert!(!parse_openverse(r#"{"page_count":12,"results":[]}"#, 12).unwrap().has_more);
    }

    #[test]
    fn added_sounds_land_in_one_pack_with_their_credit() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("packs");
        std::fs::create_dir_all(root.join(".tmp")).unwrap();
        let s = OnlineSound {
            id: "0fa1b2c3-d4e5-4f60-8a9b-0c1d2e3f4a5b".into(),
            title: "Snare: tight/dry".into(),
            author: "ana".into(),
            license: "CC-BY-4.0".into(),
            license_url: license_url("CC-BY-4.0"),
            url: "https://cdn.freesound.org/x.mp3".into(),
            page_url: "https://freesound.org/s/1".into(),
            duration_ms: Some(300),
            filetype: "mp3".into(),
            size_bytes: None,
            source: "freesound".into(),
        };
        for _ in 0..2 {
            let part = root.join(".tmp/a.part");
            std::fs::write(&part, b"ID3").unwrap();
            add_to_online_pack(&root, &s, &part).unwrap();
        }
        let list = packs::list_packs(&root);
        assert_eq!(list.len(), 1);
        let p = &list[0].pack;
        assert_eq!((p.id.as_str(), p.license.as_str(), p.origin.as_str()), (ONLINE_PACK_ID, "mixed", "online"));
        assert_eq!(p.items.len(), 1, "adding twice keeps one copy");
        let it = &p.items[0];
        assert_eq!(it.category, "drums");
        assert_eq!(it.credit.as_ref().unwrap().license, "CC-BY-4.0");
        assert_eq!(it.credit.as_ref().unwrap().url.as_deref(), Some("https://freesound.org/s/1"));
        let file = it.file.as_ref().unwrap();
        assert!(!file.contains('/') && !file.contains(':'), "{file}");
        assert!(root.join(ONLINE_PACK_ID).join(file).is_file());
    }
}
