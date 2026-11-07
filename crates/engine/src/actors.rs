//! The world's actors: monsters, NPCs and props, as the server runs them and the browser's session
//! does offline, so the training yard offline and a live server agree about where a slime is, what
//! a swing reaches, and what a pack does together:
//! bursting into pieces, a caller gathering the others in, a burst group reforming one size up, a
//! war-band sharing out who strikes and where the rest wait (crate::pack), and the blows, throws
//! and heals they ask for.

use crate::actor::Actor;
use crate::ai::{Ctx, Foe, Peer, Request, Sighting, angle_diff, brain_of, draw, flinch, force_state, rest_state, start_brain, step_brain_in};
use crate::content::{attack_at, kind, kind_index, kind_mass, ladder_at, ladders, size_for, size_up};
use crate::event::Event;
use crate::ids::EntityId;
use crate::jsmath::JsMath;
use crate::jsmath::len;
use crate::missiles::{Flight, Missile, launch, step_missiles};
use crate::pack::step_packs;
use crate::tuning::tuning;
use crate::yard::SpawnPoint;

const DEG: f64 = std::f64::consts::PI / 180.0;
/// A creature's number (its [`EntityId`](crate::ids::EntityId)): its spawn in the low 16 bits, the
/// n-th the space brought to life (its spawn list first, in order), and above them its generation,
/// how many times those 65,535 spawns have come round, so a number isn't soon used again. Kept
/// under 1 << 30 (an arrow's list of whom it hit marks creatures with that bit).
const SPAWNS: u32 = 0xffff;
const GENERATIONS: u32 = 0x3fff;
/// Frames a dead piece of a burst lies there before it is cleared away.
const CLEAR_AFTER: i32 = 60;
/// How close to a gatherer something has to be pulled before it is taken in.
const TOUCH: f64 = 0.35;
/// The rules' fixed step: brains count in 60ths of a second, whatever the server's tick.
const STEP: f64 = 1.0 / 60.0;

/// What a brain at a point sees: the nearest foe.
fn nearest_at(foes: &[Foe], x: f64, z: f64) -> Sighting {
    let mut seen = Sighting::at(x, z, false);
    let mut best = f64::INFINITY;
    for f in foes {
        let d = len(f.x - x, f.z - z);
        if d < best {
            best = d;
            seen = f.sighting();
        }
    }
    seen
}

/// What an actor's brain sees: a pack creature its chosen foe, anything else the nearest.
fn see_for(foes: &[Foe], a: &Actor) -> Sighting {
    if brain_of(a).and_then(|b| b.pack.as_ref()).is_none() {
        return nearest_at(foes, a.x, a.z);
    }
    match foes.iter().find(|f| f.id == a.target) {
        Some(f) => f.sighting(),
        None => Sighting::at(a.x, a.z, false),
    }
}

/// Which foe a creature pays attention to.
fn pick_foe<'a>(a: &Actor, foes: &'a [Foe], sticky: f64) -> Option<&'a Foe> {
    let mut best: Option<&Foe> = None;
    let mut best_dist = f64::INFINITY;
    let mut kept: Option<&Foe> = None;
    let mut kept_dist = f64::INFINITY;
    for f in foes {
        let d = len(f.x - a.x, f.z - a.z);
        if d < best_dist {
            best = Some(f);
            best_dist = d;
        }
        if f.id == a.target {
            kept = Some(f);
            kept_dist = d;
        }
    }
    if sticky > 0.0 && kept.is_some() && kept_dist <= best_dist + sticky {
        return kept;
    }
    best
}

fn anger_of(a: &Actor) -> i32 {
    brain_of(a).and_then(|b| b.anger.as_ref()).map_or(0, |g| g.frames)
}

/// Kin: the same creature in another size, or the same war-band.
fn kin(a: &Actor, o: &Actor) -> bool {
    a.id != o.id && ((a.ladder >= 0 && o.ladder == a.ladder) || (a.band != 0 && o.band == a.band)) && o.is_alive() && !o.gone
}

/// Out of the world without dying: no death, no burst, and a home actor waits to respawn.
fn take_out(o: &mut Actor) {
    o.gone = true;
    o.hp = 0.0;
    o.dead_frame = 0;
    o.rally_to = 0;
    o.calling = -1;
    o.pulled = 0;
    o.group = 0;
    o.fuse = -1;
}

/// How anything that rocks when hit settles back upright; matches LEAN in src/content/tuning.ts.
pub const LEAN_SPRING: f64 = 140.0;
pub const LEAN_DAMPING: f64 = 7.0;

pub struct Actors {
    pub list: Vec<Actor>,
    /// What creatures have thrown, still in the air.
    pub missiles: Vec<Missile>,
    next_id: u32,
    next_group: u32,
    next_band: u32,
    next_missile: u32,
    /// Testing: nothing gets angry.
    pub calm: bool,
}

impl Default for Actors {
    fn default() -> Self {
        Self::new()
    }
}

/// What died this tick, for the effects the clients are told about.
pub struct Death {
    pub id: u32,
    pub kind_index: u8,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// A slam landed: whoever stands in it is the caller's business.
#[derive(Clone, Copy, Debug)]
pub struct Slam {
    pub x: f64,
    pub z: f64,
    pub radius: f64,
    pub damage: f64,
    pub knock: f64,
}

/// A creature's blow or missile reached a foe (not in a dodge's untouchable frames), travelling
/// along (nx, nz): what it does to them is the caller's business.
#[derive(Clone, Copy, Debug)]
pub struct FoeHit {
    pub foe: u32,
    pub damage: f64,
    pub nx: f64,
    pub nz: f64,
    pub knock: f64,
}

/// What a frame of actors did to the world beyond them.
#[derive(Default)]
pub struct StepOut {
    pub slams: Vec<Slam>,
    pub hits: Vec<FoeHit>,
    /// Missiles that came down on the ground: (x, y, z).
    pub landed: Vec<(f64, f64, f64)>,
}

/// A slam or a blow from a frame of actors, in the order they happened, for whoever stands in the
/// way (`Actors::step_with`).
#[derive(Clone, Copy, Debug)]
pub enum Blow {
    Slam(Slam),
    Hit(FoeHit),
}

impl StepOut {
    pub fn extend(&mut self, other: StepOut) {
        self.slams.extend(other.slams);
        self.hits.extend(other.hits);
        self.landed.extend(other.landed);
    }
}

impl Actors {
    pub fn new() -> Self {
        Self { list: Vec::new(), missiles: Vec::new(), next_id: 1, next_group: 1, next_band: 1, next_missile: 1, calm: false }
    }

    /// A new crowd for somewhere else that numbers on from this one: none of its creatures, groups,
    /// bands or missiles shares an id with these, so a page drawing both by id never mixes them up.
    pub fn numbering_on(&self) -> Self {
        Self { next_id: self.next_id, next_group: self.next_group, next_band: self.next_band, next_missile: self.next_missile, calm: self.calm, ..Self::new() }
    }

    /// Everything gone, and the numbering started again (Actors.clear in src/engine/actors/actor.ts).
    pub fn clear(&mut self) {
        let calm = self.calm;
        *self = Self::new();
        self.calm = calm;
    }

    /// A fresh id for a war-band.
    pub fn new_band(&mut self) -> u32 {
        let b = self.next_band;
        self.next_band = if b >= 0x7fff_ffff { 1 } else { b + 1 };
        b
    }

    /// One standing where a world puts it (or a test does), its brain started on what it sees
    /// (`seen`: the player). With no seed of its own it takes one from its id. Returns its id.
    pub fn spawn_at(&mut self, p: &SpawnPoint, band: u32, transient: bool, seen: Sighting) -> Option<u32> {
        let k = kind(&p.kind)?;
        let index = kind_index(&p.kind)?;
        let id = self.allocate();
        let seed = p.seed.unwrap_or((id as u64 * 0x9e37_79b1) as u32);
        let mut a = Actor::of_kind(id, k, index, p.x, p.z, seed);
        a.facing = p.facing.unwrap_or(0.0);
        a.band = band;
        a.transient = transient;
        start_brain(&mut a, seen);
        self.list.push(a);
        Some(id)
    }

    // Counts spawns up; once they've come round, a generation on (skipping any number still in
    // use, should the generations themselves come round).
    fn allocate(&mut self) -> u32 {
        loop {
            let id = self.next_id;
            let (generation, spawn) = (id >> 16, id & SPAWNS);
            self.next_id = if spawn >= SPAWNS { ((generation + 1) & GENERATIONS) << 16 | 1 } else { id + 1 };
            if !self.list.iter().any(|a| a.id == id) {
                return id;
            }
        }
    }

    /// A creature's id, the same everywhere (its number here: crate::ids).
    pub fn entity(a: &Actor) -> EntityId {
        EntityId::creature(a.id)
    }

    fn new_group(&mut self) -> u32 {
        let g = self.next_group;
        self.next_group = if g >= 0x7fff_ffff { 1 } else { g + 1 };
        g
    }

    fn missile_id(&mut self) -> u32 {
        let m = self.next_missile;
        self.next_missile = if m >= 0x7fff_ffff { 1 } else { m + 1 };
        m
    }

    /// Adds one, standing still, and returns where it is in the list. Its brain isn't started.
    fn spawn_index(&mut self, kind_id: &str, x: f64, z: f64, seed: u32) -> Option<usize> {
        let k = kind(kind_id)?;
        let index = kind_index(kind_id)?;
        let id = self.allocate();
        self.list.push(Actor::of_kind(id, k, index, x, z, seed));
        Some(self.list.len() - 1)
    }

    pub fn spawn(&mut self, kind_id: &str, x: f64, z: f64, seed: u32) -> Option<u32> {
        let i = self.spawn_index(kind_id, x, z, seed)?;
        let a = &mut self.list[i];
        start_brain(a, Sighting::at(x, z, false));
        Some(a.id)
    }

    /// Spawns one into a war-band, facing `facing`.
    pub fn spawn_in_band(&mut self, kind_id: &str, x: f64, z: f64, facing: f64, seed: u32, band: u32) -> Option<u32> {
        let i = self.spawn_index(kind_id, x, z, seed)?;
        let a = &mut self.list[i];
        a.facing = facing;
        a.band = band;
        start_brain(a, Sighting::at(x, z, false));
        Some(a.id)
    }

    pub fn get(&self, id: u32) -> Option<&Actor> {
        self.list.iter().find(|a| a.id == id)
    }

    pub fn get_mut(&mut self, id: u32) -> Option<&mut Actor> {
        self.list.iter_mut().find(|a| a.id == id)
    }

    fn index_of(&self, id: u32) -> Option<usize> {
        self.list.iter().position(|a| a.id == id)
    }

    /// Where each one is in the list, in the order of their ids: the order anything that reaches
    /// across creatures goes in, whatever order the list is in.
    fn by_id(&self) -> Vec<usize> {
        let mut order: Vec<usize> = (0..self.list.len()).collect();
        order.sort_by_key(|&i| self.list[i].id);
        order
    }

    /// One frame of every actor: its brain, its lean,
    /// bringing it back when it has been down long enough, and what the pack does together.
    /// `foes` is every player the actors can notice; `ground` the height of the ground, for
    /// missiles. Returns the slams that landed and the blows and missiles that reached a foe,
    /// for the caller to deal with.
    pub fn step(&mut self, foes: &[Foe], ground: &dyn Fn(f64, f64) -> f64, spring: f64, damping: f64, dt: f64) -> StepOut {
        let mut res = StepOut::default();
        let mut ev = Vec::new();
        let landed = self.step_with(foes, ground, spring, damping, dt, &mut ev, &mut |b, _| match b {
            Blow::Slam(s) => res.slams.push(s),
            Blow::Hit(h) => res.hits.push(h),
        });
        res.landed = landed;
        res
    }

    /// The same frame, with what it shows (crate::event: pieces bursting, calls, gathering,
    /// healing, missiles landing, growing) added to `ev` as it happens, and every slam and blow
    /// handed to `on_blow` the moment it lands, with `ev` for what that shows. Returns where missiles
    /// came down.
    ///
    /// The order the list is in makes no difference. Each brain steps its own creature alone,
    /// seeing the others as they stood when the frame began (`peers`) and asking for whatever
    /// reaches another (`Request`); everything that reaches across creatures (deaths handed on,
    /// packs, what was asked for, coming back) is done once every brain has stepped, in the order of
    /// their ids. The brains themselves go in the list's order, which the checks shuffle to show it.
    #[allow(clippy::too_many_arguments)]
    pub fn step_with(
        &mut self,
        foes: &[Foe],
        ground: &dyn Fn(f64, f64) -> f64,
        spring: f64,
        damping: f64,
        dt: f64,
        ev: &mut Vec<Event>,
        on_blow: &mut dyn FnMut(Blow, &mut Vec<Event>),
    ) -> Vec<(f64, f64, f64)> {
        let mut landed = Vec::new();

        // Whatever was killed since the last frame, in the order of their ids: a caller hands its
        // call on, and anything that bursts does.
        for i in self.by_id() {
            if self.list[i].dead_frame != 0 || self.list[i].gone {
                continue;
            }
            if self.list[i].calling >= 0 {
                self.hand_over(i, foes);
            }
            self.list[i].calling = -1;
            self.list[i].rally_to = 0;
            self.burst(i, foes, ground, ev);
        }

        // What every brain can see of the others, and how much of each creature is about.
        let order = self.by_id();
        let mut peers: Vec<Peer> = Vec::new();
        let mut live = vec![0.0f64; ladders().len()];
        let mut budget = vec![0.0f64; ladders().len()];
        for a in order.iter().map(|&i| &self.list[i]) {
            if a.ladder >= 0 && !a.transient {
                budget[a.ladder as usize] += kind_mass(&a.home_kind);
            }
            if !a.is_alive() || a.gone {
                continue;
            }
            peers.push(Peer {
                id: a.id,
                x: a.x,
                z: a.z,
                radius: a.radius,
                ladder: a.ladder,
                calling: a.calling,
                rally_to: a.rally_to,
                group: a.group,
                band: a.band,
            });
            if a.ladder >= 0 {
                live[a.ladder as usize] += a.mass;
            }
        }

        // Who each pack creature is after, whether it has noticed them, and then what its band
        // works out together.
        for &i in &order {
            let a = &self.list[i];
            let Some(b) = brain_of(a) else { continue };
            let Some(p) = b.pack.as_ref() else { continue };
            if !a.is_alive() || a.gone {
                continue;
            }
            let f = pick_foe(a, foes, p.switch_at).copied();
            self.list[i].target = f.map_or(0, |f| f.id);
            self.notice(i, f.as_ref());
        }
        step_packs(&mut self.list, &order, foes);

        // Each brain on its own creature, in the list's order (it makes no difference which).
        let mut out: Vec<Request> = Vec::new();
        let mut down: Vec<usize> = Vec::new();
        for i in 0..self.list.len() {
            let a = &mut self.list[i];
            a.flash_frame = (a.flash_frame + 1).min(999);
            if a.is_alive() {
                if a.angry > 0 {
                    a.angry -= 1;
                }
                if a.slam_cd > 0 {
                    a.slam_cd -= 1;
                }
                if a.gather_cd > 0 {
                    a.gather_cd -= 1;
                }
                for c in a.cds.iter_mut() {
                    if *c > 0 {
                        *c -= 1;
                    }
                }
                if a.calling >= 0 {
                    a.calling += 1;
                }
                let calm_beyond = brain_of(a).and_then(|b| b.anger.as_ref()).map(|g| g.calm_beyond);
                if let Some(calm) = calm_beyond
                    && a.angry > 0
                    && len(a.x - a.home_x, a.z - a.home_z) > calm
                {
                    a.angry = 0;
                    a.rally_to = 0;
                }
                if a.fuse > 0 {
                    a.fuse -= 1;
                    if a.fuse == 0 {
                        out.push(Request::FuseOut(a.id));
                    }
                }
                if a.pulled > 0 {
                    a.pulled -= 1;
                } else {
                    let seen = see_for(foes, a);
                    let mut ctx = Ctx { peers: &peers, out: &mut out };
                    step_brain_in(a, seen, &mut ctx);
                }
            } else {
                a.dead_frame += 1;
                if !a.transient && a.respawn_frames >= 0 && a.dead_frame >= a.respawn_frames {
                    down.push(i);
                }
            }
            if a.lean_x != 0.0 || a.lean_z != 0.0 || a.lean_vx != 0.0 || a.lean_vz != 0.0 {
                a.lean_vx += (-spring * a.lean_x - damping * a.lean_vx) * dt;
                a.lean_vz += (-spring * a.lean_z - damping * a.lean_vz) * dt;
                a.lean_x += a.lean_vx * dt;
                a.lean_z += a.lean_vz * dt;
            }
        }

        // A home actor down long enough comes back where it started, if there's room for it: in the
        // order of their ids, as room taken by one is room another can't have.
        down.sort_by_key(|&i| self.list[i].id);
        for i in down {
            let a = &mut self.list[i];
            let m = kind_mass(&a.home_kind);
            let room = a.ladder < 0 || live[a.ladder as usize] + m <= budget[a.ladder as usize];
            if room {
                a.revive();
                let seen = nearest_at(foes, a.x, a.z);
                start_brain(a, seen);
                if a.ladder >= 0 {
                    live[a.ladder as usize] += m;
                }
            }
        }

        // What the brains asked for, in the order of their ids (each one's in the order it asked).
        out.sort_by_key(Request::actor);
        for r in out {
            let Some(i) = self.index_of(r.actor()) else { continue };
            if !self.list[i].is_alive() || self.list[i].gone {
                continue;
            }
            match r {
                Request::Call(_) => self.call(i, ground, ev),
                Request::Pull(_) => self.pull(i),
                Request::Absorb(_) => self.absorb(i, ground, ev),
                Request::Slam(_) => {
                    let a = &self.list[i];
                    if let Some(s) = kind(&a.kind).and_then(|k| k.slam.as_ref()) {
                        on_blow(Blow::Slam(Slam { x: a.x, z: a.z, radius: s.radius, damage: s.damage, knock: s.knock }), ev);
                    }
                }
                Request::FuseOut(_) => self.fuse_out(i, foes, ground, ev),
                Request::Strike(_, attack) => {
                    let mut hits = Vec::new();
                    self.strike_foes(i, attack, foes, &mut hits);
                    for h in hits {
                        on_blow(Blow::Hit(h), ev);
                    }
                }
                Request::Throw(_, attack) => self.throw_at(i, attack, foes, ground),
                Request::Heal(_) => self.heal(i, ground, ev),
                Request::GatherStart(_) => {
                    let a = &self.list[i];
                    let radius = brain_of(a).and_then(|b| b.gather.as_ref()).map_or(0.0, |g| g.radius);
                    ev.push(Event::GatherStart { id: a.id, x: a.x, y: ground(a.x, a.z), z: a.z, radius });
                }
                Request::Broke(_) => {
                    let a = &self.list[i];
                    ev.push(Event::GatherBroken { id: a.id, x: a.x, y: ground(a.x, a.z) + a.hit_height, z: a.z });
                }
            }
        }

        // Everything thrown, in flight.
        for f in step_missiles(&mut self.missiles, foes, ground) {
            match f {
                Flight::Hit { foe, damage, knock, nx, nz } => on_blow(Blow::Hit(FoeHit { foe, damage, nx, nz, knock }), ev),
                Flight::Landed { x, y, z } => {
                    ev.push(Event::MissileLand { x, y, z });
                    landed.push((x, y, z));
                }
            }
        }

        // A rally ends when its caller stops calling, whatever the reason.
        for i in 0..self.list.len() {
            let to = self.list[i].rally_to;
            if to == 0 {
                continue;
            }
            let calling = self.list.iter().find(|c| c.id == to).is_some_and(|c| c.is_alive() && !c.gone && c.calling >= 0);
            if !calling {
                self.list[i].rally_to = 0;
            }
        }

        self.list.retain(|a| !(a.transient && (a.gone || a.dead_frame >= CLEAR_AFTER)));
        landed
    }

    // A creature that watches for trouble sees a foe in range of its home: it is angry, and so is
    // its band near it.
    fn notice(&mut self, i: usize, f: Option<&Foe>) {
        let Some(f) = f else { return };
        let Some(b) = brain_of(&self.list[i]) else { return };
        let Some(anger) = b.anger.as_ref() else { return };
        if !b.notices || self.calm {
            return;
        }
        let a = &self.list[i];
        if len(f.x - a.x, f.z - a.z) > b.sight || len(f.x - a.home_x, f.z - a.home_z) > b.leash {
            return;
        }
        self.list[i].angry = anger.frames;
        let a = self.list[i].clone();
        for o in self.list.iter_mut() {
            if !kin(&a, o) || len(o.x - a.x, o.z - a.z) > anger.radius {
                continue;
            }
            if brain_of(o).and_then(|b| b.anger.as_ref()).is_some() {
                o.angry = o.angry.max(anger_of(o));
            }
        }
    }

    // A strike lands: every foe in the cone in front of it and in reach, unless they are jumping
    // clear of it or in a dodge's untouchable frames.
    fn strike_foes(&self, i: usize, attack: usize, foes: &[Foe], hits: &mut Vec<FoeHit>) {
        let Some(atk) = attack_at(attack) else { return };
        let a = &self.list[i];
        let body = tuning().movement.player_radius;
        let reach = atk.reach + body;
        let half = (atk.arc / 2.0) * DEG;
        for f in foes {
            if f.invuln {
                continue;
            }
            let (dx, dz) = (f.x - a.x, f.z - a.z);
            let d = len(dx, dz);
            if d > reach {
                continue;
            }
            if angle_diff(a.facing, dx.js_atan2(dz)).abs() > half && d > body + 0.3 {
                continue;
            }
            if atk.lift.is_some_and(|lift| f.air > lift) {
                continue;
            }
            let (nx, nz) = if d > 0.01 { (dx / d, dz / d) } else { (a.facing.js_sin(), a.facing.js_cos()) };
            hits.push(FoeHit { foe: f.id, damage: atk.damage, nx, nz, knock: atk.knock });
        }
    }

    // A throw lets go: at the foe it is after, or the nearest.
    fn throw_at(&mut self, i: usize, attack: usize, foes: &[Foe], ground: &dyn Fn(f64, f64) -> f64) {
        let Some(atk) = attack_at(attack) else { return };
        let a = &self.list[i];
        let mut foe = foes.iter().rfind(|f| f.id == a.target);
        if foe.is_none() {
            let mut best = f64::INFINITY;
            for f in foes {
                let d = len(f.x - a.x, f.z - a.z);
                if d < best {
                    foe = Some(f);
                    best = d;
                }
            }
        }
        let Some(foe) = foe.copied() else { return };
        let ground_y = ground(a.x, a.z);
        let id = self.missile_id();
        let m = launch(id, &self.list[i], atk, attack, &foe, ground_y);
        self.missiles.push(m);
    }

    // A drink went down: it is back on its feet by its brain's heal.
    fn heal(&mut self, i: usize, ground: &dyn Fn(f64, f64) -> f64, ev: &mut Vec<Event>) {
        let a = &mut self.list[i];
        let Some(h) = brain_of(a).and_then(|b| b.heal.as_ref()) else { return };
        let was = a.hp;
        a.hp = a.max_hp.min(a.hp + h.amount * a.max_hp);
        ev.push(Event::ActorHeal { id: a.id, x: a.x, y: ground(a.x, a.z) + a.hit_height, z: a.z, amount: a.hp - was });
    }

    // The caller fell: the nearest of those rallying to it that could gather takes the call over.
    fn hand_over(&mut self, dead: usize, foes: &[Foe]) {
        let (did, dx, dz) = (self.list[dead].id, self.list[dead].x, self.list[dead].z);
        let mut next: Option<usize> = None;
        let mut next_dist = f64::INFINITY;
        for j in self.by_id() {
            let o = &self.list[j];
            if o.rally_to != did || !o.is_alive() || o.gone || o.gather_cd > 0 {
                continue;
            }
            let Some(b) = brain_of(o) else { continue };
            if b.call.is_none() || b.gather.is_none() || !kind(&o.kind).is_some_and(|k| k.gathers) {
                continue;
            }
            let d = len(o.x - dx, o.z - dz);
            if d < next_dist {
                next = Some(j);
                next_dist = d;
            }
        }
        let next_id = next.map(|j| self.list[j].id);
        for o in self.list.iter_mut() {
            if o.rally_to == did {
                o.rally_to = match next_id {
                    Some(n) if n != o.id => n,
                    _ => 0,
                };
            }
        }
        let Some(j) = next else { return };
        let c = &mut self.list[j];
        c.calling = 0;
        let seen = nearest_at(foes, c.x, c.z);
        force_state(c, "call", seen);
    }

    // Dying into pieces: they scatter, and have the fuse to be killed in before they reform.
    fn burst(&mut self, i: usize, foes: &[Foe], ground: &dyn Fn(f64, f64) -> f64, ev: &mut Vec<Event>) {
        let Some(k) = kind(&self.list[i].kind) else { return };
        let Some(b) = k.burst.as_ref() else { return };
        let ladder = self.list[i].ladder;
        let Some(lad) = ladder_at(ladder) else { return };
        let living = self.list.iter().filter(|o| o.ladder == ladder && o.is_alive() && !o.gone).count();
        let count = b.count.min(lad.cap.saturating_sub(living));
        if count == 0 {
            return;
        }
        let group = self.new_group();
        let reform = size_up(&k.id);
        let base = draw(&mut self.list[i]) * std::f64::consts::PI * 2.0;
        let (x, z, seed) = (self.list[i].x, self.list[i].z, self.list[i].seed);
        let seen = nearest_at(foes, x, z);
        for n in 0..count {
            let s = seed ^ ((n as u32 + 1).wrapping_mul(0x9e37_79b1));
            let Some(ci) = self.spawn_index(&b.into, x, z, s) else { continue };
            let c = &mut self.list[ci];
            c.transient = true;
            c.group = group;
            c.fuse = lad.fuse;
            c.reform = reform.clone();
            c.angry = anger_of(c);
            let angle = base + (n as f64 * std::f64::consts::PI * 2.0) / count as f64;
            c.move_x = angle.js_sin();
            c.move_z = angle.js_cos();
            c.stride = 2.0 + draw(c);
            start_brain(c, seen);
        }
        let a = &self.list[i];
        ev.push(Event::ActorBurst { kind: a.kind.clone(), count: count as u32, x, y: ground(x, z) + a.hit_height, z });
    }

    // The pack hears the call: every one of its kin close enough that isn't busy comes running.
    fn call(&mut self, ci: usize, ground: &dyn Fn(f64, f64) -> f64, ev: &mut Vec<Event>) {
        let Some(c) = brain_of(&self.list[ci]).and_then(|b| b.call.as_ref()) else { return };
        let caller = self.list[ci].clone();
        for o in self.list.iter_mut() {
            if !kin(&caller, o) || o.group != 0 || o.calling >= 0 {
                continue;
            }
            if o.rally_to != 0 && o.rally_to != caller.id {
                continue;
            }
            if len(o.x - caller.x, o.z - caller.z) > c.radius {
                continue;
            }
            o.rally_to = caller.id;
            o.angry = o.angry.max(anger_of(o));
        }
        ev.push(Event::ActorCall { id: caller.id, x: caller.x, y: ground(caller.x, caller.z), z: caller.z, radius: c.radius });
    }

    // A frame of gathering: every one of its kin inside the swirl slides in until it touches.
    fn pull(&mut self, ci: usize) {
        let Some(g) = brain_of(&self.list[ci]).and_then(|b| b.gather.as_ref()) else { return };
        let caster = self.list[ci].clone();
        for o in self.list.iter_mut() {
            if !kin(&caster, o) {
                continue;
            }
            let (dx, dz) = (o.x - caster.x, o.z - caster.z);
            let d = len(dx, dz);
            if d > g.radius {
                continue;
            }
            let touch = caster.radius + o.radius + 0.1;
            if d > touch {
                let step = (g.pull * STEP).min(d - touch);
                o.x -= (dx / d) * step;
                o.z -= (dz / d) * step;
            }
            if o.pulled == 0 {
                rest_state(o);
            }
            o.pulled = 2;
        }
    }

    // The cast is done: everything touching it is taken in, and it grows if that's enough.
    fn absorb(&mut self, ci: usize, ground: &dyn Fn(f64, f64) -> f64, ev: &mut Vec<Event>) {
        let caster = self.list[ci].clone();
        let mut gained = 0.0;
        let mut healed = 0.0;
        for j in self.by_id() {
            let o = &mut self.list[j];
            if !kin(&caster, o) {
                continue;
            }
            if len(o.x - caster.x, o.z - caster.z) > caster.radius + o.radius + TOUCH {
                continue;
            }
            gained += o.mass;
            healed += o.hp;
            take_out(o);
            ev.push(Event::ActorAbsorbed { x: o.x, y: ground(o.x, o.z) + o.hit_height, z: o.z, to_x: caster.x, to_z: caster.z });
        }
        if gained <= 0.0 {
            return;
        }
        let c = &mut self.list[ci];
        c.mass += gained;
        let grown = size_for(c.ladder, c.mass).filter(|s| kind_mass(s) > kind_mass(&c.kind)).and_then(kind);
        if let Some(k) = grown {
            c.become_kind(k);
            c.hp = c.max_hp;
            ev.push(Event::ActorGrow { id: c.id, kind: c.kind.clone(), x: c.x, y: ground(c.x, c.z), z: c.z });
        } else {
            c.hp = c.max_hp.min(c.hp + healed);
        }
    }

    // A fuse ran out. Two or more of the group left: they come back together, one size up. One
    // left: it's alone, and dissolves in a while. Alone already: it's gone.
    fn fuse_out(&mut self, i: usize, foes: &[Foe], ground: &dyn Fn(f64, f64) -> f64, ev: &mut Vec<Event>) {
        let group = self.list[i].group;
        if group == 0 {
            let a = &mut self.list[i];
            if a.reform.is_empty() {
                a.hp = 0.0;
                a.dead_frame = 0;
                ev.push(Event::ActorDie { id: a.id, kind: a.kind.clone(), x: a.x, y: ground(a.x, a.z) + a.hit_height, z: a.z, killed: false });
            }
            return;
        }
        let members: Vec<usize> = self.by_id().into_iter().filter(|&j| self.list[j].group == group && self.list[j].is_alive() && !self.list[j].gone).collect();
        if members.len() < 2 {
            for &j in &members {
                let m = &mut self.list[j];
                m.group = 0;
                m.reform.clear();
                m.fuse = ladder_at(m.ladder).map_or(-1, |l| l.alone);
            }
            return;
        }
        let (mut x, mut z) = (0.0, 0.0);
        for &j in &members {
            x += self.list[j].x;
            z += self.list[j].z;
        }
        x /= members.len() as f64;
        z /= members.len() as f64;
        let into = self.list[members[0]].reform.clone();
        let seed = self.list[members[0]].seed ^ 0x5bd1_e995;
        for &j in &members {
            take_out(&mut self.list[j]);
        }
        let Some(ci) = self.spawn_index(&into, x, z, seed) else { return };
        let c = &mut self.list[ci];
        c.transient = true;
        c.angry = anger_of(c);
        c.gather_cd = brain_of(c).and_then(|b| b.gather.as_ref()).map_or(0, |g| g.cooldown) / 2;
        start_brain(c, nearest_at(foes, x, z));
        ev.push(Event::ActorGrow { id: c.id, kind: c.kind.clone(), x, y: ground(x, z), z });
    }

    /// A melee swing from (x, z): everything in the arc and in reach, nearest first (of two as near,
    /// the lower id), capped at `max`. Each one is judged where `place` says it stands, which for a
    /// player's swing is where their screen showed it (crate::combat rewinds it), and passed over
    /// where that's None (on hills, feet too far from yours). Each comes back with that place.
    #[allow(clippy::too_many_arguments)]
    pub fn cone_hits_at(
        &self,
        x: f64,
        z: f64,
        facing: f64,
        reach: f64,
        arc_deg: f64,
        max: usize,
        place: impl Fn(&Actor) -> Option<(f64, f64)>,
    ) -> Vec<(u32, f64, f64)> {
        let mut hits: Vec<(f64, u32, f64, f64)> = self
            .list
            .iter()
            .filter(|a| a.is_alive())
            .filter_map(|a| {
                let (ax, az) = place(a)?;
                let (dx, dz) = (ax - x, az - z);
                let dist = len(dx, dz);
                if dist > reach + a.radius {
                    return None;
                }
                let in_cone = angle_diff(facing, dx.js_atan2(dz)).abs() <= (arc_deg / 2.0) * DEG;
                if !in_cone && dist > a.radius + 0.3 {
                    return None;
                }
                Some((dist, a.id, ax, az))
            })
            .collect();
        hits.sort_by(|p, q| p.0.total_cmp(&q.0).then(p.1.cmp(&q.1)));
        hits.truncate(max.max(1));
        hits.into_iter().map(|(_, id, ax, az)| (id, ax, az)).collect()
    }

    /// A blast: everything whose body overlaps the circle, in the order of their ids.
    pub fn circle_hits(&self, x: f64, z: f64, radius: f64) -> Vec<u32> {
        let mut hits: Vec<u32> = self.list.iter().filter(|a| a.is_alive() && len(a.x - x, a.z - z) <= radius + a.radius).map(|a| a.id).collect();
        hits.sort_unstable();
        hits
    }

    /// A projectile at a point in flight: the first thing it touches (the nearest, and of two as
    /// near, the one with the lower id).
    pub fn point_hit(&self, x: f64, y: f64, z: f64, pad: f64) -> Option<u32> {
        let mut best: Option<(f64, u32)> = None;
        for a in self.list.iter().filter(|a| a.is_alive()) {
            if y > a.hit_ceiling {
                continue;
            }
            let dist = len(a.x - x, a.z - z);
            if dist > a.radius + pad {
                continue;
            }
            if best.is_none_or(|(d, id)| dist < d || (dist == d && a.id < id)) {
                best = Some((dist, a.id));
            }
        }
        best.map(|(_, id)| id)
    }

    /// Takes a hit travelling along (nx, nz). Returns a death if that finished it. Being hit
    /// angers it and its kin close by, and a hard enough
    /// blow makes it flinch.
    pub fn damage(&mut self, id: u32, amount: f64, nx: f64, nz: f64, knock: f64) -> Option<Death> {
        let i = self.index_of(id)?;
        if !self.list[i].is_alive() {
            return None;
        }
        {
            let a = &mut self.list[i];
            a.hp = (a.hp - amount).max(0.0);
            a.flash_frame = 0;
        }
        self.provoke(i, amount);
        let a = &mut self.list[i];
        if a.hp > 0.0 {
            flinch(a, amount);
        }
        a.lean_vx += nx * knock;
        a.lean_vz += nz * knock;
        if a.hp > 0.0 {
            return None;
        }
        a.dead_frame = 0;
        Some(Death { id: a.id, kind_index: a.kind_index, x: a.x, y: a.hit_height, z: a.z })
    }

    fn provoke(&mut self, i: usize, amount: f64) {
        self.list[i].taken += amount;
        if self.calm {
            return;
        }
        let Some(anger) = brain_of(&self.list[i]).and_then(|b| b.anger.as_ref()) else { return };
        self.list[i].angry = anger.frames;
        if anger.radius <= 0.0 {
            return;
        }
        let a = self.list[i].clone();
        for o in self.list.iter_mut() {
            if !kin(&a, o) || len(o.x - a.x, o.z - a.z) > anger.radius {
                continue;
            }
            let theirs = anger_of(o);
            if brain_of(o).and_then(|b| b.anger.as_ref()).is_some() {
                o.angry = o.angry.max(theirs);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creatures_are_numbered_by_spawn_then_generation() {
        let mut actors = Actors::new();
        let first = actors.spawn("slime", 0.0, 0.0, 1).expect("a slime");
        assert_eq!(first, 1, "the first spawn of the first generation");
        assert_eq!(Actors::entity(actors.get(first).unwrap()), EntityId::creature(1));
        // The last spawn of a generation, then the first of the next.
        actors.next_id = SPAWNS;
        assert_eq!(actors.spawn("slime", 1.0, 0.0, 2), Some(SPAWNS));
        assert_eq!(actors.spawn("slime", 2.0, 0.0, 3), Some(1 << 16 | 1));
        // A number still in use is skipped, should the generations come round to it.
        actors.next_id = GENERATIONS << 16 | SPAWNS;
        assert_eq!(actors.spawn("slime", 3.0, 0.0, 4), Some(GENERATIONS << 16 | SPAWNS));
        assert_eq!(actors.spawn("slime", 4.0, 0.0, 5), Some(2), "1 is the first slime's still");
        assert!(actors.list.iter().all(|a| a.id < 1 << 30));
    }
}
