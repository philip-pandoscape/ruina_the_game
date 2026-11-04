//! Emberholm as the server plays it: one game per channel, 20 ticks a second. Each player's
//! browser sends what they press (about 60 inputs a second) and what they ask their island to do
//! (commands); here those run through the island's rules (server/src/open, server/src/life) and
//! the same combat as the battlefield (server/src/game.rs), the channel's slimes live and fight,
//! and every browser hears back where it really is, what its island now holds, and what everyone
//! else in the channel is doing. Nothing a browser says about its own state is believed: it can
//! only press keys and ask.
//!
//! The browser predicts its own player with the TypeScript twin of these rules and corrects itself
//! to what arrives here (src/net/worldLink.ts, src/net/netPlayer.ts).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::actors::{Actors, LEAN_DAMPING, LEAN_SPRING};
use crate::channels::{estate_of, Channel};
use crate::game::{open_actions_from, Players};
use crate::life::content::clock;
use crate::life::state::LifeState;
use crate::life::{farming, housing, trade, vehicles, Command, Life};
use crate::open::colliders::ground_at;
use crate::open::zone::{emberholm, Zone};
use crate::open::{OpenWorld, Sim};
use crate::player::{Build, Mode, Player};
use crate::sim::Battle;
use crate::world::{Spawn, World};

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
    pub build: Build,
}

pub struct ChannelGame {
    pub id: i32,
    /// Who left in the last minute, with their island as they left it: newer than any save that
    /// might still be on its way to the database, so a quick reload picks up exactly there.
    lingering: HashMap<i64, (Instant, Player, Box<Life>)>,
    /// Everyone's estates and who holds which plot, online or not.
    pub estates: Channel,
    pub members: HashMap<i64, Member>,
    world: World,
    pub open: OpenWorld,
    players: Players,
    actors: Actors,
    battle: Battle,
    tick: u64,
    last_tick: Instant,
}

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
        let mut players = Players::new(0, 1000.0 / TICK_HZ as f64);
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
            lingering: HashMap::new(),
            estates: Channel::default(),
            members: HashMap::new(),
            world,
            open: OpenWorld::new(zone),
            players,
            actors,
            battle: Battle::new(0),
            tick: 0,
            last_tick: Instant::now(),
        }
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
    /// channel parts: everyone else's estates and the claims.
    pub fn join(&mut self, a: Arrival) -> (Value, Value) {
        let c = client(a.character);
        self.lingering.retain(|_, (when, _, _)| when.elapsed() < LINGER);
        if self.players.open_view(c).is_some() {
            self.players.restart_inputs(c);
        } else if let Some((_, player, life)) = self.lingering.remove(&a.character) {
            self.players.join_open(c, a.character, player, life);
        } else {
            let zone = self.open.zone;
            let mut life = Life::new(zone, None, None);
            let mut player = Player::new(Spawn { x: zone.recipe.spawn.x, z: zone.recipe.spawn.z, facing: zone.recipe.spawn.facing }, 0, a.build);
            stand_on_ground(&mut player, &self.open);
            if let Some(island) = &a.island {
                load_island(&mut life, &mut player, &mut self.open, a.character, island, a.saved_at.unwrap_or(a.now), a.now);
            }
            life.after_reset(&mut player);
            make_solid(&mut self.open, a.character, &life.state);
            self.players.join_open(c, a.character, player, Box::new(life));
        }
        let now = Instant::now();
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
            },
        );
        self.refresh_estate(a.character);
        (self.estates.estates_json(a.character), self.estates.claims_json())
    }

    /// Someone's connection ended. Unless a newer window already took their seat, they're taken
    /// out, and their island comes back to be saved.
    pub fn leave(&mut self, character: i64, session: i64) -> Option<Value> {
        if !self.members.get(&character).is_some_and(|m| m.session == session) {
            return None;
        }
        self.members.remove(&character);
        let (player, life) = self.players.leave(client(character))?;
        let mut life = life?;
        let island = island_of(&player, &mut life, &mut self.open, character);
        self.lingering.insert(character, (Instant::now(), player, life));
        self.send_all(&json!({ "t": "left", "id": character }).to_string(), None);
        Some(island)
    }

    /// The developer panel's teleport: off whatever you were riding, onto the ground there.
    fn teleport(&mut self, character: i64, x: f64, z: f64, facing: Option<f64>) {
        let Some((p, life)) = self.players.open_mut(client(character)) else { return };
        let hf = self.open.terrain();
        if !x.is_finite() || !z.is_finite() || !hf.inside(x, z, 0.0) {
            return;
        }
        if p.mode == Mode::Ride {
            if let Some(life) = life {
                let mut sim = Sim { player: p, world: &mut self.open, owner: character };
                vehicles::dismount(life, &mut sim);
            }
        }
        let y = ground_at(hf, &self.open.index, x, z, hf.height(x, z) + 1.2, 1.2);
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

    pub fn has_players(&self) -> bool {
        !self.members.is_empty()
    }

    /// Inputs from a browser: (sequence number, the 9 bytes the browser packed).
    pub fn inputs(&mut self, character: i64, list: impl Iterator<Item = (u32, [u8; 9])>) {
        self.players.queue_actions(client(character), list.map(|(seq, raw)| (seq, open_actions_from(raw))));
    }

    /// A command for someone's island, given on input `seq`. The developer panel's only count where
    /// this server offers the panel.
    pub fn command(&mut self, character: i64, seq: u32, c: Command) -> bool {
        let Some(m) = self.members.get_mut(&character) else { return false };
        if c.is_dev() && !m.dev {
            return false;
        }
        m.life_due = 3;
        if let Command::Teleport { x, z, facing } = c {
            self.teleport(character, x, z, facing);
            return true;
        }
        self.players.queue_command(client(character), seq, c);
        true
    }

    /// A new build (skills and loadout), already checked.
    pub fn set_build(&mut self, character: i64, build: Build) {
        if let Some((p, _)) = self.players.open_mut(client(character)) {
            p.apply_build(build);
        }
    }

    /// Starts someone's island over: a fresh one, standing at the spawn. What they had built goes.
    /// Returns the fresh island, to save.
    pub fn reset(&mut self, character: i64) -> Option<Value> {
        let zone = self.open.zone;
        let (p, life) = self.players.open_mut(client(character))?;
        let life = life?;
        let build = Build { skills: p.skills, weapon: p.weapon, abilities: p.abilities, movement: p.movement };
        *life = Life::new(zone, None, None);
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
            if !self.members.contains_key(id) {
                if let Ok(s) = serde_json::from_value::<LifeState>(e.estate.clone()) {
                    lists.push((*id, s));
                }
            }
        }
        for (owner, s) in lists {
            make_solid(&mut self.open, owner, &s);
        }
    }

    /// Works out a member's estate again if their island changed shape, and tells everyone.
    fn refresh_estate(&mut self, character: i64) {
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
            let held: HashMap<i64, HashMap<String, String>> = self.members.keys().map(|id| (*id, self.estates.held_by_others(*id))).collect();
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
        self.tick += 1;
        // Each player may run as many inputs as real time allows, no more.
        self.players.inputs_per_tick = elapsed * 60.0;
        self.players.step_in(&mut self.battle, &mut self.actors, &self.world, self.tick, Some(&mut self.open));
        self.players.step_effects(&mut self.battle, &mut self.actors);
        let seen = self.players.live_positions();
        let mut slams = Vec::new();
        for _ in 0..(60 / TICK_HZ) {
            slams.extend(self.actors.step(&seen, LEAN_SPRING, LEAN_DAMPING, 1.0 / 60.0));
        }
        self.players.apply_slams(&slams);

        let ids: Vec<i64> = self.members.keys().copied().collect();
        for id in &ids {
            self.refresh_estate(*id);
        }

        // Everyone as everyone else sees them.
        let fr = self.tick * (60 / TICK_HZ) as u64;
        let mut presences: Vec<(i64, Value)> = Vec::new();
        for (_, owner, p, life) in self.players.each_open() {
            let Some(m) = self.members.get(&owner) else { continue };
            presences.push((owner, json!({ "id": owner, "name": m.name, "p": presence_json(p, life, fr) })));
        }

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
            let save_due = now - m.last_save >= SAVE_EVERY;
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
                    saves.push(Save { character: id, session, island: island_of(p, life, &mut self.open, id), out: Some(out.clone()) });
                }
            }
            if save_due {
                if let Some(m) = self.members.get_mut(&id) {
                    m.last_save = now;
                }
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
            let _ = out.try_send(msg.to_string());
        }
    }
}

/// Stands a player on whatever is under them (terrain, a deck, a roof).
fn stand_on_ground(p: &mut Player, world: &OpenWorld) {
    let hf = world.terrain();
    p.pos.y = ground_at(hf, &world.index, p.pos.x, p.pos.z, hf.height(p.pos.x, p.pos.z) + 1.2, 1.2);
    p.grounded = true;
}

/// Makes an island's houses and farm posts solid in the channel (each piece once).
fn make_solid(world: &mut OpenWorld, owner: i64, state: &LifeState) {
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
pub fn load_island(life: &mut Life, p: &mut Player, world: &mut OpenWorld, owner: i64, island: &Value, saved_at: i64, now: i64) {
    let Some(state) = island.get("state").and_then(|s| serde_json::from_value::<LifeState>(s.clone()).ok()) else { return };
    life.load(state);
    for v in &mut life.state.vehicles {
        v.ridden = false;
    }
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
    if let (Some(x), Some(z), Some(y), Some(facing)) = (num("x"), num("z"), num("y"), num("facing")) {
        if hf.inside(x, z, 10.0) {
            let _ = owner;
            p.pos.x = x;
            p.pos.z = z;
            p.pos.y = ground_at(hf, &world.index, x, z, y.max(hf.height(x, z)) + 0.5, 1.0);
            p.facing = facing;
            p.grounded = true;
        }
    }
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
        for k in ["pos", "vel", "mode", "jumpsUsed", "cooldowns", "movementCooldowns", "skills", "glider", "gustFrames"] {
            assert!(v.get(k).is_some(), "{k}");
        }
        assert_eq!(v["mode"], "normal");
    }
}
