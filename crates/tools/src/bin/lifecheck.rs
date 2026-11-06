//! Plays a scripted session of the open world through the server's rules (crates/engine/src/open and
//! crates/engine/src/life) and prints the player and the whole island at checkpoints, so
//! tests/conformance/life.test.ts can check the TypeScript gives the same island.
//!
//!   lifecheck < script.json
//!
//! Script: {coins?, labor?, spawn?: {x, z, facing}, island?: a saved island {state, player},
//!          every: frames between checkpoints,
//!          segments: [{frames, a?: Actions (camelCase, any subset), cmds?: [Command], tp?: {x, z, facing?}}]}
//! A segment's teleport happens before its first frame, and its commands are given on that frame.
//! Out: [{frame, player: PlayerState, life: LifeState, events: [LifeEvent]}], one per checkpoint
//! and one after the last frame.

use std::io::Read;

use ruina_engine::life::{Command, Life};
use ruina_engine::open::colliders::ground_at;
use ruina_engine::open::zone::emberholm;
use ruina_engine::open::{OpenWorld, Sim, step_player};
use ruina_engine::player::{Actions, Build, Mode, Player};
use ruina_engine::world::Spawn;
use ruina_server::world_game::{load_island, player_state_json};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct ActionsIn {
    move_x: f64,
    move_z: f64,
    jump_pressed: bool,
    jump_held: bool,
    attack_pressed: bool,
    slide_pressed: bool,
    ability_slot: u8,
    movement_slot: u8,
    movement_held: u8,
    sprint_held: bool,
    crouch_held: bool,
    aim_x: f64,
    aim_z: f64,
    stick_x: f64,
    stick_y: f64,
    #[serde(default)]
    face_x: f64,
    #[serde(default)]
    face_z: f64,
}

#[derive(Deserialize)]
struct Teleport {
    x: f64,
    z: f64,
    facing: Option<f64>,
}

#[derive(Deserialize)]
struct Segment {
    frames: usize,
    #[serde(default)]
    a: ActionsIn,
    #[serde(default)]
    cmds: Vec<Command>,
    tp: Option<Teleport>,
}

#[derive(Deserialize)]
struct SpawnIn {
    x: f64,
    z: f64,
    facing: f64,
}

#[derive(Deserialize)]
struct Script {
    coins: Option<f64>,
    labor: Option<f64>,
    spawn: Option<SpawnIn>,
    island: Option<Value>,
    every: usize,
    segments: Vec<Segment>,
}

fn main() {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).expect("read the script from stdin");
    let script: Script = serde_json::from_str(&raw).expect("stdin is a lifecheck script");
    let zone = emberholm();
    let mut world = OpenWorld::new(zone);
    let mut life = Life::new(zone, script.coins, script.labor);
    let s = script.spawn.map(|s| Spawn { x: s.x, z: s.z, facing: s.facing }).unwrap_or(Spawn {
        x: zone.recipe.spawn.x,
        z: zone.recipe.spawn.z,
        facing: zone.recipe.spawn.facing,
    });
    let mut p = Player::new(s, 0, Build::default());
    // Stand on the ground there, as the browser's api.reset() does.
    let hf = &zone.terrain;
    p.pos.y = ground_at(hf, &world.index, p.pos.x, p.pos.z, hf.height(p.pos.x, p.pos.z) + 1.2, 1.2);
    // A saved island, as the browser kept it: loaded the way the server loads one (no time away).
    if let Some(island) = &script.island {
        load_island(&mut life, &mut p, &mut world, 1, island, 0, 0).expect("the island loads");
    }
    life.after_reset(&mut p);

    let every = script.every.max(1);
    let mut frame = 0usize;
    let mut events: Vec<Value> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    let total: usize = script.segments.iter().map(|s| s.frames).sum();
    for seg in &script.segments {
        if let Some(tp) = &seg.tp {
            teleport(&mut p, &mut world, &mut life, tp);
        }
        let a = Actions {
            move_x: seg.a.move_x,
            move_z: seg.a.move_z,
            jump_pressed: seg.a.jump_pressed,
            jump_held: seg.a.jump_held,
            attack_pressed: seg.a.attack_pressed,
            slide_pressed: seg.a.slide_pressed,
            ability_slot: seg.a.ability_slot,
            movement_slot: seg.a.movement_slot,
            movement_held: seg.a.movement_held,
            sprint_held: seg.a.sprint_held,
            crouch_held: seg.a.crouch_held,
            aim_x: seg.a.aim_x,
            aim_z: seg.a.aim_z,
            stick_x: seg.a.stick_x,
            stick_y: seg.a.stick_y,
            face_x: seg.a.face_x,
            face_z: seg.a.face_z,
        };
        for f in 0..seg.frames {
            if f == 0 {
                for c in &seg.cmds {
                    life.command(c.clone());
                }
            }
            step_player(&mut p, &a, &mut world, Some(&mut life), 1);
            for e in life.drain_events() {
                events.push(serde_json::to_value(e).unwrap());
            }
            frame += 1;
            if frame.is_multiple_of(every) || frame == total {
                out.push(json!({ "frame": frame, "player": player_state_json(&p), "life": life.state, "events": std::mem::take(&mut events) }));
            }
        }
    }
    println!("{}", serde_json::to_string(&out).unwrap());
}

/// The developer panel's teleport, as src/main.ts does it offline: off whatever you were riding,
/// onto the ground there.
fn teleport(p: &mut Player, world: &mut OpenWorld, life: &mut Life, tp: &Teleport) {
    if p.mode == Mode::Ride {
        let mut sim = Sim { player: p, world, owner: 1 };
        ruina_engine::life::vehicles::dismount(life, &mut sim);
    }
    let hf = world.terrain();
    let y = ground_at(hf, &world.index, tp.x, tp.z, hf.height(tp.x, tp.z) + 1.2, 1.2);
    p.pos.x = tp.x;
    p.pos.y = y;
    p.pos.z = tp.z;
    p.vel = Default::default();
    if let Some(f) = tp.facing {
        p.facing = f;
    }
    if p.mode == Mode::Glide || p.mode == Mode::Swim {
        p.mode = Mode::Normal;
    }
    p.grounded = true;
}
