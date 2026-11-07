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
use ruina_world_api::store::{ClaimResult, LifeWrite, RegionLand, TakeResult, ToStore, Writer};
use ruina_world_api::{CharacterId, Conn, EntityId, Epoch, Owner, PartyId, SimId, SpaceId};

pub use ruina_world_api::TICK_HZ;

use crate::actors::{Actors, LEAN_DAMPING, LEAN_SPRING, StepOut};
use crate::bots::Brain;
use crate::combat::Players;
use crate::directory::EXPEL_AFTER;
use crate::gate::socket::parse_build;
use crate::life::content::clock;
use crate::life::land::{self, Change, Ids, Kind, Land};
use crate::life::market::Market;
use crate::life::progress::skill_budget;
use crate::life::{Command, Life, farming, housing, vehicles};
use crate::minigames::Minigames;
use crate::open::colliders::ground_at;
use crate::open::dungeon::{DungeonDef, door_into};
use crate::open::map::world_map;
use crate::open::spawns::{instance_spawns, region_spawns};
use crate::open::zone::{DungeonDoor, Zone};
use crate::open::{OpenWorld, SIM_BAND, Sim};
use crate::player::{Actions, Build, Mode, Player};
use crate::sim::channels::estate_of;
use crate::sim::lands::Lands;
use crate::skills::{allowed, build_from_saved};
use crate::world::Spawn;

/// Bots: players without a socket, their inputs decided by their brains.
mod bots;
pub use bots::set_bot_limit;
/// What of someone's land everyone else sees.
pub mod channels;
/// The world's clock: ticks numbered from the world's epoch.
pub mod clock;
/// The simulation's thread: its mail, its ticks, players handed between simulations.
pub mod host;
/// The region's land as a simulation shows it: everyone's, lent to its owner or kept for them, and
/// who holds which plot.
pub mod lands;
/// What a tick produced, as records for the gates.
mod publish;
/// How a channel's players are stepped each tick: one after another, or all at once.
pub mod stepping;
/// Mini-games here: challenges, tables and the money on them.
pub(crate) mod tables;

pub use bots::FIRST_BOT;
pub use host::{Sim as SimHost, Threads};

/// A life is written this soon after it changes (a command run, its land reshaped, value moved: a
/// few changes go in one write), and when its owner leaves.
const SAVE_AFTER: Duration = Duration::from_secs(1);
/// And at least this often while its owner plays, changed or not (where they stand, crops growing,
/// labor refilling).
const SAVE_ANYWAY: Duration = Duration::from_secs(60);
/// The world's market is read again this often: every channel's sales are in it.
const MARKET_EVERY: Duration = Duration::from_secs(10);
/// A run of ids with fewer than this left is topped up (a new block from the store).
const LOW_IDS: i64 = 64;
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
    /// Since when their life has changed without being written (None: it hasn't).
    changed: Option<Instant>,
    /// Their life's revision and ledger count when it was last written (or taken up): what changing
    /// means.
    saved_marks: (u64, u64),
    /// A new block of ids is on its way.
    asked_ids: bool,
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
            changed: None,
            saved_marks: (0, 0),
            asked_ids: false,
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
    /// The region's land: everyone's, lent to whoever plays here and kept for everyone else, and who
    /// holds which plot (lands.rs).
    pub lands: Lands,
    pub members: HashMap<CharacterId, Member>,
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
    /// What the store is sent (lives to write, claims, sales...), in the order it was said: one
    /// character's writes must reach it in the order they were made.
    pub store: Vec<ToStore>,
    /// Bots playing here (bots.rs), and how many have ever joined (their ids and names count on).
    pub(crate) bots: Vec<bots::BotSlot>,
    bot_count: u32,
    /// How long a tick takes to run (ms, smoothed), for the admins' stats.
    step_ms: f64,
    /// Each tick since the last stats: its rules and its publishing, ms (the stats carry them, for
    /// load tests: crates/tools/src/bin/loadtest.rs).
    timed: Vec<[f32; 2]>,
    /// How its players are stepped each tick (the server's `--parallel`).
    pub stepping: stepping::Stepping,
    /// The trading posts' demand: the world's (the store's), read again every MARKET_EVERY, lowered
    /// here at once by every sale here (and in the store too); every life here reads it.
    pub market: Market,
    /// When the world's market was last asked for.
    market_asked: Instant,
    /// When each player last struck a blow or took one (ms since 1970): in a fight, the channels'
    /// policy won't move them (crates/channels).
    fought: HashMap<CharacterId, ruina_world_api::Millis>,
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
        g.lands.loaded = true;
        g.space = Space::Copy(CopyOf { def, door, owner, empty_since: Some(Instant::now()), expel: HashMap::new(), expel_after: EXPEL_AFTER });
        g
    }

    fn playing(sim: SimId, at: SpaceId, zone: &'static Zone, open: OpenWorld, actors: Actors) -> Game {
        let mut players = Players::new(1000.0 / TICK_HZ as f64);
        players.ground = Some(&zone.terrain);
        Game {
            sim,
            at,
            lease: Epoch::default(),
            space: Space::Channel,
            zone,
            lingering: HashMap::new(),
            lands: Lands::default(),
            members: HashMap::new(),
            open,
            players,
            actors,
            tick: 0,
            last_tick: Instant::now(),
            tables: Minigames::default(),
            started: Instant::now(),
            skew: 0.0,
            said: Vec::new(),
            store: Vec::new(),
            bots: Vec::new(),
            bot_count: 0,
            step_ms: 0.0,
            timed: Vec::new(),
            stepping: stepping::Stepping::chosen(),
            market: Market::default(),
            market_asked: Instant::now(),
            fought: HashMap::new(),
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
        // Their land stands here while they're away, as they left it.
        if self.copy_of().is_none() {
            self.lands.keep(character, &member.name, life.land.clone());
        }
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
        let Carried { mut player, mut life } = carried;
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
        go_online(&mut life, self.world_market().as_ref());
        // Their land is theirs to change again: it comes with them, and isn't kept here for them.
        let kept = if self.copy_of().is_none() { self.lands.lend(character) } else { None };
        if self.copy_of().is_none() {
            life.land.make_solid(&mut self.open, character);
        }
        let stale = kept.is_some_and(|k| !same_solid(&k, &life.land));
        let marks = marks(&life);
        self.lingering.remove(&character);
        self.players.join_open(client(character), character, player, life);
        let mut m = Member::from_info(member);
        m.saved_marks = marks;
        self.members.insert(character, m);
        if stale {
            self.rebuild_world();
        }
        if let Some(c) = self.copy_mut() {
            // The first one into an empty copy brings its bots; after that, whatever an admin did
            // with them (sent them away, added more) stands while anyone is in it.
            let first = c.empty_since.take().is_some();
            if first {
                self.zone_bots_in();
            }
        } else {
            let held = self.lands.held_by_others(character);
            if let Some((_, Some(life))) = self.players.open_mut(client(character)) {
                life.plot_owners = held;
            }
            self.refresh_estate(character);
        }
    }

    /// The region's land as the store read it: everyone's kept here for them, standing and solid, who
    /// holds which plot, and the world's market. Whoever is already here (nobody, as arrivals wait
    /// for it) keeps their own.
    pub fn land_read(&mut self, r: RegionLand) {
        let (mut lands, market) = Lands::read(r);
        for id in self.members.keys() {
            lands.lend(*id);
        }
        self.lands = lands;
        self.set_market(market);
        self.rebuild_world();
    }

    /// This channel's estates (everyone's but `character`'s) and who holds which plot.
    pub fn estates_for(&self, character: CharacterId) -> Estates {
        Estates { estates: self.lands.estates_json(character), claims: self.lands.claims_json() }
    }

    /// The world's market, for a life playing in the world (a copy of an instance has none).
    fn world_market(&self) -> Option<Market> {
        self.copy_of().is_none().then(|| self.market.clone())
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
            // What they place is named from the world's ids (a block the store gave them).
            if let Some((next, end)) = a.ids {
                life.land.ids = Ids { next, end };
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
                make_solid(&mut self.open, character, &life.land);
            }
            self.players.join_open(c, character, player, Box::new(life));
        }
        if let Some(cp) = self.copy_mut() {
            cp.empty_since = None;
        }
        // Their land is theirs to change while they play here: lent to their life, kept here no longer.
        let kept = if self.copy_of().is_none() { self.lands.lend(character) } else { None };
        let mut marks_now = (0, 0);
        let mut stale = false;
        let market = self.world_market();
        if let Some((_, Some(life))) = self.players.open_mut(c) {
            go_online(life, market.as_ref());
            marks_now = marks(life);
            stale = kept.is_some_and(|k| !same_solid(&k, &life.land));
        }
        let info = MemberInfo { conn: a.conn, name: a.name, dev: a.dev, epoch: a.epoch, party: a.party, home: a.home, keep_saved };
        let mut m = Member::from_info(info);
        m.saved_marks = marks_now;
        self.members.insert(character, m);
        if stale {
            self.rebuild_world();
        }
        self.refresh_estate(character);
        // A game or a challenge they were in the middle of comes back to their browser.
        self.joined_tables(character);
        // Whatever happened to the claims, this life knows whose plots are whose.
        let held = self.lands.held_by_others(character);
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
        // Their land stands here while they're away, as they left it.
        if self.copy_of().is_none() {
            self.lands.keep(character, &m.name, life.land.clone());
        }
        self.say_all(&ToConn::Left { id: client(character) }, None);
        self.emptied(character);
        if m.keep_saved {
            return None;
        }
        let write = self.life_write(character, m.epoch, &m.home, island, None);
        self.lingering.insert(character, Lingering { at: Instant::now(), epoch: m.epoch, home: m.home, player, life, dirty: false });
        Some(write)
    }

    /// A character was deleted (they can't be playing): their land comes down for everyone, and
    /// their plots are free for the next one.
    pub fn character_gone(&mut self, character: CharacterId) {
        if self.members.contains_key(&character) {
            return;
        }
        self.lingering.remove(&character);
        let name = self.lands.estates.get(&character).map(|(n, _)| n.clone());
        if !self.lands.forget(character) {
            return;
        }
        // Everyone else's browser takes the buildings down (an empty estate), then forgets them.
        if let Some(name) = name {
            self.say_all(&ToConn::Estate { id: character, name, estate: estate_of(&Land::default()) }, None);
        }
        self.tell_claims();
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
        // Whatever it does is written a moment after it runs.
        m.changed.get_or_insert_with(Instant::now);
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
        let market = self.world_market();
        let (p, life) = self.players.open_mut(client(character))?;
        let life = life?;
        // The plots their houses stood on are free (the save without them lets them go in the store).
        let plots: Vec<String> = life.land.plots().map(String::from).collect();
        // The run of ids stays theirs: ids are the world's.
        let ids = life.land.ids;
        *life = Life::new(zone, None, None);
        life.land.ids = ids;
        go_online(life, market.as_ref());
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
        let mut freed = false;
        for plot in plots {
            freed |= self.lands.freed(&plot, character);
        }
        if freed {
            self.tell_claims();
        }
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

    /// Everything solid that anyone's land holds, made again from scratch (after a reset, or a
    /// house taken down).
    fn rebuild_world(&mut self) {
        self.open = match self.copy_of() {
            Some(c) => OpenWorld::instance(c.def, self.zone),
            None => played(self.zone),
        };
        let mut lists: Vec<(i64, Land)> = Vec::new();
        for (_, owner, _, life) in self.players.each_open() {
            if let Some(l) = life {
                lists.push((owner, l.land.clone()));
            }
        }
        for (id, h) in &self.lands.away {
            if !self.members.contains_key(id) {
                lists.push((*id, h.land.clone()));
            }
        }
        // By owner: the players are kept in slots, whose order depends on who came first, and
        // colliders added in another order are found in another order.
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
        let estate = estate_of(&life.land);
        if let Some(m) = self.members.get_mut(&character) {
            m.estate_rev = rev;
        }
        if self.lands.set_estate(character, &name, estate)
            && let Some((name, estate)) = self.lands.estates.get(&character).cloned()
        {
            self.say_all(&ToConn::Estate { id: character, name, estate }, Some(character));
        }
    }

    /// Everyone here hears who holds which plot, and each life knows whose plots it can't claim.
    fn tell_claims(&mut self) {
        if self.copy_of().is_some() {
            return;
        }
        self.say_all(&ToConn::Claims { claims: self.lands.claims_json() }, None);
        let held: HashMap<i64, BTreeMap<String, String>> = self.members.keys().map(|id| (*id, self.lands.held_by_others(*id))).collect();
        for (owner, life) in self.players.each_life_mut() {
            if let Some(h) = held.get(&owner) {
                life.plot_owners = h.clone();
            }
        }
    }

    /// The world's market as the store has it: every life here reads it from now on.
    pub fn set_market(&mut self, market: Market) {
        self.market = market;
        if self.copy_of().is_some() {
            return;
        }
        let market = &self.market;
        for (_, life) in self.players.each_life_mut() {
            life.market = market.clone();
        }
    }

    /// The registry's word on a plot `character` claimed: theirs to build on; someone else's first
    /// (their house comes down, the blueprint back in their bag); or not taken just now (the same, to
    /// try again).
    pub fn claim_result(&mut self, character: CharacterId, plot: &str, result: ClaimResult) {
        let Some(life) = self.life_here(character) else { return };
        let mut freed = false;
        match &result {
            ClaimResult::Yours => housing::confirm_claim(life, plot),
            ClaimResult::Theirs { name, .. } => freed = housing::lose_claim(life, plot, name),
            ClaimResult::Stale => freed = housing::claim_failed(life, plot),
        }
        let changed = match result {
            ClaimResult::Yours => false,
            ClaimResult::Theirs { holder, name } => self.lands.claimed(plot, holder, &name),
            ClaimResult::Stale => self.lands.freed(plot, character),
        };
        self.save_soon(character);
        if changed {
            self.tell_claims();
        }
        if freed {
            self.rebuild_world();
        }
    }

    /// A new run of ids for what `character` places.
    pub fn ids_given(&mut self, character: CharacterId, next: i64, end: i64) {
        if let Some(m) = self.members.get_mut(&character) {
            m.asked_ids = false;
        }
        if let Some(life) = self.life_here(character) {
            life.land.ids = Ids { next, end };
        }
    }

    /// The ledger has `character`'s entries up to `upto`: their life holds them no longer.
    pub fn recorded(&mut self, character: CharacterId, upto: u64) {
        if let Some(life) = self.life_here(character) {
            life.recorded(upto);
        }
    }

    /// `by` acts on piece `piece` of `owner`'s land (a pack left on the ground, a vehicle left out).
    /// One authority at a time: while `owner` plays here their life alone changes it, so this does
    /// nothing; otherwise the store gives it to the first who asks, from any channel, and only while
    /// `owner` isn't playing anywhere (`piece_taken` hears which). (No action does this yet: it's how
    /// one would, a thief's or a borrowed cart's.)
    pub fn take_piece(&mut self, by: CharacterId, owner: CharacterId, piece: i64) -> bool {
        if by == owner || self.members.contains_key(&owner) {
            return false;
        }
        let Some(epoch) = self.members.get(&by).map(|m| m.epoch) else { return false };
        self.store.push(ToStore::TakePiece { piece, owner, by, epoch, reply: self.sim });
        true
    }

    /// What became of `by` taking a piece of `owner`'s land: theirs now (into their life, standing
    /// where it was, and out of what's kept here for `owner`), or not.
    pub fn piece_taken(&mut self, by: CharacterId, owner: CharacterId, result: TakeResult) {
        let rows = match result {
            TakeResult::Yours(rows) => rows,
            TakeResult::Lent => return self.toast(by, "Its owner has it in hand.", "bad"),
            TakeResult::Gone => return self.toast(by, "Someone else got there first.", "bad"),
            TakeResult::Stale => return,
        };
        let (got, _) = Land::from_rows(rows.into_iter().filter_map(|(k, d)| Kind::named(&k).map(|k| (k, d))));
        let ids: Vec<i64> = got.packs.iter().map(|p| p.id).chain(got.vehicles.iter().map(|v| v.id)).collect();
        if let Some(h) = self.lands.away.get_mut(&owner) {
            h.land.packs.retain(|p| !ids.contains(&p.id));
            h.land.vehicles.retain(|v| !ids.contains(&v.id));
        }
        let Some(life) = self.life_here(by) else { return };
        life.land.packs.extend(got.packs);
        life.land.vehicles.extend(got.vehicles);
        life.revision += 1;
        self.save_soon(by);
    }

    /// Whether `character`'s life is here (playing, or just gone).
    pub fn has_life(&self, character: CharacterId) -> bool {
        self.members.contains_key(&character) || self.lingering.contains_key(&character)
    }

    /// The life of someone playing here, or who left a moment ago.
    fn life_here(&mut self, character: CharacterId) -> Option<&mut Life> {
        if self.members.contains_key(&character) {
            return self.players.open_mut(client(character)).and_then(|(_, l)| l);
        }
        self.lingering.get_mut(&character).map(|l| &mut *l.life)
    }

    /// `character`'s life is written on the next tick (their land changed in a way others may build
    /// on at once: a plot let go).
    fn save_soon(&mut self, character: CharacterId) {
        if let Some(m) = self.members.get_mut(&character) {
            m.changed = Some(Instant::now() - SAVE_AFTER);
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
        self.note_fights(crate::store::now_ms());
        // The world's market, with every channel's sales, read again now and then.
        if self.copy_of().is_none() && now - self.market_asked >= MARKET_EVERY {
            self.market_asked = now;
            self.store.push(ToStore::LoadMarket { reply: self.sim });
        }
        let ruled = Instant::now();
        let out = self.publish(now);
        let took = now.elapsed().as_secs_f64() * 1000.0;
        self.step_ms = if self.step_ms == 0.0 { took } else { self.step_ms * 0.9 + took * 0.1 };
        if self.timed.len() < 4 * STATS_EVERY as usize {
            let rules = (ruled - now).as_secs_f64() * 1000.0;
            self.timed.push([rules as f32, (took - rules) as f32]);
        }
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
        self.players.step_by(&mut self.actors, self.tick, &mut self.open, |jobs, step| stepping.run(jobs, step));
        self.players.seat_passengers(&self.open);
        // What the steps did to the land and the market here: sales lower everyone's demand.
        self.keep_land();
        // Once a second, the land kept for those away on the world's clock: a house whose tax went
        // unpaid too long comes down, in every channel at the same moment.
        if self.tick.is_multiple_of(TICK_HZ as u64) {
            self.neglect(world);
        }
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

    /// What everyone's steps this tick did that the region's land and the world's market must hear:
    /// each pack sold lowers the demand for it here at once (every life here then reads it) and in the
    /// store; a plot claimed goes to the registry (it counts here at once, until the registry says);
    /// a plot let go (its house taken down for its unpaid tax) is free, and its owner's life is
    /// written at once, so the store lets it go before anyone here can claim it.
    fn keep_land(&mut self) {
        let mut changes: Vec<(i64, Change)> = Vec::new();
        for (owner, life) in self.players.each_life_mut() {
            changes.extend(life.take_changes().into_iter().map(|c| (owner, c)));
        }
        if changes.is_empty() {
            return;
        }
        changes.sort_by_key(|(owner, _)| *owner);
        let (mut sold, mut freed, mut claims) = (false, false, false);
        for (owner, c) in changes {
            match c {
                Change::Sold { outpost, pack, at } => {
                    self.market.sell(&outpost, &pack, at);
                    self.store.push(ToStore::Sold { outpost, pack, at });
                    sold = true;
                }
                Change::Freed { plot } => {
                    claims |= self.lands.freed(&plot, owner);
                    freed = true;
                    self.save_soon(owner);
                }
                Change::Claimed { plot, house } => {
                    let Some(m) = self.members.get(&owner) else { continue };
                    let (epoch, name) = (m.epoch, m.name.clone());
                    let Some((_, _, Some(life))) = self.players.open_view(client(owner)) else { continue };
                    let Some(h) = life.land.houses.iter().find(|h| h.id == house) else { continue };
                    let house = serde_json::to_value(h).unwrap_or(Value::Null);
                    claims |= self.lands.claimed(&plot, owner, &name);
                    self.store.push(ToStore::ClaimPlot { character: owner, epoch, plot, house, reply: self.sim });
                }
            }
        }
        if sold {
            let market = self.market.clone();
            self.set_market(market);
        }
        if claims {
            self.tell_claims();
        }
        if freed {
            self.rebuild_world();
        }
    }

    /// The land kept here for those away, at `world` on the world's clock: a house whose tax went
    /// unpaid too long comes down, its plot free (crate::life::housing::neglected). The region's
    /// keeper (its first channel) has the store take it down too.
    fn neglect(&mut self, world: f64) {
        if self.copy_of().is_some() {
            return;
        }
        let gone = self.lands.neglected(world);
        if gone.is_empty() {
            return;
        }
        let mut owners: Vec<CharacterId> = gone.iter().map(|(o, _)| *o).collect();
        owners.dedup();
        for owner in owners {
            if let Some((name, estate)) = self.lands.estates.get(&owner).cloned() {
                self.say_all(&ToConn::Estate { id: owner, name, estate }, None);
            }
        }
        self.tell_claims();
        self.rebuild_world();
        if matches!(self.at, SpaceId::Channel { n: 1, .. })
            && let Some(writer) = self.writer()
        {
            self.store.push(ToStore::TakeDown { houses: gone.iter().map(|(_, h)| h.id).collect(), at: world, writer });
        }
    }

    /// Whoever struck a blow or took one this tick, at `now` (ms since 1970).
    fn note_fights(&mut self, now: ruina_world_api::Millis) {
        use crate::combat::{EVENT_YOU_HIT, EVENT_YOU_HURT};
        for id in self.members.keys() {
            let Some(slot) = self.players.slot_index(client(*id)) else { continue };
            if self.players.told(slot).iter().any(|e| matches!(e.kind & 0xF, EVENT_YOU_HIT | EVENT_YOU_HURT)) {
                self.fought.insert(*id, now);
            }
        }
        let members = &self.members;
        self.fought.retain(|id, _| members.contains_key(id));
    }

    /// What a player is doing, as far as changing channel goes (crates/channels): a pack on their
    /// back, their last blow, knocked down, riding, in the air, at a table.
    pub fn standing(&self, character: CharacterId) -> ruina_channels::Standing {
        let c = client(character);
        let Some((p, _, _)) = self.players.open_view(c) else { return ruina_channels::Standing::default() };
        ruina_channels::Standing {
            pack: p.pack != 0,
            fought: self.fought.get(&character).copied(),
            down: p.down_frame >= 0,
            riding: p.mode == Mode::Ride || self.players.passenger(c).is_some(),
            airborne: p.mode == Mode::Glide || (!p.grounded && p.mode != Mode::Swim && p.mode != Mode::Ride),
            seated: self.tables.seated(character),
        }
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
fn spawn_all(actors: &mut Actors, points: Vec<ruina_engine::open::spawns::SpawnPoint>) {
    for p in points {
        let seed = p.seed.unwrap_or(1);
        if p.band > 0 {
            actors.spawn_in_band(&p.kind, p.x, p.z, p.facing.unwrap_or(0.0), seed, p.band);
        } else {
            actors.spawn(&p.kind, p.x, p.z, seed);
        }
    }
}

/// Makes someone's houses and farm posts solid in the game (each piece once).
pub fn make_solid(world: &mut OpenWorld, owner: i64, land: &Land) {
    land.make_solid(world, owner);
}

/// Whether two holdings make the same things solid (else the colliders are built again).
fn same_solid(a: &Land, b: &Land) -> bool {
    a.houses == b.houses && a.scarecrows == b.scarecrows
}

/// A life as it plays online: its claims wait for the registry, and in the world its market is the
/// world's.
fn go_online(life: &mut Life, market: Option<&Market>) {
    life.claims_wait = true;
    if let Some(m) = market {
        life.market = m.clone();
    }
}

/// What a life's being changed is told by: its revision (its land's shape) and its ledger's count
/// (value moved).
fn marks(life: &Life) -> (u64, u64) {
    (life.revision, life.state.entries)
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
    let (state, mut land) = land::read_saved(island)?;
    if land::kept_inside(island) {
        land.rebase(saved_at as f64 / 1000.0 - state.clock);
    }
    life.load(state, land);
    // The land's clock is the world's from here on (the channel sets it every tick).
    life.world_clock = Some(now as f64 / 1000.0);
    for v in &mut life.land.vehicles {
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
            let v = life.land.vehicles[i].clone();
            let (x, y, z, _) = vehicles::exit_spot(&sim, &v);
            at = (x, y, z);
        }
    }
    json!({ "state": life.state, "land": life.land, "player": { "x": at.0, "y": at.1, "z": at.2, "facing": p.facing } })
}

fn island_of_ref(p: &Player, life: &Life) -> Value {
    json!({ "state": life.state, "land": life.land, "player": { "x": p.pos.x, "y": p.pos.y, "z": p.pos.z, "facing": p.facing } })
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
            ids: None,
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

    // ---- The region's land (R10.21) ----

    use crate::life::housing::demolished_at;
    use crate::life::land::{House, Pack};
    use crate::life::state::LIFE_VERSION;

    fn cottage(id: i64, plot: &str, tax_paid_until: f64) -> House {
        House { id, plot: plot.into(), blueprint: "cottage".into(), tax_paid_until, ..House::default() }
    }

    /// A channel whose region holds `land` for each (owner, name), the plots their houses stand on
    /// held by them, as the store read it.
    fn with_land(sim: u32, n: u32, owners: Vec<(CharacterId, &str, Land)>) -> Game {
        let mut ch = Game::channel(SimId(u64::from(sim)), "emberholm", n);
        let claims = owners.iter().flat_map(|(o, name, l)| l.houses.iter().map(move |h| (h.plot.clone(), *o, name.to_string()))).collect();
        let holdings = owners.into_iter().map(|(o, name, l)| (o, name.to_string(), serde_json::to_value(l).unwrap())).collect();
        ch.land_read(RegionLand { holdings, claims, market: json!({}) });
        ch
    }

    fn life_of(ch: &mut Game, id: CharacterId) -> &mut Life {
        ch.players.open_mut(client(id)).unwrap().1.unwrap()
    }

    /// What the store has been sent, taken.
    fn told_store(ch: &mut Game) -> Vec<ToStore> {
        std::mem::take(&mut ch.store)
    }

    #[test]
    fn the_regions_land_stands_for_those_away_and_is_lent_to_whoever_comes_to_play() {
        let ada = Land { houses: vec![cottage(1024, "rise-1", 1e12)], ..Land::default() };
        let mut ch = with_land(1, 1, vec![(7, "Ada", ada.clone())]);
        // Her house stands while she's away: solid, and in Bo's welcome, with her plot.
        assert!(ch.open.added.iter().any(|k| k.starts_with("7:")));
        let (estates, _) = ch.join(arrival(8, 1, "Bo", false, None));
        let estates = estates.unwrap();
        assert_eq!((estates.estates[0]["id"].clone(), estates.estates[0]["name"].clone()), (json!(7), json!("Ada")));
        assert_eq!(estates.claims, json!({ "rise-1": "Ada" }));
        assert_eq!(life_of(&mut ch, 8).plot_owners.get("rise-1").map(String::as_str), Some("Ada"));
        // She comes to play: her land is lent to her life (as the store hands it over, with a block of
        // ids), and kept here for her no longer.
        let mut a = arrival(7, 2, "Ada", false, None);
        a.life = Some(json!({ "state": { "version": LIFE_VERSION }, "land": ada, "player": {} }));
        a.ids = Some((2048, 3072));
        ch.join(a);
        assert!(!ch.lands.away.contains_key(&7));
        let life = life_of(&mut ch, 7);
        assert_eq!(life.land.houses.len(), 1);
        assert_eq!((life.land.ids.next, life.land.ids.end), (2048, 3072));
        assert!(life.claims_wait, "her claims wait for the registry");
        // She goes: written with her land beside her life, and kept here for her again.
        let w = ch.leave(conn(7, 2)).unwrap();
        assert_eq!(w.life["land"]["houses"][0]["plot"], "rise-1");
        assert_eq!(ch.lands.away[&7].land.houses.len(), 1);
        assert!(ch.lands.estates.contains_key(&7), "still standing for Bo");
    }

    #[test]
    fn a_house_put_on_a_plot_is_claimed_through_the_registry() {
        let mut ch = with_land(1, 1, Vec::new());
        ch.join(arrival(7, 1, "Ada", false, None));
        ch.join(arrival(8, 1, "Bo", false, None));
        let place = |ch: &mut Game, plot: &str| {
            let (p, life) = ch.players.open_mut(client(7)).unwrap();
            let life = life.unwrap();
            life.give("blueprint.cottage", 1, true);
            let mut sim = Sim { player: p, world: &ch.open, owner: 7 };
            assert!(housing::place_house(life, &mut sim, plot, "blueprint.cottage"));
            ch.keep_land();
        };
        // Ada puts a house on rise-2: the registry hears of it, and here it's hers at once.
        place(&mut ch, "rise-2");
        let asked = told_store(&mut ch);
        assert!(matches!(&asked[..], [ToStore::ClaimPlot { character: 7, epoch: Epoch(1), plot, reply: SimId(1), .. }] if plot == "rise-2"));
        assert_eq!(life_of(&mut ch, 8).plot_owners.get("rise-2").map(String::as_str), Some("Ada"));
        assert!(heard(&mut ch, 8).iter().any(|m| m["t"] == "claims" && m["claims"]["rise-2"] == "Ada"));
        // Someone in another channel had claimed it first: her house comes down, her blueprint back.
        ch.claim_result(7, "rise-2", ClaimResult::Theirs { holder: 9, name: "Cy".into() });
        assert!(life_of(&mut ch, 7).land.houses.is_empty());
        assert_eq!(life_of(&mut ch, 7).count("blueprint.cottage"), 1);
        assert_eq!(ch.lands.claims_json(), json!({ "rise-2": "Cy" }));
        assert_eq!(life_of(&mut ch, 8).plot_owners.get("rise-2").map(String::as_str), Some("Cy"));
        // Another the registry couldn't take just now: down again, the plot free, to try again.
        place(&mut ch, "rise-4");
        ch.claim_result(7, "rise-4", ClaimResult::Stale);
        assert!(life_of(&mut ch, 7).land.houses.is_empty());
        assert!(!ch.lands.claims.contains_key("rise-4"));
        // And one the registry has: the house is hers to build.
        place(&mut ch, "rise-3");
        told_store(&mut ch);
        ch.claim_result(7, "rise-3", ClaimResult::Yours);
        assert!(!life_of(&mut ch, 7).land.houses[0].pending);
        assert_eq!(ch.lands.claims_json(), json!({ "rise-2": "Cy", "rise-3": "Ada" }));
    }

    #[test]
    fn a_sale_lowers_the_demand_here_at_once_and_in_the_worlds_market() {
        let mut ch = with_land(1, 1, Vec::new());
        ch.join(arrival(7, 1, "Ada", false, None));
        ch.join(arrival(8, 1, "Bo", false, None));
        let start = life_of(&mut ch, 8).market.demand("westwatch", "harvestCrate", 100.0);
        life_of(&mut ch, 7).change(Change::Sold { outpost: "westwatch".into(), pack: "harvestCrate".into(), at: 100.0 });
        ch.keep_land();
        assert!(matches!(&told_store(&mut ch)[..], [ToStore::Sold { outpost, at, .. }] if outpost == "westwatch" && *at == 100.0));
        assert!(life_of(&mut ch, 8).market.demand("westwatch", "harvestCrate", 100.0) < start, "everyone here reads it");
        // The world's market as the store has it (every channel's sales) replaces it.
        ch.set_market(Market::default());
        assert_eq!(life_of(&mut ch, 8).market.demand("westwatch", "harvestCrate", 100.0), start);
    }

    #[test]
    fn a_life_is_written_a_moment_after_it_changes_and_at_least_every_minute() {
        let mut ch = with_land(1, 1, Vec::new());
        ch.join(arrival(7, 1, "Ada", false, None));
        let t0 = Instant::now();
        let saves = |ch: &mut Game, at: Instant| {
            ch.publish(at);
            told_store(ch).into_iter().filter(|m| matches!(m, ToStore::WriteLives { writes, .. } if writes.len() == 1)).count()
        };
        // Nothing changed since it was taken up: nothing to write.
        assert_eq!(saves(&mut ch, t0), 0);
        // It changes (its land's shape, here): written a second later, alone.
        life_of(&mut ch, 7).revision += 1;
        assert_eq!(saves(&mut ch, t0 + Duration::from_millis(500)), 0);
        assert_eq!(saves(&mut ch, t0 + Duration::from_millis(1600)), 1);
        assert_eq!(saves(&mut ch, t0 + Duration::from_secs(30)), 0);
        // Value moved (a ledger entry): the same.
        life_of(&mut ch, 7).record("purchase", "vendor:mara".into(), -3.0, 0.0, Vec::new(), None);
        assert_eq!(saves(&mut ch, t0 + Duration::from_secs(31)), 0);
        assert_eq!(saves(&mut ch, t0 + Duration::from_millis(32_100)), 1);
        // Unchanged, it's still written once a minute (where they stand, crops growing).
        assert_eq!(saves(&mut ch, t0 + Duration::from_secs(80)), 0);
        assert_eq!(saves(&mut ch, t0 + Duration::from_secs(93)), 1);
        // The ledger has the entry now: the life forgets it.
        ch.recorded(7, 1);
        assert!(life_of(&mut ch, 7).state.ledger.is_empty());
    }

    #[test]
    fn a_run_of_ids_running_low_is_topped_up_from_the_store() {
        let mut ch = with_land(1, 1, Vec::new());
        ch.join(arrival(7, 1, "Ada", false, None));
        life_of(&mut ch, 7).land.ids = Ids { next: 1000, end: 1030 };
        ch.publish(Instant::now());
        ch.publish(Instant::now());
        let asked: Vec<ToStore> = told_store(&mut ch).into_iter().filter(|m| matches!(m, ToStore::ReserveIds { .. })).collect();
        assert!(matches!(&asked[..], [ToStore::ReserveIds { character: 7, reply: SimId(1) }]), "asked once");
        ch.ids_given(7, 4096, 5120);
        assert_eq!(life_of(&mut ch, 7).land.ids, Ids { next: 4096, end: 5120 });
        // A run of its own (offline's, the tests') never runs out.
        life_of(&mut ch, 7).land.ids = Ids::default();
        ch.publish(Instant::now());
        assert!(!told_store(&mut ch).iter().any(|m| matches!(m, ToStore::ReserveIds { .. })));
    }

    #[test]
    fn a_house_left_untaxed_comes_down_in_every_channel_and_the_keeper_writes_it() {
        let h = cottage(1024, "rise-1", 0.0);
        for n in [1, 2] {
            let mut ch = with_land(n, n, vec![(7, "Ada", Land { houses: vec![h.clone()], ..Land::default() })]);
            ch.join(arrival(8, 1, "Bo", false, None));
            heard(&mut ch, 8);
            told_store(&mut ch);
            // Not yet; then on the world's clock, in each channel at the same moment.
            ch.neglect(demolished_at(&h) - 1.0);
            assert_eq!(ch.lands.away[&7].land.houses.len(), 1);
            ch.neglect(demolished_at(&h));
            assert!(ch.lands.away[&7].land.houses.is_empty());
            assert!(!ch.open.added.iter().any(|k| k.starts_with("7:")), "nothing of it solid");
            let told = heard(&mut ch, 8);
            assert!(told.iter().any(|m| m["t"] == "estate" && m["id"] == 7 && m["estate"]["houses"] == json!([])));
            assert!(told.iter().any(|m| m["t"] == "claims" && m["claims"] == json!({})));
            assert_eq!(life_of(&mut ch, 8).plot_owners.get("rise-1"), None);
            // Only the keeper (the first channel) has the store take it down.
            let asked = told_store(&mut ch);
            let took: Vec<&ToStore> = asked.iter().filter(|m| matches!(m, ToStore::TakeDown { houses, .. } if houses == &[1024])).collect();
            assert_eq!(took.len(), usize::from(n == 1), "channel {n}");
        }
    }

    #[test]
    fn a_deleted_characters_land_comes_down_and_their_plots_are_free() {
        let mut ch = with_land(1, 1, vec![(7, "Ada", Land { houses: vec![cottage(1024, "rise-1", 1e12)], ..Land::default() })]);
        ch.join(arrival(8, 1, "Bo", false, None));
        heard(&mut ch, 8);
        ch.character_gone(7);
        assert!(!ch.lands.away.contains_key(&7) && ch.lands.claims.is_empty());
        let told = heard(&mut ch, 8);
        assert!(told.iter().any(|m| m["t"] == "estate" && m["id"] == 7 && m["estate"]["houses"] == json!([])));
        assert!(!ch.open.added.iter().any(|k| k.starts_with("7:")));
    }

    #[test]
    fn a_piece_kept_for_someone_away_is_taken_through_the_store_one_authority_at_a_time() {
        let bale = Pack { id: 2002, def: "flaxBale".into(), at: "ground".into(), x: 5.0, z: 5.0, ..Pack::default() };
        let mut ch = with_land(1, 1, vec![(7, "Ada", Land { packs: vec![bale.clone()], ..Land::default() })]);
        ch.join(arrival(8, 1, "Bo", false, None));
        ch.join(arrival(9, 1, "Cy", false, None));
        // Ada is away: Bo asks the store for her bale (the first to ask, from any channel, has it).
        assert!(ch.take_piece(8, 7, 2002));
        assert!(matches!(&told_store(&mut ch)[..], [ToStore::TakePiece { piece: 2002, owner: 7, by: 8, epoch: Epoch(1), reply: SimId(1) }]));
        // Cy plays here: her life alone changes her land, so nobody takes from it through the store.
        assert!(!ch.take_piece(8, 9, 1));
        assert!(told_store(&mut ch).is_empty());
        // The store gave it to Bo: in his life where it lay, kept here for Ada no longer.
        ch.piece_taken(8, 7, TakeResult::Yours(vec![("pack".into(), serde_json::to_value(&bale).unwrap())]));
        assert_eq!(life_of(&mut ch, 8).land.packs, [bale]);
        assert!(ch.lands.away[&7].land.packs.is_empty());
        // Refused: he hears why, and nothing changes.
        life_of(&mut ch, 8).drain_events();
        ch.piece_taken(8, 7, TakeResult::Gone);
        let said = life_of(&mut ch, 8).drain_events();
        assert!(said.iter().any(|e| matches!(e, crate::life::LifeEvent::Toast { text, .. } if text == "Someone else got there first.")));
        assert_eq!(life_of(&mut ch, 8).land.packs.len(), 1);
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
        // Owners away, each with a scarecrow of their own, kept in two different orders.
        let solids = |order: &[i64]| {
            let mut ch = Game::test();
            for &id in order {
                let land = json!({ "houses": [], "scarecrows": [{ "id": 1, "x": id as f64 * 3.0, "z": -20.0, "rot": 0.0 }], "ships": [] });
                ch.lands.keep(id, &format!("R{id}"), serde_json::from_value(land).unwrap());
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
                ch.players.step_in(&mut ch.actors, tick, &mut ch.open);
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
                ch.players.step_in(&mut ch.actors, tick, &mut ch.open);
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
                ch.players.step_in(&mut ch.actors, tick as u64 + 1, &mut ch.open);
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
            ch.players.step_in(&mut ch.actors, 1, &mut ch.open);
            ch.players.seat_passengers(&ch.open);
        }
    }

    fn cart(ch: &Game, id: i64) -> crate::life::land::Vehicle {
        ch.players.vehicle_of(7, id).expect("Ada's cart is out")
    }

    #[test]
    fn a_friend_rides_along_in_your_cart_and_steps_out_beside_it() {
        let (mut ch, id) = ada_and_bo();
        let seat = |v: &crate::life::land::Vehicle, k: usize| vehicles::anchor_world(v, &crate::life::content::rideable("farmCart").seats[k]);
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
    fn a_tick_packs_everyone_once_and_a_browser_hears_them_on_the_wire() {
        // Ada with her cart and a crate left on the ground, Bo beside her, three bots round them.
        let (mut ch, cart) = ada_and_bo();
        let (x, z) = {
            let (p, life) = ch.players.open_mut(client(7)).unwrap();
            let life = life.unwrap();
            life.land.packs.push(crate::life::land::Pack {
                id: 99,
                def: "ciderCask".into(),
                at: "ground".into(),
                x: p.pos.x + 2.0,
                y: p.pos.y,
                z: p.pos.z,
                ..Default::default()
            });
            (p.pos.x, p.pos.z)
        };
        {
            let p = ch.players.open_mut(client(8)).unwrap().0;
            p.pos.x = x + 4.0;
            p.pos.z = z;
            stand_on_ground(p, &ch.open);
        }
        assert_eq!(ch.spawn_bots(3, crate::bots::Brain::Wanderer, x, z, 0), 3);
        let out = ch.publish(Instant::now());
        // Packed once each, by their ids: the two players, the bots, her cart and her crate.
        let records: Vec<&ruina_wire::Record> = out.frame.records().collect();
        let keys: std::collections::HashSet<u64> = records.iter().map(|r| r.key).collect();
        assert_eq!(keys.len(), records.len(), "nothing twice");
        assert!(keys.contains(&client(7).raw()) && keys.contains(&client(8).raw()));
        let bots = records.iter().filter(|r| matches!(r.intro, ruina_wire::Intro::Player { bot: true, .. })).count();
        assert_eq!(bots, 3);
        let theirs = |kind| records.iter().filter(|r| r.kind() == kind && r.owner == client(7).raw()).count();
        assert_eq!((theirs(ruina_wire::Kind::Vehicle), theirs(ruina_wire::Kind::Item)), (1, 1));
        // Read on the wire where Bo stands (the wire's own viewer; the gate's part is its own
        // tests'), his browser hears Ada by name, her cart and her crate as hers, the bots as bots;
        // never Bo himself.
        let bo = out.private_of(8).expect("Bo's own").you.p.pos;
        let mut viewer = ruina_wire::viewer::Viewer::new(client(8).raw());
        let update = viewer.update(&out.frame, ruina_wire::viewer::View { x: bo.x, z: bo.z }, &[]);
        let mut heard = ruina_wire::heard::Heard::new();
        heard.hear(&update).unwrap().expect("applied");
        let intros: Vec<&ruina_wire::Intro> = heard.ents.values().map(|e| &e.intro).collect();
        assert!(intros.iter().any(|i| matches!(i, ruina_wire::Intro::Player { id: 7, name, bot: false } if &**name == "Ada")));
        assert!(!intros.iter().any(|i| matches!(i, ruina_wire::Intro::Player { id: 8, .. })));
        assert!(intros.iter().any(|i| matches!(i, ruina_wire::Intro::Vehicle { owner: 7, id, .. } if *id == cart)));
        assert!(intros.iter().any(|i| matches!(i, ruina_wire::Intro::Item { owner: 7, id: 99, .. })));
        assert_eq!(intros.iter().filter(|i| matches!(i, ruina_wire::Intro::Player { bot: true, id, .. } if *id < 0)).count(), 3);
        assert_eq!(heard.errors, 0);
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
