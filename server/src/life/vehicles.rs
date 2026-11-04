//! Carts, cars, boats and mounts (src/sim/life/vehicles.ts).
//! STUB: the signatures are fixed (other modules call them); the bodies are being ported.
#![allow(unused_variables)]

use super::content::Anchor;
use super::state::Vehicle;
use super::Life;
use crate::open::Sim;
use crate::player::Actions;

/// Index of the vehicle with this id in life.state.vehicles (TS vehicleById).
pub fn vehicle_index(life: &Life, id: i64) -> Option<usize> {
    life.state.vehicles.iter().position(|v| v.id == id)
}

/// Index of the vehicle the player is riding, if any (TS ridden).
pub fn ridden(life: &Life, sim: &Sim) -> Option<usize> {
    if sim.player.vehicle != 0 { vehicle_index(life, sim.player.vehicle) } else { None }
}

/// A point given in the vehicle's own frame, out in the world.
pub fn anchor_world(v: &Vehicle, a: &Anchor) -> (f64, f64, f64) {
    unimplemented!()
}

/// Calls the vehicle (or mount) a deed or whistle in your bag stands for. Returns its id.
pub fn summon(life: &mut Life, sim: &mut Sim, item: &str) -> Option<i64> {
    unimplemented!()
}

pub fn recall(life: &mut Life, sim: &mut Sim, id: i64, quiet: bool) -> bool {
    unimplemented!()
}

pub fn board(life: &mut Life, sim: &mut Sim, id: i64) -> bool {
    unimplemented!()
}

/// Where you would end up stepping out of a vehicle: (x, y, z, dry).
pub fn exit_spot(sim: &Sim, v: &Vehicle) -> (f64, f64, f64, bool) {
    unimplemented!()
}

pub fn dismount(life: &mut Life, sim: &mut Sim) -> bool {
    unimplemented!()
}

/// Seats the player in the vehicle (driver's seat).
pub fn place_rider(sim: &mut Sim, v: &Vehicle) {
    unimplemented!()
}

/// The mount key: get on (calling it if it is far away or not out), or get off.
pub fn mount_command(life: &mut Life, sim: &mut Sim) {
    unimplemented!()
}

pub fn ride_vehicle(life: &mut Life, sim: &mut Sim, a: &Actions) {}

pub fn step_vehicles(life: &mut Life, sim: &mut Sim, a: &Actions) {}

/// How much of the wind a sail can use at this angle off it (0 = wind straight behind).
pub fn sail_efficiency(rel: f64) -> f64 {
    unimplemented!()
}

/// The seat or cargo slot nearest a point (TS nearestAnchor). `kind` is "seat" or "cargo".
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Anchored {
    pub kind: &'static str,
    pub index: usize,
    pub dist: f64,
}

pub fn nearest_anchor(v: &Vehicle, x: f64, z: f64, carrying: bool) -> Anchored {
    unimplemented!()
}

/// Distance from (x, z) to the vehicle's hull, roughly.
pub fn distance_to(v: &Vehicle, x: f64, z: f64) -> f64 {
    unimplemented!()
}
