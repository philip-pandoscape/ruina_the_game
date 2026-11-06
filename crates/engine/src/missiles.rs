//! What creatures throw and shoot, in flight (the page draws them from the session's view): aimed
//! where the foe is going as much as the attack leads, lobbed to come down on them, hitting the
//! first foe whose body it passes through unless they are in a dodge's untouchable frames, and
//! landing where it meets the ground.

use crate::actor::Actor;
use crate::ai::Foe;
use crate::content::AttackDef;
use crate::jsmath::JsMath;
use crate::jsmath::len;
use crate::tuning::tuning;

/// How tall a foe's body is, from the feet, for what a missile can hit.
pub const FOE_HEIGHT: f64 = 1.8;
/// Frames before a missile that never came down is gone.
const LIFE: i32 = 240;

#[derive(Clone, Debug, serde::Serialize)]
pub struct Missile {
    pub id: u32,
    /// The actor that threw it, and the attack (an index into the creatures' attacks) it came from.
    pub owner: u32,
    pub attack: usize,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub vx: f64,
    pub vy: f64,
    pub vz: f64,
    pub gravity: f64,
    pub radius: f64,
    pub damage: f64,
    pub knock: f64,
    pub age: i32,
}

/// Lets one go from a creature at a foe.
pub fn launch(id: u32, a: &Actor, atk: &AttackDef, attack: usize, foe: &Foe, ground_y: f64) -> Missile {
    let speed = atk.speed.unwrap_or(10.0);
    let gravity = atk.gravity;
    let ox = a.x + a.facing.js_sin() * 0.25;
    let oz = a.z + a.facing.js_cos() * 0.25;
    let oy = ground_y + a.hit_height * 0.9;
    // Where the foe will be by the time it gets there, as much as this attack leads.
    let ahead = (len(foe.x - ox, foe.z - oz) / speed) * atk.lead;
    let mut dx = foe.x + foe.vx * ahead - ox;
    let mut dz = foe.z + foe.vz * ahead - oz;
    let mut d = len(dx, dz);
    let range = atk.range.unwrap_or(d);
    if d > range {
        dx = (dx / d) * range;
        dz = (dz / d) * range;
        d = range;
    }
    let dir_x = if d > 1e-6 { dx / d } else { a.facing.js_sin() };
    let dir_z = if d > 1e-6 { dz / d } else { a.facing.js_cos() };
    // Lobbed to come down at the foe's chest after flying that far at its speed.
    let t = (d / speed).max(0.1);
    let vy = (foe.y + 1.0 - oy + 0.5 * gravity * t * t) / t;
    Missile {
        id,
        owner: a.id,
        attack,
        x: ox,
        y: oy,
        z: oz,
        vx: dir_x * (d / t),
        vy,
        vz: dir_z * (d / t),
        gravity,
        radius: atk.radius.unwrap_or(0.1),
        damage: atk.damage,
        knock: atk.knock,
        age: 0,
    }
}

/// What happened to a missile this frame, for the world to act on.
pub enum Flight {
    /// It struck a foe, travelling along (nx, nz).
    Hit { foe: u32, damage: f64, knock: f64, nx: f64, nz: f64 },
    /// It came down on the ground here.
    Landed { x: f64, y: f64, z: f64 },
}

/// One frame of everything in flight. Returns what struck or landed, in the order they flew.
pub fn step_missiles(missiles: &mut Vec<Missile>, foes: &[Foe], ground: &dyn Fn(f64, f64) -> f64) -> Vec<Flight> {
    let body = tuning().movement.player_radius;
    let mut out = Vec::new();
    let mut kept = Vec::with_capacity(missiles.len());
    for mut m in missiles.drain(..) {
        m.age += 1;
        m.vy -= m.gravity / 60.0;
        m.x += m.vx / 60.0;
        m.y += m.vy / 60.0;
        m.z += m.vz / 60.0;
        let struck = foes.iter().find(|f| !f.invuln && len(f.x - m.x, f.z - m.z) <= body + m.radius && m.y >= f.y && m.y <= f.y + FOE_HEIGHT);
        if let Some(f) = struck {
            let s = len(m.vx, m.vz);
            let (nx, nz) = if s > 1e-6 { (m.vx / s, m.vz / s) } else { (0.0, 1.0) };
            out.push(Flight::Hit { foe: f.id, damage: m.damage, knock: m.knock, nx, nz });
            continue;
        }
        if m.y <= ground(m.x, m.z) {
            out.push(Flight::Landed { x: m.x, y: m.y, z: m.z });
            continue;
        }
        if m.age < LIFE {
            kept.push(m);
        }
    }
    *missiles = kept;
    out
}
