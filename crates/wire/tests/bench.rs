//! Measurements, run by hand: what an update costs on the wire against today's JSON, for crowds of
//! players and creatures, and how long packing and writing take.
//!
//!   cargo test --release -p ruina-wire --test bench -- --ignored --nocapture
//!
//! The players are the engine's own, moved about by a script rather than the rules (the rules' cost
//! is the server's tick-time bench): running in circles, swinging now and then, hurt now and then,
//! as the battlefield's bots do. The JSON is today's, as crates/server/src/play/mod.rs writes it
//! (presence_json for everyone in the game, actors_json for the creatures within 70 m), field for
//! field. The update goes to a player in the middle of the crowd, its acknowledgements coming back
//! four ticks later (a 200 ms round trip).

mod common;

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Instant;

use ruina_engine::actors::Actors;
use ruina_engine::player::{Build, Mode, Player};
use ruina_engine::world::Spawn;
use ruina_wire::heard::Heard;
use ruina_wire::pack::{self, key};
use ruina_wire::record::Frame;
use ruina_wire::schema::Kind;
use ruina_wire::viewer::{View, Viewer};
use serde_json::{Value, json};

struct Crowd {
    players: Vec<(i64, Arc<str>, Player)>,
    actors: Actors,
    tick: u64,
}

impl Crowd {
    /// `n` players and `m` creatures over a square `size` metres across.
    fn new(n: usize, m: usize, size: f64) -> Crowd {
        let mut rng = common::Rng(0x5eed);
        let mut players = Vec::new();
        for i in 0..n {
            let (x, z) = ((rng.unit() - 0.5) * size, (rng.unit() - 0.5) * size);
            let mut p = Player::new(Spawn { x, z, facing: rng.unit() * std::f64::consts::TAU }, (i % 2) as u8, Build::default());
            p.pos.y = 2.0 + rng.unit();
            let id = 1 + i as i64;
            players.push((id, Arc::from(format!("Skirmisher {id}").as_str()), p));
        }
        let mut actors = Actors::new();
        for i in 0..m {
            let (x, z) = ((rng.unit() - 0.5) * size, (rng.unit() - 0.5) * size);
            actors.spawn(if i % 3 == 0 { "goblin" } else { "slime" }, x, z, 7 + i as u32);
        }
        Crowd { players, actors, tick: 529_000_000 }
    }

    /// Player 0 at the middle, and groups of players and of creatures each spread over a ring
    /// (count, from metres, to metres) round it.
    fn rings(players: &[(usize, f64, f64)], creatures: &[(usize, f64, f64)]) -> Crowd {
        let mut rng = common::Rng(0x1ce);
        let mut spot = |from: f64, to: f64| {
            let a = rng.unit() * std::f64::consts::TAU;
            let r = from + (to - from) * rng.unit().sqrt();
            (a.cos() * r, a.sin() * r)
        };
        let mut list = vec![(1, Arc::<str>::from("Watcher"), Player::new(Spawn { x: 0.0, z: 0.0, facing: 0.0 }, 0, Build::default()))];
        for &(n, from, to) in players {
            for _ in 0..n {
                let (x, z) = spot(from, to);
                let id = 1 + list.len() as i64;
                list.push((id, Arc::from(format!("Wanderer {id}").as_str()), Player::new(Spawn { x, z, facing: 0.0 }, (id % 2) as u8, Build::default())));
            }
        }
        let mut actors = Actors::new();
        for &(n, from, to) in creatures {
            for i in 0..n {
                let (x, z) = spot(from, to);
                actors.spawn(if i % 3 == 0 { "goblin" } else { "slime" }, x, z, 7 + i as u32);
            }
        }
        Crowd { players: list, actors, tick: 529_000_000 }
    }

    /// A tick of scripted play: everyone runs a circle, a few swing, a few are hurt.
    fn step(&mut self) {
        self.tick += 1;
        let t = self.tick as f64 * 0.05;
        for (k, (_, _, p)) in self.players.iter_mut().enumerate() {
            let a = t * 0.6 + k as f64;
            let (vx, vz) = (a.cos() * 5.0, a.sin() * 5.0);
            p.vel.x = vx;
            p.vel.z = vz;
            p.pos.x += vx * 0.05;
            p.pos.z += vz * 0.05;
            p.facing = vx.atan2(vz);
            p.run_phase += 5.0 * 0.05;
            if p.mode == Mode::Attack {
                p.attack_frame += 3;
                if p.attack_frame > 30 {
                    p.mode = Mode::Normal;
                    p.attack_index = (p.attack_index + 1) % 3;
                }
            } else if (self.tick + k as u64).is_multiple_of(53) {
                p.mode = Mode::Attack;
                p.attack_frame = 0;
            }
            if (self.tick + 3 * k as u64).is_multiple_of(97) {
                p.hp = (p.hp - 7.5).max(1.0);
            }
        }
        for (k, a) in self.actors.list.iter_mut().enumerate() {
            let ang = t * 0.3 + k as f64;
            a.x += ang.cos() * 0.08;
            a.z += ang.sin() * 0.08;
            a.facing = ang;
            a.state_frame += 3;
            if a.state_frame >= a.wait.max(1) {
                a.state_frame = 0;
                a.wait = 40 + (k as i32 % 30);
                a.state = (a.state + 1) % 3;
            }
        }
    }

    fn frame(&self) -> Frame {
        let mut f = Frame::new(self.tick);
        for (id, name, p) in &self.players {
            f.push(pack::player(key(Kind::Player, *id), *id, name.clone(), *id > 0, p, None, 0));
        }
        for a in &self.actors.list {
            if let Some(r) = pack::creature(key(Kind::Creature, i64::from(a.id)), a) {
                f.push(r);
            }
        }
        f
    }

    /// Today's tick message for player 0, less its own state: everyone else's presence and the
    /// creatures within 70 m (the nearest 48).
    fn json(&self) -> String {
        let fr = self.tick * 3;
        let me = &self.players[0].2;
        let peers: Vec<Value> = self.players[1..].iter().map(|(id, name, p)| json!({ "id": id, "name": &**name, "p": presence(p, fr) })).collect();
        let mut near: Vec<(f64, usize)> = self
            .actors
            .list
            .iter()
            .enumerate()
            .filter_map(|(i, a)| {
                let d2 = (a.x - me.pos.x).powi(2) + (a.z - me.pos.z).powi(2);
                (d2 <= 70.0 * 70.0).then_some((d2, i))
            })
            .collect();
        near.sort_by(|a, b| a.0.total_cmp(&b.0));
        near.truncate(48);
        let actors: Vec<Value> = near
            .into_iter()
            .map(|(_, i)| {
                let a = &self.actors.list[i];
                let progress = if a.wait > 0 { (f64::from(a.state_frame) / f64::from(a.wait)).clamp(0.0, 1.0) } else { 0.0 };
                json!({ "id": a.id, "kind": a.kind_index, "x": a.x, "y": a.y, "z": a.z, "facing": a.facing, "state": a.state, "progress": progress,
                        "hp": if a.max_hp > 0.0 { a.hp / a.max_hp } else { 0.0 }, "deadFrame": a.dead_frame, "targetX": a.target_x, "targetZ": a.target_z })
            })
            .collect();
        json!({ "t": "tick", "tick": self.tick, "peers": peers, "actors": actors, "arrows": [], "meteors": [], "events": [] }).to_string()
    }
}

/// crates/server/src/play/mod.rs presence_json, field for field (a bot's life has no vehicles or packs).
fn presence(p: &Player, fr: u64) -> Value {
    let mode = ["normal", "attack", "cast", "action", "swim", "glide", "ride"][p.mode as usize];
    json!({
        "fr": fr, "pos": { "x": p.pos.x, "y": p.pos.y, "z": p.pos.z }, "vel": { "x": p.vel.x, "y": p.vel.y, "z": p.vel.z },
        "facing": p.facing, "mode": mode, "grounded": p.grounded, "attackIndex": p.attack_index, "attackFrame": p.attack_frame,
        "flipFrame": p.flip_frame, "landFrame": p.land_frame, "landImpact": p.land_impact, "takeoffFrame": p.takeoff_frame,
        "runPhase": p.run_phase, "stun": p.stun, "downFrame": p.down_frame, "team": p.team, "weapon": p.weapon,
        "comboVariants": p.resolved.combo_variant_bits, "actionId": p.action_id, "actionFrame": p.action_frame,
        "castAbility": p.cast_ability, "castFrame": p.cast_frame, "bank": p.bank, "pack": p.pack, "vehicle": p.vehicle,
        "seat": p.seat, "host": p.host, "glider": p.glider, "airspeed": p.airspeed, "sprinting": p.sprinting,
        "crouching": p.crouching, "crouchFrame": p.crouch_frame, "hp": p.hp, "vehicles": [], "packs": [],
    })
}

struct Row {
    json: f64,
    wire: f64,
    first: usize,
    pack_us: f64,
    write_us: f64,
    json_us: f64,
    in_sight: usize,
}

/// Plays `ticks` ticks of a crowd, measuring the last `measured`.
fn measure(n: usize, m: usize, size: f64, ticks: usize, measured: usize) -> Row {
    measure_crowd(Crowd::new(n, m, size), ticks, measured)
}

fn measure_crowd(mut crowd: Crowd, ticks: usize, measured: usize) -> Row {
    let me = key(Kind::Player, crowd.players[0].0);
    let mut viewer = Viewer::new(me);
    let mut heard = Heard::new();
    let mut acks = VecDeque::new();
    let (mut json_bytes, mut wire_bytes, mut first) = (0usize, 0usize, 0usize);
    let (mut pack_s, mut write_s, mut json_s) = (0.0, 0.0, 0.0);
    for t in 0..ticks {
        crowd.step();
        let started = Instant::now();
        let frame = crowd.frame();
        let packed = Instant::now();
        let p = &crowd.players[0].2;
        let bytes = viewer.update(&frame, View { x: p.pos.x, z: p.pos.z }, &[]);
        let written = Instant::now();
        let text = crowd.json();
        let jsoned = Instant::now();
        heard.hear(&bytes).expect("reads").expect("applies");
        acks.push_back(heard.ack());
        if acks.len() > 4 {
            viewer.ack(&acks.pop_front().expect("one"));
        }
        if t == 0 {
            first = bytes.len();
        }
        if t >= ticks - measured {
            json_bytes += text.len();
            wire_bytes += bytes.len();
            pack_s += (packed - started).as_secs_f64();
            write_s += (written - packed).as_secs_f64();
            json_s += (jsoned - written).as_secs_f64();
        }
    }
    assert_eq!(heard.errors, 0);
    let k = measured as f64;
    Row {
        json: json_bytes as f64 / k,
        wire: wire_bytes as f64 / k,
        first,
        pack_us: pack_s / k * 1e6,
        write_us: write_s / k * 1e6,
        json_us: json_s / k * 1e6,
        in_sight: heard.ents.len(),
    }
}

#[test]
#[ignore = "a measurement, run by hand: cargo test --release -p ruina-wire --test bench -- --ignored --nocapture"]
fn bytes_and_time_per_update() {
    println!();
    println!(
        "{:>7} {:>9} {:>6} | {:>10} {:>10} {:>6} {:>9} | {:>8} {:>9} {:>9} | {:>8}",
        "players", "creatures", "metres", "JSON B/upd", "wire B/upd", "ratio", "first B", "pack µs", "write µs", "JSON µs", "in sight"
    );
    for (n, m, size) in [(33, 8, 80.0), (65, 8, 80.0), (257, 32, 120.0), (1025, 128, 300.0), (4097, 512, 600.0)] {
        let r = measure(n, m, size, 200, 100);
        println!(
            "{n:>7} {m:>9} {size:>6.0} | {:>10.0} {:>10.0} {:>5.1}x {:>9} | {:>8.0} {:>9.1} {:>9.0} | {:>8}",
            r.json,
            r.wire,
            r.json / r.wire,
            r.first,
            r.pack_us,
            r.write_us,
            r.json_us,
            r.in_sight
        );
    }
    println!("JSON: everyone else's presence and the creatures within 70 m, as today (each client's own state, the same either way, left out).");
    println!("pack: the sim's Frame for the tick, once. write: one connection's update. JSON: one connection's tick message.");
}

#[test]
#[ignore = "a measurement, run by hand: cargo test --release -p ruina-wire --test bench -- --ignored --nocapture"]
fn what_one_gate_core_carries() {
    // The research's three places (.plans/world/research.md 4.2): who is near, at the middle
    // distance and far from someone standing there.
    let places: [(&str, Crowd); 3] = [
        (
            "wilderness: 10 players and 20 creatures near, 20 at the middle distance, 30 far",
            Crowd::rings(&[(10, 2.0, 40.0), (10, 40.0, 120.0), (20, 120.0, 250.0)], &[(20, 2.0, 40.0), (10, 40.0, 120.0), (10, 120.0, 250.0)]),
        ),
        (
            "a busy town: 80 near, 300 at the middle distance, 600 far",
            Crowd::rings(&[(70, 2.0, 40.0), (280, 40.0, 120.0), (580, 120.0, 250.0)], &[(10, 2.0, 40.0), (20, 40.0, 120.0), (20, 120.0, 250.0)]),
        ),
        ("a world boss: 500 players within 50 m", Crowd::rings(&[(500, 2.0, 50.0)], &[(1, 5.0, 10.0)])),
    ];
    println!();
    println!("{:<82} | {:>9} {:>8} {:>9} | {:>12}", "where", "B/update", "KB/s", "write µs", "clients/core");
    for (label, crowd) in places {
        let r = measure_crowd(crowd, 300, 200);
        println!("{label:<82} | {:>9.0} {:>8.1} {:>9.1} | {:>12.0}", r.wire, r.wire * 20.0 / 1024.0, r.write_us, 50_000.0 / r.write_us);
    }
    println!("clients/core: one core writing every client's update 20 times a second (50 ms a tick, nothing else).");
}
