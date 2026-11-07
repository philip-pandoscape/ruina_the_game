//! What a simulation's tick produced, as data: what everyone else may see, sorted into 32 m cells,
//! and what is private to each player. The simulation builds it once a tick and sends it to the
//! gates that have players there ([`crate::gate::ToGate::Tick`]); a gate builds each client's update
//! from the cells around it and that client's private state, and encodes it (today as the JSON the
//! browser has always read: `crates/server/src/gate/encode.rs`).
//!
//! The field names are the browser's (camelCase), so the JSON encoding of a record is the record.
//!
//! The entity records here (presence, creatures, arrows, meteors, effects) are the JSON path's:
//! the wire workstream's packed records (crates/wire: a frame of records per cell, assembled per
//! client by a viewer) take the place of `TickOut::cells` when the gate sends its binary protocol,
//! and these go. [`Private`] (a player's own state, their life, what was said to them) and
//! [`TableRecord`] stay.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use ruina_engine::actor::Actor;
use ruina_engine::combat::{Arrow, Effect, Meteor};
use ruina_engine::life::state::{LifeState, Pack, Vehicle, Weather};
use ruina_engine::life::{Life, LifeEvent, Placement};
use ruina_engine::player::{Mode, Player, V3};
use ruina_engine::skills::SkillSet;
use ruina_engine::tuning::{HOTBAR_SLOTS, MOVEMENT_SLOTS};

use crate::ids::{CharacterId, EntityId, SimId, SpaceId, Tick};

/// The side of a cell, in metres: what a client is sent is picked cell by cell.
pub const CELL: f64 = 32.0;

/// A cell: (x, z) in whole cells from the space's origin.
pub type CellKey = (i32, i32);

/// The cell a point is in.
pub fn cell_of(x: f64, z: f64) -> CellKey {
    ((x / CELL).floor() as i32, (z / CELL).floor() as i32)
}

/// The cells a circle of `radius` round (x, z) touches, in order.
pub fn cells_round(x: f64, z: f64, radius: f64) -> impl Iterator<Item = CellKey> {
    let (x0, z0) = cell_of(x - radius, z - radius);
    let (x1, z1) = cell_of(x + radius, z + radius);
    (x0..=x1).flat_map(move |cx| (z0..=z1).map(move |cz| (cx, cz)))
}

/// One tick of a simulation, for the gates.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TickOut {
    pub sim: SimId,
    pub space: Option<SpaceId>,
    pub tick: Tick,
    /// What others see, by cell, in the order of their keys.
    pub cells: Vec<Cell>,
    /// What each player alone is sent, in the order of their characters.
    pub private: Vec<Private>,
    /// Once a second: how the simulation is running, for admins.
    pub stats: Option<Stats>,
}

impl TickOut {
    /// A player's private part.
    pub fn private_of(&self, character: CharacterId) -> Option<&Private> {
        self.private.binary_search_by_key(&character, |p| p.character).ok().map(|i| &self.private[i])
    }

    /// A cell, if anything is in it.
    pub fn cell(&self, at: CellKey) -> Option<&Cell> {
        self.cells.binary_search_by_key(&at, |c| c.at).ok().map(|i| &self.cells[i])
    }
}

/// Everything others may see in one 32 m cell.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Cell {
    pub at: CellKey,
    pub players: Vec<PresenceRecord>,
    pub creatures: Vec<CreatureRecord>,
    pub arrows: Vec<ArrowRecord>,
    pub meteors: Vec<MeteorRecord>,
    pub effects: Vec<EffectRecord>,
    /// Mini-games' tables thrown down here.
    pub tables: Vec<TableRecord>,
}

/// A player (or a bot) as everyone else sees them.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PresenceRecord {
    pub id: EntityId,
    pub name: String,
    pub bot: bool,
    pub p: Presence,
}

/// What everyone else needs to draw a player (src/net/worldPeers.ts SHOWN reads these), with their
/// vehicles and packs. `fr` counts 60ths of a second, for blending between updates.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub fr: u64,
    pub pos: V3,
    pub vel: V3,
    pub facing: f64,
    pub mode: Mode,
    pub grounded: bool,
    pub attack_index: usize,
    pub attack_frame: i32,
    pub flip_frame: i32,
    pub land_frame: i32,
    pub land_impact: f64,
    pub takeoff_frame: i32,
    pub run_phase: f64,
    pub stun: i32,
    pub down_frame: i32,
    pub team: u8,
    pub weapon: u8,
    pub combo_variants: u8,
    pub action_id: u8,
    pub action_frame: i32,
    pub cast_ability: u8,
    pub cast_frame: i32,
    pub bank: f64,
    pub pack: i64,
    pub vehicle: i64,
    pub seat: u8,
    pub host: i64,
    pub glider: String,
    pub airspeed: f64,
    pub sprinting: bool,
    pub crouching: bool,
    pub crouch_frame: i32,
    pub hp: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vehicles: Option<Vec<Vehicle>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub packs: Option<Vec<Pack>>,
}

impl Presence {
    /// A player as others see them at frame `fr`, with what of their life moves with them.
    pub fn of(p: &Player, life: Option<&Life>, fr: u64) -> Presence {
        Presence {
            fr,
            pos: p.pos,
            vel: p.vel,
            facing: p.facing,
            mode: p.mode,
            grounded: p.grounded,
            attack_index: p.attack_index,
            attack_frame: p.attack_frame,
            flip_frame: p.flip_frame,
            land_frame: p.land_frame,
            land_impact: p.land_impact,
            takeoff_frame: p.takeoff_frame,
            run_phase: p.run_phase,
            stun: p.stun,
            down_frame: p.down_frame,
            team: p.team,
            weapon: p.weapon,
            combo_variants: p.resolved.combo_variant_bits,
            action_id: p.action_id,
            action_frame: p.action_frame,
            cast_ability: p.cast_ability,
            cast_frame: p.cast_frame,
            bank: p.bank,
            pack: p.pack,
            vehicle: p.vehicle,
            seat: p.seat,
            host: p.host,
            glider: p.glider.clone(),
            airspeed: p.airspeed,
            sprinting: p.sprinting,
            crouching: p.crouching,
            crouch_frame: p.crouch_frame,
            hp: p.hp,
            vehicles: life.map(|l| l.state.vehicles.clone()),
            packs: life.map(|l| l.state.packs.clone()),
        }
    }
}

/// A creature as everyone sees it (src/net/worldFeed.ts NetActor). Heights are above its own patch
/// of ground; the browser adds the ground.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatureRecord {
    pub id: EntityId,
    /// Its kind, by its place in the creatures' bundle.
    pub kind: u8,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub facing: f64,
    pub state: usize,
    /// How far through what it's doing (0 to 1).
    pub progress: f64,
    /// Its health, as a share of its most.
    pub hp: f64,
    pub dead_frame: i32,
    pub target_x: f64,
    pub target_z: f64,
}

impl CreatureRecord {
    pub fn of(a: &Actor) -> CreatureRecord {
        CreatureRecord {
            id: EntityId::creature(a.id),
            kind: a.kind_index,
            x: a.x,
            y: a.y,
            z: a.z,
            facing: a.facing,
            state: a.state,
            progress: if a.wait > 0 { (a.state_frame as f64 / a.wait as f64).clamp(0.0, 1.0) } else { 0.0 },
            hp: if a.max_hp > 0.0 { a.hp / a.max_hp } else { 0.0 },
            dead_frame: a.dead_frame,
            target_x: a.target_x,
            target_z: a.target_z,
        }
    }
}

/// An arrow in flight (src/net/worldFeed.ts ArrowRecord): `owner` is its shooter's slot.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct ArrowRecord {
    pub id: u16,
    pub owner: u16,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub vx: f64,
    pub vz: f64,
    pub team: u8,
}

impl ArrowRecord {
    pub fn of(a: &Arrow) -> ArrowRecord {
        ArrowRecord { id: a.id, owner: a.owner, x: a.x, y: a.y, z: a.z, vx: a.dx * a.speed, vz: a.dz * a.speed, team: a.team }
    }
}

/// A meteor on its way down (src/net/worldFeed.ts MeteorRecord).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeteorRecord {
    pub id: u16,
    pub x: f64,
    pub z: f64,
    pub ticks_left: u32,
    pub fall_ticks: u32,
    pub team: u8,
    pub radius: f64,
}

impl MeteorRecord {
    pub fn of(m: &Meteor) -> MeteorRecord {
        MeteorRecord { id: m.id, x: m.x, z: m.z, ticks_left: m.ticks_left, fall_ticks: m.fall_ticks, team: m.team, radius: m.radius }
    }
}

/// Something that happened, for effects in browsers (src/net/worldFeed.ts EffectEvent): its kind
/// (crates/engine/src/combat.rs), where, and its size.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct EffectRecord {
    pub kind: u16,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub size: u8,
}

impl EffectRecord {
    pub fn of(e: &Effect) -> EffectRecord {
        EffectRecord { kind: e.kind, x: e.x, y: e.y, z: e.z, size: e.size }
    }
}

/// A mini-game's table as everyone sees it: where it stands and its public face (each game's own,
/// crates/engine/src/minigames).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TableRecord {
    pub x: f64,
    pub z: f64,
    pub shown: Value,
}

/// What only one player is sent: their own player (to check the browser's prediction against),
/// their life when it changed, and what happened to them.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Private {
    pub character: CharacterId,
    pub you: You,
    /// Their whole life, when it changed (and every couple of seconds anyway).
    pub life: Option<LifeView>,
    /// What their life said this tick (toasts, sales, quests...).
    pub life_events: Vec<LifeEvent>,
    /// Effects about them alone (damage and healing they dealt or took).
    pub told: Vec<EffectRecord>,
}

/// Your own state (src/net/worldLink.ts WorldTick.you): your slot, the last input run, your player,
/// and the parts of your life that move with you (vehicles, the clock and the wind for sailing).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct You {
    /// Your slot among the players (arrows name their shooter by it).
    pub id: usize,
    pub ack: u32,
    pub p: PlayerState,
    pub clock: f64,
    pub labor: f64,
    pub resting: bool,
    pub vehicles: Vec<Vehicle>,
    pub weather: Weather,
    pub placing: Option<Placement>,
}

impl You {
    pub fn of(slot: usize, ack: u32, p: &Player, life: &Life) -> You {
        You {
            id: slot,
            ack,
            p: PlayerState::of(p),
            clock: life.state.clock,
            labor: life.state.labor,
            resting: life.resting,
            vehicles: life.state.vehicles.clone(),
            weather: life.state.weather.clone(),
            placing: life.placing.clone(),
        }
    }
}

/// A whole life, for its owner's browser to show.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LifeView {
    pub rev: u64,
    pub state: LifeState,
    pub placing: Option<Placement>,
    pub resting: bool,
}

impl LifeView {
    pub fn of(life: &Life) -> LifeView {
        LifeView { rev: life.revision, state: life.state.clone(), placing: life.placing.clone(), resting: life.resting }
    }
}

/// How a simulation is running, once a second, for admins (the gate adds the update's size).
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub tick: Tick,
    pub players: usize,
    pub bots: usize,
    pub tick_ms: f64,
    pub pvp_hits: u64,
    pub saved_by_rewind: u64,
    pub rewind_ms: f64,
    pub heals: u64,
    pub meteors_landed: u64,
}

/// A player's whole state, in the shape of src/engine/shapes.ts PlayerState: what the browser
/// corrects its prediction from, and what a player is carried between processes as
/// ([`crate::sim::Carried`]). What a step only keeps for itself (its events, the yard's aim assist)
/// isn't in it, and the skills' numbers are worked out again from the build and the levels.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub pos: V3,
    pub vel: V3,
    pub facing: f64,
    pub mode: Mode,
    pub grounded: bool,
    pub jumps_used: i32,
    pub jump_cut_done: bool,
    pub coyote: i32,
    pub jump_buffer: i32,
    pub attack_buffer: i32,
    pub action_buffer: i32,
    pub action_buffer_id: u8,
    pub attack_index: usize,
    pub attack_frame: i32,
    pub attack_queued: bool,
    pub attack_hit: bool,
    pub flip_frame: i32,
    pub land_frame: i32,
    pub land_impact: f64,
    pub takeoff_frame: i32,
    pub run_phase: f64,
    pub hp: f64,
    pub stamina: f64,
    pub stamina_delay: i32,
    pub mp: f64,
    pub stun: i32,
    pub down_frame: i32,
    pub team: u8,
    pub weapon: u8,
    pub skills: SkillSet,
    pub combo_variants: u8,
    pub abilities: [u8; HOTBAR_SLOTS],
    pub cooldowns: [i32; HOTBAR_SLOTS],
    pub ability_buffer: i32,
    pub ability_buffer_slot: u8,
    pub movement: [u8; MOVEMENT_SLOTS],
    pub movement_cooldowns: Vec<i32>,
    pub action_id: u8,
    pub action_frame: i32,
    pub action_dir_x: f64,
    pub action_dir_z: f64,
    pub action_slot: u8,
    pub sprinting: bool,
    pub crouching: bool,
    pub crouch_frame: i32,
    pub cast_ability: u8,
    pub cast_slot: u8,
    pub cast_frame: i32,
    pub cast_target_x: f64,
    pub cast_target_z: f64,
    pub fired_ability: u8,
    pub pack: i64,
    pub vehicle: i64,
    pub seat: u8,
    pub host: i64,
    pub glider: String,
    pub airspeed: f64,
    pub bank: f64,
    pub mode_frame: i32,
    pub gust_frames: i32,
}

impl PlayerState {
    pub fn of(p: &Player) -> PlayerState {
        PlayerState {
            pos: p.pos,
            vel: p.vel,
            facing: p.facing,
            mode: p.mode,
            grounded: p.grounded,
            jumps_used: p.jumps_used,
            jump_cut_done: p.jump_cut_done,
            coyote: p.coyote,
            jump_buffer: p.jump_buffer,
            attack_buffer: p.attack_buffer,
            action_buffer: p.action_buffer,
            action_buffer_id: p.action_buffer_id,
            attack_index: p.attack_index,
            attack_frame: p.attack_frame,
            attack_queued: p.attack_queued,
            attack_hit: p.attack_hit,
            flip_frame: p.flip_frame,
            land_frame: p.land_frame,
            land_impact: p.land_impact,
            takeoff_frame: p.takeoff_frame,
            run_phase: p.run_phase,
            hp: p.hp,
            stamina: p.stamina,
            stamina_delay: p.stamina_delay,
            mp: p.mp,
            stun: p.stun,
            down_frame: p.down_frame,
            team: p.team,
            weapon: p.weapon,
            skills: p.skills,
            combo_variants: p.resolved.combo_variant_bits,
            abilities: p.abilities,
            cooldowns: p.cooldowns,
            ability_buffer: p.ability_buffer,
            ability_buffer_slot: p.ability_buffer_slot,
            movement: p.movement,
            movement_cooldowns: p.movement_cooldowns.clone(),
            action_id: p.action_id,
            action_frame: p.action_frame,
            action_dir_x: p.action_dir_x,
            action_dir_z: p.action_dir_z,
            action_slot: p.action_slot,
            sprinting: p.sprinting,
            crouching: p.crouching,
            crouch_frame: p.crouch_frame,
            cast_ability: p.cast_ability,
            cast_slot: p.cast_slot,
            cast_frame: p.cast_frame,
            cast_target_x: p.cast_target_x,
            cast_target_z: p.cast_target_z,
            fired_ability: p.fired_ability,
            pack: p.pack,
            vehicle: p.vehicle,
            seat: p.seat,
            host: p.host,
            glider: p.glider.clone(),
            airspeed: p.airspeed,
            bank: p.bank,
            mode_frame: p.mode_frame,
            gust_frames: p.gust_frames,
        }
    }

    /// Sets a player to this state (their build and its numbers too; their levels are their life's).
    pub fn apply(&self, p: &mut Player) {
        // The build first: putting one on resets what a swing was in the middle of.
        p.apply_build(ruina_engine::player::Build { skills: self.skills, weapon: self.weapon, abilities: self.abilities, movement: self.movement });
        p.pos = self.pos;
        p.prev_pos = self.pos;
        p.vel = self.vel;
        p.facing = self.facing;
        p.prev_facing = self.facing;
        p.mode = self.mode;
        p.grounded = self.grounded;
        p.jumps_used = self.jumps_used;
        p.jump_cut_done = self.jump_cut_done;
        p.coyote = self.coyote;
        p.jump_buffer = self.jump_buffer;
        p.attack_buffer = self.attack_buffer;
        p.action_buffer = self.action_buffer;
        p.action_buffer_id = self.action_buffer_id;
        p.attack_index = self.attack_index;
        p.attack_frame = self.attack_frame;
        p.attack_queued = self.attack_queued;
        p.attack_hit = self.attack_hit;
        p.flip_frame = self.flip_frame;
        p.land_frame = self.land_frame;
        p.land_impact = self.land_impact;
        p.takeoff_frame = self.takeoff_frame;
        p.run_phase = self.run_phase;
        p.hp = self.hp;
        p.stamina = self.stamina;
        p.stamina_delay = self.stamina_delay;
        p.mp = self.mp;
        p.stun = self.stun;
        p.down_frame = self.down_frame;
        p.team = self.team;
        p.cooldowns = self.cooldowns;
        p.ability_buffer = self.ability_buffer;
        p.ability_buffer_slot = self.ability_buffer_slot;
        p.movement_cooldowns = self.movement_cooldowns.clone();
        p.action_id = self.action_id;
        p.action_frame = self.action_frame;
        p.action_dir_x = self.action_dir_x;
        p.action_dir_z = self.action_dir_z;
        p.action_slot = self.action_slot;
        p.sprinting = self.sprinting;
        p.crouching = self.crouching;
        p.crouch_frame = self.crouch_frame;
        p.cast_ability = self.cast_ability;
        p.cast_slot = self.cast_slot;
        p.cast_frame = self.cast_frame;
        p.cast_target_x = self.cast_target_x;
        p.cast_target_z = self.cast_target_z;
        p.fired_ability = self.fired_ability;
        p.pack = self.pack;
        p.vehicle = self.vehicle;
        p.seat = self.seat;
        p.host = self.host;
        p.glider = self.glider.clone();
        p.airspeed = self.airspeed;
        p.bank = self.bank;
        p.mode_frame = self.mode_frame;
        p.gust_frames = self.gust_frames;
    }
}
