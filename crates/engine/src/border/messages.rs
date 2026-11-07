//! What simulations say to each other across a border: plain values, read and written whole
//! (serde), so they cross a thread or a process as they cross a function call (crates/world-api
//! carries them between the server's simulations). Each is a [`Post`]: who from, who to, the tick it
//! belongs to and what it [`Says`].

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{Epoch, SimId};
use crate::actor::Actor;
use crate::actors::{FoeHit, Slam};
use crate::bots::Bot;
use crate::combat::{Across, Departing, History};
use crate::ids::EntityId;
use crate::life::state::{LifeState, Vehicle};
use crate::life::{Command, Life, LifeEvent, Placement};
use crate::open::map::WorldMap;
use crate::player::{Actions, Player};

/// One message from one simulation to another.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Post {
    pub from: SimId,
    pub to: SimId,
    /// The world's tick it belongs to.
    pub tick: u64,
    pub says: Says,
}

/// What a post says.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Says {
    /// What the sender owns near the receiver, as it stands at this point of the tick.
    Ghosts(Ghosts),
    /// Blows and heals on what the receiver owns, and what its players are told of blows that
    /// landed with the sender (crate::combat).
    Across(Across),
    /// Creatures' slams and blows that reach what the receiver owns.
    Struck(Struck),
    /// Players handed over, whole.
    Handoff(Handoff),
    /// The receiver's handoff taken: the players are the sender's now.
    Taken(Taken),
    /// Inputs for a player the sender no longer owns, sent on to whoever does.
    Inputs(Inputs),
}

impl Post {
    /// How many bytes it takes written out (JSON; a binary form takes fewer).
    pub fn bytes(&self) -> usize {
        serde_json::to_string(self).map_or(0, |s| s.len())
    }
}

/// The points of a tick where the simulations of a world trade, in order: wherever one phase reads
/// what the one before it changed (crate::combat). Each simulation sends each neighbour one parcel
/// at each, and goes on once it has every neighbour's (lockstep), or with what it has so far (a
/// tick late).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
pub enum Barrier {
    /// As a tick begins: the handoffs made as the last one ended, and the tick each is on.
    Start,
    /// Who was taken, and the ghosts of whoever changed hands.
    Arrived,
    /// The inputs' blows and heals on what others own.
    Inputs,
    /// What's told of the inputs' blows and heals, to whoever dealt or took them.
    InputsTold,
    /// Ghosts, players and creatures, once everyone has moved and the passengers sit.
    Seated,
    /// The arrows' and meteors' blows on what others own.
    Effects,
    /// What's told of them.
    EffectsTold,
    /// Ghosts of the players, as the arrows and meteors left them, for the creatures to see.
    Hit,
    /// The creatures' slams and blows on others' players.
    Struck,
    /// Ghosts, players and creatures, as the tick ends, for the history.
    Stood,
}

// ---------- Ghosts ----------

/// Read-only copies of what a simulation owns within [`super::BAND`] of a neighbour's chunks: each
/// player and creature as it stands, with its history the first time the neighbour sees it (after
/// that the neighbour keeps it, as it keeps its own); and those it no longer sees.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Ghosts {
    pub players: Vec<GhostPlayer>,
    pub creatures: Vec<GhostCreature>,
    /// Players (by slot) and creatures (by id) gone out of sight.
    pub gone: Vec<usize>,
    pub gone_creatures: Vec<u32>,
}

impl Ghosts {
    pub fn is_empty(&self) -> bool {
        self.players.is_empty() && self.creatures.is_empty() && self.gone.is_empty() && self.gone_creatures.is_empty()
    }
}

/// A player seen across a border: in their slot, under the epoch their owner holds them by, with
/// their vehicles.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GhostPlayer {
    pub slot: usize,
    pub client: EntityId,
    pub owner: i64,
    pub epoch: Epoch,
    pub player: Player,
    pub vehicles: Vec<Vehicle>,
    pub history: Option<History>,
}

/// A creature seen across a border: what players' blows, arrows and blasts read of it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GhostCreature {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub radius: f64,
    pub hit_height: f64,
    pub hit_ceiling: f64,
    pub hp: f64,
    pub dead_frame: i32,
    /// What the neighbour's players are shown of it (a creature's record): its kind, facing, what
    /// it's doing and how far through, its health's share, where it aims.
    pub kind_index: u8,
    pub facing: f64,
    pub state: usize,
    pub state_frame: i32,
    pub wait: i32,
    pub max_hp: f64,
    pub target_x: f64,
    pub target_z: f64,
    pub history: Option<History>,
}

impl GhostCreature {
    pub fn of(a: &Actor, history: Option<History>) -> GhostCreature {
        GhostCreature {
            id: a.id,
            x: a.x,
            y: a.y,
            z: a.z,
            radius: a.radius,
            hit_height: a.hit_height,
            hit_ceiling: a.hit_ceiling,
            hp: a.hp,
            dead_frame: a.dead_frame,
            kind_index: a.kind_index,
            facing: a.facing,
            state: a.state,
            state_frame: a.state_frame,
            wait: a.wait,
            max_hp: a.max_hp,
            target_x: a.target_x,
            target_z: a.target_z,
            history,
        }
    }

    /// The creature as it's kept among a simulation's ghosts.
    pub fn actor(&self) -> Actor {
        let mut a = Actor::new(self.id, "", self.x, self.z, 0);
        a.y = self.y;
        a.radius = self.radius;
        a.hit_height = self.hit_height;
        a.hit_ceiling = self.hit_ceiling;
        a.hp = self.hp;
        a.dead_frame = self.dead_frame;
        a.kind_index = self.kind_index;
        a.facing = self.facing;
        a.state = self.state;
        a.state_frame = self.state_frame;
        a.wait = self.wait;
        a.max_hp = self.max_hp;
        a.target_x = self.target_x;
        a.target_z = self.target_z;
        a
    }
}

// ---------- Creatures' slams and blows ----------

/// Where a creature's slam or blow falls among a tick's: its frame, then blows before what was
/// thrown, then by whom (a creature by its id, a missile by its), then in the order they came.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
pub struct Blowing {
    pub frame: u32,
    pub missile: bool,
    pub by: u32,
    pub n: u32,
}

impl Blowing {
    /// Where a slam falls, the `n`-th of its creature's in `frame`.
    pub fn slam(frame: u32, s: &Slam, n: u32) -> Blowing {
        Blowing { frame, missile: false, by: s.by, n }
    }

    /// Where a creature's blow or missile falls, the `n`-th of its in `frame`.
    pub fn hit(frame: u32, h: &FoeHit, n: u32) -> Blowing {
        if h.missile != 0 { Blowing { frame, missile: true, by: h.missile, n } } else { Blowing { frame, missile: false, by: h.by, n } }
    }
}

/// A slam as it travels.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct SlamSent {
    pub x: f64,
    pub z: f64,
    pub radius: f64,
    pub damage: f64,
    pub knock: f64,
    pub by: u32,
}

impl SlamSent {
    pub fn of(s: &Slam) -> SlamSent {
        SlamSent { x: s.x, z: s.z, radius: s.radius, damage: s.damage, knock: s.knock, by: s.by }
    }

    pub fn slam(&self) -> Slam {
        Slam { x: self.x, z: self.z, radius: self.radius, damage: self.damage, knock: self.knock, by: self.by }
    }
}

/// A creature's blow or missile as it travels.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct HitSent {
    pub foe: u32,
    pub damage: f64,
    pub nx: f64,
    pub nz: f64,
    pub knock: f64,
    pub by: u32,
    pub missile: u32,
}

impl HitSent {
    pub fn of(h: &FoeHit) -> HitSent {
        HitSent { foe: h.foe, damage: h.damage, nx: h.nx, nz: h.nz, knock: h.knock, by: h.by, missile: h.missile }
    }

    pub fn hit(&self) -> FoeHit {
        FoeHit { foe: self.foe, damage: self.damage, nx: self.nx, nz: self.nz, knock: self.knock, by: self.by, missile: self.missile }
    }
}

/// Creatures' slams that fall near what the receiver owns, and blows on its players: they land
/// among its own in the order they fell.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Struck {
    pub slams: Vec<(Blowing, SlamSent)>,
    pub hits: Vec<(Blowing, HitSent)>,
}

// ---------- Handoffs ----------

/// An input as it travels: its sequence number, the tick its player saw everyone at (none: the
/// present, as a bot sees), and what was pressed.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Input {
    pub seq: u32,
    pub view: Option<f64>,
    pub actions: Actions,
}

impl Input {
    pub fn of((seq, view, actions): (u32, f64, Actions)) -> Input {
        Input { seq, view: view.is_finite().then_some(view), actions }
    }

    pub fn queued(&self) -> (u32, f64, Actions) {
        (self.seq, self.view.unwrap_or(f64::INFINITY), self.actions)
    }
}

/// A player's inputs, sent on.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Inputs {
    pub client: EntityId,
    pub inputs: Vec<Input>,
}

/// A character's life as it travels: its state and what's going on in it, written whole. What's
/// worked out again each step (what F would do) doesn't travel.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LifeForm {
    /// The region it was made for (its zone).
    pub region: String,
    pub state: LifeState,
    pub placing: Option<Placement>,
    pub resting: bool,
    pub revision: u64,
    pub plot_owners: BTreeMap<String, String>,
    pub world_clock: Option<f64>,
    pub dungeon: Option<String>,
    /// What it has to say that hasn't been said yet.
    pub said: Vec<LifeEvent>,
}

impl LifeForm {
    /// A life written out, what it had to say taken with it.
    pub fn of(life: &mut Life) -> LifeForm {
        LifeForm {
            region: life.zone.recipe.id.clone(),
            state: life.state.clone(),
            placing: life.placing.clone(),
            resting: life.resting,
            revision: life.revision,
            plot_owners: life.plot_owners.clone(),
            world_clock: life.world_clock,
            dungeon: life.dungeon.clone(),
            said: life.drain_events(),
        }
    }

    /// The life again, in a world of `map`'s regions. None if it has no such region.
    pub fn life(self, map: &'static WorldMap) -> Option<Box<Life>> {
        let zone = map.zone(map.region(&self.region)?);
        let mut life = Box::new(Life::new(zone, None, None));
        // Made new, it greets you with its first quest: not this one, which has its own.
        life.drain_events();
        life.state = self.state;
        life.placing = self.placing;
        life.resting = self.resting;
        life.revision = self.revision;
        life.plot_owners = self.plot_owners;
        life.world_clock = self.world_clock;
        life.dungeon = self.dungeon;
        for e in self.said {
            life.emit(e);
        }
        Some(life)
    }
}

/// One player handed over: everything their slot held (crate::combat's `Departing`), the life
/// written out, and their bot's brain if they're a bot.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Moving {
    pub slot: usize,
    pub client: EntityId,
    pub owner: i64,
    /// The epoch they're handed over under: the old one and one.
    pub epoch: Epoch,
    pub player: Player,
    pub life: Option<LifeForm>,
    pub last_seq: u32,
    pub build_seq: u32,
    pub queue: Vec<Input>,
    pub commands: Vec<(u32, Command)>,
    pub budget: f64,
    pub history: History,
    pub bot: Option<Bot>,
}

impl Moving {
    /// A departing player as they travel.
    pub fn of(mut d: Departing, epoch: Epoch, bot: Option<Bot>) -> Moving {
        Moving {
            slot: d.slot,
            client: d.client,
            owner: d.owner,
            epoch,
            life: d.life.as_deref_mut().map(LifeForm::of),
            player: d.player,
            last_seq: d.last_seq,
            build_seq: d.build_seq,
            queue: d.queue.into_iter().map(Input::of).collect(),
            commands: d.commands,
            budget: d.budget,
            history: d.history,
            bot,
        }
    }

    /// The player again, to seat in a world of `map`'s regions (and their bot's brain).
    pub fn departing(self, map: &'static WorldMap) -> (Departing, Option<Bot>) {
        let mut player = self.player;
        player.resolve();
        let d = Departing {
            slot: self.slot,
            client: self.client,
            owner: self.owner,
            player,
            life: self.life.and_then(|l| l.life(map)),
            last_seq: self.last_seq,
            build_seq: self.build_seq,
            queue: self.queue.iter().map(Input::queued).collect(),
            commands: self.commands,
            budget: self.budget,
            history: self.history,
        };
        (d, self.bot)
    }

    /// The last input this player has been given, run or not.
    pub fn given(&self) -> u32 {
        self.queue.iter().map(|i| i.seq).max().unwrap_or(0).max(self.last_seq)
    }
}

/// Players handed over as one unit: one on their own, or a driver with the passengers riding in
/// their vehicle (the vehicle and its cargo are the driver's life's). Frozen at the end of `tick`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Handoff {
    pub players: Vec<Moving>,
}

/// A handoff taken: each player (by slot) under the epoch they were taken by, and the input they'll
/// run next, from which their inputs go to the taker.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Taken {
    pub players: Vec<(usize, EntityId, Epoch, u32)>,
}
