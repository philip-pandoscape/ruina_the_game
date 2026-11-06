//! Every creature with a folder of its own (content/creatures/, built into shared/creatures.json):
//! its kinds, brains and attacks, all data for the shared engine parts (design/goblins.md). The same
//! bundle as src/content/creatures.ts reads: a kind travels on the wire as its index, after those in
//! shared/actors.json, so a new creature goes on the end of content/creatures/_order.json.

use std::sync::OnceLock;

/// Each creature's file (its kinds, attacks and brains), in the bundle's order.
pub fn files() -> &'static [serde_json::Value] {
    static FILES: OnceLock<Vec<serde_json::Value>> = OnceLock::new();
    FILES.get_or_init(|| {
        let bundle: serde_json::Value = serde_json::from_str(crate::bundles::bundle("creatures.json", include_str!("../../../shared/creatures.json")))
            .expect("shared/creatures.json is malformed");
        bundle["creatures"].as_array().cloned().expect("shared/creatures.json has its creatures")
    })
}
