//! Runs behaviours through the Rust rules and prints every frame as JSON, so
//! tests/ai-conformance.spec.ts can check the TypeScript version agrees.
//!
//!   aicheck < scenario.json
//!
//! Two kinds of scenario. One brain on its own: `brain`, `seed`, `x`, `z`, `frames`, `player`.
//! A whole pack (`pack` is present): real kinds from shared/actors.json stepped together, with
//! hits landing on whoever stands nearest a point at given frames, so calling, gathering,
//! bursting and reforming all run as they do in a fight.

use std::io::Read;

use serde::{Deserialize, Serialize};
use yggdrasil_server::actor::Actor;
use yggdrasil_server::actors::Actors;
use yggdrasil_server::ai::{start_brain, step_brain, Sighting};

#[derive(Deserialize)]
struct Spawn {
    kind: String,
    x: f64,
    z: f64,
    seed: u32,
}

#[derive(Deserialize)]
struct Hit {
    frame: usize,
    x: f64,
    z: f64,
    damage: f64,
}

#[derive(Deserialize)]
struct Scenario {
    #[serde(default)]
    brain: String,
    #[serde(default)]
    seed: u32,
    #[serde(default)]
    x: f64,
    #[serde(default)]
    z: f64,
    frames: usize,
    /// Whether a player is in the world at all; a brain with nobody to notice just wanders.
    #[serde(default)]
    player: bool,
    #[serde(default)]
    pack: Option<Vec<Spawn>>,
    #[serde(default)]
    hits: Vec<Hit>,
}

#[derive(Serialize)]
struct Out {
    frames: Vec<[f64; 9]>,
}

#[derive(Serialize)]
struct PackOut {
    /// Per frame, per actor: see `row`.
    frames: Vec<Vec<[f64; 20]>>,
    /// Per frame, the slams that landed: [x, z, radius, damage].
    slams: Vec<Vec<[f64; 4]>>,
}

/// A path both sides can work out for themselves, so the scenario stays small.
fn player_at(f: usize) -> (f64, f64) {
    let t = f as f64;
    ((t / 90.0).sin() * 4.0, (t / 70.0).cos() * 4.0 - 1.0)
}

fn row(a: &Actor) -> [f64; 20] {
    [
        a.id as f64,
        a.kind_index as f64,
        a.x,
        a.y,
        a.z,
        a.facing,
        a.state as f64,
        a.state_frame as f64,
        a.wait as f64,
        a.hp,
        a.mass,
        a.dead_frame as f64,
        a.angry as f64,
        a.rally_to as f64,
        a.calling as f64,
        a.fuse as f64,
        a.group as f64,
        if a.gone { 1.0 } else { 0.0 },
        a.pulled as f64,
        a.stride,
    ]
}

fn run_pack(s: &Scenario, spawns: &[Spawn]) -> PackOut {
    let mut actors = Actors::new();
    for p in spawns {
        actors.spawn(&p.kind, p.x, p.z, p.seed);
    }
    let mut out = PackOut { frames: Vec::with_capacity(s.frames), slams: Vec::with_capacity(s.frames) };
    for f in 0..s.frames {
        let (px, pz) = player_at(f);
        for h in s.hits.iter().filter(|h| h.frame == f) {
            // Whoever is standing nearest the point takes it, struck from where the player is.
            let mut best: Option<(f64, u32, f64, f64)> = None;
            for a in actors.list.iter().filter(|a| a.is_alive() && !a.gone) {
                let (hx, hz) = (a.x - h.x, a.z - h.z);
                let d = (hx * hx + hz * hz).sqrt();
                if best.is_none_or(|(bd, ..)| d < bd) {
                    best = Some((d, a.id, a.x, a.z));
                }
            }
            if let Some((_, id, ax, az)) = best {
                let (dx, dz) = (ax - px, az - pz);
                let d = (dx * dx + dz * dz).sqrt().max(1e-6);
                actors.damage(id, h.damage, dx / d, dz / d, 0.0);
            }
        }
        let slams = actors.step(&[(px, pz)], 140.0, 7.0, 1.0 / 60.0);
        out.frames.push(actors.list.iter().map(row).collect());
        out.slams.push(slams.iter().map(|s| [s.x, s.z, s.radius, s.damage]).collect());
    }
    out
}

fn main() {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).unwrap();
    let s: Scenario = serde_json::from_str(&raw).unwrap();

    if let Some(spawns) = &s.pack {
        println!("{}", serde_json::to_string(&run_pack(&s, spawns)).unwrap());
        return;
    }

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
