//! Runs a behaviour through the Rust interpreter and prints every frame as JSON, so
//! tests/ai-conformance.spec.ts can check the TypeScript version agrees.
//!
//!   aicheck < scenario.json

use std::io::Read;

use serde::{Deserialize, Serialize};
use yggdrasil_server::actor::Actor;
use yggdrasil_server::ai::{start_brain, step_brain, Sighting};

#[derive(Deserialize)]
struct Scenario {
    brain: String,
    seed: u32,
    x: f64,
    z: f64,
    frames: usize,
    /// Whether a player is in the world at all; a brain with nobody to notice just wanders.
    #[serde(default)]
    player: bool,
}

#[derive(Serialize)]
struct Out {
    frames: Vec<[f64; 9]>,
}

/// A path both sides can work out for themselves, so the scenario stays small.
fn player_at(f: usize) -> (f64, f64) {
    let t = f as f64;
    ((t / 90.0).sin() * 4.0, (t / 70.0).cos() * 4.0 - 1.0)
}

fn main() {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).unwrap();
    let s: Scenario = serde_json::from_str(&raw).unwrap();

    let mut a = Actor::new(1, "test", s.x, s.z, s.seed);
    a.brain = Some(s.brain.clone());
    let seen0 = {
        let (px, pz) = player_at(0);
        Sighting { x: px, z: pz, present: s.player }
    };
    start_brain(&mut a, seen0);

    let mut frames = Vec::with_capacity(s.frames);
    for f in 0..s.frames {
        let (px, pz) = player_at(f);
        step_brain(&mut a, Sighting { x: px, z: pz, present: s.player });
        frames.push([
            a.x,
            a.y,
            a.z,
            a.facing,
            a.state as f64,
            a.state_frame as f64,
            a.wait as f64,
            a.move_x,
            a.move_z,
        ]);
    }
    println!("{}", serde_json::to_string(&Out { frames }).unwrap());
}
