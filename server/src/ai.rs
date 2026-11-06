//! The behaviour interpreter, reading shared/behaviours.json and each creature's own file
//! (crate::creatures) - the same files src/sim/ai/brain.ts reads. A monster is data: an entry in
//! those files and an actor pointed at it. Nothing in here knows what a slime or a goblin is.
//!
//! A brain only ever changes its own actor. Anything that reaches another (calling the pack,
//! pulling them in, a slam landing, a stab, a thrown stone) it asks for in a Request, and
//! crate::actors does it once every brain has had its turn.

use std::sync::OnceLock;

use serde::Deserialize;

use crate::actor::Actor;
use crate::content::{attack_at, attack_index, kind};
use crate::jsmath::JsMath;
use crate::jsmath::len;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Gait {
    pub distance: f64,
    pub height: f64,
    pub air_start: f64,
    pub air_span: f64,
}

/// A guard's condition: one, or a list that must all hold.
#[derive(Deserialize, Clone, Debug)]
#[serde(untagged)]
pub enum Cond {
    One(String),
    All(Vec<String>),
}

/// Go to `to` if `cond` holds; with no condition, always.
#[derive(Deserialize, Clone, Debug)]
pub struct Guard {
    #[serde(rename = "if", default)]
    pub cond: Option<Cond>,
    pub to: String,
}

/// Where a state goes when it runs out: a name, or guards.
#[derive(Deserialize, Clone, Debug)]
#[serde(untagged)]
pub enum Next {
    One(String),
    Many(Vec<Guard>),
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BehaviourState {
    pub name: String,
    pub act: String,
    pub frames: [f64; 2],
    #[serde(default)]
    pub gait: Option<Gait>,
    #[serde(default)]
    pub toward: Option<String>,
    #[serde(default)]
    pub stop: Option<f64>,
    #[serde(default)]
    pub calls: bool,
    /// A walk's pace, metres a second.
    #[serde(default)]
    pub speed: f64,
    /// "foe": keeps facing its foe rather than the way it moves.
    #[serde(default)]
    pub face: Option<String>,
    /// A strike's or throw's attack.
    #[serde(default)]
    pub attack: Option<String>,
    /// While here it holds its pack's attack token.
    #[serde(default)]
    pub token: bool,
    #[serde(default)]
    pub interrupt: Vec<Guard>,
    pub next: Next,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Anger {
    pub frames: i32,
    pub radius: f64,
    pub calm_beyond: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Call {
    pub radius: f64,
    pub need: usize,
    pub struck_within: i32,
    pub give_up: i32,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Gather {
    pub radius: f64,
    pub pull: f64,
    pub break_at: f64,
    pub cooldown: i32,
}

/// The heals it carries (a goblin's stolen potion).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Heal {
    pub amount: f64,
    pub charges: i32,
    pub below: f64,
}

/// How a war-band fights together (crate::pack; PackDef in src/sim/ai/brain.ts).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackDef {
    pub tokens: Vec<i32>,
    pub ring: f64,
    pub spread: f64,
    pub opening_range: f64,
    pub back_arc: f64,
    pub friend_radius: f64,
    pub friend_worth: f64,
    pub foe_worth: f64,
    pub brave_at: f64,
    pub calm_at: f64,
    pub switch_at: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Behaviour {
    pub id: String,
    pub sight: f64,
    pub keep_away: f64,
    pub leash: f64,
    #[serde(default)]
    pub anger: Option<Anger>,
    #[serde(default)]
    pub slam_cooldown: Option<[f64; 2]>,
    #[serde(default)]
    pub call: Option<Call>,
    #[serde(default)]
    pub gather: Option<Gather>,
    #[serde(default)]
    pub regroup_at: Option<i32>,
    #[serde(default)]
    pub flee_within: Option<f64>,
    /// Seeing a foe within sight angers it (and its kin), if the foe is within its leash of home.
    #[serde(default)]
    pub notices: bool,
    /// The attacks its states use, each with its own cooldown, in this order.
    #[serde(default)]
    pub attacks: Vec<String>,
    /// The state a blow at or above its kind's poise knocks it into.
    #[serde(default)]
    pub flinch: Option<String>,
    #[serde(default)]
    pub heal: Option<Heal>,
    #[serde(default)]
    pub pack: Option<PackDef>,
    pub states: Vec<BehaviourState>,
}

#[derive(Deserialize)]
struct File {
    #[serde(default)]
    behaviours: Vec<Behaviour>,
}

static BEHAVIOURS: OnceLock<Vec<Behaviour>> = OnceLock::new();

pub fn behaviours() -> &'static Vec<Behaviour> {
    BEHAVIOURS.get_or_init(|| {
        let raw = include_str!("../../shared/behaviours.json");
        let file: File = serde_json::from_str(raw).expect("shared/behaviours.json is malformed");
        let mut all = file.behaviours;
        for raw in crate::creatures::FILES {
            let c: File = serde_json::from_str(raw).expect("a file in shared/creatures/ is malformed");
            all.extend(c.behaviours);
        }
        all
    })
}

pub fn behaviour(id: &str) -> Option<&'static Behaviour> {
    behaviours().iter().find(|b| b.id == id)
}

/// The behaviour an actor runs, if it has one.
pub fn brain_of(a: &Actor) -> Option<&'static Behaviour> {
    a.brain.as_deref().and_then(behaviour)
}

/// What a foe is doing, as far as a creature can tell (FOE_ACT in src/sim/ai/senses.ts).
pub const ACT_FREE: u8 = 0;
pub const ACT_SWING: u8 = 1;
pub const ACT_RECOVER: u8 = 2;
pub const ACT_CAST: u8 = 3;
pub const ACT_GUARD: u8 = 4;
pub const ACT_DODGE: u8 = 5;
pub const ACT_STUNNED: u8 = 6;

/// A player as a creature sees them (Foe in src/sim/ai/senses.ts).
#[derive(Clone, Copy, Debug, Default)]
pub struct Foe {
    /// 1 and up; a creature's target is a foe id, 0 for none.
    pub id: u32,
    pub x: f64,
    /// Feet height, in world terms.
    pub y: f64,
    pub z: f64,
    pub vx: f64,
    pub vz: f64,
    pub facing: f64,
    /// Health left, 0..1.
    pub hp: f64,
    /// How far its weapon's swings reach; 0 for a bow.
    pub reach: f64,
    pub ranged: bool,
    pub act: u8,
    /// In a dodge's untouchable frames.
    pub invuln: bool,
    /// Feet above the ground under them.
    pub air: f64,
}

impl Foe {
    /// A brain's view of this foe.
    pub fn sighting(&self) -> Sighting {
        Sighting { x: self.x, z: self.z, present: true, id: self.id, facing: self.facing, hp: self.hp, reach: self.reach, ranged: self.ranged, act: self.act }
    }
}

/// What a brain can see of the foe it is after.
#[derive(Clone, Copy, Debug)]
pub struct Sighting {
    pub x: f64,
    pub z: f64,
    pub present: bool,
    pub id: u32,
    pub facing: f64,
    pub hp: f64,
    pub reach: f64,
    pub ranged: bool,
    pub act: u8,
}

impl Sighting {
    /// Someone standing at a point, as far as a brain can tell: empty-handed and doing nothing.
    pub const fn at(x: f64, z: f64, present: bool) -> Self {
        Sighting { x, z, present, id: if present { 1 } else { 0 }, facing: 0.0, hp: 1.0, reach: 0.0, ranged: false, act: 0 }
    }
}

/// Nobody about.
pub const NOBODY: Sighting = Sighting::at(0.0, 0.0, false);

/// Another actor as the brains see it: where everyone standing was when the frame began.
#[derive(Clone, Copy, Debug)]
pub struct Peer {
    pub id: u32,
    pub x: f64,
    pub z: f64,
    pub radius: f64,
    pub ladder: i32,
    pub calling: i32,
    pub rally_to: u32,
    pub group: u32,
    pub band: u32,
}

/// Something a brain asks the world to do (src/sim/ai/brain.ts Request). An attack travels as its
/// index in crate::content::attacks.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Request {
    Call(u32),
    Pull(u32),
    Absorb(u32),
    Slam(u32),
    GatherStart(u32),
    Broke(u32),
    FuseOut(u32),
    Strike(u32, usize),
    Throw(u32, usize),
    Heal(u32),
}

/// The rest of the world, for a brain that has others to think about. An actor on its own gets
/// one with nobody in it, which is what the TypeScript's null means.
pub struct Ctx<'a> {
    pub peers: &'a [Peer],
    pub out: &'a mut Vec<Request>,
}

/// Shortest signed angle from a to b (angleDiff in src/sim/math.ts).
pub fn angle_diff(a: f64, b: f64) -> f64 {
    let tau = std::f64::consts::PI * 2.0;
    let mut d = (b - a) % tau;
    if d > std::f64::consts::PI {
        d -= tau;
    }
    if d < -std::f64::consts::PI {
        d += tau;
    }
    d
}

/// The actor's own random stream. Mirrors draw() in brain.ts exactly, including the wrapping.
pub fn draw(a: &mut Actor) -> f64 {
    crate::rng::mulberry32(&mut a.seed)
}

fn draw_frames(a: &mut Actor, range: Option<[f64; 2]>) -> i32 {
    match range {
        Some([lo, hi]) => {
            let roll = draw(a);
            (lo + roll * (hi - lo).max(0.0)).floor() as i32
        }
        None => 0,
    }
}

fn state_index(b: &Behaviour, name: &str) -> usize {
    b.states.iter().position(|s| s.name == name).unwrap_or(0)
}

fn air_at(g: &Gait, t: f64) -> f64 {
    ((t - g.air_start) / g.air_span).clamp(0.0, 1.0)
}

fn kin(a: &Actor, p: &Peer) -> bool {
    p.id != a.id && a.ladder >= 0 && p.ladder == a.ladder
}

/// Heads at a point, covering at most `most` metres and stopping `stop` short of it.
fn aim(a: &mut Actor, x: f64, z: f64, most: f64, stop: f64) {
    let dx = x - a.x;
    let dz = z - a.z;
    let d = len(dx, dz);
    if d > 1e-6 {
        a.move_x = dx / d;
        a.move_z = dz / d;
    }
    a.stride = most.min((d - stop).max(0.0));
}

fn peer(ctx: &Ctx, id: u32) -> Option<Peer> {
    if id == 0 {
        return None;
    }
    ctx.peers.iter().find(|p| p.id == id).copied()
}

/// Turns to look at its foe.
fn face_foe(a: &mut Actor, seen: Sighting) {
    let (dx, dz) = (seen.x - a.x, seen.z - a.z);
    if len(dx, dz) > 1e-6 {
        a.facing = dx.js_atan2(dz);
    }
}

// The original wander, kept exactly, draw for draw: the conformance tests pin it.
fn wander(a: &mut Actor, b: &Behaviour, seen: Sighting, most: f64) {
    let dx = seen.x - a.x;
    let dz = seen.z - a.z;
    let to_player = len(dx, dz);
    let hx = a.home_x - a.x;
    let hz = a.home_z - a.z;
    let to_home = len(hx, hz);
    if seen.present && to_player < b.sight && to_player > b.keep_away {
        a.move_x = dx / to_player;
        a.move_z = dz / to_player;
    } else if to_home > b.leash {
        a.move_x = hx / to_home;
        a.move_z = hz / to_home;
    } else {
        let angle = draw(a) * std::f64::consts::PI * 2.0;
        a.move_x = angle.sin();
        a.move_z = angle.cos();
    }
    a.stride = most;
}

fn away(a: &mut Actor, seen: Sighting) -> bool {
    let d = len(a.x - seen.x, a.z - seen.z);
    if seen.present && d > 1e-6 {
        a.move_x = (a.x - seen.x) / d;
        a.move_z = (a.z - seen.z) / d;
        return true;
    }
    false
}

fn enter(a: &mut Actor, b: &Behaviour, index: usize, seen: Sighting, ctx: &mut Ctx) {
    a.state = index;
    a.state_frame = 0;
    let s = &b.states[index];
    let (lo, hi) = (s.frames[0], s.frames[1]);
    let roll = draw(a);
    a.wait = (lo + roll * (hi - lo).max(0.0)).floor() as i32;
    if s.calls {
        if a.calling < 0 {
            a.calling = 0;
        }
        ctx.out.push(Request::Call(a.id));
    } else if s.act != "channel" {
        a.calling = -1;
    }

    match s.act.as_str() {
        "windup" => {
            // Picks the spot now, so you can see it coming and step out of it.
            a.target_x = if seen.present { seen.x } else { a.x + a.move_x };
            a.target_z = if seen.present { seen.z } else { a.z + a.move_z };
            let (dx, dz) = (a.target_x - a.x, a.target_z - a.z);
            if len(dx, dz) > 1e-6 {
                a.facing = dx.atan2(dz);
            }
            return;
        }
        "leap" => {
            let (dx, dz) = (a.target_x - a.x, a.target_z - a.z);
            let d = len(dx, dz);
            if d > 1e-6 {
                a.move_x = dx / d;
                a.move_z = dz / d;
                a.facing = a.move_x.atan2(a.move_z);
            }
            let reach = kind(&a.kind).and_then(|k| k.slam.as_ref()).map_or(0.0, |s| s.leap);
            a.stride = d.min(reach);
            return;
        }
        "channel" => {
            a.taken = 0.0;
            ctx.out.push(Request::GatherStart(a.id));
            return;
        }
        "strike" | "throw" => {
            a.struck = false;
            if seen.present {
                face_foe(a, seen);
            }
            return;
        }
        "heal" => {
            a.taken = 0.0;
            return;
        }
        "walk" => {
            if s.toward.as_deref() == Some("wander") {
                // A spot somewhere near home, picked once, so it strolls rather than dithers.
                let angle = draw(a) * std::f64::consts::PI * 2.0;
                let r = draw(a) * b.leash * 0.5;
                a.dest_x = a.home_x + angle.js_sin() * r;
                a.dest_z = a.home_z + angle.js_cos() * r;
            }
            return;
        }
        "advance" => {}
        _ => return,
    }

    // Choose where to go once, on entry, so the actor commits to a direction for the whole move.
    let most = s.gait.as_ref().map_or(0.0, |g| g.distance);
    match s.toward.as_deref().unwrap_or("wander") {
        "keep" => {}
        "player" => {
            if seen.present {
                aim(a, seen.x, seen.z, most, s.stop.unwrap_or(b.keep_away));
            } else {
                a.stride = 0.0;
            }
        }
        "away" => {
            if away(a, seen) {
                a.stride = most;
            } else {
                wander(a, b, seen, most);
            }
        }
        "caller" => match peer(ctx, a.rally_to) {
            Some(c) => aim(a, c.x, c.z, most, a.radius + c.radius + 0.2),
            None => a.stride = 0.0,
        },
        "ally" => {
            // To the nearest of its kin; with none about, away from you.
            let mut best: Option<Peer> = None;
            let mut best_dist = f64::INFINITY;
            for p in ctx.peers.iter() {
                if !kin(a, p) {
                    continue;
                }
                let d = len(p.x - a.x, p.z - a.z);
                if d < best_dist {
                    best = Some(*p);
                    best_dist = d;
                }
            }
            match best {
                Some(p) => aim(a, p.x, p.z, most, a.radius + p.radius + 0.2),
                None => {
                    away(a, seen);
                    a.stride = most;
                }
            }
        }
        "group" => {
            let (mut sx, mut sz, mut n) = (a.x, a.z, 1.0);
            for p in ctx.peers.iter() {
                if p.id == a.id || a.group == 0 || p.group != a.group {
                    continue;
                }
                sx += p.x;
                sz += p.z;
                n += 1.0;
            }
            aim(a, sx / n, sz / n, most, 0.0);
        }
        _ => wander(a, b, seen, most),
    }
    a.facing = a.move_x.atan2(a.move_z);
}

// A frame of walking: work out where it is going now, step toward it at the state's pace, keep
// off the rest of its band, and look where it should (walk() in brain.ts).
fn walk(a: &mut Actor, s: &BehaviourState, seen: Sighting, ctx: &Ctx) {
    let step = s.speed / 60.0;
    let (mut mx, mut mz) = (0.0, 0.0);
    if s.toward.as_deref() == Some("away") {
        let (dx, dz) = (a.x - seen.x, a.z - seen.z);
        let d = len(dx, dz);
        if seen.present && d > 1e-6 {
            mx = (dx / d) * step;
            mz = (dz / d) * step;
        }
    } else {
        let (mut tx, mut tz, mut stop) = (a.x, a.z, 0.0);
        match s.toward.as_deref() {
            Some("foe") => {
                if seen.present {
                    tx = seen.x;
                    tz = seen.z;
                    stop = s.stop.unwrap_or(0.0);
                }
            }
            Some("slot") => {
                tx = a.slot_x;
                tz = a.slot_z;
                stop = 0.1;
            }
            Some("rally") => {
                tx = a.rally_x;
                tz = a.rally_z;
                stop = s.stop.unwrap_or(0.0);
            }
            Some("home") => {
                tx = a.home_x;
                tz = a.home_z;
                stop = s.stop.unwrap_or(0.0);
            }
            Some("wander") => {
                tx = a.dest_x;
                tz = a.dest_z;
                stop = 0.2;
            }
            _ => {}
        }
        let (dx, dz) = (tx - a.x, tz - a.z);
        let d = len(dx, dz);
        if d > stop + 1e-6 {
            let m = step.min(d - stop);
            mx = (dx / d) * m;
            mz = (dz / d) * m;
        }
    }
    a.x += mx;
    a.z += mz;

    // Keep a body's width apart from the rest of the band, so a ring of them doesn't stack up.
    if a.band != 0 {
        for p in ctx.peers.iter() {
            if p.id == a.id || p.band != a.band {
                continue;
            }
            let (dx, dz) = (a.x - p.x, a.z - p.z);
            let d = len(dx, dz);
            let apart = a.radius + p.radius + 0.2;
            if d >= apart || d < 1e-6 {
                continue;
            }
            let push = (apart - d) * 0.5;
            a.x += (dx / d) * push;
            a.z += (dz / d) * push;
        }
    }

    if s.face.as_deref() == Some("foe") && seen.present {
        face_foe(a, seen);
    } else if len(mx, mz) > 1e-6 {
        a.facing = mx.js_atan2(mz);
    }
}

/// Puts an attack's cooldown on, drawn from its range.
fn cool_down(a: &mut Actor, b: &Behaviour, attack: &str, range: [f64; 2]) {
    if let Some(i) = b.attacks.iter().position(|x| x == attack)
        && i < a.cds.len()
    {
        a.cds[i] = draw_frames(a, Some(range));
    }
}

// A frame of a strike: it tracks you early in the wind-up, then commits; the blow goes on the
// frame the wind-up ends, and it lunges after it.
fn strike(a: &mut Actor, b: &Behaviour, s: &BehaviourState, seen: Sighting, ctx: &mut Ctx) {
    let Some(id) = s.attack.as_deref() else { return };
    let (Some(index), Some(atk)) = (attack_index(id), attack_index(id).and_then(attack_at)) else { return };
    if seen.present && a.state_frame < atk.track {
        face_foe(a, seen);
    }
    if a.state_frame == atk.windup && !a.struck {
        a.struck = true;
        ctx.out.push(Request::Strike(a.id, index));
        cool_down(a, b, id, atk.cooldown);
    }
    if atk.active > 0 && a.state_frame >= atk.windup && a.state_frame < atk.windup + atk.active {
        // Not into the foe, though: it stops at arm's length.
        let close = seen.present && len(seen.x - a.x, seen.z - a.z) <= a.radius + 0.45;
        if !close {
            let m = atk.lunge / atk.active as f64;
            a.x += a.facing.js_sin() * m;
            a.z += a.facing.js_cos() * m;
        }
    }
}

// A frame of a throw: it aims at you through most of the wind-up and lets go as it ends.
fn throwing(a: &mut Actor, b: &Behaviour, s: &BehaviourState, seen: Sighting, ctx: &mut Ctx) {
    let Some(id) = s.attack.as_deref() else { return };
    let (Some(index), Some(atk)) = (attack_index(id), attack_index(id).and_then(attack_at)) else { return };
    if seen.present && a.state_frame < atk.track {
        face_foe(a, seen);
    }
    if a.state_frame == atk.windup && !a.struck {
        a.struck = true;
        ctx.out.push(Request::Throw(a.id, index));
        cool_down(a, b, id, atk.cooldown);
    }
}

fn can_call(a: &Actor, b: &Behaviour, seen: Sighting, ctx: &Ctx) -> bool {
    let (Some(c), Some(_)) = (&b.call, &b.gather) else { return false };
    if !kind(&a.kind).is_some_and(|k| k.gathers) {
        return false;
    }
    if a.angry <= 0 || !seen.present || a.flash_frame >= c.struck_within {
        return false;
    }
    if a.gather_cd > 0 || a.calling >= 0 || a.rally_to != 0 {
        return false;
    }
    let mut answer = 0;
    for p in ctx.peers.iter() {
        if !kin(a, p) || len(p.x - a.x, p.z - a.z) > c.radius {
            continue;
        }
        if p.calling >= 0 {
            return false; // one call per pack
        }
        if p.rally_to == 0 && p.group == 0 {
            answer += 1;
        }
    }
    answer >= c.need
}

fn holds_one(cond: &str, a: &Actor, b: &Behaviour, seen: Sighting, ctx: &Ctx) -> bool {
    if let Some(rest) = cond.strip_prefix('!') {
        return !holds_one(rest, a, b, seen, ctx);
    }
    let (name, arg) = match cond.find(':') {
        Some(i) => (&cond[..i], &cond[i + 1..]),
        None => (cond, ""),
    };
    let num = || arg.parse::<f64>().unwrap_or(0.0);
    match name {
        "called" => a.rally_to != 0,
        "angry" => a.angry > 0 && seen.present,
        "threatened" => a.angry > 0 && seen.present && len(seen.x - a.x, seen.z - a.z) <= b.flee_within.unwrap_or(0.0),
        "canCall" => can_call(a, b, seen, ctx),
        "slam" => {
            let Some(s) = kind(&a.kind).and_then(|k| k.slam.as_ref()) else { return false };
            if a.angry <= 0 || !seen.present || a.slam_cd > 0 {
                return false;
            }
            len(seen.x - a.x, seen.z - a.z) <= s.range
        }
        "allies" => {
            let (Some(c), Some(g)) = (&b.call, &b.gather) else { return false };
            let n = ctx.peers.iter().filter(|p| kin(a, p) && len(p.x - a.x, p.z - a.z) <= g.radius).count();
            n >= c.need
        }
        "callOver" => b.call.as_ref().is_some_and(|c| a.calling >= c.give_up),
        "broken" => b.gather.as_ref().is_some_and(|g| a.taken >= g.break_at * a.max_hp),
        "fuseLow" => a.group != 0 && a.fuse >= 0 && a.fuse <= b.regroup_at.unwrap_or(0),
        "token" => a.token,
        "opening" => a.opening,
        "afraid" => a.afraid,
        "near" => seen.present && len(seen.x - a.x, seen.z - a.z) <= num(),
        "far" => seen.present && len(seen.x - a.x, seen.z - a.z) > num(),
        "hurt" => a.hp <= num() * a.max_hp,
        "foeMelee" => seen.present && !seen.ranged && seen.reach > 0.0,
        "foeRanged" => seen.present && seen.ranged,
        "foeSwinging" => seen.present && seen.act == ACT_SWING,
        "ready" => b.attacks.iter().position(|x| x == arg).is_some_and(|i| i < a.cds.len() && a.cds[i] <= 0),
        "canHeal" => b.heal.as_ref().is_some_and(|h| a.charges > 0 && a.hp <= h.below * a.max_hp),
        _ => false,
    }
}

fn holds(cond: Option<&Cond>, a: &Actor, b: &Behaviour, seen: Sighting, ctx: &Ctx) -> bool {
    match cond {
        None => true,
        Some(Cond::One(c)) => holds_one(c, a, b, seen, ctx),
        Some(Cond::All(list)) => list.iter().all(|c| holds_one(c, a, b, seen, ctx)),
    }
}

/// The first guard that holds, as a state index. `with_default` lets a guard with no condition
/// count; an interrupt never falls back to one.
fn pick(guards: &[Guard], with_default: bool, a: &Actor, b: &Behaviour, seen: Sighting, ctx: &Ctx) -> Option<usize> {
    for g in guards {
        if g.cond.is_none() && !with_default {
            continue;
        }
        if holds(g.cond.as_ref(), a, b, seen, ctx) {
            return Some(state_index(b, &g.to));
        }
    }
    None
}

/// Runs one frame of an actor's behaviour on its own, with nobody else about.
pub fn step_brain(a: &mut Actor, seen: Sighting) {
    let mut out = Vec::new();
    let mut ctx = Ctx { peers: &[], out: &mut out };
    step_brain_in(a, seen, &mut ctx);
}

/// Runs one frame of an actor's behaviour among others.
pub fn step_brain_in(a: &mut Actor, seen: Sighting, ctx: &mut Ctx) {
    let Some(b) = brain_of(a) else { return };
    if !a.is_alive() {
        return;
    }
    if a.state >= b.states.len() {
        a.state = 0;
    }
    let s = &b.states[a.state];

    if let Some(to) = pick(&s.interrupt, false, a, b, seen, ctx) {
        if s.act == "channel" {
            // Cut short: the cast is broken, and it has to wait before trying again.
            a.gather_cd = b.gather.as_ref().map_or(0, |g| g.cooldown);
            ctx.out.push(Request::Broke(a.id));
        }
        if s.gait.is_some() {
            a.y = 0.0;
        }
        enter(a, b, to, seen, ctx);
        return;
    }

    if s.act == "advance" || s.act == "leap" {
        if let Some(g) = &s.gait {
            let wait = a.wait.max(1) as f64;
            let now = air_at(g, (a.state_frame as f64 / wait).min(1.0));
            let before = air_at(g, ((a.state_frame - 1).max(0) as f64 / wait).min(1.0));
            let moved = (now - before) * a.stride;
            a.x += a.move_x * moved;
            a.z += a.move_z * moved;
            a.y = (now * std::f64::consts::PI).sin() * g.height;
        }
    } else if s.act == "channel" {
        ctx.out.push(Request::Pull(a.id));
    } else if s.act == "walk" {
        walk(a, s, seen, ctx);
    } else if s.act == "strike" {
        strike(a, b, s, seen, ctx);
    } else if s.act == "throw" {
        throwing(a, b, s, seen, ctx);
    } else if s.face.as_deref() == Some("foe") && seen.present {
        face_foe(a, seen);
    }

    a.state_frame += 1;
    if a.state_frame >= a.wait {
        if s.gait.is_some() {
            a.y = 0.0;
        }
        if s.act == "leap" {
            ctx.out.push(Request::Slam(a.id));
            a.slam_cd = draw_frames(a, b.slam_cooldown);
        } else if s.act == "channel" {
            ctx.out.push(Request::Absorb(a.id));
            a.gather_cd = b.gather.as_ref().map_or(0, |g| g.cooldown);
        } else if s.act == "heal" {
            ctx.out.push(Request::Heal(a.id));
            a.charges = (a.charges - 1).max(0);
        }
        let next = match &s.next {
            Next::One(name) => Some(state_index(b, name)),
            Next::Many(guards) => pick(guards, true, a, b, seen, ctx),
        };
        enter(a, b, next.unwrap_or(0), seen, ctx);
    }
}

/// Puts a freshly spawned or revived actor into the first state of its brain, with what it carries.
pub fn start_brain(a: &mut Actor, seen: Sighting) {
    let Some(b) = brain_of(a) else { return };
    a.charges = b.heal.as_ref().map_or(0, |h| h.charges);
    let mut out = Vec::new();
    let mut ctx = Ctx { peers: &[], out: &mut out };
    enter(a, b, 0, seen, &mut ctx);
}

/// Puts an actor straight into a named state, for the world's own decisions (taking over a call).
pub fn force_state(a: &mut Actor, name: &str, seen: Sighting) {
    let Some(b) = brain_of(a) else { return };
    a.y = 0.0;
    let mut out = Vec::new();
    let mut ctx = Ctx { peers: &[], out: &mut out };
    enter(a, b, state_index(b, name), seen, &mut ctx);
}

/// The state an actor drops back to when something outside its brain interrupts it.
pub fn rest_state(a: &mut Actor) {
    a.state = brain_of(a).map_or(0, |b| state_index(b, "idle"));
    a.state_frame = 0;
    a.wait = 1;
    a.y = 0.0;
}

/// A blow landed on it: one at or above its kind's poise knocks it into its brain's flinch,
/// spilling a drink it had at its lips (flinch() in src/sim/ai/brain.ts).
pub fn flinch(a: &mut Actor, amount: f64) {
    let Some(k) = kind(&a.kind) else { return };
    let Some(b) = brain_of(a) else { return };
    let Some(to) = b.flinch.as_deref() else { return };
    if !a.is_alive() || k.poise <= 0.0 || amount < k.poise {
        return;
    }
    if b.states.get(a.state).is_some_and(|s| s.act == "heal") {
        a.charges = (a.charges - 1).max(0);
    }
    force_state(a, to, NOBODY);
}

/// Whether the actor's current state holds its pack's attack token.
pub fn holds_token(a: &Actor) -> bool {
    brain_of(a).and_then(|b| b.states.get(a.state)).is_some_and(|s| s.token)
}

/// How far round from `facing` a point is, for the pack's sense of in front and behind.
pub fn off_facing(facing: f64, from_x: f64, from_z: f64, to_x: f64, to_z: f64) -> f64 {
    angle_diff(facing, (to_x - from_x).js_atan2(to_z - from_z)).abs()
}
