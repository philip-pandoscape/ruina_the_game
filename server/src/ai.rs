//! The behaviour interpreter, reading shared/behaviours.json - the same file src/sim/ai/brain.ts
//! reads. A monster is data: an entry in that file and an actor pointed at it. Nothing in here
//! knows what a slime is.
//!
//! A brain only ever changes its own actor. Anything that reaches another (calling the pack,
//! pulling them in, a slam landing) it asks for in a Request, and crate::actors does it once every
//! brain has had its turn.

use std::sync::OnceLock;

use serde::Deserialize;

use crate::actor::Actor;
use crate::content::kind;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Gait {
    pub distance: f64,
    pub height: f64,
    pub air_start: f64,
    pub air_span: f64,
}

/// Go to `to` if `cond` holds; with no condition, always.
#[derive(Deserialize, Clone, Debug)]
pub struct Guard {
    #[serde(rename = "if", default)]
    pub cond: Option<String>,
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
    pub states: Vec<BehaviourState>,
}

#[derive(Deserialize)]
struct File {
    behaviours: Vec<Behaviour>,
}

static BEHAVIOURS: OnceLock<Vec<Behaviour>> = OnceLock::new();

pub fn behaviours() -> &'static Vec<Behaviour> {
    BEHAVIOURS.get_or_init(|| {
        let raw = include_str!("../../shared/behaviours.json");
        let file: File = serde_json::from_str(raw).expect("shared/behaviours.json is malformed");
        file.behaviours
    })
}

pub fn behaviour(id: &str) -> Option<&'static Behaviour> {
    behaviours().iter().find(|b| b.id == id)
}

/// The behaviour an actor runs, if it has one.
pub fn brain_of(a: &Actor) -> Option<&'static Behaviour> {
    a.brain.as_deref().and_then(behaviour)
}

/// What a brain can see of the player this frame.
#[derive(Clone, Copy)]
pub struct Sighting {
    pub x: f64,
    pub z: f64,
    pub present: bool,
}

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
}

/// Something a brain asks the world to do (src/sim/ai/brain.ts Request).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Request {
    Call(u32),
    Pull(u32),
    Absorb(u32),
    Slam(u32),
    GatherStart(u32),
    Broke(u32),
    FuseOut(u32),
}

/// The rest of the world, for a brain that has others to think about. An actor on its own gets
/// one with nobody in it, which is what the TypeScript's null means.
pub struct Ctx<'a> {
    pub peers: &'a [Peer],
    pub out: &'a mut Vec<Request>,
}

fn len(x: f64, z: f64) -> f64 {
    (x * x + z * z).sqrt()
}

/// The actor's own random stream. Mirrors draw() in brain.ts exactly, including the wrapping.
pub fn draw(a: &mut Actor) -> f64 {
    a.seed = a.seed.wrapping_add(0x6d2b_79f5);
    let mut t = a.seed;
    t = (t ^ (t >> 15)).wrapping_mul(t | 1);
    t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
    ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
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

fn holds(cond: Option<&str>, a: &Actor, b: &Behaviour, seen: Sighting, ctx: &Ctx) -> bool {
    let Some(cond) = cond else { return true };
    match cond {
        "called" => a.rally_to != 0,
        "angry" => a.angry > 0 && seen.present,
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
        _ => false,
    }
}

/// The first guard that holds, as a state index. `with_default` lets a guard with no condition
/// count; an interrupt never falls back to one.
fn pick(guards: &[Guard], with_default: bool, a: &Actor, b: &Behaviour, seen: Sighting, ctx: &Ctx) -> Option<usize> {
    for g in guards {
        if g.cond.is_none() && !with_default {
            continue;
        }
        if holds(g.cond.as_deref(), a, b, seen, ctx) {
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
        }
        let next = match &s.next {
            Next::One(name) => Some(state_index(b, name)),
            Next::Many(guards) => pick(guards, true, a, b, seen, ctx),
        };
        enter(a, b, next.unwrap_or(0), seen, ctx);
    }
}

/// Puts a freshly spawned or revived actor into the first state of its brain.
pub fn start_brain(a: &mut Actor, seen: Sighting) {
    let Some(b) = brain_of(a) else { return };
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
