//! Runs a scripted list of inputs through the Rust player rules and prints every frame as JSON,
//! so tests/conformance.spec.ts can check the TypeScript version gives the same results.
//!
//!   simcheck < script.json

use std::io::Read;

use serde::{Deserialize, Serialize};
use yggdrasil_server::player::{Actions, Build, Player};
use yggdrasil_server::world::{battlefield, Spawn, SEED};

#[derive(Deserialize)]
struct Script {
    spawn: SpawnIn,
    team: u8,
    build: BuildIn,
    steps: Vec<StepIn>,
    hits: Vec<HitIn>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildIn {
    perks: u32,
    weapon: u8,
    ability1: u8,
    ability2: u8,
}

#[derive(Deserialize)]
struct SpawnIn {
    x: f64,
    z: f64,
    facing: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StepIn {
    move_x: f64,
    move_z: f64,
    jump_pressed: bool,
    jump_held: bool,
    attack_pressed: bool,
    slide_pressed: bool,
    #[serde(default)]
    ability1_pressed: bool,
    #[serde(default)]
    ability2_pressed: bool,
    #[serde(default)]
    aim_x: f64,
    #[serde(default)]
    aim_z: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HitIn {
    frame: usize,
    damage: f64,
    dir_x: f64,
    dir_z: f64,
    knock: f64,
}

// Per frame: x, y, z, vx, vy, vz, facing, hp, mode (0 normal, 1 slide, 2 attack, 3 cast),
// cast frame, slot 1 cooldown, slot 2 cooldown, cast that finished this frame, cast target x / z
#[derive(Serialize)]
struct Out {
    frames: Vec<[f64; 15]>,
    obstacles: Vec<[f64; 3]>,
}

fn main() {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).expect("read script from stdin");
    let script: Script = serde_json::from_str(&text).expect("valid script JSON");
    let world = battlefield(SEED);
    let spawn = Spawn { x: script.spawn.x, z: script.spawn.z, facing: script.spawn.facing };
    let b = &script.build;
    let build = Build { perks: b.perks, weapon: b.weapon, ability1: b.ability1, ability2: b.ability2 };
    let mut p = Player::new(spawn, script.team, build);
    let mut frames = Vec::with_capacity(script.steps.len());
    for (i, s) in script.steps.iter().enumerate() {
        for h in script.hits.iter().filter(|h| h.frame == i) {
            p.take_hit(h.damage, h.dir_x, h.dir_z, h.knock);
        }
        let a = Actions {
            move_x: s.move_x,
            move_z: s.move_z,
            jump_pressed: s.jump_pressed,
            jump_held: s.jump_held,
            attack_pressed: s.attack_pressed,
            slide_pressed: s.slide_pressed,
            ability1_pressed: s.ability1_pressed,
            ability2_pressed: s.ability2_pressed,
            aim_x: s.aim_x,
            aim_z: s.aim_z,
        };
        p.step(&a, &world);
        frames.push([
            p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, p.facing, p.hp, p.mode as i32 as f64,
            p.cast_frame as f64, p.cooldown1 as f64, p.cooldown2 as f64, p.fired_cast as f64, p.cast_target_x, p.cast_target_z,
        ]);
    }
    let obstacles = world.obstacles.iter().map(|o| [o.x, o.z, o.r]).collect();
    println!("{}", serde_json::to_string(&Out { frames, obstacles }).expect("serialize"));
}
