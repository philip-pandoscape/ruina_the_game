//! A world played as several simulations in lockstep, in one process: each owning its chunks
//! ([`Owners`]), stepping only what it owns, trading ghosts, blows, heals and handoffs with the
//! others as [`Post`]s at every point of a tick where one phase reads what another changed. It plays
//! out bit for bit as one simulation does (checks/border.rs holds it), which is what makes a border
//! something nobody notices. The server's simulations trade the same messages between threads and
//! processes (crates/world-api); this harness passes them by hand, and with `wire` set writes each
//! one out and reads it back, as a process boundary would.
//!
//! A tick, as crate::combat's phases and the server's play_tick go:
//! 1. [`Split::begin_tick`]: handoffs from the last tick taken (and ghosts traded again if any were);
//!    everyone's vehicles made solid; what everyone looks like, for the bots.
//! 2. [`Split::think`] and [`Split::queue`]: the bots' presses, and everyone's inputs through the
//!    gate's routes to whoever owns them (sent on if they reached the old owner of someone handed
//!    over).
//! 3. [`Split::finish_tick`]: the inputs (blows and heals out to their targets' owners, what's told
//!    of them back), passengers seated, ghosts; arrows and meteors (the same), ghosts; the creatures
//!    (their slams and blows out to whoever they reach); ghosts; where everything stood.
//! 4. [`Split::end_tick`]: whoever is past a border handed over, to be taken as the next tick begins.

use std::collections::BTreeMap;

use super::messages::{Blowing, HitSent, Inputs, Post, Says, SlamSent, Struck, Taken};
use super::sim::Sim;
use super::{Owners, SimId};
use crate::actors::{Actors, FoeHit, LEAN_DAMPING, LEAN_SPRING, Slam, StepOut};
use crate::bots::Bot;
use crate::combat::{Across, Landing, Players, Target, in_order};
use crate::ids::EntityId;
use crate::life::Life;
use crate::open::OpenWorld;
use crate::open::map::WorldMap;
use crate::open::zone::{Heightfield, Zone};
use crate::player::{Actions, Player};
use crate::world::World;

use super::messages::Input;

/// The rules' frames in a server tick.
const FRAMES: u32 = 3;

/// What crossed between the simulations: posts and their bytes written out (counted with `wire`),
/// by what they said.
#[derive(Clone, Debug, Default)]
pub struct Counts {
    pub posts: u64,
    pub bytes: u64,
    pub ghost_posts: u64,
    pub ghost_bytes: u64,
    /// Ghosts sent: players and creatures.
    pub ghost_players: u64,
    pub ghost_creatures: u64,
    pub across_bytes: u64,
    pub struck_bytes: u64,
    pub handoffs: u64,
    pub handoff_bytes: u64,
    /// The biggest handoff, in bytes.
    pub handoff_most: u64,
    /// Inputs that reached a player's old owner and were sent on.
    pub strays: u64,
}

/// Several simulations of one world, stepped together.
pub struct Split {
    pub owners: Owners,
    /// In the order of their ids.
    pub sims: Vec<Sim>,
    /// The gate's part: where each player's inputs go.
    pub gate: Gate,
    /// The directory's: which simulation owns each slot's player.
    pub registry: BTreeMap<usize, SimId>,
    /// Posts for the start of the next tick (handoffs), and any held back by a test.
    pub mail: Vec<Post>,
    /// Write every post out and read it back, as between processes.
    pub wire: bool,
    /// Count what crosses (each post written out to count its bytes).
    pub count: bool,
    pub counts: Counts,
    /// The tick being stepped.
    pub tick: u64,
    /// Whether ghosts have been traded yet (the first tick's begin with them).
    started: bool,
}

/// The gate's part of a split world: where each player's inputs go, and from which input on; while
/// a player is handed over, their inputs held until they're taken, then sent to the taker in order.
/// In the server it's the gate tier's (crates/server's gate), hearing of handoffs from the
/// simulations.
#[derive(Default)]
pub struct Gate {
    /// Each player's simulation, and the first input it runs of theirs.
    pub routes: BTreeMap<EntityId, (SimId, u32)>,
    /// Players being handed over, and the inputs held for them.
    pub held: BTreeMap<EntityId, Vec<Input>>,
    /// Tests: the gate hears of handoffs this many ticks late (meanwhile what it sends goes to the
    /// old owner, which sends it on).
    pub lag: u64,
    /// What it's yet to hear, and when: in half ticks (a tick's start, then its end).
    heard: Vec<(u64, Heard)>,
}

/// What the gate hears of a handoff.
enum Heard {
    /// The player is on their way: hold their inputs.
    Moving(EntityId),
    /// The player was taken by a simulation, which runs their inputs from this one on.
    Taken(EntityId, SimId, u32),
}

impl Gate {
    /// Where a player's inputs go now, or None while they're held.
    pub fn route(&self, client: EntityId) -> Option<SimId> {
        if self.held.contains_key(&client) {
            return None;
        }
        self.routes.get(&client).map(|r| r.0)
    }

    /// Something said at the start (or the `end`) of tick `tick`, heard `lag` ticks later.
    fn hear(&mut self, tick: u64, end: bool, what: Heard) {
        self.heard.push((2 * (tick + self.lag) + u64::from(end), what));
    }

    /// What it has heard by the start (or the `end`) of tick `tick`, in the order it was said: the
    /// inputs released to whoever took a player, as (client, simulation, inputs).
    fn listen(&mut self, tick: u64, end: bool) -> Vec<(EntityId, SimId, Vec<Input>)> {
        let now = 2 * tick + u64::from(end);
        let (due, wait): (Vec<_>, Vec<_>) = std::mem::take(&mut self.heard).into_iter().partition(|(at, _)| *at <= now);
        self.heard = wait;
        let mut out = Vec::new();
        for (_, h) in due {
            match h {
                Heard::Moving(client) => {
                    self.held.entry(client).or_default();
                }
                Heard::Taken(client, sim, from) => {
                    self.routes.insert(client, (sim, from));
                    if let Some(inputs) = self.held.remove(&client)
                        && !inputs.is_empty()
                    {
                        out.push((client, sim, inputs));
                    }
                }
            }
        }
        out
    }
}

impl Split {
    /// A world of `map`'s regions, one simulation for each owner in `owners`, each playing a copy of
    /// `zone` with every region solid; `ground` the height the fights are measured from.
    pub fn new(map: &'static WorldMap, zone: &'static Zone, ground: Option<&'static Heightfield>, owners: Owners, tick_ms: f64) -> Split {
        let r = &zone.recipe;
        let spawn = crate::world::Spawn { x: r.spawn.x, z: r.spawn.z, facing: r.spawn.facing };
        let sims = owners
            .sims()
            .into_iter()
            .map(|id| {
                let mut players = Players::new(tick_ms);
                players.ground = ground;
                let flat = World { radius: zone.radius, obstacles: Vec::new(), team_spawns: [spawn, spawn] };
                Sim::new(id, OpenWorld::on(map, zone), flat, players, Actors::new())
            })
            .collect();
        Split {
            owners,
            sims,
            gate: Gate::default(),
            registry: BTreeMap::new(),
            mail: Vec::new(),
            wire: false,
            count: false,
            counts: Counts::default(),
            tick: 0,
            started: false,
        }
    }

    fn index(&self, id: SimId) -> usize {
        self.sims.iter().position(|s| s.id == id).expect("a simulation of this world")
    }

    pub fn sim(&self, id: SimId) -> &Sim {
        &self.sims[self.index(id)]
    }

    pub fn sim_mut(&mut self, id: SimId) -> &mut Sim {
        let i = self.index(id);
        &mut self.sims[i]
    }

    /// The simulation that owns the player in `slot`.
    pub fn owner_of(&self, slot: usize) -> Option<SimId> {
        self.registry.get(&slot).copied()
    }

    // ---------- Who's in it ----------

    /// A character joins in `slot` (theirs in every simulation), in the simulation that owns where
    /// they stand, or `with`'s (a passenger, with their driver). The simulation they're in.
    pub fn join(&mut self, slot: usize, client: EntityId, owner: i64, player: Player, life: Box<Life>, with: Option<SimId>) -> SimId {
        let id = with.unwrap_or_else(|| self.owners.owner_at(player.pos.x, player.pos.z));
        let s = self.sim_mut(id);
        assert!(s.players.join_open_at(slot, client, owner, player, life), "slot {slot} is free");
        s.joined(slot, client);
        self.registry.insert(slot, id);
        self.gate.routes.insert(client, (id, 1));
        id
    }

    /// The bot whose inputs fill the player in `slot`'s, with whoever owns them.
    pub fn add_bot(&mut self, slot: usize, bot: Bot) {
        let id = self.owner_of(slot).expect("the bot's player");
        self.sim_mut(id).bots.insert(slot, bot);
    }

    /// The creatures of `all`, each in the simulation that owns where it was born (its home),
    /// numbering on from `all` everywhere (so ids made in a fight start where one simulation's
    /// would).
    pub fn place_creatures(&mut self, all: Actors) {
        for s in &mut self.sims {
            s.actors = all.numbering_on();
        }
        for a in all.list {
            let id = self.owners.owner_at(a.home_x, a.home_z);
            self.sim_mut(id).actors.list.push(a);
        }
    }

    // ---------- Trading posts ----------

    /// Posts delivered: written out and read back if `wire`, counted if `count`, by whom they're
    /// for.
    fn trade(&mut self, posts: Vec<Post>) -> BTreeMap<SimId, Vec<Post>> {
        let mut out: BTreeMap<SimId, Vec<Post>> = BTreeMap::new();
        for p in posts {
            let p = if self.wire || self.count {
                let text = serde_json::to_string(&p).expect("a post written out");
                let bytes = text.len() as u64;
                let c = &mut self.counts;
                c.posts += 1;
                c.bytes += bytes;
                match &p.says {
                    Says::Ghosts(g) => {
                        c.ghost_posts += 1;
                        c.ghost_bytes += bytes;
                        c.ghost_players += g.players.len() as u64;
                        c.ghost_creatures += g.creatures.len() as u64;
                    }
                    Says::Across(_) => c.across_bytes += bytes,
                    Says::Struck(_) => c.struck_bytes += bytes,
                    Says::Handoff(_) => {
                        c.handoffs += 1;
                        c.handoff_bytes += bytes;
                        c.handoff_most = c.handoff_most.max(bytes);
                    }
                    Says::Taken(_) | Says::Inputs(_) => {}
                }
                if self.wire { read_back(&text) } else { p }
            } else {
                p
            };
            out.entry(p.to).or_default().push(p);
        }
        out
    }

    /// Ghosts traded between every pair of simulations: players if `players`, creatures if
    /// `creatures`.
    fn trade_ghosts(&mut self, players: bool, creatures: bool) {
        let ids: Vec<SimId> = self.sims.iter().map(|s| s.id).collect();
        let mut posts = Vec::new();
        for s in &mut self.sims {
            let me = s.id;
            for &to in ids.iter().filter(|&&t| t != me) {
                let g = s.ghosts_for(to, &self.owners, players, creatures);
                if !g.is_empty() {
                    posts.push(Post { from: s.id, to, tick: self.tick, says: Says::Ghosts(g) });
                }
            }
        }
        for (to, posts) in self.trade(posts) {
            let s = self.sim_mut(to);
            for p in posts {
                if let Says::Ghosts(g) = p.says {
                    s.take_ghosts(p.from, g);
                }
            }
        }
    }

    // ---------- A tick ----------

    /// The start of tick `tick`: handoffs from the last taken, everyone's vehicles solid, and what
    /// everyone looks like for the bots, who see the others `lag` ticks late.
    pub fn begin_tick(&mut self, tick: u64, inputs_per_tick: f64, lag: f64) {
        self.tick = tick;
        let handed = self.deliver_mail();
        if !self.started {
            // Everyone seen across the borders before anything happens.
            self.trade_ghosts(true, true);
            self.started = true;
        } else if handed {
            // Whoever changed hands is seen from their new owner, under their new epoch.
            self.trade_ghosts(true, false);
        }
        for s in &mut self.sims {
            s.players.inputs_per_tick = inputs_per_tick;
            s.players.gather_movers(&mut s.world);
            s.look(lag);
        }
    }

    /// The mail from the end of the last tick: handoffs taken, and the takers' word back to the
    /// givers, the directory and the gate. Whether anyone changed hands.
    fn deliver_mail(&mut self) -> bool {
        let mail = std::mem::take(&mut self.mail);
        let (now, later): (Vec<Post>, Vec<Post>) = mail.into_iter().partition(|p| p.tick < self.tick);
        self.mail = later;
        let mut replies = Vec::new();
        for (to, posts) in self.trade(now) {
            for p in posts {
                if let Says::Handoff(h) = p.says {
                    let t = self.sim_mut(to).take_handoff(h);
                    if !t.players.is_empty() {
                        replies.push(Post { from: to, to: p.from, tick: self.tick, says: Says::Taken(t) });
                    }
                }
            }
        }
        let mut handed = false;
        for (to, posts) in self.trade(replies) {
            for p in posts {
                if let Says::Taken(t) = p.says {
                    self.sim_mut(to).taken(p.from, &t);
                    self.took(p.from, &t);
                    handed = true;
                }
            }
        }
        // What the gate held for whoever was taken goes to them, in order.
        let tick = self.tick;
        for (client, sim, inputs) in self.gate.listen(tick, false) {
            self.deliver_inputs(sim, client, inputs);
        }
        handed
    }

    /// The directory and the gate learn who took whom.
    fn took(&mut self, by: SimId, t: &Taken) {
        for &(slot, client, _, from) in &t.players {
            self.registry.insert(slot, by);
            self.gate.hear(self.tick, false, Heard::Taken(client, by, from));
        }
    }

    /// What every bot presses this tick, by its player's slot.
    pub fn think(&mut self) -> Vec<(usize, Actions)> {
        let mut out: Vec<(usize, Actions)> = self.sims.iter_mut().flat_map(Sim::think).collect();
        out.sort_by_key(|(slot, _)| *slot);
        out
    }

    /// A player's inputs through the gate: to whoever its routes say owns them, and on from there
    /// if they've since been handed over.
    pub fn queue(&mut self, client: EntityId, inputs: Vec<Input>) {
        match self.gate.route(client) {
            Some(to) => self.deliver_inputs(to, client, inputs),
            None => {
                if let Some(held) = self.gate.held.get_mut(&client) {
                    held.extend(inputs);
                }
            }
        }
    }

    /// Inputs handed to simulation `to`, and sent on from there to wherever their player is now.
    fn deliver_inputs(&mut self, to: SimId, client: EntityId, inputs: Vec<Input>) {
        let tick = self.tick;
        let mut post = self.sim_mut(to).take_inputs(client, inputs, tick);
        // A stray: sent on (at most once per simulation it passes).
        for _ in 0..self.sims.len() {
            let Some(p) = post.take() else { break };
            self.counts.strays += 1;
            let mut got = self.trade(vec![p]);
            let Some((to, posts)) = got.pop_first() else { break };
            for p in posts {
                if let Says::Inputs(Inputs { client, inputs }) = p.says {
                    post = self.sim_mut(to).take_inputs(client, inputs, tick);
                }
            }
        }
    }

    /// The rest of the tick, phase by phase, trading what crosses between them. What each
    /// simulation's creatures did (their slams and blows), for whoever is watching.
    pub fn finish_tick(&mut self) -> Vec<(SimId, StepOut)> {
        let tick = self.tick;
        // Everyone's inputs.
        let mut landings: Vec<Landing> = Vec::new();
        for s in &mut self.sims {
            let mut l = s.players.work_out(&s.actors, &s.flat, tick, Some(&s.world), in_order);
            s.players.send_away(&mut l, &s.actors);
            landings.push(l);
        }
        self.land(&mut landings);
        for (s, l) in self.sims.iter_mut().zip(landings) {
            s.players.settle(l, Vec::new(), Some(&mut s.world));
        }
        for s in &mut self.sims {
            s.players.seat_passengers(&s.world);
        }
        self.trade_ghosts(true, true);
        // Arrows and meteors.
        let mut landings: Vec<Landing> = Vec::new();
        for s in &mut self.sims {
            let mut l = s.players.fly_effects(&s.actors);
            s.players.send_away(&mut l, &s.actors);
            landings.push(l);
        }
        self.land(&mut landings);
        for (s, l) in self.sims.iter_mut().zip(landings) {
            s.players.settle(l, Vec::new(), None);
        }
        self.trade_ghosts(true, false);
        // The creatures, and where their slams and blows land.
        let done = self.creatures();
        self.trade_ghosts(true, true);
        for s in &mut self.sims {
            s.players.record_history(tick, &s.actors);
        }
        done
    }

    /// A phase's blows and heals landed: those on what another simulation owns sent to it, landed
    /// there among its own, and what each means for its dealer sent back to be told.
    fn land(&mut self, landings: &mut [Landing]) {
        let tick = self.tick;
        let mut posts = Vec::new();
        for (i, l) in landings.iter_mut().enumerate() {
            let away = std::mem::take(&mut l.away);
            let s = &self.sims[i];
            let mut by: BTreeMap<SimId, Across> = BTreeMap::new();
            for b in away.blows {
                let owner = match b.target {
                    Target::Creature(id) => s.creature_of.get(&id).copied(),
                    Target::Player(v) => s.owner_of(v).or_else(|| self.registry.get(&v).copied()),
                };
                if let Some(o) = owner {
                    by.entry(o).or_default().blows.push(b);
                }
            }
            for h in away.heals {
                if let Some(o) = s.owner_of(h.target).or_else(|| self.registry.get(&h.target).copied()) {
                    by.entry(o).or_default().heals.push(h);
                }
            }
            for (to, a) in by {
                posts.push(Post { from: s.id, to, tick, says: Says::Across(a) });
            }
        }
        let mut incoming: BTreeMap<SimId, Across> = BTreeMap::new();
        for (to, posts) in self.trade(posts) {
            for p in posts {
                if let Says::Across(a) = p.says {
                    incoming.entry(to).or_default().extend(a);
                }
            }
        }
        let mut posts = Vec::new();
        for (i, l) in landings.iter_mut().enumerate() {
            let s = &mut self.sims[i];
            let from = incoming.remove(&s.id).unwrap_or_default();
            s.players.land(l, &mut s.actors, from);
            let away = std::mem::take(&mut l.away);
            debug_assert!(away.blows.is_empty() && away.heals.is_empty(), "a blow or heal for another simulation came here");
            let mut by: BTreeMap<SimId, Vec<crate::combat::Told>> = BTreeMap::new();
            for t in away.told {
                if let Some(o) = s.owner_of(t.slot).or_else(|| self.registry.get(&t.slot).copied()) {
                    by.entry(o).or_default().push(t);
                }
            }
            for (to, told) in by {
                posts.push(Post { from: s.id, to, tick, says: Says::Across(Across { told, ..Across::default() }) });
            }
        }
        for (to, posts) in self.trade(posts) {
            let i = self.index(to);
            for p in posts {
                if let Says::Across(a) = p.says {
                    landings[i].tell(a.told);
                }
            }
        }
    }

    /// The creatures' frames: each simulation's own, seeing its players and the ghosts of others';
    /// a slam falls on every simulation's players it reaches, a blow on its target's owner's, each
    /// landing in the order they fell.
    fn creatures(&mut self) -> Vec<(SimId, StepOut)> {
        let tick = self.tick;
        let mut done: Vec<(SimId, StepOut)> = Vec::new();
        let mut slams: BTreeMap<SimId, Vec<(Blowing, Slam)>> = BTreeMap::new();
        let mut hits: BTreeMap<SimId, Vec<(Blowing, FoeHit)>> = BTreeMap::new();
        let mut posts = Vec::new();
        for s in &mut self.sims {
            let foes = s.players.foes();
            let ground = s.players.ground;
            let ground_at = move |x: f64, z: f64| ground.map_or(0.0, |g| g.height(x, z));
            let mut all = StepOut::default();
            let mut out_struck: BTreeMap<SimId, Struck> = BTreeMap::new();
            for frame in 0..FRAMES {
                let o = s.actors.step(&foes, &ground_at, LEAN_SPRING, LEAN_DAMPING, 1.0 / 60.0);
                let mut n: BTreeMap<u32, u32> = BTreeMap::new();
                for sl in &o.slams {
                    let k = n.entry(sl.by).or_insert(0);
                    let key = Blowing::slam(frame, sl, *k);
                    *k += 1;
                    slams.entry(s.id).or_default().push((key, *sl));
                    for to in self.owners.near(s.id, sl.x, sl.z, super::BAND) {
                        out_struck.entry(to).or_default().slams.push((key, SlamSent::of(sl)));
                    }
                }
                let mut n: BTreeMap<(bool, u32), u32> = BTreeMap::new();
                for h in &o.hits {
                    let probe = Blowing::hit(frame, h, 0);
                    let k = n.entry((probe.missile, probe.by)).or_insert(0);
                    let key = Blowing::hit(frame, h, *k);
                    *k += 1;
                    let slot = (h.foe as usize).wrapping_sub(1);
                    match s.owner_of(slot) {
                        Some(o) if o == s.id => hits.entry(s.id).or_default().push((key, *h)),
                        Some(o) => out_struck.entry(o).or_default().hits.push((key, HitSent::of(h))),
                        None => {}
                    }
                }
                all.extend(o);
            }
            for (to, st) in out_struck {
                posts.push(Post { from: s.id, to, tick, says: Says::Struck(st) });
            }
            done.push((s.id, all));
        }
        for (to, posts) in self.trade(posts) {
            for p in posts {
                if let Says::Struck(st) = p.says {
                    slams.entry(to).or_default().extend(st.slams.into_iter().map(|(k, sl)| (k, sl.slam())));
                    hits.entry(to).or_default().extend(st.hits.into_iter().map(|(k, h)| (k, h.hit())));
                }
            }
        }
        for s in &mut self.sims {
            let mut sl = slams.remove(&s.id).unwrap_or_default();
            sl.sort_by_key(|(k, _)| *k);
            let mut hs = hits.remove(&s.id).unwrap_or_default();
            hs.sort_by_key(|(k, _)| *k);
            s.players.apply_slams(&sl.into_iter().map(|(_, x)| x).collect::<Vec<_>>());
            s.players.apply_foe_hits(&hs.into_iter().map(|(_, x)| x).collect::<Vec<_>>());
        }
        done
    }

    /// The end of the tick: whoever is past a border handed over, to be taken as the next begins.
    pub fn end_tick(&mut self) {
        let tick = self.tick;
        for s in &mut self.sims {
            let posts = s.hand_over(&self.owners, tick);
            for p in &posts {
                // The gate holds whoever is on their way.
                if let Says::Handoff(h) = &p.says {
                    for m in &h.players {
                        self.gate.hear(tick, true, Heard::Moving(m.client));
                    }
                }
            }
            self.mail.extend(posts);
        }
        // At the end of a tick the gate hears of whoever just set off (with no lag, at once).
        for (client, sim, inputs) in self.gate.listen(tick, true) {
            self.deliver_inputs(sim, client, inputs);
        }
    }
}

/// A post written out, read back as another process would read it: the skills' numbers of every
/// player in it worked out again, as they aren't written.
fn read_back(text: &str) -> Post {
    let mut p: Post = serde_json::from_str(text).unwrap_or_else(|e| panic!("a post reads back: {e}"));
    if let Says::Ghosts(g) = &mut p.says {
        for gp in &mut g.players {
            gp.player.resolve();
        }
    }
    p
}
