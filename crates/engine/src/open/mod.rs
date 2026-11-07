//! Open worlds: Emberholm's ground, colliders and getting around it, and the world each channel
//! plays in. The server runs them natively; the browser runs the same code through the WebAssembly
//! to predict your own moves and to play offline. The golden scenarios of checks/world.rs hold
//! their answers.

pub mod buildings;
pub mod colliders;
pub mod dungeon;
#[cfg(any(test, feature = "fixture-world"))]
pub mod fixture;
pub mod generate;
pub mod map;
pub mod noise;
pub mod spawns;
pub mod traverse;
pub mod zone;

use std::collections::BTreeSet;

use crate::life::Life;
use crate::life::progress::Observed;
use crate::player::{Actions, Mode, Player};
use crate::tuning::{NO_ABILITY, NO_MOVEMENT};
use crate::world::Spawn;
use colliders::ColliderIndex;
use map::{WorldMap, world_map};
use zone::{Heightfield, Zone};

/// The world as a channel plays it: its view of the map of regions (`map`: the regions it holds grown,
/// and the ground they answer), the region the channel is a copy of (`zone`, whose life it plays),
/// and everything solid: the colliders of the regions it holds, plus what's been built on anyone's land
/// since (house floors and walls, scarecrow posts), shared by everyone in it.
pub struct OpenWorld {
    pub map: WorldMap,
    pub zone: &'static Zone,
    pub index: ColliderIndex,
    /// The regions whose colliders begin `index` (places in the map, in its order), and how many of
    /// its obstacles, boxes and decks are theirs: the rest were built since, and are kept when the
    /// regions held change.
    solid_regions: Vec<usize>,
    solid_counts: [usize; 3],
    /// Cells of `zone`'s grid kept free of trees and scarecrows: the zone's, plus ground cleared for houses.
    pub clear: Vec<u8>,
    /// Built pieces already made solid, as "owner:what" keys, so each is added once.
    pub added: BTreeSet<String>,
    /// Everyone's vehicles as they stood when this tick began, which everyone but their owner bumps
    /// into (src/engine/shapes.ts World.movers).
    pub movers: Vec<Mover>,
    /// Where someone knocked down gets up again, if not at the island's spawn (a dungeon's copy).
    pub respawn: Option<dungeon::Spot>,
}

/// One circle of a vehicle, with whose it is, the height it stands at and how tall it is.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Mover {
    pub owner: i64,
    pub x: f64,
    pub z: f64,
    pub r: f64,
    pub y: f64,
    pub height: f64,
}

/// How far round the chunks a simulation plays it holds the world's regions: a chunk, so what's
/// across a border is there to see, and to step into before it's handed over.
pub const SIM_BAND: f64 = 256.0;

impl OpenWorld {
    /// A copy of one of the world's regions (shared/world.json), with every region grown and solid.
    pub fn new(zone: &'static Zone) -> Self {
        Self::on(world_map(), zone)
    }

    /// A copy of one of `map`'s regions, with every region grown and solid.
    pub fn on(map: &WorldMap, zone: &'static Zone) -> Self {
        let mut w = Self::holding(map.view(), zone);
        w.hold(&(0..map.regions().len()).collect::<Vec<_>>());
        w
    }

    /// A copy of one of the world's regions holding that region alone: the browser's rules, which
    /// adopt the regions near you as its worker grows them (`adopt`), and grow on the spot only what
    /// they're asked about before then.
    pub fn alone(zone: &'static Zone) -> Self {
        let map = world_map();
        let mut w = Self::holding(map.view(), zone);
        if let Some(i) = map.place_of(&zone.recipe.id) {
            w.hold(&[i]);
        }
        w
    }

    /// A world for a simulation playing `chunks`: it holds the regions standing on them and those
    /// within `band` metres of them (`SIM_BAND`), and what's solid in it is theirs.
    pub fn playing(map: &WorldMap, zone: &'static Zone, chunks: &[(i32, i32)], band: f64) -> Self {
        let mut w = Self::holding(map.view(), zone);
        w.play(chunks, band);
        w
    }

    /// A world holding what `map` holds (and solid with it).
    fn holding(map: WorldMap, zone: &'static Zone) -> Self {
        let mut w = OpenWorld {
            map,
            zone,
            index: ColliderIndex::default(),
            solid_regions: Vec::new(),
            solid_counts: [0; 3],
            clear: zone.clear.clone(),
            added: BTreeSet::new(),
            movers: Vec::new(),
            respawn: None,
        };
        w.make_regions_solid();
        w
    }

    /// Plays `chunks` from now on: holds the regions standing on them and within `band` of them,
    /// growing those it doesn't hold and dropping the rest.
    pub fn play(&mut self, chunks: &[(i32, i32)], band: f64) {
        let want = self.map.around(chunks, band);
        self.hold(&want);
    }

    /// Holds exactly the regions at `want` (places in the map), and what's solid follows them; what's
    /// been built since stays solid.
    pub fn hold(&mut self, want: &[usize]) {
        self.map.hold(want);
        self.make_regions_solid();
    }

    /// Holds a region grown elsewhere (the browser's worker grows them), solid from then on.
    pub fn adopt(&mut self, i: usize, grown: map::Grown) -> Result<(), String> {
        self.map.adopt(i, grown)?;
        self.make_regions_solid();
        Ok(())
    }

    /// Lets a region go: no longer held, nor solid.
    pub fn release(&mut self, i: usize) {
        self.map.release(i);
        self.make_regions_solid();
    }

    /// The regions this world holds (places in the map, in its order).
    pub fn held(&self) -> Vec<usize> {
        self.map.held()
    }

    /// Makes what's solid the colliders of the regions held, in the map's order, followed by what's
    /// been built since; nothing changes if the regions held are those already solid. A region the
    /// rules grew on the spot (ground asked for that wasn't held) is made solid here too.
    pub fn make_regions_solid(&mut self) {
        let held = self.map.held();
        if held == self.solid_regions {
            return;
        }
        let i = &self.index;
        let [o, b, d] = self.solid_counts;
        let built = (i.obstacles[o..].to_vec(), i.boxes[b..].to_vec(), i.decks[d..].to_vec());
        let (mut obstacles, mut boxes, mut decks) = (Vec::new(), Vec::new(), Vec::new());
        for &r in &held {
            let z = &self.map.held_region(r).expect("held").zone;
            obstacles.extend_from_slice(&z.obstacles);
            boxes.extend_from_slice(&z.boxes);
            decks.extend_from_slice(&z.decks);
        }
        self.solid_counts = [obstacles.len(), boxes.len(), decks.len()];
        obstacles.extend(built.0);
        boxes.extend(built.1);
        decks.extend(built.2);
        self.index = ColliderIndex::new(obstacles, boxes, decks);
        self.solid_regions = held;
    }

    /// Whether the regions held aren't those solid (one grown on the spot since it was made solid).
    pub fn solid_behind(&self) -> bool {
        self.map.held() != self.solid_regions
    }

    /// What's solid that was built since its regions were (house floors and walls, scarecrow posts,
    /// a copy's floors and walls): obstacles, boxes and decks.
    pub fn built(&self) -> (&[zone::Obstacle], &[zone::BoxCollider], &[zone::Deck]) {
        let [o, b, d] = self.solid_counts;
        (&self.index.obstacles[o..], &self.index.boxes[b..], &self.index.decks[d..])
    }

    /// Forgets everything built since its regions were made solid (house floors and walls,
    /// scarecrow posts) and the ground cleared for it, so whoever keeps the land can make what still
    /// stands solid again: a house taken down leaves nothing standing.
    pub fn unbuild(&mut self) {
        let [o, b, d] = self.solid_counts;
        let i = &self.index;
        self.index = ColliderIndex::new(i.obstacles[..o].to_vec(), i.boxes[..b].to_vec(), i.decks[..d].to_vec());
        self.added.clear();
        self.clear = self.zone.clear.clone();
    }

    /// The ground, across every region and the sea between them.
    pub fn terrain(&self) -> &WorldMap {
        &self.map
    }

    /// The grid of the region this world is a copy of (its cleared cells are on it).
    pub fn grid(&self) -> &'static Heightfield {
        &self.zone.terrain
    }

    /// Where someone gets back up after being knocked down, and where a player with nowhere of their
    /// own stands: in a copy of an instance where it's entered (its file's arrival), else at the spawn
    /// of the region this world is a copy of (its recipe's). Both are data: the rules name no spot.
    pub fn spawn_point(&self) -> Spawn {
        match self.respawn {
            Some(r) => Spawn { x: r.x, z: r.z, facing: r.facing },
            None => {
                let s = self.zone.recipe.spawn;
                Spawn { x: s.x, z: s.z, facing: s.facing }
            }
        }
    }
}

/// What the open-world rules act on each step: one player, the world they are in, and whose
/// things anything they build belongs to. The world is only read while a player steps: everyone in
/// a channel steps against the same world, whatever order they go in, and what they build is made
/// solid once the step is over (`Life::make_solid`).
pub struct Sim<'a> {
    pub player: &'a mut Player,
    pub world: &'a OpenWorld,
    /// The character this player is (their colliders are kept apart from everyone else's).
    pub owner: i64,
}

impl<'a> Sim<'a> {
    /// The ground, across every region and the sea between them.
    pub fn terrain(&self) -> &'a WorldMap {
        &self.world.map
    }

    pub fn zone(&self) -> &'static Zone {
        self.world.zone
    }
}

/// One step of the rules for one player in an open world, as the server runs it (no training dummy,
/// no hit pause, no auto-aim), with the island's systems (`life`) riding along when the player has
/// an island. `owner` is the character, for whatever they build. The world is only read: a channel
/// steps each of its players against one world, in any order or all at once (crate::combat), and
/// what they build is made solid once they all have (`Life::make_solid`).
pub fn step_player(p: &mut Player, a: &Actions, world: &OpenWorld, mut life: Option<&mut Life>, owner: i64) {
    p.begin_step(a);
    let mut sim = Sim { player: p, world, owner };

    if sim.player.down_frame >= 0 {
        // Knocked down: lie still, then get back up where this world puts you (a region's spawn, for
        // both sides; in a copy of an instance, where you came in).
        if sim.player.update_down() {
            let s = sim.world.spawn_point();
            sim.player.respawn(s);
            sim.player.pos.y = match sim.world.respawn {
                Some(r) => r.y,
                // On your feet on the ground there, not inside the hill.
                None => {
                    let hf = sim.terrain();
                    colliders::ground_at(hf, &sim.world.index, s.x, s.z, hf.height(s.x, s.z) + 1.2, 1.2)
                }
            };
            sim.player.respawned();
        }
    } else if sim.player.stun > 0 {
        sim.player.update_stun();
    } else {
        match sim.player.mode {
            Mode::Action => sim.player.update_action(a),
            Mode::Cast => sim.player.update_cast(a),
            Mode::Attack => sim.player.update_attack(a),
            Mode::Swim => traverse::update_swim(&mut sim, a),
            Mode::Glide => traverse::update_glide(&mut sim, a),
            Mode::Ride => match life.as_deref_mut() {
                Some(l) => l.ride(&mut sim, a),
                // Nothing to ride without the island's vehicles: back on foot, as
                // src/engine/life/vehicles.ts rideVehicle does when the vehicle is gone.
                None => {
                    sim.player.mode = Mode::Normal;
                    sim.player.vehicle = 0;
                }
            },
            Mode::Normal => {
                // In the air with both jumps spent, jump again to open your glider.
                let p = &*sim.player;
                if !p.grounded && p.jump_buffer > 0 && p.jumps_used >= 2 && traverse::open_glider(&mut sim) {
                    traverse::update_glide(&mut sim, a);
                } else {
                    sim.player.update_normal(a);
                }
            }
        }
    }

    // A cast that finished and a movement skill that started are practice for them, counted the
    // moment they happen (the `cast` and `action` events), so the island's step
    // below picks up any level they gained. Hits are counted where they land (crate::combat).
    if let Some(l) = life.as_deref_mut() {
        let p = &*sim.player;
        if p.fired_ability != NO_ABILITY {
            l.observe(Observed::Cast { ability: p.fired_ability });
        }
        if p.started_action != NO_MOVEMENT {
            l.observe(Observed::Action { id: p.started_action });
        }
    }

    sim.player.update_crouch_frame();
    traverse::integrate_open(&mut sim);
    sim.player.check_shot();
    if let Some(l) = life {
        l.step(&mut sim, a);
    }
    sim.player.end_step();
}
