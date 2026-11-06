//! The world's instances: its dungeons and the developer zones (content/instances/<id>.json, built
//! into shared/instances.json; docs/zones.md; the page reads the files through
//! src/engine/world/dungeons.ts). Each party plays its own copy of one (crate::spaces), a space of
//! its own: everything in it stands round its own origin, in a frame no region shares, over nothing
//! (its map has no regions and no sea: OpenWorld::instance), and its floors and walls are the only
//! things solid in it.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::jsmath::{JsMath, js_hypot};

use super::OpenWorld;
use super::colliders::{ColliderIndex, ground_at, in_rect};
use super::map::WorldMap;
use super::zone::{BoxCollider, Deck, DungeonDoor, Spawn, rect};

/// A box or deck as a dungeon's file gives it: round its origin, its top above the origin.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Piece {
    pub x: f64,
    pub z: f64,
    pub hw: f64,
    pub hd: f64,
    pub rot: f64,
    pub top: f64,
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
    /// Where you come in (round its origin, on its floor).
    pub arrive: Spawn,
    pub exit: Exit,
    /// Below this you're put back where you came in.
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
    /// where.
    #[serde(default)]
    pub bots: Vec<ZoneBots>,
    /// How the browser draws it: "cave" (the default) or "arena" (open sky).
    #[serde(default)]
    pub style: Option<String>,
    /// Creatures a copy of it brings: a training dummy, slimes, goblins.
    #[serde(default)]
    pub spawns: Vec<ZoneSpawn>,
}

/// One of a kind at a spot, or a war-band of them (`band`: `count` in a ring round it, fighting
/// together as a pack, as crate::yard::band_around lays one out).
#[derive(Deserialize, Clone, Debug)]
pub struct ZoneSpawn {
    pub kind: String,
    pub x: f64,
    pub z: f64,
    #[serde(default)]
    pub band: bool,
    #[serde(default = "one")]
    pub count: u32,
}

fn one() -> u32 {
    1
}

impl ZoneSpawn {
    /// Where each one stands, which way it faces, and its seed: a band in a ring round the spot
    /// facing out, anything else on the spot.
    pub fn points(&self, seed: u32) -> Vec<(f64, f64, f64, u32)> {
        let n = self.count.max(1);
        (0..n)
            .map(|i| {
                let angle = f64::from(i) / f64::from(n) * std::f64::consts::TAU;
                let r = if n > 1 { 1.2 + 0.4 * f64::from(i % 2) } else { 0.0 };
                let (sin, cos) = (angle.js_sin(), angle.js_cos());
                (self.x + sin * r, self.z + cos * r, angle, seed.wrapping_add((i + 1).wrapping_mul(0x9e37_79b1)))
            })
            .collect()
    }
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
    /// Its boxes and decks, where they stand in its space.
    pub fn colliders(&self) -> (Vec<BoxCollider>, Vec<Deck>) {
        let place = |p: &Piece| rect(p.x, p.z, p.hw, p.hd, p.rot, p.top);
        (self.boxes.iter().map(place).collect(), self.decks.iter().map(place).collect())
    }

    /// Where you stand on arriving (the floor's height there is found once it's solid).
    pub fn arrival(&self) -> Spot {
        Spot { x: self.arrive.x, y: 0.0, z: self.arrive.z, facing: self.arrive.facing }
    }

    /// Whether you're at the portal back out: within its reach (a step's slack), on its floor.
    pub fn at_exit(&self, x: f64, y: f64, z: f64) -> bool {
        ((x - self.exit.x).powi(2) + (z - self.exit.z).powi(2)).sqrt() <= self.exit.r + 1.0 && y.abs() < 6.0
    }

    /// The floor at (x, z), if it has one there: the top of the highest of its low pieces (a floor, a
    /// deck; walls and rails aren't floor) whose footprint holds the point. What a creature in a copy
    /// of it stands on.
    pub fn floor_at(&self, x: f64, z: f64) -> Option<f64> {
        self.boxes
            .iter()
            .chain(&self.decks)
            .filter(|p| p.top <= 0.6)
            .filter(|p| in_rect(&rect(p.x, p.z, p.hw, p.hd, p.rot, 0.0), x, z, 0.0))
            .map(|p| p.top)
            .max_by(f64::total_cmp)
    }

    /// Whether someone has fallen out of it.
    pub fn fallen_out(&self, y: f64) -> bool {
        y < self.fall
    }

    /// How far its pieces reach from its origin.
    pub fn reach(&self) -> f64 {
        self.boxes.iter().chain(&self.decks).map(|p| js_hypot(p.x, p.z) + js_hypot(p.hw, p.hd)).fold(0.0, f64::max)
    }

    /// Its space's map: no regions, and nothing under its floors but a long fall (no sea to land in),
    /// its edge well past its pieces.
    pub fn map(&self) -> &'static WorldMap {
        static MAPS: OnceLock<Vec<WorldMap>> = OnceLock::new();
        let maps = MAPS.get_or_init(|| {
            dungeons()
                .iter()
                .map(|d| {
                    let r = d.reach() + VOID_MARGIN;
                    WorldMap::void([-r, -r, r, r], d.fall - VOID_DEPTH)
                })
                .collect()
        });
        let i = dungeons().iter().position(|d| d.id == self.id).expect("one of the world's instances");
        &maps[i]
    }
}

/// How far past an instance's pieces its edge is.
const VOID_MARGIN: f64 = 64.0;
/// How far under where someone is caught falling the nothing under an instance is.
const VOID_DEPTH: f64 = 100.0;

/// Every dungeon there is.
/// Every dungeon and developer zone, from shared/instances.json (built from content/instances/).
pub fn dungeons() -> &'static [DungeonDef] {
    #[derive(Deserialize)]
    struct Bundle {
        instances: Vec<DungeonDef>,
    }
    static D: OnceLock<Vec<DungeonDef>> = OnceLock::new();
    D.get_or_init(|| {
        let b: Bundle = serde_json::from_str(crate::bundles::bundle("instances.json", include_str!("../../../../shared/instances.json")))
            .unwrap_or_else(|e| panic!("shared/instances.json is malformed: {e}"));
        b.instances
    })
}

pub fn dungeon(id: &str) -> Option<&'static DungeonDef> {
    dungeons().iter().find(|d| d.id == id)
}

/// A dungeon's door in the world, in whichever region it stands (a developer zone's is its own,
/// `door`, and none is in the world).
pub fn door_into(id: &str) -> Option<&'static DungeonDoor> {
    super::map::world_map().recipes().flat_map(|r| &r.doors).find(|d| d.id == id)
}

impl OpenWorld {
    /// A copy of an instance, a space of its own: its floors and walls the only things solid, over
    /// nothing, and anyone knocked down in it back on their feet where they came in. `home` is the
    /// region its players' lives belong to (OpenWorld::zone): nothing of it is near them in here.
    pub fn instance(def: &'static DungeonDef, home: &'static super::zone::Zone) -> Self {
        let map = def.map();
        let (boxes, decks) = def.colliders();
        let index = ColliderIndex::new(Vec::new(), boxes, decks);
        let a = def.arrival();
        let y = ground_at(map, &index, a.x, a.z, a.y + 1.2, 1.2);
        OpenWorld { map, zone: home, index, clear: home.clear.clone(), added: BTreeSet::new(), movers: Vec::new(), respawn: Some(Spot { y, ..a }) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open::map::world_map;
    use crate::open::zone::emberholm;

    #[test]
    fn goblins_dread_is_a_space_of_its_own() {
        let def = dungeon("goblinsDread").expect("Goblin's Dread");
        assert_eq!(def.name, "Goblin's Dread");
        assert!(def.max_players >= 1);
        let world = OpenWorld::instance(def, emberholm());
        let a = def.arrival();
        // On its floor where you come in, round its own origin.
        let floor = world.respawn.expect("a copy has a place to get up again").y;
        assert!(floor.abs() < 1.0, "on the floor where you arrive: {floor}");
        assert_eq!(def.floor_at(a.x, a.z).map(|f| (f - floor).abs() < 1e-9), Some(true));
        // Nothing of Emberholm in it: no trees, no ground, no sea; off its floor, a long fall.
        assert_eq!(world.index.obstacles.len(), 0);
        assert!(world.map.regions().is_empty());
        assert!(world.map.height(a.x + 500.0, a.z) < def.fall - 50.0);
        assert_eq!(world.map.depth(a.x, a.z), 0.0, "nothing to swim in");
        assert!(world.map.recipes().next().is_none(), "nobody and nothing of the world's near you in here");
        // Its way out, and the fall it catches.
        assert!(def.at_exit(def.exit.x, 0.0, def.exit.z));
        assert!(!def.at_exit(a.x + 30.0, 0.0, a.z));
        assert!(def.fallen_out(def.fall - 1.0) && !def.fallen_out(0.0));
    }

    #[test]
    fn every_instance_stands_on_its_own_floor_within_its_edge() {
        for d in dungeons() {
            let world = OpenWorld::instance(d, emberholm());
            let a = d.arrival();
            assert!(d.floor_at(a.x, a.z).is_some(), "{} has a floor where you come in", d.id);
            assert!(world.map.inside(a.x, a.z, crate::open::traverse::EDGE) && world.map.inside(d.exit.x, d.exit.z, crate::open::traverse::EDGE), "{}", d.id);
            assert!(world.map.inside(d.reach(), 0.0, crate::open::traverse::EDGE), "{}: its edge is past its pieces", d.id);
        }
    }

    #[test]
    fn every_dungeon_has_a_way_in_and_out() {
        let doors: Vec<&DungeonDoor> = world_map().recipes().flat_map(|r| &r.doors).collect();
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
