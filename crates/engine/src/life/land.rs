//! Land: what's built and planted in the world, and what's left standing in it: houses on their
//! plots, farms (a scarecrow and its cells), ships on the slipways, packs on the ground or in a
//! vehicle's bed, and vehicles parked. It is the world's, not a life's: the same in every channel of
//! a region, kept in rows of its own keyed by where each piece stands (its space and 256 m chunk),
//! each with its owner. Only its owner changes a piece, so while a character plays, their own land
//! is lent to their life (`Life::land`) and changed by its rules; when they go, it stays standing
//! where it is. Whoever keeps the region's land (the server's region, the browser's session offline)
//! hears from each step what it must do beyond that (`Change`): a plot claimed or let go, a pack
//! sold. Its times are the world's clock ([`now`]), so taxes fall due and crops are fed on the
//! same clock everywhere, whoever is looking.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::Life;
use super::state::{LifeState, Stack};

/// A trade or material pack: on a back, on the ground, or in cargo. Never in the bag.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Pack {
    pub id: i64,
    pub def: String,
    /// The land's clock when it was made ([`now`]), for freshness.
    pub made: f64,
    pub origin: String,
    /// "back", "ground" or "cargo".
    pub at: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub rot: f64,
    pub vehicle: i64,
    pub slot: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct Vehicle {
    pub id: i64,
    pub def: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub heading: f64,
    pub vx: f64,
    pub vy: f64,
    pub vz: f64,
    /// Forward speed along the heading (signed).
    pub speed: f64,
    pub steer: f64,
    pub throttle: f64,
    /// Boats: how much sail is set, 0..1.
    pub sail: f64,
    pub grounded: bool,
    pub pitch: f64,
    pub roll: f64,
    pub hp: f64,
    /// A pack id per cargo slot, 0 where empty.
    pub cargo: Vec<i64>,
    /// Whether you are in it (always the driver's seat for now).
    pub ridden: bool,
    /// Mounts: in deep water.
    pub swimming: bool,
    /// Boats: told you about the rough water already.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storm_warned: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct Plant {
    pub crop: String,
    /// 0..1 along the crop's growth; 1 is ripe.
    pub growth: f64,
    pub watered: bool,
    /// Trees only: fruit picked at least once.
    pub picked: bool,
    /// Livestock: an animal rather than a plant (`crop` is then the animal's id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animal: Option<bool>,
    /// Livestock: the land's clock ([`now`]) until which it is fed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fed_until: Option<f64>,
    /// Livestock: progress toward the next eggs, wool or milk, 0..1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub produce: Option<f64>,
}

impl Plant {
    pub fn is_animal(&self) -> bool {
        self.animal == Some(true)
    }
}

/// A farm: a scarecrow and the plot of cells beside it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Scarecrow {
    pub id: i64,
    pub x: f64,
    pub z: f64,
    pub rot: f64,
    /// One per cell, row-major from the back-left; null where nothing is planted.
    pub cells: Vec<Option<Plant>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct House {
    pub id: i64,
    pub plot: String,
    pub blueprint: String,
    /// Stages finished, 0..stages (complete).
    pub stage: i64,
    /// Material packs delivered toward the current stage.
    pub delivered: BTreeMap<String, i64>,
    pub storage: Vec<Stack>,
    /// The land's clock ([`now`]) up to which property tax is paid.
    pub tax_paid_until: f64,
    /// Online, its plot's claim isn't the registry's yet: nothing is built on it until it is
    /// (crate::life::housing::confirm_claim), and if someone else's claim got there first the house
    /// is gone again (crate::life::housing::lose_claim).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pending: bool,
}

/// A ship on a slipway, part built.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct ShipBuild {
    pub id: i64,
    pub slip: String,
    pub design: String,
    pub stage: i64,
    pub delivered: BTreeMap<String, i64>,
}

/// The ids a holding gives what it places, from `next` up to (not including) `end`. Offline and in
/// tests they are its own, counted up from one past the highest it has; online the server hands out
/// runs of them from the database's sequence, so no two pieces in the world share one.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ids {
    pub next: i64,
    pub end: i64,
}

impl Default for Ids {
    fn default() -> Self {
        Ids { next: 1, end: i64::MAX }
    }
}

impl Ids {
    /// How many are left to give.
    pub fn left(&self) -> i64 {
        (self.end - self.next).max(0)
    }
}

/// Said when a holding has no ids left for something new (online, until the server has topped its
/// run up again: a moment).
pub const NO_IDS: &str = "Not just now - try again in a moment";

/// One character's land in the world: their houses, farms, ships on the slipways, packs and
/// vehicles, wherever each stands.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Land {
    pub houses: Vec<House>,
    pub scarecrows: Vec<Scarecrow>,
    pub ships: Vec<ShipBuild>,
    pub packs: Vec<Pack>,
    pub vehicles: Vec<Vehicle>,
    /// Ids for what's placed next.
    #[serde(skip)]
    pub ids: Ids,
}

impl Land {
    /// Nothing of anyone's here.
    pub fn is_empty(&self) -> bool {
        self.houses.is_empty() && self.scarecrows.is_empty() && self.ships.is_empty() && self.packs.is_empty() && self.vehicles.is_empty()
    }

    /// The highest id of anything here (0 for nothing).
    pub fn max_id(&self) -> i64 {
        let ids = self.houses.iter().map(|h| h.id).chain(self.scarecrows.iter().map(|s| s.id)).chain(self.ships.iter().map(|s| s.id));
        ids.chain(self.packs.iter().map(|p| p.id)).chain(self.vehicles.iter().map(|v| v.id)).max().unwrap_or(0).max(0)
    }

    /// Its own ids from here on, past everything it has (offline, tests, a save just read).
    pub fn own_ids(&mut self) {
        self.ids = Ids { next: self.max_id() + 1, end: i64::MAX };
    }

    /// An id for something newly placed, if there's one left to give (online the server keeps the
    /// run topped up; a run used up says no until it has).
    pub fn new_id(&mut self) -> Option<i64> {
        if self.ids.next >= self.ids.end {
            return None;
        }
        let id = self.ids.next;
        self.ids.next += 1;
        Some(id)
    }

    /// Every piece as a row of its own, keyed by the chunk it stands in (none for a pack on its
    /// owner's back, which goes where they go).
    pub fn rows(&self) -> Vec<Row> {
        let map = crate::open::map::world_map();
        let at = |x: f64, z: f64| Some(map.chunk_of(x, z));
        let data = |v: Result<Value, serde_json::Error>| v.unwrap_or(Value::Null);
        let mut out = Vec::new();
        for h in &self.houses {
            let (x, z, _) = super::housing::house_pose(h);
            out.push(Row { id: h.id, kind: Kind::House, chunk: at(x, z), data: data(serde_json::to_value(h)) });
        }
        for s in &self.scarecrows {
            out.push(Row { id: s.id, kind: Kind::Farm, chunk: at(s.x, s.z), data: data(serde_json::to_value(s)) });
        }
        for s in &self.ships {
            let (x, z) = super::shipyard::slip_def(&s.slip).map_or((0.0, 0.0), |y| (y.x, y.z));
            out.push(Row { id: s.id, kind: Kind::Ship, chunk: at(x, z), data: data(serde_json::to_value(s)) });
        }
        for v in &self.vehicles {
            out.push(Row { id: v.id, kind: Kind::Vehicle, chunk: at(v.x, v.z), data: data(serde_json::to_value(v)) });
        }
        for p in &self.packs {
            let chunk = match p.at.as_str() {
                "back" => None,
                "cargo" => self.vehicles.iter().find(|v| v.id == p.vehicle).map_or(at(p.x, p.z), |v| at(v.x, v.z)),
                _ => at(p.x, p.z),
            };
            out.push(Row { id: p.id, kind: Kind::Pack, chunk, data: data(serde_json::to_value(p)) });
        }
        out
    }

    /// The land read back from its rows (a row that doesn't read as its kind is left out, and named
    /// in what comes back with it).
    pub fn from_rows(rows: impl IntoIterator<Item = (Kind, Value)>) -> (Land, Vec<String>) {
        let mut land = Land::default();
        let mut bad = Vec::new();
        for (kind, data) in rows {
            let ok = match kind {
                Kind::House => serde_json::from_value(data.clone()).map(|h| land.houses.push(h)),
                Kind::Farm => serde_json::from_value(data.clone()).map(|s| land.scarecrows.push(s)),
                Kind::Ship => serde_json::from_value(data.clone()).map(|s| land.ships.push(s)),
                Kind::Pack => serde_json::from_value(data.clone()).map(|p| land.packs.push(p)),
                Kind::Vehicle => serde_json::from_value(data.clone()).map(|v| land.vehicles.push(v)),
            };
            if let Err(e) = ok {
                bad.push(format!("{} {}: {e}", kind.name(), data.get("id").and_then(Value::as_i64).unwrap_or(0)));
            }
        }
        land.houses.sort_by_key(|h| h.id);
        land.scarecrows.sort_by_key(|s| s.id);
        land.ships.sort_by_key(|s| s.id);
        land.packs.sort_by_key(|p| p.id);
        land.vehicles.sort_by_key(|v| v.id);
        land.own_ids();
        (land, bad)
    }

    /// Moves every time it keeps (a house's tax paid until, an animal fed until, a pack made at) by
    /// `by` seconds: a save from before land ran on the world's clock kept them on its life's, which
    /// the server reads on the world's from the moment it was saved (`by` = saved at, on the world's
    /// clock, less the life's clock then).
    pub fn rebase(&mut self, by: f64) {
        for h in &mut self.houses {
            h.tax_paid_until += by;
        }
        for p in self.scarecrows.iter_mut().flat_map(|s| s.cells.iter_mut().flatten()) {
            if let Some(t) = p.fed_until.as_mut() {
                *t += by;
            }
        }
        for p in &mut self.packs {
            p.made += by;
        }
    }

    /// The plots its houses stand on.
    pub fn plots(&self) -> impl Iterator<Item = &str> {
        self.houses.iter().map(|h| h.plot.as_str())
    }

    /// Makes its houses and farm posts solid in `world` as far as they're built, their ground
    /// cleared (each piece once: `OpenWorld::added`), under the character `owner`.
    pub fn make_solid(&self, world: &mut crate::open::OpenWorld, owner: i64) {
        for h in &self.houses {
            super::housing::add_house_colliders(world, owner, h);
        }
        for sc in &self.scarecrows {
            super::farming::add_scarecrow_collider(world, owner, sc);
        }
    }

    /// What of it everyone else draws while its owner is away: what's built and planted. (Their
    /// vehicles and packs are drawn with them while they play.)
    pub fn standing(&self) -> Land {
        Land { houses: self.houses.clone(), scarecrows: self.scarecrows.clone(), ships: self.ships.clone(), ..Land::default() }
    }
}

/// What a piece of land is, as its row names it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    House,
    Farm,
    Ship,
    Pack,
    Vehicle,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::House => "house",
            Kind::Farm => "farm",
            Kind::Ship => "ship",
            Kind::Pack => "pack",
            Kind::Vehicle => "vehicle",
        }
    }

    pub fn named(s: &str) -> Option<Kind> {
        [Kind::House, Kind::Farm, Kind::Ship, Kind::Pack, Kind::Vehicle].into_iter().find(|k| k.name() == s)
    }
}

/// One piece of land as it's kept: its id, what it is, the chunk it stands in (none for a pack on
/// its owner's back) and the piece itself.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub id: i64,
    pub kind: Kind,
    pub chunk: Option<(i32, i32)>,
    pub data: Value,
}

/// What a step did that whoever keeps the region's land must hear (taken with `Life::take_changes`):
/// the server's region tells the database and every channel; offline the session is the world, and
/// has nothing more to do.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Change {
    /// A house plot claimed, with the house now on it.
    Claimed { plot: String, house: i64 },
    /// A house plot let go: the house on it is gone.
    Freed { plot: String },
    /// A pack sold at a trading post, lowering its demand there for everyone (crate::life::market),
    /// at a moment on the land's clock.
    Sold { outpost: String, pack: String, at: f64 },
}

/// The land's clock, in seconds: online the world's (the server's, set each tick: `Life::world_clock`),
/// so a house's tax and an animal's feed run out at the same moment whoever is looking; offline,
/// where the browser's session is the whole world, the life's own.
pub fn now(life: &Life) -> f64 {
    life.world_clock.unwrap_or(life.state.clock)
}

/// Whether a save kept its land inside its life's state, as before land was kept apart (its times on
/// the life's clock: `Land::rebase`).
pub fn kept_inside(island: &Value) -> bool {
    island.get("land").is_none_or(Value::is_null)
}

/// A saved life and its land, read from a save in either shape: as the server and the browser keep
/// them now (`{state, land, player}`), or as they kept them before land had rows of its own, the
/// land inside the life's state (version 3 and before). What the state kept that is the world's now
/// (each post's demand, the weather) is left out.
pub fn read_saved(island: &Value) -> Result<(LifeState, Land), String> {
    let mut state = island.get("state").cloned().ok_or("no state")?;
    let obj = state.as_object_mut().ok_or("the state isn't an object")?;
    let mut land = match island.get("land") {
        Some(l) if !l.is_null() => serde_json::from_value::<Land>(l.clone()).map_err(|e| format!("its land: {e}"))?,
        _ => {
            let mut old = serde_json::Map::new();
            for k in ["houses", "scarecrows", "ships", "packs", "vehicles"] {
                if let Some(v) = obj.get(k) {
                    old.insert(k.into(), v.clone());
                }
            }
            serde_json::from_value::<Land>(Value::Object(old)).map_err(|e| format!("its land: {e}"))?
        }
    };
    for k in ["houses", "scarecrows", "ships", "packs", "vehicles", "demand", "weather"] {
        obj.remove(k);
    }
    let state = serde_json::from_value::<LifeState>(state).map_err(|e| e.to_string())?;
    land.own_ids();
    Ok((state, land))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_save_from_before_land_had_rows_is_read_as_a_life_and_its_land() {
        let old = json!({
            "state": {
                "version": 3, "clock": 50.0, "coins": 12.0, "nextId": 9,
                "houses": [{ "id": 1, "plot": "rise-1", "blueprint": "cottage", "stage": 2, "taxPaidUntil": 99.0 }],
                "scarecrows": [{ "id": 2, "x": -208.0, "z": -240.0, "rot": 0.0, "cells": [null] }],
                "ships": [{ "id": 3, "slip": "lanternwick-slip", "design": "cog", "stage": 1 }],
                "packs": [{ "id": 4, "def": "flaxBale", "at": "ground", "x": 1.0, "z": 2.0 }],
                "vehicles": [{ "id": 5, "def": "farmCart", "x": 3.0, "z": 4.0, "cargo": [0, 0] }],
                "demand": { "westwatch:harvestCrate": 0.9 },
                "weather": { "rainUntil": 1.0, "nextRain": 2.0, "windDir": 0.5, "windSpeed": 0.7 }
            },
            "player": { "x": 0.0, "y": 0.0, "z": 0.0, "facing": 0.0 }
        });
        let (state, land) = read_saved(&old).unwrap();
        assert_eq!((state.coins, state.next_id), (12.0, 9));
        assert_eq!((land.houses.len(), land.scarecrows.len(), land.ships.len(), land.packs.len(), land.vehicles.len()), (1, 1, 1, 1, 1));
        assert_eq!(land.ids, Ids { next: 6, end: i64::MAX });
        // Kept now: the life alone, its land beside it. Read back the same.
        let now = json!({ "state": state, "land": land, "player": old["player"] });
        assert!(now["state"].get("houses").is_none() && now["state"].get("demand").is_none() && now["state"].get("weather").is_none());
        let (again, land_again) = read_saved(&now).unwrap();
        assert_eq!((again, land_again), (state, land));
    }

    #[test]
    fn each_piece_is_kept_by_the_chunk_it_stands_in() {
        let map = crate::open::map::world_map();
        let mut land = Land::default();
        land.vehicles.push(Vehicle { id: 5, def: "farmCart".into(), x: 300.0, z: -10.0, cargo: vec![6], ..Default::default() });
        land.packs.push(Pack { id: 6, def: "flaxBale".into(), at: "cargo".into(), vehicle: 5, x: -999.0, ..Default::default() });
        land.packs.push(Pack { id: 7, def: "flaxBale".into(), at: "ground".into(), x: -10.0, z: -300.0, ..Default::default() });
        land.packs.push(Pack { id: 8, def: "flaxBale".into(), at: "back".into(), ..Default::default() });
        land.houses.push(House { id: 1, plot: "rise-1".into(), blueprint: "cottage".into(), ..Default::default() });
        let rows = land.rows();
        let chunk = |id: i64| rows.iter().find(|r| r.id == id).unwrap().chunk;
        assert_eq!(chunk(5), Some((1, -1)));
        // In the cart's bed, where the cart is.
        assert_eq!(chunk(6), Some((1, -1)));
        assert_eq!(chunk(7), Some((-1, -2)));
        assert_eq!(chunk(8), None, "on its owner's back");
        let (hx, hz, _) = super::super::housing::house_pose(&land.houses[0]);
        assert_eq!(chunk(1), Some(map.chunk_of(hx, hz)));
        // Read back, the same land.
        let (again, bad) = Land::from_rows(rows.into_iter().map(|r| (r.kind, r.data)));
        assert!(bad.is_empty());
        assert_eq!((again.houses, again.vehicles, again.packs), (land.houses, land.vehicles, land.packs));
    }

    #[test]
    fn ids_come_from_the_run_a_holding_was_given() {
        let mut land = Land { ids: Ids { next: 100, end: 102 }, ..Land::default() };
        assert_eq!((land.new_id(), land.new_id(), land.new_id()), (Some(100), Some(101), None));
        land.packs.push(Pack { id: 41, ..Default::default() });
        land.own_ids();
        assert_eq!(land.new_id(), Some(42));
    }
}
