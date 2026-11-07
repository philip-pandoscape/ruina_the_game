//! A game playing part of a region beside others (crates/engine/src/border): its side of the
//! borders between them, what it trades with them at each point of a tick (`Trade`: the host's,
//! over the post), and its players handed over and taken as they cross, their gates holding and then
//! re-routing their inputs so that nobody playing notices. A game playing a whole space has none of
//! it, and its tick is as it always was.
//!
//! The trade's shape runs either way: every point of a tick sends each neighbour one parcel and is
//! handed back what the neighbours sent there, which the host waits for (lockstep, so a split region
//! plays to the bit as one game does) or takes as it has come (a tick late, for neighbours in other
//! processes, should the multi-server version choose it).

use std::collections::BTreeMap;
use std::ops::Range;

pub use ruina_engine::border::messages::Barrier;
use ruina_engine::border::messages::{Post, Says, Struck};
use ruina_engine::border::sim::Border;
use ruina_world_api::gate::ToConn;
use ruina_world_api::sim::Member as MemberInfo;
use ruina_world_api::{CharacterId, EntityId, SimId};

use super::{Game, Member, TICK_HZ, make_solid};
use crate::actors::{LEAN_DAMPING, LEAN_SPRING, StepOut};
use crate::bots::Bot;
use crate::combat::{Across, Landing};
use crate::open::map::world_map;
use crate::open::{OpenWorld, SIM_BAND};

/// What a game sends its neighbours at a point of a tick, and what it's handed back.
#[derive(Debug, Default)]
pub struct Parcels {
    pub posts: Vec<Post>,
    /// The players handed over in them, by character: who they are, which goes with them.
    pub members: Vec<(CharacterId, MemberInfo)>,
    /// The names its ghosts show, by id, and whether each is a bot.
    pub names: Vec<(EntityId, String, bool)>,
    /// Handed back: the latest tick a neighbour is on.
    pub tick: u64,
}

/// How a game trades at a point of a tick (`Barrier`) of tick `u64`: what it sends, and back what its
/// neighbours sent. The host's, over the post (host.rs); a game alone trades nothing.
pub type Trade<'a> = dyn FnMut(Barrier, u64, Parcels) -> Parcels + 'a;

/// A trade for a game alone: nothing goes, nothing comes.
pub fn alone(_: Barrier, _: u64, _: Parcels) -> Parcels {
    Parcels::default()
}

/// A game's side of its borders.
pub struct Side {
    pub border: Border,
    /// Handoffs made as the last tick ended (sent as the next begins).
    handing: Vec<Post>,
    /// Who went with handoffs not yet taken, by character.
    leaving: BTreeMap<CharacterId, MemberInfo>,
    /// The names of the ghosts here, by id, as their owners sent them.
    pub names: BTreeMap<EntityId, (String, bool)>,
    /// The server's bots are its own and don't cross (bots.rs): the engine's border asks for brains.
    no_bots: BTreeMap<usize, Bot>,
}

/// The rules' frames in a server tick.
const FRAMES: u32 = 60 / TICK_HZ;

impl Game {
    /// Plays part of its region beside others: `border` (its id and who owns which chunk), seating
    /// its own players in `seats` (each part of a region its own range, so a player keeps their slot
    /// wherever they cross to), its world holding its `chunks` and a band round them.
    pub fn play_part(&mut self, border: Border, seats: Range<usize>, chunks: &[(i32, i32)]) {
        self.players.seats = seats;
        self.open = OpenWorld::playing(world_map(), self.zone, chunks, SIM_BAND);
        self.border = Some(Side { border, handing: Vec::new(), leaving: BTreeMap::new(), names: BTreeMap::new(), no_bots: BTreeMap::new() });
    }

    /// Whether it plays part of its region beside others.
    pub fn is_part(&self) -> bool {
        self.border.is_some()
    }

    /// The names of what it sends ghosts of, for its neighbours to show them by.
    fn names_of(&self, posts: &[Post]) -> Vec<(EntityId, String, bool)> {
        let mut out = Vec::new();
        for p in posts {
            let Says::Ghosts(g) = &p.says else { continue };
            for gp in &g.players {
                match self.members.get(&gp.owner) {
                    Some(m) => out.push((gp.client, m.name.clone(), false)),
                    None => {
                        if let Some(n) = self.bot_name_of(gp.client) {
                            out.push((gp.client, n.to_string(), true));
                        }
                    }
                }
            }
        }
        out.sort();
        out.dedup();
        out
    }

    /// As a tick begins: the handoffs made as the last ended go to their takers and those made to
    /// this game are taken (everyone on the latest tick any of them is on), their gates told where
    /// their inputs go now; then who was taken, and ghosts of whoever changed hands.
    pub(super) fn border_begin(&mut self, trade: &mut Trade) {
        let Some(side) = self.border.as_mut() else { return };
        let posts = std::mem::take(&mut side.handing);
        let mut members = Vec::new();
        for p in &posts {
            if let Says::Handoff(h) = &p.says {
                for m in &h.players {
                    if let Some(c) = m.client.as_character()
                        && let Some(info) = side.leaving.get(&c)
                    {
                        members.push((c, info.clone()));
                    }
                }
            }
        }
        let got = trade(Barrier::Start, self.tick, Parcels { posts, members, ..Parcels::default() });
        self.tick = self.tick.max(got.tick);
        let infos: BTreeMap<CharacterId, MemberInfo> = got.members.into_iter().collect();
        let mut replies = Vec::new();
        for p in got.posts {
            let Says::Handoff(h) = p.says else { continue };
            let t = side.border.take_handoff(&mut self.players, &mut side.no_bots, world_map(), h);
            for &(_, client, _, from) in &t.players {
                let Some(c) = client.as_character() else { continue };
                let Some(info) = infos.get(&c) else { continue };
                if !self.members.contains_key(&c) {
                    let m = Member::from_info(info.clone());
                    // Their gate sends their inputs here now; their browser hears nothing.
                    self.said.push((m.conn, ToConn::Crossed { sim: self.sim, from }));
                    self.members.insert(c, m);
                }
                // What they built, solid here as everywhere they play.
                if let Some((_, _, Some(life))) = self.players.open_view(client) {
                    let state = life.state.clone();
                    make_solid(&mut self.open, c, &state);
                }
            }
            if !t.players.is_empty() {
                replies.push(Post { from: side.border.id, to: p.from, tick: self.tick, says: Says::Taken(t) });
            }
        }
        let mut posts = replies;
        posts.extend(side.border.ghosts_out(&self.players, &self.actors, self.tick, true, false));
        let names = self.names_of(&posts);
        let got = trade(Barrier::Arrived, self.tick, Parcels { posts, names, ..Parcels::default() });
        self.border_heard(got);
    }

    /// What neighbours said that this game takes in whenever it comes: taken handoffs, ghosts and
    /// the names they show.
    fn border_heard(&mut self, got: Parcels) {
        let Some(side) = self.border.as_mut() else { return };
        for (id, name, bot) in got.names {
            side.names.insert(id, (name, bot));
        }
        for p in got.posts {
            match p.says {
                Says::Taken(t) => {
                    side.border.taken(p.from, &t);
                    for (_, client, _, _) in &t.players {
                        if let Some(c) = client.as_character() {
                            side.leaving.remove(&c);
                        }
                    }
                }
                Says::Ghosts(g) => side.border.take_ghosts(&mut self.players, &mut self.actors, p.from, g),
                _ => {}
            }
        }
    }

    /// A phase's blows and heals landed: across its borders, those on what others own sent to them,
    /// what they dealt here landed among this game's own, and what's told of it all traded back.
    fn land_phase(&mut self, landing: &mut Landing, out: Barrier, told: Barrier, trade: &mut Trade) {
        let tick = self.tick;
        let Some(side) = self.border.as_mut() else {
            self.players.land(landing, &mut self.actors, Across::default());
            return;
        };
        self.players.send_away(landing, &self.actors);
        let posts = side.border.across_out(&self.players, landing, tick);
        let got = trade(out, tick, Parcels { posts, ..Parcels::default() });
        self.players.land(landing, &mut self.actors, Border::dealt(got.posts));
        let posts = side.border.told_out(&self.players, landing, tick);
        let got = trade(told, tick, Parcels { posts, ..Parcels::default() });
        Border::told_in(&self.players, landing, got.posts);
    }

    /// Everyone's inputs: worked out, landed (across borders too), told and credited, and what was
    /// built made solid.
    pub(super) fn inputs_phase(&mut self, trade: &mut Trade) {
        let stepping = &mut self.stepping;
        let mut landing = self.players.work_out(&self.actors, self.tick, &self.open, |jobs, step| stepping.run(jobs, step));
        self.land_phase(&mut landing, Barrier::Inputs, Barrier::InputsTold, trade);
        self.players.settle(landing, Vec::new(), Some(&mut self.open));
    }

    /// Arrows moved and meteors come down, landed (across borders too), told and credited.
    pub(super) fn effects_phase(&mut self, trade: &mut Trade) {
        let mut landing = self.players.fly_effects(&self.actors);
        self.land_phase(&mut landing, Barrier::Effects, Barrier::EffectsTold, trade);
        self.players.settle(landing, Vec::new(), None);
    }

    /// Ghosts traded at `at`: players if `players`, creatures if `creatures`.
    pub(super) fn ghosts_phase(&mut self, at: Barrier, players: bool, creatures: bool, trade: &mut Trade) {
        let tick = self.tick;
        let Some(side) = self.border.as_mut() else { return };
        let posts = side.border.ghosts_out(&self.players, &self.actors, tick, players, creatures);
        let names = self.names_of(&posts);
        let got = trade(at, tick, Parcels { posts, names, ..Parcels::default() });
        self.border_heard(got);
    }

    /// The creatures' frames, each seeing this game's players and the ghosts of others', their
    /// slams falling on everyone they reach and their blows on their targets' owners, landing in the
    /// order they fell. What they did, for the tick's records.
    pub(super) fn creatures_phase(&mut self, ground_at: &dyn Fn(f64, f64) -> f64, trade: &mut Trade) -> StepOut {
        let foes = self.players.foes();
        let mut done = StepOut::default();
        let (mut here, mut out) = (Struck::default(), BTreeMap::new());
        for frame in 0..FRAMES {
            let o = self.actors.step(&foes, ground_at, LEAN_SPRING, LEAN_DAMPING, 1.0 / 60.0);
            if let Some(side) = &self.border {
                side.border.struck_out(&self.players, frame, &o, &mut here, &mut out);
            }
            done.extend(o);
        }
        let tick = self.tick;
        match self.border.as_mut() {
            None => {
                self.players.apply_slams(&done.slams);
                self.players.apply_foe_hits(&done.hits);
            }
            Some(side) => {
                let from = side.border.id;
                let posts = out.into_iter().map(|(to, st)| Post { from, to, tick, says: Says::Struck(st) }).collect();
                let got = trade(Barrier::Struck, tick, Parcels { posts, ..Parcels::default() });
                let (slams, hits) = Border::struck_in(here, got.posts);
                self.players.apply_slams(&slams);
                self.players.apply_foe_hits(&hits);
            }
        }
        done
    }

    /// As a tick ends, once it's published: whoever of its own is past a border, handed over (the
    /// handoff goes as the next tick begins), their gates told to hold their inputs meanwhile. Who
    /// went where, for the host to send on whatever still comes here for them.
    pub fn border_end(&mut self) -> Vec<(CharacterId, SimId)> {
        let tick = self.tick;
        let Some(side) = self.border.as_mut() else { return Vec::new() };
        let posts = side.border.hand_over(&mut self.players, &mut side.no_bots, tick);
        let mut gone = Vec::new();
        for p in &posts {
            let Says::Handoff(h) = &p.says else { continue };
            for m in &h.players {
                let Some(c) = m.client.as_character() else { continue };
                if let Some(member) = self.members.remove(&c) {
                    self.said.push((member.conn, ToConn::Crossing));
                    side.leaving.insert(c, member.info());
                    gone.push((c, SimId(p.to.0)));
                }
            }
        }
        side.handing.extend(posts);
        gone
    }
}
