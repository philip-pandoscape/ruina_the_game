//! What the browser plays offline that the server decides online (Phase 8): a swing's blow landing
//! on whatever stands in front of you (with its hit pause), damage dealt to creatures and what it
//! shows, and the training range: arrows flying, meteors falling and heals going off against
//! whatever stands about. The numbers are the server's (crate::combat); the session
//! (crate::session) runs these in its offline steps.

use serde::Serialize;

use crate::actors::Actors;
use crate::event::Event;
use crate::jsmath::{JsMath, js_hypot, len};
use crate::open::map::WorldMap;
use crate::player::{DEG, Player, angle_diff};
use crate::tuning::{AttackStep, ability, effect_damage, effect_radius, melee_targets, tuning};

/// Townsfolk: never anyone's target (FACTION.neutral in src/engine/actors/actor.ts).
const NEUTRAL: u8 = 2;
/// How close an arrow has to pass to count, and how hard it rocks what it hits.
const ARROW_PAD: f64 = 0.25;
const ARROW_KNOCK: f64 = 3.0;
const METEOR_KNOCK: f64 = 9.0;
/// A delayed area with no delay of its own falls after this many frames.
const METEOR_FALL: i32 = 30;

/// Something an attack could land on right now, with its heights in world terms (src/engine/actors/hits.ts Target).
#[derive(Clone, Copy, Debug)]
pub struct Target {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub radius: f64,
    pub hit_height: f64,
    pub hit_ceiling: f64,
}

/// Everything standing that an attack could land on: on an island
/// their heights are raised onto the ground under them.
pub fn targets(actors: &Actors, terrain: Option<&WorldMap>) -> Vec<Target> {
    let mut out = Vec::new();
    for a in &actors.list {
        if !a.is_alive() || a.faction == NEUTRAL {
            continue;
        }
        let g = terrain.map_or(0.0, |hf| hf.height(a.x, a.z));
        let raise = |v: f64| if terrain.is_some() { v + g } else { v };
        out.push(Target { id: a.id, x: a.x, y: raise(a.y), z: a.z, radius: a.radius, hit_height: raise(a.hit_height), hit_ceiling: raise(a.hit_ceiling) });
    }
    out
}

/// Nearest first, and of two as near, the one with the lower id: never the order they're kept in.
fn by_distance(list: &mut [Target], x: f64, z: f64) {
    list.sort_by(|a, b| (js_hypot(a.x - x, a.z - z) - js_hypot(b.x - x, b.z - z)).total_cmp(&0.0).then(a.id.cmp(&b.id)));
}

/// A melee swing: everything inside the arc and within reach, nearest first, capped at `max`
/// (something right on top of you counts even behind the arc).
pub fn cone_hits(targets: &[Target], x: f64, z: f64, facing: f64, reach: f64, arc_deg: f64, max: usize) -> Vec<Target> {
    let mut hits: Vec<Target> = targets
        .iter()
        .filter(|t| {
            let (dx, dz) = (t.x - x, t.z - z);
            let dist = js_hypot(dx, dz);
            if dist > reach + t.radius {
                return false;
            }
            let in_cone = angle_diff(facing, dx.js_atan2(dz)).abs() <= (arc_deg / 2.0) * DEG;
            in_cone || dist <= t.radius + 0.3
        })
        .copied()
        .collect();
    by_distance(&mut hits, x, z);
    hits.truncate(max.max(1));
    hits
}

/// A blast: everything whose body overlaps the circle, nearest first.
pub fn circle_hits(targets: &[Target], x: f64, z: f64, radius: f64) -> Vec<Target> {
    let mut hits: Vec<Target> = targets.iter().filter(|t| js_hypot(t.x - x, t.z - z) <= radius + t.radius).copied().collect();
    by_distance(&mut hits, x, z);
    hits
}

/// A projectile at a point in flight: the first thing it touches (the nearest, and of two as near,
/// the one with the lower id).
pub fn point_hit(targets: &[Target], x: f64, y: f64, z: f64, pad: f64) -> Option<Target> {
    let mut best: Option<Target> = None;
    let mut best_dist = f64::INFINITY;
    for t in targets {
        if y > t.hit_ceiling {
            continue;
        }
        let dist = js_hypot(t.x - x, t.z - z);
        if dist > t.radius + pad || dist > best_dist || (dist == best_dist && best.is_some_and(|b| b.id < t.id)) {
            continue;
        }
        best = Some(*t);
        best_dist = dist;
    }
    best
}

/// Where a blow lands, and the creatures it lands on: the player who dealt
/// it, the ground for its heights, and the step's events.
pub struct Blows<'a> {
    pub actors: &'a mut Actors,
    pub player: &'a Player,
    pub terrain: Option<&'a WorldMap>,
    pub events: &'a mut Vec<Event>,
}

impl Blows<'_> {
    /// A blow from you, travelling from you to it.
    pub fn damage(&mut self, id: u32, amount: f64, knock: f64, index: usize, weapon: Option<u8>) {
        let Some(a) = self.actors.list.iter().find(|a| a.id == id) else { return };
        if !a.is_alive() {
            return;
        }
        let p = self.player;
        let (dx, dz) = (a.x - p.pos.x, a.z - p.pos.z);
        let dist = len(dx, dz);
        let nx = if dist > 0.01 { dx / dist } else { p.facing.js_sin() };
        let nz = if dist > 0.01 { dz / dist } else { p.facing.js_cos() };
        self.damage_from(id, amount, nx, nz, knock, index, weapon);
    }

    /// A blow travelling along (nx, nz): it loses health, flashes, angers its pack, flinches and
    /// rocks (Actors::damage), and the hit (and a death) is shown. `weapon`: what dealt it, if a
    /// weapon did, which the hit trains.
    #[allow(clippy::too_many_arguments)]
    pub fn damage_from(&mut self, id: u32, amount: f64, nx: f64, nz: f64, knock: f64, index: usize, weapon: Option<u8>) {
        if !self.actors.list.iter().any(|a| a.id == id && a.is_alive()) {
            return;
        }
        let died = self.actors.damage(id, amount, nx, nz, knock).is_some();
        let Some(a) = self.actors.list.iter().find(|a| a.id == id) else { return };
        let ground = self.terrain.map_or(0.0, |hf| hf.height(a.x, a.z));
        self.events.push(Event::Hit {
            index,
            damage: amount,
            x: a.x - nx * a.radius,
            y: a.y + a.hit_height + ground,
            z: a.z - nz * a.radius,
            dir_x: nx,
            dir_z: nz,
            weapon,
        });
        if died {
            self.events.push(Event::ActorDie { id: a.id, kind: a.kind.clone(), x: a.x, y: a.hit_height + ground, z: a.z, killed: true });
        }
    }

    /// A blast: everything standing inside the circle takes it, pushed out from its middle.
    pub fn damage_circle(&mut self, x: f64, z: f64, radius: f64, amount: f64, knock: f64, index: usize) {
        for t in circle_hits(&targets(self.actors, self.terrain), x, z, radius) {
            let (dx, dz) = (t.x - x, t.z - z);
            let dist = len(dx, dz);
            let (nx, nz) = if dist > 0.01 { (dx / dist, dz / dist) } else { (1.0, 0.0) };
            self.damage_from(t.id, amount, nx, nz, knock, index, None);
        }
    }
}

/// A swing's blow, on a frame it could land: whatever is in
/// its arc and reach takes it, and everything pauses a moment. `above` is how high you are over
/// the ground; returns the frames of hit pause, if it landed.
pub fn check_hit(actors: &mut Actors, terrain: Option<&WorldMap>, events: &mut Vec<Event>, player: &mut Player, step: &AttackStep, above: f64) -> Option<i32> {
    // Too far up in the air to reach anything.
    if above > 2.0 {
        return None;
    }
    let mut list = targets(actors, terrain);
    // On hills a swing only reaches feet within 2 m of your own.
    if terrain.is_some() {
        list.retain(|t| (t.y - player.pos.y).abs() <= 2.0);
    }
    let hits = cone_hits(&list, player.pos.x, player.pos.z, player.facing, step.reach, step.arc_deg, melee_targets(player.weapon, &player.resolved));
    if hits.is_empty() {
        return None;
    }
    player.attack_hit = true;
    let (index, weapon) = (player.attack_index, player.weapon);
    let mut blows = Blows { actors, player: &*player, terrain, events };
    for t in hits {
        blows.damage(t.id, step.damage, step.knock, index, Some(weapon));
    }
    Some(step.hitstop)
}

/// An arrow in flight on the training range (src/engine/training.ts ArrowFlight).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Arrow {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub dir_x: f64,
    pub dir_z: f64,
    pub speed: f64,
    /// Metres of range left.
    pub left: f64,
    pub damage: f64,
    /// Which weapon loosed it: what it hits trains that one.
    pub weapon: u8,
    pub spent: bool,
}

/// A meteor on its way down (src/engine/training.ts MeteorFall).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meteor {
    pub x: f64,
    pub z: f64,
    /// Frames since the cast finished.
    pub frame: i32,
    pub fall_frames: i32,
    pub radius: f64,
    pub damage: f64,
}

/// The training range (src/engine/training.ts TrainingRange): the server's arrows, meteors and heals,
/// played in the browser against whatever stands about.
#[derive(Default)]
pub struct Range {
    pub arrows: Vec<Arrow>,
    pub meteors: Vec<Meteor>,
}

impl Range {
    pub fn reset(&mut self) {
        self.arrows.clear();
        self.meteors.clear();
    }

    /// Picks up the step's shots and finished casts (`seen`, the step's events so far), then moves
    /// everything one step; what that does goes into `b.events` after them.
    pub fn step(&mut self, b: &mut Blows, seen: usize) {
        let r = &b.player.resolved;
        for i in 0..seen {
            match b.events[i].clone() {
                Event::Shoot { x, y, z, dir_x, dir_z, speed, range, damage, weapon, .. } => {
                    self.arrows.push(Arrow { x, y, z, dir_x, dir_z, speed, left: range, damage, weapon, spent: false });
                }
                Event::Cast { ability: id, x, z, caster_x, caster_z } => {
                    for fx in &ability(id).effects {
                        if fx.kind == "healArea" {
                            b.events.push(Event::Heal { x: caster_x, y: 0.0, z: caster_z, radius: effect_radius(id, fx, r) });
                        } else if fx.kind == "delayedArea" {
                            let fall_frames = if fx.delay_frames == 0 { METEOR_FALL } else { fx.delay_frames };
                            self.meteors.push(Meteor { x, z, frame: 0, fall_frames, radius: effect_radius(id, fx, r), damage: effect_damage(id, fx, r) });
                        }
                    }
                }
                _ => {}
            }
        }

        let dt = 1.0 / tuning().sim_hz;
        for a in self.arrows.iter_mut() {
            // Short hops, like the server, so fast arrows can't skip past something thin.
            let travel = (a.speed * dt).min(a.left);
            let hops = (travel / 0.5).ceil().max(1.0) as usize;
            for _ in 0..hops {
                if a.spent {
                    break;
                }
                a.x += (a.dir_x * travel) / hops as f64;
                a.z += (a.dir_z * travel) / hops as f64;
                if let Some(hit) = point_hit(&targets(b.actors, b.terrain), a.x, a.y, a.z, ARROW_PAD) {
                    a.spent = true;
                    b.damage_from(hit.id, a.damage, a.dir_x, a.dir_z, ARROW_KNOCK, 0, Some(a.weapon));
                }
            }
            a.left -= travel;
        }
        self.arrows.retain(|a| a.left > 0.0 && !a.spent);

        for m in self.meteors.iter_mut() {
            m.frame += 1;
            if m.frame < m.fall_frames {
                continue;
            }
            b.damage_circle(m.x, m.z, m.radius, m.damage, METEOR_KNOCK, 2);
            b.events.push(Event::Explosion { x: m.x, y: 0.0, z: m.z, radius: m.radius });
        }
        self.meteors.retain(|m| m.frame < m.fall_frames);
    }
}
