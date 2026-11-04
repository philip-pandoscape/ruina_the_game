//! Farm animals in scarecrow plots (src/sim/life/livestock.ts).
//! STUB: the signatures are fixed (other modules call them); the bodies are being ported.
#![allow(unused_variables)]

use super::state::Plant;
use super::Life;

pub fn is_animal(p: Option<&Plant>) -> bool {
    p.is_some_and(|p| p.is_animal())
}

pub fn hungry(life: &Life, p: &Plant) -> bool {
    p.fed_until.unwrap_or(0.0) <= life.state.clock
}

pub fn grown_up(p: &Plant) -> bool {
    p.growth >= 1.0
}

pub fn produce_ready(p: &Plant) -> bool {
    grown_up(p) && p.produce.unwrap_or(0.0) >= 1.0
}

/// Advances growth and produce for `seconds`, but only the part of it the animal was fed for.
/// `clock` is the island's clock now. Returns whether it grew up or became ready.
pub fn step_animal(clock: f64, p: &mut Plant, seconds: f64) -> bool {
    unimplemented!()
}

/// Puts a young animal in cell `idx` of the scarecrow with id `sc`.
pub fn raise(life: &mut Life, sc: i64, idx: usize, item: &str) -> bool {
    unimplemented!()
}

/// Feeds the animal in cell `idx` of the scarecrow with id `sc`.
pub fn feed(life: &mut Life, sc: i64, idx: usize) -> bool {
    unimplemented!()
}

pub fn collect(life: &mut Life, sc: i64, idx: usize, x: f64, y: f64, z: f64) -> bool {
    unimplemented!()
}
