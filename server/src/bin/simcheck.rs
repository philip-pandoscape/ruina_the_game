//! Runs a scripted list of inputs through the Rust player rules and prints every frame as JSON,
//! so tests/conformance.spec.ts can check the TypeScript version gives the same results.
//!
//!   simcheck < script.json

use std::io::Read;

use serde::{Deserialize, Serialize};
use yggdrasil_server::player::{Actions, Build, Player};
use yggdrasil_server::skills::{resolve_skills, EMPTY_SKILLS, SKILL_WORDS};
use yggdrasil_server::tuning::{cast_frames_for, combo_for, HOTBAR_SLOTS, melee_targets, MOVEMENT_SKILL_CAP, MOVEMENT_SLOTS, NO_ABILITY, NO_MOVEMENT, pierce_targets, tuning};
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
    skills: Vec<u32>, // the learned set, one bit per node, low words first
    weapon: u8,
    abilities: Vec<u8>, // one per hotbar slot
    #[serde(default)]
    movement: Vec<u8>, // one per movement slot
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
    ability_slot: u8,
    #[serde(default)]
    movement_slot: u8,
    #[serde(default)]
    movement_held: u8,
    #[serde(default)]
    sprint_held: bool,
    #[serde(default)]
    crouch_held: bool,
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
// cast frame, cast that finished this frame, cast target x / z, sprinting, crouching, crouch
// frame, then one cooldown per hotbar slot.
const FRAME_LEN: usize = 18 + HOTBAR_SLOTS + MOVEMENT_SKILL_CAP;

#[derive(Serialize)]
struct Out {
    frames: Vec<Vec<f64>>,
    obstacles: Vec<[f64; 3]>,
    stats: Stats,
}

/// What the skill tree resolved to for this build. Compared against the browser's own answer, so
/// a modifier folded in a different order on one side shows up as a number, not as a desync
/// hours later.
#[derive(Serialize)]
struct Stats {
    melee_targets: Vec<usize>,
    pierce_targets: Vec<usize>,
    cast_frames: Vec<i32>,
    combo_startup: Vec<Vec<i32>>,
    combo_damage: Vec<Vec<f64>>,
}

fn main() {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).expect("read script from stdin");
    let script: Script = serde_json::from_str(&text).expect("valid script JSON");
    let world = battlefield(SEED);
    let spawn = Spawn { x: script.spawn.x, z: script.spawn.z, facing: script.spawn.facing };
    let b = &script.build;
    let mut abilities = [NO_ABILITY; HOTBAR_SLOTS];
    for (i, &a) in b.abilities.iter().take(HOTBAR_SLOTS).enumerate() {
        abilities[i] = a;
    }
    let mut skills = EMPTY_SKILLS;
    for (i, &w) in b.skills.iter().take(SKILL_WORDS).enumerate() {
        skills[i] = w;
    }
    let mut movement = [NO_MOVEMENT; MOVEMENT_SLOTS];
    for (i, &m) in b.movement.iter().take(MOVEMENT_SLOTS).enumerate() {
        movement[i] = m;
    }
    let build = Build { skills, weapon: b.weapon, abilities, movement };
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
            ability_slot: s.ability_slot,
            movement_slot: s.movement_slot,
            movement_held: s.movement_held,
            sprint_held: s.sprint_held,
            crouch_held: s.crouch_held,
            aim_x: s.aim_x,
            aim_z: s.aim_z,
        };
        p.step(&a, &world);
        let mut frame = Vec::with_capacity(FRAME_LEN);
        frame.extend_from_slice(&[
            p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, p.facing, p.hp, p.mode as i32 as f64,
            p.cast_frame as f64, p.fired_ability as f64, p.cast_target_x, p.cast_target_z,
            p.sprinting as i32 as f64, p.crouching as i32 as f64, p.crouch_frame as f64,
            p.action_id as f64, p.action_frame as f64,
        ]);
        frame.extend(p.cooldowns.iter().map(|&c| c as f64));
        frame.extend((0..MOVEMENT_SKILL_CAP).map(|i| p.movement_cooldowns.get(i).copied().unwrap_or(0) as f64));
        debug_assert_eq!(frame.len(), FRAME_LEN);
        frames.push(frame);
    }
    let obstacles = world.obstacles.iter().map(|o| [o.x, o.z, o.r]).collect();
    let r = resolve_skills(&build.skills);
    let weapons = tuning().weapons.len();
    let stats = Stats {
        melee_targets: (0..weapons).map(|w| melee_targets(w as u8, &r)).collect(),
        pierce_targets: (0..weapons).map(|w| pierce_targets(w as u8, &r)).collect(),
        cast_frames: (0..tuning().abilities.len()).map(|a| cast_frames_for(a as u8, &r)).collect(),
        combo_startup: (0..weapons).map(|w| combo_for(w as u8, &r).iter().map(|s| s.startup).collect()).collect(),
        combo_damage: (0..weapons).map(|w| combo_for(w as u8, &r).iter().map(|s| s.damage).collect()).collect(),
    };
    println!("{}", serde_json::to_string(&Out { frames, obstacles, stats }).expect("serialize"));
}
