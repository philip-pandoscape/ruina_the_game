//! The region's land as a simulation shows it (R10.21): everyone's who has land in the world, by
//! owner, and who holds each house plot, as the store read them when the simulation started
//! (`ToSim::Land`) and as they've changed here since.
//!
//! - **Lent and kept.** A player's land is lent to their life while they play here (it goes where
//!   they go, and only they change it); everyone else's is kept here for them. What's built of it
//!   stands (houses, farms and ships on the slipways, drawn and solid); packs left on the ground and
//!   vehicles left out are kept with it, shared by every channel as all land is, and drawn with their
//!   owner while they play.
//! - **Plots** are the registry's (the store's): a claim is decided there, first come in the whole
//!   world. Here is who holds what as this simulation last heard: a claim made here counts at once,
//!   until the registry says otherwise.
//! - **Neglect.** Every channel runs the same rule over the land it keeps for those away, on the
//!   world's clock, so a house whose tax went unpaid too long comes down in each at the same moment;
//!   the region's keeper (its first channel) writes it (`ToStore::TakeDown`).

use std::collections::BTreeMap;

use serde_json::{Value, json};

use ruina_world_api::CharacterId;
use ruina_world_api::store::RegionLand;

use crate::life::housing::demolish_neglected;
use crate::life::land::{House, Land};
use crate::life::market::Market;
use crate::sim::channels::estate_of;

/// Someone's land kept here while they're away.
pub struct Holding {
    pub name: String,
    pub land: Land,
}

#[derive(Default)]
pub struct Lands {
    /// The land of everyone not playing here: kept for them.
    pub away: BTreeMap<CharacterId, Holding>,
    /// What everyone here is shown of each owner's land (from their life while they play here): their
    /// estate, with their name.
    pub estates: BTreeMap<CharacterId, (String, Value)>,
    /// Who holds each house plot: plot -> (holder, their name).
    pub claims: BTreeMap<String, (CharacterId, String)>,
    /// Whether the store has said what there is yet.
    pub loaded: bool,
}

impl Lands {
    /// The land as the store read it: everyone's (nobody plays here yet), the plots' claims, and the
    /// world's market.
    pub fn read(r: RegionLand) -> (Lands, Market) {
        let mut lands = Lands { loaded: true, ..Lands::default() };
        for (owner, name, v) in r.holdings {
            match serde_json::from_value::<Land>(v) {
                Ok(land) => {
                    lands.keep(owner, &name, land);
                }
                Err(e) => eprintln!("character {owner}'s land can't be read ({e}): it isn't shown"),
            }
        }
        lands.claims = r.claims.into_iter().map(|(plot, holder, name)| (plot, (holder, name))).collect();
        let market = serde_json::from_value(r.market).unwrap_or_default();
        (lands, market)
    }

    /// Someone's land, kept here for them while they're away (they left, or never came). True if what
    /// everyone is shown of it changed.
    pub fn keep(&mut self, owner: CharacterId, name: &str, land: Land) -> bool {
        let changed = self.set_estate(owner, name, estate_of(&land));
        if land.is_empty() {
            self.away.remove(&owner);
        } else {
            self.away.insert(owner, Holding { name: name.to_string(), land });
        }
        changed
    }

    /// Someone's land, lent to their life as they come to play here: kept here no longer. What was
    /// kept, if anything.
    pub fn lend(&mut self, owner: CharacterId) -> Option<Land> {
        self.away.remove(&owner).map(|h| h.land)
    }

    /// Someone's estate as it now is. True if it changed. (Nothing is kept for someone with nothing
    /// built who had nothing shown.)
    pub fn set_estate(&mut self, owner: CharacterId, name: &str, estate: Value) -> bool {
        match self.estates.get(&owner) {
            Some((n, e)) if *e == estate && n == name => false,
            None if empty(&estate) => false,
            _ => {
                self.estates.insert(owner, (name.to_string(), estate));
                true
            }
        }
    }

    /// Plot -> holder's name, as browsers are told.
    pub fn claims_json(&self) -> Value {
        Value::Object(self.claims.iter().map(|(plot, (_, name))| (plot.clone(), Value::String(name.clone()))).collect())
    }

    /// The plots held by anyone but `who`, with the holder's name (what a Life's plot_owners holds).
    pub fn held_by_others(&self, who: CharacterId) -> BTreeMap<String, String> {
        self.claims.iter().filter(|(_, (holder, _))| *holder != who).map(|(plot, (_, name))| (plot.clone(), name.clone())).collect()
    }

    /// Everyone's estate but `except`'s, as a welcome carries them.
    pub fn estates_json(&self, except: CharacterId) -> Value {
        Value::Array(
            self.estates.iter().filter(|(id, _)| **id != except).map(|(id, (name, estate))| json!({ "id": id, "name": name, "estate": estate })).collect(),
        )
    }

    /// `plot` held by `holder`. True if that's news.
    pub fn claimed(&mut self, plot: &str, holder: CharacterId, name: &str) -> bool {
        if self.claims.get(plot).is_some_and(|(h, n)| *h == holder && n == name) {
            return false;
        }
        self.claims.insert(plot.to_string(), (holder, name.to_string()));
        true
    }

    /// `plot` let go by `holder` (their house on it taken down). True if it was theirs.
    pub fn freed(&mut self, plot: &str, holder: CharacterId) -> bool {
        if !self.claims.get(plot).is_some_and(|(h, _)| *h == holder) {
            return false;
        }
        self.claims.remove(plot);
        true
    }

    /// Someone gone for good: their land and their plots. True if they had any here.
    pub fn forget(&mut self, owner: CharacterId) -> bool {
        let had = self.away.remove(&owner).is_some() | self.estates.remove(&owner).is_some();
        let before = self.claims.len();
        self.claims.retain(|_, (h, _)| *h != owner);
        had || self.claims.len() != before
    }

    /// The houses kept here for those away whose tax has gone unpaid too long at `now` (the world's
    /// clock), taken down, their plots free: whose each was, and the house.
    pub fn neglected(&mut self, now: f64) -> Vec<(CharacterId, House)> {
        let mut gone = Vec::new();
        let mut changed = Vec::new();
        for (owner, h) in self.away.iter_mut() {
            let down = demolish_neglected(&mut h.land, now);
            if !down.is_empty() {
                changed.push((*owner, h.name.clone(), estate_of(&h.land)));
                gone.extend(down.into_iter().map(|house| (*owner, house)));
            }
        }
        for (owner, name, estate) in changed {
            self.set_estate(owner, &name, estate);
        }
        for (owner, h) in &gone {
            self.freed(&h.plot, *owner);
        }
        gone
    }
}

/// An estate with nothing in it.
fn empty(estate: &Value) -> bool {
    ["houses", "scarecrows", "ships"].iter().all(|k| estate[*k].as_array().is_none_or(Vec::is_empty))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::life::housing::{DAY, demolished_at};
    use crate::life::land::{Pack, Scarecrow, Vehicle};

    fn cottage(id: i64, plot: &str, tax_paid_until: f64) -> House {
        House { id, plot: plot.into(), blueprint: "cottage".into(), tax_paid_until, ..House::default() }
    }

    fn land(houses: Vec<House>) -> Land {
        Land { houses, ..Land::default() }
    }

    /// Ada (3) with a cottage on rise-1, Bo (7) with a farm and a cart, as the store read them.
    fn read() -> Lands {
        let mut bo = Land::default();
        bo.scarecrows.push(Scarecrow { id: 2049, x: 10.0, z: 10.0, ..Scarecrow::default() });
        bo.vehicles.push(Vehicle { id: 2050, def: "farmCart".into(), x: 12.0, z: 10.0, ..Vehicle::default() });
        bo.packs.push(Pack { id: 2051, def: "flaxBale".into(), at: "ground".into(), x: 11.0, z: 9.0, ..Pack::default() });
        let r = RegionLand {
            holdings: vec![
                (3, "Ada".into(), serde_json::to_value(land(vec![cottage(1025, "rise-1", 1000.0)])).unwrap()),
                (7, "Bo".into(), serde_json::to_value(&bo).unwrap()),
            ],
            claims: vec![("rise-1".into(), 3, "Ada".into())],
            market: json!({ "westwatch:harvestCrate": { "value": 0.8, "at": 5.0 } }),
        };
        let (lands, market) = Lands::read(r);
        assert_eq!(market.demand["westwatch:harvestCrate"].value, 0.8);
        lands
    }

    #[test]
    fn the_land_read_is_kept_for_those_away_and_shown_as_estates() {
        let lands = read();
        assert!(lands.loaded);
        assert_eq!(lands.away.keys().copied().collect::<Vec<_>>(), [3, 7]);
        // What everyone sees: what's built and planted (Bo's cart and pack are kept, not drawn).
        let shown = lands.estates_json(0);
        assert_eq!(shown[0]["name"], "Ada");
        assert_eq!(shown[0]["estate"]["houses"][0]["plot"], "rise-1");
        assert_eq!(shown[1]["estate"]["scarecrows"].as_array().map(Vec::len), Some(1));
        assert!(shown[1]["estate"].get("vehicles").is_none());
        assert_eq!(lands.away[&7].land.vehicles.len(), 1);
        // Your own isn't in your welcome; the plots are, by name.
        assert_eq!(lands.estates_json(3).as_array().map(Vec::len), Some(1));
        assert_eq!(lands.claims_json(), json!({ "rise-1": "Ada" }));
        assert_eq!(lands.held_by_others(7).get("rise-1").map(String::as_str), Some("Ada"));
        assert!(lands.held_by_others(3).is_empty());
    }

    #[test]
    fn land_is_lent_to_its_owner_while_they_play_and_kept_again_when_they_go() {
        let mut lands = read();
        let lent = lands.lend(3).expect("Ada's");
        assert_eq!(lent.houses[0].plot, "rise-1");
        assert!(!lands.away.contains_key(&3));
        // Their estate stays shown while they play (from their life), and changes with it.
        assert!(!lands.set_estate(3, "Ada", estate_of(&lent)));
        let mut built = lent.clone();
        built.houses[0].stage = 2;
        assert!(lands.set_estate(3, "Ada", estate_of(&built)));
        // They go: kept here again, as their life left it.
        assert!(!lands.keep(3, "Ada", built.clone()));
        assert_eq!(lands.away[&3].land, built);
        // Someone with nothing built shows nothing.
        assert!(!lands.keep(9, "Cy", Land::default()));
        assert!(!lands.estates.contains_key(&9) && !lands.away.contains_key(&9));
    }

    #[test]
    fn plots_are_held_as_the_registry_says_and_freed_by_their_holder_only() {
        let mut lands = read();
        assert!(lands.claimed("rise-2", 7, "Bo"));
        assert!(!lands.claimed("rise-2", 7, "Bo"), "nothing new");
        // Only its holder lets a plot go.
        assert!(!lands.freed("rise-2", 3));
        assert!(lands.freed("rise-2", 7));
        assert_eq!(lands.claims_json(), json!({ "rise-1": "Ada" }));
        // Gone for good: everything of theirs, their plots too.
        assert!(lands.forget(3));
        assert_eq!(lands.claims_json(), json!({}));
        assert!(lands.estates_json(0).as_array().is_some_and(|e| e.len() == 1));
        assert!(!lands.forget(3));
    }

    #[test]
    fn a_house_left_untaxed_too_long_comes_down_for_everyone_on_the_worlds_clock() {
        let mut lands = read();
        let h = lands.away[&3].land.houses[0].clone();
        // Not yet.
        assert!(lands.neglected(demolished_at(&h) - 1.0).is_empty());
        let gone = lands.neglected(demolished_at(&h));
        assert_eq!(gone.iter().map(|(o, h)| (*o, h.id)).collect::<Vec<_>>(), [(3, 1025)]);
        assert!(lands.away[&3].land.houses.is_empty());
        assert_eq!(lands.estates[&3].1["houses"], json!([]));
        assert_eq!(lands.claims_json(), json!({}));
        // A house whose claim the registry hasn't confirmed is never neglected.
        let mut waiting = cottage(1026, "rise-4", 0.0);
        waiting.pending = true;
        lands.keep(7, "Bo", land(vec![waiting]));
        assert!(lands.neglected(100.0 * DAY).is_empty());
    }
}
