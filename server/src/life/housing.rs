//! Houses on the plots at Hearthside Rise (src/sim/life/housing.ts).
//! STUB: the signatures are fixed (other modules call them); the bodies are being ported.
#![allow(unused_variables)]

use super::state::House;
use super::Life;
use crate::open::zone::HousePlot;
use crate::open::Sim;

pub const DAY: f64 = 86400.0;

/// Where the house stands inside its plot: toward the back, leaving a front yard.
pub const HOUSE_SETBACK: f64 = -2.5;

/// What a stage still needs, pack by pack (houses and ships).
#[derive(Clone, Debug, PartialEq)]
pub struct Need {
    pub pack: String,
    pub need: i64,
    pub have: i64,
}

pub fn plot_def(life: &Life, plot: &str) -> Option<&'static HousePlot> {
    life.zone.recipe.house_plots.iter().find(|p| p.id == plot)
}

/// Index of the house on this plot in life.state.houses, if any.
pub fn house_on(life: &Life, plot: &str) -> Option<usize> {
    life.state.houses.iter().position(|h| h.plot == plot)
}

/// The house's own position and facing in the world: (x, z, rot).
pub fn house_pose(life: &Life, h: &House) -> (f64, f64, f64) {
    unimplemented!()
}

pub fn is_complete(h: &House) -> bool {
    unimplemented!()
}

pub fn still_needs(h: &House) -> Vec<Need> {
    unimplemented!()
}

pub fn stage_ready(h: &House) -> bool {
    unimplemented!()
}

pub fn place_house(life: &mut Life, sim: &mut Sim, plot: &str, item: &str) -> bool {
    unimplemented!()
}

/// Hands the pack on your back to the house with this id, if its stage wants it.
pub fn deliver_material(life: &mut Life, sim: &mut Sim, house: i64) -> bool {
    unimplemented!()
}

pub fn build_stage(life: &mut Life, sim: &mut Sim, house: i64) -> bool {
    unimplemented!()
}

/// The house's solid parts as far as it has been built (each piece once per owner and house).
pub fn add_house_colliders(life: &Life, sim: &mut Sim, h: &House) {
    unimplemented!()
}

/// A point inside the house ("bed", "chest") in world space: (x, z).
pub fn interior_point(life: &Life, h: &House, what: &str) -> (f64, f64) {
    unimplemented!()
}

/// (owed, due_in).
pub fn tax_due(life: &Life, h: &House) -> (f64, f64) {
    unimplemented!()
}

pub fn pay_tax(life: &mut Life, house: i64) -> bool {
    unimplemented!()
}

pub fn step_housing(life: &mut Life) {}
