//! A character's life: what is theirs alone and goes where they go (money, labor, the bag, quests,
//! skills, contracts, what they sold and can buy back). What they've built and planted in the world
//! is land (crate::life::land), and what the world shares (each trading post's demand, the weather)
//! is the world's (crate::life::market, crate::life::weather). Its JSON is the page's LifeState
//! (src/engine/life/state.ts) field for field, so the browser reads what the server sends without
//! translation.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Stack {
    pub item: String,
    pub n: i64,
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

/// The weather where you are, worked out from the world's clock each step (crate::life::weather):
/// the same for everyone in a region at the same moment, and never kept with a life.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct Weather {
    /// On the life's clock (`LifeState::clock`), like everything that asks about the rain.
    pub rain_until: f64,
    pub next_rain: f64,
    /// Direction the wind blows toward (radians, 0 = +Z) and its strength 0..1.
    pub wind_dir: f64,
    pub wind_speed: f64,
}

impl Weather {
    /// Before the first step has worked it out.
    pub fn initial() -> Weather {
        Weather { rain_until: 0.0, next_rain: 240.0, wind_dir: 0.9, wind_speed: 0.8 }
    }
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

/// Value that moved between this life and the world (a purchase, a sale, a payout, a fee, a tax, a
/// quest's reward), from this life's side: what it gained (negative for what it gave). Kept with the
/// life until the store has written it in the ledger with a save (crates/server/src/store/land/ledger.rs),
/// numbered by the life's own count (`n`), so one written twice is recorded once.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Entry {
    pub n: u64,
    /// purchase, sale, buyback, payout, bonus, fee, craft, tax, reward or grant.
    pub kind: String,
    /// Who it was with: "vendor:<npc>", "post:<outpost>", "bench:<id>", "registry", "quest:<id>", "world".
    pub party: String,
    pub coins: f64,
    pub seals: f64,
    /// Items gained (a negative count for those given).
    pub items: Vec<Stack>,
    /// What it was for, where the rest doesn't say (the pack sold, the house taxed, the recipe made).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
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
    /// Seconds this life has been lived: it runs while its character plays and, when they come back,
    /// catches up the time they were away (up to trade.json's clock.maxOfflineSeconds).
    pub clock: f64,
    pub coins: f64,
    /// Coins on a table for a game being played (crates/server/src/sim/tables.rs): out of the
    /// purse until the game pays out. A life loaded with some still here gets them back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staked: Option<f64>,
    pub seals: f64,
    pub labor: f64,
    pub bag: Vec<Stack>,
    /// The glider you fly, "" for none.
    pub glider: String,
    /// The seed F plants.
    pub seed: String,
    /// Vehicles being repaired after breaking up: vehicle def -> world clock when ready.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repairs: Option<BTreeMap<String, f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contracts: Option<ContractState>,
    /// What you sold to merchants and can still buy back from them, oldest first (crate::life::trade).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buyback: Option<Vec<Buyback>>,
    /// Gathering spots resting: the spot's id -> the island's clock when it is back.
    pub nodes: BTreeMap<String, f64>,
    pub quests: Quests,
    /// Experience of each skill in the skill book, by its id (crate::life::progress). An island
    /// saved before skills levelled has none: everything at level 1.
    pub skill_xp: BTreeMap<String, f64>,
    #[serde(default)]
    pub stats: Stats,
    /// What the ledger hasn't had yet: value moved with the world since the store last wrote it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ledger: Vec<Entry>,
    /// How many entries this life has made: the next one is numbered one more.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub entries: u64,
    /// Where you wake after a rest; null for the zone's spawn.
    pub home: Option<Home>,
    pub next_id: i64,
    pub rng: u32,
}

/// 4: the life alone, its land kept beside it (crate::life::land); 3 and before held the land too,
/// read apart by crate::life::land::read_saved.
pub const LIFE_VERSION: i64 = 4;

fn is_zero(n: &u64) -> bool {
    *n == 0
}

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
        repairs: None,
        contracts: None,
        buyback: None,
        nodes: BTreeMap::new(),
        quests: Quests::default(),
        skill_xp: BTreeMap::new(),
        stats: Stats::default(),
        ledger: Vec::new(),
        entries: 0,
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
