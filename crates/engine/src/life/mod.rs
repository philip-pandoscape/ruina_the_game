//! The open-world systems: trade, farming, housing, vehicles and quests. A character's life (what
//! is theirs alone: crate::life::state) and their land (what they've built and planted in the
//! world: crate::life::land) change only here: the browser sends key presses and commands, the
//! server runs them through these rules, and what comes out is what is kept in Postgres and shown to
//! everyone. The browser runs the same rules through the WebAssembly to run its commands ahead and
//! to play offline.
//!
//! A Life changes only inside step(), from the commands queued since the last one, so the same
//! commands on the same frames always give the same life and land.

pub mod content;
pub mod contracts;
pub mod farming;
pub mod housing;
pub mod interact;
pub mod land;
pub mod livestock;
pub mod market;
pub mod progress;
pub mod quests;
pub mod shipyard;
pub mod state;
pub mod trade;
pub mod vehicles;
pub mod weather;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::open::zone::Zone;
use crate::open::{OpenWorld, Sim};
use crate::player::{Actions, Mode, Player};
use content::{ItemCount, bag_slots, item_def, labor};
use land::{Change, Land};
use market::Market;
use state::{LIFE_VERSION, LifeState, Weather, new_life_state};

/// One fixed step of the rules (shared/tuning.json's simHz).
pub fn step_seconds() -> f64 {
    1.0 / crate::tuning::tuning().sim_hz
}

/// What a browser can ask the island to do (src/engine/life/life.ts Command). `grant` and `warp` are
/// the developer panel's, and only run where the server allows the panel.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Command {
    Interact,
    Drop,
    Mount,
    Glider,
    Exit,
    CycleSeed,
    Use {
        item: String,
    },
    Buy {
        npc: String,
        item: String,
        n: i64,
    },
    Sell {
        npc: String,
        item: String,
        n: i64,
    },
    Buyback {
        npc: String,
        item: String,
        n: i64,
    },
    Craft {
        recipe: String,
    },
    Accept {
        quest: String,
    },
    Complete {
        quest: String,
    },
    Abandon {
        quest: String,
    },
    Summon {
        item: String,
    },
    Recall {
        vehicle: i64,
    },
    CancelPlace,
    Store {
        house: i64,
        item: String,
        n: i64,
    },
    Take {
        house: i64,
        item: String,
        n: i64,
    },
    PayTax {
        house: i64,
    },
    Rest,
    Contract {
        id: i64,
    },
    Gust,
    Grant {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        n: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        coins: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seals: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        labor: Option<f64>,
    },
    Warp {
        seconds: f64,
    },
    /// The developer panel's teleport. Offline the page moves you there itself; online only the
    /// server can, so the channel handles it before the island.
    Teleport {
        x: f64,
        z: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        facing: Option<f64>,
    },
    /// Ride along in another player's vehicle (`host` is their character). Their vehicle isn't on
    /// your island, so the channel seats you before it gets there.
    Ride {
        host: i64,
        vehicle: i64,
    },
    /// The developer panel's bots: `n` more round you with `brain` (crate::bots; a skirmisher by
    /// default) on `team` (yours by default), or with `n` 0 every bot here gone. Channel-wide, like
    /// teleporting: the channel handles it before the island.
    Bots {
        n: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        brain: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        team: Option<u8>,
    },
}

impl Command {
    /// The developer panel's commands: giving yourself things, skipping time, teleporting, bots.
    pub fn is_dev(&self) -> bool {
        matches!(self, Command::Grant { .. } | Command::Warp { .. } | Command::Teleport { .. } | Command::Bots { .. })
    }
}

/// Something that happened, for the browser to show (src/engine/life/life.ts LifeEvent).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum LifeEvent {
    /// kind: good, bad, info, coin or quest.
    Toast {
        text: String,
        kind: String,
    },
    /// ui: dialog, shop, craft or storage.
    Open {
        ui: String,
        id: String,
    },
    Sold {
        pack: String,
        coins: f64,
        seals: f64,
        demand: f64,
        fresh: f64,
        outpost: String,
    },
    Harvest {
        x: f64,
        y: f64,
        z: f64,
    },
    Build {
        house: i64,
        stage: i64,
        x: f64,
        z: f64,
    },
    Gather {
        x: f64,
        y: f64,
        z: f64,
        kind: String,
    },
    /// what: accepted, step, ready or done.
    Quest {
        id: String,
        what: String,
    },
    Thunder {
        x: f64,
        y: f64,
        z: f64,
    },
}

/// Something quests count (src/engine/life/quests.ts QuestEvent).
#[derive(Clone, Debug, Default)]
pub struct QuestEvent {
    pub type_: String,
    pub npc: Option<String>,
    pub crop: Option<String>,
    pub pack: Option<String>,
    pub outpost: Option<String>,
    pub vehicle: Option<String>,
    pub item: Option<String>,
    pub kind: Option<String>,
    pub place: Option<String>,
    pub amount: Option<f64>,
}

impl QuestEvent {
    pub fn new(type_: &str) -> Self {
        QuestEvent { type_: type_.to_string(), ..Default::default() }
    }
}

/// What pressing F does right now (src/engine/life/interact.ts Focus).
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Focus {
    pub action: String,
    pub key: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub ok: bool,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub npc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bench: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pack: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vehicle: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sc: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell: Option<i64>,
    /// The gathering spot it's at, by id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub house: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slip: Option<String>,
    /// A dungeon's portal, going in or coming out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dungeon: Option<String>,
    /// Online, whose vehicle you'd ride along in (their character).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<i64>,
    /// Online, the player you'd challenge to a mini-game.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other: Option<i64>,
}

/// Another player's vehicle as you see it online: whose (their character and name), and the seats
/// taken in it (src/engine/life/life.ts OthersVehicle).
#[derive(Deserialize, Clone, Debug)]
pub struct OthersVehicle {
    pub host: i64,
    pub name: String,
    pub vehicle: land::Vehicle,
    pub taken: Vec<i64>,
}

/// Another player near you online, whom the prompt can offer to challenge to a mini-game
/// (src/engine/life/life.ts OtherPlayer).
#[derive(Deserialize, Clone, Debug)]
pub struct OtherPlayer {
    pub id: i64,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// Why they can't be challenged right now ("Riding", "At a Table"...), or none.
    #[serde(default)]
    pub busy: Option<String>,
}

/// A scarecrow being walked to its spot (src/engine/life/interact.ts Placement).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Placement {
    pub item: String,
    pub x: f64,
    pub z: f64,
    pub rot: f64,
    pub problem: Option<String>,
}

/// One character's life (their own state), the land of theirs they're tending, and what is going on
/// around them right now.
pub struct Life {
    pub state: LifeState,
    /// Their land: houses, farms, ships on the slipways, packs and vehicles, wherever each stands.
    /// It's the world's (crate::life::land), lent to the life while its character plays: only they
    /// change it, through these rules.
    pub land: Land,
    /// The trading posts' demand as the world had it when this step began (crate::life::market):
    /// a sale here lowers it here at once, and goes to whoever keeps the world's (`changes`).
    pub market: Market,
    /// The weather where you are this step, worked out from the world's clock (crate::life::weather).
    pub weather: Weather,
    pub zone: &'static Zone,
    pub focus: Option<Focus>,
    pub placing: Option<Placement>,
    /// Bumped whenever something drawn from the state (farms, houses, packs) changes shape.
    pub revision: u64,
    /// True for the moment you are resting in your own bed.
    pub resting: bool,
    /// Plots other characters hold: plot id -> their name. A plot someone else holds can't be
    /// claimed.
    pub plot_owners: BTreeMap<String, String>,
    /// Online: the world's clock (the server's, in seconds since 1970), set by the channel each
    /// tick, which the rain and the wind run on so that everyone has the same weather
    /// (weather.rs). None runs them on the island's own clock (the rules' checks, tests).
    pub world_clock: Option<f64>,
    /// The dungeon or developer zone you're in a copy of (the browser's session; the server plays
    /// each copy as a channel of its own).
    pub dungeon: Option<String>,
    /// The browser's copy of an island the server runs (crate::session online): commands go to the
    /// server rather than running here (the page sends them), nothing is said here (only the
    /// server's island speaks), and a step only moves on what moves with you between its updates.
    pub remote: bool,
    /// Online, everyone else's vehicles where they're drawn, for the prompt to offer to ride along.
    pub others_vehicles: Vec<OthersVehicle>,
    /// Online, everyone else in your channel, for the prompt to offer a mini-game.
    pub others_around: Vec<OtherPlayer>,
    /// Online, a plot claimed here waits for the registry to confirm it (housing::confirm_claim)
    /// before anything is built on it. Offline the browser's session is the registry: claims hold at once.
    pub claims_wait: bool,
    queue: Vec<Command>,
    events: Vec<LifeEvent>,
    /// What steps did that whoever keeps the world's land and market must hear (`take_changes`).
    changes: Vec<Change>,
}

impl Life {
    /// A new island, with the start-of-game money and labor (tests can be generous).
    pub fn new(zone: &'static Zone, coins: Option<f64>, start_labor: Option<f64>) -> Life {
        let state = new_life_state(coins.unwrap_or(200.0), start_labor.unwrap_or(labor().start), zone.recipe.seed);
        let mut life = Life {
            state,
            land: Land::default(),
            market: Market::default(),
            weather: Weather::initial(),
            zone,
            focus: None,
            placing: None,
            revision: 0,
            resting: false,
            plot_owners: BTreeMap::new(),
            world_clock: None,
            dungeon: None,
            remote: false,
            others_vehicles: Vec::new(),
            others_around: Vec::new(),
            claims_wait: false,
            queue: Vec::new(),
            events: Vec::new(),
            changes: Vec::new(),
        };
        // The first quest is waiting the moment you arrive.
        quests::start_quests(&mut life);
        life
    }

    /// Makes the land's houses and farm posts solid in `world` as far as they're built, its ground
    /// cleared (each piece once: `OpenWorld::added`), under the character `owner`. A step that builds
    /// changes only the life and its land, which bumps its `revision`: whoever stepped it makes the
    /// building solid once the step is over (crate::combat once everyone in a channel has stepped,
    /// the browser's session after its own), so the world is the same for everyone while they step.
    pub fn make_solid(&self, world: &mut OpenWorld, owner: i64) {
        self.land.make_solid(world, owner);
    }

    /// What the steps since the last time did that the keeper of the world's land and market must
    /// hear: plots claimed and let go, packs sold.
    pub fn take_changes(&mut self) -> Vec<Change> {
        std::mem::take(&mut self.changes)
    }

    /// Something the keeper of the world's land and market must hear (`take_changes`). A remote
    /// life (the browser's copy of one the server runs) tells nobody: the server's does.
    pub fn change(&mut self, c: Change) {
        if !self.remote {
            self.changes.push(c);
        }
    }

    /// Squares the player with the life after a reset or a load: a pack the land says is on your
    /// back is on your back, nobody is left sitting in a vehicle, and your glider is yours.
    pub fn after_reset(&mut self, p: &mut Player) {
        p.pack = self.land.packs.iter().find(|pk| pk.at == "back").map(|pk| pk.id).unwrap_or(0);
        p.vehicle = 0;
        p.seat = 0;
        p.host = 0;
        p.glider = self.state.glider.clone();
        for v in &mut self.land.vehicles {
            v.ridden = false;
        }
        self.placing = None;
        self.resting = false;
    }

    /// Replaces the whole life and its land (loading a saved one), filling in what an older one
    /// lacks. The land keeps the run of ids it was given, if it was given one (online); otherwise it
    /// counts on from the highest it has.
    pub fn load(&mut self, mut state: LifeState, mut land: Land) {
        state.version = LIFE_VERSION;
        if land.ids == land::Ids::default() {
            land.own_ids();
        }
        self.land = land;
        // Gathering spots were kept by their place in the island's list before they had ids: those,
        // and any spot the world no longer has, are simply back.
        let world = crate::open::map::world_map();
        state.nodes.retain(|id, _| world.recipes().any(|r| r.nodes.iter().any(|n| n.id == *id)));
        self.state = state;
        self.revision += 1;
        quests::start_quests(self);
    }

    pub fn command(&mut self, c: Command) {
        // A remote island's commands are the server's to run (the page sends them there).
        if self.remote {
            return;
        }
        if self.queue.len() < 64 {
            self.queue.push(c);
        }
    }

    pub fn drain_events(&mut self) -> Vec<LifeEvent> {
        std::mem::take(&mut self.events)
    }

    pub fn emit(&mut self, e: LifeEvent) {
        // Online only the server's island speaks: what this copy predicts would say everything twice.
        if self.remote {
            return;
        }
        self.events.push(e);
        if self.events.len() > 200 {
            self.events.remove(0);
        }
    }

    /// kind: good, bad, info, coin or quest.
    pub fn toast(&mut self, text: impl Into<String>, kind: &str) {
        self.emit(LifeEvent::Toast { text: text.into(), kind: kind.to_string() });
    }

    /// Quest progress from anything that happened.
    pub fn notify(&mut self, e: QuestEvent) {
        quests::notify_quests(self, &e);
    }

    // ---------- What the player's step asks of the island ----------

    /// Steps the vehicle you are riding, with your controls.
    pub fn ride(&mut self, sim: &mut Sim, a: &Actions) {
        vehicles::ride_vehicle(self, sim, a);
    }

    /// Something the player did (a hit landed, a cast, a roll): the skill behind it gains
    /// experience; or a creature they finished off, for the quests. True if a skill went up a
    /// level, so the player's numbers need working out again (progress::sync_levels).
    pub fn observe(&mut self, e: progress::Observed) -> bool {
        progress::observe(self, e)
    }

    /// Everything else on the island, once per step, after you have moved.
    pub fn step(&mut self, sim: &mut Sim, a: &Actions) {
        let dt = step_seconds();
        progress::sync_levels(self, sim.player);
        // Keep the glider you own on your back.
        if sim.player.glider != self.state.glider {
            sim.player.glider = self.state.glider.clone();
        }
        if self.remote {
            // Between the server's updates, only what moves with you: the clock, your labor, the
            // rain and the wind (from the world's clock, as the server works them out), your vehicles.
            self.state.clock += dt;
            let resting = self.resting;
            self.regen_labor(dt, resting, false);
            weather::step_weather(self, dt);
            vehicles::step_vehicles(self, sim, a);
            return;
        }
        for c in std::mem::take(&mut self.queue) {
            interact::run_command(self, sim, &c);
        }
        self.state.clock += dt;
        interact::keep_resting(self, sim);
        let resting = self.resting;
        self.regen_labor(dt, resting, false);
        weather::step_weather(self, dt);
        farming::step_farms(self, dt);
        contracts::step_contracts(self);
        vehicles::step_vehicles(self, sim, a);
        housing::step_housing(self);
        quests::step_quests(self, sim);
        trade::step_buyback(self, sim);
        if sim.player.mode == Mode::Glide {
            self.state.stats.glide_seconds += dt;
        }
        // The focus, for the prompt on screen, is the page's session's to work out (crate::session);
        // the server has no screen, and an interaction works it out afresh anyway.
    }

    pub fn regen_labor(&mut self, seconds: f64, resting: bool, offline: bool) {
        let l = labor();
        let per_min = if offline { l.offline_per_minute } else { l.per_minute * if resting { l.rest_multiplier } else { 1.0 } };
        self.state.labor = l.max.min(self.state.labor + per_min * seconds / 60.0);
    }

    // ---------- Randomness: the island's own stream, saved with it ----------

    /// mulberry32 on the island's own seed.
    pub fn rand(&mut self) -> f64 {
        crate::rng::mulberry32(&mut self.state.rng)
    }

    pub fn rand_int(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.rand() * (hi - lo + 1) as f64).floor() as i64
    }

    pub fn next_id(&mut self) -> i64 {
        let id = self.state.next_id;
        self.state.next_id += 1;
        id
    }

    // ---------- The bag ----------

    pub fn count(&self, item: &str) -> i64 {
        self.state.bag.iter().filter(|s| s.item == item).map(|s| s.n).sum()
    }

    /// Slots the bag would need after adding n of item.
    fn slots_after(&self, item: &str, n: i64) -> i64 {
        let def = item_def(item);
        let (mut used, mut have) = (0i64, 0i64);
        for s in &self.state.bag {
            if s.item == item {
                have += s.n;
            } else {
                used += 1;
            }
        }
        // Saturating: n can come straight from a browser (buy), and an absurd one just doesn't fit.
        used.saturating_add((have.saturating_add(n) as f64 / def.stack.max(1) as f64).ceil() as i64)
    }

    pub fn has_room(&self, item: &str, n: i64) -> bool {
        self.slots_after(item, n) <= bag_slots() as i64
    }

    /// Adds to the bag; returns how many did not fit.
    pub fn give(&mut self, item: &str, n: i64, quiet: bool) -> i64 {
        if n <= 0 {
            return 0;
        }
        let def = item_def(item);
        let stack = def.stack.max(1);
        let mut left = n;
        for s in self.state.bag.iter_mut() {
            if s.item != item || s.n >= stack {
                continue;
            }
            let put = left.min(stack - s.n);
            s.n += put;
            left -= put;
            if left == 0 {
                break;
            }
        }
        while left > 0 && self.state.bag.len() < bag_slots() {
            let put = left.min(stack);
            self.state.bag.push(state::Stack { item: item.to_string(), n: put });
            left -= put;
        }
        let got = n - left;
        if got != 0 && !quiet {
            self.toast(format!("+{got} {} {}", def.icon, def.name), "good");
        }
        if left != 0 {
            self.toast(format!("Your bag is full - {left} {} left behind", def.name), "bad");
        }
        if got != 0 && def.cat == "seed" && self.state.seed.is_empty() {
            self.state.seed = item.to_string();
        }
        left
    }

    /// Removes from the bag if there are enough; false (and nothing removed) otherwise.
    pub fn take(&mut self, item: &str, n: i64) -> bool {
        if self.count(item) < n {
            return false;
        }
        let mut left = n;
        let bag = &mut self.state.bag;
        let mut i = bag.len();
        while i > 0 && left > 0 {
            i -= 1;
            if bag[i].item != item {
                continue;
            }
            let out = left.min(bag[i].n);
            bag[i].n -= out;
            left -= out;
            if bag[i].n <= 0 {
                bag.remove(i);
            }
        }
        true
    }

    pub fn take_all(&mut self, list: Option<&Vec<ItemCount>>) -> bool {
        let Some(list) = list else { return true };
        if list.iter().any(|s| self.count(&s.item) < s.n) {
            return false;
        }
        for s in list {
            self.take(&s.item, s.n);
        }
        true
    }

    /// Spends money and labor if you have it all; otherwise says what is missing and spends nothing.
    pub fn afford(&mut self, coins: f64, seals: f64, labor: f64, what: &str) -> bool {
        let s = &self.state;
        if coins > s.coins {
            self.toast(format!("Not enough coin to {what}"), "bad");
            return false;
        }
        if seals > s.seals {
            self.toast(format!("Not enough Charter Seals to {what}"), "bad");
            return false;
        }
        if labor > s.labor + 1e-6 {
            self.toast(format!("Too tired - not enough labor to {what}"), "bad");
            return false;
        }
        let s = &mut self.state;
        s.coins -= coins;
        s.seals -= seals;
        s.labor -= labor;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open::zone::emberholm;

    #[test]
    fn the_bag_stacks_fills_and_empties() {
        let mut life = Life::new(emberholm(), None, None);
        assert_eq!(life.give("seed.sunroot", 5, true), 0);
        assert_eq!(life.count("seed.sunroot"), 5);
        assert!(life.take("seed.sunroot", 3));
        assert!(!life.take("seed.sunroot", 3));
        assert_eq!(life.count("seed.sunroot"), 2);
    }

    #[test]
    fn rand_is_the_browsers_mulberry32() {
        let mut life = Life::new(emberholm(), None, None);
        life.state.rng = 1;
        // rng() from src/util/rng.ts seeded with 1 (makeRng(1)()).
        let first = life.rand();
        assert!((first - 0.6270739405881613).abs() < 1e-15, "{first}");
    }

    #[test]
    fn commands_read_as_the_browser_sends_them() {
        let c: Command = serde_json::from_str(r#"{"t":"buy","npc":"mara","item":"seed.sunroot","n":3}"#).unwrap();
        assert_eq!(c, Command::Buy { npc: "mara".into(), item: "seed.sunroot".into(), n: 3 });
        let c: Command = serde_json::from_str(r#"{"t":"cycleSeed"}"#).unwrap();
        assert_eq!(c, Command::CycleSeed);
        let c: Command = serde_json::from_str(r#"{"t":"buyback","npc":"mara","item":"sunroot","n":2}"#).unwrap();
        assert_eq!(c, Command::Buyback { npc: "mara".into(), item: "sunroot".into(), n: 2 });
        let c: Command = serde_json::from_str(r#"{"t":"abandon","quest":"patch"}"#).unwrap();
        assert_eq!(c, Command::Abandon { quest: "patch".into() });
        assert!(!c.is_dev());
        assert!(serde_json::from_str::<Command>(r#"{"t":"buy","npc":"mara","item":"x","n":1.5}"#).is_err());
        let c: Command = serde_json::from_str(r#"{"t":"grant","coins":500}"#).unwrap();
        assert!(c.is_dev());
    }
}
