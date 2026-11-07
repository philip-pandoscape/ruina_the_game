//! The game as the browser plays it: the rules for one player, in the island or the training yard,
//! as src/engine/engine.ts runs them. You, the creatures and the training range offline (the server
//! decides them online), the island's life, the copies of dungeons you're in; stepped once per fixed
//! frame with what you pressed, and changed from outside only by the named calls below, each the
//! other half of one of the Engine's. What happened comes out as events (crate::event) in the order
//! they happen, and everything the page draws is read off in the shapes src/engine/ reads
//! (`view_text` after each step or call). crates/engine-wasm hands it to the browser, and the
//! headless rules tests (tests/unit/rules) play it as the page does.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::actor::Actor;
use crate::actors::{Actors, Blow, LEAN_DAMPING, LEAN_SPRING};
use crate::ai::{Foe, Sighting};
use crate::event::Event;
use crate::jsmath::{JsMath, len};
use crate::life::land::{self, Change, House, Land, Scarecrow, Vehicle};
use crate::life::market::Market;
use crate::life::progress::Observed;
use crate::life::state::Weather;
use crate::life::state::{LIFE_VERSION, LifeState};
use crate::life::{
    Command, Focus, Life, LifeEvent, OtherPlayer, OthersVehicle, Placement, content::clock, farming, housing, interact, interact::short_time, vehicles,
};
use crate::missiles::Missile;
use crate::open::colliders::ground_at;
use crate::open::dungeon::{Spot, dungeon};
use crate::open::map::{Grown, WorldMap};
use crate::open::spawns::{band_around, instance_spawns};
use crate::open::zone::emberholm;
use crate::open::{Mover, OpenWorld, Sim, traverse};
use crate::player::{Actions, Body, Build, Mode, Player, V3, step_len};
use crate::skills::{Levels, resolve_skills};
use crate::training::{Arrow, Blows, Footing, Meteor, Range, check_hit, targets};
use crate::tuning::tuning;
use crate::world::{Spawn, World};
use crate::yard::{SpawnPoint, YARD_SEED, Yard, island_spawns, yard};

/// A slam only catches someone standing on the ground, not someone jumping over it.
const SLAM_LIFT: f64 = 1.0;

/// The ground you play on: the yard's flat ground with its props, or an island.
pub enum Ground {
    Flat { yard: Yard, world: World },
    Open(Box<OpenWorld>),
}

pub struct Session {
    /// Fixed steps taken so far.
    pub frame: u32,
    /// Offline, frames left of a hit's pause.
    pub hitstop: i32,
    pub player: Player,
    /// Offline, the creatures (online the server's are drawn from its updates).
    pub actors: Actors,
    pub ground: Ground,
    /// The island's life systems, on an island.
    pub life: Option<Life>,
    /// Online the server decides: these rules only predict your own moves.
    pub online: bool,
    /// Offline, the yard's arrows, meteors and heals.
    pub range: Range,
    /// What happened since they were last taken (`take_events`), in order, and the step each
    /// happened in (`frames`, filled in as they're added).
    pub events: Vec<Event>,
    frames: Vec<u32>,
    /// How many of `events` the island has learned from (skills trained, kills counted).
    observed: usize,
    /// Who stands about when the world is built (or reset).
    pub spawns: Vec<SpawnPoint>,
    /// Your skill levels, which every new you takes on.
    pub levels: Vec<u32>,
    /// Offline, fallen out of the bottom of a copy this step: put back where it's entered, facing this way.
    pub placed: Option<f64>,
    dungeon: Option<String>,
    respawn_at: Option<Spot>,
    /// In a copy of an instance, the world you came into it from (its ground, its colliders, what's
    /// been built in it), to come back out to.
    outside: Option<Box<OpenWorld>>,
    /// Offline in a copy, the world's creatures and who stands about it, set aside until you come
    /// back out (the copy brings its own).
    outside_creatures: Option<(Actors, Vec<SpawnPoint>)>,
    /// The instances you've been in a copy of (the tests ask which you're in now).
    visited: BTreeSet<String>,
    /// How many times you've gone from one space to another, so the page reads what's solid again.
    crossings: u32,
    /// Online, where you were drawn from when the server's word on you came (`take_player`), for a
    /// `replay` with nothing to run again.
    drawn_from: Option<V3>,
    /// Online, your life and land as the server last sent them, while the life has moved on from
    /// them (commands run ahead of the server work on a copy); while `is_sent`, the life's are them.
    sent: Option<(LifeState, Land)>,
    is_sent: bool,
}

impl Session {
    /// The island (or the yard), you at its spawn with `build`, and offline whoever stands about it
    /// (with `band`, a war-band of that many of a kind, in the yard's far corner): the Engine's
    /// constructor.
    pub fn new(open_world: bool, online: bool, band: Option<(&str, usize)>, build: Build) -> Session {
        let (ground, mut spawns, spawn) = if open_world {
            let zone = emberholm();
            let s = zone.recipe.spawn;
            // The world holding its home region alone: the page adopts the regions near you as its
            // worker grows them (adopt_region), and drops them behind you.
            (Ground::Open(Box::new(OpenWorld::alone(zone))), island_spawns(&zone.recipe), Spawn { x: s.x, z: s.z, facing: s.facing })
        } else {
            let y = yard(YARD_SEED);
            let (spawns, spawn) = (y.spawns.clone(), y.spawn);
            let world = y.world();
            (Ground::Flat { yard: y, world }, spawns, spawn)
        };
        if let Some((kind, count)) = band.filter(|(_, n)| *n > 0) {
            spawns.extend(band_around(kind, count, 9.0, 10.0, 1, 0x9b1d));
        }
        let player = Player::new(spawn, 0, Build::default());
        let levels = player.levels.clone();
        let mut s = Session {
            frame: 0,
            hitstop: 0,
            player,
            actors: Actors::new(),
            ground,
            life: None,
            online,
            range: Range::default(),
            events: Vec::new(),
            frames: Vec::new(),
            observed: 0,
            spawns,
            levels,
            placed: None,
            dungeon: None,
            respawn_at: None,
            outside: None,
            outside_creatures: None,
            visited: BTreeSet::new(),
            crossings: 0,
            drawn_from: None,
            sent: None,
            is_sent: false,
        };
        s.populate();
        s.player.apply_build(build);
        // Offline on the island, start standing on the ground at the spawn rather than inside the
        // hill (online the server puts you there, the same way).
        if !online && let Some(hf) = s.terrain() {
            let (x, z) = (s.player.pos.x, s.player.pos.z);
            s.settle(x, z, hf.height(x, z));
        }
        if open_world {
            let mut life = Life::new(emberholm(), None, None);
            // Online the server runs the island; this copy only keeps what moves with you moving.
            life.remote = online;
            s.life = Some(life);
        }
        s
    }

    /// The world's ground (none on the yard's flat ground).
    pub fn terrain(&self) -> Option<&WorldMap> {
        terrain_of(&self.ground)
    }

    fn training(&self) -> bool {
        !self.online
    }

    /// What a creature's brain sees of you: nobody while you're knocked down.
    fn sighting(&self) -> Sighting {
        let p = &self.player;
        if p.down_frame >= 0 { Sighting::at(p.pos.x, p.pos.z, false) } else { p.foe(1, 0.0).sighting() }
    }

    /// Offline, whoever stands about this world, spawned afresh (Sim.reset): war-bands share a band.
    fn populate(&mut self) {
        self.actors.clear();
        if !self.training() {
            return;
        }
        self.spawn_all();
    }

    /// Whoever stands about here (`spawns`), into the crowd as it is.
    fn spawn_all(&mut self) {
        let mut bands: BTreeMap<u32, u32> = BTreeMap::new();
        for point in self.spawns.clone() {
            let band = if point.band != 0 { *bands.entry(point.band).or_insert_with(|| self.actors.new_band()) } else { 0 };
            let seen = self.sighting();
            self.actors.spawn_at(&point, band, false, seen);
        }
    }

    // ---------- A step ----------

    /// One fixed step (Engine.step): the rules, then the yard's arrows, meteors and heals against
    /// whatever stands about. What happened is added to `events`.
    pub fn step(&mut self, a: &Actions) {
        self.placed = None;
        self.frame += 1;
        // A region the rules grew on the spot (asked about before the page handed it over) is solid
        // from this step on.
        if let Ground::Open(w) = &mut self.ground
            && w.solid_behind()
        {
            w.make_regions_solid();
        }
        let training = self.training();
        self.player.remember_presses(a);
        // Hit pause (offline): everything freezes briefly when a hit lands. Presses are kept.
        if training && self.hitstop > 0 {
            self.hitstop -= 1;
        } else {
            self.player.count_down(a);
            self.player.aim_assist = training.then(|| targets(&self.actors, footing(&self.ground, &self.dungeon)).iter().map(|t| (t.x, t.z)).collect());
            self.act(a);
            self.take_player_events();
            if training && let Some(step) = self.player.swing_due.take() {
                let above = self.height_above_ground();
                let footing = footing(&self.ground, &self.dungeon);
                if let Some(pause) = check_hit(&mut self.actors, footing, &mut self.events, &mut self.player, &step, above) {
                    self.hitstop = pause;
                }
            }
            self.player.update_crouch_frame();
            self.player.bodies.clear();
            if training {
                let footing = footing(&self.ground, &self.dungeon);
                for a in self.actors.list.iter().filter(|a| a.solid && a.is_alive()) {
                    let y = if footing.raised() { footing.height(a.x, a.z) + a.y } else { a.y };
                    self.player.bodies.push(Body { x: a.x, z: a.z, r: a.radius, y });
                }
            }
            self.integrate();
            if self.player.mode == Mode::Attack {
                self.player.check_shot();
            }
            self.take_player_events();
            if training {
                self.step_actors();
            }
            self.observe();
            if let (Some(life), Ground::Open(world)) = (self.life.as_mut(), &mut self.ground) {
                let revision = life.revision;
                let mut sim = Sim { player: &mut self.player, world, owner: 0 };
                life.step(&mut sim, a);
                // What F does here, for the prompt on screen (the server works it out only when F is pressed).
                life.focus = interact::find_focus(life, &sim);
                // Whatever the step built is solid once it's over, as the server makes it once
                // everyone has stepped (crate::combat).
                if life.revision != revision {
                    life.make_solid(world, 0);
                }
            }
            self.keep_land();
            self.take_player_events();
            self.player.end_step();
        }
        self.catch_fall();
        if training {
            let seen = self.events.len();
            let footing = footing(&self.ground, &self.dungeon);
            let mut blows = Blows { actors: &mut self.actors, player: &self.player, footing, events: &mut self.events };
            self.range.step(&mut blows, seen);
            self.observe();
        }
        self.stamp();
    }

    /// Notes the step the events added since the last time happened in.
    fn stamp(&mut self) {
        self.frames.resize(self.events.len(), self.frame);
    }

    /// What you do this step, by what you're doing (Sim.step's middle).
    fn act(&mut self, a: &Actions) {
        let p = &mut self.player;
        if p.down_frame >= 0 {
            // Knocked down: lie still, then get back up.
            if p.update_down() {
                self.respawn();
            }
            return;
        }
        if p.stun > 0 {
            p.update_stun();
            return;
        }
        match (p.mode, &mut self.ground) {
            (Mode::Action, _) => p.update_action(a),
            (Mode::Cast, _) => p.update_cast(a),
            (Mode::Attack, _) => p.update_attack(a),
            (Mode::Swim, Ground::Open(world)) => traverse::update_swim(&mut Sim { player: p, world, owner: 0 }, a),
            (Mode::Glide, Ground::Open(world)) => traverse::update_glide(&mut Sim { player: p, world, owner: 0 }, a),
            (Mode::Ride, Ground::Open(world)) => {
                if let Some(life) = self.life.as_mut() {
                    life.ride(&mut Sim { player: p, world, owner: 0 }, a);
                }
            }
            (Mode::Normal, Ground::Open(world)) => {
                // In the air with both jumps spent, jump again to open your glider.
                let mut sim = Sim { player: p, world, owner: 0 };
                let q = &*sim.player;
                if !q.grounded && q.jump_buffer > 0 && q.jumps_used >= 2 && traverse::open_glider(&mut sim) {
                    traverse::update_glide(&mut sim, a);
                } else {
                    sim.player.update_normal(a);
                }
            }
            (_, Ground::Flat { .. }) => p.update_normal(a),
        }
    }

    /// Back on your feet: where a copy is entered, or your
    /// team's spawn, standing on the ground there.
    fn respawn(&mut self) {
        let team = match &self.ground {
            Ground::Flat { world, .. } => world.team_spawns[self.player.team as usize & 1],
            Ground::Open(w) => {
                let s = w.zone.recipe.spawn;
                Spawn { x: s.x, z: s.z, facing: s.facing }
            }
        };
        let s = self.respawn_at.map_or(team, |at| Spawn { x: at.x, z: at.z, facing: at.facing });
        self.player.respawn(s);
        if let Ground::Open(w) = &self.ground {
            let hf = w.terrain();
            let near = self.respawn_at.map_or_else(|| hf.height(s.x, s.z), |at| at.y);
            self.player.pos.y = ground_at(hf, &w.index, s.x, s.z, near + 1.2, 1.2);
        }
        self.player.respawned();
    }

    fn integrate(&mut self) {
        match &mut self.ground {
            Ground::Flat { world, .. } => self.player.integrate(world),
            Ground::Open(world) => traverse::integrate_open(&mut Sim { player: &mut self.player, world, owner: 0 }),
        }
    }

    /// How high your feet are over whatever is under you (water counts as a floor).
    fn height_above_ground(&mut self) -> f64 {
        match &mut self.ground {
            Ground::Flat { .. } => self.player.pos.y,
            Ground::Open(world) => traverse::height_above_ground(&Sim { player: &mut self.player, world, owner: 0 }),
        }
    }

    fn take_player_events(&mut self) {
        self.events.append(&mut self.player.events);
    }

    /// Offline, every creature's frame: their blows and
    /// slams land on you as they happen.
    fn step_actors(&mut self) {
        // In a copy of a dungeon or a developer zone, its creatures stand on its floor, as the
        // server's do.
        let foes: Vec<Foe> = if self.player.down_frame >= 0 {
            Vec::new()
        } else {
            let mut f = self.player.foe(1, 0.0);
            f.air = self.height_above_ground();
            vec![f]
        };
        let footing = footing(&self.ground, &self.dungeon);
        let ground = move |x: f64, z: f64| footing.height(x, z);
        let player = &mut self.player;
        let pr = tuning().movement.player_radius;
        let hurt = |player: &mut Player, ev: &mut Vec<Event>, damage: f64, nx: f64, nz: f64, knock: f64| {
            let before = player.hp;
            player.take_hit(damage, nx, nz, knock);
            if player.hp < before {
                ev.push(Event::Hurt { damage: before - player.hp, x: player.pos.x, y: player.pos.y + 1.6, z: player.pos.z });
            }
        };
        self.actors.step_with(&foes, &ground, LEAN_SPRING, LEAN_DAMPING, step_len(), &mut self.events, &mut |b, ev| match b {
            Blow::Slam(s) => {
                ev.push(Event::Slam { x: s.x, y: ground(s.x, s.z), z: s.z, radius: s.radius });
                let (dx, dz) = (player.pos.x - s.x, player.pos.z - s.z);
                let d = len(dx, dz);
                if player.down_frame >= 0 || d > s.radius + pr {
                    return;
                }
                if player.pos.y - ground(player.pos.x, player.pos.z) > SLAM_LIFT {
                    return;
                }
                let nx = if d > 0.01 { dx / d } else { player.facing.js_sin() };
                let nz = if d > 0.01 { dz / d } else { player.facing.js_cos() };
                hurt(player, ev, s.damage, nx, nz, s.knock);
            }
            Blow::Hit(h) => {
                if h.foe == 1 {
                    hurt(player, ev, h.damage, h.nx, h.nz, h.knock);
                }
            }
        });
    }

    /// Offline, the island learns from what just happened: a hit trains the weapon that dealt it, a
    /// cast its ability, a movement skill itself, and a kill counts for the quests.
    fn observe(&mut self) {
        let Some(life) = self.life.as_mut().filter(|_| !self.online) else {
            self.observed = self.events.len();
            return;
        };
        for o in self.events[self.observed..].iter().filter_map(Observed::of) {
            life.observe(o);
        }
        self.observed = self.events.len();
    }

    /// What happened since the last time, in order, each with the step it happened in.
    pub fn take_events(&mut self) -> Vec<(u32, Event)> {
        self.stamp();
        self.observed = 0;
        std::mem::take(&mut self.frames).into_iter().zip(std::mem::take(&mut self.events)).collect()
    }

    /// Offline, fallen out of the bottom of a copy: back where it's entered (the server does this online).
    fn catch_fall(&mut self) {
        if self.online {
            return;
        }
        let Some(def) = self.dungeon.as_deref().and_then(dungeon) else { return };
        if !def.fallen_out(self.player.pos.y) {
            return;
        }
        let a = def.arrival();
        self.place(a.x, a.z, a.facing, Some(a.y));
        self.placed = Some(a.facing);
    }

    // ---------- Named calls: the Engine's writes ----------

    /// Stands you at rest on whatever is solid at (x, z) under `near`.
    fn settle(&mut self, x: f64, z: f64, near: f64) {
        let Ground::Open(w) = &self.ground else { return };
        let y = ground_at(w.terrain(), &w.index, x, z, near + 1.2, 1.2);
        let p = &mut self.player;
        p.pos.x = x;
        p.pos.y = y;
        p.pos.z = z;
        p.prev_pos = p.pos;
        p.grounded = true;
    }

    /// Puts you at (x, z) facing `facing`, on whatever is solid under `from_y` there (by default the
    /// ground, or the floor of the copy you're in), off whatever you were riding, gliding or
    /// swimming in: teleports, and a dungeon's arrival and door.
    pub fn place(&mut self, x: f64, z: f64, facing: f64, from_y: Option<f64>) {
        if self.terrain().is_none() {
            return;
        }
        if self.player.mode == Mode::Ride
            && let (Some(life), Ground::Open(world)) = (self.life.as_mut(), &mut self.ground)
        {
            vehicles::dismount(life, &mut Sim { player: &mut self.player, world, owner: 0 });
        }
        let near = from_y.or(self.floor_here()).unwrap_or_else(|| self.terrain().map_or(0.0, |hf| hf.height(x, z)));
        self.settle(x, z, near);
        let p = &mut self.player;
        p.vel = Default::default();
        p.facing = facing;
        p.prev_facing = facing;
        if p.mode == Mode::Glide || p.mode == Mode::Swim {
            p.mode = Mode::Normal;
        }
    }

    /// Your skills and loadout, as the server switches them: any attack or cast in progress is dropped.
    pub fn set_build(&mut self, b: Build) {
        self.player.apply_build(b);
    }

    /// Your skill levels (in the yard, from what you've earned there; on the island, from your quests).
    pub fn set_levels(&mut self, levels: &[u32]) {
        self.levels = levels.to_vec();
        self.player.set_levels(levels);
    }

    /// A command for the island, run on the next step.
    pub fn command(&mut self, c: Command) {
        if let Some(life) = self.life.as_mut() {
            life.command(c);
        }
    }

    /// Into a copy of a dungeon or developer zone, a space of its own (OpenWorld::instance): the
    /// world you were in set aside, its floors and walls the only things solid round you, and
    /// knocked down in it you get up where it's entered. False if there's no such dungeon here.
    pub fn enter_dungeon(&mut self, id: &str) -> bool {
        let Some(def) = dungeon(id) else { return false };
        if !matches!(self.ground, Ground::Open(_)) {
            return false;
        }
        if self.dungeon.as_deref() == Some(id) {
            return true;
        }
        self.leave_dungeon();
        let Ground::Open(w) = &mut self.ground else { return false };
        let inside = Box::new(OpenWorld::instance(def, w.zone));
        self.outside = Some(std::mem::replace(w, inside));
        self.crossings += 1;
        self.visited.insert(id.to_string());
        self.dungeon = Some(id.to_string());
        self.respawn_at = Some(def.arrival());
        if let Some(life) = self.life.as_mut() {
            life.dungeon = Some(id.to_string());
        }
        // Offline the copy brings its creatures (the server's copy does online), numbered on from
        // the world's, which wait for you outside.
        if self.training() {
            let inside = self.actors.numbering_on();
            let world = std::mem::replace(&mut self.actors, inside);
            let spawns = std::mem::replace(&mut self.spawns, instance_spawns(def));
            self.outside_creatures = Some((world, spawns));
            self.spawn_all();
        }
        true
    }

    /// Out of the copy you're in, back into the world you came from.
    pub fn leave_dungeon(&mut self) {
        if self.dungeon.take().is_none() {
            return;
        }
        if let (Some(outside), Ground::Open(w)) = (self.outside.take(), &mut self.ground) {
            *w = outside;
        }
        self.crossings += 1;
        self.respawn_at = None;
        if let Some(life) = self.life.as_mut() {
            life.dungeon = None;
        }
        if let Some((actors, spawns)) = self.outside_creatures.take() {
            self.actors = actors;
            self.spawns = spawns;
        }
    }

    /// The dungeon or developer zone you're in a copy of.
    pub fn inside(&self) -> Option<&str> {
        self.dungeon.as_deref()
    }

    /// The floor at (x, z) of the copy you're in, where it has one.
    pub fn floor_at(&self, x: f64, z: f64) -> Option<f64> {
        self.dungeon.as_deref().and_then(dungeon).and_then(|d| d.floor_at(x, z))
    }

    /// The floor's height in the copy you're in.
    pub fn floor_here(&self) -> Option<f64> {
        self.dungeon.as_deref().and_then(dungeon).map(|d| d.arrival().y)
    }

    /// Which dungeons have been made solid in your world, and whether they still are (tests).
    pub fn solidity(&self) -> BTreeMap<String, bool> {
        self.visited.iter().map(|k| (k.clone(), self.dungeon.as_deref() == Some(k.as_str()))).collect()
    }

    /// The ground of the space you're in as the page draws it: in a copy of an instance, how far down
    /// the nothing under its floors is and the water (none: under that), null out in the world.
    pub fn space_ground(&self) -> Value {
        match (&self.ground, &self.dungeon) {
            (Ground::Open(w), Some(_)) => json!({ "floor": w.map.sea_floor, "water": w.map.water }),
            _ => Value::Null,
        }
    }

    /// Ground height under a point: a copy's floor where you're in one, the island's terrain, or 0.
    pub fn ground_y(&self, x: f64, z: f64) -> f64 {
        self.floor_at(x, z).unwrap_or_else(|| self.terrain().map_or(0.0, |hf| hf.height(x, z)))
    }

    /// What someone at height `near` would stand on at (x, z): the ground, a deck, a roof (0 on flat ground).
    pub fn standing_at(&self, x: f64, z: f64, near: f64, pad: f64) -> f64 {
        match &self.ground {
            Ground::Open(w) => ground_at(w.terrain(), &w.index, x, z, near, pad),
            Ground::Flat { .. } => 0.0,
        }
    }

    /// Offline the session keeps the world's land and market itself: what a step did that their
    /// keeper must hear is done already (a sale lowered the demand here, a claim holds at once),
    /// but a house taken down for its unpaid tax leaves walls standing until what's solid is made
    /// again. There's no ledger to write to: what the life kept for it goes.
    fn keep_land(&mut self) {
        let Some(life) = self.life.as_mut() else { return };
        let n = life.state.entries;
        life.recorded(n);
        let changes = life.take_changes();
        if !changes.iter().any(|c| matches!(c, Change::Freed { .. })) {
            return;
        }
        let world: &mut OpenWorld = match (self.outside.as_deref_mut(), &mut self.ground) {
            (Some(w), _) => w,
            (None, Ground::Open(w)) => w,
            _ => return,
        };
        world.unbuild();
        life.make_solid(world, 0);
        self.crossings += 1;
    }

    /// Restores a saved life and its land (a test's, or a bug report's), in the shape kept now or
    /// the one before land was kept apart: what was saved, the time you were away (`now` on the
    /// clock `savedAt` was measured on, in ms), where you stood. False, changing nothing, for a save
    /// from a newer game than this one.
    pub fn load_island(&mut self, data: &Value, now: f64) -> bool {
        let (Some(life), Ground::Open(world)) = (self.life.as_mut(), &mut self.ground) else { return false };
        if data.get("state").and_then(|s| s.get("version")).and_then(Value::as_i64).unwrap_or(0) > LIFE_VERSION {
            return false;
        }
        let Ok((state, land)) = land::read_saved(data) else { return false };
        life.load(state, land);
        for v in &mut life.land.vehicles {
            v.ridden = false;
        }
        // A stake still on a table when this was saved: back in the purse, as the server does.
        if let Some(s) = life.state.staked.take() {
            life.state.coins += s;
        }
        life.make_solid(world, 0);
        // Time away.
        let saved_at = data.get("savedAt").and_then(Value::as_f64).unwrap_or(now);
        let c = clock();
        let away = ((now - saved_at) / 1000.0).clamp(0.0, c.max_offline_seconds) * c.offline_factor;
        if away > 1.0 {
            life.state.clock += away;
            farming::grow_for(life, away);
            life.regen_labor(away, false, true);
            if away > 60.0 {
                life.toast(format!("Welcome back - {} passed on Emberholm while you were away", short_time(away)), "info");
            }
        }
        // Where you were.
        let hf = world.terrain();
        let at = &data["player"];
        let num = |k: &str| at.get(k).and_then(Value::as_f64);
        if let (Some(x), Some(z), Some(y), Some(facing)) = (num("x"), num("z"), num("y"), num("facing"))
            && hf.inside(x, z, 10.0)
        {
            let p = &mut self.player;
            let gy = ground_at(hf, &world.index, x, z, y.max(hf.height(x, z)) + 0.5, 1.0);
            p.pos.x = x;
            p.pos.y = gy;
            p.pos.z = z;
            p.prev_pos = p.pos;
            p.facing = facing;
            p.prev_facing = facing;
            p.grounded = true;
        }
        life.after_reset(&mut self.player);
        true
    }

    // ---------- Online: what the server says ----------

    /// Online, the server's word on you (the first half of Engine.correct): you start again from
    /// it, in the shape of src/engine/shapes.ts PlayerState; where you were drawn from is kept for
    /// `replay`.
    pub fn take_player(&mut self, v: &Value) {
        self.drawn_from = Some(self.player.prev_pos);
        take_state(&mut self.player, v);
    }

    /// Online, after the server's word on you (and the island put back as of it): the inputs it
    /// hasn't used yet run again on top, numbered as they were the first time (the frame count is
    /// the clock everything is drawn by) and setting nothing off (that was shown already). With
    /// none to run you're drawn from where you were, so the last step isn't drawn twice.
    pub fn replay(&mut self, inputs: &[Actions], world_clock: Option<f64>) {
        let drawn_from = self.drawn_from.take();
        self.frame = self.frame.saturating_sub(inputs.len() as u32);
        for a in inputs {
            self.set_world_clock(world_clock);
            self.step(a);
        }
        self.take_events();
        if inputs.is_empty()
            && let Some(at) = drawn_from
        {
            self.player.prev_pos = at;
        }
    }

    /// Online, the world's clock (the server's, in seconds since 1970) the rain and the wind run on,
    /// for the next step.
    pub fn set_world_clock(&mut self, t: Option<f64>) {
        if let Some(life) = self.life.as_mut() {
            life.world_clock = t;
        }
    }

    /// Online, your life as a tick has it: its state, your land, the world's market, and whether
    /// you're placing something or resting.
    pub fn take_island(&mut self, state: LifeState, land: Land, market: Market, placing: Option<Placement>, resting: bool) {
        let Some(life) = self.life.as_mut() else { return };
        life.state = state;
        life.land = land;
        life.market = market;
        life.placing = placing;
        life.resting = resting;
        self.sent = None;
        self.is_sent = true;
    }

    /// Online, a command run here at once as well as on the server (a pack picked up, a seat
    /// taken), on a copy of the island the server sent, so that one stays as it came.
    pub fn run_ahead(&mut self, c: &Command) {
        let (Some(life), Ground::Open(world)) = (self.life.as_mut(), &mut self.ground) else { return };
        if self.is_sent {
            self.sent = Some((life.state.clone(), life.land.clone()));
            self.is_sent = false;
        }
        let revision = life.revision;
        interact::run_command(life, &mut Sim { player: &mut self.player, world, owner: 0 }, c);
        if life.revision != revision {
            life.make_solid(world, 0);
        }
    }

    /// Online, before your inputs run again on the server's word on you: the parts of the island
    /// that move with you as of that word (its clock, your labor, the weather, your vehicles, resting
    /// and placing), and the commands the server hasn't run yet (`ahead`) run again on the island it sent.
    #[allow(clippy::too_many_arguments)]
    pub fn replay_island(
        &mut self,
        clock: f64,
        labor: f64,
        weather: Weather,
        vehicles: Vec<Vehicle>,
        resting: bool,
        placing: Option<Placement>,
        ahead: &[Command],
    ) {
        let (Some(life), Ground::Open(world)) = (self.life.as_mut(), &mut self.ground) else { return };
        if !ahead.is_empty() {
            if self.is_sent {
                self.sent = Some((life.state.clone(), life.land.clone()));
                self.is_sent = false;
            } else if let Some((state, land)) = &self.sent {
                life.state = state.clone();
                life.land = land.clone();
            }
        }
        life.state.clock = clock;
        life.state.labor = labor;
        life.weather = weather;
        life.land.vehicles = vehicles;
        life.resting = resting;
        life.placing = placing;
        let revision = life.revision;
        let mut sim = Sim { player: &mut self.player, world, owner: 0 };
        for c in ahead {
            interact::run_command(life, &mut sim, c);
        }
        if life.revision != revision {
            life.make_solid(world, 0);
        }
    }

    // ---------- The world's regions, grown by need ----------

    /// The open world, wherever you are: the one set aside while you're in a copy of an instance.
    fn open_world(&self) -> Option<&OpenWorld> {
        match (self.outside.as_deref(), &self.ground) {
            (Some(w), _) => Some(w),
            (None, Ground::Open(w)) => Some(w),
            _ => None,
        }
    }

    fn open_world_mut(&mut self) -> Option<&mut OpenWorld> {
        match (self.outside.as_deref_mut(), &mut self.ground) {
            (Some(w), _) => Some(w),
            (None, Ground::Open(w)) => Some(w),
            _ => None,
        }
    }

    /// Holds a region grown elsewhere (the page's worker, src/engine/world/grower.ts): its ground the
    /// rules' and what's on it solid from now on. Refused if it isn't that region as the world
    /// places it.
    pub fn adopt_region(&mut self, place: usize, grown: Grown) -> Result<(), String> {
        self.open_world_mut().ok_or("no open world")?.adopt(place, grown)
    }

    /// Lets a region go (the page drops what's behind you).
    pub fn release_region(&mut self, place: usize) {
        if let Some(w) = self.open_world_mut() {
            w.release(place);
        }
    }

    /// The regions the world holds (places in the world's map), and how many it has grown on the spot
    /// because the rules asked about ground before the page handed it over.
    pub fn regions_held(&self) -> (Vec<usize>, u32) {
        self.open_world().map_or((Vec::new(), 0), |w| (w.held(), w.map.unheld()))
    }

    /// What's solid on a region the world holds, as grown (`{obstacles, boxes, decks}`; null if it
    /// doesn't hold it): for the page, when the rules grew one on the spot.
    pub fn region_solids(&self, place: usize) -> Value {
        match self.open_world().and_then(|w| w.map.held_region(place)) {
            Some(g) => json!({ "obstacles": g.zone.obstacles, "boxes": g.zone.boxes, "decks": g.zone.decks }),
            None => Value::Null,
        }
    }

    /// A house solid here as it is on the server: yours, or someone else's where you see it (their
    /// houses come with ids of their own, so they're never taken for yours).
    pub fn add_solid_house(&mut self, h: &House) {
        // In the world, even from inside a copy of an instance (it's the world you'll come back to).
        let world: &mut OpenWorld = match (self.outside.as_deref_mut(), &mut self.ground) {
            (Some(w), _) => w,
            (None, Ground::Open(w)) => w,
            _ => return,
        };
        housing::add_house_colliders(world, 0, h);
    }

    /// A scarecrow's post solid, and the ground round it tilled, as on the server (in the world).
    pub fn add_solid_scarecrow(&mut self, sc: &Scarecrow) {
        let world: &mut OpenWorld = match (self.outside.as_deref_mut(), &mut self.ground) {
            (Some(w), _) => w,
            (None, Ground::Open(w)) => w,
            _ => return,
        };
        farming::add_scarecrow_collider(world, 0, sc);
    }

    /// Other players' vehicles where they're drawn, solid to you as yours are.
    pub fn set_movers(&mut self, movers: Vec<Mover>) {
        if let Ground::Open(world) = &mut self.ground {
            world.movers = movers;
        }
    }

    /// Online, what the prompt can offer with others: their vehicles to ride along in, themselves
    /// to challenge, and the house plots they hold (plot id to their name).
    pub fn set_others(&mut self, vehicles: Option<Vec<OthersVehicle>>, around: Option<Vec<OtherPlayer>>, plots: Option<BTreeMap<String, String>>) {
        let Some(life) = self.life.as_mut() else { return };
        if let Some(v) = vehicles {
            life.others_vehicles = v;
        }
        if let Some(a) = around {
            life.others_around = a;
        }
        if let Some(p) = plots {
            life.plot_owners = p;
        }
    }

    /// Starts you over at `at` with `build`, standing on whatever is solid there, the island's and
    /// the yard's parts with you (tests).
    pub fn reset(&mut self, at: Spawn, build: Build) {
        self.frame = 0;
        self.hitstop = 0;
        self.events.clear();
        self.frames.clear();
        self.observed = 0;
        self.player = Player::new(at, 0, build);
        self.player.set_levels(&self.levels.clone());
        self.populate();
        if let Ground::Open(w) = &self.ground {
            let (x, z) = (self.player.pos.x, self.player.pos.z);
            // From just above the ground there: the floor of the copy you're in, or the terrain.
            let from = self.ground_y(x, z) + 1.2;
            self.player.pos.y = ground_at(w.terrain(), &w.index, x, z, from, 1.2);
            self.player.prev_pos = self.player.pos;
        }
        if let Some(life) = self.life.as_mut() {
            life.after_reset(&mut self.player);
        }
        self.range.reset();
    }

    /// Your stamina and MP as they would be part way through a fight (tests).
    pub fn set_vitals(&mut self, stamina: Option<f64>, mp: Option<f64>) {
        if let Some(s) = stamina {
            self.player.stamina = s;
        }
        if let Some(m) = mp {
            self.player.mp = m;
        }
    }

    /// Monsters that never get angry, for tests about something else that hits them.
    pub fn calm(&mut self, on: bool) {
        self.actors.calm = on;
        if on {
            for a in &mut self.actors.list {
                a.angry = 0;
            }
        }
    }

    /// Puts the `i`th actor of a kind (in spawn order) at (x, z), at home there (tests).
    pub fn place_actor(&mut self, kind: &str, i: usize, x: f64, z: f64) {
        if let Some(a) = self.actors.list.iter_mut().filter(|a| a.kind == kind).nth(i) {
            a.x = x;
            a.z = z;
            a.y = 0.0;
            a.home_x = x;
            a.home_z = z;
        }
    }

    /// Sets fields on an actor (a cooldown, where it stands), by the page's names for them, to set up a
    /// moment directly (tests). Returns the names it doesn't know.
    pub fn set_actor(&mut self, id: u32, fields: &Map<String, Value>) -> Vec<String> {
        let Some(a) = self.actors.get_mut(id) else { return Vec::new() };
        let mut unknown = Vec::new();
        for (k, v) in fields {
            let n = v.as_f64().unwrap_or(0.0);
            match k.as_str() {
                "x" => a.x = n,
                "y" => a.y = n,
                "z" => a.z = n,
                "facing" => a.facing = n,
                "homeX" => a.home_x = n,
                "homeZ" => a.home_z = n,
                "hp" => a.hp = n,
                "angry" => a.angry = n as i32,
                "slamCd" => a.slam_cd = n as i32,
                "gatherCd" => a.gather_cd = n as i32,
                "fuse" => a.fuse = n as i32,
                "calling" => a.calling = n as i32,
                "wait" => a.wait = n as i32,
                "charges" => a.charges = n as i32,
                _ => unknown.push(k.clone()),
            }
        }
        unknown
    }

    /// A seed for what a test makes, from the moment and how many there are.
    fn test_seed(&self) -> u32 {
        ((self.frame as u64 * 2_654_435_761 + self.actors.list.len() as u64 * 40503) % (1 << 32)) as u32
    }

    /// A new actor of a kind at (x, z), as if a fight had made it (it won't respawn). Returns its id.
    pub fn spawn_actor(&mut self, kind: &str, x: f64, z: f64) -> Option<u32> {
        let point = SpawnPoint { kind: kind.to_string(), x, z, seed: Some(self.test_seed()), ..Default::default() };
        let seen = self.sighting();
        self.actors.spawn_at(&point, 0, true, seen)
    }

    /// A band of `count` of a kind round (x, z), as a zone's spawns make one. Returns their ids.
    pub fn spawn_band(&mut self, kind: &str, count: usize, x: f64, z: f64) -> Vec<u32> {
        let seed = self.test_seed();
        let band = self.actors.new_band();
        let mut ids = Vec::new();
        for point in band_around(kind, count, x, z, band, seed) {
            let seen = self.sighting();
            if let Some(id) = self.actors.spawn_at(&point, band, false, seen) {
                ids.push(id);
            }
        }
        ids
    }

    /// A blow from you to an actor, as if your weapon had landed it.
    pub fn hurt_actor(&mut self, id: u32, amount: f64) {
        let weapon = self.player.weapon;
        let footing = footing(&self.ground, &self.dungeon);
        Blows { actors: &mut self.actors, player: &self.player, footing, events: &mut self.events }.damage(id, amount, 0.0, 0, Some(weapon));
        self.observe();
        self.stamp();
    }

    /// A blow landing on you from (dir_x, dir_z), as if something had hit you.
    pub fn take_hit(&mut self, damage: f64, dir_x: f64, dir_z: f64, knock: f64) {
        self.player.take_hit(damage, dir_x, dir_z, knock);
    }

    // ---------- What the page reads ----------

    /// You, as src/engine/shapes.ts PlayerState has you.
    pub fn player_json(&self) -> Value {
        let p = &self.player;
        let mut v = player_state_json(p);
        v["prevPos"] = json!({ "x": p.prev_pos.x, "y": p.prev_pos.y, "z": p.prev_pos.z });
        v["prevFacing"] = json!(p.prev_facing);
        v
    }

    /// A number that changes whenever what's solid changes (a house or a scarecrow made solid, a
    /// dungeon's floors and walls put in or taken out, a region held or let go), so the page knows to
    /// read the colliders again (`colliders_json`, `clear`) for its camera and drawing.
    pub fn solid_key(&self) -> u32 {
        let Ground::Open(w) = &self.ground else { return 0 };
        let mut h: u32 = 0x811c_9dc5;
        let mut mix = |n: usize| {
            for b in (n as u64).to_le_bytes() {
                h = (h ^ b as u32).wrapping_mul(0x0100_0193);
            }
        };
        let (obstacles, boxes, decks) = w.built();
        mix(w.added.len());
        mix(obstacles.len());
        mix(boxes.len());
        mix(decks.len());
        for r in w.held() {
            mix(r);
        }
        mix(self.crossings as usize);
        h
    }

    /// What's solid in the world as it stands, in src/engine/world/types.ts's shapes: the regions held
    /// (`regions`, places in the world's map: the page has what's on them from its worker), and what's
    /// been built since (`{obstacles, boxes, decks}`: houses, scarecrows, a copy's floors and walls);
    /// null on the yard's flat ground.
    pub fn colliders_json(&self) -> Value {
        let Ground::Open(w) = &self.ground else { return Value::Null };
        let (obstacles, boxes, decks) = w.built();
        json!({ "regions": w.held(), "obstacles": obstacles, "boxes": boxes, "decks": decks })
    }

    /// The island's cells kept clear of trees and scarecrows (the zone's, and ground cleared for houses).
    pub fn clear(&self) -> &[u8] {
        match &self.ground {
            Ground::Open(w) => &w.clear,
            Ground::Flat { .. } => &[],
        }
    }

    /// The creatures and what they've thrown, as src/engine/actors/actor.ts has them, and offline the yard's
    /// arrows and meteors in flight (src/engine/training.ts).
    pub fn actors_json(&self) -> Value {
        json!({ "list": self.actors.list, "missiles": self.actors.missiles, "arrows": self.range.arrows, "meteors": self.range.meteors })
    }

    /// The life as the page shows it: its state, your land, the world's market and weather where you
    /// are, what F does here, what you're placing, resting.
    pub fn life_json(&self) -> Value {
        match &self.life {
            Some(l) => json!({
                "state": l.state,
                "land": l.land,
                "market": l.market,
                "weather": l.weather,
                "now": land::now(l),
                "focus": l.focus,
                "placing": l.placing,
                "resting": l.resting,
                "revision": l.revision,
            }),
            None => Value::Null,
        }
    }

    /// Everything the page reads after a step or a call, in one, as JSON text: the step count and the
    /// hit pause, you, the creatures and the yard's arrows and meteors (offline), the island, what the
    /// island said (taken), whether a fall put you somewhere (and facing which way), a number that
    /// changes when what's solid does (`solid_key`), and with `events` what happened (taken). Written
    /// straight from the session's own values: building it as JSON values first was most of an
    /// offline step's time (the refactor's R8.14).
    pub fn view_text(&mut self, events: bool) -> String {
        #[derive(Serialize)]
        struct ActorsView<'a> {
            list: &'a [Actor],
            missiles: &'a [Missile],
            arrows: &'a [Arrow],
            meteors: &'a [Meteor],
        }
        #[derive(Serialize)]
        struct LifeView<'a> {
            state: &'a LifeState,
            land: &'a Land,
            market: &'a Market,
            weather: &'a Weather,
            /// The land's clock as of this view (crate::life::land::now), which the market's
            /// demand and the land's times are read against.
            now: f64,
            focus: &'a Option<Focus>,
            placing: &'a Option<Placement>,
            resting: bool,
            revision: u64,
        }
        #[derive(Serialize)]
        struct View<'a> {
            frame: u32,
            hitstop: i32,
            player: Value,
            levels: &'a Levels,
            actors: ActorsView<'a>,
            life: Option<LifeView<'a>>,
            said: Vec<LifeEvent>,
            placed: Option<f64>,
            solid: u32,
            events: Vec<Value>,
        }
        let happened = self.happened(events);
        let said = self.life.as_mut().map(|l| l.drain_events()).unwrap_or_default();
        let view = View {
            frame: self.frame,
            hitstop: self.hitstop,
            player: self.player_json(),
            levels: &self.player.levels,
            actors: ActorsView { list: &self.actors.list, missiles: &self.actors.missiles, arrows: &self.range.arrows, meteors: &self.range.meteors },
            life: self.life.as_ref().map(|l| LifeView {
                state: &l.state,
                land: &l.land,
                market: &l.market,
                weather: &l.weather,
                now: land::now(l),
                focus: &l.focus,
                placing: &l.placing,
                resting: l.resting,
                revision: l.revision,
            }),
            said,
            placed: self.placed,
            solid: self.solid_key(),
            events: happened,
        };
        serde_json::to_string(&view).unwrap_or_default()
    }

    /// With `events`, what happened since the last time (taken), each with the frame it happened on.
    fn happened(&mut self, events: bool) -> Vec<Value> {
        if events {
            self.take_events()
                .into_iter()
                .map(|(frame, e)| {
                    let mut v = serde_json::to_value(e).unwrap_or(Value::Null);
                    if let Value::Object(m) = &mut v {
                        m.insert("frame".into(), json!(frame));
                    }
                    v
                })
                .collect()
        } else {
            Vec::new()
        }
    }

    /// The flat world as it's drawn (the yard's props, the dummy, where you start and who stands about).
    pub fn world_json(&self) -> Value {
        let spawn = |s: Spawn| json!({ "x": s.x, "z": s.z, "facing": s.facing });
        match &self.ground {
            Ground::Flat { yard, world } => json!({
                "seed": yard.seed,
                "radius": world.radius,
                "obstacles": yard.props,
                "spawn": spawn(yard.spawn),
                "teamSpawns": [spawn(world.team_spawns[0]), spawn(world.team_spawns[1])],
                "spawns": self.spawns,
            }),
            Ground::Open(_) => json!({ "spawns": self.spawns }),
        }
    }
}

/// The world's ground (none on the yard's flat ground).
fn terrain_of(ground: &Ground) -> Option<&WorldMap> {
    match ground {
        Ground::Open(w) => Some(&w.map),
        Ground::Flat { .. } => None,
    }
}

/// The ground creatures stand on: the floor of the copy you're in, the world's terrain, or neither
/// on the yard's flat ground.
fn footing<'a>(ground: &'a Ground, inside: &Option<String>) -> Footing<'a> {
    Footing { floor: inside.as_deref().and_then(dungeon), terrain: terrain_of(ground) }
}

fn mode_of(s: &str) -> Option<Mode> {
    Some(match s {
        "normal" => Mode::Normal,
        "attack" => Mode::Attack,
        "cast" => Mode::Cast,
        "action" => Mode::Action,
        "swim" => Mode::Swim,
        "glide" => Mode::Glide,
        "ride" => Mode::Ride,
        _ => return None,
    })
}

/// Takes a player's whole state in the shape of src/engine/shapes.ts PlayerState (`player_state_json`'s,
/// with where they were a step ago): what isn't there is left as it was. What the build does is
/// worked out again from its skills.
pub fn take_state(p: &mut Player, v: &Value) {
    let f = |k: &str| v.get(k).and_then(Value::as_f64);
    let i = |k: &str| v.get(k).and_then(Value::as_i64);
    let b = |k: &str| v.get(k).and_then(Value::as_bool);
    let v3 = |k: &str, to: &mut V3| {
        if let Some(o) = v.get(k) {
            let c = |a: &str| o.get(a).and_then(Value::as_f64).unwrap_or(0.0);
            *to = V3 { x: c("x"), y: c("y"), z: c("z") };
        }
    };
    v3("pos", &mut p.pos);
    v3("vel", &mut p.vel);
    v3("prevPos", &mut p.prev_pos);
    macro_rules! set {
        ($field:expr, $get:expr) => {
            if let Some(x) = $get {
                $field = x;
            }
        };
    }
    set!(p.facing, f("facing"));
    set!(p.prev_facing, f("prevFacing"));
    set!(p.mode, v.get("mode").and_then(Value::as_str).and_then(mode_of));
    set!(p.grounded, b("grounded"));
    set!(p.jumps_used, i("jumpsUsed").map(|n| n as i32));
    set!(p.jump_cut_done, b("jumpCutDone"));
    set!(p.coyote, i("coyote").map(|n| n as i32));
    set!(p.jump_buffer, i("jumpBuffer").map(|n| n as i32));
    set!(p.attack_buffer, i("attackBuffer").map(|n| n as i32));
    set!(p.action_buffer, i("actionBuffer").map(|n| n as i32));
    set!(p.action_buffer_id, i("actionBufferId").map(|n| n as u8));
    set!(p.attack_index, i("attackIndex").map(|n| n as usize));
    set!(p.attack_frame, i("attackFrame").map(|n| n as i32));
    set!(p.attack_queued, b("attackQueued"));
    set!(p.attack_hit, b("attackHit"));
    set!(p.flip_frame, i("flipFrame").map(|n| n as i32));
    set!(p.land_frame, i("landFrame").map(|n| n as i32));
    set!(p.land_impact, f("landImpact"));
    set!(p.takeoff_frame, i("takeoffFrame").map(|n| n as i32));
    set!(p.run_phase, f("runPhase"));
    set!(p.hp, f("hp"));
    set!(p.stamina, f("stamina"));
    set!(p.stamina_delay, i("staminaDelay").map(|n| n as i32));
    set!(p.mp, f("mp"));
    set!(p.stun, i("stun").map(|n| n as i32));
    set!(p.down_frame, i("downFrame").map(|n| n as i32));
    set!(p.team, i("team").map(|n| n as u8));
    set!(p.weapon, i("weapon").map(|n| n as u8));
    let list = |k: &str| v.get(k).and_then(Value::as_array);
    if let Some(a) = list("skills") {
        for (k, w) in a.iter().take(p.skills.len()).enumerate() {
            p.skills[k] = w.as_u64().unwrap_or(0) as u32;
        }
    }
    if let Some(a) = list("abilities") {
        for (k, w) in a.iter().take(p.abilities.len()).enumerate() {
            p.abilities[k] = w.as_u64().unwrap_or(0) as u8;
        }
    }
    if let Some(a) = list("cooldowns") {
        for (k, w) in a.iter().take(p.cooldowns.len()).enumerate() {
            p.cooldowns[k] = w.as_i64().unwrap_or(0) as i32;
        }
    }
    if let Some(a) = list("movement") {
        for (k, w) in a.iter().take(p.movement.len()).enumerate() {
            p.movement[k] = w.as_u64().unwrap_or(0) as u8;
        }
    }
    if let Some(a) = list("movementCooldowns") {
        p.movement_cooldowns = a.iter().map(|w| w.as_i64().unwrap_or(0) as i32).collect();
    }
    set!(p.ability_buffer, i("abilityBuffer").map(|n| n as i32));
    set!(p.ability_buffer_slot, i("abilityBufferSlot").map(|n| n as u8));
    set!(p.action_id, i("actionId").map(|n| n as u8));
    set!(p.action_frame, i("actionFrame").map(|n| n as i32));
    set!(p.action_dir_x, f("actionDirX"));
    set!(p.action_dir_z, f("actionDirZ"));
    set!(p.action_slot, i("actionSlot").map(|n| n as u8));
    set!(p.sprinting, b("sprinting"));
    set!(p.crouching, b("crouching"));
    set!(p.crouch_frame, i("crouchFrame").map(|n| n as i32));
    set!(p.cast_ability, i("castAbility").map(|n| n as u8));
    set!(p.cast_slot, i("castSlot").map(|n| n as u8));
    set!(p.cast_frame, i("castFrame").map(|n| n as i32));
    set!(p.cast_target_x, f("castTargetX"));
    set!(p.cast_target_z, f("castTargetZ"));
    set!(p.fired_ability, i("firedAbility").map(|n| n as u8));
    set!(p.pack, i("pack"));
    set!(p.vehicle, i("vehicle"));
    set!(p.seat, i("seat").map(|n| n as u8));
    set!(p.host, i("host"));
    set!(p.glider, v.get("glider").and_then(Value::as_str).map(str::to_string));
    set!(p.airspeed, f("airspeed"));
    set!(p.bank, f("bank"));
    set!(p.mode_frame, i("modeFrame").map(|n| n as i32));
    set!(p.gust_frames, i("gustFrames").map(|n| n as i32));
    p.resolved = resolve_skills(&p.skills, &p.levels);
}

fn mode_name(m: Mode) -> &'static str {
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

/// A player's whole state, in the shape of src/engine/shapes.ts PlayerState (without where they were a
/// step ago, which only the browser keeps).
pub fn player_state_json(p: &Player) -> Value {
    let v3 = |x: f64, y: f64, z: f64| json!({ "x": x, "y": y, "z": z });
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

#[cfg(test)]
mod tests {
    use super::*;

    fn crowd(s: &Session) -> Vec<(u32, String)> {
        s.actors.list.iter().map(|a| (a.id, a.kind.clone())).collect()
    }

    #[test]
    fn offline_a_copy_brings_its_creatures_and_the_world_keeps_its_own() {
        let mut s = Session::new(true, false, None, Build::default());
        let world = crowd(&s);
        assert!(!world.is_empty(), "Emberholm's slimes and dummy");
        assert!(s.enter_dungeon("yard"));
        let inside = crowd(&s);
        let kinds: Vec<&str> = inside.iter().map(|(_, k)| k.as_str()).collect();
        assert_eq!(kinds, ["dummy", "slime", "slime", "slime", "slime", "slime"], "the yard's spawns");
        let last = world.iter().map(|(id, _)| *id).max().unwrap_or(0);
        assert!(inside.iter().all(|(id, _)| *id > last), "numbered on from the world's");

        // They stand on its floor: a blow on the dummy lands at its height above the floor, not
        // down in the nothing under the copy.
        for _ in 0..10 {
            s.step(&Actions::default());
        }
        let dummy = s.actors.list.iter().find(|a| a.kind == "dummy").expect("the dummy");
        let (id, x, z) = (dummy.id, dummy.x, dummy.z);
        let floor = s.floor_at(x, z).expect("the yard's floor under the dummy");
        s.take_events();
        s.hurt_actor(id, 1.0);
        let hit = s.take_events().into_iter().find_map(|(_, e)| if let Event::Hit { y, .. } = e { Some(y) } else { None });
        let y = hit.expect("the blow landed");
        assert!(y > floor && y < floor + 3.0, "hit at {y}, the floor at {floor}");

        // Back out, the world's creatures are as they were.
        s.leave_dungeon();
        assert_eq!(crowd(&s), world);
    }
}
