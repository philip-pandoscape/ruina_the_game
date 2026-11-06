//! Emberholm as the server plays it: one game per channel, 20 ticks a second. Each player's
//! browser sends what they press (about 60 inputs a second) and what they ask their island to do
//! (commands); here those run through the island's rules (crates/engine/src/open, crates/engine/src/life) and
//! the players' combat (crates/server/src/combat.rs), the channel's slimes live and fight,
//! and every browser hears back where it really is, what its island now holds, and what everyone
//! else in the channel is doing. Nothing a browser says about its own state is believed: it can
//! only press keys and ask.
//!
//! The browser predicts its own player with the TypeScript twin of these rules and corrects itself
//! to what arrives here (src/net/worldLink.ts, src/net/netPlayer.ts).

use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::actors::{Actors, LEAN_DAMPING, LEAN_SPRING, StepOut};
use crate::bots::Brain;
use crate::combat::{OPEN_INPUT, Players, open_actions_from};
use crate::life::content::clock;
use crate::life::progress::skill_budget;
use crate::life::state::LifeState;
use crate::life::{Command, Life, farming, housing, trade, vehicles};
use crate::minigames::Minigames;
use crate::open::colliders::ground_at;
use crate::open::dungeon::{DungeonDef, Spot};
use crate::open::zone::{DungeonDoor, Zone, emberholm};
use crate::open::{OpenWorld, Sim};
use crate::play::channels::{Channel, estate_of};
use crate::play::socket::parse_build;
use crate::player::{Actions, Build, Mode, Player};
use crate::skills::{valid_build, valid_movement};
use crate::world::{Spawn, World};

/// Bots: players without a socket, their inputs decided by their brains.
mod bots;
/// The channels' residents: everyone's estates and who holds which plot.
pub mod channels;
/// Parties: who plays with whom.
pub mod parties;
/// A player's connection: sign-in, the welcome, inputs and commands in, ticks out.
pub mod socket;
/// Every channel and every party's copy of a dungeon, and moving between them.
pub mod spaces;
/// Mini-games here: challenges, tables and the money on them.
mod tables;

pub const TICK_HZ: u32 = 20;
/// Islands are written to Postgres this often while their owner plays (and when they leave).
const SAVE_EVERY: Duration = Duration::from_secs(5);
/// The whole island goes to its owner at least this often, even when nothing obvious changed
/// (crops grow, labor refills, quests tick along).
const LIFE_EVERY: Duration = Duration::from_secs(2);
/// Monsters and other actors further than this aren't sent.
const ACTOR_RADIUS: f64 = 70.0;
const ACTOR_CAP: usize = 48;
/// How long someone who left is remembered as they were (see ChannelGame::lingering).
const LINGER: Duration = Duration::from_secs(60);
/// How close to someone's vehicle you have to be to climb in (the hull, as the island's prompts
/// measure it, with a little slack for where you were drawn).
const CLIMB_IN: f64 = 2.6;

/// An island to write to Postgres, and whose browser to tell once it's written.
pub struct Save {
    pub character: i64,
    pub session: i64,
    pub island: Value,
    pub out: Option<mpsc::Sender<String>>,
}

/// Someone playing in the channel right now.
pub struct Member {
    pub session: i64,
    pub name: String,
    /// Messages for their browser (dropped if they can't keep up).
    pub out: mpsc::Sender<String>,
    /// Whether this server lets them use the developer panel's commands.
    pub dev: bool,
    /// Ticks left on which their island goes out whether or not it looks changed (a command was
    /// just given: it runs on one of the next few ticks).
    life_due: u8,
    last_life: Instant,
    last_rev: u64,
    last_save: Instant,
    /// Their island's revision when their estate was last worked out.
    estate_rev: u64,
    /// Their saved island couldn't be read: it's left as it is in the database, and nothing from
    /// this visit is written over it.
    pub keep_saved: bool,
}

/// What a character brings into a channel.
pub struct Arrival {
    pub character: i64,
    pub session: i64,
    pub name: String,
    pub out: mpsc::Sender<String>,
    pub dev: bool,
    /// The island as saved and where they stood, if they have one (None for a newcomer).
    pub island: Option<Value>,
    /// When it was saved and the time now (ms since the epoch), for the time they were away.
    pub saved_at: Option<i64>,
    pub now: i64,
    /// Their build as kept (src/app/build.ts's shape), if they have one. It is checked against the
    /// skill points their island has earned once the island is loaded.
    pub build: Option<Value>,
}

/// Whose copy of a dungeon a game is: a party's, someone's on their own, or (a developer zone
/// everyone shares, the battlefield) everyone's allowed in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Owner {
    Party(u64),
    Solo(i64),
    Everyone,
}

/// What a game plays: a channel of Emberholm, or someone's copy of a dungeon (crate::play::spaces).
pub enum Space {
    Channel,
    Copy(CopyOf),
}

pub struct CopyOf {
    pub def: &'static DungeonDef,
    /// Its door in the open world: where you come out.
    pub door: &'static DungeonDoor,
    pub owner: Owner,
    /// Since when nobody has been in it (crate::play::spaces closes it a while after).
    pub empty_since: Option<Instant>,
    /// Whoever is in it but no longer in the party it belongs to, and when they're put out.
    pub expel: HashMap<i64, Instant>,
}

/// Someone on their way from one game to another (into a dungeon, or back out): their connection,
/// their player and their island, as they were.
pub struct Moving {
    member: Member,
    player: Player,
    life: Box<Life>,
}

/// Someone who left in the last minute, with their island as they left it.
struct Lingering {
    at: Instant,
    /// The connection that played them last, which may still write their island.
    session: i64,
    player: Player,
    life: Box<Life>,
    /// A game changed their island since they left (it was paid out): written when the server stops.
    dirty: bool,
}

pub struct ChannelGame {
    pub id: i32,
    /// A channel, or a copy of a dungeon.
    pub space: Space,
    /// Who left in the last minute, with their island as they left it: newer than any save that
    /// might still be on its way to the database, so a quick reload picks up exactly there.
    lingering: HashMap<i64, Lingering>,
    /// Everyone's estates and who holds which plot, online or not.
    pub estates: Channel,
    pub members: HashMap<i64, Member>,
    world: World,
    pub open: OpenWorld,
    players: Players,
    actors: Actors,
    tick: u64,
    last_tick: Instant,
    /// Challenges and the tables they became (crates/server/src/play/tables.rs).
    pub tables: Minigames,
    /// When the channel began: games' clocks run from here.
    started: Instant,
    /// Tests: seconds added to the games' clock.
    pub(crate) skew: f64,
    /// Islands to write together, in one transaction (a pot changing hands), when there's no
    /// writer to hand them to straight away (tests).
    joint: Vec<Vec<Save>>,
    /// The server's queue of islands to write (socket.rs spawn_world), if it has one.
    pub saver: Option<mpsc::UnboundedSender<Vec<Save>>>,
    /// Bots playing here (bots.rs), and how many have ever joined (their ids and names count on).
    bots: Vec<bots::BotSlot>,
    bot_count: u32,
    /// How long a tick takes to run (ms, smoothed), for the admins' stats.
    step_ms: f64,
}

/// Ticks between the stats an admin is sent (once a second).
const STATS_EVERY: u64 = TICK_HZ as u64;

/// A player's id on the wire (Players numbers its clients with u32).
fn client(character: i64) -> u32 {
    character as u32
}

impl ChannelGame {
    pub fn new(id: i32) -> Self {
        let zone: &'static Zone = emberholm();
        let r = &zone.recipe;
        let spawn = Spawn { x: r.spawn.x, z: r.spawn.z, facing: r.spawn.facing };
        let world = World { radius: zone.radius, obstacles: Vec::new(), team_spawns: [spawn, spawn] };
        let mut players = Players::new(1000.0 / TICK_HZ as f64);
        players.ground = Some(&zone.terrain);
        // The island's monsters, where src/sim/zone/world.ts puts them, and the training dummy.
        let mut actors = Actors::new();
        let s = r.slimes;
        for i in 0..s.count {
            let a = (i as f64 / s.count as f64) * std::f64::consts::PI * 2.0 + 0.4;
            let rr = s.r * (0.45 + 0.55 * ((i * 7) % 5) as f64 / 4.0);
            let seed = (r.seed ^ 0x51e0).wrapping_add((i as u32).wrapping_mul(0x9e37_79b1));
            actors.spawn("slime", s.x + a.sin() * rr, s.z + a.cos() * rr, seed);
        }
        actors.spawn("dummy", r.dummy.x, r.dummy.z, 1);
        ChannelGame {
            id,
            space: Space::Channel,
            lingering: HashMap::new(),
            estates: Channel::default(),
            members: HashMap::new(),
            world,
            open: OpenWorld::new(zone),
            players,
            actors,
            tick: 0,
            last_tick: Instant::now(),
            tables: Minigames::default(),
            started: Instant::now(),
            skew: 0.0,
            joint: Vec::new(),
            saver: None,
            bots: Vec::new(),
            bot_count: 0,
            step_ms: 0.0,
        }
    }

    /// A copy of a dungeon, for `owner`: its floors and walls solid, nobody in it yet.
    pub fn copy(id: i32, def: &'static DungeonDef, door: &'static DungeonDoor, owner: Owner) -> Self {
        let mut ch = ChannelGame::new(id);
        ch.actors = Actors::new();
        // What its file says lives in it (a developer zone's training dummy, slimes, a war-band).
        for (i, s) in def.spawns.iter().enumerate() {
            let band = if s.band { i as u32 + 1 } else { 0 };
            for (x, z, facing, seed) in s.points(0x20ae ^ (i as u32).wrapping_mul(0x9e37_79b1)) {
                let (x, z) = (def.origin.x + x, def.origin.z + z);
                if band > 0 {
                    ch.actors.spawn_in_band(&s.kind, x, z, facing, seed, band);
                } else {
                    ch.actors.spawn(&s.kind, x, z, seed);
                }
            }
        }
        ch.open.make_dungeon(def);
        // Heights in a fight are measured from its floor, far over the island.
        ch.players.floor = Some(def);
        ch.estates.loaded = true;
        ch.space = Space::Copy(CopyOf { def, door, owner, empty_since: Some(Instant::now()), expel: HashMap::new() });
        ch
    }

    pub fn copy_of(&self) -> Option<&CopyOf> {
        match &self.space {
            Space::Copy(c) => Some(c),
            Space::Channel => None,
        }
    }

    pub fn copy_mut(&mut self) -> Option<&mut CopyOf> {
        match &mut self.space {
            Space::Copy(c) => Some(c),
            Space::Channel => None,
        }
    }

    /// Players in it, and anyone who left a moment ago and may come straight back.
    pub fn headcount(&self) -> usize {
        self.members.len() + self.lingering.values().filter(|l| l.at.elapsed() < LINGER).count()
    }

    /// Where someone in a copy comes in.
    pub fn arrival(&self) -> Option<Spot> {
        self.copy_of().map(|c| self.open.respawn.unwrap_or_else(|| c.def.arrival()))
    }

    /// In a copy, an island is saved as standing outside its door: a copy is gone after a restart,
    /// and its owner comes back to the open world there.
    fn outside(&self) -> Option<Spot> {
        let c = self.copy_of()?;
        let o = &c.door.outside;
        let hf = self.open.terrain();
        Some(Spot { x: o.x, y: ground_at(hf, &self.open.index, o.x, o.z, c.door.portal.y + 1.2, 1.2), z: o.z, facing: o.facing })
    }

    /// Someone here as they are: where they stand, how, and whether they're free to go somewhere
    /// else (not riding, carrying a pack, down or at a mini-game's table).
    pub fn whereabouts(&self, character: i64) -> Option<(f64, f64, f64, bool)> {
        let (p, _, _) = self.players.open_view(client(character))?;
        let free = p.mode != Mode::Ride && p.pack == 0 && p.down_frame < 0 && !self.tables.seated(character);
        Some((p.pos.x, p.pos.y, p.pos.z, free))
    }

    /// Forgets someone who left a moment ago (they've come back somewhere else).
    pub fn forget_lingering(&mut self, character: i64) {
        self.lingering.remove(&character);
    }

    /// Tests: stands someone at (x, y, z), just there.
    #[cfg(test)]
    pub fn place(&mut self, character: i64, x: f64, y: f64, z: f64) {
        if let Some((p, _)) = self.players.open_mut(client(character)) {
            p.pos.x = x;
            p.pos.y = y;
            p.pos.z = z;
            p.grounded = true;
        }
    }

    /// A message for someone's browser.
    pub fn send_to(&self, character: i64, text: &str) -> bool {
        self.members.get(&character).is_some_and(|m| m.out.try_send(text.to_string()).is_ok())
    }

    /// Someone leaves this game for another, taken out whole with their connection, as they are.
    pub fn take(&mut self, character: i64) -> Option<Moving> {
        if !self.members.contains_key(&character) || self.players.open_view(client(character)).is_none() {
            return None;
        }
        self.drop_off(character);
        self.left_tables(character);
        let member = self.members.remove(&character)?;
        let (player, life) = self.players.leave(client(character))?;
        let life = life?;
        self.send_all(&json!({ "t": "left", "id": character }).to_string(), None);
        let empty = self.members.is_empty();
        if let Some(c) = self.copy_mut() {
            c.expel.remove(&character);
            if empty {
                c.empty_since = Some(Instant::now());
            }
        }
        if empty {
            self.remove_bots();
        }
        Some(Moving { member, player, life })
    }

    /// Someone arrives from another game, standing at `at` (on whatever is there to stand on).
    pub fn put(&mut self, character: i64, m: Moving, at: Spot) {
        let Moving { mut member, mut player, life } = m;
        player.vel = Default::default();
        if self.copy_of().is_none() {
            // Sides are a developer zone's (spaces.rs take_side): on the island everyone is on one.
            player.team = 0;
            // So is trying any build (set_build): here it stays only if this island has earned it.
            if !valid_build(&player.skills, player.weapon, &player.abilities, skill_budget(&life.state)) || !valid_movement(&player.skills, &player.movement) {
                player.apply_build(Build::default());
            }
        }
        if matches!(player.mode, Mode::Glide | Mode::Swim) {
            player.mode = Mode::Normal;
        }
        player.pos.x = at.x;
        player.pos.z = at.z;
        player.facing = at.facing;
        let hf = self.open.terrain();
        player.pos.y = ground_at(hf, &self.open.index, at.x, at.z, at.y + 1.2, 1.2);
        player.grounded = true;
        if self.copy_of().is_none() {
            make_solid(&mut self.open, character, &life.state);
        }
        let now = Instant::now();
        member.life_due = 3;
        member.last_life = now - LIFE_EVERY;
        member.last_rev = u64::MAX;
        member.estate_rev = u64::MAX;
        self.lingering.remove(&character);
        self.players.join_open(client(character), character, player, life);
        self.members.insert(character, member);
        if let Some(c) = self.copy_mut() {
            // The first one into an empty copy brings its bots; after that, whatever an admin did
            // with them (sent them away, added more) stands while anyone is in it.
            let first = c.empty_since.take().is_some();
            if first {
                self.zone_bots_in();
            }
        } else {
            let held = self.estates.held_by_others(character);
            if let Some((_, Some(life))) = self.players.open_mut(client(character)) {
                life.plot_owners = held;
            }
            self.refresh_estate(character);
        }
    }

    /// Islands to be written together, each list in one transaction (a game's pot paid out).
    pub fn take_joint(&mut self) -> Vec<Vec<Save>> {
        std::mem::take(&mut self.joint)
    }

    /// A resident who isn't online: their houses and farms stand (and are solid) all the same.
    pub fn add_resident(&mut self, character: i64, name: &str, state: &Value) {
        if self.members.contains_key(&character) {
            return;
        }
        self.estates.set_estate(character, name, estate_of(state));
        if let Ok(s) = serde_json::from_value::<LifeState>(state.clone()) {
            make_solid(&mut self.open, character, &s);
        }
    }

    /// Someone arrives. If their character is already here (another window, or a quick
    /// reconnect) they take it over as it is, which is newer than any save. Returns the welcome's
    /// channel parts (everyone else's estates and the claims) and the build they play with.
    pub fn join(&mut self, a: Arrival) -> (Value, Value, Value) {
        let c = client(a.character);
        let mut keep_saved = false;
        self.lingering.retain(|_, l| l.at.elapsed() < LINGER);
        if self.players.open_view(c).is_some() {
            self.players.restart_inputs(c);
        } else if let Some(l) = self.lingering.remove(&a.character) {
            self.players.join_open(c, a.character, l.player, l.life);
        } else {
            let zone = self.open.zone;
            let mut life = Life::new(zone, None, None);
            let mut player = Player::new(Spawn { x: zone.recipe.spawn.x, z: zone.recipe.spawn.z, facing: zone.recipe.spawn.facing }, 0, Build::default());
            stand_on_ground(&mut player, &self.open);
            if let Some(island) = &a.island
                && let Err(e) = load_island(&mut life, &mut player, &mut self.open, a.character, island, a.saved_at.unwrap_or(a.now), a.now)
            {
                eprintln!("character {}: the saved island can't be read ({e}); it is kept as it is, and this visit isn't saved", a.character);
                life.toast("Your island couldn't be loaded. It's kept safe on the server, but nothing from this visit will be saved.", "bad");
                keep_saved = true;
            }
            // The build they kept, if the skill points their island has earned still cover it.
            if let Some(b) = a.build.as_ref().and_then(|v| parse_build(v, skill_budget(&life.state))) {
                player.apply_build(b);
            }
            life.after_reset(&mut player);
            if let Some(at) = self.arrival() {
                // Back in a copy they were in: where it's entered (the island was saved outside).
                player.pos.x = at.x;
                player.pos.y = at.y;
                player.pos.z = at.z;
                player.facing = at.facing;
                player.vel = Default::default();
                player.grounded = true;
            } else {
                make_solid(&mut self.open, a.character, &life.state);
            }
            self.players.join_open(c, a.character, player, Box::new(life));
        }
        let now = Instant::now();
        if let Some(c) = self.copy_mut() {
            c.empty_since = None;
        }
        self.members.insert(
            a.character,
            Member {
                session: a.session,
                name: a.name.clone(),
                out: a.out,
                dev: a.dev,
                life_due: 3,
                last_life: now - LIFE_EVERY,
                last_rev: u64::MAX,
                last_save: now,
                estate_rev: u64::MAX,
                keep_saved,
            },
        );
        self.refresh_estate(a.character);
        // A game or a challenge they were in the middle of comes back to their browser.
        self.joined_tables(a.character);
        // Whatever happened to the claims, this island knows whose plots are whose.
        let held = self.estates.held_by_others(a.character);
        let mut build = Value::Null;
        if let Some((p, life)) = self.players.open_mut(c) {
            build = build_json(&Build { skills: p.skills, weapon: p.weapon, abilities: p.abilities, movement: p.movement });
            if let Some(life) = life {
                life.plot_owners = held;
            }
        }
        (self.estates.estates_json(a.character), self.estates.claims_json(), build)
    }

    /// Someone's connection ended. Unless a newer window already took their seat, they're taken
    /// out, and their island comes back to be saved.
    pub fn leave(&mut self, character: i64, session: i64) -> Option<Value> {
        if !self.members.get(&character).is_some_and(|m| m.session == session) {
            return None;
        }
        // Riding along with someone, you step out beside their vehicle first: that's where you are.
        self.drop_off(character);
        let keep_saved = self.members.remove(&character).is_some_and(|m| m.keep_saved);
        // Challenges are off; a game they're playing waits a while for them (tables.rs).
        self.left_tables(character);
        let (player, life) = self.players.leave(client(character))?;
        let mut life = life?;
        let outside = self.outside();
        let island = outside_of(island_of(&player, &mut life, &mut self.open, character), outside);
        self.send_all(&json!({ "t": "left", "id": character }).to_string(), None);
        let empty = self.members.is_empty();
        if let Some(c) = self.copy_mut() {
            c.expel.remove(&character);
            if empty {
                c.empty_since = Some(Instant::now());
            }
        }
        // Bots stay only while someone is here to see them.
        if empty {
            self.remove_bots();
        }
        if keep_saved {
            return None;
        }
        self.lingering.insert(character, Lingering { at: Instant::now(), session, player, life, dirty: false });
        Some(island)
    }

    /// A character who lived here was deleted (they can't be playing): their houses, farms and
    /// ships come down for everyone, and their plots are free for the next one.
    pub fn remove_resident(&mut self, character: i64) {
        if self.members.contains_key(&character) {
            return;
        }
        self.lingering.remove(&character);
        let Some(name) = self.estates.estates.get(&character).map(|e| e.name.clone()) else { return };
        // Everyone else's browser takes the buildings down (an empty estate), then forgets them.
        let empty = json!({ "t": "estate", "id": character, "name": name, "estate": estate_of(&json!({})) });
        self.send_all(&empty.to_string(), None);
        self.estates.remove(character);
        self.send_all(&self.estates.claims_message(), None);
        let held: HashMap<i64, BTreeMap<String, String>> = self.members.keys().map(|id| (*id, self.estates.held_by_others(*id))).collect();
        for (owner, life) in self.players.each_life_mut() {
            if let Some(h) = held.get(&owner) {
                life.plot_owners = h.clone();
            }
        }
        // Their walls and posts stop being solid.
        self.rebuild_world();
    }

    /// The developer panel's teleport: off whatever you were riding, onto the ground there (in a
    /// dungeon's copy, its floor).
    fn teleport(&mut self, character: i64, x: f64, z: f64, facing: Option<f64>) {
        self.drop_off(character);
        let floor = self.arrival().map(|a| a.y);
        let Some((p, life)) = self.players.open_mut(client(character)) else { return };
        let hf = self.open.terrain();
        if !x.is_finite() || !z.is_finite() || !hf.inside(x, z, 0.0) {
            return;
        }
        if p.mode == Mode::Ride
            && let Some(life) = life
        {
            let mut sim = Sim { player: p, world: &mut self.open, owner: character };
            vehicles::dismount(life, &mut sim);
        }
        let y = ground_at(hf, &self.open.index, x, z, floor.unwrap_or_else(|| hf.height(x, z)) + 1.2, 1.2);
        p.pos.x = x;
        p.pos.y = y;
        p.pos.z = z;
        p.vel = Default::default();
        if let Some(f) = facing.filter(|f| f.is_finite()) {
            p.facing = f;
        }
        if p.mode == Mode::Glide || p.mode == Mode::Swim {
            p.mode = Mode::Normal;
        }
        p.grounded = true;
    }

    /// Everyone's island as it is this moment, to save (the server is stopping). Games can't go
    /// on without the server: they're called off first, each stake back to its player.
    pub fn islands_now(&mut self) -> Vec<Save> {
        self.abort_tables();
        let ids: Vec<(i64, i64, bool)> = self.members.iter().map(|(id, m)| (*id, m.session, m.keep_saved)).collect();
        let outside = self.outside();
        let mut out = Vec::new();
        for (id, session, keep_saved) in ids {
            if keep_saved {
                continue;
            }
            if let Some((p, Some(life))) = self.players.open_mut(client(id)) {
                let island = outside_of(island_of(p, life, &mut self.open, id), outside);
                out.push(Save { character: id, session, island, out: None });
            }
        }
        // Someone away whose game was paid out since they left.
        for (id, l) in &mut self.lingering {
            if l.dirty {
                let island = island_of(&l.player, &mut l.life, &mut self.open, *id);
                out.push(Save { character: *id, session: l.session, island, out: None });
            }
        }
        out
    }

    pub fn has_players(&self) -> bool {
        !self.members.is_empty()
    }

    /// Inputs from a browser: (sequence number, the tick × 16 it drew everyone else at, the
    /// OPEN_INPUT bytes it packed). At a table you stay in your seat: what you press counts as nothing.
    pub fn inputs_seen(&mut self, character: i64, list: impl Iterator<Item = (u32, u32, [u8; OPEN_INPUT])>) {
        let seated = self.tables.seated(character);
        let actions = |raw| if seated { Actions::default() } else { open_actions_from(raw) };
        self.players.queue_actions(client(character), list.map(|(seq, view, raw)| (seq, f64::from(view) / 16.0, actions(raw))));
    }

    /// Inputs that see everyone where they are now (the tests').
    pub fn inputs(&mut self, character: i64, list: impl Iterator<Item = (u32, [u8; OPEN_INPUT])>) {
        self.inputs_seen(character, list.map(|(seq, raw)| (seq, u32::MAX, raw)));
    }

    /// A command for someone's island, given on input `seq`. The developer panel's only count where
    /// this server offers the panel.
    pub fn command(&mut self, character: i64, seq: u32, c: Command) -> bool {
        let Some(m) = self.members.get_mut(&character) else { return false };
        if c.is_dev() && !m.dev {
            return false;
        }
        m.life_due = 3;
        // At a table the game is all you do (the developer panel's grants and time aside).
        if self.tables.seated(character) && !matches!(c, Command::Grant { .. } | Command::Warp { .. }) {
            return true;
        }
        if let Command::Teleport { x, z, facing } = c {
            self.teleport(character, x, z, facing);
            return true;
        }
        if let Command::Bots { n, brain, team } = c {
            if n == 0 {
                self.remove_bots();
            } else if let Some((p, _, _)) = self.players.open_view(client(character)) {
                let (x, z, team) = (p.pos.x, p.pos.z, team.unwrap_or(p.team));
                let brain = brain.as_deref().and_then(Brain::named).unwrap_or(Brain::Skirmisher);
                self.spawn_bots(n, brain, x, z, team);
            }
            return true;
        }
        if let Command::Ride { host, vehicle } = c {
            self.ride_along(character, host, vehicle);
            return true;
        }
        // Riding along with someone, the key that gets you out of your own vehicle gets you out of
        // theirs: their vehicle isn't on your island, so the channel does it.
        if matches!(c, Command::Interact | Command::Exit) && self.passenger(character).is_some() {
            self.drop_off(character);
            return true;
        }
        self.players.queue_command(client(character), seq, c);
        true
    }

    /// Who a passenger rides with, which of their vehicles and which seat, if they ride along.
    fn passenger(&self, character: i64) -> Option<(i64, i64, usize)> {
        let (p, _, _) = self.players.open_view(client(character))?;
        (p.mode == Mode::Ride && p.host != 0).then_some((p.host, p.vehicle, p.seat as usize))
    }

    /// A vehicle of `host`'s as it is now, if they're here and it's out.
    fn vehicle_of(&self, host: i64, vehicle: i64) -> Option<crate::life::state::Vehicle> {
        let (_, _, life) = self.players.open_view(client(host))?;
        let life = life?;
        vehicles::vehicle_index(life, vehicle).map(|i| life.state.vehicles[i].clone())
    }

    /// Climbs into the free seat of `host`'s vehicle nearest you (the driver's is its owner's).
    /// You need to be beside it, on your feet or swimming, with your hands free. True if you're in.
    pub fn ride_along(&mut self, character: i64, host: i64, vehicle: i64) -> bool {
        if host == character || !self.members.contains_key(&host) {
            return false;
        }
        let Some(v) = self.vehicle_of(host, vehicle) else { return false };
        let def = crate::life::content::rideable(&v.def);
        let taken: Vec<usize> = self
            .players
            .each_open()
            .filter(|(_, _, p, _)| p.mode == Mode::Ride && p.host == host && p.vehicle == vehicle)
            .map(|(_, _, p, _)| p.seat as usize)
            .collect();
        let owner_name = self.members.get(&host).map(|m| m.name.clone()).unwrap_or_default();
        let Some((p, life)) = self.players.open_mut(client(character)) else { return false };
        let say = |life: Option<&mut Life>, text: String| {
            if let Some(l) = life {
                l.toast(text, "bad");
            }
        };
        if (p.mode != Mode::Normal && p.mode != Mode::Swim) || p.down_frame >= 0 || p.stun > 0 {
            return false;
        }
        if p.pack != 0 {
            say(life, format!("Put your pack down first - there's no room for it in {owner_name}'s {}", def.name.to_lowercase()));
            return false;
        }
        if vehicles::distance_to(&v, p.pos.x, p.pos.z) > CLIMB_IN {
            return false;
        }
        let near = |k: &usize| {
            let (x, _, z) = vehicles::anchor_world(&v, &def.seats[*k]);
            (x - p.pos.x).hypot(z - p.pos.z)
        };
        let Some(seat) = (1..def.seats.len()).filter(|k| !taken.contains(k)).min_by(|a, b| near(a).total_cmp(&near(b))) else {
            say(life, format!("There's no room left in {owner_name}'s {}", def.name.to_lowercase()));
            return false;
        };
        p.mode = Mode::Ride;
        p.vehicle = vehicle;
        p.host = host;
        p.seat = seat as u8;
        p.grounded = true;
        p.jumps_used = 0;
        p.sprinting = false;
        p.crouching = false;
        p.jump_buffer = 0;
        sit(p, &v, seat);
        true
    }

    /// A passenger steps out beside the vehicle they ride in (or, if it has gone, where they are).
    fn drop_off(&mut self, character: i64) {
        let Some((host, vehicle, _)) = self.passenger(character) else { return };
        let v = self.vehicle_of(host, vehicle);
        let Some((p, _)) = self.players.open_mut(client(character)) else { return };
        let sim = Sim { player: p, world: &mut self.open, owner: character };
        let (x, y, z, dry) = match &v {
            Some(v) => vehicles::exit_spot(&sim, v),
            None => {
                let hf = sim.terrain();
                let (x, z) = (sim.player.pos.x, sim.player.pos.z);
                let y = ground_at(hf, &sim.world.index, x, z, sim.player.pos.y.max(hf.water) + 0.5, 3.0);
                let dry = y > hf.water - crate::life::content::swim().depth + 0.2;
                (x, if dry { y } else { hf.water - crate::life::content::swim().float }, z, dry)
            }
        };
        let p = &mut *sim.player;
        p.mode = Mode::Normal;
        p.vehicle = 0;
        p.host = 0;
        p.seat = 0;
        p.pos.x = x;
        p.pos.y = y;
        p.pos.z = z;
        p.vel = Default::default();
        p.grounded = dry;
    }

    /// Everyone riding along sits where their seat has gone this tick, now their host has driven;
    /// whoever's vehicle (or host) has gone steps off where they are.
    fn seat_passengers(&mut self) {
        let riders: Vec<(i64, i64, i64, usize)> = self
            .players
            .each_open()
            .filter(|(_, _, p, _)| p.mode == Mode::Ride && p.host != 0)
            .map(|(_, who, p, _)| (who, p.host, p.vehicle, p.seat as usize))
            .collect();
        for (who, host, vehicle, seat) in riders {
            let v = self.vehicle_of(host, vehicle).filter(|v| seat < crate::life::content::rideable(&v.def).seats.len());
            match v {
                Some(v) => {
                    if let Some((p, _)) = self.players.open_mut(client(who)) {
                        sit(p, &v, seat);
                    }
                }
                None => self.drop_off(who),
            }
        }
    }

    /// Everyone's vehicles, solid to everyone but their owner, as they stand when the tick begins.
    fn gather_movers(&mut self) {
        let mut movers = std::mem::take(&mut self.open.movers);
        movers.clear();
        for (_, owner, _, life) in self.players.each_open() {
            if let Some(l) = life {
                for v in &l.state.vehicles {
                    movers.extend(vehicles::bodies(owner, v));
                }
            }
        }
        self.open.movers = movers;
    }

    /// A new build (skills and loadout) as the browser sent it: used if it is one, and the skill
    /// points this character has earned cover it. False if it isn't allowed.
    pub fn set_build(&mut self, character: i64, build: &Value) -> bool {
        // A developer zone is for trying weapons and skills: any build the tree allows.
        let trying = self.copy_of().is_some_and(|c| c.def.developer);
        let Some((p, life)) = self.players.open_mut(client(character)) else { return false };
        let budget = if trying { u32::MAX } else { life.map_or(crate::tuning::tuning().skills.start_points, |l| skill_budget(&l.state)) };
        let Some(b) = parse_build(build, budget) else { return false };
        p.apply_build(b);
        true
    }

    /// Starts someone's island over: a fresh one, standing at the spawn. What they had built goes.
    /// Returns the fresh island, to save.
    pub fn reset(&mut self, character: i64) -> Option<Value> {
        // A game they're playing is called off first: the other player's stake goes back to them.
        self.abort_table_of(character);
        let zone = self.open.zone;
        let (p, life) = self.players.open_mut(client(character))?;
        let life = life?;
        *life = Life::new(zone, None, None);
        // The quests that earned skill points went with the island: the build stays only if the
        // points a fresh island starts with still cover it.
        let mut build = Build { skills: p.skills, weapon: p.weapon, abilities: p.abilities, movement: p.movement };
        if !valid_build(&build.skills, build.weapon, &build.abilities, skill_budget(&life.state)) || !valid_movement(&build.skills, &build.movement) {
            build = Build::default();
        }
        *p = Player::new(Spawn { x: zone.recipe.spawn.x, z: zone.recipe.spawn.z, facing: zone.recipe.spawn.facing }, 0, build);
        stand_on_ground(p, &self.open);
        life.after_reset(p);
        let island = island_of_ref(p, life);
        // Their walls and farm posts go with it: the channel's colliders are built again.
        self.rebuild_world();
        if let Some(m) = self.members.get_mut(&character) {
            m.life_due = 3;
            m.estate_rev = u64::MAX;
        }
        self.players.restart_inputs(client(character));
        self.refresh_estate(character);
        Some(island)
    }

    /// Everything solid that residents have built, made again from scratch (after a reset).
    fn rebuild_world(&mut self) {
        self.open = OpenWorld::new(self.open.zone);
        let mut lists: Vec<(i64, LifeState)> = Vec::new();
        for (_, owner, _, life) in self.players.each_open() {
            if let Some(l) = life {
                lists.push((owner, l.state.clone()));
            }
        }
        for (id, e) in &self.estates.estates {
            if !self.members.contains_key(id)
                && let Ok(s) = serde_json::from_value::<LifeState>(e.estate.clone())
            {
                lists.push((*id, s));
            }
        }
        // By owner: the estates are kept in a HashMap, whose order differs from one run to the next,
        // and colliders added in another order are found in another order.
        lists.sort_by_key(|(owner, _)| *owner);
        for (owner, s) in lists {
            make_solid(&mut self.open, owner, &s);
        }
    }

    /// Works out a member's estate again if their island changed shape, and tells everyone (a copy
    /// of a dungeon has nobody's estate in it).
    fn refresh_estate(&mut self, character: i64) {
        if self.copy_of().is_some() {
            return;
        }
        let Some((_, _, Some(life))) = self.players.open_view(client(character)) else { return };
        let rev = life.revision;
        let Some(m) = self.members.get(&character) else { return };
        if m.estate_rev == rev {
            return;
        }
        let name = m.name.clone();
        let estate = estate_of(&serde_json::to_value(&life.state).unwrap_or(Value::Null));
        if let Some(m) = self.members.get_mut(&character) {
            m.estate_rev = rev;
        }
        if self.estates.set_estate(character, &name, estate) {
            if let Some(msg) = self.estates.estate_message(character) {
                self.send_all(&msg, Some(character));
            }
            self.send_all(&self.estates.claims_message(), None);
            // Who may claim which plot changed for everyone.
            let held: HashMap<i64, BTreeMap<String, String>> = self.members.keys().map(|id| (*id, self.estates.held_by_others(*id))).collect();
            for (owner, life) in self.players.each_life_mut() {
                if let Some(h) = held.get(&owner) {
                    life.plot_owners = h.clone();
                }
            }
        }
    }

    fn send_all(&self, text: &str, except: Option<i64>) {
        for (id, m) in &self.members {
            if Some(*id) != except {
                let _ = m.out.try_send(text.to_string());
            }
        }
    }

    /// One tick: everyone's inputs run, arrows fly, monsters move and slam, and every browser
    /// hears what happened. Islands due a save are added to `saves`.
    pub fn step(&mut self, saves: &mut Vec<Save>) {
        let now = Instant::now();
        let elapsed = (now - self.last_tick).as_secs_f64().min(1.0);
        self.last_tick = now;
        // Everyone's weather runs on the world's clock, so it's the same weather for all of them.
        let world = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64());
        self.play_tick(elapsed, world);
        self.send_tick(now, saves);
        let took = now.elapsed().as_secs_f64() * 1000.0;
        self.step_ms = if self.step_ms == 0.0 { took } else { self.step_ms * 0.9 + took * 0.1 };
    }

    /// A tick of the rules, `elapsed` seconds after the last, with the world's clock at `world`
    /// (seconds since 1970): everyone's inputs run, their islands step, arrows fly, monsters move
    /// and slam. No clock is read here, so the same game given the same ticks plays the same.
    pub fn play_tick(&mut self, elapsed: f64, world: f64) {
        self.tick += 1;
        // Each player may run as many inputs as real time allows (a hair more, so a browser whose
        // clock runs a little fast never builds up a queue), and no more.
        self.players.inputs_per_tick = elapsed * 61.0;
        for (_, life) in self.players.each_life_mut() {
            life.world_clock = Some(world);
        }
        self.gather_movers();
        self.drive_bots();
        self.players.step_in(&mut self.actors, &self.world, self.tick, Some(&mut self.open));
        self.seat_passengers();
        // Games' clocks, payouts, and players kept in their seats.
        self.step_tables();
        self.players.step_effects(&mut self.actors);
        let foes = self.players.foes();
        let ground = self.players.ground;
        // In a copy of a dungeon or a developer zone, its creatures stand on its floor, far over the island.
        let floor = self.copy_of().map(|c| c.def);
        let ground_at = move |x: f64, z: f64| floor.and_then(|d| d.floor_at(x, z)).unwrap_or_else(|| ground.map_or(0.0, |g| g.height(x, z)));
        let mut done = StepOut::default();
        for _ in 0..(60 / TICK_HZ) {
            done.extend(self.actors.step(&foes, &ground_at, LEAN_SPRING, LEAN_DAMPING, 1.0 / 60.0));
        }
        self.players.apply_slams(&done.slams);
        self.players.apply_foe_hits(&done.hits);
        // Where everyone stood as this tick ends: swings are checked against what their swinger saw.
        self.players.record_history(self.tick);
        self.catch_fallers();
    }

    /// Every browser hears what happened this tick (`now`); islands due a save are added to `saves`.
    fn send_tick(&mut self, now: Instant, saves: &mut Vec<Save>) {
        let ids: Vec<i64> = self.members.keys().copied().collect();
        let outside = self.outside();
        for id in &ids {
            self.refresh_estate(*id);
        }

        // Everyone as everyone else sees them.
        let fr = self.tick * (60 / TICK_HZ) as u64;
        let mut presences: Vec<(i64, Value)> = Vec::new();
        for (_, owner, p, life) in self.players.each_open() {
            if let Some(m) = self.members.get(&owner) {
                presences.push((owner, json!({ "id": owner, "name": m.name, "p": presence_json(p, life, fr) })));
            } else if let Some(name) = self.bot_name(owner) {
                presences.push((owner, json!({ "id": owner, "name": name, "bot": true, "p": presence_json(p, life, fr) })));
            }
        }
        // The tables thrown down for games, as everyone sees them.
        let tables = self.tables_shown();
        // Once a second, for admins: how this game is running and how its fights go.
        let stats = self.tick.is_multiple_of(STATS_EVERY).then(|| {
            let pl = &self.players;
            json!({
                "tick": self.tick,
                "players": self.members.len(),
                "bots": self.bots.len(),
                "tickMs": self.step_ms,
                "pvpHits": pl.pvp_hits,
                "savedByRewind": pl.saved_by_rewind,
                "rewindMs": pl.rewind_ms(),
                "heals": pl.heals,
                "meteorsLanded": pl.meteors_landed,
            })
        });

        for id in ids {
            let c = client(id);
            let Some(slot) = self.players.slot_index(c) else { continue };
            let Some((p, ack, Some(life))) = self.players.open_view(c) else { continue };
            let (x, z) = (p.pos.x, p.pos.z);
            let you = you_json(slot, ack, p, life);
            let rev = life.revision;
            let m = self.members.get_mut(&id).unwrap();
            let send_life = m.life_due > 0 || rev != m.last_rev || now - m.last_life >= LIFE_EVERY;
            let life_json = send_life.then(|| life_view(life));
            let save_due = now - m.last_save >= SAVE_EVERY && !m.keep_saved;
            m.life_due = m.life_due.saturating_sub(1);
            if send_life {
                m.last_rev = rev;
                m.last_life = now;
            }
            let (session, out) = (m.session, m.out.clone());
            let (arrows, meteors, events) = self.players.effects_json(Some(slot), x, z);
            let peers: Vec<&Value> = presences.iter().filter(|(o, _)| *o != id).map(|(_, v)| v).collect();
            let actors = actors_json(&self.actors, &self.open, x, z);
            let mut life_events = Vec::new();
            if let Some((p, Some(life))) = self.players.open_mut(c) {
                life_events = life.drain_events();
                if save_due {
                    saves.push(Save { character: id, session, island: outside_of(island_of(p, life, &mut self.open, id), outside), out: Some(out.clone()) });
                }
            }
            if save_due && let Some(m) = self.members.get_mut(&id) {
                m.last_save = now;
            }
            let mut msg = json!({
                "t": "tick",
                "tick": self.tick,
                "you": you,
                "peers": peers,
                "actors": actors,
                "arrows": arrows,
                "meteors": meteors,
                "events": events,
            });
            if !life_events.is_empty() {
                msg["lifeEvents"] = serde_json::to_value(&life_events).unwrap_or(Value::Null);
            }
            if let Some(l) = life_json {
                msg["life"] = l;
            }
            let near = ChannelGame::tables_near(&tables, x, z);
            if !near.is_empty() {
                msg["tables"] = Value::Array(near);
            }
            let mut text = msg.to_string();
            if let Some(s) = &stats
                && self.members.get(&id).is_some_and(|m| m.dev)
            {
                // With the size of this very update, before the stats were added to it.
                let mut s = s.clone();
                s["bytes"] = json!(text.len());
                msg["stats"] = s;
                text = msg.to_string();
            }
            let _ = out.try_send(text);
        }
    }
}

impl ChannelGame {
    /// In a copy of a dungeon, anyone who falls out of it is back where it's entered.
    fn catch_fallers(&mut self) {
        let Some(c) = self.copy_of() else { return };
        let def = c.def;
        let Some(at) = self.arrival() else { return };
        let ids: Vec<i64> = self.members.keys().copied().collect();
        for id in ids {
            if let Some((p, _)) = self.players.open_mut(client(id))
                && def.fallen_out(p.pos.y)
            {
                p.pos.x = at.x;
                p.pos.y = at.y;
                p.pos.z = at.z;
                p.facing = at.facing;
                p.vel = Default::default();
                if p.mode == Mode::Glide || p.mode == Mode::Swim {
                    p.mode = Mode::Normal;
                }
                p.grounded = true;
            }
        }
    }
}

/// An island as saved, standing at `outside` instead if it's given (a copy's door).
fn outside_of(mut island: Value, outside: Option<Spot>) -> Value {
    if let Some(o) = outside {
        island["player"] = json!({ "x": o.x, "y": o.y, "z": o.z, "facing": o.facing });
    }
    island
}

/// Puts a passenger in seat `seat` of a vehicle, facing the way it faces and moving with it.
fn sit(p: &mut Player, v: &crate::life::state::Vehicle, seat: usize) {
    let def = crate::life::content::rideable(&v.def);
    let Some(a) = def.seats.get(seat) else { return };
    let (x, y, z) = vehicles::anchor_world(v, a);
    p.pos.x = x;
    p.pos.y = y;
    p.pos.z = z;
    p.facing = v.heading;
    p.vel.x = v.vx;
    p.vel.y = v.vy;
    p.vel.z = v.vz;
    p.bank = 0.0;
}

/// Stands a player on whatever is under them (terrain, a deck, a roof).
fn stand_on_ground(p: &mut Player, world: &OpenWorld) {
    let hf = world.terrain();
    p.pos.y = ground_at(hf, &world.index, p.pos.x, p.pos.z, hf.height(p.pos.x, p.pos.z) + 1.2, 1.2);
    p.grounded = true;
}

/// Makes an island's houses and farm posts solid in the channel (each piece once).
pub fn make_solid(world: &mut OpenWorld, owner: i64, state: &LifeState) {
    let zone = world.zone;
    let mut life = Life::new(zone, None, None);
    life.state = state.clone();
    let spawn = Spawn { x: zone.recipe.spawn.x, z: zone.recipe.spawn.z, facing: zone.recipe.spawn.facing };
    let mut p = Player::new(spawn, 0, Build::default());
    let mut sim = Sim { player: &mut p, world, owner };
    for h in &state.houses {
        housing::add_house_colliders(&life, &mut sim, h);
    }
    for sc in &state.scarecrows {
        farming::add_scarecrow_collider(&mut sim, sc);
    }
}

/// Seconds as "1m 20s" (src/sim/life/interact.ts shortTime).
fn short_time(s: f64) -> String {
    let s = s.ceil().max(0.0) as i64;
    let day = housing::DAY as i64;
    if s >= day {
        return format!("{}d {}h", s / day, (s % day) / 3600);
    }
    if s >= 3600 {
        return format!("{}h {}m", s / 3600, (s % 3600) / 60);
    }
    if s >= 60 {
        return format!("{}m {}s", s / 60, s % 60);
    }
    format!("{s}s")
}

/// Restores a saved island into a fresh Life and player (src/app/save.ts applySave): its state,
/// the time that passed while its owner was away, and where they stood.
pub fn load_island(life: &mut Life, p: &mut Player, world: &mut OpenWorld, owner: i64, island: &Value, saved_at: i64, now: i64) -> Result<(), String> {
    let state = island.get("state").ok_or("no state")?;
    let state = serde_json::from_value::<LifeState>(state.clone()).map_err(|e| e.to_string())?;
    life.load(state);
    for v in &mut life.state.vehicles {
        v.ridden = false;
    }
    // A stake still on a table when this was saved (the server stopped or fell over mid-game): no
    // game holds it now, as games are only in the server's memory, so it's back in the purse.
    if let Some(s) = life.state.staked.take() {
        life.state.coins += s;
    }
    // Solid before anyone stands on it (a house floor is somewhere to stand).
    make_solid(world, owner, &life.state);
    // Time away.
    let c = clock();
    let away = ((now - saved_at) as f64 / 1000.0).clamp(0.0, c.max_offline_seconds) * c.offline_factor;
    if away > 1.0 {
        life.state.clock += away;
        farming::grow_for(life, away);
        trade::recover_demand(life, away);
        life.regen_labor(away, false, true);
        if away > 60.0 {
            life.toast(format!("Welcome back - {} passed on Emberholm while you were away", short_time(away)), "info");
        }
    }
    // Where they were.
    let hf = world.terrain();
    let at = &island["player"];
    let num = |k: &str| at.get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
    if let (Some(x), Some(z), Some(y), Some(facing)) = (num("x"), num("z"), num("y"), num("facing"))
        && hf.inside(x, z, 10.0)
    {
        p.pos.x = x;
        p.pos.z = z;
        p.pos.y = ground_at(hf, &world.index, x, z, y.max(hf.height(x, z)) + 0.5, 1.0);
        p.facing = facing;
        p.grounded = true;
    }
    Ok(())
}

/// The island as it would be saved right now (src/app/save.ts islandData): riding isn't saved, so
/// you're standing beside your vehicle next time.
pub fn island_of(p: &Player, life: &mut Life, world: &mut OpenWorld, owner: i64) -> Value {
    let mut at = (p.pos.x, p.pos.y, p.pos.z);
    if p.mode == Mode::Ride {
        let mut q = p.clone();
        let sim = Sim { player: &mut q, world, owner };
        if let Some(i) = vehicles::ridden(life, &sim) {
            let v = life.state.vehicles[i].clone();
            let (x, y, z, _) = vehicles::exit_spot(&sim, &v);
            at = (x, y, z);
        }
    }
    json!({ "state": life.state, "player": { "x": at.0, "y": at.1, "z": at.2, "facing": p.facing } })
}

fn island_of_ref(p: &Player, life: &Life) -> Value {
    json!({ "state": life.state, "player": { "x": p.pos.x, "y": p.pos.y, "z": p.pos.z, "facing": p.facing } })
}

pub fn mode_name(m: Mode) -> &'static str {
    match m {
        Mode::Normal => "normal",
        Mode::Attack => "attack",
        Mode::Cast => "cast",
        Mode::Action => "action",
        Mode::Swim => "swim",
        Mode::Glide => "glide",
        Mode::Ride => "ride",
    }
}

fn v3(x: f64, y: f64, z: f64) -> Value {
    json!({ "x": x, "y": y, "z": z })
}

/// A build in the shape the browser keeps one (src/app/build.ts Build), which parse_build reads back.
pub fn build_json(b: &Build) -> Value {
    json!({ "skills": b.skills, "weapon": b.weapon, "abilities": b.abilities, "movement": b.movement })
}

/// A player's whole state, in the shape of src/sim/types.ts PlayerState, for the browser to
/// correct its prediction from.
pub fn player_state_json(p: &Player) -> Value {
    json!({
        "pos": v3(p.pos.x, p.pos.y, p.pos.z),
        "vel": v3(p.vel.x, p.vel.y, p.vel.z),
        "facing": p.facing,
        "mode": mode_name(p.mode),
        "grounded": p.grounded,
        "jumpsUsed": p.jumps_used,
        "jumpCutDone": p.jump_cut_done,
        "coyote": p.coyote,
        "jumpBuffer": p.jump_buffer,
        "attackBuffer": p.attack_buffer,
        "actionBuffer": p.action_buffer,
        "actionBufferId": p.action_buffer_id,
        "attackIndex": p.attack_index,
        "attackFrame": p.attack_frame,
        "attackQueued": p.attack_queued,
        "attackHit": p.attack_hit,
        "flipFrame": p.flip_frame,
        "landFrame": p.land_frame,
        "landImpact": p.land_impact,
        "takeoffFrame": p.takeoff_frame,
        "runPhase": p.run_phase,
        "hp": p.hp,
        "stamina": p.stamina,
        "staminaDelay": p.stamina_delay,
        "mp": p.mp,
        "stun": p.stun,
        "downFrame": p.down_frame,
        "team": p.team,
        "weapon": p.weapon,
        "skills": p.skills,
        "comboVariants": p.resolved.combo_variant_bits,
        "abilities": p.abilities,
        "cooldowns": p.cooldowns,
        "abilityBuffer": p.ability_buffer,
        "abilityBufferSlot": p.ability_buffer_slot,
        "movement": p.movement,
        "movementCooldowns": p.movement_cooldowns,
        "actionId": p.action_id,
        "actionFrame": p.action_frame,
        "actionDirX": p.action_dir_x,
        "actionDirZ": p.action_dir_z,
        "actionSlot": p.action_slot,
        "sprinting": p.sprinting,
        "crouching": p.crouching,
        "crouchFrame": p.crouch_frame,
        "castAbility": p.cast_ability,
        "castSlot": p.cast_slot,
        "castFrame": p.cast_frame,
        "castTargetX": p.cast_target_x,
        "castTargetZ": p.cast_target_z,
        "firedAbility": p.fired_ability,
        "pack": p.pack,
        "vehicle": p.vehicle,
        "seat": p.seat,
        "host": p.host,
        "glider": p.glider,
        "airspeed": p.airspeed,
        "bank": p.bank,
        "modeFrame": p.mode_frame,
        "gustFrames": p.gust_frames,
    })
}

/// Your own state, for your browser to correct its prediction: the player after input `ack`, and
/// the parts of the island that move with you (your vehicles, the clock and the wind for sailing).
fn you_json(slot: usize, ack: u32, p: &Player, life: &Life) -> Value {
    json!({
        "id": slot,
        "ack": ack,
        "p": player_state_json(p),
        "clock": life.state.clock,
        "labor": life.state.labor,
        "resting": life.resting,
        "vehicles": life.state.vehicles,
        "weather": life.state.weather,
        "placing": life.placing,
    })
}

/// The whole island, for its owner's browser to show.
fn life_view(life: &Life) -> Value {
    json!({ "rev": life.revision, "state": life.state, "placing": life.placing, "resting": life.resting })
}

/// What everyone else needs to draw you (the fields src/net/worldPeers.ts SHOWN reads), with
/// your vehicles and packs. `fr` counts 60ths of a second, for them to blend between updates.
fn presence_json(p: &Player, life: Option<&Life>, fr: u64) -> Value {
    let mut v = json!({
        "fr": fr,
        "pos": v3(p.pos.x, p.pos.y, p.pos.z),
        "vel": v3(p.vel.x, p.vel.y, p.vel.z),
        "facing": p.facing,
        "mode": mode_name(p.mode),
        "grounded": p.grounded,
        "attackIndex": p.attack_index,
        "attackFrame": p.attack_frame,
        "flipFrame": p.flip_frame,
        "landFrame": p.land_frame,
        "landImpact": p.land_impact,
        "takeoffFrame": p.takeoff_frame,
        "runPhase": p.run_phase,
        "stun": p.stun,
        "downFrame": p.down_frame,
        "team": p.team,
        "weapon": p.weapon,
        "comboVariants": p.resolved.combo_variant_bits,
        "actionId": p.action_id,
        "actionFrame": p.action_frame,
        "castAbility": p.cast_ability,
        "castFrame": p.cast_frame,
        "bank": p.bank,
        "pack": p.pack,
        "vehicle": p.vehicle,
        "seat": p.seat,
        "host": p.host,
        "glider": p.glider,
        "airspeed": p.airspeed,
        "sprinting": p.sprinting,
        "crouching": p.crouching,
        "crouchFrame": p.crouch_frame,
        "hp": p.hp,
    });
    if let Some(l) = life {
        v["vehicles"] = serde_json::to_value(&l.state.vehicles).unwrap_or(Value::Null);
        v["packs"] = serde_json::to_value(&l.state.packs).unwrap_or(Value::Null);
    }
    v
}

/// The monsters and props near a point, nearest first, in the shape of src/net/netCrowd.ts
/// NetActor (heights are above each one's own patch of ground; the browser adds the ground).
fn actors_json(actors: &Actors, _world: &OpenWorld, x: f64, z: f64) -> Value {
    let mut near: Vec<(f64, usize)> = actors
        .list
        .iter()
        .enumerate()
        .filter_map(|(i, a)| {
            let d2 = (a.x - x) * (a.x - x) + (a.z - z) * (a.z - z);
            (d2 <= ACTOR_RADIUS * ACTOR_RADIUS && !a.gone).then_some((d2, i))
        })
        .collect();
    near.sort_by(|a, b| a.0.total_cmp(&b.0));
    near.truncate(ACTOR_CAP);
    Value::Array(
        near.into_iter()
            .map(|(_, i)| {
                let a = &actors.list[i];
                let progress = if a.wait > 0 { (a.state_frame as f64 / a.wait as f64).clamp(0.0, 1.0) } else { 0.0 };
                json!({
                    "id": a.id,
                    "kind": a.kind_index,
                    "x": a.x,
                    "y": a.y,
                    "z": a.z,
                    "facing": a.facing,
                    "state": a.state,
                    "progress": progress,
                    "hp": if a.max_hp > 0.0 { a.hp / a.max_hp } else { 0.0 },
                    "deadFrame": a.dead_frame,
                    "targetX": a.target_x,
                    "targetZ": a.target_z,
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_read_like_the_browser_writes_them() {
        assert_eq!(short_time(59.2), "1m 0s");
        assert_eq!(short_time(3600.0 * 3.0 + 60.0), "3h 1m");
        assert_eq!(short_time(5.0), "5s");
    }

    #[test]
    fn a_player_state_has_every_field_the_browser_reads() {
        let zone = emberholm();
        let p = Player::new(Spawn { x: zone.recipe.spawn.x, z: zone.recipe.spawn.z, facing: 0.0 }, 0, Build::default());
        let v = player_state_json(&p);
        for k in ["pos", "vel", "mode", "jumpsUsed", "cooldowns", "movementCooldowns", "skills", "glider", "gustFrames", "stamina", "staminaDelay", "mp"] {
            assert!(v.get(k).is_some(), "{k}");
        }
        assert_eq!(v["mode"], "normal");
    }

    #[test]
    fn a_rebuild_makes_everyone_solid_in_the_same_order_whatever_order_they_came_in() {
        // Residents away, each with a scarecrow of their own, written in in two different orders.
        let solids = |order: &[i64]| {
            let mut ch = ChannelGame::new(1);
            for &id in order {
                let estate = json!({ "houses": [], "scarecrows": [{ "id": 1, "x": id as f64 * 3.0, "z": -20.0, "rot": 0.0 }], "ships": [] });
                ch.estates.set_estate(id, &format!("R{id}"), estate);
            }
            ch.rebuild_world();
            ch.open.index.obstacles.iter().map(|o| (o.x, o.z, o.r)).collect::<Vec<_>>()
        };
        let first = solids(&[3, 1, 4, 2, 5, 9, 6, 8, 7]);
        assert_eq!(first, solids(&[7, 8, 6, 9, 5, 2, 4, 1, 3]));
        // And each of them is in it: the island's own obstacles and nine scarecrows' posts.
        assert_eq!(first.len(), ChannelGame::new(1).open.index.obstacles.len() + 9);
    }

    /// A channel with one character in it, `build` as they kept it.
    fn channel_with(build: Option<Value>) -> (ChannelGame, Value) {
        let mut ch = ChannelGame::new(1);
        let (out, _) = mpsc::channel(16);
        let arrival = Arrival { character: 7, session: 1, name: "Ada".into(), out, dev: false, island: None, saved_at: None, now: 0, build };
        let (_, _, build) = ch.join(arrival);
        (ch, build)
    }

    #[test]
    fn a_build_is_held_to_the_points_the_island_has_earned() {
        let three = crate::skills::skills_from(&["sword", "cleave", "whirlwind"]);
        let wanted = build_json(&Build { skills: three, ..Build::default() });
        // A newcomer has only the points everyone starts with, too few for three skills: they play
        // with the default build, and their browser is told so.
        let (mut ch, build) = channel_with(Some(wanted.clone()));
        assert_eq!(build, build_json(&Build::default()));
        assert!(!ch.set_build(7, &wanted));
        // A quest finished is a point earned.
        ch.players.open_mut(client(7)).unwrap().1.unwrap().state.quests.done.push("landfall".into());
        assert!(ch.set_build(7, &wanted));
        assert_eq!(ch.players.open_view(client(7)).unwrap().0.skills, three);
        // Starting the island over takes the quest, and the point, with it.
        ch.reset(7).expect("a fresh island");
        assert_eq!(ch.players.open_view(client(7)).unwrap().0.skills, Build::default().skills);
        // The island's own islanders keep theirs.
        let (_, build) = channel_with(Some(build_json(&Build::default())));
        assert_eq!(build, build_json(&Build::default()));
    }

    #[test]
    fn a_swing_lands_where_its_swinger_saw_the_other_player() {
        // Two players on opposite sides (a developer zone's), a step apart, facing each other.
        let mut ch = ChannelGame::new(1);
        for (id, name) in [(7, "Ada"), (8, "Bo")] {
            let (out, _) = mpsc::channel(16);
            ch.join(Arrival { character: id, session: 1, name: name.into(), out, dev: false, island: None, saved_at: None, now: 0, build: None });
        }
        let (x, z) = {
            let p = ch.players.open_view(client(7)).unwrap().0;
            (p.pos.x, p.pos.z)
        };
        let place = |ch: &mut ChannelGame, id: i64, dz: f64, facing: f64| {
            let p = ch.players.open_mut(client(id)).unwrap().0;
            (p.pos.x, p.pos.z, p.facing) = (x, z + dz, facing);
            stand_on_ground(p, &ch.open);
        };
        place(&mut ch, 7, 0.0, 0.0);
        place(&mut ch, 8, 1.2, std::f64::consts::PI);
        ch.players.open_mut(client(8)).unwrap().0.team = 1;
        ch.players.record_history(10);
        // Then Bo steps well away; Ada's screen, a round trip behind, still shows them close.
        place(&mut ch, 8, 7.0, std::f64::consts::PI);
        ch.players.record_history(11);
        const ATTACK: [u8; OPEN_INPUT] = [0, 0, 4, 0, 0, 0, 0, 0, 0, 0];
        let hp = |ch: &ChannelGame| ch.players.open_view(client(8)).unwrap().0.hp;
        let full = hp(&ch);
        let mut seq = 0u32;
        let mut swing = |ch: &mut ChannelGame, view: u32, from: u64| {
            ch.inputs_seen(7, (1..=48).map(|k| (seq + k, view, if k == 1 { ATTACK } else { [0; OPEN_INPUT] })));
            seq += 48;
            ch.players.inputs_per_tick = 12.0;
            for tick in from..from + 4 {
                ch.players.step_in(&mut ch.actors, &ch.world, tick, Some(&mut ch.open));
            }
        };
        // Seeing the present, the swing finds nobody in reach.
        swing(&mut ch, u32::MAX, 12);
        assert_eq!(hp(&ch), full);
        // Seeing tick 10, it lands where Ada saw Bo.
        swing(&mut ch, 10 * 16, 16);
        assert!(hp(&ch) < full, "the rewound swing lands: {} of {full}", hp(&ch));
    }

    #[test]
    fn hits_casts_and_slides_train_the_skills_behind_them() {
        let (mut ch, _) = channel_with(None);
        let c = client(7);
        {
            // Landfall done, so Slime Hunter is counting.
            let life = ch.players.open_mut(c).unwrap().1.unwrap();
            life.state.quests.done.push("landfall".into());
            crate::life::quests::start_quests(life);
        }
        // A step away from the first slime, facing it.
        let (sx, sz) = (ch.actors.list[0].x, ch.actors.list[0].z);
        {
            let p = ch.players.open_mut(c).unwrap().0;
            p.pos.x = sx;
            p.pos.z = sz - 1.0;
            p.facing = 0.0;
            stand_on_ground(p, &ch.open);
        }
        let mut seq = 0u32;
        let mut play = |ch: &mut ChannelGame, first: [u8; OPEN_INPUT], frames: u32| {
            let inputs: Vec<(u32, [u8; OPEN_INPUT])> = (0..frames).map(|k| (seq + 1 + k, if k == 0 { first } else { [0; OPEN_INPUT] })).collect();
            seq += frames;
            ch.inputs(7, inputs.into_iter());
            ch.players.inputs_per_tick = 12.0;
            for tick in 0..frames.div_ceil(12) {
                ch.players.step_in(&mut ch.actors, &ch.world, tick as u64 + 1, Some(&mut ch.open));
            }
        };
        let xp = |ch: &ChannelGame, id: &str| ch.players.open_view(client(7)).unwrap().2.unwrap().state.skill_xp.get(id).copied().unwrap_or(0.0);
        const ATTACK: [u8; OPEN_INPUT] = [0, 0, 4, 0, 0, 0, 0, 0, 0, 0];
        const SLIDE: [u8; OPEN_INPUT] = [0, 0, 8, 0, 0, 0, 0, 0, 0, 0];
        // One swing lands once, however many frames it is live for, and trains the sword.
        play(&mut ch, ATTACK, 48);
        assert_eq!(ch.actors.list[0].hp, ch.actors.list[0].max_hp - tuning_damage());
        assert_eq!(xp(&ch, "sword"), 1.0);
        // Finishing one off counts for the milestone.
        ch.actors.list[0].hp = 1.0;
        play(&mut ch, ATTACK, 48);
        assert!(ch.actors.list[0].dead_frame >= 0);
        assert_eq!(xp(&ch, "sword"), 2.0);
        let life = ch.players.open_view(c).unwrap().2.unwrap();
        let hunter = crate::life::quests::quest_active(life, "slimeHunter").unwrap();
        assert_eq!(life.state.quests.active[hunter].counts, [1.0]);
        // The slide everyone has is a movement skill like the rest (done, and cooled down, after a
        // second).
        play(&mut ch, SLIDE, 60);
        assert_eq!(xp(&ch, "slide"), 1.0);
        // Enough of it is a level, which the player uses from then on.
        ch.players.open_mut(c).unwrap().1.unwrap().state.skill_xp.insert("slide".into(), 19.0);
        play(&mut ch, SLIDE, 12);
        let (p, _, life) = ch.players.open_view(c).unwrap();
        assert_eq!(life.unwrap().state.skill_xp["slide"], 20.0);
        let slide = crate::skills::book_index("slide").unwrap();
        assert_eq!(p.levels[slide], 2);
        // A cast that goes off trains the ability.
        let mut healer = Build { skills: crate::skills::skills_from(&["club", "heal"]), weapon: 1, ..Build::default() };
        healer.abilities[0] = 0;
        assert!(ch.set_build(7, &build_json(&healer)));
        play(&mut ch, [0, 0, 0, 0, 0, 1, 0, 0, 0, 0], 150);
        assert_eq!(xp(&ch, "heal"), 1.0);
        assert_eq!(xp(&ch, "club"), 0.0);
    }

    fn tuning_damage() -> f64 {
        crate::tuning::tuning().weapons[0].combo[0].damage
    }

    #[test]
    fn the_island_its_owner_sees_carries_skill_experience() {
        let mut life = Life::new(emberholm(), None, None);
        assert_eq!(life_view(&life)["state"]["skillXp"], json!({}));
        life.state.skill_xp.insert("bow".into(), 42.0);
        assert_eq!(life_view(&life)["state"]["skillXp"]["bow"], json!(42.0));
    }

    /// Ada (7) with her farm cart out on the west road, and Bo (8) in the same channel.
    fn ada_and_bo() -> (ChannelGame, i64) {
        let (mut ch, _) = channel_with(None);
        let (out, _) = mpsc::channel(16);
        ch.join(Arrival { character: 8, session: 2, name: "Bo".into(), out, dev: false, island: None, saved_at: None, now: 0, build: None });
        let (x, z, heading) = (150.0, -210.0, std::f64::consts::FRAC_PI_2 + 0.25);
        let id = {
            let (p, life) = ch.players.open_mut(client(7)).unwrap();
            p.pos.x = x - 6.0;
            p.pos.z = z;
            p.facing = heading;
            stand_on_ground(p, &ch.open);
            let life = life.unwrap();
            life.give("deed.farmCart", 1, true);
            let mut sim = Sim { player: p, world: &mut ch.open, owner: 7 };
            vehicles::summon(life, &mut sim, "deed.farmCart").expect("a cart on the road")
        };
        (ch, id)
    }

    /// Runs \`frames\` inputs for everyone (Ada's \`ada\`, Bo standing still), a tick at a time, as
    /// step() does: everyone's vehicles made solid, everyone moved, passengers seated.
    fn play_both(ch: &mut ChannelGame, seq: &mut u32, ada: [u8; OPEN_INPUT], frames: u32) {
        for _ in 0..frames.div_ceil(3) {
            let first = *seq + 1;
            *seq += 3;
            ch.inputs(7, (first..=*seq).map(|s| (s, ada)));
            ch.inputs(8, (first..=*seq).map(|s| (s, [0; OPEN_INPUT])));
            ch.players.inputs_per_tick = 3.0;
            ch.gather_movers();
            ch.players.step_in(&mut ch.actors, &ch.world, 1, Some(&mut ch.open));
            ch.seat_passengers();
        }
    }

    fn cart(ch: &ChannelGame, id: i64) -> crate::life::state::Vehicle {
        ch.vehicle_of(7, id).expect("Ada's cart is out")
    }

    #[test]
    fn a_friend_rides_along_in_your_cart_and_steps_out_beside_it() {
        let (mut ch, id) = ada_and_bo();
        let seat = |v: &crate::life::state::Vehicle, k: usize| vehicles::anchor_world(v, &crate::life::content::rideable("farmCart").seats[k]);
        // Bo walks up to the passenger's side and climbs in.
        let v = cart(&ch, id);
        let (sx, _, sz) = seat(&v, 1);
        {
            let p = ch.players.open_mut(client(8)).unwrap().0;
            p.pos.x = sx - 1.2 * v.heading.cos();
            p.pos.z = sz + 1.2 * v.heading.sin();
            stand_on_ground(p, &ch.open);
        }
        assert!(ch.command(8, 1, Command::Ride { host: 7, vehicle: id }));
        let bo = ch.players.open_view(client(8)).unwrap().0;
        assert_eq!((bo.mode, bo.host, bo.vehicle, bo.seat), (Mode::Ride, 7, id, 1));
        assert_eq!((bo.pos.x, bo.pos.y, bo.pos.z), seat(&v, 1));
        // Nobody else fits in a two-seater, and nobody takes the wheel from its owner.
        assert!(!ch.ride_along(7, 7, id), "not in your own as a passenger");
        // Ada gets in and drives off up the road: Bo goes with her, in his seat all the way.
        {
            let v = cart(&ch, id);
            let (p, life) = ch.players.open_mut(client(7)).unwrap();
            let (x, _, z) = seat(&v, 0);
            p.pos.x = x + 1.0 * v.heading.cos();
            p.pos.z = z - 1.0 * v.heading.sin();
            let mut sim = Sim { player: p, world: &mut ch.open, owner: 7 };
            assert!(vehicles::board(life.unwrap(), &mut sim, id));
        }
        let mut seq = 1;
        const GO: [u8; OPEN_INPUT] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 127];
        let start = cart(&ch, id);
        play_both(&mut ch, &mut seq, GO, 120);
        let v = cart(&ch, id);
        let went = (v.x - start.x).hypot(v.z - start.z);
        assert!(went > 3.0, "the cart went {went} m");
        let bo = ch.players.open_view(client(8)).unwrap().0;
        assert_eq!((bo.mode, bo.host), (Mode::Ride, 7));
        assert_eq!((bo.pos.x, bo.pos.y, bo.pos.z), seat(&v, 1));
        assert_eq!(bo.facing, v.heading);
        // F gets him out, beside the cart, on his feet.
        assert!(ch.command(8, seq + 1, Command::Interact));
        let bo = ch.players.open_view(client(8)).unwrap().0;
        assert_eq!((bo.mode, bo.host, bo.vehicle, bo.seat), (Mode::Normal, 0, 0, 0));
        let off = vehicles::distance_to(&v, bo.pos.x, bo.pos.z);
        assert!(off > 0.0 && off < 1.5, "{off} m from the hull");
    }

    #[test]
    fn your_friend_bumps_into_your_cart_and_falls_off_when_it_goes_home() {
        let (mut ch, id) = ada_and_bo();
        let v = cart(&ch, id);
        // Bo walks into the middle of Ada's cart: he's pushed out of it, as from his own.
        {
            let p = ch.players.open_mut(client(8)).unwrap().0;
            p.pos.x = v.x;
            p.pos.z = v.z;
            stand_on_ground(p, &ch.open);
        }
        let mut seq = 0;
        play_both(&mut ch, &mut seq, [0; OPEN_INPUT], 3);
        let bo = ch.players.open_view(client(8)).unwrap().0;
        assert!((bo.pos.x - v.x).hypot(bo.pos.z - v.z) > 1.0, "pushed out of the cart");
        // In he climbs; then Ada sends it home. Bo is left standing where it was.
        assert!(ch.ride_along(8, 7, id));
        {
            let (p, life) = ch.players.open_mut(client(7)).unwrap();
            let mut sim = Sim { player: p, world: &mut ch.open, owner: 7 };
            assert!(vehicles::recall(life.unwrap(), &mut sim, id, true));
        }
        play_both(&mut ch, &mut seq, [0; OPEN_INPUT], 3);
        let bo = ch.players.open_view(client(8)).unwrap().0;
        assert_eq!((bo.mode, bo.host), (Mode::Normal, 0));
        let hf = ch.open.terrain();
        assert!((bo.pos.y - hf.height(bo.pos.x, bo.pos.z)).abs() < 1.5, "on the ground where the cart was");
    }

    #[test]
    fn nobody_rides_along_with_a_pack_or_from_far_away() {
        let (mut ch, id) = ada_and_bo();
        let v = cart(&ch, id);
        ch.players.open_mut(client(8)).unwrap().1.unwrap().drain_events();
        {
            let p = ch.players.open_mut(client(8)).unwrap().0;
            p.pos.x = v.x + 9.0;
            p.pos.z = v.z;
            stand_on_ground(p, &ch.open);
        }
        assert!(!ch.ride_along(8, 7, id), "too far");
        {
            let p = ch.players.open_mut(client(8)).unwrap().0;
            p.pos.x = v.x + 1.6 * v.heading.cos();
            p.pos.z = v.z - 1.6 * v.heading.sin();
            p.pack = 12;
        }
        assert!(!ch.ride_along(8, 7, id), "a pack in his arms");
        let toasts: Vec<String> = ch
            .players
            .open_mut(client(8))
            .unwrap()
            .1
            .unwrap()
            .drain_events()
            .into_iter()
            .filter_map(|e| if let crate::life::LifeEvent::Toast { text, .. } = e { Some(text) } else { None })
            .collect();
        assert_eq!(toasts, ["Put your pack down first - there's no room for it in Ada's farm cart"]);
        ch.players.open_mut(client(8)).unwrap().0.pack = 0;
        assert!(!ch.ride_along(8, 7, 999), "no such cart");
        assert!(!ch.ride_along(8, 9, id), "nobody by that name here");
        assert!(ch.ride_along(8, 7, id));
    }
}
