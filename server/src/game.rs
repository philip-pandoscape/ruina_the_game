//! Real players on the server: joining and leaving, their builds (skills and loadout), running
//! their inputs in order, and everything that hurts or heals: weapon swings, arrows, meteors and
//! Healing Circles, plus bots hitting players.
//!
//! Lag compensation: each input says which server tick the player was looking at. When a melee
//! swing is checked, other players are rewound to where that player saw them, so a hit on your
//! screen is a hit on the server.

use std::collections::{HashMap, VecDeque};

use crate::actors::{Actors, Slam};
use crate::life::{Command, Life};
use crate::open::zone::Heightfield;
use crate::open::OpenWorld;
use crate::player::{angle_diff, Actions, Build, Player};
use crate::protocol::{
    aim_axis, cm16, input_axis, put_player, put_you, ARROW_ENTRY, EVENT_ARROW_HIT, EVENT_ENTRY, EVENT_EXPLOSION, EVENT_HEAL,
    CAUSE_BOT, CAUSE_HEAL, CAUSE_METEOR, CAUSE_MONSTER, CAUSE_WEAPON, EVENT_YOU_HEAL, EVENT_YOU_HIT, EVENT_YOU_HURT,
    METEOR_ENTRY, PLAYER_ENTRY, YOU_ENTRY, put_actor, ACTOR_ENTRY};
use crate::sim::{Battle, BotHit, BotTarget};
use crate::skills::valid_build;
use crate::tuning::{
    ability, effect_amount, effect_damage, effect_radius, melee_targets, pierce_targets, tuning, AttackStep, HOTBAR_SLOTS,
    NO_ABILITY,
};
use crate::world::World;

pub const MAX_PLAYERS: usize = 4096;
// A little more than one tick's worth of 60 Hz inputs: catches up after a hiccup, but a client
// can't speed itself up by sending extra inputs.
const MAX_INPUTS_PER_TICK: usize = 12;
const BODY_RADIUS: f64 = 0.45;
const VIEW_RADIUS: f64 = 60.0; // other players within this distance get detailed updates
const VIEW_CAP: usize = 32;
const EFFECT_RADIUS: f64 = 90.0; // arrows, meteors and effects within this distance are sent
const HISTORY: usize = 40; // ticks of position history kept per player (2 s at 20 Hz)
const MAX_REWIND_TICKS: f64 = 16.0; // never rewind more than 0.8 s, however laggy the attacker
const BOT_KNOCK: f64 = 2.5;
const ARROW_HEIGHT: f64 = 1.3; // arrows fly at chest height
const ARROW_RADIUS: f64 = 0.55; // how close an arrow has to pass to hit someone
const MARKER_HEIGHT: f64 = 1.1; // floating numbers sit about head height above whoever they're about
const MAX_OWN_EVENTS: usize = 24; // attributed events per player per tick; the rest are dropped
const SLAM_LIFT: f64 = 1.0; // a monster's slam only catches someone on the ground, not mid-jump

pub fn actions_from(raw: [u8; 7]) -> Actions {
    let b = raw[2];
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
        movement_slot: if raw[5] > HOTBAR_SLOTS as u8 { raw[5] - HOTBAR_SLOTS as u8 } else { 0 },
        movement_held: raw[6],
        aim_x: aim_axis(raw[3] as i8),
        aim_z: aim_axis(raw[4] as i8),
        stick_x: 0.0,
        stick_y: 0.0,
    }
}

/// Open worlds: the 9 bytes a browser packs per input: the battlefield's 7, plus the raw stick
/// (vehicles steer with it).
pub fn open_actions_from(raw: [u8; 9]) -> Actions {
    let mut a = actions_from([raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6]]);
    a.stick_x = input_axis(raw[7] as i8);
    a.stick_y = input_axis(raw[8] as i8);
    a
}

struct Slot {
    client_id: u32,
    player: Player,
    last_seq: u32,
    build_seq: u32,
    queue: VecDeque<(u32, f64, Actions)>,     // (seq, view tick, input)
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
    owner: u16,       // player id of the shooter
    owner_slot: usize, // and their slot, for "you hit X" events
    cause: u8,         // which weapon fired it, for the icon on the damage number
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
    hit: Vec<u32>,      // who it already hit: bot index, or 1 << 31 | player slot
}

struct Meteor {
    id: u16,
    owner_slot: usize, // who called it down, for "you hit X" events
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
    cause: u8,
}

// One player a Healing Circle reached.
struct HealHit {
    healer: usize,
    target: usize,
    amount: f64,
}

struct Event {
    kind: u8,
    x: f64,
    y: f64,
    z: f64,
    size: u8,
}

pub struct Players {
    /// Open worlds: the ground, so heights can be measured from it (the battlefield is flat at 0).
    pub ground: Option<&'static Heightfield>,
    /// Open worlds: refill each player's input budget by this many inputs per tick. 0 (the
    /// battlefield) runs whatever arrives, up to MAX_INPUTS_PER_TICK.
    pub inputs_per_tick: f64,
    slots: Vec<Option<Slot>>,
    by_client: HashMap<u32, usize>,
    entity_base: usize, // player ids come after the bots'
    tick_ms: f64,
    next_team: u8,
    pub pvp_hits: u64,
    pub hits_on_bots: u64,
    pub bot_hits_on_players: u64,
    pub saved_by_rewind: u64, // hits that only landed because of lag compensation
    pub heals: u64,
    pub meteors_landed: u64,
    pub arrows_fired: u64,
    rewind_recent: f64, // recent average rewind (ticks) for player-vs-player hits
    rewind_samples: u64,
    arrows: Vec<Arrow>,
    meteors: Vec<Meteor>,
    events: Vec<Event>, // things that happened this tick, for effects in browsers
    my_events: Vec<Vec<Event>>, // per slot: damage and healing only that player is told about
    next_effect_id: u16,
    // Packed once per tick and shared by every snapshot.
    packed: Vec<(usize, f64, f64, [u8; PLAYER_ENTRY])>,
    you: Vec<Option<[u8; YOU_ENTRY]>>,
    packed_arrows: Vec<(f64, f64, [u8; ARROW_ENTRY])>,
    packed_actors: Vec<(f64, f64, [u8; ACTOR_ENTRY])>,
    packed_meteors: Vec<(f64, f64, [u8; METEOR_ENTRY])>,
    packed_events: Vec<(f64, f64, [u8; EVENT_ENTRY])>,
    packed_my_events: Vec<Vec<[u8; EVENT_ENTRY]>>,
    nearby_bots: Vec<usize>,
}

impl Players {
    pub fn new(entity_base: usize, tick_ms: f64) -> Self {
        let max = MAX_PLAYERS.min(65_535 - entity_base);
        Players {
            ground: None,
            inputs_per_tick: 0.0,
            slots: (0..max).map(|_| None).collect(),
            by_client: HashMap::new(),
            entity_base,
            tick_ms,
            next_team: 1,
            pvp_hits: 0,
            hits_on_bots: 0,
            bot_hits_on_players: 0,
            saved_by_rewind: 0,
            heals: 0,
            meteors_landed: 0,
            arrows_fired: 0,
            rewind_recent: 0.0,
            rewind_samples: 0,
            arrows: Vec::new(),
            meteors: Vec::new(),
            events: Vec::new(),
            my_events: (0..max).map(|_| Vec::new()).collect(),
            next_effect_id: 0,
            packed: Vec::new(),
            you: (0..max).map(|_| None).collect(),
            packed_arrows: Vec::new(),
            packed_actors: Vec::new(),
            packed_meteors: Vec::new(),
            packed_events: Vec::new(),
            packed_my_events: (0..max).map(|_| Vec::new()).collect(),
            nearby_bots: Vec::new(),
        }
    }

    pub fn count(&self) -> usize {
        self.by_client.len()
    }

    /// Remembers something that happened *to this player or because of them*, for a floating
    /// number in their browser. Capped per tick so one meteor into a crowd can't flood a snapshot;
    /// the browser pools what does arrive anyway.
    fn note(&mut self, slot: usize, kind: u8, cause: u8, x: f64, y: f64, z: f64, amount: f64) {
        if amount < 0.5 {
            return;
        }
        if let Some(list) = self.my_events.get_mut(slot) {
            if list.len() < MAX_OWN_EVENTS {
                // kind is 4..6, so the top nibble is free for what caused it.
                list.push(Event { kind: kind | (cause << 4), x, y, z, size: amount.round().clamp(1.0, 255.0) as u8 });
            }
        }
    }

    /// Recent average rewind applied to player-vs-player hits, in milliseconds.
    pub fn rewind_ms(&self) -> f64 {
        if self.rewind_samples == 0 {
            0.0
        } else {
            self.rewind_recent * self.tick_ms
        }
    }

    pub fn slot_of(&self, client_id: u32) -> Option<usize> {
        self.by_client.get(&client_id).copied()
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

    /// Open worlds: inputs as (seq, actions). There's no view tick: monsters aren't rewound.
    pub fn queue_actions(&mut self, client_id: u32, inputs: impl Iterator<Item = (u32, Actions)>) {
        let Some(&s) = self.by_client.get(&client_id) else { return };
        if let Some(slot) = &mut self.slots[s] {
            for (seq, a) in inputs {
                slot.queue.push_back((seq, 0.0, a));
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
        if let Some(slot) = &mut self.slots[s] {
            if slot.commands.len() < 64 {
                slot.commands.push_back((seq, c));
            }
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

    /// Height of the ground under a point: the open world's terrain, or 0 on the battlefield.
    fn ground_at(&self, x: f64, z: f64) -> f64 {
        self.ground.map_or(0.0, |g| g.height(x, z))
    }

    /// Applies the build a player asked for, if it's new and allowed (enough skill points, skills
    /// learned in order, a weapon they've trained, abilities they've learned).
    pub fn sync_build(&mut self, client_id: u32, seq: u32, build: Build) {
        let Some(&s) = self.by_client.get(&client_id) else { return };
        let Some(slot) = &mut self.slots[s] else { return };
        if slot.build_seq == seq {
            return;
        }
        slot.build_seq = seq;
        if valid_build(&build.skills, build.weapon, &build.abilities) {
            slot.player.apply_build(build);
        }
    }

    /// Removes players whose connection has closed.
    pub fn retain(&mut self, connected: impl Fn(u32) -> bool) {
        for s in self.slots.iter_mut() {
            if let Some(slot) = s {
                if !connected(slot.client_id) {
                    self.by_client.remove(&slot.client_id);
                    *s = None;
                }
            }
        }
    }

    /// Inputs as (seq, view tick × 16, raw bytes).
    pub fn queue_inputs(&mut self, client_id: u32, inputs: impl Iterator<Item = (u32, u32, [u8; 7])>) {
        let Some(&s) = self.by_client.get(&client_id) else { return };
        if let Some(slot) = &mut self.slots[s] {
            for (seq, view, raw) in inputs {
                slot.queue.push_back((seq, view as f64 / 16.0, actions_from(raw)));
            }
        }
    }

    /// Runs each player's waiting inputs in order: weapon swings land, arrows fly off, and finished
    /// casts heal or call down meteors. `tick` is the tick being worked out now.
    pub fn step(&mut self, battle: &mut Battle, actors: &mut Actors, world: &World, tick: u64) {
        self.step_in(battle, actors, world, tick, None);
    }

    /// The same, in an open world: each player moves over its ground and their island steps along.
    pub fn step_in(&mut self, battle: &mut Battle, actors: &mut Actors, world: &World, tick: u64, mut open: Option<&mut OpenWorld>) {
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
                        self.fire_arrow(s, &slot.player, &swing, (self.entity_base + s) as u16);
                        slot.player.attack_hit = true;
                    } else {
                        let latest = tick.saturating_sub(1) as f64;
                        let view = view.clamp(latest - MAX_REWIND_TICKS, latest);
                        let p = &slot.player;
                        let max_targets = melee_targets(p.weapon, &p.resolved);
                        let (px, pz, facing, weapon) = (p.pos.x, p.pos.z, p.facing, p.weapon);
                        if self.swing(s, p, view, latest, &swing, max_targets, battle, &mut player_hits) {
                            slot.player.attack_hit = true;
                        }
                        // Monsters are in the arc too, and a swing that only catches one still
                        // counts as a hit. On hills (src/sim/player/attacks.ts checkHit) nothing is
                        // in reach from more than 2 m up, and only feet within 2 m of yours.
                        let feet = open.as_deref().map(|ow| {
                            let hf = ow.terrain();
                            let p = &slot.player;
                            let under = hf.water.max(crate::open::colliders::ground_at(hf, &ow.index, p.pos.x, p.pos.z, p.pos.y, 0.0));
                            (p.pos.y - under, p.pos.y)
                        });
                        if feet.is_none_or(|(above, _)| above <= 2.0) {
                            let before = self.events.len();
                            self.swing_actors(actors, s, px, pz, facing, &swing, max_targets, weapon, feet.map(|f| f.1));
                            if self.events.len() > before {
                                slot.player.attack_hit = true;
                            }
                        }
                    }
                }
                // A finished cast runs each of its ability's effects. Adding an ability built
                // from these is a data change; only a new effect kind reaches this match.
                if slot.player.fired_ability != NO_ABILITY {
                    let a = slot.player.fired_ability;
                    for i in 0..ability(a).effects.len() {
                        match ability(a).effects[i].kind.as_str() {
                            "healArea" => self.heal_area(s, a, i, &mut slot.player, battle, &mut heals),
                            "delayedArea" => self.delayed_area(s, a, i, &slot.player),
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
        for HealHit { healer, target, amount } in heals {
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
                self.note(healer, EVENT_YOU_HEAL, CAUSE_HEAL, x, y + MARKER_HEIGHT, z, gained);
                if healer != target {
                    self.note(target, EVENT_YOU_HEAL, CAUSE_HEAL, x, y + MARKER_HEIGHT, z, gained);
                }
            }
        }
    }

    /// Melee: finds enemies in front of a swinging player. Other players are checked where the
    /// attacker saw them (tick `view`); bots where they are now. Returns true if anything was hit.
    #[allow(clippy::too_many_arguments)]
    /// Everything a swing catches among the actors, on top of whatever bots and players it hit.
    #[allow(clippy::too_many_arguments)]
    fn swing_actors(&mut self, actors: &mut Actors, slot: usize, x: f64, z: f64, facing: f64, step: &AttackStep, max: usize, weapon: u8, feet: Option<f64>) {
        let hits = match (self.ground, feet) {
            (Some(g), Some(y)) => actors.cone_hits_where(x, z, facing, step.reach, step.arc_deg, max, |a| (a.y + g.height(a.x, a.z) - y).abs() <= 2.0),
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
                self.note(slot, EVENT_YOU_HIT, CAUSE_WEAPON + weapon, died.x, died.y + ground, died.z, step.damage);
            } else if let Some(a) = actors.get_mut(id) {
                let (hx, hy, hz) = (a.x, a.y + a.hit_height + ground, a.z);
                self.note(slot, EVENT_YOU_HIT, CAUSE_WEAPON + weapon, hx, hy, hz, step.damage);
            }
        }
    }

    fn swing(
        &mut self,
        attacker: usize,
        a: &Player,
        view: f64,
        latest: f64,
        step: &AttackStep,
        max_targets: usize,
        battle: &mut Battle,
        player_hits: &mut Vec<PlayerHit>,
    ) -> bool {
        if a.pos.y > 2.0 {
            return false;
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
            player_hits.push(PlayerHit {
                attacker,
                victim: i,
                damage: step.damage,
                dx: nx,
                dz: nz,
                knock: step.player_knock,
                cause: CAUSE_WEAPON + a.weapon,
            });
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

        battle.bots_near(a.pos.x as f32, a.pos.z as f32, reach as f32, &mut self.nearby_bots);
        for k in 0..self.nearby_bots.len() {
            if hits >= max_targets {
                break;
            }
            let b = self.nearby_bots[k];
            if battle.team[b] == a.team || check(battle.x[b] as f64, 0.0, battle.z[b] as f64).is_none() {
                continue;
            }
            battle.damage_bot(b, step.damage as f32);
            self.hits_on_bots += 1;
            hits += 1;
            let (bx, bz) = (battle.x[b] as f64, battle.z[b] as f64);
            self.note(attacker, EVENT_YOU_HIT, CAUSE_WEAPON + a.weapon, bx, MARKER_HEIGHT, bz, step.damage);
        }
        hits > 0
    }

    fn fire_arrow(&mut self, owner_slot: usize, shooter: &Player, shot: &AttackStep, owner: u16) {
        let (dx, dz) = (shooter.facing.sin(), shooter.facing.cos());
        let pierce = pierce_targets(shooter.weapon, &shooter.resolved);
        let id = self.next_id();
        self.arrows.push(Arrow {
            id,
            owner,
            owner_slot,
            cause: CAUSE_WEAPON + shooter.weapon,
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
        self.arrows_fired += 1;
    }

    // Healing Circle: heals the caster and every ally (players and bots) within the radius.
    /// healArea: restores health to the caster and every ally standing inside the circle.
    fn heal_area(&mut self, caster: usize, a: u8, fx: usize, healer: &mut Player, battle: &mut Battle, heals: &mut Vec<HealHit>) {
        let e = &ability(a).effects[fx];
        let radius = effect_radius(a, e, &healer.resolved);
        let amount = effect_amount(a, e, &healer.resolved);
        if healer.down_frame < 0 {
            let before = healer.hp;
            healer.hp = (healer.hp + amount).min(tuning().combat.max_hp);
            let gained = healer.hp - before;
            let (hx, hy, hz) = (healer.pos.x, healer.pos.y, healer.pos.z);
            self.note(caster, EVENT_YOU_HEAL, CAUSE_HEAL, hx, hy + MARKER_HEIGHT, hz, gained);
        }
        for (i, other) in self.slots.iter().enumerate() {
            let Some(o) = other else { continue };
            let (dx, dz) = (o.player.pos.x - healer.pos.x, o.player.pos.z - healer.pos.z);
            if o.player.team == healer.team && dx * dx + dz * dz <= radius * radius {
                heals.push(HealHit { healer: caster, target: i, amount });
            }
        }
        battle.heal_bots(healer.pos.x as f32, healer.pos.z as f32, radius as f32, healer.team, amount as f32);
        self.events.push(Event { kind: EVENT_HEAL, x: healer.pos.x, y: healer.pos.y, z: healer.pos.z, size: (radius * 10.0) as u8 });
        self.heals += 1;
    }

    /// delayedArea: something starts falling on the target spot and blasts it after a delay.
    fn delayed_area(&mut self, caster_slot: usize, a: u8, fx: usize, caster: &Player) {
        let e = &ability(a).effects[fx];
        let fall_ticks = ((e.delay_frames as f64 / 60.0 * 1000.0 / self.tick_ms).round() as u32).max(1);
        let id = self.next_id();
        self.meteors.push(Meteor {
            id,
            owner_slot: caster_slot,
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
    pub fn step_effects(&mut self, battle: &mut Battle, actors: &mut Actors) {
        let dt = self.tick_ms / 1000.0;
        let mut flying = Vec::with_capacity(self.arrows.len());
        for mut a in std::mem::take(&mut self.arrows) {
            if self.advance_arrow(&mut a, battle, actors, dt) {
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
                self.explode(&m, battle, actors);
            }
        }
        self.meteors = falling;
    }

    // Moves one arrow for one tick in short hops, hitting the first enemies in its path.
    // Returns false once it has run out of range or targets to pierce.
    fn advance_arrow(&mut self, a: &mut Arrow, battle: &mut Battle, actors: &mut Actors, dt: f64) -> bool {
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
                    actors.damage(id, a.damage, a.dx, a.dz, a.knock);
                    a.hit.push(key);
                    if let Some((hx, hy, hz)) = hit {
                        self.events.push(Event { kind: EVENT_ARROW_HIT, x: a.x, y: a.y, z: a.z, size: a.damage as u8 });
                        self.note(a.owner_slot, EVENT_YOU_HIT, a.cause, hx, hy, hz, a.damage);
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
                a.pierce_left -= 1;
                if a.pierce_left == 0 {
                    return false;
                }
            }
            battle.bots_near(a.x as f32, a.z as f32, ARROW_RADIUS as f32, &mut self.nearby_bots);
            for k in 0..self.nearby_bots.len() {
                let b = self.nearby_bots[k];
                if battle.team[b] == a.team || a.hit.contains(&(b as u32)) {
                    continue;
                }
                battle.damage_bot(b, a.damage as f32);
                a.hit.push(b as u32);
                self.hits_on_bots += 1;
                self.events.push(Event { kind: EVENT_ARROW_HIT, x: a.x, y: a.y, z: a.z, size: a.damage as u8 });
                let (bx, bz) = (battle.x[b] as f64, battle.z[b] as f64);
                self.note(a.owner_slot, EVENT_YOU_HIT, a.cause, bx, MARKER_HEIGHT, bz, a.damage);
                a.pierce_left -= 1;
                if a.pierce_left == 0 {
                    return false;
                }
            }
        }
        a.left > 0.0
    }

    // A meteor lands: everyone on the other team inside the blast is hurt and thrown outward.
    fn explode(&mut self, m: &Meteor, battle: &mut Battle, actors: &mut Actors) {
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
            self.note(m.owner_slot, EVENT_YOU_HIT, CAUSE_METEOR, x, y + MARKER_HEIGHT, z, m.damage);
            self.note(i, EVENT_YOU_HURT, CAUSE_METEOR, x, y + MARKER_HEIGHT, z, m.damage);
        }
        battle.bots_near(m.x as f32, m.z as f32, m.radius as f32, &mut self.nearby_bots);
        for k in 0..self.nearby_bots.len() {
            let b = self.nearby_bots[k];
            if battle.team[b] != m.team {
                battle.damage_bot(b, m.damage as f32);
                self.hits_on_bots += 1;
                let (bx, bz) = (battle.x[b] as f64, battle.z[b] as f64);
                self.note(m.owner_slot, EVENT_YOU_HIT, CAUSE_METEOR, bx, MARKER_HEIGHT, bz, m.damage);
            }
        }
        for id in actors.circle_hits(m.x, m.z, m.radius) {
            let Some(a) = actors.get_mut(id) else { continue };
            let (dx, dz) = (a.x - m.x, a.z - m.z);
            let d = (dx * dx + dz * dz).sqrt().max(1e-3);
            let (ax, az) = (a.x, a.z);
            let ay = a.y + a.hit_height + self.ground.map_or(0.0, |g| g.height(ax, az));
            actors.damage(id, m.damage, dx / d, dz / d, m.knock);
            self.note(m.owner_slot, EVENT_YOU_HIT, CAUSE_METEOR, ax, ay, az, m.damage);
        }
        let ground = self.ground_at(m.x, m.z);
        self.events.push(Event { kind: EVENT_EXPLOSION, x: m.x, y: ground, z: m.z, size: (m.radius * 10.0) as u8 });
        self.meteors_landed += 1;
    }

    /// Players the bots can fight this tick (anyone not knocked down).
    pub fn bot_targets(&self) -> Vec<BotTarget> {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(s, slot)| {
                let p = &slot.as_ref()?.player;
                (p.down_frame < 0).then(|| BotTarget { slot: s as u32, x: p.pos.x as f32, z: p.pos.z as f32, team: p.team })
            })
            .collect()
    }

    pub fn apply_bot_hits(&mut self, hits: &[BotHit]) {
        for h in hits {
            let struck = match self.slots.get_mut(h.slot as usize) {
                Some(Some(slot)) => {
                    slot.player.take_hit(h.damage as f64, h.dir_x as f64, h.dir_z as f64, BOT_KNOCK);
                    self.bot_hits_on_players += 1;
                    Some((slot.player.pos.x, slot.player.pos.y, slot.player.pos.z))
                }
                _ => None,
            };
            if let Some((x, y, z)) = struck {
                self.note(h.slot as usize, EVENT_YOU_HURT, CAUSE_BOT, x, y + MARKER_HEIGHT, z, h.damage as f64);
            }
        }
    }

    /// Monsters' slams: everyone standing in one when it lands is hit, with the same dodge and
    /// guard rules as any other blow. Mirrors updateActors() in src/sim/actors/step.ts.
    pub fn apply_slams(&mut self, slams: &[Slam]) {
        let body = tuning().movement.player_radius;
        for s in slams {
            let mut struck: Vec<(usize, f64, f64, f64, f64)> = Vec::new();
            for (i, slot) in self.slots.iter_mut().enumerate() {
                let Some(slot) = slot else { continue };
                let p = &mut slot.player;
                let ground = self.ground.map_or(0.0, |g| g.height(p.pos.x, p.pos.z));
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

    /// Where everyone still standing is, for the monsters to notice.
    pub fn live_positions(&self) -> Vec<(f64, f64)> {
        self.slots
            .iter()
            .filter_map(|s| s.as_ref())
            .filter(|s| s.player.hp > 0.0)
            .map(|s| (s.player.pos.x, s.player.pos.z))
            .collect()
    }

    /// Freezes the actors into wire entries once a tick, shared by every client's snapshot.
    pub fn pack_actors(&mut self, actors: &Actors) {
        self.packed_actors.clear();
        for a in actors.list.iter() {
            let mut e = [0u8; ACTOR_ENTRY];
            let progress = if a.wait > 0 { a.state_frame as f64 / a.wait as f64 } else { 0.0 };
            put_actor(
                &mut e,
                a.id,
                a.kind_index,
                a.x,
                a.z,
                a.y,
                a.facing,
                a.state as u8,
                progress.clamp(0.0, 1.0),
                if a.max_hp > 0.0 { a.hp / a.max_hp } else { 0.0 },
                // Taken out of the world (absorbed): sent as long dead, which a browser doesn't draw.
                if a.gone { 254 } else { a.dead_frame },
                a.target_x - a.x,
                a.target_z - a.z,
            );
            self.packed_actors.push((a.x, a.z, e));
        }
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

    /// Packs every player, arrow, meteor and event once per tick, for the snapshots built in
    /// parallel afterwards.
    pub fn pack(&mut self) {
        self.packed.clear();
        let mut buf = Vec::with_capacity(YOU_ENTRY);
        for (s, slot) in self.slots.iter().enumerate() {
            let Some(slot) = slot else {
                self.you[s] = None;
                continue;
            };
            let id = (self.entity_base + s) as u16;
            buf.clear();
            put_player(&mut buf, id, &slot.player);
            let mut entry = [0u8; PLAYER_ENTRY];
            entry.copy_from_slice(&buf);
            self.packed.push((s, slot.player.pos.x, slot.player.pos.z, entry));
            buf.clear();
            put_you(&mut buf, id, slot.last_seq, &slot.player);
            let mut you = [0u8; YOU_ENTRY];
            you.copy_from_slice(&buf);
            self.you[s] = Some(you);
        }

        self.packed_arrows.clear();
        for a in &self.arrows {
            let mut e = [0u8; ARROW_ENTRY];
            e[0..2].copy_from_slice(&a.id.to_le_bytes());
            e[2..4].copy_from_slice(&a.owner.to_le_bytes());
            e[4..6].copy_from_slice(&cm16(a.x));
            e[6..8].copy_from_slice(&cm16(a.y));
            e[8..10].copy_from_slice(&cm16(a.z));
            e[10..12].copy_from_slice(&cm16(a.dx * a.speed));
            e[12..14].copy_from_slice(&cm16(a.dz * a.speed));
            e[14] = a.team;
            self.packed_arrows.push((a.x, a.z, e));
        }
        self.packed_meteors.clear();
        for m in &self.meteors {
            let mut e = [0u8; METEOR_ENTRY];
            e[0..2].copy_from_slice(&m.id.to_le_bytes());
            e[2..4].copy_from_slice(&cm16(m.x));
            e[4..6].copy_from_slice(&cm16(m.z));
            e[6] = m.ticks_left.min(255) as u8;
            e[7] = m.fall_ticks.min(255) as u8;
            e[8] = m.team;
            e[9] = (m.radius * 10.0).round().clamp(0.0, 255.0) as u8;
            self.packed_meteors.push((m.x, m.z, e));
        }
        self.packed_events.clear();
        for ev in &self.events {
            let mut e = [0u8; EVENT_ENTRY];
            e[0] = ev.kind;
            e[1..3].copy_from_slice(&cm16(ev.x));
            e[3..5].copy_from_slice(&cm16(ev.y));
            e[5..7].copy_from_slice(&cm16(ev.z));
            e[7] = ev.size;
            self.packed_events.push((ev.x, ev.z, e));
        }
        for (s, list) in self.my_events.iter().enumerate() {
            let packed = &mut self.packed_my_events[s];
            packed.clear();
            for ev in list {
                let mut e = [0u8; EVENT_ENTRY];
                e[0] = ev.kind;
                e[1..3].copy_from_slice(&cm16(ev.x));
                e[3..5].copy_from_slice(&cm16(ev.y));
                e[5..7].copy_from_slice(&cm16(ev.z));
                e[7] = ev.size;
                packed.push(e);
            }
        }
    }

    /// Open worlds: the arrows in flight, meteors falling and effects near (vx, vz), plus the
    /// effects addressed to the player in `viewer`, as JSON in the shapes src/net/netCrowd.ts reads
    /// (ArrowRecord, MeteorRecord, EffectEvent).
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

    /// Appends the nearby-players section, your own exact state (if you're playing), and the
    /// arrows, meteors and effects near you.
    pub fn write_sections(&self, out: &mut Vec<u8>, viewer: Option<usize>, vx: f64, vz: f64, scratch: &mut Vec<(f64, usize)>) {
        scratch.clear();
        for (k, (s, x, z, _)) in self.packed.iter().enumerate() {
            if Some(*s) == viewer {
                continue;
            }
            let (dx, dz) = (x - vx, z - vz);
            let d2 = dx * dx + dz * dz;
            if d2 <= VIEW_RADIUS * VIEW_RADIUS {
                scratch.push((d2, k));
            }
        }
        if scratch.len() > VIEW_CAP {
            scratch.select_nth_unstable_by(VIEW_CAP, |a, b| a.0.total_cmp(&b.0));
            scratch.truncate(VIEW_CAP);
        }
        out.push(scratch.len() as u8);
        for &(_, k) in scratch.iter() {
            out.extend_from_slice(&self.packed[k].3);
        }
        match viewer.and_then(|s| self.you[s].as_ref()) {
            Some(you) => {
                out.push(1);
                out.extend_from_slice(you);
            }
            None => out.push(0),
        }
        write_near(out, &self.packed_arrows, vx, vz, 64);
        write_near(out, &self.packed_meteors, vx, vz, 16);
        let mine: &[[u8; EVENT_ENTRY]] = match viewer {
            Some(s) => &self.packed_my_events[s],
            None => &[],
        };
        write_events(out, &self.packed_events, mine, vx, vz, 48);
        write_actors(out, &self.packed_actors, vx, vz, 48);
    }
}

// The effects section: nearby effects everyone sees, then the ones addressed to this player.
// Their positions are already known to be relevant, so they skip the distance test.
fn write_events(out: &mut Vec<u8>, list: &[(f64, f64, [u8; EVENT_ENTRY])], mine: &[[u8; EVENT_ENTRY]], vx: f64, vz: f64, cap: usize) {
    let near = |&&(x, z, _): &&(f64, f64, [u8; EVENT_ENTRY])| (x - vx) * (x - vx) + (z - vz) * (z - vz) <= EFFECT_RADIUS * EFFECT_RADIUS;
    let shared = list.iter().filter(near).take(cap).count();
    let own = mine.len().min(cap - shared);
    out.push((shared + own) as u8);
    for (_, _, e) in list.iter().filter(near).take(shared) {
        out.extend_from_slice(e);
    }
    for e in mine.iter().take(own) {
        out.extend_from_slice(e);
    }
}

// Monsters and props near enough to be worth drawing. Nearest first, so a cap trims the ones
// furthest away rather than whichever happened to spawn last.
fn write_actors(out: &mut Vec<u8>, list: &[(f64, f64, [u8; ACTOR_ENTRY])], vx: f64, vz: f64, cap: usize) {
    let mut near: Vec<(f64, usize)> = list
        .iter()
        .enumerate()
        .filter_map(|(i, (x, z, _))| {
            let d2 = (x - vx) * (x - vx) + (z - vz) * (z - vz);
            (d2 <= VIEW_RADIUS * VIEW_RADIUS).then_some((d2, i))
        })
        .collect();
    near.sort_by(|a, b| a.0.total_cmp(&b.0));
    near.truncate(cap);
    out.push(near.len() as u8);
    for &(_, i) in near.iter() {
        out.extend_from_slice(&list[i].2);
    }
}

// Writes a count and then up to `cap` packed entries within EFFECT_RADIUS of (vx, vz).
fn write_near<const N: usize>(out: &mut Vec<u8>, list: &[(f64, f64, [u8; N])], vx: f64, vz: f64, cap: usize) {
    let near = |&&(x, z, _): &&(f64, f64, [u8; N])| (x - vx) * (x - vx) + (z - vz) * (z - vz) <= EFFECT_RADIUS * EFFECT_RADIUS;
    let count = list.iter().filter(near).take(cap).count();
    out.push(count as u8);
    for (_, _, e) in list.iter().filter(near).take(cap) {
        out.extend_from_slice(e);
    }
}
