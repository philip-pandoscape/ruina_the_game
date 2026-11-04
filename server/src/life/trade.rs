//! Trade packs, workbenches, vendors and trading posts (src/sim/life/trade.ts).
//! STUB: the signatures are fixed (other modules call them); the bodies are being ported.
#![allow(unused_variables)]

use super::content::RecipeDef;
use super::state::Pack;
use super::Life;
use crate::open::Sim;

pub fn demand_at(life: &Life, outpost: &str, pack: &str) -> f64 {
    unimplemented!()
}

/// Freshness multiplier for a pack of this age (seconds).
pub fn freshness(age: f64) -> f64 {
    unimplemented!()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quote {
    pub coins: f64,
    pub seals: f64,
    pub demand: f64,
    pub fresh: f64,
    pub factor: f64,
}

/// What a trading post would pay for a pack right now, or None if it will not buy it.
pub fn quote(life: &Life, pack: &Pack, outpost: &str) -> Option<Quote> {
    unimplemented!()
}

pub fn step_trade(life: &mut Life, dt: f64) {}

/// Recovers demand over a long stretch (time away).
pub fn recover_demand(life: &mut Life, seconds: f64) {
    unimplemented!()
}

/// Index of the pack with this id in life.state.packs (TS packById).
pub fn pack_index(life: &Life, id: i64) -> Option<usize> {
    life.state.packs.iter().position(|p| p.id == id)
}

/// Index of the pack on the player's back, if any (TS carried).
pub fn carried(life: &Life, sim: &Sim) -> Option<usize> {
    if sim.player.pack != 0 { pack_index(life, sim.player.pack) } else { None }
}

/// Makes a pack (on the back) and returns its id.
pub fn make_pack(life: &mut Life, def: &str, origin: &str) -> i64 {
    unimplemented!()
}

pub fn craft_pack(life: &mut Life, sim: &mut Sim, r: &RecipeDef, place: &str) -> bool {
    unimplemented!()
}

pub fn craft_item(life: &mut Life, r: &RecipeDef) -> bool {
    unimplemented!()
}

pub fn run_recipe(life: &mut Life, sim: &mut Sim, id: &str) -> bool {
    unimplemented!()
}

pub fn drop_pack(life: &mut Life, sim: &mut Sim) -> bool {
    unimplemented!()
}

/// Picks up the pack with this id.
pub fn pick_up(life: &mut Life, sim: &mut Sim, pack: i64) -> bool {
    unimplemented!()
}

/// Loads the pack on your back into the vehicle's cargo slot.
pub fn load_pack(life: &mut Life, sim: &mut Sim, vehicle: i64, slot: usize) -> bool {
    unimplemented!()
}

/// Takes the pack in the vehicle's cargo slot onto your back.
pub fn unload_pack(life: &mut Life, sim: &mut Sim, vehicle: i64, slot: usize) -> bool {
    unimplemented!()
}

pub fn sell_pack(life: &mut Life, sim: &mut Sim, outpost: &str) -> bool {
    unimplemented!()
}

pub fn consume_carried(life: &mut Life, sim: &mut Sim) {
    unimplemented!()
}

pub fn buy(life: &mut Life, npc: &str, item: &str, n: i64) -> bool {
    unimplemented!()
}

pub fn sell(life: &mut Life, npc: &str, item: &str, n: i64) -> bool {
    unimplemented!()
}
