//! The old raid battlefield's layout: the flat ground the golden player scenarios and the balance
//! harness step players on. Same seed, same random sequence, same obstacles.

use crate::jsmath::JsMath;
use crate::rng::Rng;

#[derive(Clone, Copy)]
pub struct Spawn {
    pub x: f64,
    pub z: f64,
    pub facing: f64,
}

pub struct Obstacle {
    pub tree: bool,
    pub x: f64,
    pub z: f64,
    pub r: f64,
}

pub struct World {
    pub radius: f64,
    pub obstacles: Vec<Obstacle>,
    pub team_spawns: [Spawn; 2],
}

pub const SEED: u32 = 1337;

pub fn battlefield(seed: u32) -> World {
    let mut rng = Rng::new(seed + 11);
    let mut obstacles: Vec<Obstacle> = Vec::new();
    let tau = std::f64::consts::TAU;
    let fits = |obs: &Vec<Obstacle>, x: f64, z: f64, r: f64, clearance: f64| {
        obs.iter().all(|o| {
            let (dx, dz) = (o.x - x, o.z - z);
            (dx * dx + dz * dz).sqrt() >= o.r + r + clearance
        })
    };

    let (mut tries, mut trees) = (0, 0);
    while trees < 160 && tries < 6000 {
        tries += 1;
        let angle = rng.next_f64() * tau;
        let dist = 158.0 + (270.0 - 158.0) * rng.next_f64();
        let (x, z) = (angle.js_cos() * dist, angle.js_sin() * dist);
        let scale = 1.0 + (1.7 - 1.0) * rng.next_f64();
        if !fits(&obstacles, x, z, 0.45 * scale, 3.0) {
            continue;
        }
        let _rot = rng.next_f64() * tau;
        obstacles.push(Obstacle { tree: true, x, z, r: 0.45 * scale });
        trees += 1;
    }

    let (mut tries, mut rocks) = (0, 0);
    while rocks < 40 && tries < 4000 {
        tries += 1;
        let angle = rng.next_f64() * tau;
        let dist = 105.0 + (140.0 - 105.0) * rng.next_f64();
        let (x, z) = (angle.js_cos() * dist, angle.js_sin() * dist);
        let scale = 0.6 + (1.6 - 0.6) * rng.next_f64();
        if !fits(&obstacles, x, z, 0.55 * scale, 2.0) {
            continue;
        }
        let _rot = rng.next_f64() * tau;
        obstacles.push(Obstacle { tree: false, x, z, r: 0.55 * scale });
        rocks += 1;
    }

    let half_pi = std::f64::consts::FRAC_PI_2;
    World { radius: 140.0, obstacles, team_spawns: [Spawn { x: -2.5, z: -100.0, facing: half_pi }, Spawn { x: 2.5, z: -100.0, facing: -half_pi }] }
}
