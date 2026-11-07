//! The browser's side, in Rust: the world as a connection has heard it, built from its updates in
//! order, with the acknowledgement to send back. src/net/wire/heard.ts is the one the browser runs;
//! this one is for the tests (a Viewer and a Heard talking, with updates lost and shuffled on the way)
//! and the benches, and the golden fixtures hold the two to the same answers.
//!
//! An update is applied whole or not at all: one older than the newest applied is stale and dropped
//! (never acknowledged, so the server counts it lost); one that names a baseline this side doesn't
//! have is a broken one, dropped the same way and counted in `errors` (the server can't send one).

use std::collections::{HashMap, VecDeque};

use crate::ack::Ack;
use crate::bytes::{Bad, Reader};
use crate::decode::{Update, read};
use crate::record::Intro;
use crate::schema::{Fields, Kind, MAX_FIELDS};
use crate::viewer::WINDOW;

/// An entity's state as of an update that held it.
#[derive(Clone, Debug, PartialEq)]
pub struct State {
    pub seq: u32,
    pub tick: u32,
    pub fields: Fields,
}

/// Something in sight, by its handle.
#[derive(Clone, Debug)]
pub struct Ent {
    pub intro: Intro,
    pub tier: crate::schema::Tier,
    /// Its states from the oldest the server may still measure against to the newest.
    pub states: VecDeque<State>,
}

impl Ent {
    pub fn kind(&self) -> Kind {
        self.intro.kind()
    }

    /// Its newest state.
    pub fn now(&self) -> &State {
        self.states.back().expect("an entity in sight has a state")
    }
}

/// What applying an update did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Applied {
    pub seq: u32,
    pub tick: u32,
    pub removed: Vec<u16>,
    pub introduced: Vec<u16>,
    /// Handles with a fresh state from this update.
    pub fresh: Vec<u16>,
    /// Of those, the ones sent whole (against zeros: every field, whatever the tier).
    pub whole: Vec<u16>,
    pub events: Vec<[i32; 5]>,
}

#[derive(Default)]
pub struct Heard {
    pub ents: HashMap<u16, Ent>,
    ack: Ack,
    /// Updates that couldn't be applied: a baseline this side doesn't have. Always 0 when both sides
    /// keep to the protocol.
    pub errors: u32,
    /// Updates dropped as older than the newest applied.
    pub stale: u32,
}

impl Heard {
    pub fn new() -> Heard {
        Heard::default()
    }

    /// What to send back now.
    pub fn ack(&self) -> Ack {
        self.ack
    }

    /// Forgets everything heard (the server forgets what it sent at the same moment).
    pub fn reset(&mut self) {
        self.ents.clear();
    }

    /// Reads and applies an update. Ok(None): stale or broken, dropped and not acknowledged.
    pub fn hear(&mut self, bytes: &[u8]) -> Result<Option<Applied>, Bad> {
        // Stale before anything else is read: it may name handles since given up.
        let mut head = Reader::new(bytes);
        head.u8()?;
        if self.is_stale(head.u32()?) {
            self.stale += 1;
            return Ok(None);
        }
        let u = read(bytes, |h| self.ents.get(&h).map(Ent::kind))?;
        Ok(self.apply(&u))
    }

    /// Whether update `seq` is no newer than the newest applied.
    fn is_stale(&self, seq: u32) -> bool {
        self.ack.seq != 0 && seq.wrapping_sub(self.ack.seq).wrapping_sub(1) >= 1 << 31
    }

    pub fn apply(&mut self, u: &Update) -> Option<Applied> {
        if self.is_stale(u.seq) {
            self.stale += 1;
            return None;
        }
        // Worked out first, so a broken update changes nothing.
        let mut states: Vec<(u16, State, Option<u32>)> = Vec::with_capacity(u.records.len());
        for e in &u.records {
            let kind = match u.intros.iter().rev().find(|(h, _)| *h == e.handle) {
                Some((_, i)) => i.kind(),
                None if u.removals.contains(&e.handle) => {
                    self.errors += 1;
                    return None;
                }
                None => match self.ents.get(&e.handle) {
                    Some(ent) => ent.kind(),
                    None => {
                        self.errors += 1;
                        return None;
                    }
                },
            };
            let schema = kind.fields();
            let mut fields = [0; MAX_FIELDS];
            // Whole, which says nothing of what the server may measure against next (it may be an
            // update before this one, sent whole too and acknowledged first); or against a baseline.
            let base_seq = if e.back == 0 {
                fields[..schema.len()].copy_from_slice(&e.deltas[..schema.len()]);
                None
            } else {
                let want = u.seq.wrapping_sub(u32::from(e.back));
                let Some(base) = self.ents.get(&e.handle).and_then(|ent| ent.states.iter().find(|s| s.seq == want)) else {
                    self.errors += 1;
                    return None;
                };
                let ticks = u.tick.wrapping_sub(base.tick);
                for (i, f) in schema.iter().enumerate() {
                    fields[i] = if e.tier.refreshes(f.tier) { f.run.guess(base.fields[i], ticks).wrapping_add(e.deltas[i]) } else { base.fields[i] };
                }
                Some(want)
            };
            states.push((e.handle, State { seq: u.seq, tick: u.tick, fields }, base_seq));
        }

        let mut done = Applied { seq: u.seq, tick: u.tick, events: u.events.clone(), ..Applied::default() };
        for h in &u.removals {
            if self.ents.remove(h).is_some() {
                done.removed.push(*h);
            }
        }
        for (h, intro) in &u.intros {
            // Introduced again (the server says it until an introduction is acknowledged): the same
            // entity, whose states it may yet measure against. A handle is only given to something
            // else once its removal has been applied here, so one held already is this one.
            if self.ents.get(h).is_some_and(|e| e.intro == *intro) {
                continue;
            }
            self.ents.insert(*h, Ent { intro: intro.clone(), tier: crate::schema::Tier::Near, states: VecDeque::new() });
            done.introduced.push(*h);
        }
        for ((h, state, base_seq), e) in states.into_iter().zip(&u.records) {
            let Some(ent) = self.ents.get_mut(&h) else { continue };
            ent.tier = e.tier;
            // What the server may still measure against from now on: this baseline and what's newer
            // (its baselines only move on), within the window.
            while ent.states.front().is_some_and(|s| base_seq.is_some_and(|b| s.seq.wrapping_sub(b) >= 1 << 31) || u.seq.wrapping_sub(s.seq) > WINDOW) {
                ent.states.pop_front();
            }
            ent.states.push_back(state);
            done.fresh.push(h);
            if e.back == 0 {
                done.whole.push(h);
            }
        }
        self.ack = self.ack.after(u.seq);
        Some(done)
    }
}
