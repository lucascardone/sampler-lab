//! Use the studio from a phone on the same Wi-Fi.
//!
//! When enabled from the desktop app, a small HTTP server on the local network serves
//! the web UI (the same React app, in its phone layout) and a tiny API for what the
//! studio needs from the PC: the sample library (rendered audio), the song, and exports.
//! The phone runs the audio engine itself (sound comes out of the phone).
//!
//! Safety:
//! - Off by default; on only while the user enables it. Stopping it changes the code.
//! - Every API call needs the random code from the QR (constant-time compare).
//! - Only clients on private/local networks are answered (no internet exposure even if
//!   a router forwards the port).
//! - The phone can only read rendered samples from the app's cache, and can only write
//!   exports into one fixed folder (never an arbitrary path on the PC).

use crate::commands::{AppState, CmdResult, err};
use crate::library::{self, LibraryState};
use serde::Serialize;
use serde_json::{Value, json};
use std::io::Read;
use std::net::{IpAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// Preferred port (stable, so a bookmark on the phone keeps working).
const PORT: u16 = 47321;

// ---------------------------------------------------------------------------
// Generic HTTP core (testable without a Tauri app)
// ---------------------------------------------------------------------------

pub trait Backend: Send + Sync + 'static {
    /// Run an API command. `raw` is the request body for binary commands.
    fn invoke(&self, cmd: &str, args: Value, raw: Option<Vec<u8>>) -> Result<Value, String>;
    /// A rendered sample the phone may read (the backend validates the path).
    fn file(&self, path: &str) -> Result<Vec<u8>, String>;
    /// A static file of the web UI: (bytes, content type).
    fn asset(&self, path: &str) -> Option<(Vec<u8>, String)>;
}

/// Private, loopback or link-local addresses only.
pub fn is_lan(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_lan(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

/// Compare without leaking how many characters matched.
pub fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Value of `key` in a URL query string, percent-decoded.
pub fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (k == key).then(|| percent_decode(v))
    })
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// Where a file the phone asked to export goes: always inside `dir`, with just the
/// (sanitized) file name of what was requested.
pub fn remote_target(dir: &Path, requested: &str, default_ext: &str) -> PathBuf {
    let name = requested.rsplit(['/', '\\', ':']).next().unwrap_or("").trim();
    let mut name = crate::commands::safe_file_name(if name.is_empty() { "export" } else { name });
    if !name.contains('.') {
        name.push('.');
        name.push_str(default_ext);
    }
    dir.join(name)
}

pub struct Running {
    http: Arc<tiny_http::Server>,
    thread: Option<std::thread::JoinHandle<()>>,
    pub port: u16,
    pub token: String,
}

impl Running {
    pub fn stop(mut self) {
        self.http.unblock();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

pub fn new_token() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("system RNG");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Start serving on 0.0.0.0 (preferred port, else any free one).
pub fn serve(backend: Arc<dyn Backend>, port: u16, token: String) -> std::io::Result<Running> {
    let http = tiny_http::Server::http(("0.0.0.0", port))
        .or_else(|_| tiny_http::Server::http(("0.0.0.0", 0)))
        .map_err(std::io::Error::other)?;
    let port = http.server_addr().to_ip().map_or(port, |a| a.port());
    let http = Arc::new(http);
    let (h, tok) = (http.clone(), token.clone());
    let thread = std::thread::spawn(move || {
        for rq in h.incoming_requests() {
            let (b, t) = (backend.clone(), tok.clone());
            // One thread per request: the phone fetches several samples in parallel.
            std::thread::spawn(move || handle(&*b, &t, rq));
        }
    });
    Ok(Running { http, thread: Some(thread), port, token })
}

fn respond(rq: tiny_http::Request, status: u16, body: Vec<u8>, ctype: &str) {
    let mut resp = tiny_http::Response::from_data(body).with_status_code(status);
    if let Ok(h) = tiny_http::Header::from_bytes("Content-Type", ctype) {
        resp.add_header(h);
    }
    // The phone always gets fresh data (the song and renders change).
    if let Ok(h) = tiny_http::Header::from_bytes("Cache-Control", "no-store") {
        resp.add_header(h);
    }
    let _ = rq.respond(resp);
}

fn json_error(rq: tiny_http::Request, status: u16, msg: &str) {
    respond(rq, status, json!({ "error": msg }).to_string().into_bytes(), "application/json");
}

fn header(rq: &tiny_http::Request, name: &str) -> Option<String> {
    rq.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

pub fn handle(backend: &dyn Backend, token: &str, mut rq: tiny_http::Request) {
    if !rq.remote_addr().is_some_and(|a| is_lan(a.ip())) {
        return json_error(rq, 403, "Solo se acepta la red local");
    }
    let url = rq.url().to_string();
    let path = url.split('?').next().unwrap_or("/").to_string();

    if let Some(cmd) = path.strip_prefix("/api/invoke/") {
        if *rq.method() != tiny_http::Method::Post {
            return json_error(rq, 405, "Usá POST");
        }
        if !header(&rq, "x-token").is_some_and(|t| token_eq(&t, token)) {
            return json_error(rq, 401, "Código inválido: volvé a escanear el QR en la PC");
        }
        let raw = header(&rq, "x-raw").is_some();
        let mut body = Vec::new();
        if rq.as_reader().take(512 * 1024 * 1024).read_to_end(&mut body).is_err() {
            return json_error(rq, 400, "No se pudo leer el pedido");
        }
        let (args, raw_body) = if raw {
            (Value::Null, Some(body))
        } else if body.is_empty() {
            (Value::Object(Default::default()), None)
        } else {
            match serde_json::from_slice(&body) {
                Ok(v) => (v, None),
                Err(_) => return json_error(rq, 400, "JSON inválido"),
            }
        };
        return match backend.invoke(cmd, args, raw_body) {
            Ok(v) => respond(rq, 200, json!({ "ok": v }).to_string().into_bytes(), "application/json"),
            Err(e) => json_error(rq, 400, &e),
        };
    }

    if path == "/api/file" {
        if !query_param(&url, "t").is_some_and(|t| token_eq(&t, token)) {
            return json_error(rq, 401, "Código inválido");
        }
        let Some(p) = query_param(&url, "path") else { return json_error(rq, 400, "Falta el archivo") };
        return match backend.file(&p) {
            Ok(bytes) => respond(rq, 200, bytes, content_type(&p)),
            Err(e) => json_error(rq, 404, &e),
        };
    }

    // Static web UI (the app shell isn't secret; everything that matters is behind /api).
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    match backend.asset(rel).or_else(|| (!rel.contains('.')).then(|| backend.asset("index.html")).flatten()) {
        Some((bytes, ctype)) => respond(rq, 200, bytes, &ctype),
        None => respond(rq, 404, b"No encontrado".to_vec(), "text/plain; charset=utf-8"),
    }
}

/// This PC's address on the local network (the interface used for the default route).
pub fn lan_ip() -> Option<IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    // No packet is sent: connecting a UDP socket just picks the outgoing interface.
    s.connect("192.168.255.255:9").or_else(|_| s.connect("8.8.8.8:80")).ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_unspecified()).then_some(ip)
}

pub fn qr_svg(text: &str) -> Option<String> {
    let code = qrcode::QrCode::new(text.as_bytes()).ok()?;
    Some(
        code.render::<qrcode::render::svg::Color>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .dark_color(qrcode::render::svg::Color("#15171c"))
            .light_color(qrcode::render::svg::Color("#ebe7df"))
            .build(),
    )
}

// ---------------------------------------------------------------------------
// The real backend: the Tauri app
// ---------------------------------------------------------------------------

struct AppBackend {
    app: AppHandle,
}

/// Folder on the PC where exports made from the phone go.
fn phone_exports_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    let base = app.path().audio_dir().or_else(|_| app.path().document_dir()).map_err(err)?;
    let dir = base.join("Sampler Lab").join("Desde el celu");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

fn song_stamp(app: &AppHandle) -> u64 {
    app.path()
        .app_data_dir()
        .ok()
        .and_then(|d| std::fs::metadata(d.join("songs").join("current.json")).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

fn to_json<T: Serialize>(v: Result<T, crate::commands::CmdError>) -> Result<Value, String> {
    v.map_err(|e| e.0).and_then(|x| serde_json::to_value(x).map_err(|e| e.to_string()))
}

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key).and_then(Value::as_str).map(str::to_string).ok_or_else(|| format!("Falta {key}"))
}

/// Library and pack listings, sample audio and analysis: read-only calls shared by the
/// phone and by guests of a jam room (`jam.rs`).
pub fn read_only_call(app: &AppHandle, cmd: &str, args: Value) -> Result<Value, String> {
    match cmd {
        "library_list" => to_json(tauri::async_runtime::block_on(library::library_list(app.clone()))),
        // Packs: the phone can list and play them, never install, import or delete.
        "packs_list" => to_json(tauri::async_runtime::block_on(crate::packs::packs_list(app.clone()))),
        "library_sample_audio" => {
            let (sid, smp) = (arg_str(&args, "sessionId")?, arg_str(&args, "sampleId")?);
            let stretch = args.get("stretch").and_then(Value::as_f64);
            let state: State<'_, AppState> = app.state();
            let lib: State<'_, LibraryState> = app.state();
            to_json(tauri::async_runtime::block_on(library::library_sample_audio(app.clone(), state, lib, sid, smp, stretch)))
        }
        "library_analyze" => {
            let (sid, smp) = (arg_str(&args, "sessionId")?, arg_str(&args, "sampleId")?);
            let state: State<'_, AppState> = app.state();
            let lib: State<'_, LibraryState> = app.state();
            to_json(tauri::async_runtime::block_on(library::library_analyze(app.clone(), state, lib, sid, smp)))
        }
        other => Err(format!("\"{other}\" no está disponible")),
    }
}

/// A rendered library sample or a pack sound, for the phone or a jam guest. Only audio
/// or `.sfz` files inside the library cache or the packs folder.
pub fn read_shared_sound(app: &AppHandle, path: &str) -> Result<Vec<u8>, String> {
    let not_allowed = || "Ese archivo no se puede compartir".to_string();
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("library");
    let packs = crate::packs::packs_root(app).map_err(|e| e.0)?;
    let file = dunce_canonical(Path::new(path)).ok_or_else(not_allowed)?;
    let roots: Vec<PathBuf> = [cache, packs].iter().filter_map(|r| dunce_canonical(r)).collect();
    if !phone_may_read(&file, &roots) {
        return Err(not_allowed());
    }
    std::fs::read(&file).map_err(|e| e.to_string())
}

impl Backend for AppBackend {
    fn invoke(&self, cmd: &str, args: Value, raw: Option<Vec<u8>>) -> Result<Value, String> {
        let app = &self.app;
        match cmd {
            "library_list" | "packs_list" | "library_sample_audio" | "library_analyze" => read_only_call(app, cmd, args),
            "song_load" => to_json(tauri::async_runtime::block_on(crate::studio::song_load(app.clone()))),
            "song_save" => {
                let song = args.get("song").cloned().ok_or("Falta la canción")?;
                tauri::async_runtime::block_on(crate::studio::song_save(app.clone(), song)).map_err(|e| e.0)?;
                let stamp = song_stamp(app);
                let _ = app.emit("song-saved-remotely", stamp);
                Ok(json!(stamp))
            }
            "song_stamp" => Ok(json!(song_stamp(app))),
            "export_song" | "save_file" => {
                let bytes = raw.ok_or("Faltan los datos")?;
                let dir = phone_exports_dir(app).map_err(|e| e.0)?;
                let ext = if cmd == "export_song" { "wav" } else { "mid" };
                let target = |p: &str| -> CmdResult<PathBuf> { Ok(remote_target(&dir, p, ext)) };
                let written = if cmd == "export_song" {
                    crate::studio::write_export(&bytes, target)
                } else {
                    crate::studio::write_file_payload(&bytes, target)
                }
                .map_err(|e| e.0)?;
                Ok(json!(written.to_string_lossy()))
            }
            // MIDI keyboards are connected to the PC, not the phone.
            "midi_sync" => Ok(json!([])),
            other => Err(format!("\"{other}\" no está disponible desde el celu")),
        }
    }

    fn file(&self, path: &str) -> Result<Vec<u8>, String> {
        read_shared_sound(&self.app, path)
    }

    fn asset(&self, path: &str) -> Option<(Vec<u8>, String)> {
        if path.contains("..") {
            return None;
        }
        if cfg!(debug_assertions) {
            // Development: the built UI in app/dist (run `npm run build` once).
            let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("dist");
            let bytes = std::fs::read(dist.join(path)).ok()?;
            Some((bytes, content_type(path).to_string()))
        } else {
            let a = self.app.asset_resolver().get(path.to_string())?;
            Some((a.bytes, a.mime_type))
        }
    }
}

/// The phone may read rendered library audio and the sounds/instruments of packs:
/// existing audio or `.sfz` files inside one of `roots` (canonical paths), nothing else.
fn phone_may_read(file: &Path, roots: &[PathBuf]) -> bool {
    let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let kind_ok = crate::packs::is_audio(file) || ext == "sfz";
    file.is_file() && kind_ok && roots.iter().any(|r| file.starts_with(r))
}

/// Canonical path without Windows' `\\?\` prefix quirks breaking `starts_with`.
fn dunce_canonical(p: &Path) -> Option<PathBuf> {
    let c = std::fs::canonicalize(p).ok()?;
    let s = c.to_string_lossy();
    Some(PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s)))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct RemoteState {
    running: Mutex<Option<Running>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    url: String,
    qr_svg: String,
    port: u16,
    /// False if no local network was found (the URL then only works on this PC).
    on_network: bool,
    /// Development build without app/dist: the phone page won't load until it's built.
    needs_build: bool,
}

fn info(r: &Running) -> RemoteInfo {
    let ip = lan_ip();
    let host = ip.map_or("127.0.0.1".to_string(), |i| i.to_string());
    let url = format!("http://{host}:{}/?t={}", r.port, r.token);
    let needs_build = cfg!(debug_assertions)
        && !Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("dist").join("index.html").exists();
    RemoteInfo { qr_svg: qr_svg(&url).unwrap_or_default(), url, port: r.port, on_network: ip.is_some(), needs_build }
}

#[tauri::command]
pub fn remote_status(state: State<'_, RemoteState>) -> Option<RemoteInfo> {
    state.running.lock().unwrap().as_ref().map(info)
}

#[tauri::command]
pub fn remote_start(app: AppHandle, state: State<'_, RemoteState>) -> CmdResult<RemoteInfo> {
    let mut guard = state.running.lock().unwrap();
    if let Some(r) = guard.as_ref() {
        return Ok(info(r));
    }
    let backend = Arc::new(AppBackend { app: app.clone() });
    let running = serve(backend, PORT, new_token()).map_err(|e| err(format!("No se pudo abrir la conexión para el celu: {e}")))?;
    let i = info(&running);
    *guard = Some(running);
    Ok(i)
}

/// Stop serving. The next start uses a new code, so old QR links stop working.
#[tauri::command]
pub fn remote_stop(state: State<'_, RemoteState>) {
    if let Some(r) = state.running.lock().unwrap().take() {
        r.stop();
    }
}

pub fn shutdown(app: &AppHandle) {
    if let Some(s) = app.try_state::<RemoteState>()
        && let Some(r) = s.running.lock().unwrap().take()
    {
        r.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_reads_only_sounds_inside_library_or_packs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce_canonical(tmp.path()).unwrap();
        let (lib, packs, other) = (root.join("library"), root.join("packs"), root.join("private"));
        for d in [&lib, &packs.join("p1"), &other] {
            std::fs::create_dir_all(d).unwrap();
        }
        for f in [lib.join("a.wav"), packs.join("p1/piano.sfz"), packs.join("p1/c4.flac"), packs.join("p1/pack.json"), other.join("secret.wav")] {
            std::fs::write(f, b"x").unwrap();
        }
        let roots = vec![lib.clone(), packs.clone()];
        assert!(phone_may_read(&lib.join("a.wav"), &roots));
        assert!(phone_may_read(&packs.join("p1/piano.sfz"), &roots));
        assert!(phone_may_read(&packs.join("p1/c4.flac"), &roots));
        assert!(!phone_may_read(&packs.join("p1/pack.json"), &roots), "not audio");
        assert!(!phone_may_read(&other.join("secret.wav"), &roots), "outside");
        assert!(!phone_may_read(&packs.join("p1/missing.wav"), &roots), "doesn't exist");
    }
    use std::io::Write;
    use std::net::{Ipv4Addr, Ipv6Addr, TcpStream};

    #[test]
    fn only_local_networks() {
        for ip in ["192.168.1.20", "10.0.0.5", "172.16.3.4", "127.0.0.1", "169.254.1.1"] {
            assert!(is_lan(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "172.32.0.1", "200.45.1.1"] {
            assert!(!is_lan(ip.parse().unwrap()), "{ip}");
        }
        assert!(is_lan(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_lan("fe80::1".parse().unwrap()));
        assert!(is_lan("fd12::1".parse().unwrap()));
        assert!(!is_lan("2800:3f0::1".parse().unwrap()));
        assert!(is_lan(IpAddr::V6(Ipv4Addr::new(192, 168, 0, 9).to_ipv6_mapped())));
    }

    #[test]
    fn tokens_and_query() {
        assert!(token_eq("abc", "abc"));
        assert!(!token_eq("abc", "abd"));
        assert!(!token_eq("abc", "abcd"));
        assert_eq!(new_token().len(), 32);
        assert_ne!(new_token(), new_token());
        let url = "/api/file?t=xyz&path=C%3A%5Ccache%5Cs1-smp1.wav";
        assert_eq!(query_param(url, "t").as_deref(), Some("xyz"));
        assert_eq!(query_param(url, "path").as_deref(), Some(r"C:\cache\s1-smp1.wav"));
        assert_eq!(query_param(url, "nope"), None);
        assert_eq!(query_param("/x?a=%E2%99%AA", "a").as_deref(), Some("♪"));
    }

    #[test]
    fn phone_exports_stay_in_their_folder() {
        let dir = Path::new("C:/Music/Sampler Lab/Desde el celu");
        assert_eq!(remote_target(dir, "remote:Beat 120 BPM.wav", "wav"), dir.join("Beat 120 BPM.wav"));
        assert_eq!(remote_target(dir, r"C:\Windows\System32\evil.dll", "wav"), dir.join("evil.dll"));
        assert_eq!(remote_target(dir, "../../../etc/passwd", "wav"), dir.join("passwd.wav"));
        assert_eq!(remote_target(dir, "remote:", "mid"), dir.join("export.mid"));
        assert_eq!(remote_target(dir, "remote:/01 Bombo", "wav"), dir.join("01 Bombo.wav"));
    }

    #[test]
    fn qr_code_renders() {
        let svg = qr_svg("http://192.168.0.10:47321/?t=0123456789abcdef").unwrap();
        assert!(svg.starts_with("<?xml") && svg.contains("<svg"));
    }

    /// A fake backend to exercise the HTTP layer end to end on localhost.
    struct Fake;
    impl Backend for Fake {
        fn invoke(&self, cmd: &str, args: Value, raw: Option<Vec<u8>>) -> Result<Value, String> {
            match cmd {
                "echo" => Ok(args),
                "raw_len" => Ok(json!(raw.map_or(0, |r| r.len()))),
                _ => Err("nope".into()),
            }
        }
        fn file(&self, path: &str) -> Result<Vec<u8>, String> {
            if path == "ok.wav" { Ok(b"RIFF".to_vec()) } else { Err("no".into()) }
        }
        fn asset(&self, path: &str) -> Option<(Vec<u8>, String)> {
            (path == "index.html").then(|| (b"<html>studio</html>".to_vec(), "text/html".into()))
        }
    }

    fn http(port: u16, req: &str) -> (u16, String) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        let status = out.split(' ').nth(1).unwrap().parse().unwrap();
        let body = out.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        (status, body)
    }

    #[test]
    fn http_layer_enforces_the_code() {
        let srv = serve(Arc::new(Fake), 0, "secret".into()).unwrap();
        let p = srv.port;
        let post = |cmd: &str, tok: &str, extra: &str, body: &str| {
            http(
                p,
                &format!(
                    "POST /api/invoke/{cmd} HTTP/1.1\r\nHost: x\r\nConnection: close\r\nx-token: {tok}\r\n{extra}Content-Length: {}\r\n\r\n{body}",
                    body.len()
                ),
            )
        };
        assert_eq!(post("echo", "secret", "", r#"{"a":1}"#), (200, r#"{"ok":{"a":1}}"#.into()));
        assert_eq!(post("echo", "wrong", "", "{}").0, 401);
        assert_eq!(post("raw_len", "secret", "x-raw: 1\r\n", "abcdef"), (200, r#"{"ok":6}"#.into()));
        assert_eq!(post("other", "secret", "", "{}").0, 400);
        let get = |path: &str| http(p, &format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
        assert_eq!(get("/api/file?t=secret&path=ok.wav"), (200, "RIFF".into()));
        assert_eq!(get("/api/file?t=bad&path=ok.wav").0, 401);
        assert_eq!(get("/api/file?t=secret&path=other.wav").0, 404);
        assert_eq!(get("/").1, "<html>studio</html>");
        assert_eq!(get("/estudio").1, "<html>studio</html>"); // SPA fallback
        assert_eq!(get("/missing.js").0, 404);
        assert_eq!(get("/api/invoke/echo").0, 405);
        srv.stop();
    }
}
