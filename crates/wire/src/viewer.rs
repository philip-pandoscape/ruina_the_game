//! One connection's side of the wire, kept by the gate: the handles it has given out, what the
//! browser has acknowledged of each entity, what's on its way, how overdue each entity is, and its
//! byte budget. Each tick the gate calls [`Viewer::update`] with the sim's [`Frame`] and gets the
//! bytes to send; each acknowledgement the browser sends back goes to [`Viewer::ack`].
//!
//! - **Handles.** An entity is a u16 handle on each connection, given the first time it's sent with
//!   an introduction (crate::record::Intro: which of the game's things it is). 0 is nobody and 1 is
//!   the connection's own player. A handle whose entity has gone is said to be gone in every update
//!   until one saying so is acknowledged, and only then given to something else; each giving bumps
//!   a generation, so nothing still on its way for the old entity lands on the new one.
//! - **Deltas.** A record is written against the entity's state in the newest update the browser
//!   acknowledged that held it (its baseline), with the fields that changed in a mask and each
//!   change as a zigzag varint. Frame counters are measured against where they'd have run to
//!   (crate::schema::Run), so a swing in progress costs nothing. An entity that hasn't changed at all
//!   since its baseline, with nothing newer on its way, isn't written. A baseline more than
//!   [`WINDOW`] updates old isn't used: the record goes whole.
//! - **Priority.** Each entity in sight adds its tier's rate to an accumulator every tick and is due
//!   at 1 (crate::interest). Due entities are written nearest tier first, most overdue first, as long
//!   as they fit in the budget; what doesn't fit waits, more overdue, for the next tick. A player's
//!   vehicles go when the player does, so the two are always drawn from the same moment.
//! - **Budget.** A token bucket of [`Budget::bytes_per_second`] (64 KB/s), at most two ticks' worth
//!   in hand. Removals and effects always go; records share what's left.

use std::collections::VecDeque;

use crate::ack::Ack;
use crate::bytes::{put_u16, put_u32, put_varint, zigzag, zigzag32};
use crate::fast::FxMap;
use crate::interest::{EVENTS_CAP, EVENTS_WITHIN, KEEP, KEEP_MARGIN, TOLD_CAP, Tiers, every, rate, reach};
use crate::record::{CELL, Cell, Event, Frame, Intro, Record};
use crate::schema::{EVENT, Fields, Kind, MAX_FIELDS, Tier, reference};

/// The first byte of an update.
pub const UPDATE: u8 = 1;
/// The most updates back a baseline may be (six bits of the record's base byte): 3.15 s at 20 a second.
pub const WINDOW: u32 = 63;
/// Handle 0 is nobody; handle 1 is the connection's own player.
pub const NOBODY: u16 = 0;
pub const YOU: u16 = 1;
const FIRST_HANDLE: u32 = 2;
/// Due records that didn't fit, one after another, before the rest wait unwritten.
const MISFITS: usize = 32;

/// How many bytes a connection may be sent.
#[derive(Clone, Copy, Debug)]
pub struct Budget {
    pub bytes_per_second: f64,
    pub ticks_per_second: f64,
    /// The most a connection may save up, in ticks' worth.
    pub burst_ticks: f64,
}

impl Default for Budget {
    fn default() -> Self {
        Budget { bytes_per_second: 64.0 * 1024.0, ticks_per_second: 20.0, burst_ticks: 2.0 }
    }
}

impl Budget {
    fn per_tick(&self) -> f64 {
        self.bytes_per_second / self.ticks_per_second
    }
}

/// Where the connection's player is (metres), which decides what's near.
#[derive(Clone, Copy, Debug, Default)]
pub struct View {
    pub x: f64,
    pub z: f64,
}

/// What the browser has of an entity as of an update it acknowledged.
#[derive(Clone, Copy, Debug)]
struct Base {
    seq: u32,
    tick: u32,
    fields: Fields,
}

#[derive(Clone, Debug)]
struct Slot {
    generation: u32,
    /// In sight: given to an entity that hasn't gone.
    live: bool,
    /// Gone, and said so in updates from this one on until one of them is acknowledged.
    dying: bool,
    key: u64,
    base: Option<Base>,
    /// An update with its introduction was acknowledged.
    introduced: bool,
    acc: f32,
    /// The last update it was in sight for.
    seen: u32,
    /// The last update it was written in.
    sent: u32,
}

impl Slot {
    fn new() -> Slot {
        Slot { generation: 0, live: false, dying: false, key: 0, base: None, introduced: false, acc: 0.0, seen: 0, sent: 0 }
    }
}

/// An update on its way: what each entity in it will be once it lands, and the introductions and
/// removals it carries.
struct Flight {
    seq: u32,
    tick: u32,
    /// (handle, generation, where its fields start in `values`, how many).
    entries: Vec<(u16, u32, u32, u8)>,
    values: Vec<i32>,
    intros: Vec<(u16, u32)>,
    removals: Vec<(u16, u32)>,
}

/// Counts for the admins' numbers and the benches.
#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    /// The last update: its size, and how many records, introductions, removals and effects it held.
    pub bytes: usize,
    pub records: usize,
    pub intros: usize,
    pub removals: usize,
    pub events: usize,
    /// Entities due that waited for lack of budget.
    pub waited: usize,
    /// Entities in sight now.
    pub in_sight: usize,
    /// Every update's bytes, added up.
    pub total_bytes: u64,
}

/// One connection's state on the server's side of the wire.
pub struct Viewer {
    /// The connection's own player's key: never sent to it (its own state comes on its own).
    me: u64,
    seq: u32,
    tokens: f64,
    pub budget: Budget,
    by_key: FxMap<u64, u16>,
    slots: Vec<Slot>,
    free: VecDeque<u16>,
    /// Handles said to be gone and not yet acknowledged as gone.
    dying: Vec<u16>,
    flights: VecDeque<Flight>,
    pub stats: Stats,
    /// Kept from one update to the next, so a tick allocates nothing once they've grown.
    cands: Vec<Cand>,
    judge: Vec<(f64, Kind, bool)>,
    tier_of: Vec<Option<Tier>>,
    tiers: Tiers,
}

/// An entity this update might write: where its record is in the frame, and what's known of it.
#[derive(Clone, Copy)]
struct Cand {
    cell: u32,
    rec: u32,
    d2: f64,
    kind: Kind,
    handle: u16,
    /// The handle of the entity its reference field names, as things stood when the update began
    /// (nobody if it had none then).
    refers: u16,
    tier: Option<Tier>,
    due: bool,
    /// How overdue it is, for the order it's written in (a newcomer counts as a tick overdue).
    acc: f32,
}

impl Viewer {
    /// A fresh connection for the player whose key is `me` (0 for nobody: a spectator).
    pub fn new(me: u64) -> Viewer {
        let budget = Budget::default();
        Viewer {
            me,
            seq: 0,
            tokens: budget.per_tick() * budget.burst_ticks,
            budget,
            by_key: FxMap::default(),
            slots: vec![Slot::new(); FIRST_HANDLE as usize],
            free: VecDeque::new(),
            dying: Vec::new(),
            flights: VecDeque::new(),
            stats: Stats::default(),
            cands: Vec::new(),
            judge: Vec::new(),
            tier_of: Vec::new(),
            tiers: Tiers::default(),
        }
    }

    /// The last update's number.
    pub fn seq(&self) -> u32 {
        self.seq
    }

    /// Updates sent and not yet acknowledged or lost.
    pub fn in_flight(&self) -> usize {
        self.flights.len()
    }

    /// The handle an entity has on this connection (0 if it has none).
    pub fn handle_of(&self, key: u64) -> u16 {
        if key == 0 {
            NOBODY
        } else if key == self.me {
            YOU
        } else {
            self.by_key.get(&key).copied().unwrap_or(NOBODY)
        }
    }

    /// Forgets everything sent: the browser starts over too (its player went to another space).
    pub fn reset(&mut self) {
        let me = self.me;
        let (seq, budget, total) = (self.seq, self.budget, self.stats.total_bytes);
        *self = Viewer::new(me);
        // Updates go on counting, so an acknowledgement from before can't be mistaken for a new one.
        self.seq = seq;
        self.budget = budget;
        self.stats.total_bytes = total;
    }

    /// Whether a record is the connection's own (its player, its vehicles and packs), which its own
    /// state carries instead. Its arrows are sent: the browser takes over its own guess with them.
    fn own(&self, r: &Record) -> bool {
        self.me != 0 && (r.key == self.me || (r.owner == self.me && matches!(r.kind(), Kind::Vehicle | Kind::Item)))
    }

    /// The next update for this connection: the world as `frame` has it, seen from `view`, within
    /// its budget, and `told`, what happened to its own player. A record's reference names the
    /// handle its entity had as the update began ([`Viewer::handle_of`] just before), nobody if none.
    pub fn update(&mut self, frame: &Frame, view: View, told: &[Event]) -> Vec<u8> {
        self.seq = self.seq.wrapping_add(1);
        let seq = self.seq;
        let tick = frame.tick as u32;
        let per_tick = self.budget.per_tick();
        self.tokens = (self.tokens + per_tick).min(per_tick * self.budget.burst_ticks);
        // Updates too old to be acknowledged now were lost.
        while self.flights.front().is_some_and(|f| seq.wrapping_sub(f.seq) > WINDOW) {
            self.flights.pop_front();
        }

        self.gather(frame, view);
        self.choose(frame, seq);

        // Gone: whatever was in sight and no longer is.
        let mut gone: Vec<u16> = self.by_key.values().copied().filter(|&h| self.slots[usize::from(h)].seen != seq).collect();
        // In handle order, not the map's: the same game writes the same bytes.
        gone.sort_unstable();
        for h in gone {
            let s = &mut self.slots[usize::from(h)];
            self.by_key.remove(&s.key);
            s.live = false;
            s.dying = true;
            self.dying.push(h);
        }

        let mut flight = Flight { seq, tick, entries: Vec::new(), values: Vec::new(), intros: Vec::new(), removals: Vec::new() };
        let mut removals = Vec::new();
        for &h in &self.dying {
            put_u16(&mut removals, h);
            flight.removals.push((h, self.slots[usize::from(h)].generation));
        }
        let (events, n_events) = events_near(frame, view, told);

        // What's left for records once the header, the removals and the effects are paid for.
        let fixed = 9 + 4 * 3 + removals.len() + events.len();
        let mut left = self.tokens - fixed as f64;
        let mut intros = Vec::new();
        let mut records = Vec::new();
        let (mut n_intros, mut n_records, mut waited) = (0usize, 0usize, 0usize);
        let mut entry = Vec::with_capacity(64);
        let mut intro = Vec::with_capacity(32);
        // Records that didn't fit, one after another: past a few dozen, the rest wait without being
        // written out to see.
        let mut misfits = 0;
        let cands = std::mem::take(&mut self.cands);
        for c in cands.iter().filter(|c| c.due) {
            // Nothing can be written in fewer than four bytes.
            if left < 4.0 || misfits >= MISFITS {
                waited += 1;
                continue;
            }
            let r = &frame.cells()[c.cell as usize].records[c.rec as usize];
            let fresh = c.handle == NOBODY;
            let h = if fresh {
                match self.give(r.key) {
                    Some(h) => h,
                    None => continue,
                }
            } else {
                c.handle
            };
            let tier = c.tier.unwrap_or(Tier::Far);
            entry.clear();
            intro.clear();
            let Some(sent) = self.write_record(h, c, r, tier, seq, tick, &mut entry) else {
                // Nothing about it changed: nothing to send.
                self.slots[usize::from(h)].acc = 0.0;
                continue;
            };
            let introducing = !self.slots[usize::from(h)].introduced;
            if introducing {
                write_intro(h, &r.intro, &mut intro);
            }
            let size = (entry.len() + intro.len()) as f64;
            if size > left {
                waited += 1;
                misfits += 1;
                if fresh {
                    self.take_back(h);
                }
                continue;
            }
            misfits = 0;
            left -= size;
            records.extend_from_slice(&entry);
            n_records += 1;
            let s = &mut self.slots[usize::from(h)];
            if introducing {
                intros.extend_from_slice(&intro);
                n_intros += 1;
                flight.intros.push((h, s.generation));
            }
            let n = c.kind.fields().len();
            flight.entries.push((h, s.generation, flight.values.len() as u32, n as u8));
            flight.values.extend_from_slice(&sent[..n]);
            s.acc = 0.0;
            s.sent = seq;
        }
        self.cands = cands;

        let mut out = Vec::with_capacity(fixed + intros.len() + records.len());
        out.push(UPDATE);
        put_u32(&mut out, seq);
        put_u32(&mut out, tick);
        put_varint(&mut out, flight.removals.len() as u64);
        out.extend_from_slice(&removals);
        put_varint(&mut out, n_intros as u64);
        out.extend_from_slice(&intros);
        put_varint(&mut out, n_records as u64);
        out.extend_from_slice(&records);
        put_varint(&mut out, n_events as u64);
        out.extend_from_slice(&events);

        self.tokens -= out.len() as f64;
        self.stats = Stats {
            bytes: out.len(),
            records: n_records,
            intros: n_intros,
            removals: flight.removals.len(),
            events: n_events,
            waited,
            in_sight: self.by_key.len(),
            total_bytes: self.stats.total_bytes + out.len() as u64,
        };
        self.flights.push_back(flight);
        out
    }

    /// Everything within reach of `view` in the frame, but the connection's own, into `cands`.
    fn gather(&mut self, frame: &Frame, view: View) {
        let mut cands = std::mem::take(&mut self.cands);
        cands.clear();
        let reach_cells = (KEEP / CELL).ceil() as i32;
        let centre = Cell::at(view.x, view.z);
        for cz in centre.z - reach_cells..=centre.z + reach_cells {
            for cx in centre.x - reach_cells..=centre.x + reach_cells {
                let Some(ci) = frame.cell_index(Cell { x: cx, z: cz }) else { continue };
                for (ri, r) in frame.cells()[ci].records.iter().enumerate() {
                    if self.own(r) {
                        continue;
                    }
                    let (x, z) = r.at();
                    let d2 = (x - view.x) * (x - view.x) + (z - view.z) * (z - view.z);
                    if d2 > KEEP * KEEP {
                        continue;
                    }
                    let handle = self.by_key.get(&r.key).copied().unwrap_or(NOBODY);
                    let refers = if r.refers == 0 { NOBODY } else { self.handle_of(r.refers) };
                    cands.push(Cand { cell: ci as u32, rec: ri as u32, d2, kind: r.kind(), handle, refers, tier: None, due: false, acc: 0.0 });
                }
            }
        }
        self.cands = cands;
    }

    /// Each candidate's tier, what's in sight now, and what's due, in the order to write it.
    fn choose(&mut self, frame: &Frame, seq: u32) {
        let Viewer { cands, judge, tier_of, tiers, slots, .. } = self;
        judge.clear();
        judge.extend(cands.iter().map(|c| (c.d2, c.kind, c.handle != NOBODY)));
        tiers.sort(judge, tier_of);
        // In sight: in a tier, or in sight already and not yet past the edge (kept, not refreshed).
        let mut vehicles = false;
        for (c, t) in cands.iter_mut().zip(tier_of.iter()) {
            c.tier = *t;
            let d = c.d2.sqrt();
            let r = reach(c.kind);
            if c.handle != NOBODY && (c.tier.is_some() || (d > r && d <= r + KEEP_MARGIN)) {
                slots[usize::from(c.handle)].seen = seq;
            }
            let Some(t) = c.tier else { continue };
            if c.handle == NOBODY {
                c.due = true;
                c.acc = 1.0 + rate(t);
            } else {
                let s = &mut slots[usize::from(c.handle)];
                s.acc += rate(t);
                c.due = s.acc >= 1.0 || !s.introduced;
                c.acc = s.acc;
            }
            vehicles |= c.kind == Kind::Vehicle;
        }
        // A player's vehicles go when the player does, so both are drawn from the same moment; one
        // whose owner isn't in sight goes on its own.
        if vehicles {
            let record = |c: &Cand| &frame.cells()[c.cell as usize].records[c.rec as usize];
            let owners: Vec<u64> = cands.iter().filter(|c| c.tier.is_some() && c.kind == Kind::Vehicle).map(|c| record(c).owner).collect();
            let owners_due: Vec<(u64, bool)> = cands
                .iter()
                .filter(|c| c.tier.is_some() && c.kind == Kind::Player)
                .map(|c| (record(c).key, c.due))
                .filter(|(k, _)| owners.contains(k))
                .collect();
            for c in cands.iter_mut().filter(|c| c.tier.is_some() && c.kind == Kind::Vehicle) {
                let owner = record(c).owner;
                if let Some(&(_, due)) = owners_due.iter().find(|(k, _)| *k == owner) {
                    c.due = due || (c.handle != NOBODY && !slots[usize::from(c.handle)].introduced);
                }
            }
        }
        // Nearest tier first; then the most overdue; then the nearest.
        cands.retain(|c| c.due);
        cands.sort_by(|a, b| a.tier.cmp(&b.tier).then(b.acc.total_cmp(&a.acc)).then(a.d2.total_cmp(&b.d2)));
    }

    /// A handle for an entity coming into sight: one never given before while there are any, else
    /// the one freed longest ago.
    fn give(&mut self, key: u64) -> Option<u16> {
        let h = if self.slots.len() <= usize::from(u16::MAX) {
            self.slots.push(Slot::new());
            (self.slots.len() - 1) as u16
        } else {
            self.free.pop_front()?
        };
        let s = &mut self.slots[usize::from(h)];
        s.generation = s.generation.wrapping_add(1);
        s.live = true;
        s.dying = false;
        s.key = key;
        s.base = None;
        s.introduced = false;
        s.acc = 0.0;
        s.seen = self.seq;
        s.sent = 0;
        self.by_key.insert(key, h);
        Some(h)
    }

    /// A handle given this update to something that then didn't fit: back where it came from.
    fn take_back(&mut self, h: u16) {
        let s = &mut self.slots[usize::from(h)];
        self.by_key.remove(&s.key);
        s.live = false;
        s.key = 0;
        if usize::from(h) == self.slots.len() - 1 {
            self.slots.pop();
        } else {
            self.free.push_front(h);
        }
    }

    /// Writes one record into `out`: its handle, its base byte (tier and how many updates back its
    /// baseline is, 0 for none), the mask of what changed and the changes. Returns the fields as the
    /// browser will have them, or None if nothing changed and nothing is running.
    #[allow(clippy::too_many_arguments)]
    fn write_record(&self, h: u16, c: &Cand, r: &Record, tier: Tier, seq: u32, tick: u32, out: &mut Vec<u8>) -> Option<Fields> {
        let kind = c.kind;
        let schema = kind.fields();
        let mut now = r.fields;
        if let Some(i) = reference(kind) {
            now[i] = i32::from(c.refers);
        }
        let slot = &self.slots[usize::from(h)];
        let base = slot.base.filter(|b| slot.introduced && seq.wrapping_sub(b.seq) <= WINDOW);
        let mut mask = 0u64;
        let mut deltas = [0i32; MAX_FIELDS];
        let mut sent = now;
        let offset = match base {
            None => {
                // Whole, against zeros, every field whatever the tier.
                for (i, v) in now[..schema.len()].iter().enumerate() {
                    if *v != 0 {
                        mask |= 1 << i;
                        deltas[i] = *v;
                    }
                }
                0
            }
            Some(b) => {
                let ticks = tick.wrapping_sub(b.tick);
                for (i, f) in schema.iter().enumerate() {
                    if !tier.refreshes(f.tier) {
                        sent[i] = b.fields[i];
                        continue;
                    }
                    let guess = f.run.guess(b.fields[i], ticks);
                    if now[i] != guess {
                        mask |= 1 << i;
                        deltas[i] = now[i].wrapping_sub(guess);
                    }
                }
                // Nothing changed but what ran on as guessed (which the browser runs on by itself),
                // and nothing newer than the baseline is on its way (which the browser might have
                // applied, and would keep).
                if mask == 0 && slot.sent == b.seq {
                    return None;
                }
                seq.wrapping_sub(b.seq) as u8
            }
        };
        put_u16(out, h);
        out.push((tier as u8) << 6 | offset);
        put_varint(out, mask);
        for (i, d) in deltas.iter().enumerate().take(schema.len()) {
            if mask & (1 << i) != 0 {
                put_varint(out, u64::from(zigzag32(*d)));
            }
        }
        Some(sent)
    }

    /// The browser acknowledged updates: the newest it applied, and which of the 32 before it too.
    /// Each entity in one becomes its baseline (if newer), each introduction is done with, and each
    /// handle said to be gone in one is free. Updates before the newest that it didn't apply were lost.
    pub fn ack(&mut self, a: &Ack) {
        while let Some(f) = self.flights.front() {
            let back = a.seq.wrapping_sub(f.seq);
            // Newer than what's acknowledged (or from before a reset): still on its way.
            if back > WINDOW + 1 {
                if f.seq.wrapping_sub(a.seq) <= WINDOW + 1 {
                    break;
                }
                self.flights.pop_front();
                continue;
            }
            let f = self.flights.pop_front().expect("the front");
            if back == 0 || (back <= 32 && a.bits & (1 << (back - 1)) != 0) {
                self.landed(&f);
            }
        }
    }

    /// The transport dropped update `seq` before it went (the gate's queue for the connection was
    /// full): it never reaches the browser.
    pub fn lost(&mut self, seq: u32) {
        self.flights.retain(|f| f.seq != seq);
    }

    fn landed(&mut self, f: &Flight) {
        for &(h, generation, at, n) in &f.entries {
            let s = &mut self.slots[usize::from(h)];
            if s.generation != generation || !s.live || s.base.is_some_and(|b| b.seq.wrapping_sub(f.seq) < 1 << 31) {
                continue;
            }
            let mut fields = [0; MAX_FIELDS];
            fields[..usize::from(n)].copy_from_slice(&f.values[at as usize..at as usize + usize::from(n)]);
            s.base = Some(Base { seq: f.seq, tick: f.tick, fields });
        }
        for &(h, generation) in &f.intros {
            let s = &mut self.slots[usize::from(h)];
            if s.generation == generation {
                s.introduced = true;
            }
        }
        for &(h, generation) in &f.removals {
            let s = &mut self.slots[usize::from(h)];
            if s.generation == generation && s.dying {
                s.dying = false;
                s.key = 0;
                s.base = None;
                self.free.push_back(h);
                self.dying.retain(|&d| d != h);
            }
        }
    }
}

/// Effects near `view` (the nearest, to the cap) and those told to the player, as an update's last
/// section: each against zeros.
fn events_near(frame: &Frame, view: View, told: &[Event]) -> (Vec<u8>, usize) {
    let mut near: Vec<(f64, &Event)> = Vec::new();
    let reach = (EVENTS_WITHIN / CELL).ceil() as i32;
    let centre = Cell::at(view.x, view.z);
    for cz in centre.z - reach..=centre.z + reach {
        for cx in centre.x - reach..=centre.x + reach {
            let Some(cell) = frame.cell(Cell { x: cx, z: cz }) else { continue };
            for e in &cell.events {
                let (x, z) = e.at();
                let d2 = (x - view.x) * (x - view.x) + (z - view.z) * (z - view.z);
                if d2 <= EVENTS_WITHIN * EVENTS_WITHIN {
                    near.push((d2, e));
                }
            }
        }
    }
    if near.len() > EVENTS_CAP {
        near.select_nth_unstable_by(EVENTS_CAP, |a, b| a.0.total_cmp(&b.0));
        near.truncate(EVENTS_CAP);
    }
    let mut out = Vec::new();
    let list: Vec<&Event> = near.into_iter().map(|(_, e)| e).chain(told.iter().take(TOLD_CAP)).collect();
    for e in &list {
        let f = e.as_fields();
        let mut mask = 0u64;
        for (i, v) in f.iter().enumerate().take(EVENT.len()) {
            if *v != 0 {
                mask |= 1 << i;
            }
        }
        put_varint(&mut out, mask);
        for (i, v) in f.iter().enumerate().take(EVENT.len()) {
            if mask & (1 << i) != 0 {
                put_varint(&mut out, u64::from(zigzag32(*v)));
            }
        }
    }
    (out, list.len())
}

/// An introduction: the handle, the kind's byte, then what the kind says of itself.
fn write_intro(h: u16, intro: &Intro, out: &mut Vec<u8>) {
    put_u16(out, h);
    out.push(intro.kind() as u8);
    match intro {
        Intro::Player { id, name, bot } => {
            put_varint(out, zigzag(*id));
            out.push(u8::from(*bot));
            let name = name.as_bytes();
            let name = &name[..name.len().min(255)];
            put_varint(out, name.len() as u64);
            out.extend_from_slice(name);
        }
        Intro::Creature { id } | Intro::Arrow { id } | Intro::Meteor { id } => put_varint(out, zigzag(*id)),
        Intro::Vehicle { owner, id, def } | Intro::Item { owner, id, def } => {
            put_varint(out, zigzag(*owner));
            put_varint(out, zigzag(*id));
            put_varint(out, u64::from(*def));
        }
    }
}

/// How many ticks apart a tier's refreshes come (for whoever draws what's heard).
pub fn ticks_between(t: Tier) -> u32 {
    every(t)
}
