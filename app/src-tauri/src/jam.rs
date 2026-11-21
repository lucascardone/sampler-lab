//! "Tocar juntos": several PCs on the same Wi-Fi share one Studio song.
//!
//! This module is only the network: a thin relay. The music logic (song ops, undo,
//! the shared transport clock) lives in the frontend (`app/src/features/jam/`).
//!
//! - The host ("abre la sala") listens on TCP, LAN clients only, and announces the room
//!   with a small UDP broadcast beacon (room name + port, nothing else).
//! - A guest connects with the 4-digit code. Messages are length-prefixed frames:
//!   JSON (kind 0) or binary (kind 1: a u32 request id + bytes, for sound files).
//! - Guest JSON messages go to the host frontend as `jam-host` events; the host frontend
//!   answers with `jam_host_send` (to one peer or to all). Host messages reach the guest
//!   frontend as `jam-guest` events.
//! - Sounds: the host Rust answers file requests and a few read-only library calls by
//!   itself (no round trip through the host UI), with the same folder checks as phone
//!   mode. Guests keep the files in `<app data>/jam-cache/`.
//!
//! Safety: peers only from the local network or a Tailscale VPN (friends at home: the host
//! shares this PC on Tailscale, see `is_vpn`), a code with rate-limited wrong tries, a closed
//! whitelist of what a guest can ask for, size caps on every frame. Separate from the phone
//! server and its whitelist on purpose (the phone stays LAN-only). Beacons stay LAN-only:
//! over the VPN friends type the address. Phase 8 (internet) would swap this transport,
//! not the protocol.

use crate::commands::{CmdResult, err};
use crate::remote::is_lan;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// Protocol version (sent in hello / beacon). Bump on incompatible changes.
pub const PROTOCOL: u64 = 1;
/// Preferred room port (any free one if taken).
const PORT: u16 = 47331;
/// Where beacons are sent / listened for.
pub const BEACON_PORT: u16 = 47332;
const BEACON_TAG: &str = "sampler-lab-jam";
/// Most people in a room (host included).
pub const MAX_PEERS: usize = 8;
/// Biggest JSON message (a whole song as a snapshot fits easily).
const MAX_JSON: usize = 16 * 1024 * 1024;
/// Biggest binary frame (a sound file).
const MAX_BINARY: usize = 300 * 1024 * 1024;
/// Biggest sound a guest can bring to the room.
pub const MAX_UPLOAD: usize = 50 * 1024 * 1024;
/// Wrong codes allowed per address per minute.
const MAX_WRONG: u32 = 5;

/// A Tailscale address (100.64.0.0/10, the range Tailscale hands out). Its IPv6 range
/// (fd7a:115c:a1e0::/48) is already "local" for `is_lan`. Only devices the host invited
/// to its tailnet (or shared this PC with) can reach these.
pub fn is_vpn(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (o[1] & 0xc0) == 64
        }
        IpAddr::V6(v6) => v6.to_ipv4_mapped().is_some_and(|v4| is_vpn(IpAddr::V4(v4))),
    }
}

/// Who may open / be a room connection: same network, or Tailscale.
fn reachable(ip: IpAddr) -> bool {
    is_lan(ip) || is_vpn(ip)
}

/// This PC's Tailscale address, if Tailscale is on. No packet is sent: connecting a UDP
/// socket only picks the interface that would carry it (100.100.100.100 is Tailscale's).
pub fn vpn_ip() -> Option<IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("100.100.100.100:53").ok()?;
    let ip = s.local_addr().ok()?.ip();
    is_vpn(ip).then_some(ip)
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

pub const KIND_JSON: u8 = 0;
pub const KIND_BINARY: u8 = 1;

pub fn write_frame(w: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    let mut head = [0u8; 5];
    head[..4].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    head[4] = kind;
    w.write_all(&head)?;
    w.write_all(payload)?;
    w.flush()
}

pub fn read_frame(r: &mut impl Read, max_binary: usize) -> io::Result<(u8, Vec<u8>)> {
    let mut head = [0u8; 5];
    r.read_exact(&mut head)?;
    let len = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
    let kind = head[4];
    let max = if kind == KIND_JSON { MAX_JSON } else { max_binary };
    if kind > KIND_BINARY || len > max {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "mensaje demasiado grande"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok((kind, buf))
}

fn send_json(stream: &Mutex<TcpStream>, v: &Value) -> io::Result<()> {
    write_frame(&mut *stream.lock().unwrap(), KIND_JSON, v.to_string().as_bytes())
}

fn send_binary(stream: &Mutex<TcpStream>, id: u32, bytes: &[u8]) -> io::Result<()> {
    let mut s = stream.lock().unwrap();
    let mut head = [0u8; 9];
    head[..4].copy_from_slice(&((bytes.len() + 4) as u32).to_be_bytes());
    head[4] = KIND_BINARY;
    head[5..].copy_from_slice(&id.to_be_bytes());
    s.write_all(&head)?;
    s.write_all(bytes)?;
    s.flush()
}

fn split_binary(buf: &[u8]) -> Option<(u32, &[u8])> {
    (buf.len() >= 4).then(|| (u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]), &buf[4..]))
}

/// A random 4-digit code ("0427").
pub fn new_code() -> String {
    let mut b = [0u8; 4];
    getrandom::fill(&mut b).expect("system RNG");
    format!("{:04}", u32::from_le_bytes(b) % 10_000)
}

/// What the room says on the network (what guests see in "Salas en tu Wi-Fi").
pub fn beacon_payload(name: &str, port: u16) -> String {
    json!({ "app": BEACON_TAG, "v": PROTOCOL, "name": name, "port": port }).to_string()
}

/// A beacon heard from `from`: (room name, port), if it is ours.
pub fn parse_beacon(bytes: &[u8]) -> Option<(String, u16)> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    if v.get("app")?.as_str()? != BEACON_TAG || v.get("v")?.as_u64()? != PROTOCOL {
        return None;
    }
    let name: String = v.get("name")?.as_str()?.chars().take(40).collect();
    let port = u16::try_from(v.get("port")?.as_u64()?).ok()?;
    Some((name, port))
}

/// Wrong-code bookkeeping: at most `MAX_WRONG` tries per address per minute.
#[derive(Default)]
pub struct Throttle {
    tries: HashMap<IpAddr, (Instant, u32)>,
}

impl Throttle {
    pub fn blocked(&mut self, ip: IpAddr, now: Instant) -> bool {
        match self.tries.get(&ip) {
            Some((since, n)) if now.duration_since(*since) < Duration::from_secs(60) => *n >= MAX_WRONG,
            _ => false,
        }
    }
    pub fn wrong(&mut self, ip: IpAddr, now: Instant) {
        let e = self.tries.entry(ip).or_insert((now, 0));
        if now.duration_since(e.0) >= Duration::from_secs(60) {
            *e = (now, 0);
        }
        e.1 += 1;
    }
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/// What the host frontend hears about.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HostEvent {
    Join { peer: u32, name: String },
    Leave { peer: u32 },
    Msg { peer: u32, msg: Value },
    /// A guest brought a sound: it is now in the room pack.
    Upload { peer: u32, pack_id: String, item_id: String, name: String },
}

/// What the host does with guest requests that don't need its UI.
pub trait HostBackend: Send + Sync + 'static {
    /// A sound file a guest may read (validated by the backend).
    fn file(&self, path: &str) -> Result<Vec<u8>, String>;
    /// A read-only call (library / packs listing, sample audio, analysis).
    fn call(&self, cmd: &str, args: Value) -> Result<Value, String>;
    /// A guest's own sound, to add to the room pack: (pack id, item id).
    fn upload(&self, peer_name: &str, file_name: &str, bytes: &[u8]) -> Result<(String, String), String>;
    fn event(&self, e: HostEvent);
}

/// The calls a guest may make. Never widen casually: it is the room's attack surface.
pub const GUEST_CALLS: &[&str] = &["library_list", "packs_list", "library_sample_audio", "library_analyze"];

struct Peer {
    stream: Arc<Mutex<TcpStream>>,
}

type Peers = Arc<Mutex<HashMap<u32, Peer>>>;

pub struct Host {
    pub port: u16,
    pub code: String,
    pub name: String,
    peers: Peers,
    stop: Arc<AtomicBool>,
    /// Outgoing messages, written by one thread: in order, and never blocking the caller
    /// (a slow guest must not freeze the app's window).
    out: Option<mpsc::Sender<(Option<u32>, Value)>>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl Host {
    /// Open the room on `port` (or any free port) and start announcing it.
    pub fn start(backend: Arc<dyn HostBackend>, port: u16, name: String, code: String, beacon: bool) -> io::Result<Host> {
        let listener = TcpListener::bind(("0.0.0.0", port)).or_else(|_| TcpListener::bind(("0.0.0.0", 0)))?;
        let port = listener.local_addr()?.port();
        listener.set_nonblocking(true)?;
        let peers: Peers = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        let mut threads = Vec::new();

        let (p, s, c) = (peers.clone(), stop.clone(), code.clone());
        threads.push(std::thread::spawn(move || accept_loop(listener, backend, p, s, c)));

        if beacon {
            let (s, payload) = (stop.clone(), beacon_payload(&name, port));
            threads.push(std::thread::spawn(move || {
                let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else { return };
                let _ = sock.set_broadcast(true);
                while !s.load(Ordering::Relaxed) {
                    let _ = sock.send_to(payload.as_bytes(), ("255.255.255.255", BEACON_PORT));
                    // Also to this machine: two windows on one PC can find each other.
                    let _ = sock.send_to(payload.as_bytes(), ("127.0.0.1", BEACON_PORT));
                    for _ in 0..10 {
                        if s.load(Ordering::Relaxed) {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            }));
        }
        let (tx, rx) = mpsc::channel::<(Option<u32>, Value)>();
        let p = peers.clone();
        threads.push(std::thread::spawn(move || {
            while let Ok((to, msg)) = rx.recv() {
                deliver(&p, to, &msg);
            }
        }));
        Ok(Host { port, code, name, peers, stop, out: Some(tx), threads })
    }

    /// To one peer, or to everyone (`None`). Returns at once; sent in order.
    pub fn send(&self, to: Option<u32>, msg: &Value) {
        if let Some(out) = &self.out {
            let _ = out.send((to, msg.clone()));
        }
    }

    #[cfg(test)]
    pub fn peer_count(&self) -> usize {
        self.peers.lock().unwrap().len()
    }

    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // Ends the writer thread once what's queued is sent.
        self.out.take();
        let bye = json!({ "t": "bye", "reason": "closed" });
        for p in self.peers.lock().unwrap().drain().map(|(_, p)| p) {
            let _ = send_json(&p.stream, &bye);
            let _ = p.stream.lock().unwrap().shutdown(std::net::Shutdown::Both);
        }
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

/// Write a message to one peer or all of them. A peer whose connection broke is dropped.
fn deliver(peers: &Peers, to: Option<u32>, msg: &Value) {
    let targets: Vec<(u32, Arc<Mutex<TcpStream>>)> = {
        let map = peers.lock().unwrap();
        map.iter().filter(|(id, _)| to.is_none_or(|t| t == **id)).map(|(id, p)| (*id, p.stream.clone())).collect()
    };
    for (id, stream) in targets {
        if send_json(&stream, msg).is_err() {
            let _ = stream.lock().unwrap().shutdown(std::net::Shutdown::Both);
            peers.lock().unwrap().remove(&id);
        }
    }
}

fn accept_loop(listener: TcpListener, backend: Arc<dyn HostBackend>, peers: Peers, stop: Arc<AtomicBool>, code: String) {
    let next = Arc::new(AtomicU32::new(1));
    let throttle = Arc::new(Mutex::new(Throttle::default()));
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, addr)) => {
                if !reachable(addr.ip()) {
                    continue;
                }
                let (b, p, c, n, th, s) = (backend.clone(), peers.clone(), code.clone(), next.clone(), throttle.clone(), stop.clone());
                std::thread::spawn(move || serve_peer(stream, addr, b, p, c, n, th, s));
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn serve_peer(
    stream: TcpStream,
    addr: SocketAddr,
    backend: Arc<dyn HostBackend>,
    peers: Peers,
    code: String,
    next: Arc<AtomicU32>,
    throttle: Arc<Mutex<Throttle>>,
    stop: Arc<AtomicBool>,
) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_nodelay(true);
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let Ok(mut reader) = stream.try_clone() else { return };
    let writer = Arc::new(Mutex::new(stream));
    let refuse = |reason: &str| {
        let _ = send_json(&writer, &json!({ "t": "bye", "reason": reason }));
        let _ = writer.lock().unwrap().shutdown(std::net::Shutdown::Both);
    };

    // Hello first, within a few seconds.
    let _ = reader.set_read_timeout(Some(Duration::from_secs(5)));
    let Ok((KIND_JSON, hello)) = read_frame(&mut reader, 0) else { return refuse("protocol") };
    let Ok(hello) = serde_json::from_slice::<Value>(&hello) else { return refuse("protocol") };
    if hello.get("t").and_then(Value::as_str) != Some("hello") || hello.get("v").and_then(Value::as_u64) != Some(PROTOCOL) {
        return refuse("version");
    }
    let ip = addr.ip();
    if throttle.lock().unwrap().blocked(ip, Instant::now()) {
        return refuse("wait");
    }
    let given = hello.get("code").and_then(Value::as_str).unwrap_or("");
    if !crate::remote::token_eq(given.trim(), &code) {
        throttle.lock().unwrap().wrong(ip, Instant::now());
        return refuse("code");
    }
    let name: String = hello.get("name").and_then(Value::as_str).unwrap_or("").trim().chars().take(24).collect();
    let name = if name.is_empty() { "Invitado".to_string() } else { name };
    let id = {
        let mut map = peers.lock().unwrap();
        // Host + guests.
        if map.len() + 1 >= MAX_PEERS {
            drop(map);
            return refuse("full");
        }
        let id = next.fetch_add(1, Ordering::Relaxed);
        map.insert(id, Peer { stream: writer.clone() });
        id
    };
    let _ = reader.set_read_timeout(None);
    let _ = send_json(&writer, &json!({ "t": "accepted", "peer": id }));
    backend.event(HostEvent::Join { peer: id, name: name.clone() });

    let mut uploads: HashMap<u32, String> = HashMap::new();
    while !stop.load(Ordering::Relaxed) {
        let Ok((kind, buf)) = read_frame(&mut reader, MAX_UPLOAD + 4) else { break };
        if kind == KIND_BINARY {
            let Some((req, bytes)) = split_binary(&buf) else { break };
            let Some(file_name) = uploads.remove(&req) else { continue };
            let reply = match backend.upload(&name, &file_name, bytes) {
                Ok((pack_id, item_id)) => {
                    backend.event(HostEvent::Upload { peer: id, pack_id: pack_id.clone(), item_id: item_id.clone(), name: file_name });
                    json!({ "t": "reply", "id": req, "ok": { "packId": pack_id, "itemId": item_id } })
                }
                Err(e) => json!({ "t": "reply", "id": req, "error": e }),
            };
            let _ = send_json(&writer, &reply);
            continue;
        }
        let Ok(msg) = serde_json::from_slice::<Value>(&buf) else { continue };
        let req = msg.get("id").and_then(Value::as_u64).map(|x| x as u32);
        match (msg.get("t").and_then(Value::as_str), req) {
            (Some("file"), Some(req)) => {
                let path = msg.get("path").and_then(Value::as_str).unwrap_or("").to_string();
                let (b, w) = (backend.clone(), writer.clone());
                // Files can be big: don't hold up the song messages behind them.
                std::thread::spawn(move || match b.file(&path) {
                    Ok(bytes) => {
                        let _ = send_binary(&w, req, &bytes);
                    }
                    Err(e) => {
                        let _ = send_json(&w, &json!({ "t": "reply", "id": req, "error": e }));
                    }
                });
            }
            (Some("call"), Some(req)) => {
                let cmd = msg.get("cmd").and_then(Value::as_str).unwrap_or("").to_string();
                let args = msg.get("args").cloned().unwrap_or(Value::Null);
                let (b, w) = (backend.clone(), writer.clone());
                std::thread::spawn(move || {
                    let r = if GUEST_CALLS.contains(&cmd.as_str()) { b.call(&cmd, args) } else { Err(format!("\"{cmd}\" no está disponible en la sala")) };
                    let reply = match r {
                        Ok(v) => json!({ "t": "reply", "id": req, "ok": v }),
                        Err(e) => json!({ "t": "reply", "id": req, "error": e }),
                    };
                    let _ = send_json(&w, &reply);
                });
            }
            (Some("upload"), Some(req)) => {
                let file_name = msg.get("name").and_then(Value::as_str).unwrap_or("sonido.wav").to_string();
                uploads.insert(req, file_name);
            }
            _ => backend.event(HostEvent::Msg { peer: id, msg }),
        }
    }
    if peers.lock().unwrap().remove(&id).is_some() {
        backend.event(HostEvent::Leave { peer: id });
    }
}

// ---------------------------------------------------------------------------
// Guest
// ---------------------------------------------------------------------------

enum Reply {
    Bytes(Vec<u8>),
    Json(Result<Value, String>),
}

type Pending = Arc<Mutex<HashMap<u32, mpsc::Sender<Reply>>>>;

pub struct Guest {
    pub peer: u32,
    stream: Arc<Mutex<TcpStream>>,
    /// Song messages, written by one thread (in order, without blocking the caller).
    out: mpsc::Sender<Value>,
    pending: Pending,
    next: AtomicU32,
    thread: Option<std::thread::JoinHandle<()>>,
}

/// Why the host refused us, in words for the user.
pub fn refusal(reason: &str) -> String {
    match reason {
        "code" => "El código no es ese. Fijate el número que muestra la PC que abrió la sala.".into(),
        "wait" => "Demasiados códigos equivocados. Esperá un minuto y probá de nuevo.".into(),
        "full" => "La sala está llena.".into(),
        "version" => "Esa sala usa otra versión de Sampler Lab. Actualicen las dos PCs a la misma versión.".into(),
        "closed" => "La sala se cerró.".into(),
        _ => "La sala no aceptó la conexión.".into(),
    }
}

impl Guest {
    /// Connect and say hello. `on_msg` gets every JSON message from the host, and `None`
    /// once when the connection ends.
    pub fn join(addr: SocketAddr, code: &str, name: &str, on_msg: Arc<dyn Fn(Option<Value>) + Send + Sync>) -> Result<Guest, String> {
        if !reachable(addr.ip()) {
            return Err("Solo se puede entrar a salas de tu red local o de Tailscale.".into());
        }
        let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(6))
            .map_err(|_| "No encontré la sala en esa dirección. ¿Están en el mismo Wi-Fi (o con Tailscale prendido)? ¿Sigue abierta?".to_string())?;
        let _ = stream.set_nodelay(true);
        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
        let mut reader = stream.try_clone().map_err(|e| e.to_string())?;
        let writer = Arc::new(Mutex::new(stream));
        send_json(&writer, &json!({ "t": "hello", "v": PROTOCOL, "code": code, "name": name })).map_err(|e| e.to_string())?;
        let _ = reader.set_read_timeout(Some(Duration::from_secs(6)));
        let (_, buf) = read_frame(&mut reader, 0).map_err(|_| "La sala no contestó.".to_string())?;
        let first: Value = serde_json::from_slice(&buf).map_err(|_| "La sala contestó algo raro.".to_string())?;
        let peer = match first.get("t").and_then(Value::as_str) {
            Some("accepted") => first.get("peer").and_then(Value::as_u64).unwrap_or(0) as u32,
            Some("bye") => return Err(refusal(first.get("reason").and_then(Value::as_str).unwrap_or(""))),
            _ => return Err("La sala contestó algo raro.".into()),
        };
        let _ = reader.set_read_timeout(None);
        let pending: Pending = Arc::default();
        let p = pending.clone();
        let thread = std::thread::spawn(move || {
            while let Ok((kind, buf)) = read_frame(&mut reader, MAX_BINARY) {
                if kind == KIND_BINARY {
                    if let Some((id, bytes)) = split_binary(&buf)
                        && let Some(tx) = p.lock().unwrap().remove(&id)
                    {
                        let _ = tx.send(Reply::Bytes(bytes.to_vec()));
                    }
                    continue;
                }
                let Ok(msg) = serde_json::from_slice::<Value>(&buf) else { continue };
                if msg.get("t").and_then(Value::as_str) == Some("reply") {
                    let id = msg.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
                    if let Some(tx) = p.lock().unwrap().remove(&id) {
                        let r = match msg.get("error") {
                            Some(e) => Err(e.as_str().unwrap_or("Error en la sala").to_string()),
                            None => Ok(msg.get("ok").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = tx.send(Reply::Json(r));
                    }
                    continue;
                }
                on_msg(Some(msg));
            }
            p.lock().unwrap().clear();
            on_msg(None);
        });
        let (out, rx) = mpsc::channel::<Value>();
        let w = writer.clone();
        std::thread::spawn(move || {
            while let Ok(msg) = rx.recv() {
                if send_json(&w, &msg).is_err() {
                    // The reader then ends too, and the app hears the room is gone.
                    let _ = w.lock().unwrap().shutdown(std::net::Shutdown::Both);
                    break;
                }
            }
        });
        Ok(Guest { peer, stream: writer, out, pending, next: AtomicU32::new(1), thread: Some(thread) })
    }

    /// Queue a message for the host (returns at once, sent in order).
    pub fn send(&self, msg: &Value) -> Result<(), String> {
        self.out.send(msg.clone()).map_err(|_| "Se cortó la conexión con la sala.".to_string())
    }

    fn request(&self, msg: Value, raw: Option<&[u8]>, timeout: Duration) -> Result<Reply, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut msg = msg;
        msg["id"] = json!(id);
        // Written right here (not queued) so an upload's bytes follow their header.
        send_json(&self.stream, &msg).map_err(|_| "Se cortó la conexión con la sala.".to_string())?;
        if let Some(bytes) = raw {
            send_binary(&self.stream, id, bytes).map_err(|_| "Se cortó la conexión con la sala.".to_string())?;
        }
        let r = rx.recv_timeout(timeout).map_err(|_| "La sala tardó demasiado en contestar.".to_string());
        self.pending.lock().unwrap().remove(&id);
        r
    }

    pub fn call(&self, cmd: &str, args: Value) -> Result<Value, String> {
        match self.request(json!({ "t": "call", "cmd": cmd, "args": args }), None, Duration::from_secs(120))? {
            Reply::Json(r) => r,
            Reply::Bytes(_) => Err("Respuesta inesperada de la sala".into()),
        }
    }

    pub fn file(&self, path: &str) -> Result<Vec<u8>, String> {
        match self.request(json!({ "t": "file", "path": path }), None, Duration::from_secs(300))? {
            Reply::Bytes(b) => Ok(b),
            Reply::Json(r) => Err(r.err().unwrap_or_else(|| "Respuesta inesperada de la sala".into())),
        }
    }

    pub fn upload(&self, name: &str, bytes: &[u8]) -> Result<Value, String> {
        if bytes.len() > MAX_UPLOAD {
            return Err(format!("Ese sonido pesa demasiado para la sala (máximo {} MB).", MAX_UPLOAD / 1024 / 1024));
        }
        match self.request(json!({ "t": "upload", "name": name }), Some(bytes), Duration::from_secs(120))? {
            Reply::Json(r) => r,
            Reply::Bytes(_) => Err("Respuesta inesperada de la sala".into()),
        }
    }

    pub fn leave(mut self) {
        let _ = self.stream.lock().unwrap().shutdown(std::net::Shutdown::Both);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Listen for room beacons for `wait`: (name, address) of each room heard.
pub fn scan(wait: Duration) -> Result<Vec<(String, SocketAddr)>, String> {
    let sock = UdpSocket::bind(("0.0.0.0", BEACON_PORT)).map_err(|_| "No pude buscar salas (¿hay otra ventana de Sampler Lab buscando?).".to_string())?;
    let end = Instant::now() + wait;
    let mut found: Vec<(String, SocketAddr)> = Vec::new();
    let mut buf = [0u8; 512];
    while let Some(left) = end.checked_duration_since(Instant::now()).filter(|d| !d.is_zero()) {
        let _ = sock.set_read_timeout(Some(left));
        let Ok((n, from)) = sock.recv_from(&mut buf) else { break };
        if !is_lan(from.ip()) {
            continue;
        }
        if let Some((name, port)) = parse_beacon(&buf[..n]) {
            let addr = SocketAddr::new(from.ip(), port);
            // The same room heard via broadcast and loopback: keep one.
            if !found.iter().any(|(n2, a)| *a == addr || (n2 == &name && a.port() == port && (a.ip().is_loopback() || from.ip().is_loopback()))) {
                found.push((name, addr));
            }
        }
    }
    Ok(found)
}

/// "192.168.0.10", "192.168.0.10:47331" → an address (default room port).
pub fn parse_address(text: &str) -> Option<SocketAddr> {
    let t = text.trim();
    t.parse::<SocketAddr>().ok().or_else(|| t.parse::<IpAddr>().ok().map(|ip| SocketAddr::new(ip, PORT)))
}

/// Cache file for a host path: stable name, same extension (so decoders know the type).
pub fn cache_name(path: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(path.as_bytes());
    let hex: String = hash.iter().take(12).map(|b| format!("{b:02x}")).collect();
    let ext: String = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .filter(|e| e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_else(|| "bin".into());
    format!("{hex}.{ext}")
}

// ---------------------------------------------------------------------------
// The room pack (sounds guests bring)
// ---------------------------------------------------------------------------

pub const ROOM_PACK: &str = "sala";

/// Add `bytes` as a sound of the room pack under `<root>/sala/<who>/<file>`.
pub fn add_to_room_pack(root: &Path, who: &str, file_name: &str, bytes: &[u8]) -> CmdResult<(String, String)> {
    use crate::packs::{Pack, PackItem};
    let file_name = crate::commands::safe_file_name(file_name.rsplit(['/', '\\']).next().unwrap_or("sonido.wav"));
    if !crate::packs::is_audio(Path::new(&file_name)) {
        return Err(err("Ese archivo no es un sonido (WAV, FLAC, OGG, MP3 o AIFF)."));
    }
    let who = crate::commands::safe_file_name(if who.trim().is_empty() { "Invitado" } else { who.trim() });
    let dir = root.join(ROOM_PACK);
    std::fs::create_dir_all(dir.join(&who)).map_err(err)?;
    let mut pack: Pack = std::fs::read(dir.join("pack.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| Pack {
        version: crate::packs::PACK_VERSION,
        id: ROOM_PACK.into(),
        name: "Sonidos de la sala".into(),
        author: String::new(),
        license: "own".into(),
        license_url: None,
        source_url: None,
        origin: "folder".into(),
        installed_at: chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
        items: Vec::new(),
        plan: 0,
    });
    // Same name twice: "x.wav", "x (2).wav"…
    let (stem, ext) = file_name.rsplit_once('.').unwrap_or((&file_name, "wav"));
    let mut rel = format!("{who}/{file_name}");
    for n in 2.. {
        if !dir.join(&rel).exists() && !pack.items.iter().any(|i| i.file.as_deref() == Some(rel.as_str())) {
            break;
        }
        rel = format!("{who}/{stem} ({n}).{ext}");
    }
    let tmp = dir.join(format!("{rel}.tmp"));
    std::fs::write(&tmp, bytes).map_err(err)?;
    std::fs::rename(&tmp, dir.join(&rel)).map_err(err)?;
    let id = format!("s{}", pack.items.len() + 1);
    let id = if pack.items.iter().any(|i| i.id == id) { format!("s{}", chrono::Local::now().timestamp_millis()) } else { id };
    pack.items.push(PackItem {
        id: id.clone(),
        name: crate::packs::pretty_name(&rel),
        kind: "oneshot".into(),
        file: Some(rel.clone()),
        sfz: None,
        category: crate::packs::guess_category(&rel),
        credit: Some(crate::packs::Credit { author: who.clone(), license: "own".into(), url: None }),
        hidden: false,
    });
    crate::packs::write_pack_json(&dir, &pack)?;
    Ok((ROOM_PACK.into(), id))
}

// ---------------------------------------------------------------------------
// Tauri side
// ---------------------------------------------------------------------------

struct AppHost {
    app: AppHandle,
}

impl HostBackend for AppHost {
    fn file(&self, path: &str) -> Result<Vec<u8>, String> {
        crate::remote::read_shared_sound(&self.app, path)
    }
    fn call(&self, cmd: &str, args: Value) -> Result<Value, String> {
        crate::remote::read_only_call(&self.app, cmd, args)
    }
    fn upload(&self, peer_name: &str, file_name: &str, bytes: &[u8]) -> Result<(String, String), String> {
        let root = crate::packs::packs_root(&self.app).map_err(|e| e.0)?;
        add_to_room_pack(&root, peer_name, file_name, bytes).map_err(|e| e.0)
    }
    fn event(&self, e: HostEvent) {
        let _ = self.app.emit("jam-host", e);
    }
}

#[derive(Default)]
pub struct JamState {
    host: Mutex<Option<Host>>,
    guest: Mutex<Option<Arc<Guest>>>,
    /// Host: the room's door to the internet (only after "invitar desde otra casa").
    door: Mutex<Option<crate::jam_net::Door>>,
    /// Guest: the tunnel to a room at another home.
    path: Mutex<Option<crate::jam_net::Path>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    code: String,
    name: String,
    port: u16,
    /// This PC's address on the Wi-Fi ("" if none was found).
    address: String,
    /// This PC's Tailscale address, for friends at home ("" if Tailscale is off).
    vpn_address: String,
}

fn host_info(h: &Host) -> HostInfo {
    let address = crate::remote::lan_ip().map(|ip| ip.to_string()).unwrap_or_default();
    let vpn_address = vpn_ip().map(|ip| ip.to_string()).unwrap_or_default();
    HostInfo { code: h.code.clone(), name: h.name.clone(), port: h.port, address, vpn_address }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoomFound {
    name: String,
    address: String,
}

/// A name to suggest the first time (the Windows user name).
#[tauri::command]
pub fn jam_default_name() -> String {
    std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default()
}

#[tauri::command]
pub fn jam_host_start(app: AppHandle, state: State<'_, JamState>, name: String) -> CmdResult<HostInfo> {
    if state.guest.lock().unwrap().is_some() {
        return Err(err("Primero salí de la sala en la que estás."));
    }
    let mut guard = state.host.lock().unwrap();
    if let Some(h) = guard.as_ref() {
        return Ok(host_info(h));
    }
    let name: String = name.trim().chars().take(24).collect();
    let backend = Arc::new(AppHost { app: app.clone() });
    let host = Host::start(backend, PORT, name, new_code(), true).map_err(|e| err(format!("No se pudo abrir la sala: {e}")))?;
    let info = host_info(&host);
    *guard = Some(host);
    Ok(info)
}

#[tauri::command]
pub fn jam_host_stop(state: State<'_, JamState>) {
    if let Some(d) = state.door.lock().unwrap().take() {
        d.close();
    }
    if let Some(h) = state.host.lock().unwrap().take() {
        h.stop();
    }
}

/// Let friends at other homes in: open the room's door to the internet (iroh) and return
/// the invite to send them. Opening it again returns the same invite.
#[tauri::command]
pub async fn jam_host_internet(app: AppHandle) -> CmdResult<String> {
    let state: State<'_, JamState> = app.state();
    if let Some(d) = state.door.lock().unwrap().as_ref() {
        return Ok(d.invite.clone());
    }
    let (port, code) = {
        let guard = state.host.lock().unwrap();
        let h = guard.as_ref().ok_or_else(|| err("La sala no está abierta."))?;
        (h.port, h.code.clone())
    };
    let door = tauri::async_runtime::spawn_blocking(move || crate::jam_net::Door::open(port, &code)).await.map_err(err)?.map_err(err)?;
    let invite = door.invite.clone();
    // The room may have closed while the door was opening.
    if state.host.lock().unwrap().is_none() {
        door.close();
        return Err(err("La sala se cerró."));
    }
    let mut slot = state.door.lock().unwrap();
    if let Some(old) = slot.replace(door) {
        old.close();
    }
    Ok(invite)
}

fn close_path(state: &JamState) {
    if let Some(p) = state.path.lock().unwrap().take() {
        p.close();
    }
}

#[tauri::command]
pub fn jam_host_status(state: State<'_, JamState>) -> Option<HostInfo> {
    state.host.lock().unwrap().as_ref().map(host_info)
}

/// Send to one guest (`to`) or to all of them.
#[tauri::command]
pub fn jam_host_send(state: State<'_, JamState>, to: Option<u32>, msg: Value) -> CmdResult<()> {
    let guard = state.host.lock().unwrap();
    let h = guard.as_ref().ok_or_else(|| err("La sala no está abierta."))?;
    h.send(to, &msg);
    Ok(())
}

#[tauri::command]
pub async fn jam_scan() -> CmdResult<Vec<RoomFound>> {
    let found = tauri::async_runtime::spawn_blocking(|| scan(Duration::from_millis(1300))).await.map_err(err)?.map_err(err)?;
    Ok(found.into_iter().map(|(name, a)| RoomFound { name, address: a.to_string() }).collect())
}

/// Enter a room. Returns our peer id; then the host's messages arrive as `jam-guest`
/// events (`{msg}`), and `{closed: true}` when the connection ends.
#[tauri::command]
pub async fn jam_join(app: AppHandle, address: String, code: String, name: String) -> CmdResult<u32> {
    let state: State<'_, JamState> = app.state();
    if state.host.lock().unwrap().is_some() {
        return Err(err("Tenés una sala abierta: cerrala antes de entrar a otra."));
    }
    if let Some(g) = state.guest.lock().unwrap().take() {
        if let Ok(g) = Arc::try_unwrap(g) {
            g.leave();
        }
    }
    close_path(&state);
    // An invite from another home ("SL-1234-…"): go through the internet tunnel; the
    // code travels inside the invite.
    let (addr, code) = if let Some((invite_code, host)) = crate::jam_net::parse_invite(&address) {
        let path = tauri::async_runtime::spawn_blocking(move || crate::jam_net::Path::connect(host)).await.map_err(err)?.map_err(err)?;
        let local = path.local;
        *state.path.lock().unwrap() = Some(path);
        (local, invite_code)
    } else {
        let addr = parse_address(&address).ok_or_else(|| err("Esa dirección no se entiende. Tiene que ser como 192.168.0.10, o una invitación que empiece con SL-"))?;
        (addr, code)
    };
    let a = app.clone();
    let on_msg: Arc<dyn Fn(Option<Value>) + Send + Sync> = Arc::new(move |m| {
        let _ = match m {
            Some(msg) => a.emit("jam-guest", json!({ "msg": msg })),
            None => a.emit("jam-guest", json!({ "closed": true })),
        };
    });
    let name: String = name.trim().chars().take(24).collect();
    let joined = tauri::async_runtime::spawn_blocking(move || Guest::join(addr, code.trim(), &name, on_msg)).await.map_err(err)?;
    let guest = match joined {
        Ok(g) => g,
        Err(e) => {
            close_path(&state);
            return Err(err(e));
        }
    };
    let peer = guest.peer;
    // Files from an earlier room may be stale.
    if let Ok(dir) = jam_cache_dir(&app) {
        let _ = std::fs::remove_dir_all(&dir);
    }
    *state.guest.lock().unwrap() = Some(Arc::new(guest));
    Ok(peer)
}

fn current_guest(app: &AppHandle) -> CmdResult<Arc<Guest>> {
    let state: State<'_, JamState> = app.state();
    let g = state.guest.lock().unwrap().clone();
    g.ok_or_else(|| err("No estás en una sala."))
}

#[tauri::command]
pub fn jam_guest_send(app: AppHandle, msg: Value) -> CmdResult<()> {
    current_guest(&app)?.send(&msg).map_err(err)
}

/// One of the read-only library calls, answered by the host.
#[tauri::command]
pub async fn jam_guest_call(app: AppHandle, cmd: String, args: Value) -> CmdResult<Value> {
    let g = current_guest(&app)?;
    tauri::async_runtime::spawn_blocking(move || g.call(&cmd, args)).await.map_err(err)?.map_err(err)
}

fn jam_cache_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("jam-cache"))
}

/// A host sound file, copied here: returns the local path (cached for the room).
#[tauri::command]
pub async fn jam_guest_fetch(app: AppHandle, path: String) -> CmdResult<String> {
    let dir = jam_cache_dir(&app)?;
    let local = dir.join(cache_name(&path));
    if local.is_file() {
        return Ok(local.to_string_lossy().into_owned());
    }
    let g = current_guest(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<String> {
        let bytes = g.file(&path).map_err(err)?;
        std::fs::create_dir_all(&dir).map_err(err)?;
        let tmp = local.with_extension("part");
        std::fs::write(&tmp, &bytes).map_err(err)?;
        std::fs::rename(&tmp, &local).map_err(err)?;
        Ok(local.to_string_lossy().into_owned())
    })
    .await
    .map_err(err)?
}

/// Bring one of your sounds (a file on this PC) to the room: `{packId, itemId}`.
#[tauri::command]
pub async fn jam_guest_upload(app: AppHandle, path: String) -> CmdResult<Value> {
    let g = current_guest(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<Value> {
        let p = Path::new(&path);
        if !crate::packs::is_audio(p) {
            return Err(err("Ese archivo no es un sonido (WAV, FLAC, OGG, MP3 o AIFF)."));
        }
        let size = std::fs::metadata(p).map_err(err)?.len() as usize;
        if size > MAX_UPLOAD {
            return Err(err(format!("Ese sonido pesa demasiado para la sala (máximo {} MB).", MAX_UPLOAD / 1024 / 1024)));
        }
        let bytes = std::fs::read(p).map_err(err)?;
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "sonido.wav".into());
        g.upload(&name, &bytes).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn jam_leave(app: AppHandle) {
    let state: State<'_, JamState> = app.state();
    let g = state.guest.lock().unwrap().take();
    if let Some(g) = g {
        match Arc::try_unwrap(g) {
            Ok(g) => g.leave(),
            // A fetch is still running: closing the socket ends it.
            Err(g) => {
                let _ = g.stream.lock().unwrap().shutdown(std::net::Shutdown::Both);
            }
        }
    }
    close_path(&state);
}

pub fn shutdown(app: &AppHandle) {
    if let Some(s) = app.try_state::<JamState>() {
        if let Some(d) = s.door.lock().unwrap().take() {
            d.close();
        }
        if let Some(h) = s.host.lock().unwrap().take() {
            h.stop();
        }
        if let Some(g) = s.guest.lock().unwrap().take() {
            let _ = g.stream.lock().unwrap().shutdown(std::net::Shutdown::Both);
        }
        close_path(&s);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Fake {
        events: Mutex<Vec<HostEvent>>,
    }
    impl HostBackend for Fake {
        fn file(&self, path: &str) -> Result<Vec<u8>, String> {
            if path == "ok.wav" { Ok(vec![7u8; 100_000]) } else { Err("no".into()) }
        }
        fn call(&self, cmd: &str, args: Value) -> Result<Value, String> {
            Ok(json!({ "cmd": cmd, "args": args }))
        }
        fn upload(&self, who: &str, name: &str, bytes: &[u8]) -> Result<(String, String), String> {
            Ok((format!("{who}:{name}"), bytes.len().to_string()))
        }
        fn event(&self, e: HostEvent) {
            self.events.lock().unwrap().push(e);
        }
    }

    fn wait_for(f: impl Fn() -> bool) {
        let end = Instant::now() + Duration::from_secs(5);
        while !f() {
            assert!(Instant::now() < end, "timed out");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn start(code: &str) -> (Arc<Fake>, Host, SocketAddr) {
        let fake = Arc::new(Fake::default());
        let host = Host::start(fake.clone(), 0, "Sala de prueba".into(), code.into(), false).unwrap();
        let addr: SocketAddr = format!("127.0.0.1:{}", host.port).parse().unwrap();
        (fake, host, addr)
    }

    fn sink() -> (Arc<Mutex<Vec<Option<Value>>>>, Arc<dyn Fn(Option<Value>) + Send + Sync>) {
        let got: Arc<Mutex<Vec<Option<Value>>>> = Arc::default();
        let g = got.clone();
        (got, Arc::new(move |m| g.lock().unwrap().push(m)))
    }

    #[test]
    fn frames_round_trip_and_refuse_huge_ones() {
        let mut buf = Vec::new();
        write_frame(&mut buf, KIND_JSON, b"{\"a\":1}").unwrap();
        write_frame(&mut buf, KIND_BINARY, &[1, 2, 3, 4, 5]).unwrap();
        let mut r = &buf[..];
        assert_eq!(read_frame(&mut r, 100).unwrap(), (KIND_JSON, b"{\"a\":1}".to_vec()));
        assert_eq!(read_frame(&mut r, 100).unwrap(), (KIND_BINARY, vec![1, 2, 3, 4, 5]));
        let mut big = Vec::new();
        write_frame(&mut big, KIND_BINARY, &[0; 64]).unwrap();
        assert!(read_frame(&mut &big[..], 10).is_err());
    }

    #[test]
    fn beacons_codes_and_addresses() {
        let b = beacon_payload("Sala de Lucas", 47331);
        assert_eq!(parse_beacon(b.as_bytes()), Some(("Sala de Lucas".into(), 47331)));
        assert_eq!(parse_beacon(b"{\"app\":\"otra\",\"v\":1,\"name\":\"x\",\"port\":1}"), None);
        assert_eq!(parse_beacon(b"basura"), None);
        for _ in 0..50 {
            let c = new_code();
            assert!(c.len() == 4 && c.chars().all(|ch| ch.is_ascii_digit()));
        }
        assert_eq!(parse_address("192.168.0.10"), Some("192.168.0.10:47331".parse().unwrap()));
        assert_eq!(parse_address(" 10.0.0.2:5000 "), Some("10.0.0.2:5000".parse().unwrap()));
        assert_eq!(parse_address("hola"), None);
        assert_eq!(parse_address("100.101.7.3"), Some("100.101.7.3:47331".parse().unwrap()));
    }

    #[test]
    fn tailscale_addresses_are_reachable_internet_is_not() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(is_vpn(ip("100.64.0.1")) && is_vpn(ip("100.101.7.3")) && is_vpn(ip("100.127.255.254")));
        assert!(!is_vpn(ip("100.63.255.255")) && !is_vpn(ip("100.128.0.1")) && !is_vpn(ip("8.8.8.8")));
        assert!(is_vpn(ip("::ffff:100.100.1.1")));
        assert!(reachable(ip("192.168.0.10")) && reachable(ip("100.90.1.2")) && reachable(ip("fd7a:115c:a1e0::1")));
        assert!(!reachable(ip("8.8.8.8")) && !reachable(ip("181.1.2.3")));
        // The phone server is untouched: still LAN-only.
        assert!(!is_lan(ip("100.90.1.2")));
        assert_eq!(cache_name("C:\\x\\a.WAV").len(), 24 + 4);
        assert!(cache_name("C:\\x\\a.WAV").ends_with(".wav"));
        assert_ne!(cache_name("a.wav"), cache_name("b.wav"));
    }

    #[test]
    fn throttle_blocks_after_five_wrong_codes_for_a_minute() {
        let mut t = Throttle::default();
        let ip: IpAddr = "192.168.0.5".parse().unwrap();
        let now = Instant::now();
        for _ in 0..MAX_WRONG {
            assert!(!t.blocked(ip, now));
            t.wrong(ip, now);
        }
        assert!(t.blocked(ip, now));
        assert!(!t.blocked("192.168.0.6".parse().unwrap(), now));
        assert!(!t.blocked(ip, now + Duration::from_secs(61)));
    }

    #[test]
    fn wrong_code_is_refused_right_code_joins() {
        let (fake, host, addr) = start("1234");
        let (_, cb) = sink();
        let e = Guest::join(addr, "9999", "Ana", cb.clone()).err().unwrap();
        assert!(e.contains("código"), "{e}");
        let g = Guest::join(addr, "1234", "Ana", cb).unwrap();
        assert!(g.peer > 0);
        wait_for(|| fake.events.lock().unwrap().iter().any(|e| matches!(e, HostEvent::Join { name, .. } if name == "Ana")));
        assert_eq!(host.peer_count(), 1);
        g.leave();
        wait_for(|| fake.events.lock().unwrap().iter().any(|e| matches!(e, HostEvent::Leave { .. })));
        assert_eq!(host.peer_count(), 0);
        host.stop();
    }

    #[test]
    fn messages_relay_both_ways() {
        let (fake, host, addr) = start("0001");
        let (got_a, cb_a) = sink();
        let (got_b, cb_b) = sink();
        let a = Guest::join(addr, "0001", "Ana", cb_a).unwrap();
        let b = Guest::join(addr, "0001", "Beto", cb_b).unwrap();
        a.send(&json!({ "t": "ops", "ops": [1] })).unwrap();
        wait_for(|| fake.events.lock().unwrap().iter().any(|e| matches!(e, HostEvent::Msg { msg, .. } if msg["t"] == "ops")));
        host.send(None, &json!({ "t": "song", "rev": 3 }));
        host.send(Some(b.peer), &json!({ "t": "only-b" }));
        wait_for(|| got_a.lock().unwrap().len() == 1 && got_b.lock().unwrap().len() == 2);
        assert_eq!(got_a.lock().unwrap()[0].as_ref().unwrap()["rev"], 3);
        assert_eq!(got_b.lock().unwrap()[1].as_ref().unwrap()["t"], "only-b");
        host.stop();
        // Guests hear the room closing, then the end of the connection.
        wait_for(|| got_a.lock().unwrap().iter().any(|m| m.is_none()));
        assert!(got_a.lock().unwrap().iter().any(|m| m.as_ref().is_some_and(|m| m["reason"] == "closed")));
        a.leave();
        b.leave();
    }

    #[test]
    fn files_calls_and_uploads_are_answered_by_the_host() {
        let (_fake, host, addr) = start("4321");
        let (_, cb) = sink();
        let g = Guest::join(addr, "4321", "Ana", cb).unwrap();
        assert_eq!(g.file("ok.wav").unwrap().len(), 100_000);
        assert_eq!(g.file("nope.wav").unwrap_err(), "no");
        assert_eq!(g.call("packs_list", json!({ "x": 1 })).unwrap()["cmd"], "packs_list");
        assert!(g.call("song_save", json!({})).unwrap_err().contains("no está disponible"));
        assert_eq!(g.upload("bombo.wav", &[1, 2, 3]).unwrap(), json!({ "packId": "Ana:bombo.wav", "itemId": "3" }));
        host.stop();
        g.leave();
    }

    /// A friend at another home: the same room protocol through the iroh tunnel.
    #[test]
    fn a_guest_joins_through_the_internet_tunnel() {
        let (fake, host, _) = start("8642");
        let (door, path) = crate::jam_net::local_tunnel(host.port, "8642");
        assert!(crate::jam_net::parse_invite(&door.invite).is_some_and(|(c, _)| c == "8642"));
        let (got, cb) = sink();
        assert_eq!(Guest::join(path.local, "0000", "Ana", cb.clone()).err().as_deref(), Some(refusal("code").as_str()));
        // A refused try ends that tunnel: a new one for the real join (as the app does).
        door.close();
        path.close();
        let (door, path) = crate::jam_net::local_tunnel(host.port, "8642");
        let g = Guest::join(path.local, "8642", "Ana", cb).unwrap();
        g.send(&json!({ "t": "ops", "ops": [1] })).unwrap();
        wait_for(|| fake.events.lock().unwrap().iter().any(|e| matches!(e, HostEvent::Msg { msg, .. } if msg["t"] == "ops")));
        host.send(None, &json!({ "t": "song", "rev": 9 }));
        wait_for(|| got.lock().unwrap().iter().any(|m| m.as_ref().is_some_and(|m| m["rev"] == 9)));
        assert_eq!(g.file("ok.wav").unwrap().len(), 100_000);
        host.stop();
        wait_for(|| got.lock().unwrap().iter().any(|m| m.is_none()));
        g.leave();
        path.close();
        door.close();
    }

    /// F7.1 measurement: round trip of a small request through the room (loopback).
    /// `cargo test jam_round_trip -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn jam_round_trip() {
        let (_fake, host, addr) = start("2468");
        let (_, cb) = sink();
        let g = Guest::join(addr, "2468", "Ana", cb).unwrap();
        let mut times: Vec<f64> = (0..300)
            .map(|_| {
                let t = Instant::now();
                g.call("packs_list", json!({})).unwrap();
                t.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!("round trip ms: min {:.3} median {:.3} p95 {:.3} max {:.3}", times[0], times[150], times[285], times[299]);
        host.stop();
        g.leave();
    }

    #[test]
    fn room_pack_collects_guest_sounds() {
        let dir = tempfile::tempdir().unwrap();
        let (p, a) = add_to_room_pack(dir.path(), "Ana", "bombo.wav", b"RIFF").unwrap();
        let (_, b) = add_to_room_pack(dir.path(), "Ana", "bombo.wav", b"RIFF").unwrap();
        assert_eq!(p, ROOM_PACK);
        assert_ne!(a, b);
        assert!(dir.path().join("sala/Ana/bombo.wav").is_file());
        assert!(dir.path().join("sala/Ana/bombo (2).wav").is_file());
        let pack: crate::packs::Pack = serde_json::from_slice(&std::fs::read(dir.path().join("sala/pack.json")).unwrap()).unwrap();
        assert_eq!(pack.items.len(), 2);
        assert!(add_to_room_pack(dir.path(), "Ana", "virus.exe", b"MZ").is_err());
        // No escaping the pack folder through the name.
        add_to_room_pack(dir.path(), "../../x", "..\\..\\y.wav", b"RIFF").unwrap();
        assert!(!dir.path().parent().unwrap().join("y.wav").exists());
    }
}
