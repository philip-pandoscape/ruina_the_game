//! One simulation of a world split between several. [`Border`] is its side of every border: the
//! ghosts of what its neighbours own near its chunks, the epochs it holds its players and theirs
//! under, its handoffs, and what it trades at each point of a tick, working on the players and
//! creatures it's handed (a game of the server's holds one beside its own: crates/server's sim).
//! [`Sim`] is a whole simulation for [`super::split::Split`], the harness that steps several in
//! lockstep: its border, players, creatures, bots and ground.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use super::messages::{Blowing, GhostCreature, GhostPlayer, Ghosts, Handoff, HitSent, Input, Inputs, Moving, Post, Says, SlamSent, Struck, Taken};
use super::{BAND, Epoch, Owners, SimId};
use crate::actors::{Actors, FoeHit, Slam, StepOut};
use crate::bots::{Bot, FoeSeen};
use crate::combat::{Across, Landing, MAX_PLAYERS, Players, Target, Told};
use crate::ids::EntityId;
use crate::open::OpenWorld;
use crate::open::map::WorldMap;
use crate::player::{Actions, Mode};

/// A handoff sent and not yet taken: to whom, and what was sent (sent again until it's taken).
pub struct Leaving {
    pub to: SimId,
    pub handoff: Handoff,
    /// The tick it was sent.
    pub sent: u64,
}

/// How many ticks a handoff waits to be taken before it goes again.
const RESEND_AFTER: u64 = 1;

/// A simulation's side of its borders.
pub struct Border {
    pub id: SimId,
    /// Who owns which chunk (the directory's table).
    pub owners: Owners,
    /// The epoch each player it owns or sees is held under, by slot.
    pub epochs: BTreeMap<usize, Epoch>,
    /// Every player it owns or sees, by client.
    pub clients: BTreeMap<EntityId, usize>,
    /// Whose each ghost here is: players by slot, creatures by id.
    pub ghost_of: BTreeMap<usize, SimId>,
    pub creature_of: BTreeMap<u32, SimId>,
    /// Who each player was last seen owned by (a ghost, a handoff), for what's told of a blow
    /// landed here by someone since gone out of sight.
    pub last_seen: BTreeMap<usize, SimId>,
    /// Handoffs sent and not yet taken, by the first slot of each.
    pub leaving: BTreeMap<usize, Leaving>,
    /// How many ticks a handoff waits to be taken before it goes again.
    pub resend_after: u64,
    /// What each neighbour has been shown (players by slot, creatures by id): their history goes
    /// the first time, and those no longer near are said to be gone.
    shown: BTreeMap<SimId, (BTreeSet<usize>, BTreeSet<u32>)>,
    /// The last input queued for each of its players, so one that comes twice is run once.
    queued: BTreeMap<EntityId, u32>,
    /// Inputs sent on to it for players it hasn't taken yet (their handoff on its way), kept for
    /// when it does.
    waiting: BTreeMap<EntityId, Vec<Input>>,
}

impl Border {
    pub fn new(id: SimId, owners: Owners) -> Border {
        Border {
            id,
            owners,
            epochs: BTreeMap::new(),
            clients: BTreeMap::new(),
            ghost_of: BTreeMap::new(),
            creature_of: BTreeMap::new(),
            last_seen: BTreeMap::new(),
            leaving: BTreeMap::new(),
            resend_after: RESEND_AFTER,
            shown: BTreeMap::new(),
            queued: BTreeMap::new(),
            waiting: BTreeMap::new(),
        }
    }

    /// The other simulations of its world, in order.
    pub fn neighbours(&self) -> Vec<SimId> {
        self.owners.sims().into_iter().filter(|&s| s != self.id).collect()
    }

    /// Whom it thinks owns the player in `slot`: itself, the one it sees them from, or the one it
    /// last saw them owned by.
    pub fn owner_of(&self, players: &Players, slot: usize) -> Option<SimId> {
        if players.is_own(slot) {
            return Some(self.id);
        }
        self.ghost_of.get(&slot).or_else(|| self.last_seen.get(&slot)).copied()
    }

    /// A player joining this simulation from the start: their slot, epoch 0.
    pub fn joined(&mut self, slot: usize, client: EntityId) {
        self.epochs.insert(slot, Epoch(0));
        self.clients.insert(client, slot);
        self.last_seen.insert(slot, self.id);
    }

    // ---------- Ghosts ----------

    /// Ghosts of what this simulation owns near `to`'s chunks, as they stand: its players (with their
    /// vehicles) if `players`, its creatures if `creatures`. Whatever `to` sees for the first time
    /// comes with its history; whatever it no longer sees is gone.
    pub fn ghosts_for(&mut self, players: &Players, actors: &Actors, to: SimId, with_players: bool, with_creatures: bool) -> Ghosts {
        let mut g = Ghosts::default();
        let owners = &self.owners;
        let shown = self.shown.entry(to).or_default();
        if with_players {
            let mut now = BTreeSet::new();
            for (client, owner, p, life) in players.each_open() {
                let Some(slot) = players.slot_index(client) else { continue };
                let vehicles = life.map(|l| l.state.vehicles.clone()).unwrap_or_default();
                let near = owners.within(to, p.pos.x, p.pos.z, BAND) || vehicles.iter().any(|v| owners.within(to, v.x, v.z, BAND));
                if !near {
                    continue;
                }
                now.insert(slot);
                let history = (!shown.0.contains(&slot)).then(|| players.history(slot));
                let epoch = self.epochs.get(&slot).copied().unwrap_or_default();
                g.players.push(GhostPlayer { slot, client, owner, epoch, player: p.clone(), vehicles, history });
            }
            g.gone = shown.0.difference(&now).copied().collect();
            shown.0 = now;
        }
        if with_creatures {
            let mut now = BTreeSet::new();
            for a in &actors.list {
                if !owners.within(to, a.x, a.z, BAND) {
                    continue;
                }
                now.insert(a.id);
                let history = (!shown.1.contains(&a.id)).then(|| players.creature_history(a.id));
                g.creatures.push(GhostCreature::of(a, history));
            }
            g.gone_creatures = shown.1.difference(&now).copied().collect();
            shown.1 = now;
        }
        g
    }

    /// Ghosts for every neighbour that has anything to see (or forget), as posts.
    pub fn ghosts_out(&mut self, players: &Players, actors: &Actors, tick: u64, with_players: bool, with_creatures: bool) -> Vec<Post> {
        let mut posts = Vec::new();
        for to in self.neighbours() {
            let g = self.ghosts_for(players, actors, to, with_players, with_creatures);
            if !g.is_empty() {
                posts.push(Post { from: self.id, to, tick, says: Says::Ghosts(g) });
            }
        }
        posts
    }

    /// Ghosts from `from`, taken in: each player in their slot (unless it's this simulation's own,
    /// or what's said is under an older epoch than it knows), each creature among its ghosts, each
    /// with the history it came with; those gone, forgotten.
    pub fn take_ghosts(&mut self, players: &mut Players, actors: &mut Actors, from: SimId, g: Ghosts) {
        for gp in g.players {
            let known = self.epochs.get(&gp.slot).copied().unwrap_or_default();
            if players.is_own(gp.slot) || gp.epoch < known {
                continue;
            }
            self.epochs.insert(gp.slot, gp.epoch);
            self.ghost_of.insert(gp.slot, from);
            self.last_seen.insert(gp.slot, from);
            self.clients.insert(gp.client, gp.slot);
            players.ghost(gp.slot, gp.client, gp.owner, gp.player, gp.vehicles);
            if let Some(h) = gp.history {
                players.set_history(gp.slot, &h);
            }
        }
        for slot in g.gone {
            if self.ghost_of.get(&slot) == Some(&from) && players.unghost(slot) {
                self.ghost_of.remove(&slot);
                self.clients.retain(|_, s| *s != slot);
            }
        }
        for gc in g.creatures {
            self.creature_of.insert(gc.id, from);
            if let Some(h) = &gc.history {
                players.set_creature_history(gc.id, h);
            }
            let a = gc.actor();
            match actors.ghosts.iter_mut().find(|o| o.id == a.id) {
                Some(o) => *o = a,
                None => actors.ghosts.push(a),
            }
        }
        for id in g.gone_creatures {
            if self.creature_of.get(&id) == Some(&from) {
                self.creature_of.remove(&id);
                actors.ghosts.retain(|a| a.id != id);
            }
        }
    }

    /// Every ghost post in `posts` taken in (anything else passed over).
    pub fn ghosts_in(&mut self, players: &mut Players, actors: &mut Actors, posts: Vec<Post>) {
        for p in posts {
            if let Says::Ghosts(g) = p.says {
                self.take_ghosts(players, actors, p.from, g);
            }
        }
    }

    // ---------- Blows and heals across ----------

    /// A phase worked out and sent away (crate::combat's `send_away`): its blows and heals on what
    /// others own, as posts to them.
    pub fn across_out(&self, players: &Players, landing: &mut Landing, tick: u64) -> Vec<Post> {
        let away = std::mem::take(&mut landing.away);
        let mut by: BTreeMap<SimId, Across> = BTreeMap::new();
        for b in away.blows {
            let owner = match b.target {
                Target::Creature(id) => self.creature_of.get(&id).copied(),
                Target::Player(v) => self.owner_of(players, v),
            };
            if let Some(o) = owner.filter(|&o| o != self.id) {
                by.entry(o).or_default().blows.push(b);
            }
        }
        for h in away.heals {
            if let Some(o) = self.owner_of(players, h.target).filter(|&o| o != self.id) {
                by.entry(o).or_default().heals.push(h);
            }
        }
        landing.away.told = away.told;
        by.into_iter().map(|(to, a)| Post { from: self.id, to, tick, says: Says::Across(a) }).collect()
    }

    /// What others dealt this simulation's players and creatures, from their posts, to land.
    pub fn dealt(posts: Vec<Post>) -> Across {
        let mut a = Across::default();
        for p in posts {
            if let Says::Across(x) = p.says {
                a.extend(x);
            }
        }
        a
    }

    /// A phase landed (crate::combat's `land`): what's to be told to players others hold, as posts to
    /// whoever holds them.
    pub fn told_out(&self, players: &Players, landing: &mut Landing, tick: u64) -> Vec<Post> {
        let away = std::mem::take(&mut landing.away);
        let mut by: BTreeMap<SimId, Vec<Told>> = BTreeMap::new();
        for t in away.told {
            if let Some(o) = self.owner_of(players, t.slot).filter(|&o| o != self.id) {
                by.entry(o).or_default().push(t);
            }
        }
        landing.away.blows = away.blows;
        landing.away.heals = away.heals;
        by.into_iter().map(|(to, told)| Post { from: self.id, to, tick, says: Says::Across(Across { told, ..Across::default() }) }).collect()
    }

    /// What's told of blows that landed elsewhere, from others' posts, for players here, added to
    /// what the phase tells.
    pub fn told_in(players: &Players, landing: &mut Landing, posts: Vec<Post>) {
        for p in posts {
            if let Says::Across(a) = p.says {
                landing.tell(a.told.into_iter().filter(|t| players.is_own(t.slot)).collect());
            }
        }
    }

    // ---------- Creatures' slams and blows ----------

    /// A frame of this simulation's creatures (`frame` of the tick's): its slams, each falling here
    /// and on every neighbour whose ground is near; its blows, each on its target's owner. What falls
    /// here is kept in `here` (keyed by where it falls among the tick's) and what's for others is
    /// added to `out`.
    pub fn struck_out(&self, players: &Players, frame: u32, o: &StepOut, here: &mut Struck, out: &mut BTreeMap<SimId, Struck>) {
        let mut n: BTreeMap<u32, u32> = BTreeMap::new();
        for sl in &o.slams {
            let k = n.entry(sl.by).or_insert(0);
            let key = Blowing::slam(frame, sl, *k);
            *k += 1;
            here.slams.push((key, SlamSent::of(sl)));
            for to in self.owners.near(self.id, sl.x, sl.z, BAND) {
                out.entry(to).or_default().slams.push((key, SlamSent::of(sl)));
            }
        }
        let mut n: BTreeMap<(bool, u32), u32> = BTreeMap::new();
        for h in &o.hits {
            let probe = Blowing::hit(frame, h, 0);
            let k = n.entry((probe.missile, probe.by)).or_insert(0);
            let key = Blowing::hit(frame, h, *k);
            *k += 1;
            let slot = (h.foe as usize).wrapping_sub(1);
            match self.owner_of(players, slot) {
                Some(o) if o == self.id => here.hits.push((key, HitSent::of(h))),
                Some(o) => out.entry(o).or_default().hits.push((key, HitSent::of(h))),
                None => {}
            }
        }
    }

    /// The slams and blows that fall here, this simulation's and others' (from their posts), in the
    /// order they fell.
    pub fn struck_in(here: Struck, posts: Vec<Post>) -> (Vec<Slam>, Vec<FoeHit>) {
        let (mut slams, mut hits) = (here.slams, here.hits);
        for p in posts {
            if let Says::Struck(st) = p.says {
                slams.extend(st.slams);
                hits.extend(st.hits);
            }
        }
        slams.sort_by_key(|(k, _)| *k);
        hits.sort_by_key(|(k, _)| *k);
        (slams.into_iter().map(|(_, s)| s.slam()).collect(), hits.into_iter().map(|(_, h)| h.hit()).collect())
    }

    // ---------- Inputs ----------

    /// Inputs for `client`: queued in order if it's this simulation's, each once; sent on to whoever
    /// has them now if they were handed over; kept for them if they're on their way here.
    pub fn take_inputs(&mut self, players: &mut Players, client: EntityId, mut inputs: Vec<Input>, tick: u64) -> Option<Post> {
        if players.slot_index(client).is_none() {
            let elsewhere = self.clients.get(&client).and_then(|slot| self.ghost_of.get(slot)).copied();
            match elsewhere {
                Some(to) if to != self.id => return Some(Post { from: self.id, to, tick, says: Says::Inputs(Inputs { client, inputs }) }),
                _ => {
                    let w = self.waiting.entry(client).or_default();
                    if w.len() < 240 {
                        w.extend(inputs);
                    }
                    return None;
                }
            }
        }
        inputs.sort_by_key(|i| i.seq);
        let last = self.queued.entry(client).or_insert(0);
        let fresh: Vec<(u32, f64, Actions)> = inputs.iter().filter(|i| i.seq > *last).map(Input::queued).collect();
        if let Some(&(seq, _, _)) = fresh.last() {
            *last = seq;
        }
        players.queue_actions(client, fresh.into_iter());
        None
    }

    /// The last input queued for `client` here.
    pub fn queued(&self, client: EntityId) -> u32 {
        self.queued.get(&client).copied().unwrap_or(0)
    }

    /// Notes that inputs up to `seq` reached `client`'s queue some other way (the server's own).
    pub fn queued_to(&mut self, client: EntityId, seq: u32) {
        let last = self.queued.entry(client).or_insert(0);
        *last = (*last).max(seq);
    }

    // ---------- Handoffs ----------

    /// As a tick ends: whoever of its own is past the border, frozen and handed over, each unit to
    /// the owner of where it stands: a player on their own, or a driver with their passengers. A
    /// passenger whose driver is another's goes to theirs. Each leaves a ghost here, as they left.
    /// What's handed over is taken out of `players` (and their bots out of `bots`); a handoff not yet
    /// taken goes again.
    pub fn hand_over(&mut self, players: &mut Players, bots: &mut BTreeMap<usize, Bot>, tick: u64) -> Vec<Post> {
        let mut posts: Vec<Post> = self
            .leaving
            .values()
            .filter(|l| tick >= l.sent + self.resend_after)
            .map(|l| Post { from: self.id, to: l.to, tick, says: Says::Handoff(l.handoff.clone()) })
            .collect();
        let own: Vec<(usize, EntityId)> = {
            let mut v: Vec<(usize, EntityId)> = players.each_open().filter_map(|(c, _, _, _)| Some((players.slot_index(c)?, c))).collect();
            v.sort();
            v
        };
        let mut units: Vec<(SimId, Vec<usize>)> = Vec::new();
        for &(slot, client) in &own {
            let Some((p, _, _)) = players.open_view(client) else { continue };
            let riding_along = p.mode == Mode::Ride && p.host != 0;
            if riding_along {
                // With their driver: here, or wherever the driver is.
                let host = players.slot_of_owner(p.host);
                if let Some(h) = host
                    && let Some(&to) = self.ghost_of.get(&h)
                {
                    units.push((to, vec![slot]));
                }
                continue;
            }
            let Some(to) = self.owners.handed_to(self.id, p.pos.x, p.pos.z) else { continue };
            let character = players.owner_of_slot(slot).unwrap_or(0);
            let mut unit = vec![slot];
            for &(other, oc) in &own {
                if let Some((q, _, _)) = players.open_view(oc)
                    && q.mode == Mode::Ride
                    && q.host == character
                    && character != 0
                {
                    unit.push(other);
                }
            }
            units.push((to, unit));
        }
        for (to, unit) in units {
            let mut handoff = Handoff { players: Vec::new() };
            for slot in &unit {
                let Some(d) = players.depart(*slot) else { continue };
                let epoch = self.epochs.get(slot).copied().unwrap_or_default().next();
                self.epochs.insert(*slot, epoch);
                let bot = bots.remove(slot);
                // A ghost of them here, as they left, until their new owner says otherwise.
                let vehicles = d.life.as_ref().map(|l| l.state.vehicles.clone()).unwrap_or_default();
                players.ghost(*slot, d.client, d.owner, d.player.clone(), vehicles);
                players.set_history(*slot, &d.history);
                self.ghost_of.insert(*slot, to);
                self.last_seen.insert(*slot, to);
                self.queued.remove(&d.client);
                handoff.players.push(Moving::of(d, epoch, bot));
            }
            if handoff.players.is_empty() {
                continue;
            }
            self.leaving.insert(unit[0], Leaving { to, handoff: handoff.clone(), sent: tick });
            posts.push(Post { from: self.id, to, tick, says: Says::Handoff(handoff) });
        }
        posts
    }

    /// A handoff taken: each player seated in their slot in place of their ghost, their bot with
    /// them, under the epoch they came with. One already taken (sent again) is said to be taken
    /// again; one under an older epoch than this simulation knows them by is refused.
    pub fn take_handoff(&mut self, players: &mut Players, bots: &mut BTreeMap<usize, Bot>, map: &'static WorldMap, h: Handoff) -> Taken {
        let mut taken = Taken::default();
        for m in h.players {
            let known = self.epochs.get(&m.slot).copied().unwrap_or_default();
            let next = m.given() + 1;
            if m.epoch < known || (m.epoch == known && players.is_own(m.slot)) {
                if m.epoch == known && players.is_own(m.slot) {
                    taken.players.push((m.slot, m.client, m.epoch, next));
                }
                continue;
            }
            let (slot, client, epoch) = (m.slot, m.client, m.epoch);
            let (d, bot) = m.departing(map);
            players.unghost(slot);
            self.ghost_of.remove(&slot);
            if !players.arrive(d) {
                continue;
            }
            self.epochs.insert(slot, epoch);
            self.clients.insert(client, slot);
            self.last_seen.insert(slot, self.id);
            self.queued.insert(client, next - 1);
            if let Some(b) = bot {
                bots.insert(slot, b);
            }
            // Whatever reached here for them on the way.
            if let Some(w) = self.waiting.remove(&client) {
                self.take_inputs(players, client, w, 0);
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

/// One simulation's part of a world, whole, for the harness: its border, the world its players'
/// lives live in, its ground, its players, creatures and bots.
pub struct Sim {
    pub id: SimId,
    pub border: Border,
    /// The world its players' lives live in (a life holds its region's zone for good), as the
    /// world's map itself: its own `world.map` is a view of it holding only what it plays.
    pub map: &'static WorldMap,
    pub world: OpenWorld,
    pub players: Players,
    pub actors: Actors,
    /// The brains that fill its bots' inputs, by their players' slots (they go with their players).
    pub bots: BTreeMap<usize, Bot>,
    /// What everyone it owns or sees looked like as each of the last ticks began, in the order of
    /// their slots, for its bots: (slot, character, team, as seen).
    pub looked: VecDeque<Vec<(usize, i64, u8, FoeSeen)>>,
}

impl Sim {
    pub fn new(id: SimId, owners: Owners, map: &'static WorldMap, world: OpenWorld, players: Players, actors: Actors) -> Sim {
        Sim { id, border: Border::new(id, owners), map, world, players, actors, bots: BTreeMap::new(), looked: VecDeque::new() }
    }

    /// Whom this simulation thinks owns the player in `slot`.
    pub fn owner_of(&self, slot: usize) -> Option<SimId> {
        self.border.owner_of(&self.players, slot)
    }

    /// Its own players, by slot: (slot, client).
    pub fn own(&self) -> Vec<(usize, EntityId)> {
        let mut v: Vec<(usize, EntityId)> = self.players.each_open().filter_map(|(c, _, _, _)| Some((self.players.slot_index(c)?, c))).collect();
        v.sort();
        v
    }

    pub fn take_ghosts(&mut self, from: SimId, g: Ghosts) {
        self.border.take_ghosts(&mut self.players, &mut self.actors, from, g);
    }

    pub fn take_inputs(&mut self, client: EntityId, inputs: Vec<Input>, tick: u64) -> Option<Post> {
        self.border.take_inputs(&mut self.players, client, inputs, tick)
    }

    pub fn joined(&mut self, slot: usize, client: EntityId) {
        self.border.joined(slot, client);
    }

    pub fn hand_over(&mut self, tick: u64) -> Vec<Post> {
        self.border.hand_over(&mut self.players, &mut self.bots, tick)
    }

    pub fn take_handoff(&mut self, h: Handoff) -> Taken {
        self.border.take_handoff(&mut self.players, &mut self.bots, self.map, h)
    }

    pub fn taken(&mut self, by: SimId, t: &Taken) {
        self.border.taken(by, t);
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
}
