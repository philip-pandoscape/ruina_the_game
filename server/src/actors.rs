//! The world's actors on the server: monsters, NPCs and props. Mirrors src/sim/actor.ts,
//! src/sim/actors/step.ts and src/sim/combat/hit.ts, so the training yard offline and a live
//! server agree about where a slime is, what a swing reaches, and what a pack does together:
//! bursting into pieces, a caller gathering the others in, a burst group reforming one size up.

use crate::actor::Actor;
use crate::ai::{brain_of, draw, force_state, rest_state, start_brain, step_brain_in, Ctx, Peer, Request, Sighting};
use crate::content::{kind, kind_index, kind_mass, ladder_at, ladders, size_for, size_up};

const DEG: f64 = std::f64::consts::PI / 180.0;
/// Ids go out on the wire as 16 bits.
const MAX_ID: u32 = 65_535;
/// Frames a dead piece of a burst lies there before it is cleared away.
const CLEAR_AFTER: i32 = 60;
/// How close to a gatherer something has to be pulled before it is taken in.
const TOUCH: f64 = 0.35;
/// The rules' fixed step: brains count in 60ths of a second, whatever the server's tick.
const STEP: f64 = 1.0 / 60.0;

fn len(x: f64, z: f64) -> f64 {
    (x * x + z * z).sqrt()
}

fn angle_diff(a: f64, b: f64) -> f64 {
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

/// The nearest player to a point, which is who a brain there pays attention to.
fn sighting(players: &[(f64, f64)], x: f64, z: f64) -> Sighting {
    let mut seen = Sighting { x, z, present: false };
    let mut best = f64::INFINITY;
    for &(px, pz) in players {
        let d = len(px - x, pz - z);
        if d < best {
            best = d;
            seen = Sighting { x: px, z: pz, present: true };
        }
    }
    seen
}

fn anger_of(a: &Actor) -> i32 {
    brain_of(a).and_then(|b| b.anger.as_ref()).map_or(0, |g| g.frames)
}

fn kin(a: &Actor, o: &Actor) -> bool {
    a.id != o.id && a.ladder >= 0 && o.ladder == a.ladder && o.is_alive() && !o.gone
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

/// How anything that rocks when hit settles back upright; matches LEAN in src/tuning.ts.
pub const LEAN_SPRING: f64 = 140.0;
pub const LEAN_DAMPING: f64 = 7.0;

pub struct Actors {
    pub list: Vec<Actor>,
    next_id: u32,
    next_group: u32,
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

impl Actors {
    pub fn new() -> Self {
        Self { list: Vec::new(), next_id: 1, next_group: 1 }
    }

    // Counts up and wraps, skipping ids still in use. Mirrors Actors.allocate() in actor.ts.
    fn allocate(&mut self) -> u32 {
        loop {
            let id = self.next_id;
            self.next_id = if id >= MAX_ID { 1 } else { id + 1 };
            if !self.list.iter().any(|a| a.id == id) {
                return id;
            }
        }
    }

    fn new_group(&mut self) -> u32 {
        let g = self.next_group;
        self.next_group = if g >= 0x7fff_ffff { 1 } else { g + 1 };
        g
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
        start_brain(a, Sighting { x, z, present: false });
        Some(a.id)
    }

    pub fn get_mut(&mut self, id: u32) -> Option<&mut Actor> {
        self.list.iter_mut().find(|a| a.id == id)
    }

    fn index_of(&self, id: u32) -> Option<usize> {
        self.list.iter().position(|a| a.id == id)
    }

    /// One frame of every actor (src/sim/actors/step.ts stepActors): its brain, its lean,
    /// bringing it back when it has been down long enough, and what the pack does together.
    /// `players` is where everyone is, so a brain can notice the nearest. Returns the slams that
    /// landed, for the caller to find who was standing in them.
    pub fn step(&mut self, players: &[(f64, f64)], spring: f64, damping: f64, dt: f64) -> Vec<Slam> {
        let mut slams = Vec::new();

        // Whatever was killed since the last frame: a caller hands its call on, and anything
        // that bursts does.
        let before = self.list.len();
        for i in 0..before {
            if self.list[i].dead_frame != 0 || self.list[i].gone {
                continue;
            }
            if self.list[i].calling >= 0 {
                self.hand_over(i, players);
            }
            self.list[i].calling = -1;
            self.list[i].rally_to = 0;
            self.burst(i, players);
        }

        // What every brain can see of the others, and how much of each creature is about.
        let mut peers: Vec<Peer> = Vec::new();
        let mut live = vec![0.0f64; ladders().len()];
        let mut budget = vec![0.0f64; ladders().len()];
        for a in self.list.iter() {
            if a.ladder >= 0 && !a.transient {
                budget[a.ladder as usize] += kind_mass(&a.home_kind);
            }
            if !a.is_alive() || a.gone {
                continue;
            }
            peers.push(Peer { id: a.id, x: a.x, z: a.z, radius: a.radius, ladder: a.ladder, calling: a.calling, rally_to: a.rally_to, group: a.group });
            if a.ladder >= 0 {
                live[a.ladder as usize] += a.mass;
            }
        }

        let mut out: Vec<Request> = Vec::new();
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
                if a.calling >= 0 {
                    a.calling += 1;
                }
                let calm_beyond = brain_of(a).and_then(|b| b.anger.as_ref()).map(|g| g.calm_beyond);
                if let Some(calm) = calm_beyond {
                    if a.angry > 0 && len(a.x - a.home_x, a.z - a.home_z) > calm {
                        a.angry = 0;
                        a.rally_to = 0;
                    }
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
                    let seen = sighting(players, a.x, a.z);
                    let mut ctx = Ctx { peers: &peers, out: &mut out };
                    step_brain_in(a, seen, &mut ctx);
                }
            } else {
                a.dead_frame += 1;
                // A home actor comes back where it started, if there's room for it.
                if !a.transient && a.respawn_frames >= 0 && a.dead_frame >= a.respawn_frames {
                    let m = kind_mass(&a.home_kind);
                    let room = a.ladder < 0 || live[a.ladder as usize] + m <= budget[a.ladder as usize];
                    if room {
                        a.revive();
                        let seen = sighting(players, a.x, a.z);
                        start_brain(a, seen);
                        if a.ladder >= 0 {
                            live[a.ladder as usize] += m;
                        }
                    }
                }
            }
            if a.lean_x != 0.0 || a.lean_z != 0.0 || a.lean_vx != 0.0 || a.lean_vz != 0.0 {
                a.lean_vx += (-spring * a.lean_x - damping * a.lean_vx) * dt;
                a.lean_vz += (-spring * a.lean_z - damping * a.lean_vz) * dt;
                a.lean_x += a.lean_vx * dt;
                a.lean_z += a.lean_vz * dt;
            }
        }

        // What the brains asked for, in the order they asked.
        for r in out {
            let id = match r {
                Request::Call(id) | Request::Pull(id) | Request::Absorb(id) | Request::Slam(id) | Request::FuseOut(id) => id,
                Request::GatherStart(_) | Request::Broke(_) => continue, // effects only, for the browser
            };
            let Some(i) = self.index_of(id) else { continue };
            if !self.list[i].is_alive() || self.list[i].gone {
                continue;
            }
            match r {
                Request::Call(_) => self.call(i),
                Request::Pull(_) => self.pull(i),
                Request::Absorb(_) => self.absorb(i),
                Request::Slam(_) => {
                    let a = &self.list[i];
                    if let Some(s) = kind(&a.kind).and_then(|k| k.slam.as_ref()) {
                        slams.push(Slam { x: a.x, z: a.z, radius: s.radius, damage: s.damage, knock: s.knock });
                    }
                }
                Request::FuseOut(_) => self.fuse_out(i, players),
                Request::GatherStart(_) | Request::Broke(_) => {}
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
        slams
    }

    // The caller fell: the nearest of those rallying to it that could gather takes the call over.
    fn hand_over(&mut self, dead: usize, players: &[(f64, f64)]) {
        let (did, dx, dz) = (self.list[dead].id, self.list[dead].x, self.list[dead].z);
        let mut next: Option<usize> = None;
        let mut next_dist = f64::INFINITY;
        for (j, o) in self.list.iter().enumerate() {
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
        let seen = sighting(players, c.x, c.z);
        force_state(c, "call", seen);
    }

    // Dying into pieces: they scatter, and have the fuse to be killed in before they reform.
    fn burst(&mut self, i: usize, players: &[(f64, f64)]) {
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
            c.move_x = angle.sin();
            c.move_z = angle.cos();
            c.stride = 2.0 + draw(c);
            start_brain(c, sighting(players, x, z));
        }
    }

    // The pack hears the call: every one of its kin close enough that isn't busy comes running.
    fn call(&mut self, ci: usize) {
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
    fn absorb(&mut self, ci: usize) {
        let caster = self.list[ci].clone();
        let mut gained = 0.0;
        let mut healed = 0.0;
        for o in self.list.iter_mut() {
            if !kin(&caster, o) {
                continue;
            }
            if len(o.x - caster.x, o.z - caster.z) > caster.radius + o.radius + TOUCH {
                continue;
            }
            gained += o.mass;
            healed += o.hp;
            take_out(o);
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
        } else {
            c.hp = c.max_hp.min(c.hp + healed);
        }
    }

    // A fuse ran out. Two or more of the group left: they come back together, one size up. One
    // left: it's alone, and dissolves in a while. Alone already: it's gone.
    fn fuse_out(&mut self, i: usize, players: &[(f64, f64)]) {
        let group = self.list[i].group;
        if group == 0 {
            let a = &mut self.list[i];
            if a.reform.is_empty() {
                a.hp = 0.0;
                a.dead_frame = 0;
            }
            return;
        }
        let members: Vec<usize> = (0..self.list.len()).filter(|&j| self.list[j].group == group && self.list[j].is_alive() && !self.list[j].gone).collect();
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
        start_brain(c, sighting(players, x, z));
    }

    /// A melee swing: everything in the arc and in reach, nearest first, capped at `max`.
    pub fn cone_hits(&self, x: f64, z: f64, facing: f64, reach: f64, arc_deg: f64, max: usize) -> Vec<u32> {
        self.cone_hits_where(x, z, facing, reach, arc_deg, max, |_| true)
    }

    /// The same, among only the actors `keep` allows (on hills: those whose feet are near yours).
    #[allow(clippy::too_many_arguments)]
    pub fn cone_hits_where(&self, x: f64, z: f64, facing: f64, reach: f64, arc_deg: f64, max: usize, keep: impl Fn(&Actor) -> bool) -> Vec<u32> {
        let mut hits: Vec<(f64, u32)> = self
            .list
            .iter()
            .filter(|a| a.is_alive() && keep(a))
            .filter_map(|a| {
                let (dx, dz) = (a.x - x, a.z - z);
                let dist = len(dx, dz);
                if dist > reach + a.radius {
                    return None;
                }
                let in_cone = angle_diff(facing, dx.atan2(dz)).abs() <= (arc_deg / 2.0) * DEG;
                if !in_cone && dist > a.radius + 0.3 {
                    return None;
                }
                Some((dist, a.id))
            })
            .collect();
        hits.sort_by(|p, q| p.0.total_cmp(&q.0));
        hits.truncate(max.max(1));
        hits.into_iter().map(|(_, id)| id).collect()
    }

    /// A blast: everything whose body overlaps the circle.
    pub fn circle_hits(&self, x: f64, z: f64, radius: f64) -> Vec<u32> {
        self.list
            .iter()
            .filter(|a| a.is_alive() && len(a.x - x, a.z - z) <= radius + a.radius)
            .map(|a| a.id)
            .collect()
    }

    /// A projectile at a point in flight: the first thing it touches.
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
            if best.is_none_or(|(d, _)| dist < d) {
                best = Some((dist, a.id));
            }
        }
        best.map(|(_, id)| id)
    }

    /// Takes a hit travelling along (nx, nz). Returns a death if that finished it. Being hit
    /// angers it and its kin close by (provoke() in src/sim/actors/step.ts).
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
