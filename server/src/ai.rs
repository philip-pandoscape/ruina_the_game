//! The behaviour interpreter, reading shared/behaviours.json - the same file src/sim/ai/brain.ts
//! reads. A monster is data: an entry in that file and an actor pointed at it. Nothing in here
//! knows what a slime is.

use std::sync::OnceLock;

use serde::Deserialize;

use crate::actor::Actor;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Gait {
    pub distance: f64,
    pub height: f64,
    pub air_start: f64,
    pub air_span: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BehaviourState {
    pub name: String,
    pub act: String,
    pub frames: [f64; 2],
    #[serde(default)]
    pub gait: Option<Gait>,
    pub next: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Behaviour {
    pub id: String,
    pub sight: f64,
    pub keep_away: f64,
    pub leash: f64,
    pub states: Vec<BehaviourState>,
}

#[derive(Deserialize)]
struct File {
    behaviours: Vec<Behaviour>,
}

static BEHAVIOURS: OnceLock<Vec<Behaviour>> = OnceLock::new();

pub fn behaviours() -> &'static Vec<Behaviour> {
    BEHAVIOURS.get_or_init(|| {
        let raw = include_str!("../../shared/behaviours.json");
        let file: File = serde_json::from_str(raw).expect("shared/behaviours.json is malformed");
        file.behaviours
    })
}

pub fn behaviour(id: &str) -> Option<&'static Behaviour> {
    behaviours().iter().find(|b| b.id == id)
}

/// What a brain can see of the player this frame.
#[derive(Clone, Copy)]
pub struct Sighting {
    pub x: f64,
    pub z: f64,
    pub present: bool,
}

fn len(x: f64, z: f64) -> f64 {
    (x * x + z * z).sqrt()
}

/// The actor's own random stream. Mirrors draw() in brain.ts exactly, including the wrapping.
pub fn draw(a: &mut Actor) -> f64 {
    a.seed = a.seed.wrapping_add(0x6d2b_79f5);
    let mut t = a.seed;
    t = (t ^ (t >> 15)).wrapping_mul(t | 1);
    t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
    ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
}

fn state_index(b: &Behaviour, name: &str) -> usize {
    b.states.iter().position(|s| s.name == name).unwrap_or(0)
}

fn air_at(g: &Gait, t: f64) -> f64 {
    ((t - g.air_start) / g.air_span).clamp(0.0, 1.0)
}

fn enter(a: &mut Actor, b: &Behaviour, index: usize, seen: Sighting) {
    a.state = index;
    a.state_frame = 0;
    let (lo, hi) = (b.states[index].frames[0], b.states[index].frames[1]);
    let roll = draw(a);
    a.wait = (lo + roll * (hi - lo).max(0.0)).floor() as i32;
    if b.states[index].act != "advance" {
        return;
    }

    // Chosen once, on entry, so the actor commits to a direction for the whole move.
    let dx = seen.x - a.x;
    let dz = seen.z - a.z;
    let to_player = len(dx, dz);
    let hx = a.home_x - a.x;
    let hz = a.home_z - a.z;
    let to_home = len(hx, hz);
    if seen.present && to_player < b.sight && to_player > b.keep_away {
        a.move_x = dx / to_player;
        a.move_z = dz / to_player;
    } else if to_home > b.leash {
        a.move_x = hx / to_home;
        a.move_z = hz / to_home;
    } else {
        let angle = draw(a) * std::f64::consts::PI * 2.0;
        a.move_x = angle.sin();
        a.move_z = angle.cos();
    }
    a.facing = a.move_x.atan2(a.move_z);
}

/// Runs one frame of an actor's behaviour.
pub fn step_brain(a: &mut Actor, seen: Sighting) {
    let Some(id) = a.brain.clone() else { return };
    if !a.is_alive() {
        return;
    }
    let Some(b) = behaviour(&id) else { return };
    if a.state >= b.states.len() {
        a.state = 0;
    }
    let s = &b.states[a.state];

    if s.act == "advance" {
        if let Some(g) = &s.gait {
            let wait = a.wait.max(1) as f64;
            let now = air_at(g, (a.state_frame as f64 / wait).min(1.0));
            let before = air_at(g, ((a.state_frame - 1).max(0) as f64 / wait).min(1.0));
            let moved = (now - before) * g.distance;
            a.x += a.move_x * moved;
            a.z += a.move_z * moved;
            a.y = (now * std::f64::consts::PI).sin() * g.height;
        }
    }

    a.state_frame += 1;
    if a.state_frame >= a.wait {
        if s.gait.is_some() {
            a.y = 0.0;
        }
        let next = state_index(b, &s.next);
        enter(a, b, next, seen);
    }
}

/// Puts a freshly spawned or revived actor into the first state of its brain.
pub fn start_brain(a: &mut Actor, seen: Sighting) {
    let Some(id) = a.brain.clone() else { return };
    let Some(b) = behaviour(&id) else { return };
    enter(a, b, 0, seen);
}
