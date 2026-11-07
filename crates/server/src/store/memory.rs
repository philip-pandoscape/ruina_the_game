//! The database's tables kept in memory, for the tests (and a server started without one): the
//! same rows and the same rules the SQL keeps in Postgres (`store/mod.rs`, `directory/db.rs`), so a
//! test holds the tiers to them without a database.

use std::collections::BTreeMap;

use serde_json::Value;

use ruina_world_api::Millis;

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

#[derive(Default, Debug)]
pub struct Tables {
    pub characters: BTreeMap<i64, CharacterRow>,
    pub leases: BTreeMap<String, LeaseRow>,
    /// The sequences' last values.
    pub sim_ids: u64,
    pub copy_numbers: u64,
}

impl Tables {
    /// A character, as an account's first or a new one makes it.
    pub fn add_character(&mut self, id: i64, name: &str) {
        self.characters.insert(id, CharacterRow { name: name.to_string(), ..CharacterRow::default() });
    }
}
