//! The worlds the browser plays offline: the training yard (its props, trees and rocks, the dummy
//! and the slimes) and who stands about the island when it's played without the server. Same seed,
//! same layout, to the bit (the browser's session, crate::session, plays them).

use serde::{Deserialize, Serialize};

use crate::jsmath::{JsMath, js_hypot};
use crate::open::zone::Recipe;
use crate::rng::Rng;
use crate::world::{Obstacle, Spawn, World};

/// The yard's seed and the invisible wall around it (WORLD in src/content/tuning.ts).
pub const YARD_SEED: u32 = 1337;
pub const YARD_RADIUS: f64 = 32.0;
/// How many slimes hop about the yard (SLIME.count in src/content/tuning.ts).
pub const YARD_SLIMES: usize = 5;

/// Something standing in a world when it is built (src/engine/shapes.ts ActorSpawnPoint).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SpawnPoint {
    pub kind: String,
    pub x: f64,
    pub z: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facing: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<u32>,
    /// Spawn points with the same band number fight together as one war-band (0 for none).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub band: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// One prop of a flat world as it is drawn and bumped into (src/engine/shapes.ts Obstacle).
#[derive(Clone, Debug, Serialize)]
pub struct Prop {
    pub kind: &'static str,
    pub x: f64,
    pub z: f64,
    pub r: f64,
    pub scale: f64,
    pub rot: f64,
}

/// A flat world: the yard (or the battlefield), as the browser draws it and the rules play it.
pub struct Yard {
    pub seed: u32,
    pub radius: f64,
    pub props: Vec<Prop>,
    pub dummy: (f64, f64),
    pub spawn: Spawn,
    pub spawns: Vec<SpawnPoint>,
}

impl Yard {
    /// The world the rules step a player in: its props as circles to bump into.
    pub fn world(&self) -> World {
        let obstacles = self.props.iter().map(|p| Obstacle { tree: p.kind == "tree", x: p.x, z: p.z, r: p.r }).collect();
        World { radius: self.radius, obstacles, team_spawns: [self.spawn, self.spawn] }
    }
}

/// `count` of a kind in a ring round (x, z), facing out, as spawn points that share `band`
///.
pub fn band_around(kind: &str, count: usize, x: f64, z: f64, band: u32, seed: u32) -> Vec<SpawnPoint> {
    (0..count)
        .map(|i| {
            let angle = (i as f64 / count as f64) * std::f64::consts::PI * 2.0;
            let r = if count > 1 { 1.2 + 0.4 * (i % 2) as f64 } else { 0.0 };
            SpawnPoint {
                kind: kind.to_string(),
                x: x + angle.js_sin() * r,
                z: z + angle.js_cos() * r,
                facing: Some(angle),
                seed: Some(seed.wrapping_add((i as u32 + 1).wrapping_mul(0x9e37_79b1))),
                band,
            }
        })
        .collect()
}

/// The training yard: props by the dummy, a ring of trees, rocks
/// scattered everywhere but by the spawn and the dummy, the dummy and the slimes.
pub fn yard(seed: u32) -> Yard {
    let mut rng = Rng::new(seed);
    let mut props: Vec<Prop> = Vec::new();
    let dummy = (0.0, 3.2);
    let spawn = Spawn { x: 0.0, z: -1.0, facing: 0.0 };
    let pi = std::f64::consts::PI;
    let fits = |props: &Vec<Prop>, x: f64, z: f64, r: f64, clearance: f64| props.iter().all(|o| js_hypot(o.x - x, o.z - z) >= o.r + r + clearance);

    for (kind, x, z, rot) in [
        ("hay", 4.2, 4.6, 0.3),
        ("hay", 5.4, 3.4, 1.4),
        ("crate", -4.6, 4.0, 0.2),
        ("crate", -5.3, 5.0, 0.9),
        ("crate", -4.1, 5.5, 0.5),
        ("hay", -6.0, -2.5, 2.1),
    ] {
        props.push(Prop { kind, x, z, r: if kind == "hay" { 0.62 } else { 0.5 }, scale: 1.0, rot });
    }

    let (mut tries, mut trees) = (0, 0);
    while trees < 48 && tries < 3000 {
        tries += 1;
        let angle = rng.next_f64() * pi * 2.0;
        let dist = 12.0 + (YARD_RADIUS + 6.0 - 12.0) * rng.next_f64();
        let (x, z) = (angle.js_cos() * dist, angle.js_sin() * dist);
        let scale = 0.8 + (1.35 - 0.8) * rng.next_f64();
        let r = 0.45 * scale;
        if !fits(&props, x, z, r, 1.6) {
            continue;
        }
        let rot = rng.next_f64() * pi * 2.0;
        props.push(Prop { kind: "tree", x, z, r, scale, rot });
        trees += 1;
    }

    let (mut tries, mut rocks) = (0, 0);
    while rocks < 26 && tries < 3000 {
        tries += 1;
        let angle = rng.next_f64() * pi * 2.0;
        let dist = 6.5 + (YARD_RADIUS + 4.0 - 6.5) * rng.next_f64();
        let (x, z) = (angle.js_cos() * dist, angle.js_sin() * dist);
        let scale = 0.45 + (1.1 - 0.45) * rng.next_f64();
        let r = 0.55 * scale;
        if js_hypot(x - spawn.x, z - spawn.z) < 4.0 || js_hypot(x - dummy.0, z - dummy.1) < 4.0 {
            continue;
        }
        if !fits(&props, x, z, r, 0.8) {
            continue;
        }
        let rot = rng.next_f64() * pi * 2.0;
        props.push(Prop { kind: "rock", x, z, r, scale, rot });
        rocks += 1;
    }

    let mut spawns = vec![SpawnPoint { kind: "dummy".into(), x: dummy.0, z: dummy.1, ..Default::default() }];
    for i in 0..YARD_SLIMES {
        let angle = (i as f64 / YARD_SLIMES as f64) * pi * 2.0 + 0.4;
        let r = 5.0 + (i % 3) as f64;
        // (seed ^ 0x51e0) + i * 0x9e3779b1, as doubles; every use reads it mod 2^32.
        let s = ((seed ^ 0x51e0) as u64 + i as u64 * 0x9e37_79b1) as u32;
        spawns.push(SpawnPoint { kind: "slime".into(), x: angle.js_sin() * r, z: 4.0 + angle.js_cos() * r, seed: Some(s), ..Default::default() });
    }
    Yard { seed, radius: YARD_RADIUS, props, dummy, spawn, spawns }
}

/// Who stands about an island played without the server (makeZoneWorld in src/engine/world/region.ts):
/// its slimes in a ring round their meadow, the dummy, and the townsfolk at their posts.
pub fn island_spawns(r: &Recipe) -> Vec<SpawnPoint> {
    let s = &r.slimes;
    let mut spawns = Vec::new();
    for i in 0..s.count {
        let a = (i as f64 / s.count as f64) * std::f64::consts::PI * 2.0 + 0.4;
        let rr = s.r * (0.45 + (0.55 * ((i * 7) % 5) as f64) / 4.0);
        let seed = ((r.seed ^ 0x51e0) as u64 + i as u64 * 0x9e37_79b1) as u32;
        spawns.push(SpawnPoint { kind: "slime".into(), x: s.x + a.js_sin() * rr, z: s.z + a.js_cos() * rr, seed: Some(seed), ..Default::default() });
    }
    spawns.push(SpawnPoint { kind: "dummy".into(), x: r.dummy.x, z: r.dummy.z, ..Default::default() });
    for n in &r.npcs {
        spawns.push(SpawnPoint { kind: n.kind.clone(), x: n.x, z: n.z, facing: Some(n.facing), ..Default::default() });
    }
    spawns
}
