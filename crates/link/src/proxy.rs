//! A TCP proxy for tests between processes (`crates/server/tests/cluster.rs`): whoever dials it is
//! put through to its upstream, until a test cuts it (every connection through it dropped, and new
//! ones refused until it's restored). Between two nodes it can also read the link's frames on their
//! way to the listener and write every n-th message twice; in front of anything else (Postgres) it
//! passes bytes as they are.

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::frame::{Frame, FrameReader};

/// How many times the proxy has been cut, and whether it's cut now: a connection made before the
/// latest cut is dropped, however soon the proxy was restored.
#[derive(Clone, Copy, Default)]
struct Cuts {
    cuts: u64,
    held: bool,
}

struct Inner {
    upstream: String,
    framed: bool,
    cut: watch::Sender<Cuts>,
    stop: watch::Sender<bool>,
    /// Write every n-th message twice (0: none).
    every: AtomicU64,
    messages: AtomicU64,
    duplicated: AtomicU64,
    connections: AtomicU64,
}

/// A proxy in front of `upstream`. Stops when dropped.
pub struct Proxy {
    addr: SocketAddr,
    inner: Arc<Inner>,
}

impl Proxy {
    /// Listens on `listen` (port 0 for any) and puts each connection through to `upstream`.
    /// `framed`: what passes is a link (its messages can be written twice).
    pub async fn start(listen: SocketAddr, upstream: &str, framed: bool) -> io::Result<Proxy> {
        let listener = TcpListener::bind(listen).await?;
        let addr = listener.local_addr()?;
        let inner = Arc::new(Inner {
            upstream: upstream.to_string(),
            framed,
            cut: watch::channel(Cuts::default()).0,
            stop: watch::channel(false).0,
            every: AtomicU64::new(0),
            messages: AtomicU64::new(0),
            duplicated: AtomicU64::new(0),
            connections: AtomicU64::new(0),
        });
        tokio::spawn(accept(inner.clone(), listener));
        Ok(Proxy { addr, inner })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// Drops every connection through it now, and refuses new ones until `restore`.
    pub fn cut(&self) {
        self.inner.cut.send_modify(|c| {
            c.cuts += 1;
            c.held = true;
        });
    }

    pub fn restore(&self) {
        self.inner.cut.send_modify(|c| c.held = false);
    }

    /// Writes every `n`-th message on its way to the listener twice (0: none). Framed proxies only.
    pub fn duplicate_every(&self, n: u64) {
        self.inner.every.store(n, Ordering::Relaxed);
    }

    /// Messages written twice so far.
    pub fn duplicated(&self) -> u64 {
        self.inner.duplicated.load(Ordering::Relaxed)
    }

    /// Connections put through so far.
    pub fn connections(&self) -> u64 {
        self.inner.connections.load(Ordering::Relaxed)
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.inner.stop.send_replace(true);
    }
}

async fn accept(inner: Arc<Inner>, listener: TcpListener) {
    let mut stop = inner.stop.subscribe();
    loop {
        let (down, _) = tokio::select! {
            r = listener.accept() => match r {
                Ok(c) => c,
                Err(_) => continue,
            },
            _ = crate::until(&mut stop, |s| *s) => return,
        };
        // Cut: taken and dropped at once, as a dead network would.
        let Cuts { cuts, held } = *inner.cut.borrow();
        if held {
            continue;
        }
        tokio::spawn(pass(inner.clone(), down, cuts));
    }
}

async fn pass(inner: Arc<Inner>, down: TcpStream, cuts: u64) {
    let Ok(up) = TcpStream::connect(&inner.upstream).await else { return };
    inner.connections.fetch_add(1, Ordering::Relaxed);
    let _ = (down.set_nodelay(true), up.set_nodelay(true));
    let mut cut = inner.cut.subscribe();
    let mut stop = inner.stop.subscribe();
    let (dr, dw) = down.into_split();
    let (ur, uw) = up.into_split();
    let toward = async { if inner.framed { frames(&inner, dr, uw).await } else { bytes(dr, uw).await.map(|_| ()) } };
    let back = bytes(ur, dw);
    tokio::select! {
        _ = toward => {}
        _ = back => {}
        _ = crate::until(&mut cut, |c| c.cuts != cuts) => {}
        _ = crate::until(&mut stop, |s| *s) => {}
    }
}

async fn bytes(mut from: tokio::net::tcp::OwnedReadHalf, mut to: tokio::net::tcp::OwnedWriteHalf) -> io::Result<u64> {
    tokio::io::copy(&mut from, &mut to).await
}

async fn frames(inner: &Inner, from: tokio::net::tcp::OwnedReadHalf, to: tokio::net::tcp::OwnedWriteHalf) -> io::Result<()> {
    let mut reader = FrameReader::new(from, 64 << 20);
    let mut to = BufWriter::with_capacity(64 << 10, to);
    while let Some(frame) = reader.next().await? {
        let bytes = frame.encode();
        to.write_all(&bytes).await?;
        if let Frame::Msg { .. } = frame {
            let n = inner.messages.fetch_add(1, Ordering::Relaxed) + 1;
            let every = inner.every.load(Ordering::Relaxed);
            if every > 0 && n.is_multiple_of(every) {
                to.write_all(&bytes).await?;
                inner.duplicated.fetch_add(1, Ordering::Relaxed);
            }
        }
        if !reader.buffered() {
            to.flush().await?;
        }
    }
    to.flush().await
}
