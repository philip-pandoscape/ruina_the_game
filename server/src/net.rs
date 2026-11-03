//! WebSocket connections. Each player gets a small outgoing queue; the simulation thread drops
//! updates for players who can't keep up instead of letting the queue grow.

use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::{Bytes, Message};

use crate::protocol::{MSG_ATTACH, MSG_BUILD, MSG_INPUT, MSG_JOIN, MSG_LAG, MSG_VIEW};

pub const QUEUE: usize = 32;

// One input as it arrived: when, its sequence number, the server tick × 16 the player was seeing,
// and the raw move_x, move_z, buttons, aim_x, aim_z bytes.
pub type RawInput = (Instant, u32, u32, [u8; 5]);

pub struct ClientHandle {
    pub id: u32,
    pub tx: mpsc::Sender<(Instant, Bytes)>,
    pub view: Arc<AtomicU64>,   // packed (x, z) as two f32
    pub attach: Arc<AtomicU32>, // bot id + 1, or 0 to use `view`
    pub join: Arc<AtomicU8>,    // 0 = spectating, 1 = team 0, 2 = team 1, 3 = either
    pub build: Arc<AtomicU64>,  // requested build: skills (16 bits), weapon, ability1, ability2 (see pack_build)
    pub build_seq: Arc<AtomicU32>, // counts up each time the browser sends a new build
    pub lag_ms: Arc<AtomicU32>, // testing only: extra delay each way
    pub inputs: Arc<Mutex<Vec<RawInput>>>,
}

pub type Registry = Arc<Mutex<Vec<ClientHandle>>>;

pub fn pack_view(x: f32, z: f32) -> u64 {
    ((x.to_bits() as u64) << 32) | z.to_bits() as u64
}

pub fn unpack_view(v: u64) -> (f32, f32) {
    (f32::from_bits((v >> 32) as u32), f32::from_bits(v as u32))
}

pub fn pack_build(skills: u32, weapon: u8, ability1: u8, ability2: u8) -> u64 {
    (skills as u64 & 0xFFFF) | (weapon as u64) << 16 | (ability1 as u64) << 24 | (ability2 as u64) << 32
}

/// (skills, weapon, ability1, ability2)
pub fn unpack_build(v: u64) -> (u32, u8, u8, u8) {
    ((v & 0xFFFF) as u32, (v >> 16) as u8, (v >> 24) as u8, (v >> 32) as u8)
}

pub async fn serve(port: u16, registry: Registry, welcome: Bytes) -> std::io::Result<()> {
    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    println!("listening on ws://localhost:{port}");
    let mut next_id = 1u32;
    loop {
        let (stream, _) = listener.accept().await?;
        let _ = stream.set_nodelay(true);
        let id = next_id;
        next_id += 1;
        let (registry, welcome) = (registry.clone(), welcome.clone());
        tokio::spawn(async move {
            let _ = handle(stream, id, registry.clone(), welcome).await;
            registry.lock().unwrap().retain(|c| c.id != id);
        });
    }
}

async fn handle(stream: TcpStream, id: u32, registry: Registry, welcome: Bytes) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    let ws = accept_async(stream).await?;
    let (mut write, mut read) = ws.split();
    write.send(Message::Binary(welcome)).await?;

    let (tx, mut rx) = mpsc::channel::<(Instant, Bytes)>(QUEUE);
    let view = Arc::new(AtomicU64::new(pack_view(0.0, -100.0)));
    let attach = Arc::new(AtomicU32::new(0));
    let join = Arc::new(AtomicU8::new(0));
    let build = Arc::new(AtomicU64::new(0));
    let build_seq = Arc::new(AtomicU32::new(0));
    let lag_ms = Arc::new(AtomicU32::new(0));
    let inputs = Arc::new(Mutex::new(Vec::new()));
    registry.lock().unwrap().push(ClientHandle {
        id,
        tx,
        view: view.clone(),
        attach: attach.clone(),
        join: join.clone(),
        build: build.clone(),
        build_seq: build_seq.clone(),
        lag_ms: lag_ms.clone(),
        inputs: inputs.clone(),
    });

    let writer_lag = lag_ms.clone();
    let writer = tokio::spawn(async move {
        while let Some((queued, bytes)) = rx.recv().await {
            // Simulated lag (testing): hold each message until it's old enough.
            let lag = writer_lag.load(Ordering::Relaxed);
            if lag > 0 {
                let due = queued + Duration::from_millis(lag as u64);
                tokio::time::sleep_until(due.into()).await;
            }
            if write.send(Message::Binary(bytes)).await.is_err() {
                break;
            }
        }
    });

    while let Some(msg) = read.next().await {
        let Message::Binary(b) = msg? else { continue };
        if b.is_empty() {
            continue;
        }
        match b[0] {
            MSG_INPUT if b.len() >= 2 => {
                let count = b[1] as usize;
                let now = Instant::now();
                let mut q = inputs.lock().unwrap();
                for k in 0..count {
                    let o = 2 + k * 13;
                    if b.len() < o + 13 {
                        break;
                    }
                    let seq = u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
                    let view = u32::from_le_bytes([b[o + 4], b[o + 5], b[o + 6], b[o + 7]]);
                    q.push((now, seq, view, [b[o + 8], b[o + 9], b[o + 10], b[o + 11], b[o + 12]]));
                }
            }
            MSG_JOIN if b.len() >= 2 => {
                let team = if b[1] < 2 { b[1] + 1 } else { 3 };
                join.store(team, Ordering::Relaxed);
            }
            MSG_BUILD if b.len() >= 6 => {
                let skills = u16::from_le_bytes([b[1], b[2]]) as u32;
                build.store(pack_build(skills, b[3], b[4], b[5]), Ordering::Relaxed);
                build_seq.fetch_add(1, Ordering::Relaxed);
            }
            MSG_LAG if b.len() >= 3 => {
                lag_ms.store(u16::from_le_bytes([b[1], b[2]]) as u32, Ordering::Relaxed);
            }
            MSG_VIEW if b.len() >= 9 => {
                let x = f32::from_le_bytes([b[1], b[2], b[3], b[4]]);
                let z = f32::from_le_bytes([b[5], b[6], b[7], b[8]]);
                if x.is_finite() && z.is_finite() {
                    view.store(pack_view(x, z), Ordering::Relaxed);
                    attach.store(0, Ordering::Relaxed);
                }
            }
            MSG_ATTACH if b.len() >= 5 => {
                let bot = u32::from_le_bytes([b[1], b[2], b[3], b[4]]);
                attach.store(bot.saturating_add(1), Ordering::Relaxed);
            }
            _ => {}
        }
    }
    writer.abort();
    Ok(())
}
