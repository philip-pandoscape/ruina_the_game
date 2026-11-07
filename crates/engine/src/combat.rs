//! Players together, as a channel plays them: joining and leaving, their builds (skills and
//! loadout), running their inputs in order, and everything that hurts or heals: weapon swings,
//! arrows, meteors and Healing Circles, plus creatures' slams and blows landing on players; and
//! passengers riding along in someone else's vehicle.
//!
//! The order they're stepped in makes no difference. A tick goes in phases, as the server's
//! play_tick runs them: everyone's vehicles made solid as they stand ([`Players::gather_movers`]),
//! everyone's inputs ([`Players::step_by`]), passengers seated in their hosts' vehicles
//! ([`Players::seat_passengers`]), arrows and meteors ([`Players::step_effects`]), the creatures
//! (crate::actors, whose slams and blows land after them: [`Players::apply_slams`],
//! [`Players::apply_foe_hits`]), and where everyone stood ([`Players::record_history`]). Within a
//! phase each player, arrow and meteor reads the others only as they stood when the phase began,
//! and what it does to them is handed back and applied once all of them have gone: in the order of
//! whom it lands on (a creature by its id, a player by their slot), then of whom it came from. So
//! whatever order they go in, or all at once (`step_by` is told how: the server can step everyone on
//! its threads), the tick comes out the same.
//!
//! Lag compensation: each input says which server tick the player was looking at. When a melee
//! swing is checked, the other players and the creatures are rewound to where that player saw
//! them, so a hit on your screen is a hit on the server.
//!
//! Across a border (crate::border) a simulation also holds ghosts: players another simulation owns,
//! each in their slot ([`Players::ghost`]), seen, swung at and healed like anyone here but never
//! stepped. A phase can be taken in its parts so simulations can trade what crosses between them:
//! worked out ([`Players::work_out`], [`Players::fly_effects`]), landed ([`Players::land`]: what
//! lands on a ghost, or on a creature this simulation only sees, is handed back for its owner, and
//! what its owner landed here comes in), and told ([`Players::settle`]: the numbers shown and the
//! hits credited, in the order the blows landed wherever they landed). Stepped whole, a phase does
//! the same in one go.

use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::actors::{Actors, FoeHit, Slam};
use crate::ai::Foe;
use crate::content::kind_at;
use crate::ids::EntityId;
use crate::jsmath::{JsMath, js_hypot};
use crate::life::content::rideable;
use crate::life::progress::{Observed, sync_levels};
use crate::life::state::Vehicle;
use crate::life::{Command, Life, vehicles};
use crate::open::dungeon::DungeonDef;
use crate::open::zone::Heightfield;
use crate::open::{OpenWorld, Sim};
use crate::player::{Actions, Build, Mode, Player, angle_diff};
use crate::skills::allowed;
use crate::tuning::{AttackStep, NO_ABILITY, ability, effect_amount, effect_damage, effect_radius, melee_targets, pierce_targets, tuning};

pub const MAX_PLAYERS: usize = 4096;
// A little more than one tick's worth of 60 Hz inputs: catches up after a hiccup, but a client
// can't speed itself up by sending extra inputs.
const MAX_INPUTS_PER_TICK: usize = 12;
const BODY_RADIUS: f64 = 0.45;
const HISTORY: usize = 40; // ticks of position history kept of everything that can be hit (2 s at 20 Hz)
const MAX_REWIND_TICKS: f64 = 16.0; // never rewind more than 0.8 s, however laggy the attacker
const ARROW_HEIGHT: f64 = 1.3; // arrows fly at chest height
const ARROW_RADIUS: f64 = 0.55; // how close an arrow has to pass to hit someone
const MARKER_HEIGHT: f64 = 1.1; // floating numbers sit about head height above whoever they're about
const MAX_OWN_EVENTS: usize = 24; // attributed events per player per tick; the rest are dropped
const SLAM_LIFT: f64 = 1.0; // a monster's slam only catches someone on the ground, not mid-jump
/// How close to someone's vehicle you have to be to climb in (the hull, as the island's prompts
/// measure it, with a little slack for where you were drawn).
pub const CLIMB_IN: f64 = 2.6;

// What an effect sent to the browser is (an event's kind), as src/net/netSpells.ts reads it: these
// numbers are the wire's, so they never change. 1 to 3 are shown to everyone nearby (a heal's and
// an explosion's size is its radius in tenths of a metre).
const EVENT_HEAL: u16 = 1;
const EVENT_EXPLOSION: u16 = 2;
const EVENT_ARROW_HIT: u16 = 3;
// Attributed events, sent only to the player they are about, so the browser can label a number
// without the server naming who did it: their size is the damage or healing, their position the one
// it happened to, and the bits of the kind above the low 4 say what caused it (a cause), for the
// icon beside the number.
const EVENT_YOU_HIT: u16 = 4;
const EVENT_YOU_HURT: u16 = 5;
const EVENT_YOU_HEAL: u16 = 6;

// What caused an attributed event: what sort of thing it was in a cause's low 2 bits, and for a
// weapon or an ability its place in shared/tuning.json's list above them, so the icon is the
// content's whatever its order (src/net/netSpells.ts reads them).
const CAUSE_WEAPON: u16 = 1;
const CAUSE_ABILITY: u16 = 2;
const CAUSE_MONSTER: u16 = 3;

fn weapon_cause(weapon: u8) -> u16 {
    CAUSE_WEAPON | u16::from(weapon) << 2
}

fn ability_cause(ability: u8) -> u16 {
    CAUSE_ABILITY | u16::from(ability) << 2
}

struct Slot {
    client_id: EntityId,
    player: Player,
    last_seq: u32,
    build_seq: u32,
    queue: VecDeque<(u32, f64, Actions)>, // (seq, view tick, input)
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
    /// What happened this tick to this player or because of them: damage and healing that only
    /// they are told about.
    told: Vec<Effect>,
    /// A ghost: a player another simulation owns, seen here across a border, with their vehicles
    /// as they stand (crate::border). Never stepped here.
    away: Option<Vec<Vehicle>>,
}

impl Slot {
    fn new(client_id: EntityId, player: Player, owner: i64, life: Option<Box<Life>>) -> Slot {
        Slot {
            client_id,
            player,
            last_seq: 0,
            build_seq: 0,
            queue: VecDeque::new(),
            owner,
            life,
            commands: VecDeque::new(),
            budget: 0.0,
            told: Vec::new(),
            away: None,
        }
    }

    /// One of this simulation's own players, not a ghost.
    fn own(&self) -> bool {
        self.away.is_none()
    }
}

/// Where something that can be hit stood at the end of each of the last ticks, oldest first, as
/// (tick, x, y, z): what a ghost's owner sends with it (crate::border), for swings rewound to it.
pub type History = Vec<(u64, f64, f64, f64)>;

/// Remembers something that happened *to a player or because of them*, for a floating number in
/// their browser. Capped per tick so one meteor into a crowd can't flood a snapshot; the browser
/// pools what does arrive anyway.
#[allow(clippy::too_many_arguments)]
fn note(told: &mut Vec<Effect>, kind: u16, cause: u16, x: f64, y: f64, z: f64, amount: f64) {
    if amount < 0.5 || told.len() >= MAX_OWN_EVENTS {
        return;
    }
    // kind is 4..6, so the bits above the low 4 are free for what caused it.
    told.push(Effect { kind: kind | (cause << 4), x, y, z, size: amount.round().clamp(1.0, 255.0) as u8 });
}

/// The ground under a point: a copy's floor where it has one, the terrain, or 0 where there's
/// neither.
fn ground_under(floor: Option<&'static DungeonDef>, terrain: Option<&'static Heightfield>, x: f64, z: f64) -> f64 {
    floor.and_then(|d| d.floor_at(x, z)).unwrap_or_else(|| terrain.map_or(0.0, |g| g.height(x, z)))
}

/// Where something that can be hit stood at the end of each of the last HISTORY ticks, oldest
/// first, as (tick, x, y, z): what a swing is rewound against. A creature's y is its height over
/// the ground, as it keeps it.
#[derive(Clone, Default)]
struct Track(VecDeque<(u64, f64, f64, f64)>);

impl Track {
    fn push(&mut self, tick: u64, x: f64, y: f64, z: f64) {
        self.0.push_back((tick, x, y, z));
        if self.0.len() > HISTORY {
            self.0.pop_front();
        }
    }

    /// Where it stood at (fractional) tick `view`: between the ticks either side of it, the
    /// newest if it's past them all, the oldest if it's before; None with nothing kept yet.
    fn at(&self, view: f64) -> Option<(f64, f64, f64)> {
        let h = &self.0;
        let &last = h.back()?;
        if view >= last.0 as f64 {
            return Some((last.1, last.2, last.3));
        }
        for k in (1..h.len()).rev() {
            let (a, b) = (h[k - 1], h[k]);
            if view >= a.0 as f64 {
                let f = (view - a.0 as f64) / (b.0 - a.0) as f64;
                return Some((a.1 + (b.1 - a.1) * f, a.2 + (b.2 - a.2) * f, a.3 + (b.3 - a.3) * f));
            }
        }
        Some((h[0].1, h[0].2, h[0].3))
    }
}

/// A player as everyone else sees them while a phase is stepped: as they stood when it began.
#[derive(Clone, Copy)]
struct Seen {
    slot: usize,
    team: u8,
    down: bool,
    x: f64,
    y: f64,
    z: f64,
    facing: f64,
}

/// An arrow in flight.
pub struct Arrow {
    pub id: u16,
    pub owner: u16,         // player id of the shooter (their slot)
    owner_slot: usize,      // and their slot, for "you hit X" events
    owner_client: EntityId, // and who was in it, so what it does is credited to them and nobody else
    weapon: u8,             // which weapon fired it (it trains that one)
    cause: u16,             // and for the icon on the damage number
    loosed: Loosed,         // when and by whom: the order arrows land their blows in
    pub team: u8,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub dx: f64, // flight direction (unit length)
    pub dz: f64,
    pub speed: f64,
    left: f64, // metres of range left
    damage: f64,
    knock: f64,
    pierce_left: usize, // how many more enemies it can go through
    hit: Vec<u32>,      // who it already hit: 1 << 30 | actor id, or 1 << 31 | player slot
}

impl Arrow {
    /// When it was loosed and by whom: the same in every simulation, where its id is its own.
    pub fn loosed(&self) -> Loosed {
        self.loosed
    }
}

/// A meteor on its way down.
pub struct Meteor {
    pub id: u16,
    owner_slot: usize,      // who called it down, for "you hit X" events
    owner_client: EntityId, // and who was in that slot, for what it finishes off
    cause: u16,             // the ability that called it, for the icon on the damage number
    loosed: Loosed,         // when and by whom: the order meteors land their blows in
    pub team: u8,
    pub x: f64,
    pub z: f64,
    pub ticks_left: u32,
    pub fall_ticks: u32,
    pub radius: f64,
    damage: f64,
    knock: f64,
}

impl Meteor {
    /// When it was called down and by whom.
    pub fn loosed(&self) -> Loosed {
        self.loosed
    }
}

/// Whom a blow lands on: a creature (by its id) or a player (by their slot). Creatures come first.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
pub enum Target {
    Creature(u32),
    Player(usize),
}

/// When something in flight was loosed and by whom: the tick, the slot, and how many that player
/// had loosed before it that tick. Arrows are kept in this order as they fly, and so are meteors.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Default, Serialize, Deserialize)]
pub struct Loosed {
    pub tick: u64,
    pub slot: usize,
    pub n: u32,
}

/// Where a blow came from, which orders the blows landing on one target: a player's swing (by their
/// slot); what's in flight, arrows before meteors, each by when and by whom it was loosed.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
pub enum Source {
    Swing(usize),
    Arrow(Loosed),
    Meteor(Loosed),
}

/// A blow, an arrow or a blast that reached someone, applied once everything that could have
/// dealt one this phase has gone: by whom it lands on, then by `source`, then in the order its
/// source dealt them (`seq`). Across a border it goes to whoever owns its target (crate::border).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Blow {
    pub target: Target,
    pub source: Source,
    pub seq: u32,
    /// Who is credited with it, and told about it: their slot and who was in it.
    pub by_slot: usize,
    pub by_client: EntityId,
    /// The weapon it trains, if a weapon dealt it (a blast trains nothing: its cast already did).
    pub weapon: Option<u8>,
    pub cause: u16,
    pub damage: f64,
    pub nx: f64,
    pub nz: f64,
    pub knock: f64,
}

impl Blow {
    fn key(&self) -> (Target, Source, u32) {
        (self.target, self.source, self.seq)
    }
}

/// One player a Healing Circle reached, applied once everyone has stepped (by whom it reaches, then
/// whom from, then in the order they cast).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HealHit {
    pub healer: usize,
    pub target: usize,
    pub seq: u32,
    pub amount: f64,
    pub cause: u16,
}

impl HealHit {
    fn key(&self) -> (usize, usize, u32) {
        (self.target, self.healer, self.seq)
    }
}

/// When a told thing happens among a phase's: blows' before heals', each in the order they landed,
/// and for one blow what its dealer is told, then what its target is, then the dealer's credit.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
pub struct TellKey {
    pub heal: bool,
    pub target: Target,
    pub source: Source,
    pub seq: u32,
    pub role: u8,
}

/// What a landed blow or heal means for a player who dealt or took it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Tell {
    /// A number shown to them alone: its kind and cause (the wire's), where, and how much.
    Note { kind: u16, cause: u16, x: f64, y: f64, z: f64, amount: f64 },
    /// A hit to credit them with: the weapon it trains, and the kind of creature it finished off.
    Credit { weapon: Option<u8>, died: Option<u8> },
}

/// Something to tell the player in `slot` (if it's still `client`; None: whoever is there), once
/// every blow of the phase has landed, wherever it landed ([`Players::settle`]).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Told {
    pub key: TellKey,
    pub slot: usize,
    pub client: Option<EntityId>,
    pub tell: Tell,
}

/// What a phase does to what another simulation holds, across a border (crate::border): blows and
/// heals on its players and creatures, and what its players are to be told of blows that landed
/// here.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Across {
    pub blows: Vec<Blow>,
    pub heals: Vec<HealHit>,
    pub told: Vec<Told>,
}

impl Across {
    pub fn is_empty(&self) -> bool {
        self.blows.is_empty() && self.heals.is_empty() && self.told.is_empty()
    }

    pub fn extend(&mut self, other: Across) {
        self.blows.extend(other.blows);
        self.heals.extend(other.heals);
        self.told.extend(other.told);
    }
}

/// A phase worked out and waiting to land ([`Players::land`]), then to be told ([`Players::settle`]).
#[derive(Default)]
pub struct Landing {
    blows: Vec<Blow>,
    heals: Vec<HealHit>,
    told: Vec<Told>,
    /// Slots whose island something was built on this phase.
    built: Vec<usize>,
    /// What lands on or is told to what another simulation holds, for its owner.
    pub away: Across,
}

impl Landing {
    /// What blows that landed in another simulation mean for players here, to be told with the
    /// rest ([`Players::settle`]).
    pub fn tell(&mut self, told: Vec<Told>) {
        self.told.extend(told);
    }
}

/// A player handed from one simulation to another across a border ([`Players::depart`],
/// [`Players::arrive`]): everything their slot holds, so the step they take next is the one they
/// would have taken where they were.
pub struct Departing {
    pub slot: usize,
    pub client: EntityId,
    pub owner: i64,
    pub player: Player,
    pub life: Option<Box<Life>>,
    /// The last input run, and the last build applied.
    pub last_seq: u32,
    pub build_seq: u32,
    /// Inputs given and not yet run (seq, view tick, actions), and commands given with them.
    pub queue: Vec<(u32, f64, Actions)>,
    pub commands: Vec<(u32, Command)>,
    /// Inputs they may still run before the next refill.
    pub budget: f64,
    /// Where they stood at the end of each of the last ticks.
    pub history: History,
}

/// Something that happened, for effects in browsers: its kind (the wire's numbers above), where, and
/// its size (a radius in tenths of a metre, or an amount).
pub struct Effect {
    pub kind: u16,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub size: u8,
}

/// What one player's step does to everyone else, handed back to be applied once everyone has
/// stepped.
#[derive(Default)]
struct Outbox {
    blows: Vec<Blow>,
    heals: Vec<HealHit>,
    /// Arrows loosed and meteors called down, given their ids once everyone has stepped.
    arrows: Vec<Arrow>,
    meteors: Vec<Meteor>,
    /// Effects for everyone near (Healing Circles).
    shown: Vec<Effect>,
    /// For the admins' numbers: how far each blow on a player was rewound, how many landed only
    /// because of it, how many circles were cast.
    rewinds: Vec<f64>,
    saved: u64,
    circles: u64,
    /// The island changed shape (something was built), to be made solid once everyone has stepped.
    built: bool,
}

/// One player's part of a tick ([`Players::step_by`]): its slot, taken out while it steps, and what
/// it does to everyone else.
pub struct Job {
    index: usize,
    slot: Slot,
    out: Outbox,
}

impl Job {
    /// The slot it plays in.
    pub fn slot(&self) -> usize {
        self.index
    }

    /// Where its player stands (x, z) as the tick begins.
    pub fn at(&self) -> (f64, f64) {
        (self.slot.player.pos.x, self.slot.player.pos.z)
    }
}

/// The hits a player landed with `weapon` (None: a blast, which trains nothing; its cast already
/// did), in the order they landed, each with the kind of creature it finished off if it did. Only
/// a player with an island learns from them (`Observed`, crate::life::progress): practice for the
/// weapon, and a defeat for the quests, hit then death for each in turn. A level gained changes the
/// player's numbers from the next step on.
fn credit(life: &mut Life, p: &mut Player, weapon: Option<u8>, landed: &[Option<&str>]) {
    let mut levelled = false;
    for died in landed {
        if let Some(w) = weapon {
            levelled |= life.observe(Observed::Hit { weapon: w });
        }
        if let Some(kind) = died {
            levelled |= life.observe(Observed::Defeat { kind });
        }
    }
    if levelled {
        sync_levels(life, p);
    }
}

/// The kind of creature a death was, as quests name it.
fn kind_of(kind_index: u8) -> Option<&'static str> {
    kind_at(kind_index as usize).map(|k| k.id.as_str())
}

/// What every player's step reads while everyone steps: the others and the creatures as they stood
/// when the tick began (and the tracks of where they stood before), and the ground. Nothing here
/// changes until everyone has stepped.
struct Before<'a> {
    seen: &'a [Seen],
    tracks: &'a [Track],
    creature_tracks: &'a BTreeMap<u32, Track>,
    actors: &'a Actors,
    open: &'a OpenWorld,
    floor: Option<&'static DungeonDef>,
    ground: Option<&'static Heightfield>,
    tick: u64,
    tick_ms: f64,
    inputs_per_tick: f64,
}

impl Before<'_> {
    fn ground_at(&self, x: f64, z: f64) -> f64 {
        ground_under(self.floor, self.ground, x, z)
    }

    /// One player's waiting inputs, in order: weapon swings land, arrows fly off, and finished casts
    /// heal or call down meteors, on everyone as they stood when the tick began.
    fn step(&self, job: &mut Job) {
        let (s, slot, out) = (job.index, &mut job.slot, &mut job.out);
        let revision = slot.life.as_ref().map(|l| l.revision);
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
            // The island's commands given on or before this input run with it.
            if let Some(life) = slot.life.as_deref_mut() {
                while slot.commands.front().is_some_and(|(cs, _)| *cs <= seq) {
                    let (_, c) = slot.commands.pop_front().unwrap();
                    life.command(c);
                }
            }
            crate::open::step_player(&mut slot.player, &a, self.open, slot.life.as_deref_mut(), slot.owner);
            slot.last_seq = seq;
            if self.inputs_per_tick > 0.0 {
                slot.budget -= 1.0;
            }
            used += 1;
            if let Some(swing) = slot.player.active_swing() {
                if swing.projectile_speed > 0.0 {
                    let loosed = Loosed { tick: self.tick, slot: s, n: out.arrows.len() as u32 };
                    out.arrows.push(arrow(s, slot.client_id, &slot.player, &swing, loosed));
                    slot.player.attack_hit = true;
                } else {
                    let latest = self.tick.saturating_sub(1) as f64;
                    let view = view.clamp(latest - MAX_REWIND_TICKS, latest);
                    // One swing lands once, as checkHit's attackHit has it: on whoever it reached.
                    if self.swing(s, slot, view, latest, &swing, out) > 0 {
                        slot.player.attack_hit = true;
                    }
                }
            }
            // A finished cast runs each of its ability's effects. Adding an ability built
            // from these is a data change; only a new effect kind reaches this match.
            if slot.player.fired_ability != NO_ABILITY {
                let a = slot.player.fired_ability;
                for i in 0..ability(a).effects.len() {
                    match ability(a).effects[i].kind.as_str() {
                        "healArea" => self.heal_area(s, a, i, slot, out),
                        "delayedArea" => {
                            let loosed = Loosed { tick: self.tick, slot: s, n: out.meteors.len() as u32 };
                            out.meteors.push(self.meteor(s, slot.client_id, a, i, &slot.player, loosed));
                        }
                        other => debug_assert!(false, "unknown effect kind: {other}"),
                    }
                }
            }
        }
        if slot.queue.len() > 120 {
            let extra = slot.queue.len() - 120;
            slot.queue.drain(..extra);
        }
        out.built = slot.life.as_ref().map(|l| l.revision) != revision;
    }

    /// Melee: whoever is in front of a swinging player, players and creatures alike, each judged
    /// where the swinger saw them (tick `view`). Returns how many it reached.
    fn swing(&self, s: usize, slot: &Slot, view: f64, latest: f64, step: &AttackStep, out: &mut Outbox) -> usize {
        let p = &slot.player;
        let max = melee_targets(p.weapon, &p.resolved);
        let players = self.swing_players(s, slot.client_id, p, view, latest, step, max, out);
        // On hills nothing is in reach from more than 2 m up, and only feet within 2 m of yours.
        let hf = self.open.terrain();
        let under = hf.water.max(crate::open::colliders::ground_at(hf, &self.open.index, p.pos.x, p.pos.z, p.pos.y, 0.0));
        let creatures = if p.pos.y - under <= 2.0 { self.swing_creatures(s, slot.client_id, p, view, step, max, Some(p.pos.y), out) } else { 0 };
        players + creatures
    }

    /// The players a swing reaches, each checked where the attacker saw them (tick `view`).
    #[allow(clippy::too_many_arguments)]
    fn swing_players(&self, s: usize, client: EntityId, a: &Player, view: f64, latest: f64, step: &AttackStep, max: usize, out: &mut Outbox) -> usize {
        // High in the air, a swing reaches nobody: two metres above the ground under you (a copy's
        // floor, or the world's terrain).
        let floor = self.ground_at(a.pos.x, a.pos.z);
        if a.pos.y - floor > 2.0 {
            return 0;
        }
        let reach = step.reach + BODY_RADIUS;
        let half_arc = step.arc_deg.to_radians() / 2.0;
        // Direction to the target if it's within reach and in front, else None.
        let check = |tx: f64, ty: f64, tz: f64| -> Option<(f64, f64)> {
            let (dx, dz) = (tx - a.pos.x, tz - a.pos.z);
            let dist = (dx * dx + dz * dz).sqrt();
            let in_front = angle_diff(a.facing, dx.js_atan2(dz)).abs() <= half_arc || dist < BODY_RADIUS + 0.3;
            if dist > reach || (ty - a.pos.y).abs() > 2.0 || !in_front {
                return None;
            }
            Some(if dist > 1e-6 { (dx / dist, dz / dist) } else { (a.facing.js_sin(), a.facing.js_cos()) })
        };
        let mut hits = 0;
        for o in self.seen {
            if hits >= max {
                break;
            }
            if o.slot == s || o.team == a.team || o.down {
                continue;
            }
            let (x, y, z) = self.tracks[o.slot].at(view).unwrap_or((o.x, o.y, o.z));
            let Some((nx, nz)) = check(x, y, z) else { continue };
            out.blows.push(Blow {
                target: Target::Player(o.slot),
                source: Source::Swing(s),
                seq: out.blows.len() as u32,
                by_slot: s,
                by_client: client,
                weapon: Some(a.weapon),
                cause: weapon_cause(a.weapon),
                damage: step.damage,
                nx,
                nz,
                knock: step.player_knock,
            });
            hits += 1;
            out.rewinds.push(latest - view);
            if check(o.x, o.y, o.z).is_none() {
                out.saved += 1; // without rewinding, this would have missed
            }
        }
        hits
    }

    /// The creatures a swing reaches, each judged where the attacker saw it (tick `view`), on hills
    /// only those whose feet are within 2 m of the swinger's (`feet`).
    #[allow(clippy::too_many_arguments)]
    fn swing_creatures(&self, s: usize, client: EntityId, p: &Player, view: f64, step: &AttackStep, max: usize, feet: Option<f64>, out: &mut Outbox) -> usize {
        let (floor, terrain, tracks) = (self.floor, self.ground, self.creature_tracks);
        let place = |a: &crate::actor::Actor| {
            let (x, y, z) = tracks.get(&a.id).and_then(|t| t.at(view)).unwrap_or((a.x, a.y, a.z));
            match (terrain, feet) {
                (Some(_), Some(fy)) => ((y + ground_under(floor, terrain, x, z) - fy).abs() <= 2.0).then_some((x, z)),
                _ => Some((x, z)),
            }
        };
        let hits = self.actors.cone_hits_at(p.pos.x, p.pos.z, p.facing, step.reach, step.arc_deg, max, place);
        for &(id, ax, az) in &hits {
            let (dx, dz) = (ax - p.pos.x, az - p.pos.z);
            let d = (dx * dx + dz * dz).sqrt().max(0.0001);
            out.blows.push(Blow {
                target: Target::Creature(id),
                source: Source::Swing(s),
                seq: out.blows.len() as u32,
                by_slot: s,
                by_client: client,
                weapon: Some(p.weapon),
                cause: weapon_cause(p.weapon),
                damage: step.damage,
                nx: dx / d,
                nz: dz / d,
                knock: step.player_knock,
            });
        }
        hits.len()
    }

    /// healArea: restores health to the caster at once, and to every ally standing inside the
    /// circle (where they stood as the tick began) once everyone has stepped.
    fn heal_area(&self, s: usize, a: u8, fx: usize, slot: &mut Slot, out: &mut Outbox) {
        let Slot { player: healer, told, .. } = slot;
        let e = &ability(a).effects[fx];
        let radius = effect_radius(a, e, &healer.resolved);
        let amount = effect_amount(a, e, &healer.resolved);
        if healer.down_frame < 0 {
            let before = healer.hp;
            healer.hp = (healer.hp + amount).min(tuning().combat.max_hp);
            let gained = healer.hp - before;
            note(told, EVENT_YOU_HEAL, ability_cause(a), healer.pos.x, healer.pos.y + MARKER_HEIGHT, healer.pos.z, gained);
        }
        for o in self.seen.iter().filter(|o| o.slot != s) {
            let (dx, dz) = (o.x - healer.pos.x, o.z - healer.pos.z);
            if o.team == healer.team && dx * dx + dz * dz <= radius * radius {
                out.heals.push(HealHit { healer: s, target: o.slot, seq: out.heals.len() as u32, amount, cause: ability_cause(a) });
            }
        }
        out.shown.push(Effect { kind: EVENT_HEAL, x: healer.pos.x, y: healer.pos.y, z: healer.pos.z, size: (radius * 10.0) as u8 });
        out.circles += 1;
    }

    /// delayedArea: something starts falling on the target spot and blasts it after a delay.
    fn meteor(&self, caster_slot: usize, caster_client: EntityId, a: u8, fx: usize, caster: &Player, loosed: Loosed) -> Meteor {
        let e = &ability(a).effects[fx];
        let fall_ticks = ((e.delay_frames as f64 / 60.0 * 1000.0 / self.tick_ms).round() as u32).max(1);
        Meteor {
            id: 0,
            owner_slot: caster_slot,
            owner_client: caster_client,
            cause: ability_cause(a),
            loosed,
            team: caster.team,
            x: caster.cast_target_x,
            z: caster.cast_target_z,
            ticks_left: fall_ticks,
            fall_ticks,
            radius: effect_radius(a, e, &caster.resolved),
            damage: effect_damage(a, e, &caster.resolved),
            knock: e.knock,
        }
    }
}

/// An arrow loosed by the player in `owner_slot` (its id is given once everyone has stepped).
fn arrow(owner_slot: usize, owner_client: EntityId, shooter: &Player, shot: &AttackStep, loosed: Loosed) -> Arrow {
    let (dx, dz) = (shooter.facing.js_sin(), shooter.facing.js_cos());
    Arrow {
        id: 0,
        owner: owner_slot as u16,
        owner_slot,
        owner_client,
        weapon: shooter.weapon,
        cause: weapon_cause(shooter.weapon),
        loosed,
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
        pierce_left: pierce_targets(shooter.weapon, &shooter.resolved),
        hit: Vec::new(),
    }
}

/// Steps every job in the order given (one after another, as `step_in` does).
pub fn in_order(jobs: &mut [Job], step: &(dyn Fn(&mut Job) + Sync)) {
    jobs.iter_mut().for_each(step);
}

pub struct Players {
    /// In a channel of the world: its ground, so heights can be measured from it.
    pub ground: Option<&'static Heightfield>,
    /// A copy of a dungeon or a developer zone: its floor, which is the ground where it has one.
    pub floor: Option<&'static DungeonDef>,
    /// Refill each player's input budget by this many inputs per tick. 0 (the balance harness's
    /// duels) runs whatever arrives, up to MAX_INPUTS_PER_TICK.
    pub inputs_per_tick: f64,
    slots: Vec<Option<Slot>>,
    by_client: BTreeMap<EntityId, usize>,
    /// Where the player in each slot stood at the end of each of the last ticks.
    tracks: Vec<Track>,
    /// And every creature, by its id.
    creature_tracks: BTreeMap<u32, Track>,
    tick_ms: f64,
    pub pvp_hits: u64,
    pub saved_by_rewind: u64, // hits that only landed because of lag compensation
    pub heals: u64,
    pub meteors_landed: u64,
    rewind_recent: f64, // recent average rewind (ticks) for player-vs-player hits
    rewind_samples: u64,
    arrows: Vec<Arrow>,
    meteors: Vec<Meteor>,
    events: Vec<Effect>, // things that happened this tick, for effects in browsers
    next_effect_id: u16,
}

impl Players {
    pub fn new(tick_ms: f64) -> Self {
        Players {
            ground: None,
            floor: None,
            inputs_per_tick: 0.0,
            slots: (0..MAX_PLAYERS).map(|_| None).collect(),
            by_client: BTreeMap::new(),
            tracks: vec![Track::default(); MAX_PLAYERS],
            creature_tracks: BTreeMap::new(),
            tick_ms,
            pvp_hits: 0,
            saved_by_rewind: 0,
            heals: 0,
            meteors_landed: 0,
            rewind_recent: 0.0,
            rewind_samples: 0,
            arrows: Vec::new(),
            meteors: Vec::new(),
            events: Vec::new(),
            next_effect_id: 0,
        }
    }

    /// Tells the player in `slot`, if it's still `client` (None: whoever is there), about something
    /// that happened to them or because of them.
    #[allow(clippy::too_many_arguments)]
    fn note_for(&mut self, slot: usize, client: Option<EntityId>, kind: u16, cause: u16, x: f64, y: f64, z: f64, amount: f64) {
        if let Some(Some(s)) = self.slots.get_mut(slot)
            && client.is_none_or(|c| c == s.client_id)
        {
            note(&mut s.told, kind, cause, x, y, z, amount);
        }
    }

    /// Recent average rewind applied to player-vs-player hits, in milliseconds.
    pub fn rewind_ms(&self) -> f64 {
        if self.rewind_samples == 0 { 0.0 } else { self.rewind_recent * self.tick_ms }
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

    /// Puts a new player in the first free slot, with no history of where they stood. The slot, or
    /// None if every one is taken.
    fn seat(&mut self, slot: Slot) -> Option<usize> {
        let free = self.slots.iter().position(|s| s.is_none())?;
        self.by_client.insert(slot.client_id, free);
        self.slots[free] = Some(slot);
        self.tracks[free] = Track::default();
        Some(free)
    }

    /// A player without an island (the balance harness's duellists), as `player` (already placed, on
    /// their side). Returns false if they're already here or there's no room.
    pub fn join_at(&mut self, client_id: EntityId, player: Player) -> bool {
        if self.by_client.contains_key(&client_id) {
            return false;
        }
        self.seat(Slot::new(client_id, player, 0, None)).is_some()
    }

    /// Open worlds: a character arrives, as `player` (already placed), carrying their island.
    /// Returns false if they're already here or there's no room.
    pub fn join_open(&mut self, client_id: EntityId, owner: i64, player: Player, life: Box<Life>) -> bool {
        if self.by_client.contains_key(&client_id) {
            return false;
        }
        self.seat(Slot::new(client_id, player, owner, Some(life))).is_some()
    }

    /// Open worlds: takes a player out (they left), with their island.
    pub fn leave(&mut self, client_id: EntityId) -> Option<(Player, Option<Box<Life>>)> {
        let s = self.by_client.remove(&client_id)?;
        let slot = self.slots[s].take()?;
        self.tracks[s] = Track::default();
        Some((slot.player, slot.life))
    }

    // ---- Across a border (crate::border) ----

    /// Open worlds: a character arrives in a slot of the caller's choosing (theirs in every
    /// simulation of a world split between several, which all order by slot), as `player`,
    /// carrying their island. False if they're here already or the slot is taken.
    pub fn join_open_at(&mut self, slot: usize, client_id: EntityId, owner: i64, player: Player, life: Box<Life>) -> bool {
        if self.by_client.contains_key(&client_id) || self.slots.get(slot).is_none_or(Option::is_some) {
            return false;
        }
        self.by_client.insert(client_id, slot);
        self.slots[slot] = Some(Slot::new(client_id, player, owner, Some(life)));
        self.tracks[slot] = Track::default();
        true
    }

    /// Another simulation's player seen here across a border, or seen again as they stand now: in
    /// their `slot`, for everyone here to see, swing at and heal, with their vehicles solid. Never
    /// stepped here, and whatever lands on them is handed back for their owner ([`Players::land`]).
    /// A ghost new here has no history until it's given one ([`Players::set_history`]). False where
    /// one of this simulation's own players sits.
    pub fn ghost(&mut self, slot: usize, client: EntityId, owner: i64, player: Player, vehicles: Vec<Vehicle>) -> bool {
        match self.slots.get_mut(slot) {
            Some(Some(s)) if s.own() => false,
            Some(Some(s)) => {
                s.client_id = client;
                s.owner = owner;
                s.player = player;
                s.away = Some(vehicles);
                true
            }
            Some(cell) => {
                let mut s = Slot::new(client, player, owner, None);
                s.away = Some(vehicles);
                *cell = Some(s);
                self.tracks[slot] = Track::default();
                true
            }
            None => false,
        }
    }

    /// A ghost seen here no longer (out of sight across the border, or about to be this
    /// simulation's own). False if `slot` holds no ghost.
    pub fn unghost(&mut self, slot: usize) -> bool {
        if !self.is_ghost(slot) {
            return false;
        }
        self.slots[slot] = None;
        self.tracks[slot] = Track::default();
        true
    }

    /// Whether `slot` holds a ghost.
    pub fn is_ghost(&self, slot: usize) -> bool {
        matches!(self.slots.get(slot), Some(Some(s)) if !s.own())
    }

    /// Whether `slot` holds one of this simulation's own players.
    pub fn is_own(&self, slot: usize) -> bool {
        matches!(self.slots.get(slot), Some(Some(s)) if s.own())
    }

    /// The character in `slot`, one of this simulation's or a ghost.
    pub fn owner_of_slot(&self, slot: usize) -> Option<i64> {
        self.slots.get(slot)?.as_ref().map(|s| s.owner)
    }

    /// The slot a character is in, one of this simulation's or a ghost.
    pub fn slot_of_owner(&self, owner: i64) -> Option<usize> {
        self.slots.iter().position(|s| s.as_ref().is_some_and(|s| s.owner == owner))
    }

    /// Every ghost here, by slot.
    pub fn ghosts(&self) -> impl Iterator<Item = usize> + '_ {
        self.slots.iter().enumerate().filter(|(_, s)| s.as_ref().is_some_and(|s| !s.own())).map(|(i, _)| i)
    }

    /// Where the player in `slot` stood at the end of each of the last ticks, oldest first.
    pub fn history(&self, slot: usize) -> History {
        self.tracks.get(slot).map(|t| t.0.iter().copied().collect()).unwrap_or_default()
    }

    /// Where a ghost stood, as its owner kept it, for swings rewound to where their swinger saw it.
    pub fn set_history(&mut self, slot: usize, history: &[(u64, f64, f64, f64)]) {
        if let Some(t) = self.tracks.get_mut(slot) {
            *t = Track(history.iter().copied().collect());
        }
    }

    /// Where the creature `id` stood at the end of each of the last ticks, oldest first.
    pub fn creature_history(&self, id: u32) -> History {
        self.creature_tracks.get(&id).map(|t| t.0.iter().copied().collect()).unwrap_or_default()
    }

    /// Where a creature seen across a border stood, as its owner kept it.
    pub fn set_creature_history(&mut self, id: u32, history: &[(u64, f64, f64, f64)]) {
        self.creature_tracks.insert(id, Track(history.iter().copied().collect()));
    }

    /// One of this simulation's players handed to another across a border: their slot taken out
    /// whole (what they'd given and not yet run, their island, where they stood). None if `slot`
    /// holds none of its own.
    pub fn depart(&mut self, slot: usize) -> Option<Departing> {
        if !self.is_own(slot) {
            return None;
        }
        let s = self.slots[slot].take()?;
        self.by_client.remove(&s.client_id);
        let history = std::mem::take(&mut self.tracks[slot]).0.into_iter().collect();
        Some(Departing {
            slot,
            client: s.client_id,
            owner: s.owner,
            player: s.player,
            life: s.life,
            last_seq: s.last_seq,
            build_seq: s.build_seq,
            queue: s.queue.into_iter().collect(),
            commands: s.commands.into_iter().collect(),
            budget: s.budget,
            history,
        })
    }

    /// A player handed over from another simulation takes their slot here, in place of their
    /// ghost, as they left the other. False if they're here already or one of this simulation's
    /// own players sits there.
    pub fn arrive(&mut self, d: Departing) -> bool {
        if self.by_client.contains_key(&d.client) || d.slot >= MAX_PLAYERS || self.is_own(d.slot) {
            return false;
        }
        let mut s = Slot::new(d.client, d.player, d.owner, d.life);
        s.last_seq = d.last_seq;
        s.build_seq = d.build_seq;
        s.queue = d.queue.into_iter().collect();
        s.commands = d.commands.into_iter().collect();
        s.budget = d.budget;
        self.slots[d.slot] = Some(s);
        self.by_client.insert(d.client, d.slot);
        self.tracks[d.slot] = Track(d.history.into_iter().collect());
        true
    }

    /// Open worlds: inputs as (seq, view tick, actions). The view tick is the (fractional) tick the
    /// player saw everyone else at, so a swing at another player, a bot or a creature is checked
    /// against where they were then (their `Track`); `f64::INFINITY` sees the present (bots, tests).
    pub fn queue_actions(&mut self, client_id: EntityId, inputs: impl Iterator<Item = (u32, f64, Actions)>) {
        let Some(&s) = self.by_client.get(&client_id) else { return };
        if let Some(slot) = &mut self.slots[s] {
            for (seq, view, a) in inputs {
                slot.queue.push_back((seq, view, a));
            }
        }
    }

    /// Open worlds: a new window (or a reconnect) counts its inputs from 1 again.
    pub fn restart_inputs(&mut self, client_id: EntityId) {
        let Some(&s) = self.by_client.get(&client_id) else { return };
        if let Some(slot) = &mut self.slots[s] {
            slot.last_seq = 0;
            slot.queue.clear();
            slot.commands.clear();
            slot.budget = 0.0;
        }
    }

    /// Open worlds: a command for the island, given on input `seq`.
    pub fn queue_command(&mut self, client_id: EntityId, seq: u32, c: Command) {
        let Some(&s) = self.by_client.get(&client_id) else { return };
        if let Some(slot) = &mut self.slots[s]
            && slot.commands.len() < 64
        {
            slot.commands.push_back((seq, c));
        }
    }

    /// Open worlds: a player, the last input they've had run, and their island.
    pub fn open_view(&self, client_id: EntityId) -> Option<(&Player, u32, Option<&Life>)> {
        let &s = self.by_client.get(&client_id)?;
        let slot = self.slots[s].as_ref()?;
        Some((&slot.player, slot.last_seq, slot.life.as_deref()))
    }

    /// Open worlds: a player and their island, to change (a new build, an island started over).
    pub fn open_mut(&mut self, client_id: EntityId) -> Option<(&mut Player, Option<&mut Life>)> {
        let &s = self.by_client.get(&client_id)?;
        let slot = self.slots[s].as_mut()?;
        Some((&mut slot.player, slot.life.as_deref_mut()))
    }

    /// Open worlds: everyone here, as (client id, character, player, island); not the ghosts of
    /// those across a border.
    pub fn each_open(&self) -> impl Iterator<Item = (EntityId, i64, &Player, Option<&Life>)> {
        self.slots.iter().flatten().filter(|s| s.own()).map(|s| (s.client_id, s.owner, &s.player, s.life.as_deref()))
    }

    /// Open worlds: everyone's island, to change between steps (who holds which plot).
    pub fn each_life_mut(&mut self) -> impl Iterator<Item = (i64, &mut Life)> {
        self.slots.iter_mut().flatten().filter_map(|s| {
            let owner = s.owner;
            s.life.as_deref_mut().map(|l| (owner, l))
        })
    }

    /// The slot a client plays in (open worlds address its effects by slot).
    pub fn slot_index(&self, client_id: EntityId) -> Option<usize> {
        self.by_client.get(&client_id).copied()
    }

    /// Height of the ground under a point: a copy's floor where it has one, the open world's
    /// terrain, or 0 on a flat World.
    fn ground_at(&self, x: f64, z: f64) -> f64 {
        ground_under(self.floor, self.ground, x, z)
    }

    /// Tools that drive the rules headlessly (bin/balance.rs): applies the build a player asked
    /// for, if it's new and allowed (within skills.points, learned outward from a root, a weapon
    /// they've trained, abilities they've learned).
    pub fn sync_build(&mut self, client_id: EntityId, seq: u32, build: Build) {
        let Some(&s) = self.by_client.get(&client_id) else { return };
        let Some(slot) = &mut self.slots[s] else { return };
        if slot.build_seq == seq {
            return;
        }
        slot.build_seq = seq;
        if allowed(&build, tuning().skills.points) {
            slot.player.apply_build(build);
        }
    }

    /// Credits the player in `slot`, if it's still `client` and has an island, with what one of
    /// their blows, arrows or meteors did (see credit()).
    fn credit_owner(&mut self, slot: usize, client: EntityId, weapon: Option<u8>, landed: &[Option<&str>]) {
        let Some(Some(s)) = self.slots.get_mut(slot) else { return };
        if s.client_id != client {
            return;
        }
        if let Some(life) = s.life.as_deref_mut() {
            credit(life, &mut s.player, weapon, landed);
        }
    }

    /// Everyone here as they stand now, in the order of their slots.
    fn seen(&self) -> Vec<Seen> {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(i, s)| {
                let p = &s.as_ref()?.player;
                Some(Seen { slot: i, team: p.team, down: p.down_frame >= 0, x: p.pos.x, y: p.pos.y, z: p.pos.z, facing: p.facing })
            })
            .collect()
    }

    /// Runs each player's waiting inputs in order, in `world` (a channel's, or a copy of an
    /// instance): each moves over its ground with their island stepping along, weapon swings land,
    /// arrows fly off, and finished casts heal or call down meteors. `tick` is the tick being worked
    /// out now.
    pub fn step_in(&mut self, actors: &mut Actors, tick: u64, world: &mut OpenWorld) {
        self.step_by(actors, tick, world, in_order);
    }

    /// The same, with every player's step a [`Job`] that `drive` runs: one after another in any
    /// order, or all at once on threads of its own (the server's choice; the engine has none). Each
    /// job reads the others, the creatures and the world only as they were when the tick began, and
    /// what it does to them is applied once every one has run, in an order of its own (the module's
    /// doc): so however `drive` runs them, the tick comes out the same. What anyone built is made
    /// solid after that, island by island in the order of the slots.
    pub fn step_by(&mut self, actors: &mut Actors, tick: u64, world: &mut OpenWorld, drive: impl FnOnce(&mut [Job], &(dyn Fn(&mut Job) + Sync))) {
        let mut landing = self.work_out(actors, tick, world, drive);
        self.land(&mut landing, actors, Across::default());
        self.settle(landing, Vec::new(), Some(world));
    }

    /// The first part of [`Players::step_by`]: every player's waiting inputs run (not the ghosts'),
    /// each reading the others, the creatures and the world as they were when the tick began. What
    /// they did to anyone, to land ([`Players::land`]).
    pub fn work_out(&mut self, actors: &Actors, tick: u64, world: &OpenWorld, drive: impl FnOnce(&mut [Job], &(dyn Fn(&mut Job) + Sync))) -> Landing {
        self.events.clear();
        let seen = self.seen();
        let mut jobs: Vec<Job> = Vec::with_capacity(seen.len());
        for (index, cell) in self.slots.iter_mut().enumerate() {
            if cell.as_ref().is_some_and(Slot::own)
                && let Some(mut slot) = cell.take()
            {
                slot.told.clear();
                jobs.push(Job { index, slot, out: Outbox::default() });
            }
        }
        {
            let before = Before {
                seen: &seen,
                tracks: &self.tracks,
                creature_tracks: &self.creature_tracks,
                actors,
                open: world,
                floor: self.floor,
                ground: self.ground,
                tick,
                tick_ms: self.tick_ms,
                inputs_per_tick: self.inputs_per_tick,
            };
            drive(&mut jobs, &|job: &mut Job| before.step(job));
        }
        // Everyone back in their slot, and what each did gathered in the order of the slots.
        jobs.sort_by_key(|j| j.index);
        let mut landing = Landing::default();
        for Job { index, slot, out } in jobs {
            self.slots[index] = Some(slot);
            if out.built {
                landing.built.push(index);
            }
            self.saved_by_rewind += out.saved;
            for r in out.rewinds {
                self.rewind_recent = if self.rewind_samples == 0 { r } else { self.rewind_recent * 0.8 + r * 0.2 };
                self.rewind_samples += 1;
            }
            self.heals += out.circles;
            self.events.extend(out.shown);
            for mut a in out.arrows {
                a.id = self.next_id();
                self.arrows.push(a);
            }
            for mut m in out.meteors {
                m.id = self.next_id();
                self.meteors.push(m);
            }
            landing.blows.extend(out.blows);
            landing.heals.extend(out.heals);
        }
        landing
    }

    /// Across a border (crate::border), before a phase lands: its blows and heals on what this
    /// simulation doesn't own (a ghost, a creature it only sees) moved to `landing.away`, for their
    /// owners to land among their own.
    pub fn send_away(&self, landing: &mut Landing, actors: &Actors) {
        let blows = std::mem::take(&mut landing.blows);
        let (away, here): (Vec<Blow>, Vec<Blow>) = blows.into_iter().partition(|b| match b.target {
            Target::Creature(id) => actors.get(id).is_none() && actors.ghost(id).is_some(),
            Target::Player(v) => self.is_ghost(v),
        });
        landing.blows = here;
        landing.away.blows.extend(away);
        let heals = std::mem::take(&mut landing.heals);
        let (away, here): (Vec<HealHit>, Vec<HealHit>) = heals.into_iter().partition(|h| self.is_ghost(h.target));
        landing.heals = here;
        landing.away.heals.extend(away);
    }

    /// Lands a phase's blows, by whom each lands on, then whom from, then in the order its source
    /// dealt them; then its heals, by whom each reaches, then whom from. A blow on a creature already
    /// dead, or a player already down, does nothing: someone else finished them off first this tick.
    /// What each means for whoever dealt and took it is kept to be told ([`Players::settle`]).
    ///
    /// Across a border (crate::border): `from` is what other simulations dealt this one's players and
    /// creatures, landing here among this one's own in that order. What lands on a ghost, or on a
    /// creature only seen here, and what's to be told to a player held elsewhere, is left in
    /// `landing.away` for their owners.
    pub fn land(&mut self, landing: &mut Landing, actors: &mut Actors, from: Across) {
        let mut blows = std::mem::take(&mut landing.blows);
        blows.extend(from.blows);
        blows.sort_by_key(Blow::key);
        let mut told = std::mem::take(&mut landing.told);
        told.extend(from.told);
        for b in blows {
            let key = TellKey { heal: false, target: b.target, source: b.source, seq: b.seq, role: 0 };
            let dealt = |role: u8, tell: Tell| Told { key: TellKey { role, ..key }, slot: b.by_slot, client: Some(b.by_client), tell };
            match b.target {
                Target::Creature(id) => {
                    let Some(a) = actors.get(id) else {
                        if actors.ghost(id).is_some() {
                            landing.away.blows.push(b);
                        }
                        continue;
                    };
                    if !a.is_alive() {
                        continue;
                    }
                    let ground = self.ground_at(a.x, a.z);
                    let (x, y, z) = (a.x, a.y + a.hit_height + ground, a.z);
                    let died = actors.damage(id, b.damage, b.nx, b.nz, b.knock).map(|d| d.kind_index);
                    told.push(dealt(0, Tell::Note { kind: EVENT_YOU_HIT, cause: b.cause, x, y, z, amount: b.damage }));
                    // A hit with the weapon that dealt it, and maybe a creature finished off.
                    told.push(dealt(2, Tell::Credit { weapon: b.weapon, died }));
                }
                Target::Player(v) => {
                    if self.is_ghost(v) {
                        landing.away.blows.push(b);
                        continue;
                    }
                    let Some(Some(slot)) = self.slots.get_mut(v) else { continue };
                    let p = &mut slot.player;
                    if p.down_frame >= 0 {
                        continue;
                    }
                    p.take_hit(b.damage, b.nx, b.nz, b.knock);
                    let (x, y, z) = (p.pos.x, p.pos.y + MARKER_HEIGHT, p.pos.z);
                    self.pvp_hits += 1;
                    told.push(dealt(0, Tell::Note { kind: EVENT_YOU_HIT, cause: b.cause, x, y, z, amount: b.damage }));
                    let hurt = Tell::Note { kind: EVENT_YOU_HURT, cause: b.cause, x, y, z, amount: b.damage };
                    told.push(Told { key: TellKey { role: 1, ..key }, slot: v, client: None, tell: hurt });
                    told.push(dealt(2, Tell::Credit { weapon: b.weapon, died: None }));
                }
            }
        }
        let mut heals = std::mem::take(&mut landing.heals);
        heals.extend(from.heals);
        heals.sort_by_key(HealHit::key);
        let max_hp = tuning().combat.max_hp;
        for h in heals {
            if self.is_ghost(h.target) {
                landing.away.heals.push(h);
                continue;
            }
            let healed = match &mut self.slots[h.target] {
                Some(t) if t.player.down_frame < 0 => {
                    let before = t.player.hp;
                    t.player.hp = (t.player.hp + h.amount).min(max_hp);
                    Some((t.player.pos.x, t.player.pos.y, t.player.pos.z, t.player.hp - before))
                }
                _ => None,
            };
            // Only what the heal actually restored: topping up someone at full health shows nothing.
            if let Some((x, y, z, gained)) = healed {
                let key = TellKey { heal: true, target: Target::Player(h.target), source: Source::Swing(h.healer), seq: h.seq, role: 0 };
                let tell = Tell::Note { kind: EVENT_YOU_HEAL, cause: h.cause, x, y: y + MARKER_HEIGHT, z, amount: gained };
                told.push(Told { key, slot: h.healer, client: None, tell: tell.clone() });
                if h.healer != h.target {
                    told.push(Told { key: TellKey { role: 1, ..key }, slot: h.target, client: None, tell });
                }
            }
        }
        // Whoever is held elsewhere is told there.
        for t in told {
            if self.is_own(t.slot) {
                landing.told.push(t);
            } else {
                landing.away.told.push(t);
            }
        }
    }

    /// What a phase's blows and heals mean for the players who dealt and took them, in the order
    /// they landed: the numbers each is shown, and the hits each is credited with (practice for the
    /// weapon, a defeat for the quests). With `from`, what blows that landed in other simulations mean
    /// for players here (crate::border). Then what anyone built is made solid.
    pub fn settle(&mut self, landing: Landing, from: Vec<Told>, open: Option<&mut OpenWorld>) {
        let mut told = landing.told;
        told.extend(from);
        told.sort_by_key(|t| t.key);
        for t in told {
            match t.tell {
                Tell::Note { kind, cause, x, y, z, amount } => self.note_for(t.slot, t.client, kind, cause, x, y, z, amount),
                Tell::Credit { weapon, died } => {
                    if let Some(client) = t.client {
                        self.credit_owner(t.slot, client, weapon, &[died.and_then(kind_of)]);
                    }
                }
            }
        }
        // What anyone built this tick, solid now that everyone has stepped past it.
        if let Some(world) = open {
            for i in landing.built {
                if let Some(Some(slot)) = self.slots.get(i)
                    && let Some(life) = slot.life.as_deref()
                {
                    life.make_solid(world, slot.owner);
                }
            }
        }
    }

    /// Moves arrows and lands meteors. Runs once per tick, after everyone has moved: each arrow and
    /// meteor against everyone as they stand when it begins, what they reach landing once all of
    /// them have gone.
    pub fn step_effects(&mut self, actors: &mut Actors) {
        let mut landing = self.fly_effects(actors);
        self.land(&mut landing, actors, Across::default());
        self.settle(landing, Vec::new(), None);
    }

    /// The first part of [`Players::step_effects`]: arrows moved and meteors come down, each
    /// against everyone as they stand. What they reached, to land ([`Players::land`]).
    pub fn fly_effects(&mut self, actors: &Actors) -> Landing {
        let dt = self.tick_ms / 1000.0;
        let seen = self.seen();
        let mut blows = Vec::new();
        let mut flying = Vec::with_capacity(self.arrows.len());
        for mut a in std::mem::take(&mut self.arrows) {
            if self.fly(&mut a, actors, &seen, dt, &mut blows) {
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
                self.explode(&m, actors, &seen, &mut blows);
            }
        }
        self.meteors = falling;
        Landing { blows, ..Landing::default() }
    }

    // Moves one arrow for one tick in short hops, hitting the first enemies in its path. Returns
    // false once it has run out of range or targets to pierce.
    fn fly(&mut self, a: &mut Arrow, actors: &Actors, seen: &[Seen], dt: f64, blows: &mut Vec<Blow>) -> bool {
        let travel = (a.speed * dt).min(a.left);
        let hops = ((travel / 0.5).ceil() as usize).max(1);
        let hop = travel / hops as f64;
        let mut seq = 0;
        let mut blow = |target: Target, a: &Arrow| {
            seq += 1;
            Blow {
                target,
                source: Source::Arrow(a.loosed),
                seq: seq - 1,
                by_slot: a.owner_slot,
                by_client: a.owner_client,
                weapon: Some(a.weapon),
                cause: a.cause,
                damage: a.damage,
                nx: a.dx,
                nz: a.dz,
                knock: a.knock,
            }
        };
        for _ in 0..hops {
            a.x += a.dx * hop;
            a.z += a.dz * hop;
            a.left -= hop;
            let ground = self.ground_at(a.x, a.z);
            if let Some(id) = actors.point_hit(a.x, a.y - ground, a.z, ARROW_RADIUS) {
                let key = 1u32 << 30 | id;
                if !a.hit.contains(&key) {
                    a.hit.push(key);
                    self.events.push(Effect { kind: EVENT_ARROW_HIT, x: a.x, y: a.y, z: a.z, size: a.damage as u8 });
                    blows.push(blow(Target::Creature(id), a));
                    a.pierce_left -= 1;
                    if a.pierce_left == 0 {
                        return false;
                    }
                }
            }
            for p in seen {
                let key = 1u32 << 31 | p.slot as u32;
                if p.team == a.team || p.down || a.hit.contains(&key) {
                    continue;
                }
                let (dx, dz) = (p.x - a.x, p.z - a.z);
                if dx * dx + dz * dz > ARROW_RADIUS * ARROW_RADIUS || a.y < p.y - 0.2 || a.y > p.y + 2.0 {
                    continue;
                }
                a.hit.push(key);
                self.events.push(Effect { kind: EVENT_ARROW_HIT, x: a.x, y: a.y, z: a.z, size: a.damage as u8 });
                blows.push(blow(Target::Player(p.slot), a));
                a.pierce_left -= 1;
                if a.pierce_left == 0 {
                    return false;
                }
            }
        }
        a.left > 0.0
    }

    // A meteor lands: everyone on the other team inside the blast is hurt and thrown outward, and
    // every creature in it.
    fn explode(&mut self, m: &Meteor, actors: &Actors, seen: &[Seen], blows: &mut Vec<Blow>) {
        let mut seq = 0;
        let mut blow = |target: Target, nx: f64, nz: f64| {
            seq += 1;
            Blow {
                target,
                source: Source::Meteor(m.loosed),
                seq: seq - 1,
                by_slot: m.owner_slot,
                by_client: m.owner_client,
                weapon: None,
                cause: m.cause,
                damage: m.damage,
                nx,
                nz,
                knock: m.knock,
            }
        };
        for p in seen {
            if p.team == m.team || p.down {
                continue;
            }
            let (dx, dz) = (p.x - m.x, p.z - m.z);
            let d = (dx * dx + dz * dz).sqrt();
            if d > m.radius {
                continue;
            }
            let (nx, nz) = if d > 1e-3 { (dx / d, dz / d) } else { (p.facing.js_sin(), p.facing.js_cos()) };
            blows.push(blow(Target::Player(p.slot), nx, nz));
        }
        for id in actors.circle_hits(m.x, m.z, m.radius) {
            let Some(a) = actors.any(id) else { continue };
            let (dx, dz) = (a.x - m.x, a.z - m.z);
            let d = (dx * dx + dz * dz).sqrt().max(1e-3);
            blows.push(blow(Target::Creature(id), dx / d, dz / d));
        }
        let ground = self.ground_at(m.x, m.z);
        self.events.push(Effect { kind: EVENT_EXPLOSION, x: m.x, y: ground, z: m.z, size: (m.radius * 10.0) as u8 });
        self.meteors_landed += 1;
    }

    /// Monsters' slams: everyone standing in one when it lands is hit, with the same dodge and
    /// guard rules as any other blow.
    pub fn apply_slams(&mut self, slams: &[Slam]) {
        let body = tuning().movement.player_radius;
        let (floor, terrain) = (self.floor, self.ground);
        for s in slams {
            // A ghost is slammed where its owner is (crate::border hands it the slam).
            for slot in self.slots.iter_mut().flatten().filter(|s| s.own()) {
                let p = &mut slot.player;
                let ground = ground_under(floor, terrain, p.pos.x, p.pos.z);
                if p.down_frame >= 0 || p.pos.y - ground > SLAM_LIFT {
                    continue;
                }
                let (dx, dz) = (p.pos.x - s.x, p.pos.z - s.z);
                let d = (dx * dx + dz * dz).sqrt();
                if d > s.radius + body {
                    continue;
                }
                let (nx, nz) = if d > 0.01 { (dx / d, dz / d) } else { (p.facing.js_sin(), p.facing.js_cos()) };
                let before = p.hp;
                p.take_hit(s.damage, nx, nz, s.knock);
                if p.hp < before {
                    let (x, y, z, taken) = (p.pos.x, p.pos.y, p.pos.z, before - p.hp);
                    note(&mut slot.told, EVENT_YOU_HURT, CAUSE_MONSTER, x, y + MARKER_HEIGHT, z, taken);
                }
            }
        }
    }

    /// Creatures' blows and missiles that reached a player: the same dodge and guard rules as any
    /// other blow. A foe id is a slot index plus one. One on a ghost lands where its owner is
    /// (crate::border hands it over).
    pub fn apply_foe_hits(&mut self, hits: &[FoeHit]) {
        for h in hits {
            let Some(i) = (h.foe as usize).checked_sub(1) else { continue };
            let Some(Some(slot)) = self.slots.get_mut(i) else { continue };
            if !slot.own() {
                continue;
            }
            let p = &mut slot.player;
            let before = p.hp;
            p.take_hit(h.damage, h.nx, h.nz, h.knock);
            if p.hp < before {
                let (x, y, z, taken) = (p.pos.x, p.pos.y, p.pos.z, before - p.hp);
                note(&mut slot.told, EVENT_YOU_HURT, CAUSE_MONSTER, x, y + MARKER_HEIGHT, z, taken);
            }
        }
    }

    /// Everyone still standing, as the creatures see them: foe
    /// ids are slot indexes plus one.
    pub fn foes(&self) -> Vec<Foe> {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.as_ref().map(|s| (i, s)))
            .filter(|(_, s)| s.player.hp > 0.0 && s.player.down_frame < 0)
            .map(|(i, s)| s.player.foe(i as u32 + 1, self.ground_at(s.player.pos.x, s.player.pos.z)))
            .collect()
    }

    /// Where everyone stood as tick `tick` ends, players and creatures (and the ghosts of those
    /// across a border), for swings checked against what their swinger saw. A creature no longer
    /// about is forgotten.
    pub fn record_history(&mut self, tick: u64, actors: &Actors) {
        for (i, slot) in self.slots.iter().enumerate() {
            if let Some(s) = slot {
                let p = &s.player.pos;
                self.tracks[i].push(tick, p.x, p.y, p.z);
            }
        }
        let mut kept = std::mem::take(&mut self.creature_tracks);
        for a in actors.list.iter().chain(&actors.ghosts) {
            let mut t = kept.remove(&a.id).unwrap_or_default();
            t.push(tick, a.x, a.y, a.z);
            self.creature_tracks.insert(a.id, t);
        }
    }

    /// The vehicles of the player in a slot: their island's, or a ghost's as its owner sent them.
    fn vehicles(s: &Slot) -> &[Vehicle] {
        match (&s.away, s.life.as_deref()) {
            (Some(vs), _) => vs,
            (None, Some(l)) => &l.state.vehicles,
            (None, None) => &[],
        }
    }

    /// Open worlds: everyone's vehicles, solid to everyone but their owner, as they stand when the
    /// tick begins (OpenWorld::movers), in the order of the slots: the ghosts' too.
    pub fn gather_movers(&self, world: &mut OpenWorld) {
        let mut movers = std::mem::take(&mut world.movers);
        movers.clear();
        for s in self.slots.iter().flatten() {
            for v in Players::vehicles(s) {
                movers.extend(vehicles::bodies(s.owner, v));
            }
        }
        world.movers = movers;
    }

    /// A vehicle of the character `host`'s as it is now, if they're here (or seen here across a
    /// border) and it's out.
    pub fn vehicle_of(&self, host: i64, vehicle: i64) -> Option<Vehicle> {
        let s = self.slots.iter().flatten().find(|s| s.owner == host)?;
        Players::vehicles(s).iter().find(|v| v.id == vehicle).cloned()
    }

    /// Open worlds: climbs `client_id`'s player into the free seat of the character `host`'s
    /// vehicle nearest them (the driver's is its owner's): beside it, on their feet or swimming, with
    /// their hands free. `host_name` names them in what the player is told when there's no room.
    /// True if they're in.
    pub fn ride_along(&mut self, client_id: EntityId, host: i64, vehicle: i64, host_name: &str) -> bool {
        let Some(v) = self.vehicle_of(host, vehicle) else { return false };
        let def = rideable(&v.def);
        let taken: Vec<usize> = self
            .slots
            .iter()
            .flatten()
            .filter(|s| s.player.mode == Mode::Ride && s.player.host == host && s.player.vehicle == vehicle)
            .map(|s| s.player.seat as usize)
            .collect();
        let Some((p, life)) = self.open_mut(client_id) else { return false };
        let say = |life: Option<&mut Life>, text: String| {
            if let Some(l) = life {
                l.toast(text, "bad");
            }
        };
        if (p.mode != Mode::Normal && p.mode != Mode::Swim) || p.down_frame >= 0 || p.stun > 0 {
            return false;
        }
        if p.pack != 0 {
            say(life, format!("Put your pack down first - there's no room for it in {host_name}'s {}", def.name.to_lowercase()));
            return false;
        }
        if vehicles::distance_to(&v, p.pos.x, p.pos.z) > CLIMB_IN {
            return false;
        }
        let near = |k: &usize| {
            let (x, _, z) = vehicles::anchor_world(&v, &def.seats[*k]);
            js_hypot(x - p.pos.x, z - p.pos.z)
        };
        let Some(seat) = (1..def.seats.len()).filter(|k| !taken.contains(k)).min_by(|a, b| near(a).total_cmp(&near(b))) else {
            say(life, format!("There's no room left in {host_name}'s {}", def.name.to_lowercase()));
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
        vehicles::sit(p, &v, seat);
        true
    }

    /// Open worlds: who `client_id` rides along with, which of their vehicles and which seat, if
    /// they do.
    pub fn passenger(&self, client_id: EntityId) -> Option<(i64, i64, usize)> {
        let (p, _, _) = self.open_view(client_id)?;
        (p.mode == Mode::Ride && p.host != 0).then_some((p.host, p.vehicle, p.seat as usize))
    }

    /// Open worlds: a passenger steps out beside the vehicle they ride in (or, if it has gone,
    /// where they are).
    pub fn drop_off(&mut self, client_id: EntityId, world: &OpenWorld) {
        let Some((host, vehicle, _)) = self.passenger(client_id) else { return };
        let v = self.vehicle_of(host, vehicle);
        let Some(&s) = self.by_client.get(&client_id) else { return };
        let Some(slot) = &mut self.slots[s] else { return };
        vehicles::step_off(&mut Sim { player: &mut slot.player, world, owner: slot.owner }, v.as_ref());
    }

    /// Open worlds: everyone riding along sits where their seat has gone this tick, now their host
    /// has driven; whoever's vehicle (or host) has gone steps off where they are. Each passenger
    /// reads only their host's vehicle, which nobody moves here, so the order they're seated in
    /// makes no difference.
    pub fn seat_passengers(&mut self, world: &OpenWorld) {
        let riders: Vec<(usize, i64, i64, usize)> = self
            .slots
            .iter()
            .enumerate()
            .filter_map(|(i, s)| {
                let s = s.as_ref().filter(|s| s.own())?;
                let p = &s.player;
                (p.mode == Mode::Ride && p.host != 0).then_some((i, p.host, p.vehicle, p.seat as usize))
            })
            .collect();
        for (i, host, vehicle, seat) in riders {
            let v = self.vehicle_of(host, vehicle);
            let Some(slot) = &mut self.slots[i] else { continue };
            match v {
                Some(v) if seat < rideable(&v.def).seats.len() => vehicles::sit(&mut slot.player, &v, seat),
                v => vehicles::step_off(&mut Sim { player: &mut slot.player, world, owner: slot.owner }, v.as_ref()),
            }
        }
    }

    /// The arrows in flight.
    pub fn arrows(&self) -> &[Arrow] {
        &self.arrows
    }

    /// The meteors falling.
    pub fn meteors(&self) -> &[Meteor] {
        &self.meteors
    }

    /// What happened this tick that everyone near it is shown (heals, explosions, arrows landing).
    pub fn shown(&self) -> &[Effect] {
        &self.events
    }

    /// What happened this tick to the player in `slot` or because of them, shown to them alone.
    pub fn told(&self, slot: usize) -> &[Effect] {
        self.slots.get(slot).and_then(Option::as_ref).map_or(&[], |s| s.told.as_slice())
    }
}
