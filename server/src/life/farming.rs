//! Scarecrow plots and what grows in them (src/sim/life/farming.ts).
//! STUB: the signatures are fixed (other modules call them); the bodies are being ported.
#![allow(unused_variables)]

use super::state::{Plant, Scarecrow};
use super::Life;
use crate::open::Sim;

pub fn stage_of(p: &Plant) -> i64 {
    unimplemented!()
}

pub fn is_ripe(p: &Plant) -> bool {
    p.growth >= 1.0
}

/// Growth per second right now.
pub fn growth_rate(life: &Life, p: &Plant) -> f64 {
    unimplemented!()
}

/// Seconds until ripe at the current rate.
pub fn seconds_to_ripe(life: &Life, p: &Plant) -> f64 {
    unimplemented!()
}

pub fn step_farms(life: &mut Life, dt: f64) {}

/// Advances every plant by a long stretch at once (time away, or the dev panel's warp).
pub fn grow_for(life: &mut Life, seconds: f64) {
    unimplemented!()
}

/// The middle of a plot cell: (x, z).
pub fn cell_centre(sc: &Scarecrow, idx: usize) -> (f64, f64) {
    unimplemented!()
}

/// The plot cell under a point, if any: (index into life.state.scarecrows, cell index).
pub fn cell_at(life: &Life, x: f64, z: f64) -> Option<(usize, usize)> {
    unimplemented!()
}

/// Where the scarecrow itself stands: just outside the plot's front-left corner.
pub fn scarecrow_post(x: f64, z: f64, rot: f64) -> (f64, f64) {
    unimplemented!()
}

/// Why a scarecrow cannot go here, or None if it can.
pub fn plot_problem(life: &Life, sim: &Sim, x: f64, z: f64, rot: f64) -> Option<String> {
    unimplemented!()
}

/// Puts a scarecrow down (the item is already paid for). Returns its id.
pub fn add_scarecrow(life: &mut Life, sim: &mut Sim, x: f64, z: f64, rot: f64) -> i64 {
    unimplemented!()
}

/// Makes a scarecrow's post solid and its ground tilled (once per owner and scarecrow).
pub fn add_scarecrow_collider(sim: &mut Sim, sc: &Scarecrow) {
    unimplemented!()
}

/// Plants in cell `idx` of the scarecrow with id `sc`.
pub fn plant(life: &mut Life, sc: i64, idx: usize, seed_item: &str) -> bool {
    unimplemented!()
}

pub fn water(life: &mut Life, sc: i64, idx: usize) -> bool {
    unimplemented!()
}

pub fn harvest(life: &mut Life, sc: i64, idx: usize, y: f64) -> bool {
    unimplemented!()
}

pub fn fell(life: &mut Life, sc: i64, idx: usize, y: f64) -> bool {
    unimplemented!()
}
