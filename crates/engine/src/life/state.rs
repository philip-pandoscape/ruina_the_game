//! Everything the open-world systems remember: money, labor, the bag, every trade pack, summoned
//! vehicles, farms, houses, demand at the trading posts, quests and weather. Its JSON is the page's
//! LifeState (src/engine/life/state.ts) field for field, so the islands kept in Postgres load as they
//! are and the browser reads what the server sends without translation.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Stack {
    pub item: String,
    pub n: i64,
}

/// A trade or material pack: on a back, on the ground, or in cargo. Never in the bag.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Pack {
    pub id: i64,
    pub def: String,
    /// World clock when it was made, for freshness.
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
    /// Livestock: world clock until which it is fed.
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
    /// World clock up to which property tax is paid.
    pub tax_paid_until: f64,
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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct QuestProgress {
    pub id: String,
    pub step: i64,
    /// Per objective of the current step (seconds, for gliding).
    pub counts: Vec<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Quests {
    pub active: Vec<QuestProgress>,
    pub done: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct Weather {
    pub rain_until: f64,
    pub next_rain: f64,
    /// Direction the wind blows toward (radians, 0 = +Z) and its strength 0..1.
    pub wind_dir: f64,
    pub wind_speed: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub delivered: f64,
    pub earned: f64,
    pub harvested: f64,
    pub glide_seconds: f64,
    pub built: f64,
}

/// A trading post's request for packs (src/engine/life/contracts.ts).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct Contract {
    pub id: i64,
    pub outpost: String,
    pub pack: String,
    pub count: i64,
    pub delivered: i64,
    pub bonus_coins: f64,
    pub bonus_seals: f64,
    /// World clock when it lapses.
    pub expires: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct ContractState {
    pub offered: Vec<Contract>,
    pub active: Vec<Contract>,
    pub next_refresh: f64,
}

/// Something you sold, which that merchant sells you back at what they paid until you walk off.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Buyback {
    pub npc: String,
    pub item: String,
    pub n: i64,
    /// Coins each, what the merchant paid.
    pub price: f64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Home {
    pub x: f64,
    pub z: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct LifeState {
    pub version: i64,
    /// World seconds since this island began.
    pub clock: f64,
    pub coins: f64,
    /// Coins on a table for a game being played (crates/server/src/sim/tables.rs): out of the
    /// purse until the game pays out. An island loaded with some still here gets them back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staked: Option<f64>,
    pub seals: f64,
    pub labor: f64,
    pub bag: Vec<Stack>,
    /// The glider you fly, "" for none.
    pub glider: String,
    /// The seed F plants.
    pub seed: String,
    pub packs: Vec<Pack>,
    pub vehicles: Vec<Vehicle>,
    pub scarecrows: Vec<Scarecrow>,
    pub houses: Vec<House>,
    #[serde(default)]
    pub ships: Vec<ShipBuild>,
    /// Vehicles being repaired after breaking up: vehicle def -> world clock when ready.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repairs: Option<BTreeMap<String, f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contracts: Option<ContractState>,
    /// What you sold to merchants and can still buy back from them, oldest first (crate::life::trade).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buyback: Option<Vec<Buyback>>,
    /// Demand multiplier per "outpost:pack".
    pub demand: BTreeMap<String, f64>,
    /// Gathering spots resting: the spot's id -> the island's clock when it is back.
    pub nodes: BTreeMap<String, f64>,
    pub quests: Quests,
    /// Experience of each skill in the skill book, by its id (crate::life::progress). An island
    /// saved before skills levelled has none: everything at level 1.
    pub skill_xp: BTreeMap<String, f64>,
    pub weather: Weather,
    #[serde(default)]
    pub stats: Stats,
    /// Where you wake after a rest; null for the zone's spawn.
    pub home: Option<Home>,
    pub next_id: i64,
    pub rng: u32,
}

pub const LIFE_VERSION: i64 = 3;

pub fn new_life_state(coins: f64, labor: f64, seed: u32) -> LifeState {
    LifeState {
        version: LIFE_VERSION,
        clock: 0.0,
        coins,
        staked: None,
        seals: 0.0,
        labor,
        bag: Vec::new(),
        glider: String::new(),
        seed: String::new(),
        packs: Vec::new(),
        vehicles: Vec::new(),
        scarecrows: Vec::new(),
        houses: Vec::new(),
        ships: Vec::new(),
        repairs: None,
        contracts: None,
        buyback: None,
        demand: BTreeMap::new(),
        nodes: BTreeMap::new(),
        quests: Quests::default(),
        skill_xp: BTreeMap::new(),
        weather: Weather { rain_until: 0.0, next_rain: 240.0, wind_dir: 0.9, wind_speed: 0.8 },
        stats: Stats::default(),
        home: None,
        next_id: 1,
        rng: if seed == 0 { 1 } else { seed },
    }
}

impl Default for LifeState {
    fn default() -> Self {
        new_life_state(0.0, 0.0, 1)
    }
}
