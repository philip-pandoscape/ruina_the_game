//! What of someone's land everyone else sees: their estate. A region's land stands in every one of
//! its channels, kept for whoever is away and lent to whoever plays (crates/server/src/sim/lands.rs);
//! the channels themselves are opened, placed in and merged by the directory, by the channels'
//! policy (crates/channels). The channel's game itself is in crates/server/src/sim/mod.rs.

use serde_json::{Value, json};

use crate::life::land::Land;

/// What of someone's land everyone else sees while its owner is away. Vehicles and packs move, so
/// they travel with the owner's presence instead (and only while they're online).
pub fn estate_of(land: &Land) -> Value {
    serde_json::to_value(land.standing()).map_or_else(
        |_| json!({ "houses": [], "scarecrows": [], "ships": [] }),
        |v| json!({ "houses": v["houses"], "scarecrows": v["scarecrows"], "ships": v["ships"] }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_estate_is_the_built_things() {
        let house = json!({ "id": 1, "plot": "p1", "blueprint": "cottage", "stage": 0 });
        let land: Land = serde_json::from_value(json!({ "houses": [house], "scarecrows": [], "vehicles": [{ "id": 3 }] })).unwrap();
        let e = estate_of(&land);
        assert_eq!(e["houses"][0]["plot"], "p1");
        assert!(e.get("vehicles").is_none());
        assert_eq!(e["ships"], json!([]));
    }
}
