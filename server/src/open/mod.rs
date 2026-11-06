//! Open worlds on the server: Emberholm's ground, colliders and getting around it, and the world
//! each channel plays in. The browser predicts your own moves with the TypeScript rules
//! (src/sim/player/traverse.ts, src/sim/zone/*); these are their Rust twins, and
//! tests/world-conformance.spec.ts runs both and compares them frame by frame.

pub mod colliders;
pub mod dungeon;
pub mod traverse;
pub mod zone;

use std::collections::HashSet;

use crate::life::progress::Observed;
use crate::life::Life;
use crate::player::{Actions, Mode, Player};
use crate::tuning::{NO_ABILITY, NO_MOVEMENT};
use crate::world::Spawn;
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
    /// Everyone's vehicles as they stood when this tick began, which everyone but their owner bumps
    /// into (src/sim/types.ts World.movers).
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

impl OpenWorld {
    pub fn new(zone: &'static Zone) -> Self {
        OpenWorld {
            zone,
            index: ColliderIndex::new(zone.obstacles.clone(), zone.boxes.clone(), zone.decks.clone()),
            clear: zone.clear.clone(),
            radius: zone.radius,
            added: HashSet::new(),
            movers: Vec::new(),
            respawn: None,
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
pub fn step_player(p: &mut Player, a: &Actions, world: &mut OpenWorld, mut life: Option<&mut Life>, owner: i64) {
    p.begin_step(a);
    // The island has one spawn, and the TypeScript gives it to both teams.
    let s = world.zone.recipe.spawn;
    let mut sim = Sim { player: p, world, owner };

    if sim.player.down_frame >= 0 {
        // Knocked down: lie still, then get back up at the island's spawn (in a dungeon, where you
        // came in).
        if sim.player.update_down() {
            if let Some(r) = sim.world.respawn {
                sim.player.respawn(Spawn { x: r.x, z: r.z, facing: r.facing });
                sim.player.pos.y = r.y;
            } else {
                sim.player.respawn(Spawn { x: s.x, z: s.z, facing: s.facing });
                // On your feet on the ground there, not inside the hill (respawn() is the
                // battlefield's, flat at 0): the TypeScript's respawn does the same with the
                // island's terrain.
                let hf = sim.terrain();
                sim.player.pos.y = colliders::ground_at(hf, &sim.world.index, s.x, s.z, hf.height(s.x, s.z) + 1.2, 1.2);
            }
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
                // src/sim/life/vehicles.ts rideVehicle does when the vehicle is gone.
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
    // moment the TypeScript reports them (its `cast` and `action` events), so the island's step
    // below picks up any level they gained. Hits are counted where they land (game.rs).
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
    if let Some(l) = life {
        l.step(&mut sim, a);
    }
    sim.player.end_step();
}
