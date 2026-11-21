//! Lifecycle of the Python separation engine (a companion process).
//!
//! - **Setup** (`engine_setup`): `uv sync` of the engine project with one PyTorch build.
//!   The first time this downloads Python, PyTorch and Demucs (~250 MB for the CPU build,
//!   ~2.5 GB for the NVIDIA ones); uv's output is streamed to the UI as
//!   `engine-setup-log` events.
//! - **Start** (`engine_start`): runs the engine on a random local port with a random
//!   token; the engine prints one JSON "ready" line with its port. The UI then talks to
//!   it directly over HTTP/WebSocket.
//! - The engine is killed when the app exits (and it also exits by itself if our
//!   process disappears — see `--parent-pid`).
//!
//! Where things live:
//! - **Installed app**: the engine sources and `uv.exe` travel as bundle resources
//!   (`resources/engine`, `resources/bin/uv.exe`, staged by `scripts/prepare-resources.mjs`).
//!   The sources are copied to `<local data>/engine` (the install dir may be read-only)
//!   and the Python environment, uv's cache and a uv-managed Python live next to them.
//! - **Development** (debug build, or `SAMPLER_ENGINE_DIR`): the repo's `engine/` folder
//!   with its own `.venv`, as before.
//!
//! PyTorch comes in three builds (`cpu`, `cu126`, `cu130`: dependency groups in
//! `engine/pyproject.toml`). The app recommends one from `nvidia-smi`; the user can pick
//! another.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct EngineState {
    inner: Mutex<Inner>,
    /// Held for the whole start sequence so concurrent `engine_start` calls (e.g. React
    /// mounting a panel twice) share one process instead of spawning two.
    start_lock: tauri::async_runtime::Mutex<()>,
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    info: Option<EngineInfo>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    port: u16,
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    /// "missingUv" | "notInstalled" | "stopped" | "running"
    state: &'static str,
    info: Option<EngineInfo>,
    /// PyTorch build installed (None: not installed, or a dev env set up by hand).
    variant: Option<Variant>,
}

/// PyTorch build. Values match the dependency groups in `engine/pyproject.toml`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Variant {
    Cpu,
    Cu126,
    Cu130,
}

impl Variant {
    fn group(self) -> &'static str {
        match self {
            Variant::Cpu => "cpu",
            Variant::Cu126 => "cu126",
            Variant::Cu130 => "cu130",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "cpu" => Some(Variant::Cpu),
            "cu126" => Some(Variant::Cu126),
            "cu130" => Some(Variant::Cu130),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Where the engine lives
// ---------------------------------------------------------------------------

/// Which engine folder to use.
#[derive(Debug, PartialEq)]
enum Source {
    /// The repo's engine (or `SAMPLER_ENGINE_DIR`): uv's default `.venv` inside it.
    Dev(PathBuf),
    /// Bundled with the installed app.
    Bundled(PathBuf),
}

/// Pick among the candidates: explicit override, then the repo (dev builds), then the
/// bundled copy.
fn choose_source(env_dir: Option<PathBuf>, dev_repo: Option<PathBuf>, bundled: Option<PathBuf>) -> Option<Source> {
    env_dir.map(Source::Dev).or_else(|| dev_repo.map(Source::Dev)).or_else(|| bundled.map(Source::Bundled))
}

/// Everything the `uv` calls need to know.
struct Layout {
    /// Folder with pyproject.toml, uv.lock and sampler_engine/.
    project: PathBuf,
    /// Installed app: where the venv, uv's cache and Python go. None in development.
    data: Option<PathBuf>,
    uv: PathBuf,
}

/// A command with no console window on Windows.
fn quiet(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

impl Layout {
    fn venv(&self) -> PathBuf {
        match &self.data {
            Some(d) => d.join("engine-venv"),
            None => self.project.join(".venv"),
        }
    }

    /// A `uv` command set up for this layout.
    fn uv(&self) -> Command {
        let mut c = quiet(&self.uv);
        c.current_dir(&self.project);
        if let Some(d) = &self.data {
            // Paths go as OsStr values, never through a shell: spaces and accents are fine.
            c.env("UV_PROJECT_ENVIRONMENT", self.venv())
                .env("UV_CACHE_DIR", d.join("uv-cache"))
                .env("UV_PYTHON_INSTALL_DIR", d.join("python"))
                // Our own Python, not whatever else is installed on the PC.
                .env("UV_PYTHON_PREFERENCE", "only-managed")
                .env("UV_NO_CONFIG", "1");
        }
        c
    }

    fn uv_available(&self) -> bool {
        self.uv().arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
    }

    fn installed(&self) -> bool {
        // demucs being importable is the real signal.
        let dir = self.venv();
        dir.join("Lib/site-packages/demucs").exists() || {
            // Unix layout: lib/python3.x/site-packages
            std::fs::read_dir(dir.join("lib"))
                .ok()
                .and_then(|mut it| it.find_map(|e| e.ok().map(|e| e.path().join("site-packages/demucs").exists())))
                .unwrap_or(false)
        }
    }

    fn variant_file(&self) -> PathBuf {
        self.venv().join("sampler-variant.txt")
    }

    fn variant(&self) -> Option<Variant> {
        std::fs::read_to_string(self.variant_file()).ok().and_then(|s| Variant::parse(&s))
    }
}

fn layout(app: &AppHandle) -> Result<Layout, String> {
    let env_dir = std::env::var_os("SAMPLER_ENGINE_DIR").map(PathBuf::from);
    // The repo's engine only in development builds (the path is baked in at compile time).
    let dev_repo = cfg!(debug_assertions)
        .then(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../engine")))
        .filter(|p| p.join("pyproject.toml").exists());
    let resources = app.path().resource_dir().ok();
    let bundled = resources.as_ref().map(|r| r.join("engine")).filter(|p| p.join("pyproject.toml").exists());
    let bundled_uv = resources
        .map(|r| r.join("bin").join(if cfg!(windows) { "uv.exe" } else { "uv" }))
        .filter(|p| p.is_file());
    let uv = bundled_uv.unwrap_or_else(|| PathBuf::from("uv"));

    match choose_source(env_dir, dev_repo, bundled) {
        Some(Source::Dev(project)) => Ok(Layout { project, data: None, uv }),
        Some(Source::Bundled(src)) => {
            let data = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
            let project = data.join("engine");
            sync_sources(&src, &project).map_err(|e| format!("No se pudo preparar el separador: {e}"))?;
            Ok(Layout { project, data: Some(data), uv })
        }
        None => Err("Esta copia de la app no trae el separador".into()),
    }
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for e in std::fs::read_dir(dir)? {
        let p = e?.path();
        let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
        if name == "__pycache__" || name == ".venv" || name == ".bundle-hash" {
            continue;
        }
        if p.is_dir() {
            collect_files(root, &p, out)?;
        } else if let Ok(rel) = p.strip_prefix(root) {
            out.push(rel.to_path_buf());
        }
    }
    Ok(())
}

/// Fingerprint of a folder's files (relative path + contents).
fn tree_hash(dir: &Path) -> std::io::Result<u64> {
    use std::hash::{Hash, Hasher};
    let mut files = Vec::new();
    collect_files(dir, dir, &mut files)?;
    files.sort();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for rel in files {
        rel.hash(&mut h);
        std::fs::read(dir.join(&rel))?.hash(&mut h);
    }
    Ok(h.finish())
}

/// Copy the bundled engine sources to a writable folder, only when they changed (a new
/// app version). The venv lives elsewhere, so replacing the sources is cheap.
fn sync_sources(src: &Path, dst: &Path) -> std::io::Result<()> {
    let want = tree_hash(src)?.to_string();
    if std::fs::read_to_string(dst.join(".bundle-hash")).is_ok_and(|h| h == want) {
        return Ok(());
    }
    if dst.exists() {
        std::fs::remove_dir_all(dst)?;
    }
    let mut files = Vec::new();
    collect_files(src, src, &mut files)?;
    for rel in files {
        let to = dst.join(&rel);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src.join(&rel), to)?;
    }
    std::fs::write(dst.join(".bundle-hash"), want)
}

// ---------------------------------------------------------------------------
// Which PyTorch build
// ---------------------------------------------------------------------------

/// The NVIDIA card from `nvidia-smi` output ("NVIDIA GeForce RTX 3070, 581.29").
fn parse_nvidia_smi(out: &str) -> Option<(String, String)> {
    let line = out.lines().find(|l| !l.trim().is_empty())?;
    let (name, driver) = line.rsplit_once(',')?;
    let (name, driver) = (name.trim(), driver.trim());
    let major_ok = driver.split('.').next().is_some_and(|m| m.parse::<u32>().is_ok());
    (!name.is_empty() && major_ok).then(|| (name.to_string(), driver.to_string()))
}

/// Best build for a driver: CUDA 13 needs driver >= 580, CUDA 12.6 needs >= 528 (Windows).
fn recommend(driver: Option<&str>) -> Variant {
    match driver.and_then(|d| d.split('.').next()?.parse::<u32>().ok()) {
        Some(m) if m >= 580 => Variant::Cu130,
        Some(m) if m >= 528 => Variant::Cu126,
        _ => Variant::Cpu,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    /// NVIDIA card name, if there is one.
    gpu: Option<String>,
    driver: Option<String>,
    recommended: Variant,
}

fn hardware() -> Hardware {
    let found = quiet("nvidia-smi")
        .args(["--query-gpu=name,driver_version", "--format=csv,noheader"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| parse_nvidia_smi(&String::from_utf8_lossy(&o.stdout)));
    let (gpu, driver) = found.map_or((None, None), |(g, d)| (Some(g), Some(d)));
    Hardware { recommended: recommend(driver.as_deref()), gpu, driver }
}

fn random_token() -> String {
    // Not crypto-grade, but the engine only listens on 127.0.0.1; the token just stops
    // other local web pages from poking it.
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    (0..2)
        .map(|_| {
            let mut h = RandomState::new().build_hasher();
            h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
            format!("{:016x}", h.finish())
        })
        .collect()
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("models"))
}

fn stop(state: &EngineState) {
    let mut inner = state.inner.lock().unwrap();
    if let Some(mut c) = inner.child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    inner.info = None;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// What this PC has, and which PyTorch build to install.
#[tauri::command]
pub async fn engine_hardware() -> Hardware {
    tauri::async_runtime::spawn_blocking(hardware)
        .await
        .unwrap_or(Hardware { gpu: None, driver: None, recommended: Variant::Cpu })
}

#[tauri::command]
pub fn engine_status(app: AppHandle, state: State<'_, EngineState>) -> EngineStatus {
    let info = {
        let mut inner = state.inner.lock().unwrap();
        // Notice if the process died.
        if let Some(child) = inner.child.as_mut()
            && !matches!(child.try_wait(), Ok(None))
        {
            inner.child = None;
            inner.info = None;
        }
        inner.info.clone()
    };
    let Ok(l) = layout(&app) else {
        return EngineStatus { state: "missingUv", info, variant: None };
    };
    let installed = l.installed();
    let st = if info.is_some() {
        "running"
    } else if !l.uv_available() {
        "missingUv"
    } else if !installed {
        "notInstalled"
    } else {
        "stopped"
    };
    EngineStatus { state: st, info, variant: if installed { l.variant() } else { None } }
}

/// Install/update the engine's Python environment with one PyTorch build (the
/// recommended one if none is given), streaming uv's output to the UI. Running it
/// again with another build swaps PyTorch; after an interruption it resumes from uv's
/// cache.
#[tauri::command]
pub async fn engine_setup(app: AppHandle, state: State<'_, EngineState>, variant: Option<Variant>) -> Result<(), String> {
    // A running engine keeps the venv's files open: stop it before replacing torch.
    stop(&state);
    let l = layout(&app)?;
    let variant = match variant {
        Some(v) => v,
        None => tauri::async_runtime::spawn_blocking(hardware).await.map_err(|e| e.to_string())?.recommended,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = l.uv();
        // --frozen: never rewrite uv.lock. Development keeps its test tools.
        cmd.args(["sync", "--frozen", "--no-default-groups", "--group", variant.group()]);
        if l.data.is_none() {
            cmd.args(["--group", "dev"]);
        }
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("No se pudo ejecutar uv: {e}"))?;
        // uv reports progress on stderr.
        let stderr = child.stderr.take().unwrap();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app.emit("engine-setup-log", line);
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("La instalación del separador no terminó. Si se cortó internet, tocá Reintentar: sigue desde donde quedó.".into());
        }
        std::fs::write(l.variant_file(), variant.group()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Start the engine if it isn't running and return how to reach it.
#[tauri::command]
pub async fn engine_start(app: AppHandle, state: State<'_, EngineState>) -> Result<EngineInfo, String> {
    let _starting = state.start_lock.lock().await;
    if let Some(info) = state.inner.lock().unwrap().info.clone() {
        return Ok(info);
    }
    let l = layout(&app)?;
    let token = random_token();
    let models = models_dir(&app)?;
    let log_path = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&log_path).map_err(|e| e.to_string())?;
    let log = std::fs::File::create(log_path.join("engine.log")).map_err(|e| e.to_string())?;

    let mut child = l
        .uv()
        .args(["run", "--no-sync", "python", "-m", "sampler_engine"])
        .args(["--port", "0", "--token", &token])
        .args(["--parent-pid", &std::process::id().to_string()])
        .arg("--models-dir")
        .arg(&models)
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| format!("No se pudo iniciar el separador: {e}"))?;

    // Wait for the {"event":"ready","port":N} line (model weights load lazily, so this
    // is just Python + torch import time).
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line)
                && v["event"] == "ready"
            {
                let _ = tx.send(v["port"].as_u64());
            }
        }
    });
    let port = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(120)))
        .await
        .map_err(|e| e.to_string())?;
    let Ok(Some(port)) = port else {
        let _ = child.kill();
        return Err("El separador no arrancó. Detalle en engine.log".into());
    };

    let info = EngineInfo { port: port as u16, token };
    let mut inner = state.inner.lock().unwrap();
    inner.child = Some(child);
    inner.info = Some(info.clone());
    Ok(info)
}

/// Kill the engine (called on app exit).
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<EngineState>() {
        stop(&state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_order_is_override_then_repo_then_bundle() {
        let p = |s: &str| Some(PathBuf::from(s));
        assert_eq!(choose_source(p("env"), p("repo"), p("bundle")), Some(Source::Dev("env".into())));
        assert_eq!(choose_source(None, p("repo"), p("bundle")), Some(Source::Dev("repo".into())));
        assert_eq!(choose_source(None, None, p("bundle")), Some(Source::Bundled("bundle".into())));
        assert_eq!(choose_source(None, None, None), None);
    }

    #[test]
    fn picks_the_torch_build_from_the_driver() {
        assert_eq!(parse_nvidia_smi("NVIDIA GeForce RTX 3070, 581.29\n"), Some(("NVIDIA GeForce RTX 3070".into(), "581.29".into())));
        assert_eq!(parse_nvidia_smi(""), None);
        assert_eq!(parse_nvidia_smi("No devices were found"), None);
        assert_eq!(recommend(Some("581.29")), Variant::Cu130);
        assert_eq!(recommend(Some("560.94")), Variant::Cu126);
        assert_eq!(recommend(Some("472.12")), Variant::Cpu);
        assert_eq!(recommend(None), Variant::Cpu);
        assert_eq!(Variant::parse(" cu126\n"), Some(Variant::Cu126));
    }

    #[test]
    fn bundled_sources_are_copied_once_and_refreshed_on_change() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, dst) = (tmp.path().join("res/engine"), tmp.path().join("Jos\u{e9} Pérez/engine"));
        std::fs::create_dir_all(src.join("sampler_engine/__pycache__")).unwrap();
        std::fs::write(src.join("pyproject.toml"), "a").unwrap();
        std::fs::write(src.join("sampler_engine/app.py"), "x").unwrap();
        std::fs::write(src.join("sampler_engine/__pycache__/app.pyc"), "junk").unwrap();

        sync_sources(&src, &dst).unwrap();
        assert!(dst.join("sampler_engine/app.py").is_file());
        assert!(!dst.join("sampler_engine/__pycache__").exists(), "caches are not copied");

        // Unchanged: the copy is left alone (a file uv wrote there survives).
        std::fs::write(dst.join("extra.txt"), "kept").unwrap();
        sync_sources(&src, &dst).unwrap();
        assert!(dst.join("extra.txt").exists());

        // An app update changes the sources: fresh copy.
        std::fs::write(src.join("sampler_engine/app.py"), "y").unwrap();
        sync_sources(&src, &dst).unwrap();
        assert_eq!(std::fs::read_to_string(dst.join("sampler_engine/app.py")).unwrap(), "y");
        assert!(!dst.join("extra.txt").exists());
    }
}
