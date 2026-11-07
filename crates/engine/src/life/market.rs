//! The trading posts' demand for each pack: the world's, the same for everyone who sells there
//! (the page reads it through src/engine/life/trade.ts). A sale lowers that post's demand for that
//! pack; it recovers with time up to its ceiling. Each is kept as it stood at a moment on the land's
//! clock (crate::life::land::now), and what it is at any later moment is worked out from there, so
//! nothing needs stepping and every channel and server agrees on it. A life reads the market as it
//! stood when the step began (`Life::market`), and its sales go to whoever keeps the world's
//! (crate::life::land::Change::Sold), so who sold first in a tick changes nothing.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::content;
use crate::jsmath::{js_max, js_min};

/// A post's demand for a pack as it stood at a moment (`at`, on the land's clock).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Demand {
    pub value: f64,
    pub at: f64,
}

/// Every post's demand that a sale has moved from where it starts, by "outpost:pack". (A demand
/// that has recovered stays: it comes back to its ceiling, above where an untouched one starts.)
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(transparent)]
pub struct Market {
    pub demand: BTreeMap<String, Demand>,
}

pub fn key(outpost: &str, pack: &str) -> String {
    format!("{outpost}:{pack}")
}

impl Market {
    /// What `outpost` pays for `pack` against its base price right now (`now`, the land's clock).
    pub fn demand(&self, outpost: &str, pack: &str, now: f64) -> f64 {
        let d = content::demand();
        match self.demand.get(&key(outpost, pack)) {
            None => d.start,
            Some(k) => js_min(d.max, k.value + d.recover_per_minute * js_max(0.0, now - k.at) / 60.0),
        }
    }

    /// A sale of `pack` at `outpost` at `now`: demand there drops, down to its floor.
    pub fn sell(&mut self, outpost: &str, pack: &str, now: f64) {
        let d = content::demand();
        let value = js_max(d.min, self.demand(outpost, pack, now) - d.drop_per_sale);
        self.demand.insert(key(outpost, pack), Demand { value, at: now });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sale_lowers_demand_for_everyone_and_it_recovers_with_time() {
        let d = content::demand();
        let mut m = Market::default();
        assert_eq!(m.demand("westwatch", "harvestCrate", 0.0), d.start);
        m.sell("westwatch", "harvestCrate", 100.0);
        assert!((m.demand("westwatch", "harvestCrate", 100.0) - (d.start - d.drop_per_sale)).abs() < 1e-12);
        // Elsewhere, and for other packs, nothing moved.
        assert_eq!(m.demand("gullrock", "harvestCrate", 100.0), d.start);
        assert_eq!(m.demand("westwatch", "flaxBale", 100.0), d.start);
        // A minute later it has come back by a minute's worth; an hour later, all the way up.
        assert!((m.demand("westwatch", "harvestCrate", 160.0) - (d.start - d.drop_per_sale + d.recover_per_minute)).abs() < 1e-12);
        assert_eq!(m.demand("westwatch", "harvestCrate", 3700.0), d.max);
        // Sold out: never below its floor.
        for _ in 0..100 {
            m.sell("westwatch", "harvestCrate", 200.0);
        }
        assert_eq!(m.demand("westwatch", "harvestCrate", 200.0), d.min);
    }
}
