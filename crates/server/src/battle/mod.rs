//! The PvP battlefield: thousands of fighters simulated at a fixed tick rate (the engine's sim.rs),
//! each connected player streamed a personal update of what's near them (interest.rs) over its own
//! WebSocket (net.rs). Fenced in here until the battlefield becomes a developer zone with bots
//! (the refactor's Phase 10), when this goes.

pub mod interest;
pub mod net;

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use rayon::prelude::*;
use tokio::sync::mpsc::Sender;

use crate::actors::{Actors, LEAN_DAMPING, LEAN_SPRING, StepOut};
use crate::combat::Players;
use crate::http;
use crate::protocol::{self, StatsMsg};
use crate::sim::{Battle, BotHit, FIELD};
use crate::world::{SEED, battlefield};
use interest::{InterestGrid, MID_EVERY, Records, Scratch, build_snapshot};
use net::{Registry, unpack_view};

/// Starts the battlefield: its simulation on a thread of its own, and what its connections need.
pub fn start(bots: usize, virtual_clients: usize, hz: u32, slimes: usize) -> http::Battle {
    let registry: Registry = Arc::new(Mutex::new(Vec::new()));
    let welcome = Bytes::from(protocol::welcome(bots, hz, FIELD));
    println!(
        "battlefield: bots {} | slimes {} | virtual players {} | {} ticks/s | {} CPU threads",
        bots,
        slimes,
        virtual_clients,
        hz,
        rayon::current_num_threads()
    );
    let sim_registry = registry.clone();
    std::thread::Builder::new().name("sim".into()).spawn(move || run(bots, virtual_clients, hz, slimes, sim_registry)).expect("start sim thread");
    http::Battle { registry, welcome }
}

#[derive(Default)]
struct Window {
    ticks: u32,
    tick_ms: f64,
    worst_ms: f64,
    sim_ms: f64,
    snap_ms: f64,
    real_bytes: u64,
    virt_bytes: u64,
    dropped: u64,
    real_client_ticks: u64,
}

// The battlefield's loop, with its tuples of clients; it goes when the battlefield becomes a zone
// (.plans/refactor, Phase 10).
#[allow(clippy::type_complexity)]
fn run(bots: usize, virtual_clients: usize, hz: u32, slimes: usize, registry: Registry) {
    let world = battlefield(SEED);
    let mut battle = Battle::new(bots);
    let mut players = Players::new(bots, 1000.0 / hz as f64);
    let mut bot_hits: Vec<BotHit> = Vec::new();
    let mut grid = InterestGrid::new(bots);
    let mut records = Records::new(bots);
    // Monsters live near where players come in, so they are something you meet rather than
    // something you have to go looking for.
    let mut actors = Actors::new();
    for i in 0..slimes {
        let angle = (i as f64 / slimes.max(1) as f64) * std::f64::consts::PI * 2.0 + 0.4;
        let r = 6.0 + (i % 5) as f64 * 2.5;
        actors.spawn(
            "slime",
            world.team_spawns[0].x + angle.sin() * r,
            world.team_spawns[0].z + 6.0 + angle.cos() * r,
            (SEED ^ 0x51e0).wrapping_add((i as u32).wrapping_mul(0x9e37_79b1)),
        );
    }
    let dt = 1.0 / hz as f32;
    let monster_steps = (60 / hz.max(1)).max(1);
    let period = Duration::from_secs_f64(1.0 / hz as f64);
    let mut next = Instant::now() + period;
    let mut window = Window::default();
    let mut window_start = Instant::now();
    let mut last_stats: Option<Bytes> = None;

    loop {
        let t0 = Instant::now();

        // Who's connected: handle join requests and pick up inputs that have arrived
        // (after any simulated test lag).
        let now = Instant::now();
        let mut connected: HashSet<u32> = HashSet::new();
        let raw_clients: Vec<(u32, Sender<(Instant, Bytes)>, u32, u64)> = {
            let reg = registry.lock().unwrap();
            for c in reg.iter() {
                connected.insert(c.id);
                let join = c.join.load(Ordering::Relaxed);
                if join > 0 {
                    players.join(c.id, join, &world);
                }
                let build_seq = c.build_seq.load(Ordering::Relaxed);
                if build_seq > 0 {
                    let build = *c.build.lock().unwrap();
                    players.sync_build(c.id, build_seq, build);
                }
                let lag = Duration::from_millis(c.lag_ms.load(Ordering::Relaxed) as u64);
                let mut q = c.inputs.lock().unwrap();
                let ready = q.iter().take_while(|(t, _, _, _)| *t + lag <= now).count();
                if ready > 0 {
                    players.queue_inputs(c.id, q.drain(..ready).map(|(_, seq, view, raw)| (seq, view, raw)));
                }
            }
            reg.iter().map(|c| (c.id, c.tx.clone(), c.attach.load(Ordering::Relaxed), c.view.load(Ordering::Relaxed))).collect()
        };
        players.retain(|id| connected.contains(&id));

        // Players move and fight first, then the bots.
        let tick_now = battle.tick + 1;
        players.step(&mut battle, &mut actors, &world, tick_now);
        let targets = players.bot_targets();
        bot_hits.clear();
        battle.step(dt, &targets, &mut bot_hits);
        players.apply_bot_hits(&bot_hits);
        players.step_effects(&mut battle, &mut actors);
        // Monsters move after the players, on the same tick, reading where everyone ended up.
        // Their brains count 60ths of a second, as in the browser, so a tick runs as many of
        // those as it lasts; then their slams land on whoever is standing in them.
        let foes = players.foes();
        let mut done = StepOut::default();
        for _ in 0..monster_steps {
            done.extend(actors.step(&foes, &|_, _| 0.0, LEAN_SPRING, LEAN_DAMPING, 1.0 / 60.0));
        }
        players.apply_slams(&done.slams);
        players.apply_foe_hits(&done.hits);
        players.record_history(battle.tick);
        let t1 = Instant::now();
        grid.rebuild(&battle);
        records.rebuild(&battle);
        players.pack();
        players.pack_actors(&actors);
        let tick = battle.tick;

        // Where each client is looking from: their own fighter, a bot they follow, or a spot they chose.
        let clients: Vec<(u32, Sender<(Instant, Bytes)>, f32, f32, Option<usize>)> = raw_clients
            .into_iter()
            .map(|(id, tx, attach, view)| {
                let slot = players.slot_of(id);
                let (x, z) = if let Some((px, pz)) = slot.and_then(|s| players.position(s)) {
                    (px as f32, pz as f32)
                } else if attach > 0 {
                    let i = (attach as usize - 1) % battle.n;
                    (battle.x[i], battle.z[i])
                } else {
                    unpack_view(view)
                };
                (id, tx, x, z, slot)
            })
            .collect();

        // Once a second: every fighter coarsely, plus server stats. Built once, shared by everyone.
        let mut shared: Vec<Bytes> = Vec::new();
        if tick.is_multiple_of(hz as u64) {
            shared.push(Bytes::from(protocol::far(&battle)));
            if let Some(s) = &last_stats {
                shared.push(s.clone());
            }
        }
        let shared_len: usize = shared.iter().map(|s| s.len()).sum();

        // Each connected player's personal update, built in parallel across CPU cores.
        let real_bytes = AtomicU64::new(0);
        let dropped = AtomicU64::new(0);
        clients.par_iter().for_each_init(
            || (Scratch::default(), Vec::with_capacity(8192), Vec::new()),
            |(scratch, buf, nearby_players), (id, tx, x, z, slot)| {
                let mid = (tick + *id as u64).is_multiple_of(MID_EVERY);
                build_snapshot(&battle, &grid, &records, *x, *z, mid, scratch, buf);
                players.write_sections(buf, *slot, *x as f64, *z as f64, nearby_players);
                let queued = Instant::now();
                let mut sent = 0u64;
                if tx.try_send((queued, Bytes::copy_from_slice(buf))).is_ok() {
                    sent += buf.len() as u64;
                } else {
                    dropped.fetch_add(1, Ordering::Relaxed);
                }
                for s in &shared {
                    if tx.try_send((queued, s.clone())).is_ok() {
                        sent += s.len() as u64;
                    } else {
                        dropped.fetch_add(1, Ordering::Relaxed);
                    }
                }
                real_bytes.fetch_add(sent, Ordering::Relaxed);
            },
        );

        // Virtual players: the same update for each bot as if it were a connected player.
        let virt_bytes = AtomicU64::new(0);
        (0..virtual_clients).into_par_iter().for_each_init(
            || (Scratch::default(), Vec::with_capacity(8192)),
            |(scratch, buf), v| {
                let i = v % battle.n;
                let mid = (tick + v as u64).is_multiple_of(MID_EVERY);
                build_snapshot(&battle, &grid, &records, battle.x[i], battle.z[i], mid, scratch, buf);
                virt_bytes.fetch_add((buf.len() + shared_len) as u64, Ordering::Relaxed);
            },
        );
        let t2 = Instant::now();

        let tick_ms = (t2 - t0).as_secs_f64() * 1000.0;
        window.ticks += 1;
        window.tick_ms += tick_ms;
        window.worst_ms = window.worst_ms.max(tick_ms);
        window.sim_ms += (t1 - t0).as_secs_f64() * 1000.0;
        window.snap_ms += (t2 - t1).as_secs_f64() * 1000.0;
        window.real_bytes += real_bytes.into_inner();
        window.virt_bytes += virt_bytes.into_inner();
        window.dropped += dropped.into_inner();
        window.real_client_ticks += clients.len() as u64;

        let elapsed = window_start.elapsed().as_secs_f64();
        if elapsed >= 1.0 {
            let n = window.ticks as f64;
            let avg_real_clients = window.real_client_ticks as f64 / n;
            let real_avg = if avg_real_clients > 0.0 { window.real_bytes as f64 / elapsed / avg_real_clients } else { 0.0 };
            let virt_avg = if virtual_clients > 0 { window.virt_bytes as f64 / elapsed / virtual_clients as f64 } else { 0.0 };
            let per_player = if virtual_clients > 0 { virt_avg } else { real_avg };
            println!(
                "tick {:>6} | alive {:>5}/{} | players {} real + {} virtual | tick {:.2} ms avg, {:.2} worst (sim {:.2}, updates {:.2}) of {:.0} ms | per player {:.0} KB/s ({:.2} Mbit/s) | real out {:.1} MB/s | dropped {} | playing {} (hits: {} player-on-player, {} on bots, {} bot-on-player; rewind {:.0} ms avg, {} hits saved by it; {} arrows, {} meteors, {} heals)",
                tick,
                battle.alive(),
                battle.n,
                clients.len(),
                virtual_clients,
                window.tick_ms / n,
                window.worst_ms,
                window.sim_ms / n,
                window.snap_ms / n,
                1000.0 / hz as f64,
                per_player / 1024.0,
                per_player * 8.0 / 1e6,
                window.real_bytes as f64 / elapsed / 1e6,
                window.dropped,
                players.count(),
                players.pvp_hits,
                players.hits_on_bots,
                players.bot_hits_on_players,
                players.rewind_ms(),
                players.saved_by_rewind,
                players.arrows_fired,
                players.meteors_landed,
                players.heals
            );
            last_stats = Some(Bytes::from(protocol::stats(&StatsMsg {
                tick,
                bots: battle.n,
                alive: battle.alive(),
                real_clients: clients.len(),
                virtual_clients,
                tick_ms: (window.tick_ms / n) as f32,
                sim_ms: (window.sim_ms / n) as f32,
                snap_ms: (window.snap_ms / n) as f32,
                bytes_per_player_per_s: per_player as f32,
                dropped: window.dropped as u32,
                pvp_hits: players.pvp_hits as u32,
                bot_hits_on_players: players.bot_hits_on_players as u32,
                rewind_ms: players.rewind_ms() as f32,
                saved_by_rewind: players.saved_by_rewind as u32,
                hits_on_bots: players.hits_on_bots as u32,
            })));
            window = Window::default();
            window_start = Instant::now();
        }

        // Wait for the next tick; if we fell behind, carry on from now.
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
            next += period;
        } else {
            next = now + period;
        }
    }
}
