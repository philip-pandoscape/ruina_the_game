//! The database's tables kept in memory, for the tests (and a server started without one): the
//! same rows and the same rules the SQL keeps in Postgres (`store/mod.rs`, `store/land/`,
//! `directory/db.rs`), so a test holds the tiers to them without a database.

use std::collections::BTreeMap;

use serde_json::Value;

use ruina_world_api::Millis;
use ruina_world_api::store::{ClaimResult, LifeWrite, RegionLand, Transfer};

use super::land::{BLOCK, last_entry, split, waiting, without_ledger};
use crate::life::housing::neglected;
use crate::life::land::{House, Ids, Kind, Land};
use crate::life::market::Market;
use crate::life::state::Entry;

/// A character's row.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CharacterRow {
    pub name: String,
    pub life: Option<Value>,
    pub build: Option<Value>,
    pub saved_at: Option<Millis>,
    /// The character's grant: bumped by every claim and every move between simulations.
    pub epoch: u64,
    pub live_session: Option<i64>,
    /// Where their saved position is.
    pub space: Option<String>,
}

/// A space's lease.
#[derive(Clone, Debug, PartialEq)]
pub struct LeaseRow {
    pub sim: u64,
    pub holder: String,
    pub epoch: u64,
    pub expires_at: Millis,
}

/// A piece of land's row (migration 0010).
#[derive(Clone, Debug, PartialEq)]
pub struct LandRow {
    pub owner: i64,
    pub kind: Kind,
    pub chunk: Option<(i32, i32)>,
    pub data: Value,
    pub epoch: i64,
}

/// One character's side of a transfer, as the ledger keeps it (migration 0012).
#[derive(Clone, Debug, PartialEq)]
pub struct LedgerRow {
    pub character: i64,
    pub party: String,
    pub kind: String,
    pub coins: f64,
    pub seals: f64,
}

#[derive(Default, Debug)]
pub struct Tables {
    pub characters: BTreeMap<i64, CharacterRow>,
    pub leases: BTreeMap<String, LeaseRow>,
    /// The sequences' last values.
    pub sim_ids: u64,
    pub copy_numbers: u64,
    pub land_blocks: i64,
    /// Land, a row a piece, by id.
    pub land: BTreeMap<i64, LandRow>,
    /// House plots: plot -> (its holder, the house on it).
    pub plots: BTreeMap<String, (i64, i64)>,
    /// The ledger, by key.
    pub ledger: BTreeMap<String, LedgerRow>,
    /// The world's market.
    pub market: Market,
}

impl Tables {
    /// A character, as an account's first or a new one makes it.
    pub fn add_character(&mut self, id: i64, name: &str) {
        self.characters.insert(id, CharacterRow { name: name.to_string(), ..CharacterRow::default() });
    }

    /// A block of ids no other piece in the world has (`land::reserve_ids`).
    pub fn reserve_ids(&mut self) -> Ids {
        self.land_blocks += 1;
        Ids { next: self.land_blocks * BLOCK, end: (self.land_blocks + 1) * BLOCK }
    }

    /// Everything of one character's in the world (`land::load_holding`).
    pub fn holding(&self, owner: i64) -> Land {
        let rows = self.land.values().filter(|r| r.owner == owner).map(|r| (r.kind, r.data.clone()));
        Land::from_rows(rows).0
    }

    /// One character's land as it now is (`land::write_holding`): each piece's row, only ever its own
    /// owner's, and none of theirs it no longer has, their plots going with their houses. A house
    /// waiting for the registry is the claim's to write.
    pub fn write_holding(&mut self, owner: i64, epoch: i64, land: &Land) {
        let waiting = waiting(land);
        let rows = land.rows();
        for r in rows.iter().filter(|r| !(r.kind == Kind::House && waiting.contains(&r.id))) {
            if self.land.get(&r.id).is_some_and(|had| had.owner != owner) {
                continue;
            }
            self.land.insert(r.id, LandRow { owner, kind: r.kind, chunk: r.chunk, data: r.data.clone(), epoch });
        }
        let gone: Vec<i64> = self.land.iter().filter(|(id, row)| row.owner == owner && !rows.iter().any(|r| r.id == **id)).map(|(id, _)| *id).collect();
        self.remove_land(&gone);
    }

    /// Rows gone, and the plots whose houses they were.
    fn remove_land(&mut self, ids: &[i64]) {
        for id in ids {
            self.land.remove(id);
        }
        self.plots.retain(|_, (_, house)| !ids.contains(house));
    }

    /// A life's own entries, each once by its number (`ledger::record`).
    pub fn record(&mut self, character: i64, entries: &[Entry]) {
        for e in entries {
            let row = LedgerRow { character, party: e.party.clone(), kind: e.kind.clone(), coins: e.coins, seals: e.seals };
            self.ledger.entry(format!("life:{character}:{}", e.n)).or_insert(row);
        }
    }

    /// A life written under its grant, with the land lent to it and its ledger's entries
    /// (`land::save_in`). Whether it was.
    pub fn write_life(&mut self, w: &LifeWrite, now: Millis) -> bool {
        let Some(c) = self.characters.get_mut(&w.character) else { return false };
        if c.epoch != w.epoch.0 {
            return false;
        }
        let (life, land) = split(&w.life);
        let (life, entries) = without_ledger(&life);
        c.life = Some(life);
        c.saved_at = Some(now);
        c.space = Some(w.space.to_string());
        if let Some(land) = land {
            self.write_holding(w.character, w.epoch.0 as i64, &land);
        }
        self.record(w.character, &entries);
        true
    }

    /// A plot claimed with the house just put on it, first come (`plots::claim`).
    pub fn claim(&mut self, plot: &str, owner: i64, epoch: i64, house: &House) -> ClaimResult {
        if self.characters.get(&owner).is_none_or(|c| c.epoch as i64 != epoch) {
            return ClaimResult::Stale;
        }
        match self.plots.get(plot) {
            Some((holder, _)) if *holder != owner => {
                let name = self.characters.get(holder).map(|c| c.name.clone()).unwrap_or_default();
                ClaimResult::Theirs { holder: *holder, name }
            }
            _ => {
                let land = Land { houses: vec![house.clone()], ..Land::default() };
                for r in land.rows() {
                    self.land.insert(r.id, LandRow { owner, kind: r.kind, chunk: r.chunk, data: r.data, epoch });
                }
                self.plots.insert(plot.to_string(), (owner, house.id));
                ClaimResult::Yours
            }
        }
    }

    /// Houses taken down, each only if its tax is still unpaid too long at `at` (`plots::take_down`):
    /// the plots let go, with whose they were.
    pub fn take_down(&mut self, ids: &[i64], at: f64) -> Vec<(String, i64)> {
        let gone: Vec<i64> = ids
            .iter()
            .copied()
            .filter(|id| {
                self.land.get(id).is_some_and(|r| r.kind == Kind::House && serde_json::from_value::<House>(r.data.clone()).is_ok_and(|h| neglected(&h, at)))
            })
            .collect();
        let freed: Vec<(String, i64)> =
            self.plots.iter().filter(|(_, (_, house))| gone.contains(house)).map(|(plot, (holder, _))| (plot.clone(), *holder)).collect();
        self.remove_land(&gone);
        freed
    }

    /// Everyone's land in the world by owner, with their names, who holds each plot, and the market.
    pub fn region_land(&self) -> RegionLand {
        let mut owners: Vec<i64> = self.land.values().map(|r| r.owner).collect();
        owners.sort_unstable();
        owners.dedup();
        let name = |id: &i64| self.characters.get(id).map(|c| c.name.clone()).unwrap_or_default();
        RegionLand {
            holdings: owners.iter().map(|o| (*o, name(o), serde_json::to_value(self.holding(*o)).unwrap_or(Value::Null))).collect(),
            claims: self.plots.iter().map(|(plot, (holder, _))| (plot.clone(), *holder, name(holder))).collect(),
            market: serde_json::to_value(&self.market).unwrap_or(Value::Null),
        }
    }

    /// A transfer and the lives it changes, at once, once (`ledger::transfer`): which lives were
    /// written, or None if it was before.
    pub fn transfer(&mut self, t: &Transfer, writes: &[LifeWrite], now: Millis) -> Option<Vec<bool>> {
        if t.sides.iter().any(|(c, _, _)| self.ledger.contains_key(&format!("{}:{c}", t.key))) {
            return None;
        }
        for (character, party, coins) in &t.sides {
            let row = LedgerRow { character: *character, party: party.clone(), kind: t.kind.clone(), coins: *coins, seals: 0.0 };
            self.ledger.insert(format!("{}:{character}", t.key), row);
        }
        Some(writes.iter().map(|w| self.write_life(w, now)).collect())
    }

    /// The ledger's entries a life holds that are written now that it is: the last one's number.
    pub fn recorded(w: &LifeWrite) -> Option<u64> {
        last_entry(&w.life)
    }
}
