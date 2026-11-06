//! The island's dungeons (shared/dungeons/<id>.json; src/sim/zone/dungeon.ts is the browser's
//! twin). Each party plays its own copy of one (crate::spaces). Inside, everything stands round a
//! spot high above the sea that nothing else in the world uses, and is solid only in a copy: a
//! copy's OpenWorld gets the dungeon's boxes and decks, the channels never do.

use std::sync::OnceLock;

use serde::Deserialize;

use super::OpenWorld;
use super::colliders::{ground_at, in_rect};
use super::zone::{BoxCollider, Deck, DungeonDoor, Spawn, rect};

/// A box or deck as a dungeon's file gives it: around the origin, its top above the origin's height.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Piece {
    pub x: f64,
    pub z: f64,
    pub hw: f64,
    pub hd: f64,
    pub rot: f64,
    pub top: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Origin {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// The portal back out: F within `r` of it.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Exit {
    pub x: f64,
    pub z: f64,
    pub r: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DungeonDef {
    pub id: String,
    pub name: String,
    /// How many players a copy holds.
    pub max_players: usize,
    pub origin: Origin,
    /// Where you come in (around the origin, on its floor).
    pub arrive: Spawn,
    pub exit: Exit,
    /// Below origin.y + fall you're put back where you came in.
    pub fall: f64,
    pub boxes: Vec<Piece>,
    pub decks: Vec<Piece>,
    /// A developer zone: only admins go in, from the Admin menu, as there's no portal to it on the
    /// island (docs/admin.md).
    #[serde(default)]
    pub developer: bool,
    /// One copy for everyone allowed in, instead of one for each party.
    #[serde(default)]
    pub shared: bool,
    /// Where a developer zone lets you out on the island (a dungeon's door is in the island's recipe).
    #[serde(default)]
    pub door: Option<DungeonDoor>,
    /// Bots in it while anyone is (crate::bots): how many, with which brain, on which side, round
    /// where (relative to the origin).
    #[serde(default)]
    pub bots: Vec<ZoneBots>,
    /// How the browser draws it: "cave" (the default) or "arena" (open sky).
    #[serde(default)]
    pub style: Option<String>,
    /// Creatures a copy of it brings (relative to the origin): a training dummy, slimes, goblins.
    #[serde(default)]
    pub spawns: Vec<ZoneSpawn>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ZoneSpawn {
    pub kind: String,
    pub x: f64,
    pub z: f64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ZoneBots {
    pub brain: String,
    pub count: u32,
    pub team: u8,
    pub x: f64,
    pub z: f64,
}

/// Where a spot stands, and which way you face there.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spot {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub facing: f64,
}

impl DungeonDef {
    /// Its boxes and decks, where they stand in the world.
    pub fn colliders(&self) -> (Vec<BoxCollider>, Vec<Deck>) {
        let o = self.origin;
        let place = |p: &Piece| rect(o.x + p.x, o.z + p.z, p.hw, p.hd, p.rot, o.y + p.top);
        (self.boxes.iter().map(place).collect(), self.decks.iter().map(place).collect())
    }

    /// Where you stand on arriving (the floor's height there is found once it's solid).
    pub fn arrival(&self) -> Spot {
        let o = self.origin;
        Spot { x: o.x + self.arrive.x, y: o.y, z: o.z + self.arrive.z, facing: self.arrive.facing }
    }

    /// Whether you're at the portal back out: within its reach (a step's slack), on its floor.
    pub fn at_exit(&self, x: f64, y: f64, z: f64) -> bool {
        let o = self.origin;
        let (ex, ez) = (o.x + self.exit.x, o.z + self.exit.z);
        ((x - ex).powi(2) + (z - ez).powi(2)).sqrt() <= self.exit.r + 1.0 && (y - o.y).abs() < 6.0
    }

    /// The floor at (x, z) (in the world), if it has one there: the top of the highest of its low
    /// pieces (a floor, a deck; walls and rails aren't floor) whose footprint holds the point. What a
    /// creature in a copy of it stands on.
    pub fn floor_at(&self, x: f64, z: f64) -> Option<f64> {
        let o = self.origin;
        self.boxes
            .iter()
            .chain(&self.decks)
            .filter(|p| p.top <= 0.6)
            .filter(|p| in_rect(&rect(o.x + p.x, o.z + p.z, p.hw, p.hd, p.rot, 0.0), x, z, 0.0))
            .map(|p| o.y + p.top)
            .max_by(f64::total_cmp)
    }

    /// Whether someone has fallen out of it.
    pub fn fallen_out(&self, y: f64) -> bool {
        y < self.origin.y + self.fall
    }
}

/// Every dungeon there is.
pub fn dungeons() -> &'static [DungeonDef] {
    static D: OnceLock<Vec<DungeonDef>> = OnceLock::new();
    D.get_or_init(|| {
        [
            ("goblinsDread", include_str!("../../../../shared/dungeons/goblinsDread.json")),
            ("yard", include_str!("../../../../shared/dungeons/yard.json")),
            ("battlefield", include_str!("../../../../shared/dungeons/battlefield.json")),
        ]
        .into_iter()
        .map(|(id, json)| serde_json::from_str(json).unwrap_or_else(|e| panic!("shared/dungeons/{id}.json is a dungeon: {e}")))
        .collect()
    })
}

pub fn dungeon(id: &str) -> Option<&'static DungeonDef> {
    dungeons().iter().find(|d| d.id == id)
}

impl OpenWorld {
    /// Makes a world a copy of a dungeon: its floors and walls solid, and anyone knocked down in it
    /// back on their feet where they came in, not at the island's spawn far below.
    pub fn make_dungeon(&mut self, def: &DungeonDef) {
        let (boxes, decks) = def.colliders();
        for b in boxes {
            self.index.add_box(b);
        }
        for d in decks {
            self.index.add_deck(d);
        }
        let a = def.arrival();
        let hf = self.terrain();
        let y = ground_at(hf, &self.index, a.x, a.z, a.y + 1.2, 1.2);
        self.respawn = Some(Spot { y, ..a });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open::zone::emberholm;

    #[test]
    fn goblins_dread_is_solid_only_in_a_copy() {
        let def = dungeon("goblinsDread").expect("Goblin's Dread");
        assert_eq!(def.name, "Goblin's Dread");
        assert!(def.max_players >= 1);
        let a = def.arrival();
        let mut world = OpenWorld::new(emberholm());
        let hf = world.terrain();
        // Nothing there in the open world: you'd be over the sea, far below.
        assert!(ground_at(hf, &world.index, a.x, a.z, a.y + 1.2, 1.2) < a.y - 100.0);
        assert!(world.respawn.is_none());
        world.make_dungeon(def);
        let floor = world.respawn.expect("a copy has a place to get up again").y;
        assert!((floor - def.origin.y).abs() < 1.0, "on the floor where you arrive: {floor}");
        assert!(def.at_exit(def.origin.x + def.exit.x, def.origin.y, def.origin.z + def.exit.z));
        assert!(!def.at_exit(a.x + 30.0, a.y, a.z));
        assert!(def.fallen_out(def.origin.y + def.fall - 1.0) && !def.fallen_out(def.origin.y));
    }

    #[test]
    fn every_dungeon_has_a_way_in_and_out() {
        let doors = &emberholm().recipe.dungeons;
        for d in dungeons() {
            if d.developer {
                // A developer zone: in from the Admin menu, out at its own door, none on the island.
                assert!(d.door.is_some(), "{} lets you out somewhere", d.id);
                assert!(!doors.iter().any(|x| x.id == d.id), "{} has no portal on the island", d.id);
            } else {
                let door = doors.iter().find(|x| x.id == d.id).unwrap_or_else(|| panic!("a door for {}", d.id));
                assert!(door.portal.r > 0.0);
            }
        }
    }
}
