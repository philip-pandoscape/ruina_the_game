//! What a region or an instance brings to life where it's played (its file's `spawns`): one of a
//! kind on a spot, a group of them spread round it, or a war-band in a ring round it fighting
//! together as a pack. The server spawns a channel's and a copy's creatures from them, and the
//! browser's session an island's played offline: the same creatures in the same places, with the
//! same seeds.

use serde::{Deserialize, Serialize};

use super::dungeon::DungeonDef;
use super::zone::Recipe;
use crate::jsmath::JsMath;

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

/// One entry of a region's or an instance's `spawns`.
#[derive(Deserialize, Clone, Debug)]
pub struct ZoneSpawn {
    /// A creature's kind (shared/actors.json, or a creature's kinds in shared/creatures.json).
    pub kind: String,
    pub x: f64,
    pub z: f64,
    /// A war-band: `count` in a ring round the spot, facing out, fighting together as a pack.
    #[serde(default)]
    pub band: bool,
    #[serde(default = "one")]
    pub count: u32,
    /// How far round the spot a group that isn't a band is spread (m); without it, a group stands
    /// in a ring round the spot, as a band does.
    #[serde(default)]
    pub r: f64,
}

fn one() -> u32 {
    1
}

impl ZoneSpawn {
    /// Where each one stands, which way it faces (a band's face out; the rest choose for
    /// themselves), and its seed, the seeds following on from `seed`.
    pub fn points(&self, seed: u32) -> Vec<(f64, f64, Option<f64>, u32)> {
        let n = self.count.max(1);
        (0..n)
            .map(|i| {
                let seed = seed.wrapping_add((i + 1).wrapping_mul(0x9e37_79b1));
                if self.r > 0.0 && !self.band {
                    // Round the spot at five distances, out to `r`, so a group doesn't stand in a ring.
                    let a = f64::from(i) / f64::from(n) * std::f64::consts::TAU + 0.4;
                    let r = self.r * (0.45 + 0.55 * f64::from((i * 7) % 5) / 4.0);
                    (self.x + a.js_sin() * r, self.z + a.js_cos() * r, None, seed)
                } else {
                    // One on its spot, or a ring round it.
                    let (x, z, facing) = ring_place(self.x, self.z, i, n);
                    (x, z, self.band.then_some(facing), seed)
                }
            })
            .collect()
    }
}

/// The `i`th of `n` in a war-band's ring round (x, z): where it stands and the way it faces (out).
fn ring_place(x: f64, z: f64, i: u32, n: u32) -> (f64, f64, f64) {
    let angle = f64::from(i) / f64::from(n) * std::f64::consts::TAU;
    let r = if n > 1 { 1.2 + 0.4 * f64::from(i % 2) } else { 0.0 };
    (x + angle.js_sin() * r, z + angle.js_cos() * r, angle)
}

/// Every creature `spawns` brings, as spawn points. Each entry's seeds start from `base` and its
/// place in the list; each war-band is numbered by its place in the list too (from 1), so its
/// members fight together.
pub fn spawn_points(spawns: &[ZoneSpawn], base: u32) -> Vec<SpawnPoint> {
    spawns
        .iter()
        .enumerate()
        .flat_map(|(i, s)| {
            let band = if s.band { i as u32 + 1 } else { 0 };
            let seed = base ^ (i as u32).wrapping_mul(0x9e37_79b1);
            s.points(seed).into_iter().map(move |(x, z, facing, seed)| SpawnPoint { kind: s.kind.clone(), x, z, facing, seed: Some(seed), band })
        })
        .collect()
}

/// What a region brings to life (its recipe's `spawns`), its seeds from the region's own: a
/// channel's on the server, and the island's when the browser plays it offline.
pub fn region_spawns(r: &Recipe) -> Vec<SpawnPoint> {
    spawn_points(&r.spawns, r.seed ^ 0x51e0)
}

/// Who stands about a region played without the server: what its recipe brings to life (as the
/// server spawns it in a channel), and the townsfolk at their posts.
pub fn offline_spawns(r: &Recipe) -> Vec<SpawnPoint> {
    let mut spawns = region_spawns(r);
    for n in &r.npcs {
        spawns.push(SpawnPoint { kind: n.kind.clone(), x: n.x, z: n.z, facing: Some(n.facing), ..Default::default() });
    }
    spawns
}

/// What a copy of an instance brings to life (its file's `spawns`).
pub fn instance_spawns(def: &DungeonDef) -> Vec<SpawnPoint> {
    spawn_points(&def.spawns, 0x20ae)
}

/// `count` of a kind in a ring round (x, z), facing out, as spawn points that share `band`: a
/// war-band put down on its own (a test's).
pub fn band_around(kind: &str, count: usize, x: f64, z: f64, band: u32, seed: u32) -> Vec<SpawnPoint> {
    let s = ZoneSpawn { kind: kind.to_string(), x, z, band: true, count: count as u32, r: 0.0 };
    s.points(seed).into_iter().map(|(x, z, facing, seed)| SpawnPoint { kind: kind.to_string(), x, z, facing, seed: Some(seed), band }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spawn(kind: &str, band: bool, count: u32, r: f64) -> ZoneSpawn {
        ZoneSpawn { kind: kind.into(), x: 10.0, z: -20.0, band, count, r }
    }

    #[test]
    fn one_stands_on_its_spot() {
        let p = spawn_points(&[spawn("dummy", false, 1, 0.0)], 7);
        assert_eq!(p.len(), 1);
        assert_eq!((p[0].x, p[0].z, p[0].facing, p[0].band), (10.0, -20.0, None, 0));
    }

    #[test]
    fn a_group_is_spread_round_its_spot_within_its_reach() {
        let p = spawn_points(&[spawn("slime", false, 6, 16.0)], 7);
        assert_eq!(p.len(), 6);
        for q in &p {
            let d = ((q.x - 10.0).powi(2) + (q.z + 20.0).powi(2)).sqrt();
            assert!((0.45 * 16.0 - 1e-9..=16.0 + 1e-9).contains(&d), "{d} m from the spot");
            assert_eq!(q.band, 0);
        }
        let seeds: std::collections::BTreeSet<_> = p.iter().map(|q| q.seed).collect();
        assert_eq!(seeds.len(), 6, "each its own seed");
    }

    #[test]
    fn a_band_rings_its_spot_facing_out_and_is_numbered_by_its_place() {
        let p = spawn_points(&[spawn("dummy", false, 1, 0.0), spawn("goblin", true, 6, 0.0)], 7);
        let band: Vec<_> = p.iter().filter(|q| q.kind == "goblin").collect();
        assert_eq!(band.len(), 6);
        assert!(band.iter().all(|q| q.band == 2 && q.facing.is_some()));
        // As a band put down on its own lays one out, from the same seed.
        let alone = band_around("goblin", 6, 10.0, -20.0, 2, 7 ^ 0x9e37_79b1);
        for (a, b) in band.iter().zip(&alone) {
            assert_eq!((a.x, a.z, a.facing, a.seed), (b.x, b.z, b.facing, b.seed));
        }
    }
}
