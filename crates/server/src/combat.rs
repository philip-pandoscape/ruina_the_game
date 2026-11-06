//! Real players on the server: joining and leaving, their builds (skills and loadout), running
//! their inputs in order, and everything that hurts or heals: weapon swings, arrows, meteors and
//! Healing Circles, plus monsters' slams and blows landing on players.
//!
//! Lag compensation: each input says which server tick the player was looking at. When a melee
//! swing is checked, other players are rewound to where that player saw them, so a hit on your
//! screen is a hit on the server.

use std::collections::{HashMap, VecDeque};

use crate::actors::{Actors, FoeHit, Slam};
use crate::ai::Foe;
use crate::content::kind_at;
use crate::jsmath::JsMath;
use crate::life::progress::{Observed, sync_levels};
use crate::life::{Command, Life};
use crate::open::OpenWorld;
use crate::open::dungeon::DungeonDef;
use crate::open::zone::Heightfield;
use crate::player::{Actions, Build, Player, angle_diff};
use crate::skills::allowed;
use crate::tuning::{AttackStep, HOTBAR_SLOTS, NO_ABILITY, ability, effect_amount, effect_damage, effect_radius, melee_targets, pierce_targets, tuning};
use crate::world::World;

pub const MAX_PLAYERS: usize = 4096;
// A little more than one tick's worth of 60 Hz inputs: catches up after a hiccup, but a client
// can't speed itself up by sending extra inputs.
const MAX_INPUTS_PER_TICK: usize = 12;
const BODY_RADIUS: f64 = 0.45;
const EFFECT_RADIUS: f64 = 90.0; // arrows, meteors and effects within this distance are sent
const HISTORY: usize = 40; // ticks of position history kept per player (2 s at 20 Hz)
const MAX_REWIND_TICKS: f64 = 16.0; // never rewind more than 0.8 s, however laggy the attacker
const ARROW_HEIGHT: f64 = 1.3; // arrows fly at chest height
const ARROW_RADIUS: f64 = 0.55; // how close an arrow has to pass to hit someone
const MARKER_HEIGHT: f64 = 1.1; // floating numbers sit about head height above whoever they're about
const MAX_OWN_EVENTS: usize = 24; // attributed events per player per tick; the rest are dropped
const SLAM_LIFT: f64 = 1.0; // a monster's slam only catches someone on the ground, not mid-jump

// What an effect sent to the browser is (an event's kind), as src/net/netSpells.ts reads it: these
// numbers are the wire's, so they never change. 1 to 3 are shown to everyone nearby (a heal's and
// an explosion's size is its radius in tenths of a metre).
const EVENT_HEAL: u16 = 1;
const EVENT_EXPLOSION: u16 = 2;
const EVENT_ARROW_HIT: u16 = 3;
// Attributed events, sent only to the player they are about, so the browser can label a number
// without the server naming who did it: their size is the damage or healing, their position the one
// it happened to, and the bits of the kind above the low 4 say what caused it (a cause), for the
// icon beside the number.
const EVENT_YOU_HIT: u16 = 4;
const EVENT_YOU_HURT: u16 = 5;
const EVENT_YOU_HEAL: u16 = 6;

// What caused an attributed event: what sort of thing it was in a cause's low 2 bits, and for a
// weapon or an ability its place in shared/tuning.json's list above them, so the icon is the
// content's whatever its order (src/net/netSpells.ts reads them).
const CAUSE_WEAPON: u16 = 1;
const CAUSE_ABILITY: u16 = 2;
const CAUSE_MONSTER: u16 = 3;

fn weapon_cause(weapon: u8) -> u16 {
    CAUSE_WEAPON | u16::from(weapon) << 2
}

fn ability_cause(ability: u8) -> u16 {
    CAUSE_ABILITY | u16::from(ability) << 2
}

// Inputs travel as small integers; the browser applies the same rounding to its own prediction.
fn input_axis(v: i8) -> f64 {
    v as f64 / 127.0
}

fn aim_axis(v: i8) -> f64 {
    v as f64 * 0.25
}

/// The combat-stance heading byte as a direction: 0 is none, 1..=255 a heading in 255 steps.
fn face_axis(v: u8) -> (f64, f64) {
    if v == 0 {
        return (0.0, 0.0);
    }
    let yaw = (v - 1) as f64 * std::f64::consts::TAU / 255.0;
    (yaw.js_sin(), yaw.js_cos())
}

/// One input as a browser packs it, 8 bytes: move x and z (i8, ±127 for full), the buttons (1 jump
/// pressed, 2 jump held, 4 attack pressed, 8 slide pressed, 16 sprint held, 32 crouch held), aim x
/// and z (i8: the target's offset from the player in quarter metres, 0, 0 straight ahead), the slot
/// used this frame (1..=HOTBAR_SLOTS the hotbar, past that a movement slot, 0 none), the movement
/// skill held, and the combat stance's heading (0 to face the way you move, else 1..=255 a heading
/// to keep facing).
pub fn actions_from(raw: [u8; 8]) -> Actions {
    let b = raw[2];
    let (face_x, face_z) = face_axis(raw[7]);
    Actions {
        move_x: input_axis(raw[0] as i8),
        move_z: input_axis(raw[1] as i8),
        jump_pressed: b & 1 != 0,
        jump_held: b & 2 != 0,
        attack_pressed: b & 4 != 0,
        slide_pressed: b & 8 != 0,
        sprint_held: b & 16 != 0,
        crouch_held: b & 32 != 0,
        ability_slot: if raw[5] <= HOTBAR_SLOTS as u8 { raw[5] } else { 0 },
        // Values past the hotbar are the movement slots, so one byte covers both.
        movement_slot: raw[5].saturating_sub(HOTBAR_SLOTS as u8),
        movement_held: raw[6],
        aim_x: aim_axis(raw[3] as i8),
        aim_z: aim_axis(raw[4] as i8),
        stick_x: 0.0,
        stick_y: 0.0,
        face_x,
        face_z,
    }
}

/// Open worlds: the 10 bytes a browser packs per input: actions_from's 8, plus the raw stick
/// (vehicles steer with it).
pub fn open_actions_from(raw: [u8; OPEN_INPUT]) -> Actions {
    let mut a = actions_from([raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7]]);
    a.stick_x = input_axis(raw[8] as i8);
    a.stick_y = input_axis(raw[9] as i8);
    a
}

/// Bytes per input in an open world's input message.
pub const OPEN_INPUT: usize = 10;

struct Slot {
    client_id: u32,
    player: Player,
    last_seq: u32,
    build_seq: u32,
    queue: VecDeque<(u32, f64, Actions)>,    // (seq, view tick, input)
    history: VecDeque<(u64, f64, f64, f64)>, // (tick, x, y, z) at the end of each tick
    // ---- Open worlds: the character's island, and what they asked it to do ----
    /// The character (whose houses and farms these are).
    owner: i64,
    life: Option<Box<Life>>,
    /// Commands, each with the input it was given on: it runs on that step (or the next one, if
    /// it arrives after that input has run).
    commands: VecDeque<(u32, Command)>,
    /// Inputs this player may still run: refilled at 60 a second, so a browser can catch up after
    /// a hiccup but can't run faster than the game.
    budget: f64,
}

/// The ground under a point: a copy's floor where it has one, the terrain, or 0 (a flat World, as
/// the balance harness's duels have).
fn ground_under(floor: Option<&'static DungeonDef>, terrain: Option<&'static Heightfield>, x: f64, z: f64) -> f64 {
    floor.and_then(|d| d.floor_at(x, z)).unwrap_or_else(|| terrain.map_or(0.0, |g| g.height(x, z)))
}

// Where `slot` stood at (fractional) tick `view`, from its history.
fn rewound(slot: &Slot, view: f64) -> (f64, f64, f64) {
    let h = &slot.history;
    let Some(&last) = h.back() else {
        return (slot.player.pos.x, slot.player.pos.y, slot.player.pos.z);
    };
    if view >= last.0 as f64 {
        return (last.1, last.2, last.3);
    }
    for k in (1..h.len()).rev() {
        let (a, b) = (h[k - 1], h[k]);
        if view >= a.0 as f64 {
            let f = (view - a.0 as f64) / (b.0 - a.0) as f64;
            return (a.1 + (b.1 - a.1) * f, a.2 + (b.2 - a.2) * f, a.3 + (b.3 - a.3) * f);
        }
    }
    (h[0].1, h[0].2, h[0].3)
}

struct Arrow {
    id: u16,
    owner: u16,        // player id of the shooter (their slot)
    owner_slot: usize, // and their slot, for "you hit X" events
    owner_client: u32, // and who was in it, so what it does is credited to them and nobody else
    weapon: u8,        // which weapon fired it (it trains that one)
    cause: u16,        // and for the icon on the damage number
    team: u8,
    x: f64,
    y: f64,
    z: f64,
    dx: f64, // flight direction (unit length)
    dz: f64,
    speed: f64,
    left: f64, // metres of range left
    damage: f64,
    knock: f64,
    pierce_left: usize, // how many more enemies it can go through
    hit: Vec<u32>,      // who it already hit: 1 << 30 | actor id, or 1 << 31 | player slot
}

struct Meteor {
    id: u16,
    owner_slot: usize, // who called it down, for "you hit X" events
    owner_client: u32, // and who was in that slot, for what it finishes off
    cause: u16,        // the ability that called it, for the icon on the damage number
    team: u8,
    x: f64,
    z: f64,
    ticks_left: u32,
    fall_ticks: u32,
    radius: f64,
    damage: f64,
    knock: f64,
}

// One melee hit waiting to be applied once every player has moved.
struct PlayerHit {
    attacker: usize,
    victim: usize,
    damage: f64,
    dx: f64,
    dz: f64,
    knock: f64,
    cause: u16,
}

// One player a Healing Circle reached.
struct HealHit {
    healer: usize,
    target: usize,
    amount: f64,
    cause: u16,
}

struct Event {
    kind: u16,
    x: f64,
    y: f64,
    z: f64,
    size: u8,
}

/// The hits a player landed with `weapon` (None: a blast, which trains nothing; its cast already
/// did), in the order they landed, each with the kind of creature it finished off if it did. Only
/// a player with an island learns from them (`Observed`, crate::life::progress): practice for the
/// weapon, and a defeat for the quests, hit then death for each in turn. A level gained changes the
/// player's numbers from the next step on.
fn credit(life: &mut Life, p: &mut Player, weapon: Option<u8>, landed: &[Option<&str>]) {
    let mut levelled = false;
    for died in landed {
        if let Some(w) = weapon {
            levelled |= life.observe(Observed::Hit { weapon: w });
        }
        if let Some(kind) = died {
            levelled |= life.observe(Observed::Defeat { kind });
        }
    }
    if levelled {
        sync_levels(life, p);
    }
}

/// The kind of creature a death was, as quests name it.
fn kind_of(kind_index: u8) -> Option<&'static str> {
    kind_at(kind_index as usize).map(|k| k.id.as_str())
}

pub struct Players {
    /// Open worlds: the ground, so heights can be measured from it (a flat World is at 0).
    pub ground: Option<&'static Heightfield>,
    /// A copy of a dungeon or a developer zone: its floor, which is the ground where it has one.
    pub floor: Option<&'static DungeonDef>,
    /// Open worlds: refill each player's input budget by this many inputs per tick. 0 (the
    /// balance harness's duels) runs whatever arrives, up to MAX_INPUTS_PER_TICK.
    pub inputs_per_tick: f64,
    slots: Vec<Option<Slot>>,
    by_client: HashMap<u32, usize>,
    tick_ms: f64,
    next_team: u8,
    pub pvp_hits: u64,
    pub saved_by_rewind: u64, // hits that only landed because of lag compensation
    pub heals: u64,
    pub meteors_landed: u64,
    rewind_recent: f64, // recent average rewind (ticks) for player-vs-player hits
    rewind_samples: u64,
    arrows: Vec<Arrow>,
    meteors: Vec<Meteor>,
    events: Vec<Event>,         // things that happened this tick, for effects in browsers
    my_events: Vec<Vec<Event>>, // per slot: damage and healing only that player is told about
    next_effect_id: u16,
}

impl Players {
    pub fn new(tick_ms: f64) -> Self {
        Players {
            ground: None,
            floor: None,
            inputs_per_tick: 0.0,
            slots: (0..MAX_PLAYERS).map(|_| None).collect(),
            by_client: HashMap::new(),
            tick_ms,
            next_team: 1,
            pvp_hits: 0,
            saved_by_rewind: 0,
            heals: 0,
            meteors_landed: 0,
            rewind_recent: 0.0,
            rewind_samples: 0,
            arrows: Vec::new(),
            meteors: Vec::new(),
            events: Vec::new(),
            my_events: (0..MAX_PLAYERS).map(|_| Vec::new()).collect(),
            next_effect_id: 0,
        }
    }

    /// Remembers something that happened *to this player or because of them*, for a floating
    /// number in their browser. Capped per tick so one meteor into a crowd can't flood a snapshot;
    /// the browser pools what does arrive anyway.
    #[allow(clippy::too_many_arguments)]
    fn note(&mut self, slot: usize, kind: u16, cause: u16, x: f64, y: f64, z: f64, amount: f64) {
        if amount < 0.5 {
            return;
        }
        if let Some(list) = self.my_events.get_mut(slot)
            && list.len() < MAX_OWN_EVENTS
        {
            // kind is 4..6, so the bits above the low 4 are free for what caused it.
            list.push(Event { kind: kind | (cause << 4), x, y, z, size: amount.round().clamp(1.0, 255.0) as u8 });
        }
    }

    /// Recent average rewind applied to player-vs-player hits, in milliseconds.
    pub fn rewind_ms(&self) -> f64 {
        if self.rewind_samples == 0 { 0.0 } else { self.rewind_recent * self.tick_ms }
    }

    pub fn position(&self, slot: usize) -> Option<(f64, f64)> {
        self.slots[slot].as_ref().map(|s| (s.player.pos.x, s.player.pos.z))
    }

    /// Read a fighter, for tools that drive the rules headlessly (see bin/balance.rs).
    pub fn player(&self, slot: usize) -> Option<&Player> {
        self.slots.get(slot).and_then(|s| s.as_ref()).map(|s| &s.player)
    }

    /// Stand a fighter somewhere facing a direction, for setting up a measured fight.
    pub fn place(&mut self, slot: usize, x: f64, z: f64, facing: f64) {
        if let Some(Some(s)) = self.slots.get_mut(slot) {
            s.player.pos.x = x;
            s.player.pos.z = z;
            s.player.facing = facing;
        }
    }

    fn next_id(&mut self) -> u16 {
        self.next_effect_id = self.next_effect_id.wrapping_add(1);
        self.next_effect_id
    }

    /// team_request: 1 = team 0, 2 = team 1, anything else = alternate.
    pub fn join(&mut self, client_id: u32, team_request: u8, world: &World) {
        if self.by_client.contains_key(&client_id) {
            return;
        }
        let Some(free) = self.slots.iter().position(|s| s.is_none()) else { return };
        let team = match team_request {
            1 => 0,
            2 => 1,
            _ => {
                self.next_team ^= 1;
                self.next_team
            }
        };
        let player = Player::new(world.team_spawns[team as usize], team, Build::default());
        self.slots[free] = Some(Slot {
            client_id,
            player,
            last_seq: 0,
            build_seq: 0,
            queue: VecDeque::new(),
            history: VecDeque::new(),
            owner: 0,
            life: None,
            commands: VecDeque::new(),
            budget: 0.0,
        });
        self.by_client.insert(client_id, free);
    }

    /// Open worlds: a character arrives, as `player` (already placed), carrying their island.
    /// Returns false if they're already here or there's no room.
    pub fn join_open(&mut self, client_id: u32, owner: i64, player: Player, life: Box<Life>) -> bool {
        if self.by_client.contains_key(&client_id) {
            return false;
        }
        let Some(free) = self.slots.iter().position(|s| s.is_none()) else { return false };
        self.slots[free] = Some(Slot {
            client_id,
            player,
            last_seq: 0,
            build_seq: 0,
            queue: VecDeque::new(),
            history: VecDeque::new(),
            owner,
            life: Some(life),
            commands: VecDeque::new(),
            budget: 0.0,
        });
        self.by_client.insert(client_id, free);
        true
    }

    /// Open worlds: takes a player out (they left), with their island.
    pub fn leave(&mut self, client_id: u32) -> Option<(Player, Option<Box<Life>>)> {
        let s = self.by_client.remove(&client_id)?;
        let slot = self.slots[s].take()?;
        Some((slot.player, slot.life))
    }

    /// Open worlds: inputs as (seq, view tick, actions). The view tick is the (fractional) tick the
    /// player saw everyone else at, so a swing at another player or a bot is checked against where
    /// they were then (`rewound`); `f64::INFINITY` sees the present (bots, tests). Monsters aren't
    /// rewound.
    pub fn queue_actions(&mut self, client_id: u32, inputs: impl Iterator<Item = (u32, f64, Actions)>) {
        let Some(&s) = self.by_client.get(&client_id) else { return };
        if let Some(slot) = &mut self.slots[s] {
            for (seq, view, a) in inputs {
                slot.queue.push_back((seq, view, a));
            }
        }
    }

    /// Open worlds: a new window (or a reconnect) counts its inputs from 1 again.
    pub fn restart_inputs(&mut self, client_id: u32) {
        let Some(&s) = self.by_client.get(&client_id) else { return };
        if let Some(slot) = &mut self.slots[s] {
            slot.last_seq = 0;
            slot.queue.clear();
            slot.commands.clear();
            slot.budget = 0.0;
        }
    }

    /// Open worlds: a command for the island, given on input `seq`.
    pub fn queue_command(&mut self, client_id: u32, seq: u32, c: Command) {
        let Some(&s) = self.by_client.get(&client_id) else { return };
        if let Some(slot) = &mut self.slots[s]
            && slot.commands.len() < 64
        {
            slot.commands.push_back((seq, c));
        }
    }

    /// Open worlds: a player, the last input they've had run, and their island.
    pub fn open_view(&self, client_id: u32) -> Option<(&Player, u32, Option<&Life>)> {
        let &s = self.by_client.get(&client_id)?;
        let slot = self.slots[s].as_ref()?;
        Some((&slot.player, slot.last_seq, slot.life.as_deref()))
    }

    /// Open worlds: a player and their island, to change (a new build, an island started over).
    pub fn open_mut(&mut self, client_id: u32) -> Option<(&mut Player, Option<&mut Life>)> {
        let &s = self.by_client.get(&client_id)?;
        let slot = self.slots[s].as_mut()?;
        Some((&mut slot.player, slot.life.as_deref_mut()))
    }

    /// Open worlds: everyone here, as (client id, character, player, island).
    pub fn each_open(&self) -> impl Iterator<Item = (u32, i64, &Player, Option<&Life>)> {
        self.slots.iter().flatten().map(|s| (s.client_id, s.owner, &s.player, s.life.as_deref()))
    }

    /// Open worlds: everyone's island, to change between steps (who holds which plot).
    pub fn each_life_mut(&mut self) -> impl Iterator<Item = (i64, &mut Life)> {
        self.slots.iter_mut().flatten().filter_map(|s| {
            let owner = s.owner;
            s.life.as_deref_mut().map(|l| (owner, l))
        })
    }

    /// The slot a client plays in (open worlds address its effects by slot).
    pub fn slot_index(&self, client_id: u32) -> Option<usize> {
        self.by_client.get(&client_id).copied()
    }

    /// Height of the ground under a point: a copy's floor where it has one, the open world's
    /// terrain, or 0 on a flat World.
    fn ground_at(&self, x: f64, z: f64) -> f64 {
        ground_under(self.floor, self.ground, x, z)
    }

    /// Tools that drive the rules headlessly (bin/balance.rs): applies the build a player asked
    /// for, if it's new and allowed (within skills.points, learned outward from a root, a weapon
    /// they've trained, abilities they've learned).
    pub fn sync_build(&mut self, client_id: u32, seq: u32, build: Build) {
        let Some(&s) = self.by_client.get(&client_id) else { return };
        let Some(slot) = &mut self.slots[s] else { return };
        if slot.build_seq == seq {
            return;
        }
        slot.build_seq = seq;
        if allowed(&build, tuning().skills.points) {
            slot.player.apply_build(build);
        }
    }

    /// Credits the player in `slot`, if it's still `client` and has an island, with what one of
    /// their arrows or meteors did (see credit()).
    fn credit_owner(&mut self, slot: usize, client: u32, weapon: Option<u8>, landed: &[Option<&str>]) {
        let Some(Some(s)) = self.slots.get_mut(slot) else { return };
        if s.client_id != client {
            return;
        }
        if let Some(life) = s.life.as_deref_mut() {
            credit(life, &mut s.player, weapon, landed);
        }
    }

    /// Inputs as (seq, view tick × 16, raw bytes).
    pub fn queue_inputs(&mut self, client_id: u32, inputs: impl Iterator<Item = (u32, u32, [u8; 8])>) {
        let Some(&s) = self.by_client.get(&client_id) else { return };
        if let Some(slot) = &mut self.slots[s] {
            for (seq, view, raw) in inputs {
                slot.queue.push_back((seq, view as f64 / 16.0, actions_from(raw)));
            }
        }
    }

    /// Runs each player's waiting inputs in order: weapon swings land, arrows fly off, and finished
    /// casts heal or call down meteors. `tick` is the tick being worked out now.
    pub fn step(&mut self, actors: &mut Actors, world: &World, tick: u64) {
        self.step_in(actors, world, tick, None);
    }

    /// The same, in an open world: each player moves over its ground and their island steps along.
    pub fn step_in(&mut self, actors: &mut Actors, world: &World, tick: u64, mut open: Option<&mut OpenWorld>) {
        self.events.clear();
        for list in &mut self.my_events {
            list.clear();
        }
        let mut player_hits: Vec<PlayerHit> = Vec::new();
        let mut heals: Vec<HealHit> = Vec::new();
        for s in 0..self.slots.len() {
            // Take the player out while it moves, so it can't hit itself and the others can be read.
            let Some(mut slot) = self.slots[s].take() else { continue };
            let mut used = 0;
            // In an open world each player runs at most the game's own speed, with a little slack.
            let limit = if self.inputs_per_tick > 0.0 {
                slot.budget = (slot.budget + self.inputs_per_tick).min(self.inputs_per_tick * 4.0);
                (slot.budget.floor() as usize).min(MAX_INPUTS_PER_TICK)
            } else {
                MAX_INPUTS_PER_TICK
            };
            while used < limit {
                let Some((seq, view, a)) = slot.queue.pop_front() else { break };
                if seq <= slot.last_seq {
                    continue; // repeated or out of date
                }
                match open.as_deref_mut() {
                    Some(ow) => {
                        // The island's commands given on or before this input run with it.
                        if let Some(life) = slot.life.as_deref_mut() {
                            while slot.commands.front().is_some_and(|(cs, _)| *cs <= seq) {
                                let (_, c) = slot.commands.pop_front().unwrap();
                                life.command(c);
                            }
                        }
                        crate::open::step_player(&mut slot.player, &a, ow, slot.life.as_deref_mut(), slot.owner);
                    }
                    None => slot.player.step(&a, world),
                }
                slot.last_seq = seq;
                if self.inputs_per_tick > 0.0 {
                    slot.budget -= 1.0;
                }
                used += 1;
                if let Some(swing) = slot.player.active_swing() {
                    if swing.projectile_speed > 0.0 {
                        self.fire_arrow(s, slot.client_id, &slot.player, &swing);
                        slot.player.attack_hit = true;
                    } else {
                        let latest = tick.saturating_sub(1) as f64;
                        let view = view.clamp(latest - MAX_REWIND_TICKS, latest);
                        let p = &slot.player;
                        let max_targets = melee_targets(p.weapon, &p.resolved);
                        let (px, pz, facing, weapon) = (p.pos.x, p.pos.z, p.facing, p.weapon);
                        // Each hit this swing lands, in order, with what it finished off.
                        let mut landed: Vec<Option<&'static str>> = Vec::new();
                        let fighters = self.swing(s, p, view, latest, &swing, max_targets, &mut player_hits);
                        landed.resize(fighters, None);
                        // Monsters are in the arc too, and a swing that only catches one still
                        // counts as a hit. On hills nothing is
                        // in reach from more than 2 m up, and only feet within 2 m of yours.
                        let feet = open.as_deref().map(|ow| {
                            let hf = ow.terrain();
                            let p = &slot.player;
                            let under = hf.water.max(crate::open::colliders::ground_at(hf, &ow.index, p.pos.x, p.pos.z, p.pos.y, 0.0));
                            (p.pos.y - under, p.pos.y)
                        });
                        if feet.is_none_or(|(above, _)| above <= 2.0) {
                            self.swing_actors(actors, s, px, pz, facing, &swing, max_targets, weapon, feet.map(|f| f.1), &mut landed);
                        }
                        // One swing lands once, as checkHit's attackHit has it.
                        if !landed.is_empty() {
                            slot.player.attack_hit = true;
                        }
                        if let Some(life) = slot.life.as_deref_mut() {
                            credit(life, &mut slot.player, Some(weapon), &landed);
                        }
                    }
                }
                // A finished cast runs each of its ability's effects. Adding an ability built
                // from these is a data change; only a new effect kind reaches this match.
                if slot.player.fired_ability != NO_ABILITY {
                    let a = slot.player.fired_ability;
                    for i in 0..ability(a).effects.len() {
                        match ability(a).effects[i].kind.as_str() {
                            "healArea" => self.heal_area(s, a, i, &mut slot.player, &mut heals),
                            "delayedArea" => self.delayed_area(s, slot.client_id, a, i, &slot.player),
                            other => debug_assert!(false, "unknown effect kind: {other}"),
                        }
                    }
                }
            }
            if slot.queue.len() > 120 {
                let extra = slot.queue.len() - 120;
                slot.queue.drain(..extra);
            }
            self.slots[s] = Some(slot);
        }
        for h in player_hits {
            let landed = match &mut self.slots[h.victim] {
                Some(v) => {
                    v.player.take_hit(h.damage, h.dx, h.dz, h.knock);
                    self.pvp_hits += 1;
                    Some((v.player.pos.x, v.player.pos.y, v.player.pos.z))
                }
                None => None,
            };
            if let Some((x, y, z)) = landed {
                self.note(h.attacker, EVENT_YOU_HIT, h.cause, x, y + MARKER_HEIGHT, z, h.damage);
                self.note(h.victim, EVENT_YOU_HURT, h.cause, x, y + MARKER_HEIGHT, z, h.damage);
            }
        }
        let max_hp = tuning().combat.max_hp;
        for HealHit { healer, target, amount, cause } in heals {
            let healed = match &mut self.slots[target] {
                Some(t) if t.player.down_frame < 0 => {
                    let before = t.player.hp;
                    t.player.hp = (t.player.hp + amount).min(max_hp);
                    Some((t.player.pos.x, t.player.pos.y, t.player.pos.z, t.player.hp - before))
                }
                _ => None,
            };
            // Only what the heal actually restored: topping up someone at full health shows nothing.
            if let Some((x, y, z, gained)) = healed {
                self.note(healer, EVENT_YOU_HEAL, cause, x, y + MARKER_HEIGHT, z, gained);
                if healer != target {
                    self.note(target, EVENT_YOU_HEAL, cause, x, y + MARKER_HEIGHT, z, gained);
                }
            }
        }
    }

    /// Everything a swing catches among the actors, on top of whatever players it hit.
    /// Each one hit goes on `landed`, with its kind if the hit finished it off.
    #[allow(clippy::too_many_arguments)]
    fn swing_actors(
        &mut self,
        actors: &mut Actors,
        slot: usize,
        x: f64,
        z: f64,
        facing: f64,
        step: &AttackStep,
        max: usize,
        weapon: u8,
        feet: Option<f64>,
        landed: &mut Vec<Option<&'static str>>,
    ) {
        let (floor, terrain) = (self.floor, self.ground);
        let hits = match (self.ground, feet) {
            (Some(_), Some(y)) => {
                actors.cone_hits_where(x, z, facing, step.reach, step.arc_deg, max, |a| (a.y + ground_under(floor, terrain, a.x, a.z) - y).abs() <= 2.0)
            }
            _ => actors.cone_hits(x, z, facing, step.reach, step.arc_deg, max),
        };
        for id in hits {
            let (ax, az) = match actors.get_mut(id) {
                Some(a) => (a.x, a.z),
                None => continue,
            };
            let (dx, dz) = (ax - x, az - z);
            let d = (dx * dx + dz * dz).sqrt().max(0.0001);
            let ground = self.ground_at(ax, az);
            if let Some(died) = actors.damage(id, step.damage, dx / d, dz / d, step.player_knock) {
                self.note(slot, EVENT_YOU_HIT, weapon_cause(weapon), died.x, died.y + ground, died.z, step.damage);
                landed.push(kind_of(died.kind_index));
            } else if let Some(a) = actors.get_mut(id) {
                let (hx, hy, hz) = (a.x, a.y + a.hit_height + ground, a.z);
                self.note(slot, EVENT_YOU_HIT, weapon_cause(weapon), hx, hy, hz, step.damage);
                landed.push(None);
            }
        }
    }

    /// Melee: finds enemies in front of a swinging player, each checked where the attacker saw
    /// them (tick `view`). Returns how many it hit.
    #[allow(clippy::too_many_arguments)]
    fn swing(&mut self, attacker: usize, a: &Player, view: f64, latest: f64, step: &AttackStep, max_targets: usize, player_hits: &mut Vec<PlayerHit>) -> usize {
        // High in the air, a swing reaches nobody: two metres above the ground under you (a flat
        // World's floor is 0; the open world's is its terrain).
        let floor = self.ground_at(a.pos.x, a.pos.z);
        if a.pos.y - floor > 2.0 {
            return 0;
        }
        let reach = step.reach + BODY_RADIUS;
        let half_arc = step.arc_deg.to_radians() / 2.0;
        // Direction to the target if it's within reach and in front, else None.
        let check = |tx: f64, ty: f64, tz: f64| -> Option<(f64, f64)> {
            let (dx, dz) = (tx - a.pos.x, tz - a.pos.z);
            let dist = (dx * dx + dz * dz).sqrt();
            let in_front = angle_diff(a.facing, dx.atan2(dz)).abs() <= half_arc || dist < BODY_RADIUS + 0.3;
            if dist > reach || (ty - a.pos.y).abs() > 2.0 || !in_front {
                return None;
            }
            Some(if dist > 1e-6 { (dx / dist, dz / dist) } else { (a.facing.sin(), a.facing.cos()) })
        };

        let mut hits = 0;
        let mut saved = 0u64;
        let mut rewinds: Vec<f64> = Vec::new();
        for (i, other) in self.slots.iter().enumerate() {
            if hits >= max_targets {
                break;
            }
            let Some(o) = other else { continue };
            if o.player.team == a.team || o.player.down_frame >= 0 {
                continue;
            }
            let (x, y, z) = rewound(o, view);
            let Some((nx, nz)) = check(x, y, z) else { continue };
            player_hits.push(PlayerHit { attacker, victim: i, damage: step.damage, dx: nx, dz: nz, knock: step.player_knock, cause: weapon_cause(a.weapon) });
            hits += 1;
            rewinds.push(latest - view);
            if check(o.player.pos.x, o.player.pos.y, o.player.pos.z).is_none() {
                saved += 1; // without rewinding, this would have missed
            }
        }
        self.saved_by_rewind += saved;
        for r in rewinds {
            self.rewind_recent = if self.rewind_samples == 0 { r } else { self.rewind_recent * 0.8 + r * 0.2 };
            self.rewind_samples += 1;
        }
        hits
    }

    fn fire_arrow(&mut self, owner_slot: usize, owner_client: u32, shooter: &Player, shot: &AttackStep) {
        let (dx, dz) = (shooter.facing.sin(), shooter.facing.cos());
        let pierce = pierce_targets(shooter.weapon, &shooter.resolved);
        let id = self.next_id();
        self.arrows.push(Arrow {
            id,
            owner: owner_slot as u16,
            owner_slot,
            owner_client,
            weapon: shooter.weapon,
            cause: weapon_cause(shooter.weapon),
            team: shooter.team,
            x: shooter.pos.x + dx * 0.6,
            y: shooter.pos.y + ARROW_HEIGHT,
            z: shooter.pos.z + dz * 0.6,
            dx,
            dz,
            speed: shot.projectile_speed,
            left: shot.projectile_range,
            damage: shot.damage,
            knock: shot.player_knock,
            pierce_left: pierce,
            hit: Vec::new(),
        });
    }

    // Healing Circle: heals the caster and every ally within the radius.
    /// healArea: restores health to the caster and every ally standing inside the circle.
    fn heal_area(&mut self, caster: usize, a: u8, fx: usize, healer: &mut Player, heals: &mut Vec<HealHit>) {
        let e = &ability(a).effects[fx];
        let radius = effect_radius(a, e, &healer.resolved);
        let amount = effect_amount(a, e, &healer.resolved);
        if healer.down_frame < 0 {
            let before = healer.hp;
            healer.hp = (healer.hp + amount).min(tuning().combat.max_hp);
            let gained = healer.hp - before;
            let (hx, hy, hz) = (healer.pos.x, healer.pos.y, healer.pos.z);
            self.note(caster, EVENT_YOU_HEAL, ability_cause(a), hx, hy + MARKER_HEIGHT, hz, gained);
        }
        for (i, other) in self.slots.iter().enumerate() {
            let Some(o) = other else { continue };
            let (dx, dz) = (o.player.pos.x - healer.pos.x, o.player.pos.z - healer.pos.z);
            if o.player.team == healer.team && dx * dx + dz * dz <= radius * radius {
                heals.push(HealHit { healer: caster, target: i, amount, cause: ability_cause(a) });
            }
        }
        self.events.push(Event { kind: EVENT_HEAL, x: healer.pos.x, y: healer.pos.y, z: healer.pos.z, size: (radius * 10.0) as u8 });
        self.heals += 1;
    }

    /// delayedArea: something starts falling on the target spot and blasts it after a delay.
    fn delayed_area(&mut self, caster_slot: usize, caster_client: u32, a: u8, fx: usize, caster: &Player) {
        let e = &ability(a).effects[fx];
        let fall_ticks = ((e.delay_frames as f64 / 60.0 * 1000.0 / self.tick_ms).round() as u32).max(1);
        let id = self.next_id();
        self.meteors.push(Meteor {
            id,
            owner_slot: caster_slot,
            owner_client: caster_client,
            cause: ability_cause(a),
            team: caster.team,
            x: caster.cast_target_x,
            z: caster.cast_target_z,
            ticks_left: fall_ticks,
            fall_ticks,
            radius: effect_radius(a, e, &caster.resolved),
            damage: effect_damage(a, e, &caster.resolved),
            knock: e.knock,
        });
    }

    /// Moves arrows and lands meteors. Runs once per tick, after everyone has moved.
    pub fn step_effects(&mut self, actors: &mut Actors) {
        let dt = self.tick_ms / 1000.0;
        let mut flying = Vec::with_capacity(self.arrows.len());
        for mut a in std::mem::take(&mut self.arrows) {
            if self.advance_arrow(&mut a, actors, dt) {
                flying.push(a);
            }
        }
        self.arrows = flying;

        let mut falling = Vec::with_capacity(self.meteors.len());
        for mut m in std::mem::take(&mut self.meteors) {
            m.ticks_left = m.ticks_left.saturating_sub(1);
            if m.ticks_left > 0 {
                falling.push(m);
            } else {
                self.explode(&m, actors);
            }
        }
        self.meteors = falling;
    }

    // Moves one arrow for one tick in short hops, hitting the first enemies in its path.
    // Returns false once it has run out of range or targets to pierce.
    fn advance_arrow(&mut self, a: &mut Arrow, actors: &mut Actors, dt: f64) -> bool {
        let travel = (a.speed * dt).min(a.left);
        let hops = ((travel / 0.5).ceil() as usize).max(1);
        let hop = travel / hops as f64;
        for _ in 0..hops {
            a.x += a.dx * hop;
            a.z += a.dz * hop;
            a.left -= hop;
            let ground = self.ground_at(a.x, a.z);
            if let Some(id) = actors.point_hit(a.x, a.y - ground, a.z, ARROW_RADIUS) {
                let key = 1u32 << 30 | id;
                if !a.hit.contains(&key) {
                    let hit = actors.get_mut(id).map(|t| (t.x, t.y + t.hit_height + ground, t.z));
                    let died = actors.damage(id, a.damage, a.dx, a.dz, a.knock);
                    a.hit.push(key);
                    if let Some((hx, hy, hz)) = hit {
                        self.events.push(Event { kind: EVENT_ARROW_HIT, x: a.x, y: a.y, z: a.z, size: a.damage as u8 });
                        self.note(a.owner_slot, EVENT_YOU_HIT, a.cause, hx, hy, hz, a.damage);
                        // A hit with the bow that loosed it, and maybe a creature finished off.
                        let died = died.and_then(|d| kind_of(d.kind_index));
                        self.credit_owner(a.owner_slot, a.owner_client, Some(a.weapon), &[died]);
                    }
                    a.pierce_left -= 1;
                    if a.pierce_left == 0 {
                        return false;
                    }
                }
            }
            for i in 0..self.slots.len() {
                let struck = {
                    let Some(slot) = &mut self.slots[i] else { continue };
                    let p = &mut slot.player;
                    let key = 1u32 << 31 | i as u32;
                    if p.team == a.team || p.down_frame >= 0 || a.hit.contains(&key) {
                        continue;
                    }
                    let (dx, dz) = (p.pos.x - a.x, p.pos.z - a.z);
                    if dx * dx + dz * dz > ARROW_RADIUS * ARROW_RADIUS || a.y < p.pos.y - 0.2 || a.y > p.pos.y + 2.0 {
                        continue;
                    }
                    p.take_hit(a.damage, a.dx, a.dz, a.knock);
                    a.hit.push(key);
                    (p.pos.x, p.pos.y, p.pos.z)
                };
                self.pvp_hits += 1;
                self.events.push(Event { kind: EVENT_ARROW_HIT, x: a.x, y: a.y, z: a.z, size: a.damage as u8 });
                self.note(a.owner_slot, EVENT_YOU_HIT, a.cause, struck.0, struck.1 + MARKER_HEIGHT, struck.2, a.damage);
                self.note(i, EVENT_YOU_HURT, a.cause, struck.0, struck.1 + MARKER_HEIGHT, struck.2, a.damage);
                self.credit_owner(a.owner_slot, a.owner_client, Some(a.weapon), &[None]);
                a.pierce_left -= 1;
                if a.pierce_left == 0 {
                    return false;
                }
            }
        }
        a.left > 0.0
    }

    // A meteor lands: everyone on the other team inside the blast is hurt and thrown outward.
    fn explode(&mut self, m: &Meteor, actors: &mut Actors) {
        let mut caught: Vec<(usize, f64, f64, f64)> = Vec::new();
        for (i, slot) in self.slots.iter_mut().enumerate() {
            let Some(slot) = slot else { continue };
            let p = &mut slot.player;
            if p.team == m.team || p.down_frame >= 0 {
                continue;
            }
            let (dx, dz) = (p.pos.x - m.x, p.pos.z - m.z);
            let d = (dx * dx + dz * dz).sqrt();
            if d > m.radius {
                continue;
            }
            let (nx, nz) = if d > 1e-3 { (dx / d, dz / d) } else { (p.facing.sin(), p.facing.cos()) };
            p.take_hit(m.damage, nx, nz, m.knock);
            self.pvp_hits += 1;
            caught.push((i, p.pos.x, p.pos.y, p.pos.z));
        }
        for (i, x, y, z) in caught {
            self.note(m.owner_slot, EVENT_YOU_HIT, m.cause, x, y + MARKER_HEIGHT, z, m.damage);
            self.note(i, EVENT_YOU_HURT, m.cause, x, y + MARKER_HEIGHT, z, m.damage);
        }
        for id in actors.circle_hits(m.x, m.z, m.radius) {
            let Some(a) = actors.get_mut(id) else { continue };
            let (dx, dz) = (a.x - m.x, a.z - m.z);
            let d = (dx * dx + dz * dz).sqrt().max(1e-3);
            let (ax, az) = (a.x, a.z);
            let ay = a.y + a.hit_height + self.ground_at(ax, az);
            let died = actors.damage(id, m.damage, dx / d, dz / d, m.knock);
            self.note(m.owner_slot, EVENT_YOU_HIT, m.cause, ax, ay, az, m.damage);
            // A blast trains nothing (the cast did), but what it finishes off counts.
            if let Some(kind) = died.and_then(|d| kind_of(d.kind_index)) {
                self.credit_owner(m.owner_slot, m.owner_client, None, &[Some(kind)]);
            }
        }
        let ground = self.ground_at(m.x, m.z);
        self.events.push(Event { kind: EVENT_EXPLOSION, x: m.x, y: ground, z: m.z, size: (m.radius * 10.0) as u8 });
        self.meteors_landed += 1;
    }

    /// Monsters' slams: everyone standing in one when it lands is hit, with the same dodge and
    /// guard rules as any other blow.
    pub fn apply_slams(&mut self, slams: &[Slam]) {
        let body = tuning().movement.player_radius;
        let (floor, terrain) = (self.floor, self.ground);
        for s in slams {
            let mut struck: Vec<(usize, f64, f64, f64, f64)> = Vec::new();
            for (i, slot) in self.slots.iter_mut().enumerate() {
                let Some(slot) = slot else { continue };
                let p = &mut slot.player;
                let ground = ground_under(floor, terrain, p.pos.x, p.pos.z);
                if p.down_frame >= 0 || p.pos.y - ground > SLAM_LIFT {
                    continue;
                }
                let (dx, dz) = (p.pos.x - s.x, p.pos.z - s.z);
                let d = (dx * dx + dz * dz).sqrt();
                if d > s.radius + body {
                    continue;
                }
                let (nx, nz) = if d > 0.01 { (dx / d, dz / d) } else { (p.facing.sin(), p.facing.cos()) };
                let before = p.hp;
                p.take_hit(s.damage, nx, nz, s.knock);
                if p.hp < before {
                    struck.push((i, p.pos.x, p.pos.y, p.pos.z, before - p.hp));
                }
            }
            for (i, x, y, z, taken) in struck {
                self.note(i, EVENT_YOU_HURT, CAUSE_MONSTER, x, y + MARKER_HEIGHT, z, taken);
            }
        }
    }

    /// Creatures' blows and missiles that reached a player: the same dodge and guard rules as any
    /// other blow. A foe id is a slot index plus one.
    pub fn apply_foe_hits(&mut self, hits: &[FoeHit]) {
        for h in hits {
            let Some(i) = (h.foe as usize).checked_sub(1) else { continue };
            let Some(Some(slot)) = self.slots.get_mut(i) else { continue };
            let p = &mut slot.player;
            let before = p.hp;
            p.take_hit(h.damage, h.nx, h.nz, h.knock);
            if p.hp < before {
                let (x, y, z, taken) = (p.pos.x, p.pos.y, p.pos.z, before - p.hp);
                self.note(i, EVENT_YOU_HURT, CAUSE_MONSTER, x, y + MARKER_HEIGHT, z, taken);
            }
        }
    }

    /// Everyone still standing, as the creatures see them: foe
    /// ids are slot indexes plus one.
    pub fn foes(&self) -> Vec<Foe> {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.as_ref().map(|s| (i, s)))
            .filter(|(_, s)| s.player.hp > 0.0 && s.player.down_frame < 0)
            .map(|(i, s)| s.player.foe(i as u32 + 1, self.ground_at(s.player.pos.x, s.player.pos.z)))
            .collect()
    }

    pub fn record_history(&mut self, tick: u64) {
        for slot in self.slots.iter_mut().flatten() {
            let p = &slot.player.pos;
            slot.history.push_back((tick, p.x, p.y, p.z));
            if slot.history.len() > HISTORY {
                slot.history.pop_front();
            }
        }
    }

    /// Open worlds: the arrows in flight, meteors falling and effects near (vx, vz), plus the
    /// effects addressed to the player in `viewer`, as JSON in the shapes the browser reads
    /// (ArrowRecord, MeteorRecord and EffectEvent in src/net/worldFeed.ts).
    pub fn effects_json(&self, viewer: Option<usize>, vx: f64, vz: f64) -> (serde_json::Value, serde_json::Value, serde_json::Value) {
        use serde_json::json;
        let near = |x: f64, z: f64| (x - vx) * (x - vx) + (z - vz) * (z - vz) <= EFFECT_RADIUS * EFFECT_RADIUS;
        let r2 = |v: f64| (v * 100.0).round() / 100.0;
        let arrows: Vec<_> = self
            .arrows
            .iter()
            .filter(|a| near(a.x, a.z))
            .take(64)
            .map(|a| json!({ "id": a.id, "owner": a.owner, "x": r2(a.x), "y": r2(a.y), "z": r2(a.z), "vx": r2(a.dx * a.speed), "vz": r2(a.dz * a.speed), "team": a.team }))
            .collect();
        let meteors: Vec<_> = self
            .meteors
            .iter()
            .filter(|m| near(m.x, m.z))
            .take(16)
            .map(|m| json!({ "id": m.id, "x": r2(m.x), "z": r2(m.z), "ticksLeft": m.ticks_left, "fallTicks": m.fall_ticks, "team": m.team, "radius": r2(m.radius) }))
            .collect();
        let event = |e: &Event| json!({ "kind": e.kind, "x": r2(e.x), "y": r2(e.y), "z": r2(e.z), "size": e.size });
        let mut events: Vec<_> = self.events.iter().filter(|e| near(e.x, e.z)).take(48).map(event).collect();
        if let Some(list) = viewer.and_then(|s| self.my_events.get(s)) {
            events.extend(list.iter().map(event));
        }
        (serde_json::Value::Array(arrows), serde_json::Value::Array(meteors), serde_json::Value::Array(events))
    }
}
