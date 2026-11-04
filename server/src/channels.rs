//! Emberholm's channels: copies of the island, each home to at most CHANNEL_CAP characters, so
//! eight house plots aren't fought over by everyone. Everybody in a channel sees everybody else:
//! where they are and what they're doing (their presence, relayed about 20 times a second), and
//! what they've built (their estate: houses, farms and ships on the slipway), which stays when they
//! log off. A house plot belongs to whoever built on it first.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::mpsc;

/// Characters who call one channel home.
pub const CHANNEL_CAP: i64 = 24;

/// What of an island everyone else sees. Vehicles and packs move, so they travel with the
/// player's presence instead (and only while they're online).
pub fn estate_of(state: &Value) -> Value {
    let list = |k: &str| state.get(k).filter(|v| v.is_array()).cloned().unwrap_or_else(|| json!([]));
    json!({ "houses": list("houses"), "scarecrows": list("scarecrows"), "ships": list("ships") })
}

/// The house plots an estate stands on.
pub fn plots_of(estate: &Value) -> Vec<String> {
    estate["houses"].as_array().map(|hs| hs.iter().filter_map(|h| h["plot"].as_str().map(String::from)).collect()).unwrap_or_default()
}

/// Someone playing in the channel right now.
pub struct Peer {
    pub session: i64,
    pub name: String,
    /// Messages for their browser (dropped if they can't keep up).
    pub out: mpsc::Sender<String>,
    /// Their latest presence, as the JSON object their browser sent.
    pub presence: Option<Arc<str>>,
    pub dirty: bool,
}

pub struct Estate {
    pub name: String,
    pub estate: Value,
}

#[derive(Default)]
pub struct Channel {
    pub peers: HashMap<i64, Peer>,
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

    /// Plots go to the earliest character holding them (a race within a save or two settles the
    /// same way every time).
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

    pub fn send_all(&self, text: &str, except: Option<i64>) {
        for (id, p) in &self.peers {
            if Some(*id) != except {
                let _ = p.out.try_send(text.to_string());
            }
        }
    }

    /// The presences that changed since last time, as one message (None if nothing moved).
    pub fn take_changed(&mut self) -> Option<String> {
        let mut parts = Vec::new();
        for (id, p) in self.peers.iter_mut() {
            if p.dirty {
                p.dirty = false;
                if let Some(pr) = &p.presence {
                    parts.push(peer_entry(*id, &p.name, pr));
                }
            }
        }
        (!parts.is_empty()).then(|| peers_message(&parts))
    }

    /// Everyone else's latest presence, for someone who just arrived.
    pub fn presences(&self, except: i64) -> String {
        let parts: Vec<String> = self.peers.iter().filter(|(id, _)| **id != except).filter_map(|(id, p)| p.presence.as_ref().map(|pr| peer_entry(*id, &p.name, pr))).collect();
        peers_message(&parts)
    }
}

fn peer_entry(id: i64, name: &str, presence: &str) -> String {
    format!("{{\"id\":{id},\"name\":{},\"p\":{presence}}}", Value::String(name.to_string()))
}

fn peers_message(parts: &[String]) -> String {
    format!("{{\"t\":\"peers\",\"list\":[{}]}}", parts.join(","))
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
        // Unchanged: nothing to tell anyone.
        assert!(!c.set_estate(3, "early", json!({ "houses": [house("p1")] })));
        // Gone: the plot is free for the next one.
        assert!(c.set_estate(3, "early", json!({ "houses": [] })));
        assert_eq!(c.claims_json(), json!({ "p1": "late" }));
    }

    #[test]
    fn presences_go_out_once() {
        let mut c = Channel::default();
        let (tx, _rx) = mpsc::channel(4);
        c.peers.insert(1, Peer { session: 1, name: "a\"b".into(), out: tx, presence: Some(Arc::from("{\"x\":1}")), dirty: true });
        let msg = c.take_changed().unwrap();
        let v: Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(v["list"][0]["name"], "a\"b");
        assert_eq!(v["list"][0]["p"]["x"], 1);
        assert!(c.take_changed().is_none());
        assert_eq!(serde_json::from_str::<Value>(&c.presences(2)).unwrap()["list"].as_array().unwrap().len(), 1);
        assert_eq!(serde_json::from_str::<Value>(&c.presences(1)).unwrap()["list"].as_array().unwrap().len(), 0);
    }
}
