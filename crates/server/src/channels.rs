//! Emberholm's channels: copies of the island, each home to at most CHANNEL_CAP characters, so
//! eight house plots aren't fought over by everyone. This keeps what everyone in a channel has
//! built (their estate: houses, farms and ships on the slipway), which stays standing when they log
//! off, and who holds which house plot: whoever built on it first. The channel's game itself is in
//! crates/server/src/world_game.rs.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Value, json};

/// Characters who call one channel home.
pub const CHANNEL_CAP: i64 = 24;

/// What of an island everyone else sees while its owner is away. Vehicles and packs move, so they
/// travel with the owner's presence instead (and only while they're online).
pub fn estate_of(state: &Value) -> Value {
    let list = |k: &str| state.get(k).filter(|v| v.is_array()).cloned().unwrap_or_else(|| json!([]));
    json!({ "houses": list("houses"), "scarecrows": list("scarecrows"), "ships": list("ships") })
}

/// The house plots an estate stands on.
pub fn plots_of(estate: &Value) -> Vec<String> {
    estate["houses"].as_array().map(|hs| hs.iter().filter_map(|h| h["plot"].as_str().map(String::from)).collect()).unwrap_or_default()
}

pub struct Estate {
    pub name: String,
    pub estate: Value,
}

#[derive(Default)]
pub struct Channel {
    /// Everyone who lives here, online or not.
    pub estates: HashMap<i64, Estate>,
    /// House plot -> the character who holds it.
    pub claims: BTreeMap<String, i64>,
    /// Whether the residents' estates have been read from the database yet.
    pub loaded: bool,
}

impl Channel {
    /// Sets a character's estate. True if anything changed.
    pub fn set_estate(&mut self, id: i64, name: &str, estate: Value) -> bool {
        if self.estates.get(&id).is_some_and(|e| e.estate == estate && e.name == name) {
            return false;
        }
        self.estates.insert(id, Estate { name: name.to_string(), estate });
        self.recount_claims();
        true
    }

    /// A character is gone for good: their estate and their plots go. True if they lived here.
    pub fn remove(&mut self, id: i64) -> bool {
        if self.estates.remove(&id).is_none() {
            return false;
        }
        self.recount_claims();
        true
    }

    /// Plots go to the earliest character holding them (a race settles the same way every time).
    fn recount_claims(&mut self) {
        self.claims.clear();
        let mut ids: Vec<i64> = self.estates.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            for plot in plots_of(&self.estates[&id].estate) {
                self.claims.entry(plot).or_insert(id);
            }
        }
    }

    /// Plot -> holder's name.
    pub fn claims_json(&self) -> Value {
        let mut m = serde_json::Map::new();
        for (plot, id) in &self.claims {
            if let Some(e) = self.estates.get(id) {
                m.insert(plot.clone(), Value::String(e.name.clone()));
            }
        }
        Value::Object(m)
    }

    /// The plots held by anyone but `who`, with the holder's name (what a Life's plot_owners holds).
    pub fn held_by_others(&self, who: i64) -> HashMap<String, String> {
        self.claims.iter().filter(|(_, id)| **id != who).filter_map(|(plot, id)| self.estates.get(id).map(|e| (plot.clone(), e.name.clone()))).collect()
    }

    /// Everyone else's estate.
    pub fn estates_json(&self, except: i64) -> Value {
        let mut ids: Vec<&i64> = self.estates.keys().filter(|id| **id != except).collect();
        ids.sort_unstable();
        Value::Array(ids.into_iter().map(|id| json!({ "id": id, "name": self.estates[id].name, "estate": self.estates[id].estate })).collect())
    }

    pub fn estate_message(&self, id: i64) -> Option<String> {
        let e = self.estates.get(&id)?;
        Some(json!({ "t": "estate", "id": id, "name": e.name, "estate": e.estate }).to_string())
    }

    pub fn claims_message(&self) -> String {
        json!({ "t": "claims", "claims": self.claims_json() }).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn house(plot: &str) -> Value {
        json!({ "id": 1, "plot": plot, "blueprint": "cottage", "stage": 0 })
    }

    #[test]
    fn an_estate_is_the_built_things() {
        let state = json!({ "coins": 5, "houses": [house("p1")], "scarecrows": [], "vehicles": [{ "id": 3 }] });
        let e = estate_of(&state);
        assert_eq!(plots_of(&e), vec!["p1".to_string()]);
        assert!(e.get("vehicles").is_none());
        assert_eq!(e["ships"], json!([]));
    }

    #[test]
    fn the_first_to_build_holds_the_plot() {
        let mut c = Channel::default();
        assert!(c.set_estate(7, "late", json!({ "houses": [house("p1")] })));
        assert!(c.set_estate(3, "early", json!({ "houses": [house("p1")] })));
        assert_eq!(c.claims_json(), json!({ "p1": "early" }));
        assert_eq!(c.held_by_others(7).get("p1").map(String::as_str), Some("early"));
        assert!(c.held_by_others(3).is_empty());
        // Unchanged: nothing to tell anyone.
        assert!(!c.set_estate(3, "early", json!({ "houses": [house("p1")] })));
        // Gone: the plot is free for the next one.
        assert!(c.set_estate(3, "early", json!({ "houses": [] })));
        assert_eq!(c.claims_json(), json!({ "p1": "late" }));
    }

    #[test]
    fn a_deleted_character_frees_their_plots() {
        let mut c = Channel::default();
        c.set_estate(3, "early", json!({ "houses": [house("p1")] }));
        c.set_estate(7, "late", json!({ "houses": [house("p1"), house("p2")] }));
        assert_eq!(c.claims_json(), json!({ "p1": "early", "p2": "late" }));
        assert!(c.remove(3));
        assert_eq!(c.claims_json(), json!({ "p1": "late", "p2": "late" }));
        assert!(!c.remove(3));
        assert!(c.remove(7));
        assert_eq!(c.claims_json(), json!({}));
    }
}
