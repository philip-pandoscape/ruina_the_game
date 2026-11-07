//! One simulation of a world split between several: what it owns (its players, their lives and
//! bots, its creatures), the ghosts of what its neighbours own near its chunks, and its side of a
//! handoff. [`super::split::Split`] steps several of these in lockstep.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use super::messages::{GhostCreature, GhostPlayer, Ghosts, Handoff, Input, Inputs, Moving, Post, Says, Taken};
use super::{BAND, Epoch, Owners, SimId};
use crate::actors::Actors;
use crate::bots::{Bot, FoeSeen};
use crate::combat::{MAX_PLAYERS, Players};
use crate::ids::EntityId;
use crate::open::OpenWorld;
use crate::player::{Actions, Mode};
use crate::world::World;

/// A handoff sent and not yet taken: to whom, and what was sent (sent again until it's taken).
pub struct Leaving {
    pub to: SimId,
    pub handoff: Handoff,
}

/// One simulation's part of a world.
pub struct Sim {
    pub id: SimId,
    pub world: OpenWorld,
    /// The flat arena [`Players::work_out`] is handed (unused in an open world).
    pub flat: World,
    pub players: Players,
    pub actors: Actors,
    /// The brains that fill its bots' inputs, by their players' slots (they go with their players).
    pub bots: BTreeMap<usize, Bot>,
    /// The epoch each player it owns or sees is held under, by slot.
    pub epochs: BTreeMap<usize, Epoch>,
    /// Every player it owns or sees, by client.
    pub clients: BTreeMap<EntityId, usize>,
    /// Whose each ghost here is: players by slot, creatures by id.
    pub ghost_of: BTreeMap<usize, SimId>,
    pub creature_of: BTreeMap<u32, SimId>,
    /// Handoffs sent and not yet taken, by the first slot of each.
    pub leaving: BTreeMap<usize, Leaving>,
    /// What each neighbour has been shown (players by slot, creatures by id): their history goes
    /// the first time, and those no longer near are said to be gone.
    shown: BTreeMap<SimId, (BTreeSet<usize>, BTreeSet<u32>)>,
    /// The last input queued for each of its players, so one that comes twice is run once.
    queued: BTreeMap<EntityId, u32>,
    /// What everyone it owns or sees looked like as each of the last ticks began, in the order of
    /// their slots, for its bots: (slot, character, team, as seen).
    pub looked: VecDeque<Vec<(usize, i64, u8, FoeSeen)>>,
}

impl Sim {
    pub fn new(id: SimId, world: OpenWorld, flat: World, players: Players, actors: Actors) -> Sim {
        Sim {
            id,
            world,
            flat,
            players,
            actors,
            bots: BTreeMap::new(),
            epochs: BTreeMap::new(),
            clients: BTreeMap::new(),
            ghost_of: BTreeMap::new(),
            creature_of: BTreeMap::new(),
            leaving: BTreeMap::new(),
            shown: BTreeMap::new(),
            queued: BTreeMap::new(),
            looked: VecDeque::new(),
        }
    }

    /// Whom this simulation thinks owns the player in `slot`: itself, or the one it sees them from.
    pub fn owner_of(&self, slot: usize) -> Option<SimId> {
        if self.players.is_own(slot) {
            return Some(self.id);
        }
        self.ghost_of.get(&slot).copied()
    }

    /// Its own players, by slot: (slot, client).
    pub fn own(&self) -> Vec<(usize, EntityId)> {
        let mut v: Vec<(usize, EntityId)> = self.players.each_open().filter_map(|(c, _, _, _)| Some((self.players.slot_index(c)?, c))).collect();
        v.sort();
        v
    }

    // ---------- Ghosts ----------

    /// Ghosts of what this simulation owns near `to`'s chunks, as they stand: its players (with their
    /// vehicles) if `players`, its creatures if `creatures`. Whatever `to` sees for the first time
    /// comes with its history; whatever it no longer sees is gone.
    pub fn ghosts_for(&mut self, to: SimId, owners: &Owners, players: bool, creatures: bool) -> Ghosts {
        let mut g = Ghosts::default();
        let shown = self.shown.entry(to).or_default();
        if players {
            let mut now = BTreeSet::new();
            for (client, owner, p, life) in self.players.each_open() {
                let Some(slot) = self.players.slot_index(client) else { continue };
                let vehicles = life.map(|l| l.state.vehicles.clone()).unwrap_or_default();
                let near = owners.within(to, p.pos.x, p.pos.z, BAND) || vehicles.iter().any(|v| owners.within(to, v.x, v.z, BAND));
                if !near {
                    continue;
                }
                now.insert(slot);
                let history = (!shown.0.contains(&slot)).then(|| self.players.history(slot));
                let epoch = self.epochs.get(&slot).copied().unwrap_or_default();
                g.players.push(GhostPlayer { slot, client, owner, epoch, player: p.clone(), vehicles, history });
            }
            g.gone = shown.0.difference(&now).copied().collect();
            shown.0 = now;
        }
        if creatures {
            let mut now = BTreeSet::new();
            for a in &self.actors.list {
                if !owners.within(to, a.x, a.z, BAND) {
                    continue;
                }
                now.insert(a.id);
                let history = (!shown.1.contains(&a.id)).then(|| self.players.creature_history(a.id));
                g.creatures.push(GhostCreature::of(a, history));
            }
            g.gone_creatures = shown.1.difference(&now).copied().collect();
            shown.1 = now;
        }
        g
    }

    /// Ghosts from `from`, taken in: each player in their slot (unless it's this simulation's own,
    /// or what's said is under an older epoch than it knows), each creature among its ghosts, each
    /// with the history it came with; those gone, forgotten.
    pub fn take_ghosts(&mut self, from: SimId, g: Ghosts) {
        for gp in g.players {
            let known = self.epochs.get(&gp.slot).copied().unwrap_or_default();
            if self.players.is_own(gp.slot) || gp.epoch < known {
                continue;
            }
            self.epochs.insert(gp.slot, gp.epoch);
            self.ghost_of.insert(gp.slot, from);
            self.clients.insert(gp.client, gp.slot);
            self.players.ghost(gp.slot, gp.client, gp.owner, gp.player, gp.vehicles);
            if let Some(h) = gp.history {
                self.players.set_history(gp.slot, &h);
            }
        }
        for slot in g.gone {
            if self.ghost_of.get(&slot) == Some(&from) && self.players.unghost(slot) {
                self.ghost_of.remove(&slot);
                self.clients.retain(|_, s| *s != slot);
            }
        }
        for gc in g.creatures {
            self.creature_of.insert(gc.id, from);
            if let Some(h) = &gc.history {
                self.players.set_creature_history(gc.id, h);
            }
            let a = gc.actor();
            match self.actors.ghosts.iter_mut().find(|o| o.id == a.id) {
                Some(o) => *o = a,
                None => self.actors.ghosts.push(a),
            }
        }
        for id in g.gone_creatures {
            if self.creature_of.get(&id) == Some(&from) {
                self.creature_of.remove(&id);
                self.actors.ghosts.retain(|a| a.id != id);
            }
        }
    }

    // ---------- Bots ----------

    /// What everyone it owns or sees looks like as the tick begins, kept for its bots, who see the
    /// others `lag` ticks late.
    pub fn look(&mut self, lag: f64) {
        let mut seen = Vec::new();
        for slot in 0..MAX_PLAYERS {
            if let Some(p) = self.players.player(slot) {
                let owner = self.players.owner_of_slot(slot).unwrap_or(0);
                seen.push((slot, owner, p.team, FoeSeen { x: p.pos.x, z: p.pos.z, hp: if p.down_frame >= 0 { 0.0 } else { p.hp } }));
            }
        }
        self.looked.push_back(seen);
        while self.looked.len() > lag.ceil() as usize + 1 {
            self.looked.pop_front();
        }
    }

    /// What each of its bots presses this tick, by slot: each sees itself as it is and everyone
    /// else as the oldest look kept.
    pub fn think(&mut self) -> Vec<(usize, Actions)> {
        let Some(everyone) = self.looked.front() else { return Vec::new() };
        let mut out = Vec::new();
        for (&slot, bot) in self.bots.iter_mut() {
            let Some(me) = self.players.player(slot).filter(|_| self.players.is_own(slot)) else { continue };
            let mine = self.players.owner_of_slot(slot).unwrap_or(0);
            let foes: Vec<FoeSeen> = everyone.iter().filter(|(_, o, team, _)| *o != mine && *team != me.team).map(|e| e.3).collect();
            out.push((slot, bot.think(me, &foes)));
        }
        out
    }

    // ---------- Inputs ----------

    /// Inputs for `client`: queued in order if it's this simulation's, each once; or, if it was
    /// handed over, sent on to whoever has it now.
    pub fn take_inputs(&mut self, client: EntityId, mut inputs: Vec<Input>, tick: u64) -> Option<Post> {
        if self.players.slot_index(client).is_none() {
            let slot = *self.clients.get(&client)?;
            let to = self.ghost_of.get(&slot).copied()?;
            return Some(Post { from: self.id, to, tick, says: Says::Inputs(Inputs { client, inputs }) });
        }
        inputs.sort_by_key(|i| i.seq);
        let last = self.queued.entry(client).or_insert(0);
        let fresh: Vec<(u32, f64, Actions)> = inputs.iter().filter(|i| i.seq > *last).map(Input::queued).collect();
        if let Some(&(seq, _, _)) = fresh.last() {
            *last = seq;
        }
        self.players.queue_actions(client, fresh.into_iter());
        None
    }

    /// A player joining this simulation from the start: their slot, epoch 0.
    pub fn joined(&mut self, slot: usize, client: EntityId) {
        self.epochs.insert(slot, Epoch(0));
        self.clients.insert(client, slot);
    }

    // ---------- Handoffs ----------

    /// As a tick ends: whoever of its own is past the border, frozen and handed over, each unit to
    /// the owner of where it stands: a player on their own, or a driver with their passengers. A
    /// passenger whose driver is another's goes to theirs. Each leaves a ghost here, as they left.
    pub fn hand_over(&mut self, owners: &Owners, tick: u64) -> Vec<Post> {
        let own = self.own();
        let mut units: Vec<(SimId, Vec<usize>)> = Vec::new();
        for &(slot, client) in &own {
            let Some((p, _, _)) = self.players.open_view(client) else { continue };
            let riding_along = p.mode == Mode::Ride && p.host != 0;
            if riding_along {
                // With their driver: here, or wherever the driver is.
                let host = self.players.slot_of_owner(p.host);
                if let Some(h) = host
                    && let Some(&to) = self.ghost_of.get(&h)
                {
                    units.push((to, vec![slot]));
                }
                continue;
            }
            let Some(to) = owners.handed_to(self.id, p.pos.x, p.pos.z) else { continue };
            let character = self.players.owner_of_slot(slot).unwrap_or(0);
            let mut unit = vec![slot];
            for &(other, oc) in &own {
                if let Some((q, _, _)) = self.players.open_view(oc)
                    && q.mode == Mode::Ride
                    && q.host == character
                    && character != 0
                {
                    unit.push(other);
                }
            }
            units.push((to, unit));
        }
        let mut posts = Vec::new();
        for (to, unit) in units {
            let mut handoff = Handoff { players: Vec::new() };
            for slot in &unit {
                let Some(d) = self.players.depart(*slot) else { continue };
                let epoch = self.epochs.get(slot).copied().unwrap_or_default().next();
                self.epochs.insert(*slot, epoch);
                let bot = self.bots.remove(slot);
                // A ghost of them here, as they left, until their new owner says otherwise.
                let vehicles = d.life.as_ref().map(|l| l.state.vehicles.clone()).unwrap_or_default();
                self.players.ghost(*slot, d.client, d.owner, d.player.clone(), vehicles);
                self.players.set_history(*slot, &d.history);
                self.ghost_of.insert(*slot, to);
                self.queued.remove(&d.client);
                handoff.players.push(Moving::of(d, epoch, bot));
            }
            if handoff.players.is_empty() {
                continue;
            }
            self.leaving.insert(unit[0], Leaving { to, handoff: handoff.clone() });
            posts.push(Post { from: self.id, to, tick, says: Says::Handoff(handoff) });
        }
        posts
    }

    /// A handoff from `from` taken: each player seated in their slot in place of their ghost, their
    /// bot with them, under the epoch they came with. One already taken (sent again) is said to be
    /// taken again; one under an older epoch than this simulation knows them by is refused.
    pub fn take_handoff(&mut self, h: Handoff) -> Taken {
        let mut taken = Taken::default();
        for m in h.players {
            let known = self.epochs.get(&m.slot).copied().unwrap_or_default();
            let next = m.given() + 1;
            if m.epoch < known || (m.epoch == known && self.players.is_own(m.slot)) {
                if m.epoch == known && self.players.is_own(m.slot) {
                    taken.players.push((m.slot, m.client, m.epoch, next));
                }
                continue;
            }
            let (slot, client, epoch) = (m.slot, m.client, m.epoch);
            let (d, bot) = m.departing(self.world.map);
            self.players.unghost(slot);
            self.ghost_of.remove(&slot);
            if !self.players.arrive(d) {
                continue;
            }
            self.epochs.insert(slot, epoch);
            self.clients.insert(client, slot);
            self.queued.insert(client, next - 1);
            if let Some(b) = bot {
                self.bots.insert(slot, b);
            }
            taken.players.push((slot, client, epoch, next));
        }
        taken
    }

    /// Its handoff taken by `by`: nothing left to send again.
    pub fn taken(&mut self, by: SimId, t: &Taken) {
        self.leaving.retain(|_, l| !(l.to == by && l.handoff.players.iter().all(|m| t.players.iter().any(|(s, _, e, _)| *s == m.slot && *e == m.epoch))));
    }
}
