//! "Tocar juntos" from different homes: a tunnel over the internet with iroh.
//!
//! The room itself (jam.rs) doesn't change. iroh only carries its TCP bytes:
//! - host: `Door` accepts iroh connections (dialed by this PC's public key) and pipes each
//!   one into the room's local TCP port, so a friend at home looks like any LAN guest;
//! - guest: `Path` dials the host by key and opens a loopback port; `Guest::join` connects
//!   to that port as if the room were on the Wi-Fi.
//!
//! iroh connects the two PCs directly (QUIC, encrypted, NAT hole punching); when that's not
//! possible the traffic goes through n0's free public relays (still end-to-end encrypted).
//! The door opens only when the host asks to invite someone from another home: until then
//! nothing leaves the local network. Each door has a fresh key, so an invite stops working
//! when the room closes.
//!
//! An invite is `SL-<code>-<key>@<relay>`: the room code, the host's key (z-base-32) and
//! the n0 relay the host sits on (so the guest needn't look the key up: that lookup was
//! unreliable right after a room opened). One thing to paste. The 4-digit code still gates the room (rate-limited in jam.rs), and nobody can
//! even reach the door without the key.

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayUrl, SecretKey};
use std::net::SocketAddr;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

/// Protocol name for iroh (both sides must agree).
const ALPN: &[u8] = b"sampler-lab/jam/1";
/// Most tunnels at once into one room (a room holds 8 people; a few spares for retries).
const MAX_TUNNELS: usize = 12;

/// The tunnel's own async runtime: the room code is plain threads, and this keeps iroh
/// independent from whatever runtime the app (or a test) has.
fn rt() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("jam-net")
            .enable_all()
            .build()
            .expect("tokio runtime")
    })
}

/// `SL-1234-<key>@<relay>` → (code, where the host is). Spaces and line breaks (pasted
/// from a chat) are ignored; the relay part is optional.
pub fn parse_invite(text: &str) -> Option<(String, EndpointAddr)> {
    let clean: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let rest = clean.strip_prefix("SL-").or_else(|| clean.strip_prefix("sl-"))?;
    let (code, rest) = rest.split_once('-')?;
    if code.len() != 4 || !code.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let (key, relay) = match rest.split_once('@') {
        Some((k, r)) => (k, Some(r)),
        None => (rest, None),
    };
    let id = EndpointId::from_z32(&key.to_lowercase()).ok()?;
    let mut addr = EndpointAddr::new(id);
    if let Some(r) = relay {
        let url: RelayUrl = format!("https://{}", r.to_lowercase().trim_start_matches("https://")).parse().ok()?;
        addr = addr.with_relay_url(url);
    }
    Some((code.to_string(), addr))
}

pub fn invite(code: &str, addr: &EndpointAddr) -> String {
    let mut out = format!("SL-{code}-{}", addr.id.to_z32());
    if let Some(r) = addr.relay_urls().next() {
        out.push('@');
        out.push_str(r.as_str().trim_start_matches("https://"));
    }
    out
}

/// Bytes both ways between a local TCP socket and one iroh stream, until either side ends.
async fn pipe(tcp: TcpStream, send: iroh::endpoint::SendStream, recv: iroh::endpoint::RecvStream) {
    let _ = tcp.set_nodelay(true);
    let mut tcp = tcp;
    let mut quic = tokio::io::join(recv, send);
    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut quic).await;
}

// ---------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------

/// The room's door to the internet.
pub struct Door {
    endpoint: Endpoint,
    task: JoinHandle<()>,
    pub invite: String,
}

impl Door {
    /// Open the door for the room listening on `127.0.0.1:port`. Waits (a few seconds) until
    /// this PC is reachable from the internet.
    pub fn open(port: u16, code: &str) -> Result<Door, String> {
        let code = code.to_string();
        rt().block_on(async move {
            let endpoint = Endpoint::builder(presets::N0)
                .secret_key(SecretKey::generate())
                .alpns(vec![ALPN.to_vec()])
                .bind()
                .await
                .map_err(|_| "No pude preparar la conexión por internet.".to_string())?;
            if tokio::time::timeout(Duration::from_secs(12), endpoint.online()).await.is_err() {
                endpoint.close().await;
                return Err("No pude salir a internet. ¿Esta PC tiene conexión?".into());
            }
            Ok(Door::serve(endpoint, port, &code))
        })
    }

    /// Accept tunnels on `endpoint` into the local room port (also used by tests).
    fn serve(endpoint: Endpoint, port: u16, code: &str) -> Door {
        let invite = invite(code, &endpoint.addr());
        let ep = endpoint.clone();
        let task = rt().spawn(async move {
            let open = std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_TUNNELS));
            while let Some(incoming) = ep.accept().await {
                let Ok(permit) = open.clone().try_acquire_owned() else {
                    incoming.refuse();
                    continue;
                };
                tokio::spawn(async move {
                    let _permit = permit;
                    let Ok(conn) = incoming.await else { return };
                    // The guest opens one stream and speaks first (its hello).
                    let Ok(Ok((send, recv))) = tokio::time::timeout(Duration::from_secs(10), conn.accept_bi()).await else {
                        return;
                    };
                    let Ok(tcp) = TcpStream::connect(("127.0.0.1", port)).await else { return };
                    pipe(tcp, send, recv).await;
                    conn.close(0u32.into(), b"bye");
                });
            }
        });
        Door { endpoint, task, invite }
    }

    /// Close (in the background: never blocks the caller).
    pub fn close(self) {
        self.task.abort();
        let ep = self.endpoint;
        rt().spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(2), ep.close()).await;
        });
    }
}

// ---------------------------------------------------------------------------
// Guest side
// ---------------------------------------------------------------------------

/// A guest's way to a room at another home: a loopback port that leads there.
pub struct Path {
    endpoint: Endpoint,
    task: JoinHandle<()>,
    /// Connect the room's `Guest` here.
    pub local: SocketAddr,
}

impl Path {
    /// Reach the host with this key over the internet.
    pub fn connect(host: EndpointAddr) -> Result<Path, String> {
        rt().block_on(async move {
            let endpoint = Endpoint::bind(presets::N0).await.map_err(|_| "No pude preparar la conexión por internet.".to_string())?;
            Path::through(endpoint, host).await
        })
    }

    async fn through(endpoint: Endpoint, host: EndpointAddr) -> Result<Path, String> {
        // A room that just opened may not be findable by its key for a few seconds (its
        // address is still being published): keep trying for a while.
        let end = tokio::time::Instant::now() + Duration::from_secs(25);
        let conn = loop {
            let left = end.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(left, endpoint.connect(host.clone(), ALPN)).await {
                Ok(Ok(c)) => break c,
                Ok(Err(_)) if left > Duration::from_secs(2) => tokio::time::sleep(Duration::from_millis(1500)).await,
                _ => {
                    endpoint.close().await;
                    return Err("No pude llegar a la sala por internet. ¿La invitación es la última que te mandaron? ¿La sala sigue abierta?".into());
                }
            }
        };
        let Ok((send, recv)) = conn.open_bi().await else {
            endpoint.close().await;
            return Err("La sala no aceptó la conexión.".into());
        };
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
        let local = listener.local_addr().map_err(|e| e.to_string())?;
        let task = tokio::spawn(async move {
            // One connection: the room's Guest. When it ends, so does the tunnel.
            if let Ok(Ok((tcp, _))) = tokio::time::timeout(Duration::from_secs(10), listener.accept()).await {
                drop(listener);
                pipe(tcp, send, recv).await;
            }
            conn.close(0u32.into(), b"bye");
        });
        Ok(Path { endpoint, task, local })
    }

    /// Close (in the background: never blocks the caller).
    pub fn close(self) {
        self.task.abort();
        let ep = self.endpoint;
        rt().spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(2), ep.close()).await;
        });
    }
}

/// A door and a path on this machine, offline (no relays, no lookups): for tests.
#[cfg(test)]
pub(crate) fn local_tunnel(port: u16, code: &str) -> (Door, Path) {
    let door = Door::serve(rt().block_on(tests::local_endpoint(true)), port, code);
    let addr = door.endpoint.addr();
    let path = rt().block_on(async { Path::through(tests::local_endpoint(false).await, addr).await }).unwrap();
    (door, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::RelayMode;

    /// Through the real internet (n0's relays and key lookup), both ends on this PC.
    /// `cargo test jam_net_online -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn jam_net_online() {
        use std::io::{Read, Write};
        let room = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = room.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = room.accept().unwrap();
            let mut buf = [0u8; 4];
            while s.read_exact(&mut buf).is_ok() {
                let _ = s.write_all(&buf);
            }
        });
        let t = std::time::Instant::now();
        let door = Door::open(port, "1357").unwrap();
        println!("door online in {:?}: {}", t.elapsed(), door.invite);
        let (code, addr) = parse_invite(&door.invite).unwrap();
        assert_eq!(code, "1357");
        let t = std::time::Instant::now();
        let path = Path::connect(addr).unwrap();
        println!("connected by key in {:?}", t.elapsed());
        let mut s = std::net::TcpStream::connect(path.local).unwrap();
        s.set_nodelay(true).unwrap();
        let mut back = [0u8; 4];
        let mut rtts = Vec::new();
        for _ in 0..20 {
            let t = std::time::Instant::now();
            s.write_all(b"ping").unwrap();
            s.read_exact(&mut back).unwrap();
            rtts.push(t.elapsed());
        }
        rtts.sort();
        println!("round trip: best {:?}, median {:?}", rtts[0], rtts[10]);
        path.close();
        door.close();
    }

    #[test]
    fn invites_round_trip_and_reject_junk() {
        let id = SecretKey::generate().public();
        let relay: RelayUrl = "https://use1-1.relay.n0.iroh.iroh.link./".parse().unwrap();
        let addr = EndpointAddr::new(id).with_relay_url(relay);
        let text = invite("0427", &addr);
        assert!(text.starts_with("SL-0427-") && text.ends_with("@use1-1.relay.n0.iroh.iroh.link./"), "{text}");
        assert_eq!(parse_invite(&text), Some(("0427".into(), addr.clone())));
        // Pasted from a chat: spaces, line breaks, upper case.
        let messy = format!("  {}\n", text.to_uppercase().replacen("SL-", "sl- ", 1));
        assert_eq!(parse_invite(&messy).map(|x| x.1), Some(addr));
        // Without the relay part: the key alone.
        assert_eq!(parse_invite(&invite("0427", &EndpointAddr::new(id))).map(|x| x.1), Some(EndpointAddr::new(id)));
        assert_eq!(parse_invite("192.168.0.10"), None);
        assert_eq!(parse_invite("SL-12-abc"), None);
        assert_eq!(parse_invite("SL-1234-notakey"), None);
    }

    /// Offline endpoints (no relays, no lookups) on this machine.
    pub(crate) async fn local_endpoint(alpn: bool) -> Endpoint {
        let mut b = Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled);
        if alpn {
            b = b.alpns(vec![ALPN.to_vec()]);
        }
        b.bind_addr("127.0.0.1:0").unwrap().bind().await.unwrap()
    }

    /// The tunnel carries bytes both ways and ends when either side ends.
    #[test]
    fn tunnel_pipes_a_local_tcp_port() {
        use std::io::{Read, Write};
        // A stand-in for the room: echo, upper-cased.
        let room = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = room.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = room.accept().unwrap();
            let mut buf = [0u8; 5];
            s.read_exact(&mut buf).unwrap();
            s.write_all(&buf.to_ascii_uppercase()).unwrap();
        });
        let (door, path) = local_tunnel(port, "1234");
        let mut s = std::net::TcpStream::connect(path.local).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(b"hola!").unwrap();
        let mut back = [0u8; 5];
        s.read_exact(&mut back).unwrap();
        assert_eq!(&back, b"HOLA!");
        // The room hung up: the guest side sees the end.
        let mut rest = Vec::new();
        assert_eq!(s.read_to_end(&mut rest).unwrap_or(0), 0);
        path.close();
        door.close();
    }
}
