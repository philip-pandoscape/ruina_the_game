//! The open world's check: a scripted list of inputs run through the open-world rules on Emberholm,
//! every frame given back.
//!
//! Script: { spawn: { x, z, facing }, glider: "" or a glider id, pack: 0 or a pack id,
//! steps: [Actions, camelCase], gusts: [frames to use the glider's gust before stepping] }.

use serde::{Deserialize, Serialize};

use crate::open::colliders::ground_at;
use crate::open::traverse::gust;
use crate::open::zone::emberholm;
use crate::open::{OpenWorld, Sim, step_player};
use crate::player::{Actions, Build, Player};
use crate::world::Spawn;

#[derive(Deserialize)]
struct Script {
    spawn: SpawnIn,
    #[serde(default)]
    glider: String,
    #[serde(default)]
    pack: i64,
    steps: Vec<StepIn>,
    #[serde(default)]
    gusts: Vec<usize>,
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
    #[serde(default)]
    stick_x: f64,
    #[serde(default)]
    stick_y: f64,
    #[serde(default)]
    face_x: f64,
    #[serde(default)]
    face_z: f64,
}

// Per frame: x, y, z, vx, vy, vz, facing,
// airspeed, bank, land impact, run phase, hp, then mode (player.rs Mode), grounded, jumps used,
// jump cut done, coyote, jump buffer, flip frame, land frame, takeoff frame, sprinting, crouching,
// crouch frame, mode frame, gust frames, action id, action frame, attack index, attack frame,
// stun, down frame, stamina, MP, stamina delay.
const FRAME_LEN: usize = 35;

#[derive(Serialize)]
struct Out {
    /// Where the player was stood at the start, on the ground at the spawn.
    start: [f64; 3],
    frames: Vec<Vec<f64>>,
}

fn flag(b: bool) -> f64 {
    if b { 1.0 } else { 0.0 }
}

/// Runs a script (JSON) and gives back every frame (JSON).
pub fn run(input: &str) -> serde_json::Result<String> {
    let script: Script = serde_json::from_str(input)?;
    let world = OpenWorld::new(emberholm());
    let spawn = Spawn { x: script.spawn.x, z: script.spawn.z, facing: script.spawn.facing };
    let mut p = Player::new(spawn, 0, Build::default());
    // Stand on the ground there, not inside it (as api.reset() in src/main.ts does).
    let hf = world.terrain();
    p.pos.y = ground_at(hf, &world.index, p.pos.x, p.pos.z, hf.height(p.pos.x, p.pos.z) + 1.2, 1.2);
    p.glider = script.glider.clone();
    p.pack = script.pack;
    let start = [p.pos.x, p.pos.y, p.pos.z];

    let mut frames = Vec::with_capacity(script.steps.len());
    for (i, s) in script.steps.iter().enumerate() {
        if script.gusts.contains(&i) {
            gust(&mut Sim { player: &mut p, world: &world, owner: 0 });
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
            stick_x: s.stick_x,
            stick_y: s.stick_y,
            face_x: s.face_x,
            face_z: s.face_z,
        };
        step_player(&mut p, &a, &world, None, 0);
        let frame = vec![
            p.pos.x,
            p.pos.y,
            p.pos.z,
            p.vel.x,
            p.vel.y,
            p.vel.z,
            p.facing,
            p.airspeed,
            p.bank,
            p.land_impact,
            p.run_phase,
            p.hp,
            p.mode as i32 as f64,
            flag(p.grounded),
            p.jumps_used as f64,
            flag(p.jump_cut_done),
            p.coyote as f64,
            p.jump_buffer as f64,
            p.flip_frame as f64,
            p.land_frame as f64,
            p.takeoff_frame as f64,
            flag(p.sprinting),
            flag(p.crouching),
            p.crouch_frame as f64,
            p.mode_frame as f64,
            p.gust_frames as f64,
            p.action_id as f64,
            p.action_frame as f64,
            p.attack_index as f64,
            p.attack_frame as f64,
            p.stun as f64,
            p.down_frame as f64,
            p.stamina,
            p.mp,
            p.stamina_delay as f64,
        ];
        debug_assert_eq!(frame.len(), FRAME_LEN);
        frames.push(frame);
    }
    serde_json::to_string(&Out { start, frames })
}
