//! Bots in a channel or a dungeon's copy: players without a socket, their inputs decided each tick
//! by their brains (crates/engine/src/bots.rs), stepped with everyone else's by the same rules and
//! shown to everyone as peers marked as bots. An admin's developer panel adds and removes them
//! (Command::Bots); the battlefield's developer zone will bring its own.

use std::collections::BTreeMap;

use rayon::prelude::*;

use ruina_world_api::gate::ToConn;

use super::stepping::Stepping;
use super::{Game, TICK_HZ};
use crate::bots::{Bot, Brain, FoeSeen};
use crate::ids::EntityId;
use crate::jsmath::JsMath;
use crate::life::Life;
use crate::open::colliders::ground_at;
use crate::player::{Actions, Build, Player};
use crate::world::Spawn;

/// A bot playing here.
pub struct BotSlot {
    /// Who it is among the players (crate::ids).
    pub entity: EntityId,
    pub name: String,
    brain: Bot,
    /// Its last input's number: bots number their inputs as browsers do.
    seq: u32,
}

/// Bots' numbers as the rest of the rules know them (whose colliders, whose vehicles): below every
/// character's (they start at 1), counting down from here. The wire names a bot so too (the gate).
pub const FIRST_BOT: i64 = -1_000_000;
/// The most bots one channel holds, so a slip of the panel can't fill it.
pub const MAX_BOTS: usize = 64;

impl Game {
    /// Up to `n` bots with `brain` in a ring round (x, z), on `team`. How many joined: the channel
    /// may be full, or at its bots' limit.
    pub fn spawn_bots(&mut self, n: u32, brain: Brain, x: f64, z: f64, team: u8) -> u32 {
        self.spawn_bots_up_to(n, brain, x, z, team, MAX_BOTS)
    }

    /// The same, up to `cap` bots in all (the tick-time bench goes past the panel's limit).
    fn spawn_bots_up_to(&mut self, n: u32, brain: Brain, x: f64, z: f64, team: u8, cap: usize) -> u32 {
        let hf = self.open.terrain();
        let mut joined = 0;
        for k in 0..n {
            if self.bots.len() >= cap {
                break;
            }
            self.bot_count += 1;
            let id = FIRST_BOT - i64::from(self.bot_count);
            let angle = f64::from(k) / f64::from(n.max(1)) * std::f64::consts::TAU;
            let r = 3.0 + f64::from(k % 3);
            let (bx, bz) = (x + angle.js_sin() * r, z + angle.js_cos() * r);
            if !hf.inside(bx, bz, 0.0) {
                continue;
            }
            let floor = self.arrival().map(|a| a.y);
            let mut player = Player::new(Spawn { x: bx, z: bz, facing: angle + std::f64::consts::PI }, 0, Build::default());
            player.team = team;
            player.pos.y = ground_at(hf, &self.open.index, bx, bz, floor.unwrap_or_else(|| hf.height(bx, bz)) + 1.2, 1.2);
            player.grounded = true;
            // An island of its own, empty: the rules step every open-world player with one.
            let life = Box::new(Life::new(self.zone, None, None));
            let entity = EntityId::bot(self.sim.0, self.bot_count);
            if !self.players.join_open(entity, id, player, life) {
                break;
            }
            let name = format!("{} {}", if brain == Brain::Wanderer { "Wanderer" } else { "Skirmisher" }, self.bot_count);
            self.bots.push(BotSlot { entity, name, brain: Bot::new(brain, 0x5eed_0000 ^ self.bot_count, (x, z)), seq: 0 });
            joined += 1;
        }
        joined
    }

    /// A developer zone's bots, as its file lists them, if they aren't here already: they come in
    /// with the first player into it while it's empty (put) and go with its last (take).
    pub(super) fn zone_bots_in(&mut self) {
        let Some(c) = self.copy_of() else { return };
        let def = c.def;
        if !self.bots.is_empty() || def.bots.is_empty() {
            return;
        }
        for b in &def.bots {
            let brain = Brain::named(&b.brain).unwrap_or(Brain::Skirmisher);
            self.spawn_bots(b.count, brain, b.x, b.z, b.team);
        }
    }

    /// Every bot here gone.
    pub fn remove_bots(&mut self) {
        for b in std::mem::take(&mut self.bots) {
            self.players.leave(b.entity);
            self.say_all(&ToConn::Left { id: b.entity }, None);
        }
    }

    /// Each bot looks at who it can fight (anyone on another side, players and bots alike) and
    /// queues this tick's inputs: one a step, as a browser sends them. Each sees everyone as the
    /// tick begins and decides for itself alone, so they all think at once when the channel steps
    /// its players at once (`stepping`); their inputs go in after, in the order of the bots.
    pub(super) fn drive_bots(&mut self) {
        if self.bots.is_empty() {
            return;
        }
        // Whom each side fights: everyone on the other sides, in the order of their slots.
        let everyone: Vec<(u8, FoeSeen)> =
            self.players.each_open().map(|(_, _, p, _)| (p.team, FoeSeen { x: p.pos.x, z: p.pos.z, hp: if p.down_frame >= 0 { 0.0 } else { p.hp } })).collect();
        let mut foes: BTreeMap<u8, Vec<FoeSeen>> = BTreeMap::new();
        for &(team, _) in &everyone {
            foes.entry(team).or_insert_with(|| everyone.iter().filter(|(t, _)| *t != team).map(|(_, f)| *f).collect());
        }
        let players = &self.players;
        let think = |b: &mut BotSlot| {
            let (me, _, _) = players.open_view(b.entity)?;
            Some(b.brain.think(me, foes.get(&me.team).map_or(&[], Vec::as_slice)))
        };
        let decided: Vec<Option<Actions>> = match self.stepping {
            Stepping::Parallel => self.bots.par_iter_mut().map(think).collect(),
            _ => self.bots.iter_mut().map(think).collect(),
        };
        let steps = 60 / TICK_HZ;
        for (b, a) in self.bots.iter_mut().zip(decided) {
            let Some(a) = a else { continue };
            let first = b.seq + 1;
            b.seq += steps;
            // A press counts once: on the first of the tick's steps.
            let held = Actions { attack_pressed: false, jump_pressed: false, slide_pressed: false, ability_slot: 0, movement_slot: 0, ..a };
            // A bot sees everyone where they are: nothing to rewind.
            self.players.queue_actions(b.entity, (0..steps).map(|k| (first + k, f64::INFINITY, if k == 0 { a } else { held })));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open::zone::emberholm;
    use crate::rng::Rng;
    use ruina_world_api::records::PlayerState;
    use ruina_world_api::{Owner, SimId};
    use serde_json::{Value, json};

    /// An effect as the browser sees it, for the hash.
    fn effect(e: &crate::combat::Effect) -> Value {
        json!({ "kind": e.kind, "x": e.x, "y": e.y, "z": e.z, "size": e.size })
    }

    /// The battlefield's copy, as the directory would start it.
    fn battlefield() -> Game {
        let def = crate::open::dungeon::dungeon("battlefield").expect("the battlefield");
        Game::copy(SimId(1), def, 1, Owner::Everyone)
    }

    /// A player's state as the browser reads it, as text (what the hashes fold).
    fn state_text(p: &Player) -> String {
        serde_json::to_value(PlayerState::of(p)).expect("a state").to_string()
    }

    #[test]
    fn bots_join_play_and_leave() {
        let mut ch = Game::test();
        let s = &emberholm().recipe.spawn;
        assert_eq!(ch.spawn_bots(4, Brain::Wanderer, s.x, s.z, 0), 4);
        assert_eq!(ch.bots.len(), 4);
        let start: Vec<(f64, f64)> = ch.bots.iter().map(|b| ch.players.open_view(b.entity).map(|(p, _, _)| (p.pos.x, p.pos.z)).unwrap()).collect();
        // A tick at a time as step() runs them, with a tick's worth of inputs whatever the clock says.
        for tick in 0..60 {
            ch.drive_bots();
            ch.players.inputs_per_tick = 3.0;
            ch.players.step_in(&mut ch.actors, &ch.world, tick, Some(&mut ch.open));
        }
        // They wandered off from where they stood.
        let moved = ch
            .bots
            .iter()
            .zip(&start)
            .filter(|(b, s)| ch.players.open_view(b.entity).is_some_and(|(p, _, _)| (p.pos.x - s.0).hypot(p.pos.z - s.1) > 0.5))
            .count();
        assert!(moved >= 2, "{moved} of 4 moved");
        ch.remove_bots();
        assert!(ch.bots.is_empty());
        assert!(ch.players.each_open().all(|(e, _, _, _)| e.as_bot().is_none()), "no bot left among the players");
    }

    #[test]
    fn skirmishers_on_two_sides_fight() {
        let mut ch = Game::test();
        let s = &emberholm().recipe.spawn;
        ch.spawn_bots(1, Brain::Skirmisher, s.x, s.z, 0);
        ch.spawn_bots(1, Brain::Skirmisher, s.x + 4.0, s.z, 1);
        let hp = |ch: &Game| -> Vec<f64> { ch.bots.iter().map(|b| ch.players.open_view(b.entity).map_or(0.0, |(p, _, _)| p.hp)).collect() };
        let full = hp(&ch);
        for tick in 0..200 {
            ch.drive_bots();
            ch.players.inputs_per_tick = 3.0;
            ch.players.step_in(&mut ch.actors, &ch.world, tick, Some(&mut ch.open));
        }
        let now = hp(&ch);
        assert!(now.iter().zip(&full).any(|(n, f)| n < f), "blows landed: {full:?} -> {now:?}");
    }

    /// The battlefield as it comes (its 32 bots, two sides), with each weapon in turn (swords,
    /// clubs, staves and bows), played for `ticks` ticks of the rules alone: the game itself, and a
    /// hash of everyone's state after every tick (FNV-1a over each player's state as the browser
    /// reads it, in slot order), and how many arrows were seen in flight, tick by tick.
    pub(crate) fn battle(ticks: u32) -> (Game, String, usize) {
        let mut ch = battlefield();
        ch.zone_bots_in();
        let ids: Vec<EntityId> = ch.bots.iter().map(|b| b.entity).collect();
        for (k, id) in ids.into_iter().enumerate() {
            let name = ["sword", "club", "staff", "bow"][k % 4];
            let weapon = crate::tuning::weapon_index(name).expect("its weapon");
            let skills = crate::skills::skills_from(&[name]);
            if let Some((p, _)) = ch.players.open_mut(id) {
                p.apply_build(Build { skills, weapon, ..Build::default() });
            }
        }
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut arrows = 0;
        for _ in 0..ticks {
            ch.play_tick(1.0 / f64::from(TICK_HZ), 0.0);
            for (_, _, p, _) in ch.players.each_open() {
                for b in state_text(p).bytes() {
                    h = (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3);
                }
            }
            // As a browser in the middle would have seen them (within 90 m, at most 64).
            arrows += ch.players.arrows().iter().filter(|a| a.x.hypot(a.z) <= 90.0).count().min(64);
        }
        (ch, format!("{h:016x}"), arrows)
    }

    #[test]
    fn a_battle_plays_out_as_it_always_has() {
        // Combat between players, bots' brains and their moves, the battlefield's floor: a guard
        // for the server's own rules, which the engine's golden scenarios don't step (and for
        // running them in parallel, which mustn't change a thing). If a rule changed on purpose, this is the
        // battle's new hash.
        let (ch, hash, arrows) = battle(400);
        assert_eq!(ch.bots.len(), 32);
        // It was a fight: blows landed, arrows flew, and some went down.
        assert!(ch.players.pvp_hits > 50, "{} blows", ch.players.pvp_hits);
        assert!(arrows > 20, "{arrows} arrows");
        assert!(ch.players.each_open().any(|(_, _, p, _)| p.down_frame >= 0 || p.hp < 100.0), "nobody hurt");
        assert_eq!(hash, "73470aebbc6e11b5");
    }

    /// The battlefield with `n` skirmishers, half a side, spread in rows of groups of eight facing
    /// each other across the middle, and an admin in it receiving every update: the game as the
    /// tick-time bench plays it.
    fn crowded_battlefield(n: u32) -> Game {
        let mut ch = battlefield();
        ch.join(super::super::tests::arrival(1, 1, "Admin", true, None));
        let groups = n.div_ceil(16);
        for team in 0..2u8 {
            for g in 0..groups {
                let (row, col) = (g / 8, g % 8);
                let x = -44.0 + f64::from(col) * 12.5;
                let z = if team == 0 { -1.0 } else { 1.0 } * (10.0 + f64::from(row) * 6.0);
                ch.spawn_bots_up_to(8, Brain::Skirmisher, x, z, team, n as usize);
            }
        }
        ch
    }

    #[test]
    #[ignore = "a measurement, run by hand: cargo test --release -p ruina-server tick_time -- --ignored --nocapture"]
    fn tick_time_in_the_battlefield() {
        for n in [64u32, 256, 1024] {
            for (how, stepping) in [("one after another", Stepping::InOrder), ("all at once", Stepping::Parallel)] {
                let mut ch = crowded_battlefield(n);
                ch.stepping = stepping;
                assert_eq!(ch.bots.len(), n as usize);
                for _ in 0..40 {
                    ch.play_tick(1.0 / f64::from(TICK_HZ), 0.0);
                }
                let ticks = 100;
                let (mut rules, mut published, mut encoded, mut bytes) = (0.0, 0.0, 0.0, 0);
                // The admin's connection: its encoder, and a browser acknowledging what it hears.
                let mut enc = crate::gate::encode::Encoder::new(1, true);
                let mut heard = ruina_wire::heard::Heard::new();
                for _ in 0..ticks {
                    let t = std::time::Instant::now();
                    ch.play_tick(1.0 / f64::from(TICK_HZ), 0.0);
                    let m = std::time::Instant::now();
                    // The simulation's part: the tick's records, once.
                    let out = ch.publish(m);
                    let e = std::time::Instant::now();
                    // The gate's part, on its own threads: the admin's update built from them.
                    let me = out.private_of(1).expect("the admin's own");
                    let (update, text) = enc.tick(&out, me, crate::gate::encode::Owed::default());
                    bytes = update.len() + text.len();
                    heard.hear(&update).expect("it reads");
                    enc.ack(&heard.ack().write());
                    rules += (m - t).as_secs_f64() * 1000.0;
                    published += (e - m).as_secs_f64() * 1000.0;
                    encoded += e.elapsed().as_secs_f64() * 1000.0;
                    ch.writes.clear();
                }
                let per = |v: f64| v / f64::from(ticks);
                let (rules, published, encoded) = (per(rules), per(published), per(encoded));
                println!(
                    "{n:5} bots, {how:17}: the rules {rules:7.3} ms a tick, its records {published:7.3} ms (the simulation's tick {:7.3} ms); the gate's update {encoded:7.3} ms, {bytes} bytes ({} blows)",
                    rules + published,
                    ch.players.pvp_hits
                );
            }
        }
    }

    /// The battlefield's two sides (each weapon in turn, as in `battle`) with a war-band of goblins
    /// and two slimes in the middle of them, played for `ticks` ticks: its players stepped as
    /// `stepping` says and, given `shuffle`, its bots' brains and its creatures in an order shuffled
    /// afresh before every tick. A hash of every player, creature, arrow, meteor and effect (and what
    /// each player was told) after every tick.
    fn melee(ticks: u32, stepping: Stepping, shuffle: Option<u32>) -> String {
        let mut ch = battlefield();
        ch.stepping = stepping;
        ch.zone_bots_in();
        let ids: Vec<EntityId> = ch.bots.iter().map(|b| b.entity).collect();
        for (k, id) in ids.into_iter().enumerate() {
            let name = ["sword", "club", "staff", "bow"][k % 4];
            let weapon = crate::tuning::weapon_index(name).expect("its weapon");
            let skills = crate::skills::skills_from(&[name]);
            if let Some((p, _)) = ch.players.open_mut(id) {
                p.apply_build(Build { skills, weapon, ..Build::default() });
            }
        }
        // Round the copy's own origin: an instance is a space of its own.
        let (ox, oz) = (0.0f64, 0.0f64);
        // A war-band of six on each flank, in a ring.
        for band in 1..=2u32 {
            let cx = ox + if band == 1 { -12.0 } else { 12.0 };
            for k in 0..6u32 {
                let a = f64::from(k) / 6.0 * std::f64::consts::TAU;
                ch.actors.spawn_in_band("goblin", cx + 2.0 * a.js_sin(), oz + 2.0 * a.js_cos(), 0.0, 0x90b1 + band * 16 + k, band);
            }
        }
        ch.actors.spawn("slime", ox - 6.0, oz, 0x51e0);
        ch.actors.spawn("slime", ox + 6.0, oz, 0x51e1);
        let mut rng = shuffle.map(Rng::new);
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut fold = |text: String| {
            for b in text.bytes() {
                h = (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3);
            }
        };
        for _ in 0..ticks {
            if let Some(r) = rng.as_mut() {
                r.shuffle(&mut ch.bots);
                r.shuffle(&mut ch.actors.list);
            }
            ch.play_tick(1.0 / f64::from(TICK_HZ), 0.0);
            for (c, _, p, _) in ch.players.each_open() {
                let told: Option<Vec<Value>> = ch.players.slot_index(c).map(|s| ch.players.told(s).iter().map(effect).collect());
                fold(json!([PlayerState::of(p), told]).to_string());
            }
            let mut creatures: Vec<&crate::actor::Actor> = ch.actors.list.iter().collect();
            creatures.sort_by_key(|a| a.id);
            for a in creatures {
                fold(json!([a.id, a.x, a.y, a.z, a.facing, a.hp, a.state, a.dead_frame, a.lean_x, a.lean_z]).to_string());
            }
            let arrows: Vec<Value> = ch
                .players
                .arrows()
                .iter()
                .map(|a| json!({ "id": a.id, "owner": a.owner, "x": a.x, "y": a.y, "z": a.z, "vx": a.dx * a.speed, "vz": a.dz * a.speed, "team": a.team }))
                .collect();
            let meteors: Vec<Value> = ch
                .players
                .meteors()
                .iter()
                .map(|m| json!({ "id": m.id, "x": m.x, "z": m.z, "ticksLeft": m.ticks_left, "fallTicks": m.fall_ticks, "team": m.team, "radius": m.radius }))
                .collect();
            let events: Vec<Value> = ch.players.shown().iter().map(effect).collect();
            fold(json!([arrows, meteors, events, ch.players.pvp_hits]).to_string());
        }
        assert!(ch.players.pvp_hits > 20, "a fight: {} blows", ch.players.pvp_hits);
        assert!(ch.actors.list.iter().any(|a| a.hp < a.max_hp || a.dead_frame >= 0), "the creatures were in it");
        format!("{h:016x}")
    }

    #[test]
    fn the_order_a_channel_steps_its_players_bots_and_creatures_in_changes_nothing() {
        let kept = melee(200, Stepping::InOrder, None);
        for seed in 1..=3u32 {
            let shuffled = melee(200, Stepping::Shuffled(Rng::new(seed)), Some(seed.wrapping_mul(0x9e37_79b1)));
            assert_eq!(shuffled, kept, "stepped in an order shuffled with seed {seed}");
        }
    }

    #[test]
    fn stepped_all_at_once_a_channel_plays_the_same_game() {
        assert_eq!(melee(200, Stepping::Parallel, None), melee(200, Stepping::InOrder, None));
    }

    #[test]
    fn a_channel_holds_only_so_many() {
        let mut ch = Game::test();
        let s = &emberholm().recipe.spawn;
        let joined = ch.spawn_bots(MAX_BOTS as u32 + 10, Brain::Wanderer, s.x, s.z, 0);
        assert!(joined as usize <= MAX_BOTS);
    }
}
