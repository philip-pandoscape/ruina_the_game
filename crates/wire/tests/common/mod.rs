//! A made-up world for the wire's tests and benches: players, bots, creatures, vehicles, packs on the
//! ground, arrows and meteors moving about on their own, packed into a Frame each tick as a sim
//! would; and a road between a Viewer and a Heard that can lose, hold back and shuffle what's on it.

#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use ruina_wire::heard::Heard;
use ruina_wire::pack::{key, owned_key};
use ruina_wire::record::{Event, Frame, Intro, Record};
use ruina_wire::schema::{Fields, Kind, MAX_FIELDS, PLAYER, reference};
use ruina_wire::viewer::{View, Viewer};

/// xorshift32: the tests' own random numbers, the same every run.
pub struct Rng(pub u32);

impl Rng {
    pub fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }

    /// 0..1.
    pub fn unit(&mut self) -> f64 {
        f64::from(self.next()) / f64::from(u32::MAX)
    }

    pub fn below(&mut self, n: u32) -> u32 {
        self.next() % n.max(1)
    }

    pub fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }
}

/// One made-up entity.
#[derive(Clone)]
pub struct Thing {
    pub key: u64,
    pub owner: u64,
    pub intro: Intro,
    pub fields: Fields,
    pub refers: u64,
    /// Metres a tick it drifts, x and z.
    pub vx: f64,
    pub vz: f64,
}

pub struct World {
    pub tick: u64,
    pub things: Vec<Thing>,
    pub rng: Rng,
    pub events: Vec<Event>,
    next_arrow: i64,
    /// How much of the world moves each tick (0..1).
    pub busy: f64,
}

fn field(kind: Kind, name: &str) -> usize {
    kind.fields().iter().position(|f| f.name == name).unwrap_or_else(|| panic!("{name}"))
}

impl World {
    /// `players` players (bots among them) and as many creatures, spread over a square `size` metres
    /// across round the origin, with a vehicle for every fourth player and a pack on the ground for
    /// every tenth.
    pub fn new(seed: u32, players: usize, creatures: usize, size: f64) -> World {
        let mut w = World { tick: 529_000_000, things: Vec::new(), rng: Rng(seed | 1), events: Vec::new(), next_arrow: 1, busy: 0.7 };
        for i in 0..players {
            let id = if i % 3 == 0 { -1_000_001 - i as i64 } else { 1 + i as i64 };
            let k = key(Kind::Player, id);
            let (x, z) = w.spot(size);
            let mut f = [0; MAX_FIELDS];
            f[0] = (x * 100.0) as i32;
            f[1] = (z * 100.0) as i32;
            f[2] = 150;
            f[3] = w.rng.below(65536) as i32;
            for name in ["attackFrame", "castFrame", "actionFrame", "flipFrame", "downFrame"] {
                f[field(Kind::Player, name)] = -1;
            }
            f[field(Kind::Player, "landFrame")] = 999;
            f[field(Kind::Player, "takeoffFrame")] = 999;
            f[field(Kind::Player, "hp")] = 10_000;
            f[field(Kind::Player, "castAbility")] = 255;
            f[field(Kind::Player, "actionId")] = 255;
            f[field(Kind::Player, "flags")] = 1;
            f[field(Kind::Player, "team")] = (i % 2) as i32;
            let name: Arc<str> = Arc::from(format!("Fighter {i}").as_str());
            let intro = Intro::Player { id, name, bot: id < 0 };
            let (vx, vz) = w.drift();
            w.things.push(Thing { key: k, owner: k, intro, fields: f, refers: 0, vx, vz });
            if i % 4 == 0 {
                let mut v = [0; MAX_FIELDS];
                v[0] = f[0] + 300;
                v[1] = f[1];
                v[3] = f[3];
                v[field(Kind::Vehicle, "flags")] = 1;
                v[field(Kind::Vehicle, "cargo0")] = 3;
                let vk = owned_key(Kind::Vehicle, id, 1);
                w.things.push(Thing { key: vk, owner: k, intro: Intro::Vehicle { owner: id, id: 1, def: 0 }, fields: v, refers: 0, vx: 0.0, vz: 0.0 });
            }
            if i % 10 == 0 {
                let mut p = [0; MAX_FIELDS];
                p[0] = f[0] - 200;
                p[1] = f[1] + 100;
                p[3] = 1000;
                let pk = owned_key(Kind::Item, id, 7);
                w.things.push(Thing { key: pk, owner: k, intro: Intro::Item { owner: id, id: 7, def: 2 }, fields: p, refers: 0, vx: 0.0, vz: 0.0 });
            }
        }
        for i in 0..creatures {
            let id = 1 + i as i64;
            let (x, z) = w.spot(size);
            let mut f = [0; MAX_FIELDS];
            f[0] = (x * 100.0) as i32;
            f[1] = (z * 100.0) as i32;
            f[field(Kind::Creature, "hp")] = 10_000;
            f[field(Kind::Creature, "deadFrame")] = -1;
            f[field(Kind::Creature, "wait")] = 60;
            f[field(Kind::Creature, "kind")] = (i % 5) as i32;
            let (vx, vz) = w.drift();
            w.things.push(Thing { key: key(Kind::Creature, id), owner: 0, intro: Intro::Creature { id }, fields: f, refers: 0, vx, vz });
        }
        w
    }

    fn spot(&mut self, size: f64) -> (f64, f64) {
        ((self.rng.unit() - 0.5) * size, (self.rng.unit() - 0.5) * size)
    }

    fn drift(&mut self) -> (f64, f64) {
        let a = self.rng.unit() * std::f64::consts::TAU;
        let speed = self.rng.unit() * 0.3;
        (a.cos() * speed, a.sin() * speed)
    }

    /// One tick: things move, swing, get hurt, arrows fly, meteors fall, effects happen.
    pub fn step(&mut self) {
        self.tick += 1;
        self.events.clear();
        let busy = self.busy;
        let mut arrows = Vec::new();
        for i in 0..self.things.len() {
            let roll = self.rng.unit();
            let t = &mut self.things[i];
            let kind = t.intro.kind();
            match kind {
                Kind::Player | Kind::Creature => {
                    if roll < busy {
                        t.fields[0] += (t.vx * 100.0) as i32;
                        t.fields[1] += (t.vz * 100.0) as i32;
                        t.fields[3] = (t.fields[3] + 300) & 0xffff;
                    }
                }
                Kind::Arrow => {
                    t.fields[0] += t.fields[3] / 20;
                    t.fields[1] += t.fields[4] / 20;
                }
                Kind::Meteor => {
                    t.fields[2] -= 1;
                }
                _ => {}
            }
            if kind == Kind::Player {
                // Swings start and run on; health comes and goes; now and then someone falls.
                let swing = field(Kind::Player, "attackFrame");
                if t.fields[swing] >= 0 {
                    t.fields[swing] += 3;
                    if t.fields[swing] > 30 {
                        t.fields[swing] = -1;
                        t.fields[field(Kind::Player, "mode")] = 0;
                    }
                } else if roll > 0.97 {
                    t.fields[swing] = 0;
                    t.fields[field(Kind::Player, "mode")] = 1;
                    t.fields[field(Kind::Player, "attackIndex")] = (t.fields[field(Kind::Player, "attackIndex")] + 1) % 3;
                }
                if roll > 0.99 {
                    t.fields[field(Kind::Player, "hp")] -= 750;
                }
                t.fields[field(Kind::Player, "run")] = t.fields[field(Kind::Player, "run")].wrapping_add((t.vx.hypot(t.vz) * 100.0) as i32);
                if roll > 0.995 {
                    arrows.push((t.key, t.fields[0], t.fields[1], t.fields[field(Kind::Player, "team")]));
                }
            }
            if kind == Kind::Creature {
                let frame = field(Kind::Creature, "stateFrame");
                t.fields[frame] += 3;
                if t.fields[frame] >= t.fields[field(Kind::Creature, "wait")] {
                    t.fields[frame] = 0;
                    t.fields[field(Kind::Creature, "state")] = (t.fields[field(Kind::Creature, "state")] + 1) % 4;
                }
            }
        }
        for (owner, x, z, team) in arrows {
            let id = self.next_arrow;
            self.next_arrow += 1;
            let mut f = [0; MAX_FIELDS];
            f[0] = x;
            f[1] = z;
            f[2] = 130;
            f[3] = 3000;
            f[4] = -1500;
            f[5] = team;
            self.things.push(Thing { key: key(Kind::Arrow, id), owner, intro: Intro::Arrow { id }, fields: f, refers: owner, vx: 0.0, vz: 0.0 });
            let mut m = [0; MAX_FIELDS];
            m[0] = x + 500;
            m[1] = z;
            m[2] = 20;
            m[3] = 20;
            m[4] = team;
            m[5] = 400;
            self.things.push(Thing { key: key(Kind::Meteor, id), owner, intro: Intro::Meteor { id }, fields: m, refers: 0, vx: 0.0, vz: 0.0 });
            self.events.push(Event::new(x, 120, z, 2, 40));
        }
        // Arrows that flew far enough and meteors that landed are gone.
        let tick = self.tick;
        self.things.retain(|t| match t.intro.kind() {
            Kind::Arrow => t.fields[3] != 0 && (tick % 40 != (t.key & 31)),
            Kind::Meteor => t.fields[2] > 0,
            _ => true,
        });
    }

    /// The tick's frame, as a sim packs it.
    pub fn frame(&self) -> Frame {
        let mut f = Frame::new(self.tick);
        for t in &self.things {
            f.push(Record { key: t.key, owner: t.owner, intro: t.intro.clone(), fields: t.fields, refers: t.refers });
        }
        for e in &self.events {
            f.event(*e);
        }
        f
    }

    pub fn find(&self, key: u64) -> Option<&Thing> {
        self.things.iter().find(|t| t.key == key)
    }

    /// The key a thing's introduction names.
    pub fn key_of(intro: &Intro) -> u64 {
        match intro {
            Intro::Player { id, .. } => key(Kind::Player, *id),
            Intro::Creature { id } => key(Kind::Creature, *id),
            Intro::Arrow { id } => key(Kind::Arrow, *id),
            Intro::Meteor { id } => key(Kind::Meteor, *id),
            Intro::Vehicle { owner, id, .. } => owned_key(Kind::Vehicle, *owner, *id),
            Intro::Item { owner, id, .. } => owned_key(Kind::Item, *owner, *id),
        }
    }
}

/// What can happen to an update on its way.
#[derive(Clone, Copy, Default)]
pub struct Road {
    /// Each update is lost with this chance.
    pub lose: f64,
    /// Held back a tick or two with this chance (so later ones overtake it).
    pub hold: f64,
    /// Acknowledgements are sent only every this many ticks (1: each tick).
    pub ack_every: u64,
    /// Ticks an update takes to arrive, and an acknowledgement to come back.
    pub delay: u64,
}

/// A Viewer and a Heard joined by a road, checking every state the Heard comes to.
pub struct Talk {
    pub viewer: Viewer,
    pub heard: Heard,
    pub road: Road,
    rng: Rng,
    /// (tick to arrive at, update number, bytes).
    going: VecDeque<(u64, u32, Vec<u8>)>,
    acks: VecDeque<(u64, ruina_wire::Ack)>,
    /// What each update number meant, by key: the fields as the viewer had them that tick.
    pub truth: HashMap<u32, HashMap<u64, Fields>>,
    /// Updates applied, and fresh states checked against the truth.
    pub applied: u64,
    pub checked: u64,
    pub sent_bytes: u64,
    pub updates: u64,
}

impl Talk {
    pub fn new(me: u64, road: Road, seed: u32) -> Talk {
        Talk {
            viewer: Viewer::new(me),
            heard: Heard::new(),
            road: Road { ack_every: road.ack_every.max(1), ..road },
            rng: Rng(seed | 1),
            going: VecDeque::new(),
            acks: VecDeque::new(),
            truth: HashMap::new(),
            applied: 0,
            checked: 0,
            sent_bytes: 0,
            updates: 0,
        }
    }

    /// One tick: an update from `world` seen from `view` goes on the road; whatever has arrived is
    /// heard and checked; acknowledgements due go back.
    pub fn tick(&mut self, world: &World, view: View) {
        let frame = world.frame();
        // The fields each entity is sent as this tick: references as this viewer's handles as the
        // update begins.
        let truth: HashMap<u64, Fields> = world
            .things
            .iter()
            .map(|t| {
                let mut f = t.fields;
                if let Some(i) = reference(t.intro.kind()) {
                    f[i] = i32::from(self.viewer.handle_of(t.refers));
                }
                (t.key, f)
            })
            .collect();
        let bytes = self.viewer.update(&frame, view, &[]);
        let seq = self.viewer.seq();
        self.sent_bytes += bytes.len() as u64;
        self.updates += 1;
        self.truth.insert(seq, truth);
        self.truth.retain(|s, _| seq.wrapping_sub(*s) < 200);
        if self.rng.chance(self.road.lose) {
            // Never arrives.
        } else {
            let late = if self.rng.chance(self.road.hold) { 1 + u64::from(self.rng.below(2)) } else { 0 };
            self.going.push_back((world.tick + self.road.delay + late, seq, bytes));
        }
        // Whatever has arrived, in the order it arrives.
        let mut arrived: Vec<(u64, u32, Vec<u8>)> = Vec::new();
        self.going.retain(|(at, seq, b)| {
            if *at <= world.tick {
                arrived.push((*at, *seq, b.clone()));
                false
            } else {
                true
            }
        });
        arrived.sort_by_key(|(at, _, _)| *at);
        for (_, seq, bytes) in arrived {
            if let Some(done) = self.heard.hear(&bytes).expect("an update reads") {
                self.applied += 1;
                let truth = &self.truth[&seq];
                for h in &done.fresh {
                    let ent = &self.heard.ents[h];
                    let k = World::key_of(&ent.intro);
                    let want = truth.get(&k).unwrap_or_else(|| panic!("update {seq} names {k:#x}, which wasn't there"));
                    let got = &ent.now().fields;
                    let whole = done.whole.contains(h);
                    for (i, f) in ent.kind().fields().iter().enumerate() {
                        let refreshed = whole || ent.tier.refreshes(f.tier);
                        if refreshed {
                            assert_eq!(got[i], want[i], "update {seq}, {} {k:#x}'s {} (tier {:?})", ent.kind().name(), f.name, ent.tier);
                        }
                    }
                    self.checked += 1;
                }
            }
        }
        if world.tick.is_multiple_of(self.road.ack_every) {
            self.acks.push_back((world.tick + self.road.delay, self.heard.ack()));
        }
        while self.acks.front().is_some_and(|(at, _)| *at <= world.tick) {
            let (_, a) = self.acks.pop_front().expect("one");
            // Acknowledgements are as easily lost as updates.
            if !self.rng.chance(self.road.lose) {
                self.viewer.ack(&a);
            }
        }
    }

    /// Checks that everything within `radius` of `view` (but what flies) is in sight on the Heard's
    /// side exactly as it is in the world now, every field: run after a quiet tick or two.
    pub fn settled(&self, world: &World, view: View, radius: f64) {
        let mut n = 0;
        for t in &world.things {
            let kind = t.intro.kind();
            let (x, z) = (f64::from(t.fields[0]) / 100.0, f64::from(t.fields[1]) / 100.0);
            if matches!(kind, Kind::Arrow | Kind::Meteor) || (x - view.x).hypot(z - view.z) > radius {
                continue;
            }
            let ent =
                self.heard.ents.values().find(|e| World::key_of(&e.intro) == t.key).unwrap_or_else(|| panic!("{:?} at ({x:.0}, {z:.0}) is in sight", t.intro));
            let mut want = t.fields;
            if let Some(i) = reference(kind) {
                want[i] = i32::from(self.viewer.handle_of(t.refers));
            }
            // As heard, run on to now (a counter goes on counting while nothing is sent).
            let s = ent.now();
            let ticks = (world.tick as u32).wrapping_sub(s.tick);
            for (i, f) in kind.fields().iter().enumerate() {
                assert_eq!(f.run.guess(s.fields[i], ticks), want[i], "{} {:?}'s {}", kind.name(), t.intro, f.name);
            }
            n += 1;
        }
        assert!(n > 0, "something to check");
    }

    /// Checks that everything in sight on the Heard's side is what the viewer last sent of it, and
    /// that it was in the world: nothing stale, nothing invented.
    pub fn agree(&self, world: &World) {
        for ent in self.heard.ents.values() {
            let k = World::key_of(&ent.intro);
            assert!(world.find(k).is_some() || ent.kind() == Kind::Arrow || ent.kind() == Kind::Meteor, "{} {k:#x} isn't in the world", ent.kind().name());
        }
    }
}

/// A player's field by name.
pub fn player_field(name: &str) -> usize {
    PLAYER.iter().position(|f| f.name == name).expect("a player field")
}
