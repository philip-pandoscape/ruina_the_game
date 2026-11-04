//! Ships built on slipways (src/sim/life/shipyard.ts).
//! STUB: the signatures are fixed (other modules call them); the bodies are being ported.
#![allow(unused_variables)]

use super::housing::Need;
use super::state::ShipBuild;
use super::Life;
use crate::open::zone::Shipyard;
use crate::open::Sim;

pub fn slip_def(life: &Life, slip: &str) -> Option<&'static Shipyard> {
    life.zone.recipe.shipyards.iter().find(|s| s.id == slip)
}

/// Index of the ship on this slipway in life.state.ships, if any.
pub fn ship_on(life: &Life, slip: &str) -> Option<usize> {
    life.state.ships.iter().position(|s| s.slip == slip)
}

pub fn ship_needs(b: &ShipBuild) -> Vec<Need> {
    unimplemented!()
}

pub fn ship_stage_ready(b: &ShipBuild) -> bool {
    unimplemented!()
}

pub fn ship_finished(b: &ShipBuild) -> bool {
    unimplemented!()
}

pub fn lay_keel(life: &mut Life, slip: &str, item: &str) -> bool {
    unimplemented!()
}

/// Hands the pack on your back to the ship with this id.
pub fn deliver_ship_material(life: &mut Life, sim: &mut Sim, ship: i64) -> bool {
    unimplemented!()
}

pub fn build_ship_stage(life: &mut Life, ship: i64) -> bool {
    unimplemented!()
}

pub fn launch(life: &mut Life, ship: i64) -> bool {
    unimplemented!()
}

pub fn design_items_in_bag(life: &Life) -> Vec<String> {
    unimplemented!()
}
