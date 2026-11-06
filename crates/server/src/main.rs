//! The game server. On one port (crates/server/src/http.rs):
//!   - accounts and the open world, Emberholm, kept in Postgres (when DATABASE_URL is set)
//!   - the PvP battlefield: thousands of fighters simulated at a fixed tick rate, each connected
//!     player streamed a personal update (unless started with --battle off)
//!   - the game's built files (with --static or STATIC_DIR; in development Vite serves them)
//!
//!   cargo run --release -- --bots 10000 --virtual-clients 10000 --port 7777 --hz 20
//!
//! --virtual-clients N builds a personal update for N bots every tick as if they were connected
//! players, without sending it anywhere. That measures the server cost of a full raid.
//!
//! It listens on this machine only (so Windows' firewall never asks about it) unless started with
//! --listen all or LISTEN=all, as the Docker image is for Railway and `npm run up`.
//!
//! Environment: PORT (Railway sets it; --port wins), LISTEN (all | local), DATABASE_URL, STATIC_DIR,
//! ADMIN_USERS (the accounts, by name, comma-separated, that reach the developer pages and commands),
//! DEV_LOGIN=1 (sign in by name alone, and everyone an admin unless ADMIN_USERS names some: for
//! development; ignored on Railway),
//! COOKIE_SECURE=1 (https without Railway).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use rayon::prelude::*;
use ruina_server::actors::{Actors, LEAN_DAMPING, LEAN_SPRING, StepOut};
use ruina_server::game::Players;
use ruina_server::http::{self, AppState};
use ruina_server::interest::{InterestGrid, MID_EVERY, Records, Scratch, build_snapshot};
use ruina_server::net::{Registry, unpack_view};
use ruina_server::protocol::{self, StatsMsg};
use ruina_server::sim::{Battle, BotHit, FIELD};
use ruina_server::{db, world_socket};
use tokio::sync::mpsc::Sender;

use ruina_server::world::{SEED, battlefield};

struct Args {
    /// Run the battlefield at all (--battle off for a server that only hosts the open world).
    battle: bool,
    /// Fighters on the battlefield (at least 2).
    bots: usize,
    virtual_clients: usize,
    port: u16,
    /// Take connections at every address (`--listen all`), not only from this machine.
    everywhere: bool,
    hz: u32,
    /// Monsters to scatter around the players' end of the field. Off unless asked for:
    /// putting them in by default would change every world anybody already runs.
    slimes: usize,
    /// The built game (dist/) to serve, if any.
    static_dir: Option<PathBuf>,
}

fn parse_args() -> Args {
    let env_port = std::env::var("PORT").ok().and_then(|p| p.parse().ok());
    let static_dir = std::env::var_os("STATIC_DIR").filter(|d| !d.is_empty()).map(PathBuf::from);
    let everywhere = std::env::var("LISTEN").is_ok_and(|v| v == "all");
    let mut a = Args { battle: true, bots: 10_000, virtual_clients: 0, port: env_port.unwrap_or(7777), everywhere, hz: 20, slimes: 0, static_dir };
    let argv: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i + 1 < argv.len() {
        let v = &argv[i + 1];
        match argv[i].as_str() {
            "--battle" => a.battle = v != "off",
            "--bots" => a.bots = v.parse().expect("--bots needs a number"),
            "--virtual-clients" => a.virtual_clients = v.parse().expect("--virtual-clients needs a number"),
            "--port" => a.port = v.parse().expect("--port needs a number"),
            "--listen" => {
                a.everywhere = match v.as_str() {
                    "all" => true,
                    "local" => false,
                    _ => panic!("--listen takes all or local"),
                }
            }
            "--hz" => a.hz = v.parse().expect("--hz needs a number"),
            "--slimes" => a.slimes = v.parse().expect("--slimes needs a number"),
            "--static" => a.static_dir = Some(PathBuf::from(v)),
            other => panic!("unknown argument {other}"),
        }
        i += 2;
    }
    a.bots = a.bots.clamp(2, 65_535);
    a.hz = a.hz.clamp(1, 60);
    a
}

fn main() {
    let args = parse_args();
    let on_railway = std::env::var_os("RAILWAY_PROJECT_ID").is_some();
    let dev_login = std::env::var("DEV_LOGIN").is_ok_and(|v| v == "1") && !on_railway;
    let secure_cookies = on_railway || std::env::var("COOKIE_SECURE").is_ok_and(|v| v == "1");
    let admin_users = http::admin_users(&std::env::var("ADMIN_USERS").unwrap_or_default());
    if dev_login && admin_users.is_empty() {
        println!("admins: everyone (developer sign-in is on and ADMIN_USERS names nobody)");
    } else if admin_users.is_empty() {
        println!("admins: none (ADMIN_USERS is not set)");
    } else {
        let mut names: Vec<&String> = admin_users.iter().collect();
        names.sort();
        println!("admins: {}", names.iter().map(|n| n.as_str()).collect::<Vec<_>>().join(", "));
    }

    let battle = if args.battle {
        let registry: Registry = Arc::new(Mutex::new(Vec::new()));
        let welcome = Bytes::from(protocol::welcome(args.bots, args.hz, FIELD));
        println!(
            "battlefield: bots {} | slimes {} | virtual players {} | {} ticks/s | {} CPU threads",
            args.bots,
            args.slimes,
            args.virtual_clients,
            args.hz,
            rayon::current_num_threads()
        );
        let sim_registry = registry.clone();
        let (bots, virt, hz, slimes) = (args.bots, args.virtual_clients, args.hz, args.slimes);
        std::thread::Builder::new().name("sim".into()).spawn(move || run(bots, virt, hz, slimes, sim_registry)).expect("start sim thread");
        Some(http::Battle { registry, welcome })
    } else {
        println!("battlefield: off (--battle off)");
        None
    };

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("start tokio");
    let result = rt.block_on(async move {
        let db = match std::env::var("DATABASE_URL") {
            Ok(url) if !url.is_empty() => {
                let pool = db::connect(&url).await.map_err(std::io::Error::other)?;
                db::spawn_housekeeping(pool.clone());
                println!("database: connected{}", if dev_login { " | developer sign-in on (?as=name)" } else { "" });
                Some(pool)
            }
            _ => {
                println!("database: none (DATABASE_URL is not set), so accounts and the open world are off");
                None
            }
        };
        let state =
            AppState { db, battle, world: world_socket::Hub::default(), dev_login, admin_users, secure_cookies, failed_logins: Mutex::new(HashMap::new()) };
        http::serve(args.port, args.everywhere, state, args.static_dir).await
    });
    if let Err(e) = result {
        eprintln!("server error: {e}");
        std::process::exit(1);
    }
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
