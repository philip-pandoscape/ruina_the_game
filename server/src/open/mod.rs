//! Open worlds on the server: Emberholm's ground, colliders and getting around it, and the world
//! each channel plays in. The browser predicts your own moves with the TypeScript rules
//! (src/sim/player/traverse.ts, src/sim/zone/*); these are their Rust twins, and
//! tests/world-conformance.spec.ts runs both and compares them frame by frame.

pub mod colliders;
pub mod traverse;
pub mod zone;

use std::collections::HashSet;

use crate::life::Life;
use crate::player::{Actions, Player};
use colliders::ColliderIndex;
use zone::{Heightfield, Zone};

/// One copy of an island as a channel plays it: the zone as grown, plus everything solid that
/// residents have built since (house floors and walls, scarecrow posts), shared by everyone in it.
pub struct OpenWorld {
    pub zone: &'static Zone,
    pub index: ColliderIndex,
    /// Cells kept free of trees and scarecrows: the zone's, plus ground cleared for houses.
    pub clear: Vec<u8>,
    pub radius: f64,
    /// Built pieces already made solid, as "owner:what" keys, so each is added once.
    pub added: HashSet<String>,
}

impl OpenWorld {
    pub fn new(zone: &'static Zone) -> Self {
        OpenWorld {
            zone,
            index: ColliderIndex::new(zone.obstacles.clone(), zone.boxes.clone(), zone.decks.clone()),
            clear: zone.clear.clone(),
            radius: zone.radius,
            added: HashSet::new(),
        }
    }

    pub fn terrain(&self) -> &'static Heightfield {
        &self.zone.terrain
    }
}

/// What the open-world rules act on each step: one player, the world they are in, and whose
/// things anything they build belongs to. The TypeScript passes its `Sim` around for the same.
pub struct Sim<'a> {
    pub player: &'a mut Player,
    pub world: &'a mut OpenWorld,
    /// The character this player is (their colliders are kept apart from everyone else's).
    pub owner: i64,
}

impl Sim<'_> {
    pub fn terrain(&self) -> &'static Heightfield {
        self.world.zone.terrain_ref()
    }

    pub fn zone(&self) -> &'static Zone {
        self.world.zone
    }
}

impl Zone {
    pub fn terrain_ref(&'static self) -> &'static Heightfield {
        &self.terrain
    }
}

/// One step of the rules for one player in an open world: src/sim/sim.ts step() as the server runs
/// it (no training dummy, no hit pause, no auto-aim), with the island's systems (`life`) riding
/// along when the player has an island. `owner` is the character, for whatever they build.
pub fn step_player(_p: &mut Player, _a: &Actions, _world: &mut OpenWorld, _life: Option<&mut Life>, _owner: i64) {
    // Being ported (src/sim/player/traverse.ts into traverse.rs).
}
