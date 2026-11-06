//! Load tester: opens many real WebSocket connections to the server, each following one bot,
//! and measures what each connection receives.
//!
//!   cargo run --release --bin loadtest -- --clients 1000 --seconds 15

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::{Bytes, Message};
use yggdrasil_server::protocol::{MSG_ATTACH, MSG_SNAPSHOT, NEAR_ENTRY};

#[derive(Default)]
struct Counters {
    bytes: AtomicU64,
    msgs: AtomicU64,
    snapshots: AtomicU64,
    near: AtomicU64,
    mid: AtomicU64,
    mid_updates: AtomicU64,
    connected: AtomicUsize,
    failed: AtomicUsize,
    closed: AtomicUsize,
}

struct Totals {
    bytes: u64,
    msgs: u64,
    snapshots: u64,
    near: u64,
    mid: u64,
    mid_updates: u64,
}

fn totals(c: &Counters) -> Totals {
    Totals {
        bytes: c.bytes.load(Ordering::Relaxed),
        msgs: c.msgs.load(Ordering::Relaxed),
        snapshots: c.snapshots.load(Ordering::Relaxed),
        near: c.near.load(Ordering::Relaxed),
        mid: c.mid.load(Ordering::Relaxed),
        mid_updates: c.mid_updates.load(Ordering::Relaxed),
    }
}

#[tokio::main]
async fn main() {
    let (mut url, mut clients, mut seconds, mut bots) = ("ws://127.0.0.1:7777/ws/battle".to_string(), 1000usize, 15u64, 10_000usize);
    let argv: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i + 1 < argv.len() {
        let v = argv[i + 1].clone();
        match argv[i].as_str() {
            "--url" => url = v,
            "--clients" => clients = v.parse().expect("--clients needs a number"),
            "--seconds" => seconds = v.parse().expect("--seconds needs a number"),
            "--bots" => bots = v.parse().expect("--bots needs a number"),
            other => panic!("unknown argument {other}"),
        }
        i += 2;
    }

    let c = Arc::new(Counters::default());
    for k in 0..clients {
        let (c, url) = (c.clone(), url.clone());
        let bot = (k * bots / clients.max(1)) as u32;
        tokio::spawn(async move {
            let Ok((ws, _)) = connect_async(url.as_str()).await else {
                c.failed.fetch_add(1, Ordering::Relaxed);
                return;
            };
            c.connected.fetch_add(1, Ordering::Relaxed);
            let (mut write, mut read) = ws.split();
            let mut attach = vec![MSG_ATTACH];
            attach.extend_from_slice(&bot.to_le_bytes());
            if write.send(Message::Binary(Bytes::from(attach))).await.is_err() {
                return;
            }
            while let Some(Ok(msg)) = read.next().await {
                let Message::Binary(b) = msg else { continue };
                c.bytes.fetch_add(b.len() as u64, Ordering::Relaxed);
                c.msgs.fetch_add(1, Ordering::Relaxed);
                if b[0] == MSG_SNAPSHOT && b.len() >= 7 {
                    let near = u16::from_le_bytes([b[5], b[6]]) as usize;
                    c.snapshots.fetch_add(1, Ordering::Relaxed);
                    c.near.fetch_add(near as u64, Ordering::Relaxed);
                    let at = 7 + near * NEAR_ENTRY;
                    if b.len() >= at + 2 {
                        let mid = u16::from_le_bytes([b[at], b[at + 1]]) as u64;
                        if mid > 0 {
                            c.mid.fetch_add(mid, Ordering::Relaxed);
                            c.mid_updates.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            }
            c.closed.fetch_add(1, Ordering::Relaxed);
        });
        if k % 50 == 49 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    // Let every connection finish its handshake, then measure.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let a = totals(&c);
    let t0 = Instant::now();
    tokio::time::sleep(Duration::from_secs(seconds)).await;
    let b = totals(&c);
    let secs = t0.elapsed().as_secs_f64();

    let connected = c.connected.load(Ordering::Relaxed);
    let per = |v: u64| v as f64 / secs / connected.max(1) as f64;
    let bytes = per(b.bytes - a.bytes);
    let snapshots = (b.snapshots - a.snapshots).max(1) as f64;
    let mid_updates = (b.mid_updates - a.mid_updates).max(1) as f64;
    println!("connections: {connected} ok, {} failed, {} closed early", c.failed.load(Ordering::Relaxed), c.closed.load(Ordering::Relaxed));
    println!("per connection: {:.0} KB/s ({:.2} Mbit/s), {:.1} messages/s", bytes / 1024.0, bytes * 8.0 / 1e6, per(b.msgs - a.msgs));
    println!(
        "fighters per update: {:.0} nearby (every tick), {:.0} mid-range (every 4th tick)",
        (b.near - a.near) as f64 / snapshots,
        (b.mid - a.mid) as f64 / mid_updates
    );
    println!("all connections together: {:.1} MB/s received", (b.bytes - a.bytes) as f64 / secs / 1e6);
    std::process::exit(0);
}
