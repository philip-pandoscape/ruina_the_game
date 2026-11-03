//! Real players on the server: joining and leaving, their builds (skills and loadout), running
//! their inputs in order, and everything that hurts or heals: weapon swings, arrows, meteors and
//! Healing Circles, plus bots hitting players.
//!
//! Lag compensation: each input says which server tick the player was looking at. When a melee
//! swing is checked, other players are rewound to where that player saw them, so a hit on your
//! screen is a hit on the server.

use std::collections::{HashMap, VecDeque};

use crate::player::{angle_diff, Actions, Build, Player};
use crate::protocol::{
    aim_axis, cm16, input_axis, put_player, put_you, ARROW_ENTRY, EVENT_ARROW_HIT, EVENT_ENTRY, EVENT_EXPLOSION, EVENT_HEAL,
    METEOR_ENTRY, PLAYER_ENTRY, YOU_ENTRY,
};
use crate::sim::{Battle, BotHit, BotTarget};
use crate::tuning::{perks, tuning, valid_build, Ability, AttackStep, CAST_HEAL, CAST_METEOR};
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

pub fn actions_from(raw: [u8; 5]) -> Actions {
    let b = raw[2];
    Actions {
        move_x: input_axis(raw[0] as i8),
        move_z: input_axis(raw[1] as i8),
        jump_pressed: b & 1 != 0,
        jump_held: b & 2 != 0,
        attack_pressed: b & 4 != 0,
        slide_pressed: b & 8 != 0,
        ability1_pressed: b & 16 != 0,
        ability2_pressed: b & 32 != 0,
        aim_x: aim_axis(raw[3] as i8),
        aim_z: aim_axis(raw[4] as i8),
    }
}

fn ability_of_kind(kind: &str) -> &'static Ability {
    tuning().abilities.iter().find(|a| a.kind == kind).expect("ability exists")
}

struct Slot {
    client_id: u32,
    player: Player,
    last_seq: u32,
    build_seq: u32,
    queue: VecDeque<(u32, f64, Actions)>,     // (seq, view tick, input)
    history: VecDeque<(u64, f64, f64, f64)>, // (tick, x, y, z) at the end of each tick
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
    owner: u16, // player id of the shooter
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
    team: u8,
    x: f64,
    z: f64,
    ticks_left: u32,
    fall_ticks: u32,
    radius: f64,
    damage: f64,
    knock: f64,
}

struct Event {
    kind: u8,
    x: f64,
    y: f64,
    z: f64,
    size: u8,
}

pub struct Players {
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
    next_effect_id: u16,
    // Packed once per tick and shared by every snapshot.
    packed: Vec<(usize, f64, f64, [u8; PLAYER_ENTRY])>,
    you: Vec<Option<[u8; YOU_ENTRY]>>,
    packed_arrows: Vec<(f64, f64, [u8; ARROW_ENTRY])>,
    packed_meteors: Vec<(f64, f64, [u8; METEOR_ENTRY])>,
    packed_events: Vec<(f64, f64, [u8; EVENT_ENTRY])>,
    nearby_bots: Vec<usize>,
}

impl Players {
    pub fn new(entity_base: usize, tick_ms: f64) -> Self {
        let max = MAX_PLAYERS.min(65_535 - entity_base);
        Players {
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
            next_effect_id: 0,
            packed: Vec::new(),
            you: (0..max).map(|_| None).collect(),
            packed_arrows: Vec::new(),
            packed_meteors: Vec::new(),
            packed_events: Vec::new(),
            nearby_bots: Vec::new(),
        }
    }

    pub fn count(&self) -> usize {
        self.by_client.len()
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
        self.slots[free] = Some(Slot { client_id, player, last_seq: 0, build_seq: 0, queue: VecDeque::new(), history: VecDeque::new() });
        self.by_client.insert(client_id, free);
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
        if valid_build(build.perks, build.weapon, build.ability1, build.ability2) {
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
    pub fn queue_inputs(&mut self, client_id: u32, inputs: impl Iterator<Item = (u32, u32, [u8; 5])>) {
        let Some(&s) = self.by_client.get(&client_id) else { return };
        if let Some(slot) = &mut self.slots[s] {
            for (seq, view, raw) in inputs {
                slot.queue.push_back((seq, view as f64 / 16.0, actions_from(raw)));
            }
        }
    }

    /// Runs each player's waiting inputs in order: weapon swings land, arrows fly off, and finished
    /// casts heal or call down meteors. `tick` is the tick being worked out now.
    pub fn step(&mut self, battle: &mut Battle, world: &World, tick: u64) {
        self.events.clear();
        let mut player_hits: Vec<(usize, f64, f64, f64, f64)> = Vec::new();
        let mut heals: Vec<(usize, f64)> = Vec::new();
        for s in 0..self.slots.len() {
            // Take the player out while it moves, so it can't hit itself and the others can be read.
            let Some(mut slot) = self.slots[s].take() else { continue };
            let mut used = 0;
            while used < MAX_INPUTS_PER_TICK {
                let Some((seq, view, a)) = slot.queue.pop_front() else { break };
                if seq <= slot.last_seq {
                    continue; // repeated or out of date
                }
                slot.player.step(&a, world);
                slot.last_seq = seq;
                used += 1;
                if let Some(swing) = slot.player.active_swing() {
                    if swing.projectile_speed > 0.0 {
                        self.fire_arrow(&slot.player, swing, (self.entity_base + s) as u16);
                        slot.player.attack_hit = true;
                    } else {
                        let latest = tick.saturating_sub(1) as f64;
                        let view = view.clamp(latest - MAX_REWIND_TICKS, latest);
                        let p = &slot.player;
                        let max_targets = if p.weapon == 0 && p.perks & perks().cleave != 0 { tuning().skills.cleave_targets } else { 1 };
                        if self.swing(p, view, latest, swing, max_targets, battle, &mut player_hits) {
                            slot.player.attack_hit = true;
                        }
                    }
                }
                match slot.player.fired_cast {
                    CAST_HEAL => self.cast_heal(&mut slot.player, battle, &mut heals),
                    CAST_METEOR => self.cast_meteor(&slot.player),
                    _ => {}
                }
            }
            if slot.queue.len() > 120 {
                let extra = slot.queue.len() - 120;
                slot.queue.drain(..extra);
            }
            self.slots[s] = Some(slot);
        }
        for (victim, damage, dx, dz, knock) in player_hits {
            if let Some(v) = &mut self.slots[victim] {
                v.player.take_hit(damage, dx, dz, knock);
                self.pvp_hits += 1;
            }
        }
        let max_hp = tuning().combat.max_hp;
        for (target, amount) in heals {
            if let Some(t) = &mut self.slots[target] {
                if t.player.down_frame < 0 {
                    t.player.hp = (t.player.hp + amount).min(max_hp);
                }
            }
        }
    }

    /// Melee: finds enemies in front of a swinging player. Other players are checked where the
    /// attacker saw them (tick `view`); bots where they are now. Returns true if anything was hit.
    #[allow(clippy::too_many_arguments)]
    fn swing(
        &mut self,
        a: &Player,
        view: f64,
        latest: f64,
        step: &AttackStep,
        max_targets: usize,
        battle: &mut Battle,
        player_hits: &mut Vec<(usize, f64, f64, f64, f64)>,
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
            player_hits.push((i, step.damage, nx, nz, step.player_knock));
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
        }
        hits > 0
    }

    fn fire_arrow(&mut self, shooter: &Player, shot: &AttackStep, owner: u16) {
        let (dx, dz) = (shooter.facing.sin(), shooter.facing.cos());
        let pierce = if shooter.perks & perks().piercing != 0 { tuning().skills.pierce_targets } else { 1 };
        let id = self.next_id();
        self.arrows.push(Arrow {
            id,
            owner,
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
    fn cast_heal(&mut self, healer: &mut Player, battle: &mut Battle, heals: &mut Vec<(usize, f64)>) {
        let ab = ability_of_kind("heal");
        if healer.down_frame < 0 {
            healer.hp = (healer.hp + ab.amount).min(tuning().combat.max_hp);
        }
        for (i, other) in self.slots.iter().enumerate() {
            let Some(o) = other else { continue };
            let (dx, dz) = (o.player.pos.x - healer.pos.x, o.player.pos.z - healer.pos.z);
            if o.player.team == healer.team && dx * dx + dz * dz <= ab.radius * ab.radius {
                heals.push((i, ab.amount));
            }
        }
        battle.heal_bots(healer.pos.x as f32, healer.pos.z as f32, ab.radius as f32, healer.team, ab.amount as f32);
        self.events.push(Event { kind: EVENT_HEAL, x: healer.pos.x, y: healer.pos.y, z: healer.pos.z, size: (ab.radius * 10.0) as u8 });
        self.heals += 1;
    }

    // Meteor: the cast is done, so a fireball starts falling on the target spot.
    fn cast_meteor(&mut self, caster: &Player) {
        let ab = ability_of_kind("meteor");
        let fall_ticks = ((ab.fall_frames as f64 / 60.0 * 1000.0 / self.tick_ms).round() as u32).max(1);
        let id = self.next_id();
        self.meteors.push(Meteor {
            id,
            team: caster.team,
            x: caster.cast_target_x,
            z: caster.cast_target_z,
            ticks_left: fall_ticks,
            fall_ticks,
            radius: ab.radius,
            damage: ab.damage,
            knock: ab.knock,
        });
    }

    /// Moves arrows and lands meteors. Runs once per tick, after everyone has moved.
    pub fn step_effects(&mut self, battle: &mut Battle) {
        let dt = self.tick_ms / 1000.0;
        let mut flying = Vec::with_capacity(self.arrows.len());
        for mut a in std::mem::take(&mut self.arrows) {
            if self.advance_arrow(&mut a, battle, dt) {
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
                self.explode(&m, battle);
            }
        }
        self.meteors = falling;
    }

    // Moves one arrow for one tick in short hops, hitting the first enemies in its path.
    // Returns false once it has run out of range or targets to pierce.
    fn advance_arrow(&mut self, a: &mut Arrow, battle: &mut Battle, dt: f64) -> bool {
        let travel = (a.speed * dt).min(a.left);
        let hops = ((travel / 0.5).ceil() as usize).max(1);
        let hop = travel / hops as f64;
        for _ in 0..hops {
            a.x += a.dx * hop;
            a.z += a.dz * hop;
            a.left -= hop;
            for i in 0..self.slots.len() {
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
                self.pvp_hits += 1;
                self.events.push(Event { kind: EVENT_ARROW_HIT, x: a.x, y: a.y, z: a.z, size: a.damage as u8 });
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
                a.pierce_left -= 1;
                if a.pierce_left == 0 {
                    return false;
                }
            }
        }
        a.left > 0.0
    }

    // A meteor lands: everyone on the other team inside the blast is hurt and thrown outward.
    fn explode(&mut self, m: &Meteor, battle: &mut Battle) {
        for slot in self.slots.iter_mut().flatten() {
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
        }
        battle.bots_near(m.x as f32, m.z as f32, m.radius as f32, &mut self.nearby_bots);
        for k in 0..self.nearby_bots.len() {
            let b = self.nearby_bots[k];
            if battle.team[b] != m.team {
                battle.damage_bot(b, m.damage as f32);
                self.hits_on_bots += 1;
            }
        }
        self.events.push(Event { kind: EVENT_EXPLOSION, x: m.x, y: 0.0, z: m.z, size: (m.radius * 10.0) as u8 });
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
            if let Some(Some(slot)) = self.slots.get_mut(h.slot as usize) {
                slot.player.take_hit(h.damage as f64, h.dir_x as f64, h.dir_z as f64, BOT_KNOCK);
                self.bot_hits_on_players += 1;
            }
        }
    }

    /// Remembers where everyone stood at the end of `tick`, for rewinding later swings.
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
        write_near(out, &self.packed_events, vx, vz, 48);
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
