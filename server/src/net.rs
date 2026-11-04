//! The battlefield's WebSocket connections (/ws/battle, routed by server/src/http.rs). Each player
//! gets a small outgoing queue; the simulation thread drops updates for players who can't keep up
//! instead of letting the queue grow.

use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use crate::player::Build;
use crate::protocol::{MSG_ATTACH, MSG_BUILD, MSG_INPUT, MSG_JOIN, MSG_LAG, MSG_VIEW};
use crate::skills::{SKILL_WORDS, EMPTY_SKILLS};
use crate::tuning::{HOTBAR_SLOTS, MOVEMENT_SLOTS, NO_ABILITY, NO_MOVEMENT};

pub const QUEUE: usize = 32;

// One input as it arrived: when, its sequence number, the server tick × 16 the player was seeing,
// and the raw move_x, move_z, buttons, aim_x, aim_z, hotbar slot bytes.
pub type RawInput = (Instant, u32, u32, [u8; 7]);

pub struct ClientHandle {
    pub id: u32,
    pub tx: mpsc::Sender<(Instant, Bytes)>,
    pub view: Arc<AtomicU64>,   // packed (x, z) as two f32
    pub attach: Arc<AtomicU32>, // bot id + 1, or 0 to use `view`
    pub join: Arc<AtomicU8>,    // 0 = spectating, 1 = team 0, 2 = team 1, 3 = either
    // Requested build. Eight hotbar slots no longer fit in an atomic word, and a build changes
    // only when someone edits their skills, so a short lock costs nothing.
    pub build: Arc<Mutex<Build>>,
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

/// Reads a BUILD message body: weapon u8, the learned set as SKILL_WORDS little-endian u32s,
/// then one ability per hotbar slot.
pub fn read_build(b: &[u8]) -> Option<Build> {
    let base = 2 + SKILL_WORDS * 4;
    let want = base + HOTBAR_SLOTS + MOVEMENT_SLOTS;
    if b.len() < want {
        return None;
    }
    let mut skills = EMPTY_SKILLS;
    for (w, slot) in skills.iter_mut().enumerate() {
        let o = 2 + w * 4;
        *slot = u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    }
    let mut abilities = [NO_ABILITY; HOTBAR_SLOTS];
    abilities.copy_from_slice(&b[base..base + HOTBAR_SLOTS]);
    let mut movement = [NO_MOVEMENT; MOVEMENT_SLOTS];
    movement.copy_from_slice(&b[base + HOTBAR_SLOTS..want]);
    Some(Build { skills, weapon: b[1], abilities, movement })
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// One battlefield connection, from the welcome to the moment it closes.
pub async fn handle(ws: WebSocket, registry: Registry, welcome: Bytes) {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let _ = run(ws, id, registry.clone(), welcome).await;
    registry.lock().unwrap().retain(|c| c.id != id);
}

async fn run(ws: WebSocket, id: u32, registry: Registry, welcome: Bytes) -> Result<(), axum::Error> {
    let (mut write, mut read) = ws.split();
    write.send(Message::Binary(welcome)).await?;

    let (tx, mut rx) = mpsc::channel::<(Instant, Bytes)>(QUEUE);
    let view = Arc::new(AtomicU64::new(pack_view(0.0, -100.0)));
    let attach = Arc::new(AtomicU32::new(0));
    let join = Arc::new(AtomicU8::new(0));
    let build = Arc::new(Mutex::new(Build::default()));
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
                    let o = 2 + k * 15;
                    if b.len() < o + 15 {
                        break;
                    }
                    let seq = u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
                    let view = u32::from_le_bytes([b[o + 4], b[o + 5], b[o + 6], b[o + 7]]);
                    q.push((now, seq, view, [b[o + 8], b[o + 9], b[o + 10], b[o + 11], b[o + 12], b[o + 13], b[o + 14]]));
                }
            }
            MSG_JOIN if b.len() >= 2 => {
                let team = if b[1] < 2 { b[1] + 1 } else { 3 };
                join.store(team, Ordering::Relaxed);
            }
            MSG_BUILD => {
                if let Some(parsed) = read_build(&b) {
                    *build.lock().unwrap() = parsed;
                    build_seq.fetch_add(1, Ordering::Relaxed);
                }
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
