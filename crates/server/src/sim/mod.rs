//! A simulation: one space as the server plays it, a region's channel or an instance's copy, 20
//! ticks a second on a thread of its own (`host.rs`). Each player's browser sends what they press
//! (about 60 inputs a second) and what they ask their life to do (commands); here those run through
//! the rules (crates/engine/src/open, crates/engine/src/life) and the players' combat
//! (crates/engine/src/combat.rs), the space's creatures live and fight, and each tick's records go to
//! the gates (`publish.rs`), which tell every browser where it really is, what its life now holds,
//! and what everyone else there is doing. Nothing a browser says about its own state is believed: it
//! can only press keys and ask.
//!
//! The game owns everything in its space and reaches nothing outside it: what it says to a browser,
//! a life it wants written, it leaves in its outbox (`said`, `writes`), which the host sends.
//!
//! The browser predicts its own player with these same rules (the engine, through its WebAssembly)
//! and corrects itself to what arrives (src/net/worldLink.ts, src/net/netPlayer.ts).

use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use ruina_world_api::gate::{Estates, SpaceView, ToConn};
use ruina_world_api::input::open_actions_from;
use ruina_world_api::sim::{Arrival, Carried, Member as MemberInfo, Spot};
use ruina_world_api::store::{LifeWrite, Then, Writer};
use ruina_world_api::{CharacterId, Conn, EntityId, Epoch, Owner, PartyId, SimId, SpaceId};

pub use ruina_world_api::TICK_HZ;

use crate::actors::{Actors, LEAN_DAMPING, LEAN_SPRING, StepOut};
use crate::bots::Brain;
use crate::combat::Players;
use crate::directory::EXPEL_AFTER;
use crate::gate::socket::parse_build;
use crate::life::content::clock;
use crate::life::progress::skill_budget;
use crate::life::state::LifeState;
use crate::life::{Command, Life, farming, housing, trade, vehicles};
use crate::minigames::Minigames;
use crate::open::colliders::ground_at;
use crate::open::dungeon::{DungeonDef, door_into};
use crate::open::map::world_map;
use crate::open::spawns::{instance_spawns, region_spawns};
use crate::open::zone::{DungeonDoor, Zone};
use crate::open::{OpenWorld, SIM_BAND, Sim};
use crate::player::{Actions, Build, Mode, Player};
use crate::sim::channels::{Channel, estate_of};
use crate::skills::{allowed, build_from_saved};
use crate::world::{Spawn, World};

/// Bots: players without a socket, their inputs decided by their brains.
mod bots;
/// The channels' residents: everyone's estates and who holds which plot.
pub mod channels;
/// The world's clock: ticks numbered from the world's epoch.
pub mod clock;
/// The simulation's thread: its mail, its ticks, players handed between simulations.
pub mod host;
/// What a tick produced, as records for the gates.
mod publish;
/// How a channel's players are stepped each tick: one after another, or all at once.
pub mod stepping;
/// Mini-games here: challenges, tables and the money on them.
pub(crate) mod tables;

pub use bots::FIRST_BOT;
pub use host::{Sim as SimHost, Threads};

/// Lives are written this often while their owner plays (and when they leave).
const SAVE_EVERY: Duration = Duration::from_secs(5);
/// The whole life goes to its owner at least this often, even when nothing obvious changed (crops
/// grow, labor refills, quests tick along).
const LIFE_EVERY: Duration = Duration::from_secs(2);
/// How long someone who left is remembered as they were (see Game::lingering).
const LINGER: Duration = Duration::from_secs(60);

/// Someone playing here right now.
pub struct Member {
    /// Their connection: what they're told goes there.
    pub conn: Conn,
    pub name: String,
    /// Whether they may use the developer panel's commands and go into the developer zones.
    pub dev: bool,
    /// Their grant here: every write of their life carries it.
    pub epoch: Epoch,
    /// Their party (whose copies they may be in), as the social tier keeps it.
    pub party: Option<PartyId>,
    /// Their home channel (where a save made in a copy puts them).
    pub home: SpaceId,
    /// Ticks left on which their life goes out whether or not it looks changed (a command was
    /// just given: it runs on one of the next few ticks).
    life_due: u8,
    last_life: Instant,
    last_rev: u64,
    last_save: Instant,
    /// Their life's revision when their estate was last worked out.
    estate_rev: u64,
    /// Their saved life couldn't be read: it's left as it is in the database, and nothing from
    /// this visit is written over it.
    pub keep_saved: bool,
}

impl Member {
    fn from_info(m: MemberInfo) -> Member {
        let now = Instant::now();
        Member {
            conn: m.conn,
            name: m.name,
            dev: m.dev,
            epoch: m.epoch,
            party: m.party,
            home: m.home,
            life_due: 3,
            last_life: now - LIFE_EVERY,
            last_rev: u64::MAX,
            last_save: now,
            estate_rev: u64::MAX,
            keep_saved: m.keep_saved,
        }
    }

    /// Who they are, to travel with them to another simulation.
    pub fn info(&self) -> MemberInfo {
        MemberInfo {
            conn: self.conn,
            name: self.name.clone(),
            dev: self.dev,
            epoch: self.epoch,
            party: self.party,
            home: self.home.clone(),
            keep_saved: self.keep_saved,
        }
    }
}

/// What a game plays: a channel of a region, or someone's copy of an instance.
pub enum Space {
    Channel,
    Copy(CopyOf),
}

pub struct CopyOf {
    pub def: &'static DungeonDef,
    /// Its door in the world: where you come out.
    pub door: &'static DungeonDoor,
    pub owner: Owner,
    /// Since when nobody has been in it (the directory closes it a while after).
    pub empty_since: Option<Instant>,
    /// Whoever is in it but no longer in the party it belongs to, and when they're put out.
    pub expel: HashMap<CharacterId, Instant>,
    /// How long they have.
    pub expel_after: Duration,
}

/// Someone who left in the last minute, with their life as they left it.
struct Lingering {
    at: Instant,
    /// Their grant when they left: the write of their life carries it.
    epoch: Epoch,
    home: SpaceId,
    player: Player,
    life: Box<Life>,
    /// A game changed their life since they left (it was paid out): written when the server stops.
    dirty: bool,
}

pub struct Game {
    /// The simulation playing this game, its space and its lease's epoch there.
    pub sim: SimId,
    pub at: SpaceId,
    pub lease: Epoch,
    /// A channel, or a copy of an instance.
    pub space: Space,
    /// The region whose life its players live (a channel's own; a copy's door stands in one).
    zone: &'static Zone,
    /// Who left in the last minute, with their life as they left it: newer than any save that
    /// might still be on its way to the database, so a quick reload picks up exactly there.
    lingering: HashMap<CharacterId, Lingering>,
    /// Everyone's estates and who holds which plot, online or not.
    pub estates: Channel,
    pub members: HashMap<CharacterId, Member>,
    world: World,
    pub open: OpenWorld,
    pub(crate) players: Players,
    pub(crate) actors: Actors,
    tick: u64,
    last_tick: Instant,
    /// Challenges and the tables they became (crates/server/src/sim/tables.rs).
    pub tables: Minigames,
    /// When the game began: mini-games' clocks run from here.
    started: Instant,
    /// Tests: seconds added to the games' clock.
    pub(crate) skew: f64,
    /// What it said to browsers since the host last took it.
    pub said: Vec<(Conn, ToConn)>,
    /// Lives to write (each list in one transaction), and what then.
    pub writes: Vec<(Vec<LifeWrite>, Then)>,
    /// Bots playing here (bots.rs), and how many have ever joined (their ids and names count on).
    pub(crate) bots: Vec<bots::BotSlot>,
    bot_count: u32,
    /// How long a tick takes to run (ms, smoothed), for the admins' stats.
    step_ms: f64,
    /// How its players are stepped each tick (the server's `--parallel`).
    pub stepping: stepping::Stepping,
}

/// Ticks between the stats an admin is sent (once a second).
const STATS_EVERY: u64 = TICK_HZ as u64;

/// A character among the players (crate::ids).
pub(crate) fn client(character: CharacterId) -> EntityId {
    EntityId::character(character)
}

/// The world a channel plays: the chunks it plays and a band round them grown (the engine's
/// `OpenWorld::playing`). One channel plays every chunk of the world today; a simulation playing part
/// of it names its own (R10.19).
fn played(zone: &'static Zone) -> OpenWorld {
    let map = world_map();
    OpenWorld::playing(map, zone, &map.chunks(), SIM_BAND)
}

impl Game {
    /// Channel `n` of `region` (found by its id in the world's map).
    pub fn channel(sim: SimId, region: &str, n: u32) -> Game {
        let map = world_map();
        let r = map.region(region).unwrap_or_else(|| panic!("no region {region:?} in this world"));
        let zone = map.zone(r);
        let mut actors = Actors::new();
        // What the region brings to life (its recipe's spawns), as the browser's island offline has it.
        spawn_all(&mut actors, region_spawns(&zone.recipe));
        Game::playing(sim, SpaceId::channel(region, n), zone, played(zone), actors)
    }

    /// Copy `n` of an instance, for `owner`: a space of its own (OpenWorld::instance), its floors and
    /// walls the only things solid in it, nobody in it yet.
    pub fn copy(sim: SimId, def: &'static DungeonDef, n: u64, owner: Owner) -> Game {
        let door = door_into(&def.id).or(def.door.as_ref()).unwrap_or_else(|| panic!("{} has no door", def.id));
        let map = world_map();
        // Its players live the life of the region its door stands in.
        let zone = map.zone_at(door.outside.x, door.outside.z).unwrap_or_else(|| map.zone(&map.regions()[0]));
        let mut actors = Actors::new();
        // What its file says lives in it (a developer zone's training dummy, slimes, a war-band).
        spawn_all(&mut actors, instance_spawns(def));
        let mut g = Game::playing(sim, SpaceId::copy(&def.id, n), zone, OpenWorld::instance(def, zone), actors);
        // Heights in a fight are measured from its floor; off it there's no ground but a fall.
        g.players.floor = Some(def);
        g.players.ground = None;
        g.estates.loaded = true;
        g.space = Space::Copy(CopyOf { def, door, owner, empty_since: Some(Instant::now()), expel: HashMap::new(), expel_after: EXPEL_AFTER });
        g
    }

    fn playing(sim: SimId, at: SpaceId, zone: &'static Zone, open: OpenWorld, actors: Actors) -> Game {
        let r = &zone.recipe;
        let spawn = Spawn { x: r.spawn.x, z: r.spawn.z, facing: r.spawn.facing };
        let world = World { radius: zone.radius, obstacles: Vec::new(), team_spawns: [spawn, spawn] };
        let mut players = Players::new(1000.0 / TICK_HZ as f64);
        players.ground = Some(&zone.terrain);
        Game {
            sim,
            at,
            lease: Epoch::default(),
            space: Space::Channel,
            zone,
            lingering: HashMap::new(),
            estates: Channel::default(),
            members: HashMap::new(),
            world,
            open,
            players,
            actors,
            tick: 0,
            last_tick: Instant::now(),
            tables: Minigames::default(),
            started: Instant::now(),
            skew: 0.0,
            said: Vec::new(),
            writes: Vec::new(),
            bots: Vec::new(),
            bot_count: 0,
            step_ms: 0.0,
            stepping: stepping::Stepping::chosen(),
        }
    }

    /// Emberholm's first channel (tests).
    #[cfg(test)]
    pub fn test() -> Game {
        Game::channel(SimId(1), "emberholm", 1)
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

    /// Where this is, as a browser is told.
    pub fn space_view(&self) -> SpaceView {
        SpaceView::of(&self.at, self.copy_of().map_or("", |c| c.def.name.as_str()))
    }

    /// Players in it, and anyone who left a moment ago and may come straight back.
    pub fn headcount(&self) -> usize {
        self.members.len() + self.lingering.values().filter(|l| l.at.elapsed() < LINGER).count()
    }

    /// Where someone in a copy comes in.
    pub fn arrival(&self) -> Option<Spot> {
        self.copy_of().map(|c| {
            let s = self.open.respawn.unwrap_or_else(|| c.def.arrival());
            Spot { x: s.x, y: s.y, z: s.z, facing: s.facing }
        })
    }

    /// In a copy, the spot outside its door in the world: what a save made here keeps (a save is of
    /// the world), at the portal's height, from which whoever is put there settles on what's solid.
    pub fn outside(&self) -> Option<Spot> {
        let c = self.copy_of()?;
        let o = &c.door.outside;
        Some(Spot { x: o.x, y: c.door.portal.y, z: o.z, facing: o.facing })
    }

    /// Someone here as they are: where they stand, how, and whether they're free to go somewhere
    /// else (not riding, carrying a pack, down or at a mini-game's table).
    pub fn whereabouts(&self, character: CharacterId) -> Option<(f64, f64, f64, bool)> {
        let (p, _, _) = self.players.open_view(client(character))?;
        let free = p.mode != Mode::Ride && p.pack == 0 && p.down_frame < 0 && !self.tables.seated(character);
        Some((p.pos.x, p.pos.y, p.pos.z, free))
    }

    /// Whether someone belongs in this copy: it's their party's, theirs on their own, or everyone's.
    pub fn may_be_in(&self, character: CharacterId) -> bool {
        let Some(c) = self.copy_of() else { return true };
        let party = self.members.get(&character).and_then(|m| m.party);
        c.owner == Owner::Everyone || c.owner == Owner::of(character, party)
    }

    /// Tests: stands someone at (x, y, z), just there.
    #[cfg(test)]
    pub fn place(&mut self, character: CharacterId, x: f64, y: f64, z: f64) {
        if let Some((p, _)) = self.players.open_mut(client(character)) {
            p.pos.x = x;
            p.pos.y = y;
            p.pos.z = z;
            p.grounded = true;
        }
    }

    /// A message for someone's browser, if they're here.
    pub fn say(&mut self, character: CharacterId, msg: ToConn) {
        if let Some(m) = self.members.get(&character) {
            self.said.push((m.conn, msg));
        }
    }

    /// A message for everyone here (but `except`).
    fn say_all(&mut self, msg: &ToConn, except: Option<CharacterId>) {
        for (id, m) in &self.members {
            if Some(*id) != except {
                self.said.push((m.conn, msg.clone()));
            }
        }
    }

    /// The space a life saved here is in: a channel's own; outside a copy's door, its home channel.
    fn saved_space(&self, home: &SpaceId) -> SpaceId {
        if self.copy_of().is_some() { home.clone() } else { self.at.clone() }
    }

    /// Who writes from here.
    fn writer(&self) -> Option<Writer> {
        Some(Writer { sim: self.sim, space: self.at.clone(), epoch: self.lease })
    }

    /// A life to write for `character`, under `epoch`, telling `tell` once it's written.
    fn life_write(&self, character: CharacterId, epoch: Epoch, home: &SpaceId, life: Value, tell: Option<Conn>) -> LifeWrite {
        LifeWrite { character, epoch, life, space: self.saved_space(home), writer: self.writer(), tell }
    }

    /// Someone leaves this game for another, taken out whole, as they are: who they are, their player
    /// and their life.
    pub fn take(&mut self, character: CharacterId) -> Option<(Member, Carried)> {
        if !self.members.contains_key(&character) || self.players.open_view(client(character)).is_none() {
            return None;
        }
        self.drop_off(character);
        self.left_tables(character);
        let member = self.members.remove(&character)?;
        let (player, life) = self.players.leave(client(character))?;
        let life = life?;
        self.say_all(&ToConn::Left { id: client(character) }, None);
        self.emptied(character);
        Some((member, Carried { player, life }))
    }

    /// Someone left: a copy notes when it emptied; bots stay only while someone is here to see them.
    fn emptied(&mut self, character: CharacterId) {
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
    }

    /// Someone arrives from another game, standing at `at` (on whatever is there to stand on).
    pub fn put(&mut self, member: MemberInfo, carried: Carried, at: Spot) {
        let character = member.conn.character;
        let Carried { mut player, life } = carried;
        player.vel = Default::default();
        if self.copy_of().is_none() {
            // Sides are a developer zone's (take_side): in the world everyone is on one.
            player.team = 0;
            // So is trying any build (set_build): here it stays only if this life has earned it.
            let using = Build { skills: player.skills, weapon: player.weapon, abilities: player.abilities, movement: player.movement };
            if !allowed(&using, skill_budget(&life.state)) {
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
        self.lingering.remove(&character);
        self.players.join_open(client(character), character, player, life);
        self.members.insert(character, Member::from_info(member));
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

    /// A resident who isn't online: their houses and farms stand (and are solid) all the same.
    pub fn add_resident(&mut self, character: CharacterId, name: &str, state: &Value) {
        if self.members.contains_key(&character) {
            return;
        }
        self.estates.set_estate(character, name, estate_of(state));
        if let Ok(s) = serde_json::from_value::<LifeState>(state.clone()) {
            make_solid(&mut self.open, character, &s);
        }
    }

    /// This channel's estates (everyone's but `character`'s) and who holds which plot.
    pub fn estates_for(&self, character: CharacterId) -> Estates {
        Estates { estates: self.estates.estates_json(character), claims: self.estates.claims_json() }
    }

    /// Someone arrives from their connection. If their character is already here (another window,
    /// or a quick reconnect) they take it over as it is, which is newer than any save. Returns the
    /// channel's estates and claims for their welcome (a copy has none), and the build they play with.
    pub fn join(&mut self, a: Arrival) -> (Option<Estates>, Value) {
        let character = a.conn.character;
        let c = client(character);
        let mut keep_saved = false;
        self.lingering.retain(|_, l| l.at.elapsed() < LINGER);
        if self.players.open_view(c).is_some() {
            self.players.restart_inputs(c);
            keep_saved = self.members.get(&character).is_some_and(|m| m.keep_saved);
        } else if let Some(l) = self.lingering.remove(&character) {
            self.players.join_open(c, character, l.player, l.life);
        } else {
            let zone = self.zone;
            let mut life = Life::new(zone, None, None);
            let mut player = Player::new(Spawn { x: zone.recipe.spawn.x, z: zone.recipe.spawn.z, facing: zone.recipe.spawn.facing }, 0, Build::default());
            stand_on_ground(&mut player, &self.open);
            if let Some(island) = &a.life
                && let Err(e) = load_island(&mut life, &mut player, &mut self.open, character, island, a.saved_at.unwrap_or(a.now), a.now)
            {
                eprintln!("character {character}: the saved life can't be read ({e}); it is kept as it is, and this visit isn't saved");
                life.toast("Your island couldn't be loaded. It's kept safe on the server, but nothing from this visit will be saved.", "bad");
                keep_saved = true;
            }
            // The build they kept, if the skill points their life has earned still cover it.
            if let Some(b) = a.build.as_ref().and_then(build_from_saved).filter(|b| allowed(b, skill_budget(&life.state))) {
                player.apply_build(b);
            }
            life.after_reset(&mut player);
            if let Some(at) = self.arrival() {
                // Back in a copy they were in: where it's entered (the life was saved outside).
                player.pos.x = at.x;
                player.pos.y = at.y;
                player.pos.z = at.z;
                player.facing = at.facing;
                player.vel = Default::default();
                player.grounded = true;
            } else {
                make_solid(&mut self.open, character, &life.state);
            }
            self.players.join_open(c, character, player, Box::new(life));
        }
        if let Some(cp) = self.copy_mut() {
            cp.empty_since = None;
        }
        let info = MemberInfo { conn: a.conn, name: a.name, dev: a.dev, epoch: a.epoch, party: a.party, home: a.home, keep_saved };
        self.members.insert(character, Member::from_info(info));
        self.refresh_estate(character);
        // A game or a challenge they were in the middle of comes back to their browser.
        self.joined_tables(character);
        // Whatever happened to the claims, this life knows whose plots are whose.
        let held = self.estates.held_by_others(character);
        let mut build = Value::Null;
        if let Some((p, life)) = self.players.open_mut(c) {
            build = build_json(&Build { skills: p.skills, weapon: p.weapon, abilities: p.abilities, movement: p.movement });
            if let Some(life) = life {
                life.plot_owners = held;
            }
        }
        let estates = self.copy_of().is_none().then(|| self.estates_for(character));
        (estates, build)
    }

    /// Someone's connection ended. Unless a newer window already took their seat, they're taken
    /// out, and their life comes back to be written.
    pub fn leave(&mut self, conn: Conn) -> Option<LifeWrite> {
        let character = conn.character;
        if !self.members.get(&character).is_some_and(|m| m.conn.session == conn.session) {
            return None;
        }
        // Riding along with someone, you step out beside their vehicle first: that's where you are.
        self.drop_off(character);
        let m = self.members.remove(&character)?;
        // Challenges are off; a game they're playing waits a while for them (tables.rs).
        self.left_tables(character);
        let (player, life) = self.players.leave(client(character))?;
        let mut life = life?;
        let outside = self.outside();
        let island = outside_of(island_of(&player, &mut life, &mut self.open, character), outside);
        self.say_all(&ToConn::Left { id: client(character) }, None);
        self.emptied(character);
        if m.keep_saved {
            return None;
        }
        let write = self.life_write(character, m.epoch, &m.home, island, None);
        self.lingering.insert(character, Lingering { at: Instant::now(), epoch: m.epoch, home: m.home, player, life, dirty: false });
        Some(write)
    }

    /// A character who lived here was deleted (they can't be playing): their houses, farms and
    /// ships come down for everyone, and their plots are free for the next one.
    pub fn remove_resident(&mut self, character: CharacterId) {
        if self.members.contains_key(&character) {
            return;
        }
        self.lingering.remove(&character);
        let Some(name) = self.estates.estates.get(&character).map(|e| e.name.clone()) else { return };
        // Everyone else's browser takes the buildings down (an empty estate), then forgets them.
        self.say_all(&ToConn::Estate { id: character, name, estate: estate_of(&json!({})) }, None);
        self.estates.remove(character);
        self.say_all(&ToConn::Claims { claims: self.estates.claims_json() }, None);
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
    fn teleport(&mut self, character: CharacterId, x: f64, z: f64, facing: Option<f64>) {
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
            let mut sim = Sim { player: p, world: &self.open, owner: character };
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

    /// Everyone's life as it is this moment, to write (the server is stopping). Games can't go on
    /// without the server: they're called off first, each stake back to its player.
    pub fn lives_now(&mut self) -> Vec<LifeWrite> {
        self.abort_tables();
        let ids: Vec<(i64, Epoch, SpaceId, bool)> = self.members.iter().map(|(id, m)| (*id, m.epoch, m.home.clone(), m.keep_saved)).collect();
        let outside = self.outside();
        let mut out = Vec::new();
        for (id, epoch, home, keep_saved) in ids {
            if keep_saved {
                continue;
            }
            if let Some((p, Some(life))) = self.players.open_mut(client(id)) {
                let island = outside_of(island_of(p, life, &mut self.open, id), outside);
                out.push(self.life_write(id, epoch, &home, island, None));
            }
        }
        // Someone away whose game was paid out since they left.
        let dirty: Vec<i64> = self.lingering.iter().filter(|(_, l)| l.dirty).map(|(id, _)| *id).collect();
        for id in dirty {
            let l = self.lingering.get_mut(&id).expect("there");
            let island = island_of(&l.player, &mut l.life, &mut self.open, id);
            let (epoch, home) = (l.epoch, l.home.clone());
            out.push(self.life_write(id, epoch, &home, island, None));
        }
        out
    }

    pub fn has_players(&self) -> bool {
        !self.members.is_empty()
    }

    /// Inputs from a browser: (sequence number, the low 32 bits of the tick × 16 it drew everyone
    /// else at, the bytes it packed).
    pub fn inputs_seen(&mut self, character: CharacterId, list: impl Iterator<Item = (u32, u32, [u8; ruina_world_api::input::OPEN_INPUT])>) {
        let now = self.tick;
        self.queue_inputs(character, list.map(|(seq, view, raw)| (seq, clock::seen_at(now, view), raw)));
    }

    /// Inputs that see everyone where they are now (the tests').
    pub fn inputs(&mut self, character: CharacterId, list: impl Iterator<Item = (u32, [u8; ruina_world_api::input::OPEN_INPUT])>) {
        self.queue_inputs(character, list.map(|(seq, raw)| (seq, f64::INFINITY, raw)));
    }

    /// Inputs with the (fractional) tick each saw everyone else at. At a table you stay in your
    /// seat: what you press counts as nothing.
    fn queue_inputs(&mut self, character: CharacterId, list: impl Iterator<Item = (u32, f64, [u8; ruina_world_api::input::OPEN_INPUT])>) {
        let seated = self.tables.seated(character);
        let actions = |raw| if seated { Actions::default() } else { open_actions_from(raw) };
        self.players.queue_actions(client(character), list.map(|(seq, view, raw)| (seq, view, actions(raw))));
    }

    /// A command for someone's life, given on input `seq`. The developer panel's only count for
    /// those this server lets use it.
    pub fn command(&mut self, character: CharacterId, seq: u32, c: Command) -> bool {
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
        // theirs: their vehicle isn't in your life, so the game does it.
        if matches!(c, Command::Interact | Command::Exit) && self.players.passenger(client(character)).is_some() {
            self.drop_off(character);
            return true;
        }
        self.players.queue_command(client(character), seq, c);
        true
    }

    /// Climbs into the free seat of `host`'s vehicle nearest you (the driver's is its owner's).
    /// You need to be beside it, on your feet or swimming, with your hands free. True if you're in.
    pub fn ride_along(&mut self, character: CharacterId, host: CharacterId, vehicle: i64) -> bool {
        if host == character {
            return false;
        }
        let Some(name) = self.members.get(&host).map(|m| m.name.clone()) else { return false };
        self.players.ride_along(client(character), host, vehicle, &name)
    }

    /// A passenger steps out beside the vehicle they ride in (or, if it has gone, where they are).
    fn drop_off(&mut self, character: CharacterId) {
        self.players.drop_off(client(character), &self.open);
    }

    /// A new build (skills and loadout) as the browser sent it: used if it is one, and the skill
    /// points this character has earned cover it. The build now in use, or None if it isn't allowed.
    pub fn set_build(&mut self, character: CharacterId, build: &Value) -> Option<Build> {
        // A developer zone is for trying weapons and skills: any build the tree allows.
        let trying = self.copy_of().is_some_and(|c| c.def.developer);
        let (p, life) = self.players.open_mut(client(character))?;
        let budget = if trying { u32::MAX } else { life.map_or(crate::tuning::tuning().skills.start_points, |l| skill_budget(&l.state)) };
        let b = parse_build(build, budget)?;
        p.apply_build(b);
        Some(b)
    }

    /// Starts someone's life over: a fresh one, standing at the spawn. What they had built goes.
    /// Returns the fresh life, to write.
    pub fn reset(&mut self, character: CharacterId) -> Option<LifeWrite> {
        // A game they're playing is called off first: the other player's stake goes back to them.
        self.abort_table_of(character);
        let zone = self.zone;
        let (p, life) = self.players.open_mut(client(character))?;
        let life = life?;
        *life = Life::new(zone, None, None);
        // The quests that earned skill points went with the life: the build stays only if the
        // points a fresh life starts with still cover it.
        let mut build = Build { skills: p.skills, weapon: p.weapon, abilities: p.abilities, movement: p.movement };
        if !allowed(&build, skill_budget(&life.state)) {
            build = Build::default();
        }
        *p = Player::new(Spawn { x: zone.recipe.spawn.x, z: zone.recipe.spawn.z, facing: zone.recipe.spawn.facing }, 0, build);
        stand_on_ground(p, &self.open);
        life.after_reset(p);
        let island = island_of_ref(p, life);
        // Their walls and farm posts go with it: the game's colliders are built again.
        self.rebuild_world();
        let m = self.members.get_mut(&character)?;
        m.life_due = 3;
        m.estate_rev = u64::MAX;
        let (epoch, home) = (m.epoch, m.home.clone());
        self.players.restart_inputs(client(character));
        self.refresh_estate(character);
        Some(self.life_write(character, epoch, &home, island, None))
    }

    /// Everything solid that residents have built, made again from scratch (after a reset).
    fn rebuild_world(&mut self) {
        self.open = match self.copy_of() {
            Some(c) => OpenWorld::instance(c.def, self.zone),
            None => played(self.zone),
        };
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
        if self.copy_of().is_none() {
            for (owner, s) in lists {
                make_solid(&mut self.open, owner, &s);
            }
        }
    }

    /// Works out a member's estate again if their life changed shape, and tells everyone (a copy
    /// of an instance has nobody's estate in it).
    fn refresh_estate(&mut self, character: CharacterId) {
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
            if let Some(e) = self.estates.estates.get(&character) {
                let msg = ToConn::Estate { id: character, name: e.name.clone(), estate: e.estate.clone() };
                self.say_all(&msg, Some(character));
            }
            self.say_all(&ToConn::Claims { claims: self.estates.claims_json() }, None);
            // Who may claim which plot changed for everyone.
            let held: HashMap<i64, BTreeMap<String, String>> = self.members.keys().map(|id| (*id, self.estates.held_by_others(*id))).collect();
            for (owner, life) in self.players.each_life_mut() {
                if let Some(h) = held.get(&owner) {
                    life.plot_owners = h.clone();
                }
            }
        }
    }

    /// One tick: everyone's inputs run, arrows fly, monsters move and slam, and what it produced is
    /// published for the gates. Lives due a save go to `writes`.
    pub fn step(&mut self) -> ruina_world_api::records::TickOut {
        let now = Instant::now();
        let elapsed = (now - self.last_tick).as_secs_f64().min(1.0);
        self.last_tick = now;
        let wall = std::time::SystemTime::now();
        // Everyone's weather runs on the world's clock, so it's the same weather for all of them.
        let world = wall.duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64());
        // Ticks are the world's (clock.rs): a tick that runs late takes the number of its moment.
        let at = clock::world_tick(wall);
        if at > self.tick + 1 {
            self.tick = at - 1;
        }
        self.play_tick(elapsed, world);
        let out = self.publish(now);
        let took = now.elapsed().as_secs_f64() * 1000.0;
        self.step_ms = if self.step_ms == 0.0 { took } else { self.step_ms * 0.9 + took * 0.1 };
        out
    }

    /// A tick of the rules, `elapsed` seconds after the last, with the world's clock at `world`
    /// (seconds since 1970): everyone's inputs run, their lives step, arrows fly, monsters move
    /// and slam. No clock is read here, so the same game given the same ticks plays the same.
    pub fn play_tick(&mut self, elapsed: f64, world: f64) {
        self.tick += 1;
        // Each player may run as many inputs as real time allows (a hair more, so a browser whose
        // clock runs a little fast never builds up a queue), and no more.
        self.players.inputs_per_tick = elapsed * 61.0;
        for (_, life) in self.players.each_life_mut() {
            life.world_clock = Some(world);
        }
        // Everyone's vehicles solid as they stand; then everyone's inputs (bots' as their brains
        // decide), each player stepped against everyone as the tick began, however `stepping` runs
        // them (crates/engine/src/combat.rs); then whoever rides along sits where their seat went.
        self.players.gather_movers(&mut self.open);
        self.drive_bots();
        let stepping = &mut self.stepping;
        self.players.step_by(&mut self.actors, &self.world, self.tick, Some(&mut self.open), |jobs, step| stepping.run(jobs, step));
        self.players.seat_passengers(&self.open);
        // Games' clocks, payouts, and players kept in their seats.
        self.step_tables();
        self.players.step_effects(&mut self.actors);
        let foes = self.players.foes();
        let ground = self.players.ground;
        // In a copy of an instance, its creatures stand on its floor.
        let floor = self.copy_of().map(|c| c.def);
        let ground_at = move |x: f64, z: f64| floor.and_then(|d| d.floor_at(x, z)).unwrap_or_else(|| ground.map_or(0.0, |g| g.height(x, z)));
        let mut done = StepOut::default();
        for _ in 0..(60 / TICK_HZ) {
            done.extend(self.actors.step(&foes, &ground_at, LEAN_SPRING, LEAN_DAMPING, 1.0 / 60.0));
        }
        self.players.apply_slams(&done.slams);
        self.players.apply_foe_hits(&done.hits);
        // Where everyone and everything stood as this tick ends: swings are checked against what
        // their swinger saw.
        self.players.record_history(self.tick, &self.actors);
        self.catch_fallers();
    }

    /// In a copy of an instance, anyone who falls out of it is back where it's entered.
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

    /// In a developer zone, onto a side (0 or 1; the first if none is asked for). Everyone in the
    /// world is on its one side, so this only matters where bots or other admins fight across sides.
    pub fn take_side(&mut self, character: CharacterId, team: Option<u8>) {
        if let Some((p, _)) = self.players.open_mut(client(character)) {
            p.team = team.unwrap_or(0).min(1);
        }
    }

    /// Party or owner changes: whoever's party changed, and this copy's owner.
    pub fn parties(&mut self, changed: &[(CharacterId, Option<PartyId>)], owner: Option<Owner>) {
        for &(c, p) in changed {
            if let Some(m) = self.members.get_mut(&c) {
                m.party = p;
            }
        }
        if let (Some(o), Some(c)) = (owner, self.copy_mut()) {
            c.owner = o;
        }
    }

    /// Whoever is in this copy but doesn't belong is warned, and once their time is up handed back:
    /// the characters to put out now.
    pub fn sweep_copy(&mut self, now: Instant) -> Vec<CharacterId> {
        let Some(c) = self.copy_of() else { return Vec::new() };
        let after = c.expel_after;
        let mut warn = Vec::new();
        let mut out = Vec::new();
        let mut belong = Vec::new();
        let ids: Vec<CharacterId> = self.members.keys().copied().collect();
        for who in ids {
            let c = self.copy_of().expect("a copy");
            if self.may_be_in(who) {
                if c.expel.contains_key(&who) {
                    belong.push(who);
                }
                continue;
            }
            match c.expel.get(&who) {
                Some(t) if now >= *t => out.push(who),
                Some(_) => {}
                None => warn.push(who),
            }
        }
        let name = self.copy_of().map(|c| c.def.name.clone()).unwrap_or_default();
        if let Some(c) = self.copy_mut() {
            for who in &belong {
                c.expel.remove(who);
            }
            for who in &warn {
                c.expel.insert(*who, now + after);
            }
            for who in &out {
                c.expel.remove(who);
            }
        }
        let secs = after.as_secs();
        for who in warn {
            self.toast(who, format!("This copy of {name} belongs to another party: you'll be taken out in {secs} seconds."), "info");
        }
        out
    }
}

/// An island as saved, standing at `outside` instead if it's given (a copy's door).
fn outside_of(mut island: Value, outside: Option<Spot>) -> Value {
    if let Some(o) = outside {
        island["player"] = json!({ "x": o.x, "y": o.y, "z": o.z, "facing": o.facing });
    }
    island
}

/// Stands a player on whatever is under them (terrain, a deck, a roof).
fn stand_on_ground(p: &mut Player, world: &OpenWorld) {
    let hf = world.terrain();
    p.pos.y = ground_at(hf, &world.index, p.pos.x, p.pos.z, hf.height(p.pos.x, p.pos.z) + 1.2, 1.2);
    p.grounded = true;
}

/// Brings to life what a region's or an instance's spawns list (open/spawns.rs), each war-band
/// fighting together.
fn spawn_all(actors: &mut Actors, points: Vec<ruina_engine::yard::SpawnPoint>) {
    for p in points {
        let seed = p.seed.unwrap_or(1);
        if p.band > 0 {
            actors.spawn_in_band(&p.kind, p.x, p.z, p.facing.unwrap_or(0.0), seed, p.band);
        } else {
            actors.spawn(&p.kind, p.x, p.z, seed);
        }
    }
}

/// Makes a life's houses and farm posts solid in the game (each piece once).
pub fn make_solid(world: &mut OpenWorld, owner: i64, state: &LifeState) {
    let mut life = Life::new(world.zone, None, None);
    life.state = state.clone();
    life.make_solid(world, owner);
}

/// Seconds as "1m 20s" (src/engine/life/interact.ts shortTime).
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

/// Takes a saved life up into a fresh Life and player (src/app/save.ts applySave): its state, the
/// time that passed while its owner was away, and where they stood. (The store reads it:
/// crate::store::Db::load_life.)
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
    life.make_solid(world, owner);
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

/// A life put away as it would be saved right now (src/app/save.ts islandData): riding isn't saved,
/// so you're standing beside your vehicle next time. (The store writes it:
/// crate::store::Db::write_lives.)
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

/// A build in the shape the browser keeps one (src/content/build.ts Build), which parse_build reads back.
pub fn build_json(b: &Build) -> Value {
    json!({ "skills": b.skills, "weapon": b.weapon, "abilities": b.abilities, "movement": b.movement })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ruina_world_api::input::OPEN_INPUT;
    use ruina_world_api::records::PlayerState;
    use ruina_world_api::{GateId, SessionId};

    /// A connection for character `id` (session `session`) through gate 1.
    pub(crate) fn conn(id: CharacterId, session: SessionId) -> Conn {
        Conn { gate: GateId(1), character: id, session }
    }

    /// Character `id` called `name` coming in for the first time, with `build` as they kept it.
    pub(crate) fn arrival(id: CharacterId, session: SessionId, name: &str, dev: bool, build: Option<Value>) -> Arrival {
        Arrival {
            conn: conn(id, session),
            name: name.into(),
            dev,
            epoch: Epoch(1),
            party: None,
            home: SpaceId::channel("emberholm", 1),
            life: None,
            build,
            saved_at: None,
            now: 0,
        }
    }

    /// Everything `id`'s browser has been told since last asked, as the JSON it reads.
    pub(crate) fn heard(g: &mut Game, id: CharacterId) -> Vec<Value> {
        let (theirs, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut g.said).into_iter().partition(|(c, _)| c.character == id);
        g.said = rest;
        theirs.into_iter().filter_map(|(_, m)| crate::gate::encode::message(&m)).map(|t| serde_json::from_str(&t).unwrap()).collect()
    }

    #[test]
    fn times_read_like_the_browser_writes_them() {
        assert_eq!(short_time(59.2), "1m 0s");
        assert_eq!(short_time(3600.0 * 3.0 + 60.0), "3h 1m");
        assert_eq!(short_time(5.0), "5s");
    }

    #[test]
    fn a_player_state_has_every_field_the_browser_reads() {
        let g = Game::test();
        let s = g.zone.recipe.spawn;
        let p = Player::new(Spawn { x: s.x, z: s.z, facing: 0.0 }, 0, Build::default());
        let v = serde_json::to_value(PlayerState::of(&p)).unwrap();
        for k in ["pos", "vel", "mode", "jumpsUsed", "cooldowns", "movementCooldowns", "skills", "glider", "gustFrames", "stamina", "staminaDelay", "mp"] {
            assert!(v.get(k).is_some(), "{k}");
        }
        assert_eq!(v["mode"], "normal");
        // The same as the engine's session tells its page, field for field.
        assert_eq!(v, ruina_engine::session::player_state_json(&p));
    }

    #[test]
    fn a_rebuild_makes_everyone_solid_in_the_same_order_whatever_order_they_came_in() {
        // Residents away, each with a scarecrow of their own, written in in two different orders.
        let solids = |order: &[i64]| {
            let mut ch = Game::test();
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
        assert_eq!(first.len(), Game::test().open.index.obstacles.len() + 9);
    }

    /// A channel with one character in it, `build` as they kept it.
    fn channel_with(build: Option<Value>) -> (Game, Value) {
        let mut ch = Game::test();
        let (_, build) = ch.join(arrival(7, 1, "Ada", false, build));
        (ch, build)
    }

    #[test]
    fn a_build_is_held_to_the_points_the_life_has_earned() {
        let three = Build { skills: crate::skills::skills_from(&["sword", "cleave", "whirlwind"]), ..Build::default() };
        let (kept, wanted) = (crate::skills::saved_build(&three), build_json(&three));
        // A newcomer has only the points everyone starts with, too few for three skills: they play
        // with the default build, and their browser is told so.
        let (mut ch, build) = channel_with(Some(kept));
        assert_eq!(build, build_json(&Build::default()));
        assert!(ch.set_build(7, &wanted).is_none());
        // A quest finished is a point earned.
        ch.players.open_mut(client(7)).unwrap().1.unwrap().state.quests.done.push("landfall".into());
        assert_eq!(ch.set_build(7, &wanted).map(|b| b.skills), Some(three.skills));
        assert_eq!(ch.players.open_view(client(7)).unwrap().0.skills, three.skills);
        // Starting the life over takes the quest, and the point, with it.
        let fresh = ch.reset(7).expect("a fresh life");
        assert_eq!((fresh.character, fresh.epoch), (7, Epoch(1)));
        assert_eq!(ch.players.open_view(client(7)).unwrap().0.skills, Build::default().skills);
        // The island's own islanders keep theirs.
        let (_, build) = channel_with(Some(crate::skills::saved_build(&Build::default())));
        assert_eq!(build, build_json(&Build::default()));
    }

    #[test]
    fn a_build_kept_by_id_or_by_index_comes_back_on_the_wire_by_index() {
        let mut dodger = Build { skills: crate::skills::skills_from(&["sword", "dodgeRoll"]), ..Build::default() };
        dodger.movement[1] = crate::tuning::movement_index("dodgeRoll").unwrap();
        // As it's kept now, and as the server kept it before (c3d19c3's row for the same build).
        let by_index: Value = serde_json::from_str(
            r#"{"skills": [4097, 0, 0, 0, 0, 0, 0, 0], "weapon": 0, "movement": [255, 0], "abilities": [255, 255, 255, 255, 255, 255, 255, 255]}"#,
        )
        .unwrap();
        for kept in [crate::skills::saved_build(&dodger), by_index] {
            let (_, build) = channel_with(Some(kept));
            assert_eq!(build, build_json(&dodger));
        }
        // Nothing kept, or nothing that reads as a build: the default one.
        for kept in [None, Some(json!("nonsense"))] {
            assert_eq!(channel_with(kept).1, build_json(&Build::default()));
        }
    }

    #[test]
    fn a_swing_lands_where_its_swinger_saw_the_other_player() {
        // Two players on opposite sides (a developer zone's), a step apart, facing each other.
        let mut ch = Game::test();
        for (id, name) in [(7, "Ada"), (8, "Bo")] {
            ch.join(arrival(id, 1, name, false, None));
        }
        let (x, z) = {
            let p = ch.players.open_view(client(7)).unwrap().0;
            (p.pos.x, p.pos.z)
        };
        let place = |ch: &mut Game, id: i64, dz: f64, facing: f64| {
            let p = ch.players.open_mut(client(id)).unwrap().0;
            (p.pos.x, p.pos.z, p.facing) = (x, z + dz, facing);
            stand_on_ground(p, &ch.open);
        };
        place(&mut ch, 7, 0.0, 0.0);
        place(&mut ch, 8, 1.2, std::f64::consts::PI);
        ch.players.open_mut(client(8)).unwrap().0.team = 1;
        ch.players.record_history(10, &ch.actors);
        // Then Bo steps well away; Ada's screen, a round trip behind, still shows them close.
        place(&mut ch, 8, 7.0, std::f64::consts::PI);
        ch.players.record_history(11, &ch.actors);
        const ATTACK: [u8; OPEN_INPUT] = [0, 0, 4, 0, 0, 0, 0, 0, 0, 0];
        let hp = |ch: &Game| ch.players.open_view(client(8)).unwrap().0.hp;
        let full = hp(&ch);
        let mut seq = 0u32;
        // `view`: the tick × 16 Ada drew everyone else at, or None for the present.
        let mut swing = |ch: &mut Game, view: Option<u32>, from: u64| {
            let list = (1..=48).map(|k| (seq + k, if k == 1 { ATTACK } else { [0; OPEN_INPUT] }));
            match view {
                Some(v) => ch.inputs_seen(7, list.map(|(s, raw)| (s, v, raw))),
                None => ch.inputs(7, list),
            }
            seq += 48;
            ch.players.inputs_per_tick = 12.0;
            for tick in from..from + 4 {
                ch.players.step_in(&mut ch.actors, &ch.world, tick, Some(&mut ch.open));
            }
        };
        // Seeing the present, the swing finds nobody in reach.
        swing(&mut ch, None, 12);
        assert_eq!(hp(&ch), full);
        // Seeing tick 10, it lands where Ada saw Bo.
        swing(&mut ch, Some(10 * 16), 16);
        assert!(hp(&ch) < full, "the rewound swing lands: {} of {full}", hp(&ch));
    }

    #[test]
    fn a_swing_lands_on_a_creature_where_its_swinger_saw_it() {
        // Ada and a slime a step apart, Ada facing it.
        let mut ch = Game::test();
        ch.join(arrival(7, 1, "Ada", false, None));
        let (x, z) = {
            let p = ch.players.open_mut(client(7)).unwrap().0;
            p.facing = 0.0;
            stand_on_ground(p, &ch.open);
            (p.pos.x, p.pos.z)
        };
        let id = ch.actors.list.iter().find(|a| a.kind == "slime").expect("a slime").id;
        let place = |ch: &mut Game, dz: f64| {
            let a = ch.actors.get_mut(id).unwrap();
            (a.x, a.y, a.z) = (x, 0.0, z + dz);
        };
        place(&mut ch, 1.2);
        ch.players.record_history(10, &ch.actors);
        // Then it hops well away; Ada's screen, a round trip behind, still shows it close.
        place(&mut ch, 7.0);
        ch.players.record_history(11, &ch.actors);
        const ATTACK: [u8; OPEN_INPUT] = [0, 0, 4, 0, 0, 0, 0, 0, 0, 0];
        let hp = |ch: &Game| ch.actors.get(id).unwrap().hp;
        let full = hp(&ch);
        let mut seq = 0u32;
        // `view`: the tick × 16 Ada drew everyone else at, or None for the present.
        let mut swing = |ch: &mut Game, view: Option<u32>, from: u64| {
            let list = (1..=48).map(|k| (seq + k, if k == 1 { ATTACK } else { [0; OPEN_INPUT] }));
            match view {
                Some(v) => ch.inputs_seen(7, list.map(|(s, raw)| (s, v, raw))),
                None => ch.inputs(7, list),
            }
            seq += 48;
            ch.players.inputs_per_tick = 12.0;
            for tick in from..from + 4 {
                ch.players.step_in(&mut ch.actors, &ch.world, tick, Some(&mut ch.open));
            }
        };
        // Seeing the present, the swing finds nothing in reach.
        swing(&mut ch, None, 12);
        assert_eq!(hp(&ch), full);
        // Seeing tick 10, it lands where Ada saw the slime, as a swing at a player does.
        swing(&mut ch, Some(10 * 16), 16);
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
        let mut play = |ch: &mut Game, first: [u8; OPEN_INPUT], frames: u32| {
            let inputs: Vec<(u32, [u8; OPEN_INPUT])> = (0..frames).map(|k| (seq + 1 + k, if k == 0 { first } else { [0; OPEN_INPUT] })).collect();
            seq += frames;
            ch.inputs(7, inputs.into_iter());
            ch.players.inputs_per_tick = 12.0;
            for tick in 0..frames.div_ceil(12) {
                ch.players.step_in(&mut ch.actors, &ch.world, tick as u64 + 1, Some(&mut ch.open));
            }
        };
        let xp = |ch: &Game, id: &str| ch.players.open_view(client(7)).unwrap().2.unwrap().state.skill_xp.get(id).copied().unwrap_or(0.0);
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
        let club = crate::tuning::weapon_index("club").unwrap();
        let mut healer = Build { skills: crate::skills::skills_from(&["club", "heal"]), weapon: club, ..Build::default() };
        healer.abilities[0] = crate::tuning::ability_index("heal").unwrap();
        assert!(ch.set_build(7, &build_json(&healer)).is_some());
        play(&mut ch, [0, 0, 0, 0, 0, 1, 0, 0, 0, 0], 150);
        assert_eq!(xp(&ch, "heal"), 1.0);
        assert_eq!(xp(&ch, "club"), 0.0);
    }

    /// The sword's first swing.
    fn tuning_damage() -> f64 {
        let sword = crate::tuning::weapon_index("sword").unwrap();
        crate::tuning::tuning().weapons[usize::from(sword)].combo[0].damage
    }

    #[test]
    fn the_life_its_owner_sees_carries_skill_experience() {
        let g = Game::test();
        let mut life = Life::new(g.zone, None, None);
        let view = |l: &Life| serde_json::to_value(ruina_world_api::records::LifeView::of(l)).unwrap();
        assert_eq!(view(&life)["state"]["skillXp"], json!({}));
        life.state.skill_xp.insert("bow".into(), 42.0);
        assert_eq!(view(&life)["state"]["skillXp"]["bow"], json!(42.0));
    }

    /// Ada (7) with her farm cart out on the west road, and Bo (8) in the same channel.
    fn ada_and_bo() -> (Game, i64) {
        let (mut ch, _) = channel_with(None);
        ch.join(arrival(8, 2, "Bo", false, None));
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

    /// Runs `frames` inputs for everyone (Ada's `ada`, Bo standing still), a tick at a time, as
    /// step() does: everyone's vehicles made solid, everyone moved, passengers seated.
    fn play_both(ch: &mut Game, seq: &mut u32, ada: [u8; OPEN_INPUT], frames: u32) {
        for _ in 0..frames.div_ceil(3) {
            let first = *seq + 1;
            *seq += 3;
            ch.inputs(7, (first..=*seq).map(|s| (s, ada)));
            ch.inputs(8, (first..=*seq).map(|s| (s, [0; OPEN_INPUT])));
            ch.players.inputs_per_tick = 3.0;
            ch.players.gather_movers(&mut ch.open);
            ch.players.step_in(&mut ch.actors, &ch.world, 1, Some(&mut ch.open));
            ch.players.seat_passengers(&ch.open);
        }
    }

    fn cart(ch: &Game, id: i64) -> crate::life::state::Vehicle {
        ch.players.vehicle_of(7, id).expect("Ada's cart is out")
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

    /// A copy of the instance `id`, for everyone allowed in.
    fn copy(id: &str) -> Game {
        Game::copy(SimId(1), crate::open::dungeon::dungeon(id).expect("the instance"), 1, Owner::Everyone)
    }

    #[test]
    fn the_goblin_camp_brings_a_war_band() {
        let g = copy("goblinCamp");
        let goblins: Vec<_> = g.actors.list.iter().filter(|a| a.kind == "goblin").collect();
        assert_eq!(goblins.len(), 6);
        assert!(goblins.iter().all(|a| a.band != 0 && a.band == goblins[0].band), "one band");
    }

    #[test]
    fn the_yard_brings_its_dummy_and_slimes_and_they_stand_on_its_floor() {
        let mut g = copy("yard");
        g.join(arrival(1, 1, "Ada", true, None));
        let kinds: Vec<String> = g.actors.list.iter().map(|a| a.kind.clone()).collect();
        assert_eq!(kinds.iter().filter(|k| *k == "dummy").count(), 1);
        assert_eq!(kinds.iter().filter(|k| *k == "slime").count(), 5);
        for _ in 0..40 {
            g.step();
        }
        // A creature's height is above the ground under it, which in the copy is the yard's floor.
        let yard = crate::open::dungeon::dungeon("yard").unwrap();
        for a in &g.actors.list {
            assert_eq!(yard.floor_at(a.x, a.z), Some(0.0), "{} is over the yard's floor", a.kind);
            assert!(a.y.abs() < 1.0, "{} stands on it ({} above it)", a.kind, a.y);
        }
    }

    #[test]
    fn an_angry_slime_in_the_yard_slams_the_player_beside_it() {
        let mut g = copy("yard");
        g.join(arrival(1, 1, "Ada", true, None));
        let (sx, sz) = {
            let a = g.actors.list.iter_mut().find(|a| a.kind == "slime").unwrap();
            a.angry = 600;
            (a.x, a.z)
        };
        {
            let p = g.players.open_mut(client(1)).unwrap().0;
            (p.pos.x, p.pos.z) = (sx + 1.5, sz);
        }
        let full = g.players.open_view(client(1)).unwrap().0.hp;
        for _ in 0..200 {
            g.step();
            // Stood still in a nearby spot, as a player waiting for it.
            if g.players.open_view(client(1)).unwrap().0.hp < full {
                return;
            }
        }
        panic!("no slam landed");
    }

    #[test]
    fn a_life_saved_in_a_copy_stands_outside_its_door_in_its_home_channel() {
        let def = crate::open::dungeon::dungeon("goblinsDread").unwrap();
        let mut g = Game::copy(SimId(9), def, 4, Owner::Solo(7));
        g.lease = Epoch(3);
        g.join(arrival(7, 1, "Ada", false, None));
        let w = g.leave(conn(7, 1)).expect("a life to write");
        let door = door_into("goblinsDread").unwrap();
        assert_eq!(w.life["player"]["x"].as_f64(), Some(door.outside.x));
        assert_eq!(w.space, SpaceId::channel("emberholm", 1), "its position is in the world");
        assert_eq!(w.writer, Some(Writer { sim: SimId(9), space: SpaceId::copy("goblinsDread", 4), epoch: Epoch(3) }));
        // A window that was replaced leaving takes nobody out.
        g.join(arrival(8, 5, "Bo", false, None));
        assert!(g.leave(conn(8, 4)).is_none());
        assert!(g.members.contains_key(&8));
    }
}
