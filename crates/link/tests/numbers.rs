//! The link's numbers, run by hand (in release, as the server runs):
//!
//!   cargo test --release -p ruina-link --test numbers -- --ignored --nocapture --test-threads=1
//!
//! - **Codecs**: world-api's own messages (a tick's records for a gate, a player's inputs, a life to
//!   write, a player handed between simulations) written and read by MessagePack with field names
//!   and by JSON; postcard, which needs a schema and so can't carry world-api's messages as they
//!   are, measured on the one it can (inputs) for what such a format would save.
//! - **Throughput**: small messages and ticks' records over one link on this machine.
//! - **Latency**: a request and its answer, one after another.
//!
//! The numbers are in `.plans/refactor/reports/multiserver.md`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use ruina_engine::life::Life;
use ruina_engine::open::zone::emberholm;
use ruina_engine::player::{Build, Player};
use ruina_engine::world::Spawn;
use ruina_link::{Config, Encoding, Node};
use ruina_world_api::directory::Destination;
use ruina_world_api::gate::ToGate;
use ruina_world_api::ids::{Conn, EntityId, Epoch, GateId, SimId, SpaceId};
use ruina_world_api::input::Input;
use ruina_world_api::post::{Address, Envelope, Message};
use ruina_world_api::records::{Cell, LifeView, Presence, PresenceRecord, Private, TickOut, You};
use ruina_world_api::sim::{Carried, Entry, Member, Moving, ToSim};
use ruina_world_api::store::{LifeWrite, Then, ToStore, Writer};
use serde::{Deserialize, Serialize};

fn player(k: usize) -> Player {
    let s = emberholm().recipe.spawn;
    let mut p = Player::new(Spawn { x: s.x + (k % 8) as f64 * 9.0, z: s.z + (k / 8) as f64 * 9.0, facing: k as f64 * 0.3 }, (k % 2) as u8, Build::default());
    p.vel.x = 3.25;
    p.hp = 87.5;
    p
}

/// A tick of a busy channel for one gate: 40 players in 6 cells, 8 of them this gate's, one of
/// whom is sent their whole life this tick.
fn tick() -> Envelope {
    let life = Life::new(emberholm(), None, None);
    let mut cells: Vec<Cell> = (0..6).map(|c| Cell { at: (c, -2), ..Cell::default() }).collect();
    for k in 0..40 {
        let p = player(k);
        cells[k % 6].players.push(PresenceRecord {
            id: EntityId::character(1000 + k as i64),
            name: format!("Player{k}"),
            bot: k % 5 == 0,
            p: Presence::of(&p, None, 123_456 + k as u64),
        });
    }
    let private = (0..8)
        .map(|k| Private {
            character: 1000 + k as i64,
            you: You::of(k, 4321, &player(k), &life),
            life: (k == 0).then(|| LifeView::of(&life)),
            life_events: vec![],
            told: vec![],
        })
        .collect();
    let out = TickOut { sim: SimId(3), lease: Epoch(2), space: Some(SpaceId::channel("emberholm", 1)), tick: 9_000_000, cells, private, stats: None };
    Envelope { to: Address::Gate(GateId(1)), msg: Message::Gate(ToGate::Tick(Arc::new(out))) }
}

/// A player's inputs as a gate forwards them: three frames (60 a second, 20 ticks).
fn inputs() -> Envelope {
    let inputs = (0..3).map(|k| Input { seq: 1000 + k, view: 9_000_000 * 16 + k * 5, raw: [127, 0, 1, 0, 0, 3, 0, 0, 0, 127] }).collect();
    let conn = Conn { gate: GateId(1), character: 1042, session: 77 };
    Envelope { to: Address::Sim(SimId(3)), msg: Message::Sim(ToSim::Inputs { conn, inputs }) }
}

/// A life to write, fenced by its epoch.
fn life_write() -> Envelope {
    let life = Life::new(emberholm(), None, None);
    let saved = serde_json::json!({ "state": life.state, "player": { "x": 1.5, "y": 2.0, "z": -3.25, "facing": 0.5 } });
    let write = LifeWrite {
        character: 1042,
        epoch: Epoch(17),
        life: saved,
        space: SpaceId::channel("emberholm", 1),
        writer: Some(Writer { sim: SimId(3), space: SpaceId::channel("emberholm", 1), epoch: Epoch(2) }),
        tell: Some(Conn { gate: GateId(1), character: 1042, session: 77 }),
    };
    Envelope { to: Address::Store, msg: Message::Store(ToStore::WriteLives { writes: vec![write], then: Then::Nothing }) }
}

/// A player handed from one simulation to another, with their life.
fn transfer() -> Envelope {
    let conn = Conn { gate: GateId(1), character: 1042, session: 77 };
    let member = Member { conn, name: "Ana".into(), dev: false, epoch: Epoch(18), party: None, home: SpaceId::channel("emberholm", 1), keep_saved: false };
    let carried = Carried { player: player(3), life: Box::new(Life::new(emberholm(), None, None)) };
    let moving = Moving { character: 1042, member, carried, entry: Entry::Entrance, after: vec![], from: SimId(3) };
    let _ = Destination::Home;
    Envelope { to: Address::Sim(SimId(4)), msg: Message::Sim(ToSim::Transfer(Box::new(moving))) }
}

/// Nanoseconds per call of `f`, the best of five runs of `n`.
fn time(n: u32, mut f: impl FnMut()) -> f64 {
    (0..5)
        .map(|_| {
            let t = Instant::now();
            for _ in 0..n {
                f();
            }
            t.elapsed().as_nanos() as f64 / n as f64
        })
        .fold(f64::INFINITY, f64::min)
}

fn row(name: &str, e: &Envelope) {
    let n = if name == "tick" || name == "transfer" { 300 } else { 20_000 };
    let mut cells = Vec::new();
    for enc in [Encoding::MessagePack, Encoding::Json] {
        let bytes = enc.encode(e).unwrap();
        let write = time(n, || {
            std::hint::black_box(enc.encode(e).unwrap());
        });
        let read = time(n, || {
            std::hint::black_box(enc.decode::<Envelope>(&bytes).unwrap());
        });
        cells.push(format!("{:>7} B {:>9.1} µs {:>9.1} µs", bytes.len(), write / 1000.0, read / 1000.0));
    }
    println!("| {name:<10} | {} | {} |", cells[0], cells[1]);
}

#[test]
#[ignore = "a measurement, run by hand: cargo test --release -p ruina-link --test numbers -- --ignored --nocapture"]
fn codecs() {
    println!("\n| message    | MessagePack (named): size, write, read | JSON: size, write, read |");
    println!("|---|---|---|");
    for (name, e) in [("inputs", inputs()), ("life write", life_write()), ("tick", tick()), ("transfer", transfer())] {
        // Everything crosses whole each way.
        for enc in [Encoding::MessagePack, Encoding::Json] {
            let back: Envelope = enc.round_trip(&e).unwrap();
            assert_eq!(serde_json::to_value(&back).unwrap(), serde_json::to_value(&e).unwrap(), "{name} in {enc:?}");
        }
        row(name, &e);
    }
    // What a format with a schema would save, on the one message it can carry as it is.
    let Message::Sim(ToSim::Inputs { conn, inputs }) = inputs().msg else { unreachable!() };
    let character = conn.character;
    #[derive(Serialize, Deserialize)]
    struct Bare {
        character: i64,
        inputs: Vec<Input>,
    }
    let bare = Bare { character, inputs };
    let bytes = postcard::to_allocvec(&bare).unwrap();
    let write = time(20_000, || {
        std::hint::black_box(postcard::to_allocvec(&bare).unwrap());
    });
    let read = time(20_000, || {
        std::hint::black_box(postcard::from_bytes::<Bare>(&bytes).unwrap());
    });
    println!("postcard, the inputs alone: {} B, write {:.2} µs, read {:.2} µs", bytes.len(), write / 1000.0, read / 1000.0);
}

#[derive(Clone, Debug, Serialize, Deserialize)]
enum Small {
    N(u64),
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().unwrap()
}

#[test]
#[ignore = "a measurement, run by hand"]
fn throughput() {
    runtime().block_on(async {
        // Small messages: a number each.
        let (a, _) = Node::<Small>::start("a", "127.0.0.1:0", Config::default()).await.unwrap();
        let (b, mut inbox) = Node::<Small>::start("b", "127.0.0.1:0", Config::default()).await.unwrap();
        let link = a.link("b", &b.local_addr().to_string());
        link.send(&Small::N(0)).await.unwrap();
        inbox.recv().await.unwrap();
        const N: u64 = 1_000_000;
        let t = Instant::now();
        let sender = tokio::spawn(async move {
            for k in 1..=N {
                link.send(&Small::N(k)).await.unwrap();
            }
        });
        for k in 1..=N {
            let Small::N(got) = inbox.recv().await.unwrap().msg;
            assert_eq!(got, k);
        }
        sender.await.unwrap();
        let s = t.elapsed().as_secs_f64();
        println!("\nsmall messages: {N} in {s:.2} s, {:.0} a second", N as f64 / s);

        // Ticks' records for a gate, as a sim sends them.
        let (sim, _) = Node::<Envelope>::start("sim", "127.0.0.1:0", Config::default()).await.unwrap();
        let (gate, mut inbox) = Node::<Envelope>::start("gate", "127.0.0.1:0", Config::default()).await.unwrap();
        let link = sim.link("gate", &gate.local_addr().to_string());
        let e = tick();
        let size = Encoding::MessagePack.encode(&e).unwrap().len();
        const T: u64 = 5_000;
        let t = Instant::now();
        let sender = tokio::spawn(async move {
            for _ in 0..T {
                link.send(&e).await.unwrap();
            }
        });
        for _ in 0..T {
            inbox.recv().await.unwrap();
        }
        sender.await.unwrap();
        let s = t.elapsed().as_secs_f64();
        println!("ticks ({size} B each): {T} in {s:.2} s, {:.0} a second, {:.1} MB/s", T as f64 / s, (T as f64 * size as f64) / s / 1e6);
    });
}

#[test]
#[ignore = "a measurement, run by hand"]
fn latency() {
    runtime().block_on(async {
        let (a, _) = Node::<Small>::start("a", "127.0.0.1:0", Config::default()).await.unwrap();
        let (b, mut inbox) = Node::<Small>::start("b", "127.0.0.1:0", Config::default()).await.unwrap();
        tokio::spawn({
            let b = b.clone();
            async move {
                while let Some(e) = inbox.recv().await {
                    let Small::N(k) = e.msg;
                    b.reply(&e, &Small::N(k + 1)).unwrap();
                }
            }
        });
        let link = a.link("b", &b.local_addr().to_string());
        for k in 0..1000 {
            link.request(&Small::N(k), Duration::from_secs(5)).await.unwrap();
        }
        let mut times: Vec<f64> = Vec::with_capacity(20_000);
        for k in 0..20_000 {
            let t = Instant::now();
            let Small::N(got) = link.request(&Small::N(k), Duration::from_secs(5)).await.unwrap();
            times.push(t.elapsed().as_secs_f64() * 1e6);
            assert_eq!(got, k + 1);
        }
        times.sort_by(f64::total_cmp);
        let at = |q: f64| times[((times.len() - 1) as f64 * q) as usize];
        println!("\na request and its answer: p50 {:.0} µs, p99 {:.0} µs, p99.9 {:.0} µs, most {:.0} µs", at(0.5), at(0.99), at(0.999), at(1.0));
    });
}
