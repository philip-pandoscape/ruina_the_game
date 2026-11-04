//! The world's actors on the server: monsters, NPCs and props. Mirrors src/sim/actor.ts and
//! src/sim/combat/hit.ts, so the training yard offline and a live server agree about where a
//! slime is and what a swing reaches.

use crate::actor::Actor;
use crate::ai::{start_brain, step_brain, Sighting};
use crate::content::{kind, kind_index};

const DEG: f64 = std::f64::consts::PI / 180.0;

fn len(x: f64, z: f64) -> f64 {
    (x * x + z * z).sqrt()
}

fn angle_diff(a: f64, b: f64) -> f64 {
    let tau = std::f64::consts::PI * 2.0;
    let mut d = (b - a) % tau;
    if d > std::f64::consts::PI {
        d -= tau;
    }
    if d < -std::f64::consts::PI {
        d += tau;
    }
    d
}

#[derive(Default)]
pub struct Actors {
    pub list: Vec<Actor>,
    next_id: u32,
}

/// What died this tick, for the effects the clients are told about.
pub struct Death {
    pub id: u32,
    pub kind_index: u8,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Actors {
    pub fn new() -> Self {
        Self { list: Vec::new(), next_id: 1 }
    }

    pub fn spawn(&mut self, kind_id: &str, x: f64, z: f64, seed: u32) -> Option<u32> {
        let k = kind(kind_id)?;
        let index = kind_index(kind_id)?;
        self.next_id += 1;
        let id = self.next_id;
        let mut a = Actor::of_kind(id, k, index, x, z, seed);
        start_brain(&mut a, Sighting { x, z, present: false });
        self.list.push(a);
        Some(id)
    }

    pub fn get_mut(&mut self, id: u32) -> Option<&mut Actor> {
        self.list.iter_mut().find(|a| a.id == id)
    }

    /// One frame for every actor: its brain, its lean, and bringing it back when it has been
    /// down long enough. `players` is where everyone is, so a brain can notice the nearest.
    pub fn step(&mut self, players: &[(f64, f64)], spring: f64, damping: f64, dt: f64) {
        for a in self.list.iter_mut() {
            a.flash_frame = (a.flash_frame + 1).min(999);
            if a.is_alive() {
                let mut seen = Sighting { x: a.x, z: a.z, present: false };
                let mut best = f64::INFINITY;
                for &(px, pz) in players {
                    let d = len(px - a.x, pz - a.z);
                    if d < best {
                        best = d;
                        seen = Sighting { x: px, z: pz, present: true };
                    }
                }
                step_brain(a, seen);
            } else {
                a.dead_frame += 1;
                if a.respawn_frames >= 0 && a.dead_frame >= a.respawn_frames {
                    a.revive();
                    let seen = Sighting { x: a.x, z: a.z, present: false };
                    start_brain(a, seen);
                }
            }
            if a.lean_x != 0.0 || a.lean_z != 0.0 || a.lean_vx != 0.0 || a.lean_vz != 0.0 {
                a.lean_vx += (-spring * a.lean_x - damping * a.lean_vx) * dt;
                a.lean_vz += (-spring * a.lean_z - damping * a.lean_vz) * dt;
                a.lean_x += a.lean_vx * dt;
                a.lean_z += a.lean_vz * dt;
            }
        }
    }

    /// A melee swing: everything in the arc and in reach, nearest first, capped at `max`.
    pub fn cone_hits(&self, x: f64, z: f64, facing: f64, reach: f64, arc_deg: f64, max: usize) -> Vec<u32> {
        let mut hits: Vec<(f64, u32)> = self
            .list
            .iter()
            .filter(|a| a.is_alive())
            .filter_map(|a| {
                let (dx, dz) = (a.x - x, a.z - z);
                let dist = len(dx, dz);
                if dist > reach + a.radius {
                    return None;
                }
                let in_cone = angle_diff(facing, dx.atan2(dz)).abs() <= (arc_deg / 2.0) * DEG;
                if !in_cone && dist > a.radius + 0.3 {
                    return None;
                }
                Some((dist, a.id))
            })
            .collect();
        hits.sort_by(|p, q| p.0.total_cmp(&q.0));
        hits.truncate(max.max(1));
        hits.into_iter().map(|(_, id)| id).collect()
    }

    /// A blast: everything whose body overlaps the circle.
    pub fn circle_hits(&self, x: f64, z: f64, radius: f64) -> Vec<u32> {
        self.list
            .iter()
            .filter(|a| a.is_alive() && len(a.x - x, a.z - z) <= radius + a.radius)
            .map(|a| a.id)
            .collect()
    }

    /// A projectile at a point in flight: the first thing it touches.
    pub fn point_hit(&self, x: f64, y: f64, z: f64, pad: f64) -> Option<u32> {
        let mut best: Option<(f64, u32)> = None;
        for a in self.list.iter().filter(|a| a.is_alive()) {
            if y > a.hit_ceiling {
                continue;
            }
            let dist = len(a.x - x, a.z - z);
            if dist > a.radius + pad {
                continue;
            }
            if best.is_none_or(|(d, _)| dist < d) {
                best = Some((dist, a.id));
            }
        }
        best.map(|(_, id)| id)
    }

    /// Takes a hit travelling along (nx, nz). Returns a death if that finished it.
    pub fn damage(&mut self, id: u32, amount: f64, nx: f64, nz: f64, knock: f64) -> Option<Death> {
        let a = self.get_mut(id)?;
        if !a.is_alive() {
            return None;
        }
        a.hp = (a.hp - amount).max(0.0);
        a.flash_frame = 0;
        a.lean_vx += nx * knock;
        a.lean_vz += nz * knock;
        if a.hp > 0.0 {
            return None;
        }
        a.dead_frame = 0;
        Some(Death { id: a.id, kind_index: a.kind_index, x: a.x, y: a.hit_height, z: a.z })
    }
}
