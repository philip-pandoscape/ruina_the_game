//! Bots in a channel or a dungeon's copy: players without a socket, their inputs decided each tick
//! by their brains (crates/engine/src/bots.rs), stepped with everyone else's by the same rules and
//! shown to everyone as peers marked as bots. An admin's developer panel adds and removes them
//! (Command::Bots); the battlefield's developer zone will bring its own.

use serde_json::json;

use super::{ChannelGame, TICK_HZ, client};
use crate::bots::{Bot, Brain, FoeSeen};
use crate::jsmath::JsMath;
use crate::life::Life;
use crate::open::colliders::ground_at;
use crate::player::{Actions, Build, Player};
use crate::world::Spawn;

/// A bot playing here.
pub struct BotSlot {
    pub id: i64,
    pub name: String,
    brain: Bot,
    /// Its last input's number: bots number their inputs as browsers do.
    seq: u32,
}

/// Bots' ids: below every character's (they start at 1), counting down from here.
const FIRST_BOT: i64 = -1_000_000;
/// The most bots one channel holds, so a slip of the panel can't fill it.
pub const MAX_BOTS: usize = 64;

impl ChannelGame {
    /// Up to `n` bots with `brain` in a ring round (x, z), on `team`. How many joined: the channel
    /// may be full, or at its bots' limit.
    pub fn spawn_bots(&mut self, n: u32, brain: Brain, x: f64, z: f64, team: u8) -> u32 {
        let hf = self.open.terrain();
        let mut joined = 0;
        for k in 0..n {
            if self.bots.len() >= MAX_BOTS {
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
            let life = Box::new(Life::new(self.open.zone, None, None));
            if !self.players.join_open(client(id), id, player, life) {
                break;
            }
            let name = format!("{} {}", if brain == Brain::Wanderer { "Wanderer" } else { "Skirmisher" }, self.bot_count);
            self.bots.push(BotSlot { id, name, brain: Bot::new(brain, 0x5eed_0000 ^ self.bot_count, (x, z)), seq: 0 });
            joined += 1;
        }
        joined
    }

    /// A developer zone's bots, as its file lists them, if they aren't here already: they come in
    /// with the first player into it while it's empty (put) and go with its last (take).
    pub(super) fn zone_bots_in(&mut self) {
        let Some(c) = self.copy_of() else { return };
        let (def, origin) = (c.def, c.def.origin);
        if !self.bots.is_empty() || def.bots.is_empty() {
            return;
        }
        for b in &def.bots {
            let brain = Brain::named(&b.brain).unwrap_or(Brain::Skirmisher);
            self.spawn_bots(b.count, brain, origin.x + b.x, origin.z + b.z, b.team);
        }
    }

    /// Every bot here gone.
    pub fn remove_bots(&mut self) {
        for b in std::mem::take(&mut self.bots) {
            self.players.leave(client(b.id));
            self.send_all(&json!({ "t": "left", "id": b.id }).to_string(), None);
        }
    }

    /// A bot's name, if `id` is one of the bots here.
    pub(super) fn bot_name(&self, id: i64) -> Option<&str> {
        self.bots.iter().find(|b| b.id == id).map(|b| b.name.as_str())
    }

    /// Each bot looks at who it can fight (anyone on another side, players and bots alike) and
    /// queues this tick's inputs: one a step, as a browser sends them.
    pub(super) fn drive_bots(&mut self) {
        if self.bots.is_empty() {
            return;
        }
        let everyone: Vec<(i64, u8, FoeSeen)> = self
            .players
            .each_open()
            .map(|(_, owner, p, _)| (owner, p.team, FoeSeen { x: p.pos.x, z: p.pos.z, hp: if p.down_frame >= 0 { 0.0 } else { p.hp } }))
            .collect();
        let steps = 60 / TICK_HZ;
        for b in &mut self.bots {
            let Some((me, _, _)) = self.players.open_view(client(b.id)) else { continue };
            let foes: Vec<FoeSeen> = everyone.iter().filter(|(id, team, _)| *id != b.id && *team != me.team).map(|(_, _, f)| *f).collect();
            let a = b.brain.think(me, &foes);
            let first = b.seq + 1;
            b.seq += steps;
            // A press counts once: on the first of the tick's steps.
            let held = Actions { attack_pressed: false, jump_pressed: false, slide_pressed: false, ability_slot: 0, movement_slot: 0, ..a };
            // A bot sees everyone where they are: nothing to rewind.
            self.players.queue_actions(client(b.id), (0..steps).map(|k| (first + k, f64::INFINITY, if k == 0 { a } else { held })));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open::zone::emberholm;

    #[test]
    fn bots_join_play_and_leave() {
        let mut ch = ChannelGame::new(1);
        let s = &emberholm().recipe.spawn;
        assert_eq!(ch.spawn_bots(4, Brain::Wanderer, s.x, s.z, 0), 4);
        assert_eq!(ch.bots.len(), 4);
        let start: Vec<(f64, f64)> = ch.bots.iter().map(|b| ch.players.open_view(client(b.id)).map(|(p, _, _)| (p.pos.x, p.pos.z)).unwrap()).collect();
        // A tick at a time as step() runs them, with a tick's worth of inputs whatever the clock says.
        for tick in 0..60 {
            ch.drive_bots();
            ch.players.inputs_per_tick = 3.0;
            ch.players.step_in(&mut ch.battle, &mut ch.actors, &ch.world, tick, Some(&mut ch.open));
        }
        // They wandered off from where they stood.
        let moved = ch
            .bots
            .iter()
            .zip(&start)
            .filter(|(b, s)| ch.players.open_view(client(b.id)).is_some_and(|(p, _, _)| (p.pos.x - s.0).hypot(p.pos.z - s.1) > 0.5))
            .count();
        assert!(moved >= 2, "{moved} of 4 moved");
        ch.remove_bots();
        assert!(ch.bots.is_empty());
        assert!(ch.players.open_view(client(FIRST_BOT - 1)).is_none());
    }

    #[test]
    fn skirmishers_on_two_sides_fight() {
        let mut ch = ChannelGame::new(1);
        let s = &emberholm().recipe.spawn;
        ch.spawn_bots(1, Brain::Skirmisher, s.x, s.z, 0);
        ch.spawn_bots(1, Brain::Skirmisher, s.x + 4.0, s.z, 1);
        let hp = |ch: &ChannelGame| -> Vec<f64> { ch.bots.iter().map(|b| ch.players.open_view(client(b.id)).map_or(0.0, |(p, _, _)| p.hp)).collect() };
        let full = hp(&ch);
        for tick in 0..200 {
            ch.drive_bots();
            ch.players.inputs_per_tick = 3.0;
            ch.players.step_in(&mut ch.battle, &mut ch.actors, &ch.world, tick, Some(&mut ch.open));
        }
        let now = hp(&ch);
        assert!(now.iter().zip(&full).any(|(n, f)| n < f), "blows landed: {full:?} -> {now:?}");
    }

    #[test]
    fn a_channel_holds_only_so_many() {
        let mut ch = ChannelGame::new(1);
        let s = &emberholm().recipe.spawn;
        let joined = ch.spawn_bots(MAX_BOTS as u32 + 10, Brain::Wanderer, s.x, s.z, 0);
        assert!(joined as usize <= MAX_BOTS);
    }
}
