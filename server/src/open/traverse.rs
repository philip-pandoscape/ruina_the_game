//! Getting around an open world: walking over hills (and not up cliffs), wading and swimming,
//! and flying a glider (src/sim/player/traverse.ts).
//! STUB: the signatures are fixed (other modules call them); the bodies are being ported.
#![allow(unused_variables)]

use super::zone::Updraft;
use super::Sim;
use crate::player::Actions;

pub fn integrate_open(sim: &mut Sim) {
    unimplemented!()
}

/// Trees, rocks, buildings and the edge of the world.
pub fn collide_open(sim: &mut Sim) {
    unimplemented!()
}

pub fn update_swim(sim: &mut Sim, a: &Actions) {
    unimplemented!()
}

/// Height of your feet above whatever is under you (water counts as a floor).
pub fn height_above_ground(sim: &Sim) -> f64 {
    unimplemented!()
}

/// Why the glider will not open right now, or None if it will.
pub fn glider_blocked(sim: &Sim) -> Option<&'static str> {
    unimplemented!()
}

pub fn open_glider(sim: &mut Sim) -> bool {
    unimplemented!()
}

/// why: "fold", "land", "crash" or "water".
pub fn close_glider(sim: &mut Sim, why: &str) {
    unimplemented!()
}

/// Climb rate from rising air at a point.
pub fn updraft_lift(updrafts: &[Updraft], x: f64, y: f64, z: f64) -> f64 {
    unimplemented!()
}

/// F in flight: the glider's gust. Returns false while it recharges.
pub fn gust(sim: &mut Sim) -> bool {
    unimplemented!()
}

pub fn update_glide(sim: &mut Sim, a: &Actions) {
    unimplemented!()
}
