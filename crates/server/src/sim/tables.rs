//! The channel's side of mini-games (crate::minigames): challenges between the players here, the
//! tables thrown down for the ones accepted, the money on them, and what each player hears.
//!
//! Money never vanishes or doubles. A stake leaves its player's purse for their life's `staked`
//! (state.rs) as the game starts, so each life on its own always adds up: if the server stops
//! or falls over mid-game, the life comes back with the stake returned to the purse
//! (load_life). When a game ends the pot is made of what the two lives hold staked, never
//! more, and the two lives are written to the database together, in one transaction, so one
//! can't be kept without the other. A game called off returns each stake to its own player.

use std::collections::HashSet;

use serde_json::{Value, json};

use ruina_world_api::gate::ToConn;
use ruina_world_api::store::{LifeWrite, Then, ToStore, Transfer};

use super::{Game, client, life_save};
use crate::life::Life;
use crate::life::content::format_coins;
use crate::minigames::{Challenge, Seat, Spot, Table, Why, content};
use crate::open::colliders::ground_at;
use crate::player::Mode;

/// Tables further than this from a player aren't sent to them.
pub(crate) const SHOW_TABLES: f64 = 90.0;
/// Slack on the challenge range for where each of you was drawn on the other's screen.
const RANGE_SLACK: f64 = 1.0;
/// How far apart you may have wandered by the time a challenge is accepted.
const ACCEPT_RANGE: f64 = 7.0;
/// A seated player pushed further than this from their seat is put back in it.
const PIN: f64 = 0.25;

/// Why someone can't sit down to a game right now.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Busy {
    Unsaved,
    Riding,
    Flying,
    Swimming,
    Fighting,
    Down,
    Pack,
    Playing,
}

/// Why not, to you (`name` None) or about someone else.
fn say(b: Busy, name: Option<&str>) -> String {
    match (b, name) {
        (Busy::Unsaved, None) => "Your character can't be saved just now, so you can't play for stakes.".into(),
        (Busy::Unsaved, Some(n)) => format!("{n} can't play just now."),
        (Busy::Riding, None) => "Get down first - games are played on foot.".into(),
        (Busy::Riding, Some(n)) => format!("{n} is riding."),
        (Busy::Flying, None) => "Land first - games are played on foot.".into(),
        (Busy::Flying, Some(n)) => format!("{n} is in the air."),
        (Busy::Swimming, None) => "Get out of the water first.".into(),
        (Busy::Swimming, Some(n)) => format!("{n} is swimming."),
        (Busy::Fighting, None) => "Finish what you're doing first.".into(),
        (Busy::Fighting, Some(n)) => format!("{n} is busy."),
        (Busy::Down, None) => "Get back on your feet first.".into(),
        (Busy::Down, Some(n)) => format!("{n} is down."),
        (Busy::Pack, None) => "Put your pack down first.".into(),
        (Busy::Pack, Some(n)) => format!("{n} has a pack on their back."),
        (Busy::Playing, None) => "You're already at a table.".into(),
        (Busy::Playing, Some(n)) => format!("{n} is already playing."),
    }
}

/// A seed for a game's deal nobody can guess.
fn fresh_seed(id: u64) -> u32 {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
    let x = t ^ id.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    ((x >> 32) as u32 ^ x as u32) | 1
}

impl Game {
    /// The clock games run on, in seconds.
    pub(crate) fn game_clock(&self) -> f64 {
        self.started.elapsed().as_secs_f64() + self.skew
    }

    /// Whether anything is going on at a table or in a challenge (the channel keeps its clocks
    /// running for it, even with nobody connected).
    pub fn has_tables(&self) -> bool {
        !self.tables.idle()
    }

    /// Whether `id` is sitting at a table (they can't walk off or do anything else there).
    pub fn seated(&self, id: i64) -> bool {
        self.tables.seated(id)
    }

    /// Why `id` can't sit down to a game now, if they can't.
    fn busy(&self, id: i64) -> Option<Busy> {
        if self.members.get(&id).is_none_or(|m| m.keep_saved) {
            return Some(Busy::Unsaved);
        }
        if self.tables.seated(id) {
            return Some(Busy::Playing);
        }
        let (p, _, _) = self.players.open_view(client(id))?;
        match p.mode {
            Mode::Ride => return Some(Busy::Riding),
            Mode::Glide => return Some(Busy::Flying),
            Mode::Swim => return Some(Busy::Swimming),
            Mode::Attack | Mode::Cast | Mode::Action => return Some(Busy::Fighting),
            Mode::Normal => {}
        }
        if p.hp <= 0.0 || p.down_frame >= 0 {
            return Some(Busy::Down);
        }
        if p.pack != 0 {
            return Some(Busy::Pack);
        }
        None
    }

    fn name_of(&self, id: i64) -> Option<String> {
        self.members.get(&id).map(|m| m.name.clone())
    }

    fn distance(&self, a: i64, b: i64) -> Option<f64> {
        let (pa, _, _) = self.players.open_view(client(a))?;
        let (pb, _, _) = self.players.open_view(client(b))?;
        Some((pa.pos.x - pb.pos.x).hypot(pa.pos.z - pb.pos.z))
    }

    fn coins(&self, id: i64) -> f64 {
        self.players.open_view(client(id)).and_then(|(_, _, l)| l).map_or(0.0, |l| l.state.coins)
    }

    /// The life of `id`, here or just gone (a life a game changes while its player is away is
    /// marked to be written when the server stops).
    fn life_of(&mut self, id: i64) -> Option<&mut Life> {
        if self.members.contains_key(&id) {
            return self.players.open_mut(client(id)).and_then(|(_, l)| l);
        }
        let l = self.lingering.get_mut(&id)?;
        l.dirty = true;
        Some(&mut l.life)
    }

    /// The life of `id` as it would be saved now, under the grant it was played under.
    fn save_of(&mut self, id: i64) -> Option<LifeWrite> {
        if let Some(m) = self.members.get(&id) {
            if m.keep_saved {
                return None;
            }
            let (epoch, home, conn) = (m.epoch, m.home.clone(), m.conn);
            let (p, life) = self.players.open_mut(client(id))?;
            let save = life_save(p, life?, &mut self.open, id);
            return Some(self.life_write(id, epoch, &home, save, Some(conn)));
        }
        let l = self.lingering.get_mut(&id)?;
        let save = life_save(&l.player, &mut l.life, &mut self.open, id);
        let (epoch, home) = (l.epoch, l.home.clone());
        Some(self.life_write(id, epoch, &home, save, None))
    }

    /// Something for `id` to read: at once if they're here, when they're back if they're away.
    pub(crate) fn toast(&mut self, id: i64, text: impl Into<String>, kind: &str) {
        let life = if self.members.contains_key(&id) {
            self.players.open_mut(client(id)).and_then(|(_, l)| l)
        } else {
            self.lingering.get_mut(&id).map(|l| &mut *l.life)
        };
        if let Some(life) = life {
            life.toast(text, kind);
        }
    }

    /// Tells `id` what's going on with their challenges.
    pub(super) fn tell_challenges(&mut self, id: i64) {
        let v = self.tables.challenges_json(id, self.game_clock());
        self.say(id, ToConn::Challenges { sent: v["sent"].clone(), waiting: v["waiting"].clone() });
    }

    /// `from` challenges `to` to the game at `game` in the bundle (as it comes on the wire) for
    /// `stake` copper each. On development servers `seed` deals a known game. Err: why not, for
    /// `from`.
    pub fn challenge(&mut self, from: i64, to: i64, game: usize, stake: f64, seed: Option<u32>) -> Result<(), String> {
        self.challenge_timed(from, to, game, stake, seed, None)
    }

    /// A challenge whose game gives each turn `turn` seconds, on development servers (tests in a
    /// browser that draws in software, too slow for the game's own clock).
    pub fn challenge_timed(&mut self, from: i64, to: i64, game: usize, stake: f64, seed: Option<u32>, turn: Option<f64>) -> Result<(), String> {
        let c = &content().challenge;
        let now = self.game_clock();
        let Some(def) = crate::minigames::game(game) else { return Err("There's no such game.".into()) };
        if from == to {
            return Err("You can't challenge yourself.".into());
        }
        let Some(to_name) = self.name_of(to) else { return Err("They aren't here any more.".into()) };
        let from_name = self.name_of(from).unwrap_or_default();
        if !c.stakes.contains(&stake) {
            return Err("That isn't a stake you can offer.".into());
        }
        if let Some(b) = self.busy(from) {
            return Err(say(b, None));
        }
        if let Some(b) = self.busy(to) {
            return Err(say(b, Some(&to_name)));
        }
        if self.tables.sent_by(from).is_some() {
            return Err("You've challenged someone already - wait for their answer, or withdraw it.".into());
        }
        if self.tables.waiting_for(from).is_some() {
            return Err("Answer the challenge waiting for you first.".into());
        }
        if self.tables.waiting_for(to).is_some() || self.tables.sent_by(to).is_some() {
            return Err(format!("{to_name} is answering another challenge."));
        }
        if self.tables.declined.get(&(from, to)).is_some_and(|&until| until > now) {
            return Err(format!("{to_name} said no just now."));
        }
        if self.distance(from, to).is_none_or(|d| d > c.range + RANGE_SLACK) {
            return Err(format!("Walk up to {to_name} first."));
        }
        if stake > self.coins(from) {
            return Err("You don't have that much to stake.".into());
        }
        let dev = self.members.get(&from).is_some_and(|m| m.dev);
        self.tables.challenges.push(Challenge {
            from,
            from_name,
            to,
            to_name,
            game: def,
            stake,
            expires: now + c.invite_seconds,
            seed: seed.filter(|_| dev),
            turn: turn.filter(|t| dev && t.is_finite() && *t > 0.0),
        });
        self.tell_challenges(from);
        self.tell_challenges(to);
        Ok(())
    }

    /// `from` takes their challenge back.
    pub fn withdraw(&mut self, from: i64) {
        let Some(i) = self.tables.challenges.iter().position(|c| c.from == from) else { return };
        let c = self.tables.challenges.remove(i);
        self.toast(c.to, format!("{} withdrew their challenge.", c.from_name), "info");
        self.tell_challenges(c.from);
        self.tell_challenges(c.to);
    }

    /// `to` answers `from`'s challenge. Accepting checks everything again, takes both stakes and
    /// throws the table down between them. Err: why not, for `to` (a challenge that can still be
    /// accepted once that's put right stays open).
    pub fn answer(&mut self, to: i64, from: i64, accept: bool) -> Result<(), String> {
        let now = self.game_clock();
        let Some(i) = self.tables.challenges.iter().position(|c| c.from == from && c.to == to) else {
            return Err("That challenge isn't open any more.".into());
        };
        let (game, stake, seed, turn, from_name, to_name) = {
            let c = &self.tables.challenges[i];
            (c.game, c.stake, c.seed, c.turn, c.from_name.clone(), c.to_name.clone())
        };
        let close = |ch: &mut Game| {
            ch.tables.challenges.retain(|c| !(c.from == from && c.to == to));
            ch.tell_challenges(from);
            ch.tell_challenges(to);
        };
        if !accept {
            close(self);
            self.tables.declined.insert((from, to), now + content().challenge.decline_cooldown);
            self.toast(from, format!("{to_name} declined your challenge."), "info");
            return Ok(());
        }
        if !self.members.contains_key(&from) {
            close(self);
            return Err(format!("{from_name} isn't here any more."));
        }
        if let Some(b) = self.busy(to) {
            return Err(say(b, None));
        }
        if let Some(b) = self.busy(from) {
            return Err(say(b, Some(&from_name)));
        }
        if self.distance(from, to).is_none_or(|d| d > ACCEPT_RANGE) {
            return Err(format!("{from_name} has walked off - stand together to play."));
        }
        if stake > self.coins(to) {
            return Err("You don't have enough to match the stake.".into());
        }
        if stake > self.coins(from) {
            close(self);
            self.toast(from, "You no longer have the stake you offered.", "bad");
            return Err(format!("{from_name} can't cover the stake any more."));
        }
        let Some(spot) = self.table_spot(to, from) else { return Err("There's no room for a table here - find open, level ground.".into()) };
        let id = self.tables.next_id();
        let rules = game.deal(seed.unwrap_or_else(|| fresh_seed(id)));
        // Agreed: into the pot with the stakes, and down with the table. The challenged player
        // has seat 0 and moves first.
        close(self);
        for id in [to, from] {
            if let Some(life) = self.life_of(id) {
                life.state.coins -= stake;
                if stake > 0.0 {
                    life.state.staked = Some(life.state.staked.unwrap_or(0.0) + stake);
                }
            }
            if let Some(m) = self.members.get_mut(&id) {
                m.life_due = 3;
            }
        }
        let mut table = Table::new(id, game, stake, [Seat::new(to, &to_name), Seat::new(from, &from_name)], spot, rules, now);
        if let Some(t) = turn {
            table.turn_seconds = t;
        }
        self.tables.tables.push(table);
        self.pin_seated(Some(id));
        let pot = if stake > 0.0 { format!(" for {}", format_coins(stake * 2.0)) } else { String::new() };
        self.toast(to, format!("You sit down to {} with {from_name}{pot}. You go first.", game.name), "info");
        self.toast(from, format!("{to_name} accepts! You sit down to {}{pot}.", game.name), "info");
        Ok(())
    }

    /// Where a table goes between `a` (seat 0) and `b`: the middle of the two on dry ground, with
    /// room for a seat either side at about its height. None if there isn't.
    fn table_spot(&self, a: i64, b: i64) -> Option<Spot> {
        let (pa, _, _) = self.players.open_view(client(a))?;
        let (pb, _, _) = self.players.open_view(client(b))?;
        let (dx, dz) = (pb.pos.x - pa.pos.x, pb.pos.z - pa.pos.z);
        let rot = if dx.hypot(dz) > 0.3 { dx.atan2(dz) } else { pa.facing };
        let (x, z) = ((pa.pos.x + pb.pos.x) / 2.0, (pa.pos.z + pb.pos.z) / 2.0);
        let hf = self.open.terrain();
        let feet = (pa.pos.y + pb.pos.y) / 2.0;
        let y = ground_at(hf, &self.open.index, x, z, feet, 0.6);
        let spot = Spot { x, y, z, rot };
        let dry = |x: f64, z: f64, y: f64| hf.inside(x, z, 2.0) && y > hf.water + 0.05;
        if !dry(x, z, y) {
            return None;
        }
        for k in 0..2 {
            let (sx, sz, _) = spot.seat(k);
            let sy = ground_at(hf, &self.open.index, sx, sz, y, 0.6);
            if !dry(sx, sz, sy) || (sy - y).abs() > 0.7 {
                return None;
            }
        }
        Some(spot)
    }

    /// Keeps everyone at a table in their seat: puts the players of table `start` there, facing
    /// it, as its game starts, and anyone else at a table back there if something pushed them out.
    fn pin_seated(&mut self, start: Option<u64>) {
        let seats: Vec<(i64, Spot, usize, bool)> =
            self.tables.tables.iter().flat_map(|t| (0..2).map(move |k| (t.seats[k].id, t.at, k, Some(t.id) == start))).collect();
        for (id, at, k, sit_down) in seats {
            let (x, z, facing) = at.seat(k);
            let Some((p, _)) = self.players.open_mut(client(id)) else { continue };
            if !sit_down && (p.pos.x - x).hypot(p.pos.z - z) <= PIN && p.mode == Mode::Normal {
                continue;
            }
            let hf = self.open.terrain();
            p.pos.x = x;
            p.pos.z = z;
            p.pos.y = ground_at(hf, &self.open.index, x, z, at.y, 0.6);
            p.vel = Default::default();
            p.facing = facing;
            p.mode = Mode::Normal;
            p.grounded = true;
            p.sprinting = false;
            p.crouching = false;
        }
    }

    /// A move from `who` at their table, as the browser sent it.
    pub fn table_move(&mut self, who: i64, table: u64, m: &Value) -> Result<(), String> {
        let now = self.game_clock();
        let Some(k) = self.tables.tables.iter().position(|t| t.id == table) else { return Err("That game is over.".into()) };
        let t = &mut self.tables.tables[k];
        let Some(seat) = t.seat_of(who) else { return Err("You aren't at that table.".into()) };
        t.play(seat, m, now)?;
        if t.over.is_some() {
            self.settle(k);
        }
        Ok(())
    }

    /// `who` gives up their game: the other player wins it.
    pub fn concede(&mut self, who: i64, table: u64) -> Result<(), String> {
        let now = self.game_clock();
        let Some(k) = self.tables.tables.iter().position(|t| t.id == table) else { return Err("That game is over.".into()) };
        let t = &mut self.tables.tables[k];
        let Some(seat) = t.seat_of(who) else { return Err("You aren't at that table.".into()) };
        if t.over.is_some() {
            return Ok(());
        }
        t.concede(seat, now);
        self.settle(k);
        Ok(())
    }

    /// Calls off every game going on, each stake back to its player, and every challenge (the
    /// server is stopping).
    pub(super) fn abort_tables(&mut self) {
        let now = self.game_clock();
        for k in 0..self.tables.tables.len() {
            if self.tables.tables[k].over.is_none() {
                self.tables.tables[k].abort(now);
                self.settle(k);
            }
        }
        for c in std::mem::take(&mut self.tables.challenges) {
            self.tell_challenges(c.from);
            self.tell_challenges(c.to);
        }
    }

    /// Calls off the game `id` is playing, if any, and takes the table away at once (their life
    /// is being started over, and they with it).
    pub(super) fn abort_table_of(&mut self, id: i64) {
        let now = self.game_clock();
        let Some(k) = self.tables.table_of(id) else { return };
        if self.tables.tables[k].over.is_none() {
            self.tables.tables[k].abort(now);
            self.settle(k);
        }
        let t = self.tables.tables.remove(k);
        for s in &t.seats {
            self.tables.sent.remove(&s.id);
            self.say(s.id, ToConn::Table { table: None });
        }
    }

    /// `id` left the channel: challenges to or from them are off. A game they're playing goes on
    /// without them for a while (their turns run out), in case they come back.
    pub(super) fn left_tables(&mut self, id: i64) {
        let gone: Vec<Challenge> = {
            let (gone, keep) = std::mem::take(&mut self.tables.challenges).into_iter().partition(|c| c.from == id || c.to == id);
            self.tables.challenges = keep;
            gone
        };
        for c in gone {
            let other = if c.from == id { c.to } else { c.from };
            let name = if c.from == id { &c.from_name } else { &c.to_name };
            self.toast(other, format!("{name} left, and the challenge with them."), "info");
            self.tell_challenges(other);
        }
        self.tables.sent.remove(&id);
    }

    /// `id` arrived (or came back): what's going on with their challenges and their table goes
    /// to their browser again.
    pub(super) fn joined_tables(&mut self, id: i64) {
        self.tables.sent.remove(&id);
        if self.tables.sent_by(id).is_some() || self.tables.waiting_for(id).is_some() {
            self.tell_challenges(id);
        }
    }

    /// Pays out the game at table `k`, just ended: the winner takes the pot; a draw, or a game
    /// called off, returns each stake to its player. The pot is what the two lives hold staked.
    /// Both lives are then written to the database together.
    fn settle(&mut self, k: usize) {
        let t = &self.tables.tables[k];
        let Some(over) = t.over else { return };
        let table = t.id;
        let ids = [t.seats[0].id, t.seats[1].id];
        let names = [t.seats[0].name.clone(), t.seats[1].name.clone()];
        let game = t.game.name.clone();
        let mut held = [0.0; 2];
        for s in 0..2 {
            if let Some(life) = self.life_of(ids[s]) {
                held[s] = life.state.staked.take().unwrap_or(0.0);
            }
        }
        let pot = held[0] + held[1];
        // A winner's life that isn't here (it can't happen, but if it did) would take the pot
        // with it: then everyone just gets their own stake back.
        let winner = over.winner.filter(|&w| self.life_of(ids[w]).is_some());
        match winner {
            Some(w) => {
                if let Some(life) = self.life_of(ids[w]) {
                    life.state.coins += pot;
                }
            }
            None => {
                for s in 0..2 {
                    if let Some(life) = self.life_of(ids[s]) {
                        life.state.coins += held[s];
                    }
                }
            }
        }
        let won = if pot > 0.0 { format!(" and takes the pot of {}", format_coins(pot)) } else { String::new() };
        let yours = if pot > 0.0 { format!(" The pot of {} is yours.", format_coins(pot)) } else { String::new() };
        for s in 0..2 {
            let them = &names[1 - s];
            let (text, kind) = match (over.why, winner) {
                (Why::Aborted, _) => {
                    (format!("The game of {game} was called off.{}", if held[s] > 0.0 { " Your stake is back in your purse." } else { "" }), "info")
                }
                (_, None) => (format!("A draw at {game}.{}", if held[s] > 0.0 { " Your stake is back in your purse." } else { "" }), "info"),
                (Why::Conceded, Some(w)) if w == s => (format!("{them} conceded - you win at {game}!{yours}"), "coin"),
                (Why::Conceded, Some(_)) => (format!("You conceded. {them} wins at {game}{won}."), "bad"),
                (Why::Timeouts, Some(w)) if w == s => (format!("{them} ran out of time too often - you win at {game}!{yours}"), "coin"),
                (Why::Timeouts, Some(_)) => (format!("You ran out of time too often. {them} wins at {game}{won}."), "bad"),
                (Why::Away, Some(w)) if w == s => (format!("{them} was away too long - you win at {game}!{yours}"), "coin"),
                (Why::Away, Some(_)) => (format!("You were away too long. {them} wins at {game}{won}."), "bad"),
                (Why::Rules, Some(w)) if w == s => (format!("You win at {game}!{yours}"), "coin"),
                (Why::Rules, Some(_)) => (format!("{them} wins at {game}{won}."), "bad"),
            };
            self.toast(ids[s], text, kind);
        }
        for id in ids {
            if let Some(m) = self.members.get_mut(&id) {
                m.life_due = 3;
            }
        }
        // Written together, in one transaction, ahead of anything newer of theirs: a pot won with the
        // ledger's transfer from the loser to the winner (once, by its key, however often it's sent).
        let batch: Vec<LifeWrite> = ids.iter().filter_map(|&id| self.save_of(id)).collect();
        if batch.is_empty() {
            return;
        }
        match winner.filter(|_| pot > 0.0) {
            Some(w) => {
                let (to, from) = (ids[w], ids[1 - w]);
                let key = format!("pot:{}:{}:{}:{}", self.at, self.sim.0, table, crate::store::now_ms());
                let transfer = Transfer {
                    key,
                    kind: "pot".into(),
                    sides: vec![(to, format!("character:{from}"), held[1 - w]), (from, format!("character:{to}"), -held[1 - w])],
                    detail: json!({ "game": game, "stake": held[1 - w] }),
                };
                self.store.push(ToStore::Transfer { transfer, writes: batch });
            }
            None => self.store.push(ToStore::WriteLives { writes: batch, then: Then::Nothing }),
        }
    }

    /// Once a tick: challenges lapse, the tables' clocks run, games that ended are paid out, their
    /// tables cleared a little after, and every seated player hears how their game stands.
    pub(super) fn step_tables(&mut self) {
        if self.tables.idle() {
            return;
        }
        let now = self.game_clock();
        // Challenges nobody answered in time.
        let (lapsed, keep): (Vec<Challenge>, Vec<Challenge>) = std::mem::take(&mut self.tables.challenges).into_iter().partition(|c| c.expires <= now);
        self.tables.challenges = keep;
        for c in lapsed {
            self.toast(c.from, format!("{} didn't answer your challenge.", c.to_name), "info");
            self.tell_challenges(c.from);
            self.tell_challenges(c.to);
        }
        // The tables' clocks.
        let here: HashSet<i64> = self.members.keys().copied().collect();
        for k in 0..self.tables.tables.len() {
            let t = &mut self.tables.tables[k];
            if t.over.is_none() {
                t.tick(now, |id| here.contains(&id));
                if t.over.is_some() {
                    self.settle(k);
                }
            }
        }
        self.pin_seated(None);
        // A finished game's table goes a little after, and its players are free.
        let clear = content().table.clear_seconds;
        let (gone, keep): (Vec<Table>, Vec<Table>) =
            std::mem::take(&mut self.tables.tables).into_iter().partition(|t| t.over.is_some_and(|o| now - o.at >= clear));
        self.tables.tables = keep;
        for t in gone {
            for s in &t.seats {
                self.tables.sent.remove(&s.id);
                self.say(s.id, ToConn::Table { table: None });
            }
        }
        // Each seated player's view of their game, when it changed.
        let mut out = Vec::new();
        for t in &self.tables.tables {
            for (k, s) in t.seats.iter().enumerate() {
                if self.members.contains_key(&s.id) && self.tables.sent.get(&s.id) != Some(&(t.id, t.version)) {
                    out.push((s.id, t.id, t.version, ToConn::Table { table: Some(t.view(k, now)) }));
                }
            }
        }
        for (id, table, version, msg) in out {
            self.say(id, msg);
            self.tables.sent.insert(id, (table, version));
        }
        self.tables.declined.retain(|_, until| *until > now);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::super::tests::{arrival, conn, heard};
    use super::super::{Game, client, life_save, load_life, stand_on_ground};
    use crate::life::{Command, Life};
    use crate::minigames::games::beacons::setup;
    use crate::minigames::{Asking, GameDef, Why, content, game_called};
    use crate::player::{Build, Mode, Player};
    use crate::world::Spawn;
    use ruina_world_api::Epoch;
    use ruina_world_api::input::OPEN_INPUT;
    use ruina_world_api::store::{LifeWrite, ToStore};

    /// The game these tests play (a challenge names it by its place in the bundle).
    /// What a player's board view is offered with `picked` picked, from their view of the table
    /// (`Table::view`), as the browser asks the engine.
    fn offered(view: &Value, picked: Value) -> Value {
        let asking =
            Asking { you: view["you"].as_u64().unwrap() as usize, to_move: view["toMove"].as_u64().map(|s| s as usize), view: view["state"].clone(), picked };
        beacons().options(&asking).unwrap()
    }

    fn beacons() -> &'static GameDef {
        game_called("beacons").unwrap()
    }

    /// Ann (7) and Bea (8) standing two metres apart on the green by the spawn, with 200 copper
    /// each (what each of their browsers hears is in the game's outbox: heard).
    fn ann_and_bea() -> Game {
        let mut ch = Game::test();
        ch.join(arrival(7, 1, "Ann", true, None));
        ch.join(arrival(8, 2, "Bea", true, None));
        let zone = ch.open.zone;
        let (x, z) = (zone.recipe.spawn.x, zone.recipe.spawn.z);
        for (id, dx) in [(7, -1.0), (8, 1.0)] {
            let (p, life) = ch.players.open_mut(client(id)).unwrap();
            // What a newcomer hears first (their first quest) is nothing to do with games.
            life.unwrap().drain_events();
            p.pos.x = x + dx;
            p.pos.z = z;
            stand_on_ground(p, &ch.open);
        }
        ch
    }

    fn coins(ch: &Game, id: i64) -> f64 {
        ch.players.open_view(client(id)).unwrap().2.unwrap().state.coins
    }

    fn staked(ch: &Game, id: i64) -> Option<f64> {
        ch.players.open_view(client(id)).unwrap().2.unwrap().state.staked
    }

    fn toasts(ch: &mut Game, id: i64) -> Vec<String> {
        ch.players
            .open_mut(client(id))
            .unwrap()
            .1
            .unwrap()
            .drain_events()
            .into_iter()
            .filter_map(|e| if let crate::life::LifeEvent::Toast { text, .. } = e { Some(text) } else { None })
            .collect()
    }

    /// The last view of their table a browser was sent.
    fn last_view(ch: &mut Game, id: i64) -> Option<Value> {
        heard(ch, id).into_iter().rfind(|m| m["t"] == "table").map(|m| m["table"].clone())
    }

    /// The lives to be written together (a pot paid out, with its transfer), each list in one
    /// transaction.
    fn take_joint(ch: &mut Game) -> Vec<Vec<LifeWrite>> {
        std::mem::take(&mut ch.store)
            .into_iter()
            .filter_map(|m| match m {
                ToStore::WriteLives { writes, .. } | ToStore::Transfer { writes, .. } => Some(writes),
                _ => None,
            })
            .collect()
    }

    /// Ann challenges Bea for `stake` and Bea accepts: the table's id.
    fn sit_down(ch: &mut Game, stake: f64) -> u64 {
        ch.challenge(7, 8, beacons().index, stake, Some(5)).unwrap();
        ch.answer(8, 7, true).unwrap();
        ch.tables.tables.last().unwrap().id
    }

    #[test]
    fn a_challenge_accepted_puts_both_stakes_in_the_pot_and_a_table_between_them() {
        let mut ch = ann_and_bea();
        ch.challenge(7, 8, beacons().index, 50.0, None).unwrap();
        // Bea is asked, Ann waits.
        let to_bea = heard(&mut ch, 8).into_iter().find(|m| m["t"] == "challenges").unwrap();
        assert_eq!(to_bea["waiting"]["fromName"], "Ann");
        assert_eq!(to_bea["waiting"]["stake"], 50.0);
        assert_eq!(heard(&mut ch, 7).into_iter().find(|m| m["t"] == "challenges").unwrap()["sent"]["toName"], "Bea");
        // Nobody else gets asked meanwhile, by either of them.
        assert!(ch.challenge(7, 8, beacons().index, 10.0, None).is_err());
        assert!(ch.challenge(8, 7, beacons().index, 10.0, None).is_err());
        assert_eq!((coins(&ch, 7), coins(&ch, 8)), (200.0, 200.0), "nothing taken until it's accepted");
        ch.answer(8, 7, true).unwrap();
        assert_eq!((coins(&ch, 7), coins(&ch, 8)), (150.0, 150.0));
        assert_eq!((staked(&ch, 7), staked(&ch, 8)), (Some(50.0), Some(50.0)));
        assert!(ch.tables.challenges.is_empty());
        let t = &ch.tables.tables[0];
        assert_eq!((t.seats[0].id, t.seats[1].id), (8, 7), "the challenged player sits first");
        // Both at their seats, facing the table.
        for (k, id) in [(0, 8), (1, 7)] {
            let (x, z, f) = t.at.seat(k);
            let p = ch.players.open_view(client(id)).unwrap().0;
            assert!((p.pos.x - x).hypot(p.pos.z - z) < 1e-9);
            assert_eq!(p.facing, f);
        }
        // Everyone sees the table; each player sees their own hand.
        ch.step_tables();
        let view = last_view(&mut ch, 8).unwrap();
        assert_eq!(view["you"], 0);
        assert_eq!(view["state"]["hand"].as_array().unwrap().len(), 4);
        assert_eq!(offered(&view, Value::Null)["play"], true, "Bea moves first");
        let ann = last_view(&mut ch, 7).unwrap();
        assert_eq!(offered(&ann, Value::Null)["play"], false);
        assert_ne!(ann["state"]["hand"], view["state"]["hand"], "each sees only their own hand (seed 5 deals them differently)");
        let out = ch.publish(std::time::Instant::now());
        let shown: Vec<&Value> = out.tables.iter().map(|t| &t.shown).collect();
        assert_eq!(shown.len(), 1);
        assert!(shown[0]["board"]["lit"].is_array());
        assert!(shown[0].get("state").is_none(), "nobody's hand on show");
    }

    #[test]
    fn a_declined_or_unanswered_challenge_leaves_both_purses_alone() {
        let mut ch = ann_and_bea();
        ch.challenge(7, 8, beacons().index, 100.0, None).unwrap();
        ch.answer(8, 7, false).unwrap();
        assert_eq!(toasts(&mut ch, 7), ["Bea declined your challenge."]);
        assert!(ch.tables.challenges.is_empty() && ch.tables.tables.is_empty());
        assert_eq!((coins(&ch, 7), coins(&ch, 8)), (200.0, 200.0));
        // Not straight away again...
        assert_eq!(ch.challenge(7, 8, beacons().index, 100.0, None), Err("Bea said no just now.".into()));
        // ...but Bea may ask Ann, who lets it lapse.
        ch.challenge(8, 7, beacons().index, 25.0, None).unwrap();
        ch.skew += content().challenge.invite_seconds + 0.1;
        ch.step_tables();
        assert!(ch.tables.challenges.is_empty());
        assert_eq!(toasts(&mut ch, 8), ["Ann didn't answer your challenge."]);
        assert_eq!((coins(&ch, 7), coins(&ch, 8)), (200.0, 200.0));
        assert!(ch.answer(7, 8, true).is_err(), "too late");
    }

    #[test]
    fn a_challenge_needs_both_on_foot_close_together_and_able_to_pay() {
        let mut ch = ann_and_bea();
        assert!(ch.challenge(7, 8, beacons().index, 30.0, None).is_err(), "not a stake on offer");
        assert!(ch.challenge(7, 8, beacons().index, 250.0, None).is_err(), "more than Ann has");
        assert!(ch.challenge(7, 8, content().games.len(), 0.0, None).is_err());
        assert!(ch.challenge(7, 7, beacons().index, 0.0, None).is_err());
        assert!(ch.challenge(7, 9, beacons().index, 0.0, None).is_err(), "nobody by that name");
        ch.players.open_mut(client(8)).unwrap().0.pack = 4;
        assert_eq!(ch.challenge(7, 8, beacons().index, 0.0, None), Err("Bea has a pack on their back.".into()));
        ch.players.open_mut(client(8)).unwrap().0.pack = 0;
        ch.players.open_mut(client(7)).unwrap().0.mode = Mode::Swim;
        assert_eq!(ch.challenge(7, 8, beacons().index, 0.0, None), Err("Get out of the water first.".into()));
        ch.players.open_mut(client(7)).unwrap().0.mode = Mode::Normal;
        ch.players.open_mut(client(8)).unwrap().0.pos.x += 9.0;
        assert_eq!(ch.challenge(7, 8, beacons().index, 0.0, None), Err("Walk up to Bea first.".into()));
        ch.players.open_mut(client(8)).unwrap().0.pos.x -= 9.0;
        // Bea spends her money meanwhile: she can't accept, and the challenge stays for her to decline.
        ch.challenge(7, 8, beacons().index, 100.0, None).unwrap();
        ch.players.open_mut(client(8)).unwrap().1.unwrap().state.coins = 60.0;
        assert_eq!(ch.answer(8, 7, true), Err("You don't have enough to match the stake.".into()));
        assert_eq!(ch.tables.challenges.len(), 1);
        assert!(ch.tables.tables.is_empty());
        assert_eq!((coins(&ch, 7), coins(&ch, 8)), (200.0, 60.0));
    }

    #[test]
    fn at_the_table_nothing_you_press_moves_you_and_life_commands_wait() {
        let mut ch = ann_and_bea();
        sit_down(&mut ch, 0.0);
        let before = ch.players.open_view(client(7)).unwrap().0.pos;
        // Ann holds forward for a second and asks for her mount.
        const FORWARD: [u8; OPEN_INPUT] = [0, 127, 16, 0, 0, 0, 0, 0, 0, 127];
        ch.inputs(7, (1..=60).map(|s| (s, FORWARD)));
        assert!(ch.command(7, 61, Command::Mount));
        for tick in 0..20 {
            ch.players.inputs_per_tick = 3.0;
            ch.players.step_in(&mut ch.actors, tick, &mut ch.open);
        }
        let p = ch.players.open_view(client(7)).unwrap().0;
        assert!((p.pos.x - before.x).hypot(p.pos.z - before.z) < 1e-6, "still in her seat");
        assert_eq!(p.mode, Mode::Normal);
    }

    /// Plays Bea's and Ann's turns from the browser's side until Ann (seat 1) wins: Ann works on
    /// a row, Bea plays well away from it. Returns the moves made.
    fn play_until_ann_wins(ch: &mut Game, table: u64) -> usize {
        let b = &setup(beacons()).board;
        // Ann's row: the four hexes from (-3, 0) to (0, 0) along the middle row... the Old Beacon
        // takes a pair, so a row on the left half of the middle row.
        let row: Vec<usize> = (-3..=0).map(|q| b.at(q, 0).unwrap()).collect();
        let mut moves = 0;
        loop {
            let t = ch.tables.tables.iter().find(|t| t.id == table).unwrap();
            if t.over.is_some() {
                return moves;
            }
            moves += 1;
            assert!(moves < 400, "the game never ended");
            let seat = t.rules.to_move().unwrap();
            let id = t.seats[seat].id;
            let v = t.view(seat, 0.0);
            // Every way to light a hex, as their board view finds them: what each card, and each
            // pair of cards, lights.
            let n = v["state"]["hand"].as_array().unwrap().len();
            let lights = |cards: Vec<usize>| json!({ "hexes": offered(&v, json!(cards))["hexes"], "cards": cards });
            let pairs = (0..n).flat_map(|a| (a + 1..n).map(move |b| vec![a, b]));
            let legal: Vec<Value> = (0..n).map(|a| vec![a]).chain(pairs).map(lights).collect();
            let v = &v["state"];
            let draws = v["draws"].as_u64().unwrap();
            let m = if draws > 0 {
                // Ann takes a Harbour card that's good for her row, if there is one.
                let want: Vec<u64> = row.iter().filter(|&&h| v["lit"][h] == 0).filter_map(|&h| setup(beacons()).good_at(h).map(u64::from)).collect();
                let pick = v["harbour"].as_array().unwrap().iter().position(|g| seat == 1 && g.as_u64().is_some_and(|g| want.contains(&g)));
                match pick {
                    Some(i) => json!({ "k": "draw", "from": "harbour", "i": i }),
                    None => json!({ "k": "draw", "from": "deck" }),
                }
            } else if seat == 1 {
                let on_row = legal.iter().find_map(|l| {
                    l["hexes"].as_array().unwrap().iter().find(|h| row.contains(&(h.as_u64().unwrap() as usize))).map(|h| (l["cards"].clone(), h.clone()))
                });
                match on_row {
                    Some((cards, hex)) => json!({ "k": "light", "cards": cards, "hex": hex }),
                    None => json!({ "k": "swap", "card": 0 }),
                }
            } else {
                let away = legal.iter().find_map(|l| {
                    l["hexes"].as_array().unwrap().iter().find(|h| b.cells[h.as_u64().unwrap() as usize].1 >= 2).map(|h| (l["cards"].clone(), h.clone()))
                });
                match away {
                    Some((cards, hex)) => json!({ "k": "light", "cards": cards, "hex": hex }),
                    None => json!({ "k": "swap", "card": 0 }),
                }
            };
            ch.table_move(id, table, &m).unwrap();
        }
    }

    #[test]
    fn the_winner_takes_the_pot_and_both_lives_are_written_together() {
        let mut ch = ann_and_bea();
        let table = sit_down(&mut ch, 50.0);
        assert!(ch.table_move(7, table, &json!({ "k": "swap", "card": 0 })).is_err(), "Bea moves first");
        play_until_ann_wins(&mut ch, table);
        let t = &ch.tables.tables[0];
        assert_eq!(t.over.map(|o| (o.winner, o.why)), Some((Some(1), Why::Rules)));
        assert_eq!((coins(&ch, 7), coins(&ch, 8)), (250.0, 150.0), "Ann takes the pot of 100");
        assert_eq!((staked(&ch, 7), staked(&ch, 8)), (None, None));
        assert!(toasts(&mut ch, 7).contains(&"You win at Beacons! The pot of 1s 0c is yours.".to_string()));
        assert!(toasts(&mut ch, 8).contains(&"Ann wins at Beacons and takes the pot of 1s 0c.".to_string()));
        // One batch, both lives, as they are now.
        let batch = take_joint(&mut ch);
        assert_eq!(batch.len(), 1);
        let ids: Vec<i64> = batch[0].iter().map(|s| s.character).collect();
        assert_eq!(ids, [8, 7]);
        assert_eq!(batch[0][1].life["state"]["coins"], 250.0);
        assert!(batch[0][1].life["state"].get("staked").is_none());
        // The result goes to both; the table stays a moment, then goes and they're free.
        ch.step_tables();
        let v = last_view(&mut ch, 7).unwrap();
        assert_eq!(v["over"]["winner"], 1);
        assert!(ch.seated(7));
        ch.skew += content().table.clear_seconds + 0.1;
        ch.step_tables();
        assert!(!ch.seated(7) && !ch.seated(8));
        assert!(heard(&mut ch, 7).iter().any(|m| m["t"] == "table" && m["table"].is_null()));
        // Money is only ever moved.
        assert_eq!(coins(&ch, 7) + coins(&ch, 8), 400.0);
    }

    #[test]
    fn a_pot_won_goes_through_the_ledger_with_both_lives() {
        let mut ch = ann_and_bea();
        let table = sit_down(&mut ch, 50.0);
        play_until_ann_wins(&mut ch, table);
        // One transfer, from Bea to Ann, written with both lives as they are now, once by its key.
        let sent: Vec<ToStore> = std::mem::take(&mut ch.store).into_iter().filter(|m| matches!(m, ToStore::Transfer { .. })).collect();
        let [ToStore::Transfer { transfer, writes }] = &sent[..] else { panic!("one transfer: {sent:?}") };
        assert_eq!(transfer.kind, "pot");
        assert!(transfer.key.starts_with("pot:channel:emberholm:1:1:"), "{}", transfer.key);
        assert_eq!(transfer.sides, [(7, "character:8".to_string(), 50.0), (8, "character:7".to_string(), -50.0)]);
        assert_eq!(writes.iter().map(|w| w.character).collect::<Vec<_>>(), [8, 7]);
        assert_eq!(writes[1].life["state"]["coins"], 250.0);
    }

    #[test]
    fn conceding_hands_the_pot_over_at_once() {
        let mut ch = ann_and_bea();
        let table = sit_down(&mut ch, 100.0);
        assert!(ch.concede(9, table).is_err());
        ch.concede(8, table).unwrap();
        assert_eq!((coins(&ch, 7), coins(&ch, 8)), (300.0, 100.0));
        assert_eq!(ch.tables.tables[0].over.map(|o| o.why), Some(Why::Conceded));
        // Twice changes nothing.
        ch.concede(8, table).unwrap();
        ch.concede(7, table).unwrap();
        assert_eq!((coins(&ch, 7), coins(&ch, 8)), (300.0, 100.0));
        assert_eq!(take_joint(&mut ch).len(), 1, "paid out once");
    }

    #[test]
    fn three_turns_run_out_in_a_row_and_that_player_forfeits() {
        let mut ch = ann_and_bea();
        let table = sit_down(&mut ch, 10.0);
        let turn = beacons().turn_seconds;
        // Bea (first) lets her clock run out three times; Ann plays each time it's her turn.
        for round in 0..3 {
            ch.skew += turn + 0.1;
            ch.step_tables();
            let t = &ch.tables.tables[0];
            if round < 2 {
                assert_eq!(t.over, None);
                assert_eq!(t.seats[0].timeouts, round + 1);
                assert_eq!(t.rules.to_move(), Some(1), "the server played Bea's turn");
                ch.table_move(7, table, &json!({ "k": "swap", "card": 0 })).unwrap();
                ch.table_move(7, table, &json!({ "k": "draw", "from": "deck" })).unwrap();
            }
        }
        assert_eq!(ch.tables.tables[0].over.map(|o| (o.winner, o.why)), Some((Some(1), Why::Timeouts)));
        assert_eq!((coins(&ch, 7), coins(&ch, 8)), (210.0, 190.0));
    }

    #[test]
    fn a_player_who_leaves_and_does_not_come_back_forfeits_and_their_saved_life_is_paid() {
        let mut ch = ann_and_bea();
        sit_down(&mut ch, 50.0);
        // Bea's connection ends: her life is kept as she left it, stake and all.
        let left = ch.leave(conn(8, 2)).unwrap();
        assert_eq!(left.life["state"]["staked"], 50.0);
        assert!(ch.seated(8), "her seat is kept for her");
        let away = content().table.away_seconds;
        ch.skew += 1.0;
        ch.step_tables();
        ch.skew += away;
        ch.step_tables();
        let t = &ch.tables.tables[0];
        assert_eq!(t.over.map(|o| (o.winner, o.why)), Some((Some(1), Why::Away)));
        assert_eq!(coins(&ch, 7), 250.0);
        // Her life, as it is in the channel now, is written with Ann's: no stake left in it to
        // come back when she next loads it.
        let batch = take_joint(&mut ch).pop().unwrap();
        let bea = batch.iter().find(|s| s.character == 8).unwrap();
        assert_eq!((bea.epoch, bea.tell), (Epoch(1), None), "under the grant she played under; nobody to tell");
        assert_eq!(bea.life["state"]["coins"], 150.0);
        assert!(bea.life["state"].get("staked").is_none());
        // And if the server stops before that's written, it's saved then.
        assert!(ch.lives_now().iter().any(|s| s.character == 8 && s.life["state"]["coins"] == 150.0));
    }

    #[test]
    fn back_in_time_you_play_on() {
        let mut ch = ann_and_bea();
        let table = sit_down(&mut ch, 50.0);
        ch.step_tables();
        heard(&mut ch, 8);
        ch.leave(conn(8, 2));
        ch.skew += 10.0;
        ch.step_tables();
        assert!(ch.tables.tables[0].seats[1 - 1].away.is_some());
        heard(&mut ch, 8);
        ch.join(arrival(8, 3, "Bea", true, None));
        ch.step_tables();
        assert_eq!(ch.tables.tables[0].seats[0].away, None);
        let v = last_view(&mut ch, 8).expect("her game comes back to her");
        assert_eq!(v["id"], table);
        assert_eq!(staked(&ch, 8), Some(50.0), "the stake is still on the table");
        ch.table_move(8, table, &json!({ "k": "swap", "card": 1 })).unwrap();
    }

    #[test]
    fn a_game_called_off_returns_each_stake() {
        let mut ch = ann_and_bea();
        sit_down(&mut ch, 250.0 - 150.0);
        assert_eq!((coins(&ch, 7), coins(&ch, 8)), (100.0, 100.0));
        // The server is stopping: what it saves has the stakes back in the purses.
        let saved = ch.lives_now();
        for s in &saved {
            assert_eq!(s.life["state"]["coins"], 200.0, "character {}", s.character);
            assert!(s.life["state"].get("staked").is_none());
        }
        assert_eq!((coins(&ch, 7), coins(&ch, 8)), (200.0, 200.0));
        assert_eq!(ch.tables.tables[0].over.map(|o| (o.winner, o.why)), Some((None, Why::Aborted)));
    }

    #[test]
    fn a_life_saved_mid_game_comes_back_with_its_stake_returned() {
        // The server fell over mid-game: what was last written has the stake out of the purse
        // and on the table. Loaded again, with no game holding it, it's back in the purse.
        let mut ch = ann_and_bea();
        sit_down(&mut ch, 50.0);
        let mid = {
            let (p, life) = ch.players.open_mut(client(7)).unwrap();
            life_save(p, life.unwrap(), &mut ch.open, 7)
        };
        assert_eq!((mid["state"]["coins"].as_f64(), mid["state"]["staked"].as_f64()), (Some(150.0), Some(50.0)));
        let fresh = Game::test();
        let mut world = fresh.open;
        let zone = world.zone;
        let mut life = Life::new(zone, None, None);
        let mut p = Player::new(Spawn { x: zone.recipe.spawn.x, z: zone.recipe.spawn.z, facing: 0.0 }, 0, Build::default());
        load_life(&mut life, &mut p, &mut world, 7, &mid, 0, 0).unwrap();
        assert_eq!((life.state.coins, life.state.staked), (200.0, None));
    }

    #[test]
    fn starting_your_life_over_mid_game_calls_the_game_off_for_the_other_player() {
        let mut ch = ann_and_bea();
        sit_down(&mut ch, 50.0);
        ch.reset(7).unwrap();
        assert_eq!(coins(&ch, 8), 200.0, "Bea's stake comes back");
        assert!(ch.tables.tables.is_empty(), "the table goes with Ann's old life");
        assert!(!ch.seated(7) && !ch.seated(8));
    }

    #[test]
    fn a_table_needs_dry_level_ground() {
        let mut ch = ann_and_bea();
        // Out at sea, both treading water... they'd be swimming; stood on the sea floor by a test,
        // there's no room for a table.
        let hf = ch.open.terrain();
        let (mut sx, mut sz) = (0.0, 0.0);
        'find: for i in 0..400 {
            for j in 0..400 {
                let (x, z) = (-600.0 + i as f64 * 3.0, -600.0 + j as f64 * 3.0);
                if hf.inside(x, z, 10.0) && hf.height(x, z) < hf.water - 1.0 && hf.height(x + 2.0, z) < hf.water - 1.0 && hf.height(x - 2.0, z) < hf.water - 1.0
                {
                    (sx, sz) = (x, z);
                    break 'find;
                }
            }
        }
        for (id, dx) in [(7, -1.0), (8, 1.0)] {
            let p = ch.players.open_mut(client(id)).unwrap().0;
            p.pos.x = sx + dx;
            p.pos.z = sz;
            p.pos.y = hf.height(sx + dx, sz);
        }
        ch.challenge(7, 8, beacons().index, 10.0, None).unwrap();
        assert!(ch.answer(8, 7, true).unwrap_err().starts_with("There's no room for a table here"));
        assert_eq!((coins(&ch, 7), coins(&ch, 8)), (200.0, 200.0));
        assert_eq!(ch.tables.challenges.len(), 1, "still open, if they move somewhere better");
    }

    #[test]
    fn a_development_server_gives_a_test_the_turn_it_asks_for_and_nobody_else() {
        let mut ch = ann_and_bea();
        let turn = beacons().turn_seconds;
        ch.challenge_timed(7, 8, beacons().index, 0.0, None, Some(600.0)).unwrap();
        ch.answer(8, 7, true).unwrap();
        let t = ch.tables.tables.last().unwrap();
        assert_eq!(t.turn_seconds, 600.0);
        assert_eq!(t.time_left(t.turn_began + turn + 1.0), 600.0 - turn - 1.0, "well past the game's own clock, still on");
        // Off a development server it's the game's clock, whatever the challenge asks.
        let mut ch = ann_and_bea();
        ch.members.get_mut(&7).unwrap().dev = false;
        ch.challenge_timed(7, 8, beacons().index, 0.0, None, Some(600.0)).unwrap();
        ch.answer(8, 7, true).unwrap();
        assert_eq!(ch.tables.tables.last().unwrap().turn_seconds, turn);
    }
}
