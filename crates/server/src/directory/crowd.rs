//! The channels' crowd of bots (crates/channels/src/crowd.rs) played against the directory itself:
//! its claims and releases, its parties, its moves between channels as messages, its channels'
//! simulations started and stopped. The simulations are stand-ins: each takes what the directory
//! sends it and answers as a simulation would (a player handed over is placed where the grant says,
//! a stopped one goes). The crowd's clock is the directory's, so a minute's quiet passes in a step.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};

use ruina_channels::crowd::{Arena, Crowd, Plan, Tally};
use ruina_channels::{Action, ChannelNo, Follow, Merge, Placed, Refusal, Social, Standing, Target, Ties, Tuning};
use ruina_world_api::directory::ToDirectory;
use ruina_world_api::gate::{ToConn, ToGate};
use ruina_world_api::sim::{After, ToSim};
use ruina_world_api::{CharacterId, Conn, GateId, Millis, PartyId, SimId, SpaceId};

use super::leases::MemoryLeases;
use super::{Directory, SimSetup, Spawner};
use crate::post::Post;
use crate::store::Db;
use crate::store::memory::Tables;

/// Some moment on the world's clock.
const START: Millis = 1_793_000_000_000;

/// Simulations started, and their mailboxes.
#[derive(Default)]
struct Started {
    spaces: BTreeMap<SimId, SpaceId>,
    inboxes: BTreeMap<SimId, std_mpsc::Receiver<ToSim>>,
}

/// Starts stand-ins: a mailbox each, read by the arena.
struct StandIns {
    post: Arc<Post>,
    started: Arc<Mutex<Started>>,
}

impl Spawner for StandIns {
    fn start(&self, setup: SimSetup) {
        let inbox = self.post.open_sim(setup.lease.sim);
        let mut s = self.started.lock().unwrap();
        s.spaces.insert(setup.lease.sim, setup.lease.space.clone());
        s.inboxes.insert(setup.lease.sim, inbox);
    }
}

/// What the directory said back while one thing was done.
#[derive(Default)]
struct Heard {
    actions: Vec<Action>,
    errors: BTreeMap<CharacterId, String>,
    notices: BTreeMap<CharacterId, Vec<String>>,
}

/// The directory, its stand-in simulations and the gate's mailbox, played by a crowd.
pub struct DirArena {
    rt: tokio::runtime::Runtime,
    pub dir: Directory<MemoryLeases>,
    post: Arc<Post>,
    gate: tokio::sync::mpsc::UnboundedReceiver<ToGate>,
    started: Arc<Mutex<Started>>,
    tables: Arc<Mutex<Tables>>,
    /// Simulations the arena has seen start, and those stopped.
    known: BTreeSet<SimId>,
    stopped: BTreeSet<SimId>,
    /// Where each bot plays, as the stand-ins have it.
    seats: BTreeMap<CharacterId, SimId>,
    /// Each bot's party, as the directory was last told.
    told: BTreeMap<CharacterId, Option<u64>>,
    region: String,
}

fn conn(who: CharacterId) -> Conn {
    Conn { gate: GateId(1), character: who, session: 1 }
}

/// The refusal a sentence says.
fn refusal_of(text: &str) -> Refusal {
    let all = [
        Refusal::NotHere,
        Refusal::Here,
        Refusal::WithParty,
        Refusal::NoParty,
        Refusal::PartyAway,
        Refusal::NoChannel,
        Refusal::Closing,
        Refusal::Full,
        Refusal::Pack,
        Refusal::Combat,
        Refusal::Riding,
        Refusal::Airborne,
        Refusal::AtTable,
    ];
    if text.starts_with("You can change channel again in") {
        return Refusal::Wait { ms: 1 };
    }
    all.into_iter().find(|r| r.sentence() == text).unwrap_or_else(|| panic!("no refusal says {text:?}"))
}

impl DirArena {
    pub fn new(tuning: Tuning) -> DirArena {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a runtime");
        let post = Post::new();
        let gate = post.open_gate(GateId(1));
        let started = Arc::new(Mutex::new(Started::default()));
        let (db, tables) = Db::memory();
        let spawner = Arc::new(StandIns { post: post.clone(), started: started.clone() });
        let mut dir = Directory::new(post.clone(), db, MemoryLeases::default(), spawner);
        dir.tuning = tuning;
        let region = crate::open::map::world_map().regions().first().expect("a region").id.clone();
        DirArena {
            rt,
            dir,
            post,
            gate,
            started,
            tables,
            known: BTreeSet::new(),
            stopped: BTreeSet::new(),
            seats: BTreeMap::new(),
            told: BTreeMap::new(),
            region,
        }
    }

    fn send(&mut self, msg: ToDirectory) {
        let dir = &mut self.dir;
        self.rt.block_on(dir.handle(msg));
    }

    fn space_of(&self, sim: SimId) -> Option<SpaceId> {
        self.started.lock().unwrap().spaces.get(&sim).cloned()
    }

    fn channel_n(space: &SpaceId) -> ChannelNo {
        match space {
            SpaceId::Channel { n, .. } => *n,
            SpaceId::Copy { .. } => 0,
        }
    }

    /// The simulations still running, by the spaces they play.
    pub fn running(&self) -> Vec<SpaceId> {
        let s = self.started.lock().unwrap();
        s.spaces.iter().filter(|(sim, _)| !self.stopped.contains(sim)).map(|(_, space)| space.clone()).collect()
    }

    /// Tells the directory the parties as the crowd has them now, where they changed, as the social
    /// tier would (with who leads each).
    fn sync_parties(&mut self, ties: &Social) {
        let mut everyone: BTreeSet<CharacterId> = self.told.keys().copied().collect();
        for p in ties.parties() {
            everyone.extend(p.members.iter().copied());
        }
        let mut changed = Vec::new();
        let mut leaders = Vec::new();
        for c in everyone {
            let now = ties.party_id(c);
            if self.told.get(&c).copied().flatten() != now || !self.told.contains_key(&c) {
                changed.push((c, now.map(PartyId)));
                if let (Some(p), Some(t)) = (now, ties.party(c)) {
                    leaders.push((PartyId(p), t.leader));
                }
                self.told.insert(c, now);
            }
        }
        if !changed.is_empty() {
            leaders.sort();
            leaders.dedup();
            self.send(ToDirectory::Parties { changed, hand: Vec::new(), leaders });
        }
    }

    /// Plays out everything sent meanwhile, as the stand-ins and the gate take it: players handed
    /// over placed where their grant says, stopped simulations gone; what happened, as the policy's
    /// actions, and what each bot was told.
    fn settle(&mut self) -> Heard {
        let mut heard = Heard::default();
        loop {
            let mut quiet = true;
            // Simulations started since.
            let new: Vec<(SimId, SpaceId)> = {
                let s = self.started.lock().unwrap();
                s.spaces.iter().filter(|(sim, _)| !self.known.contains(sim)).map(|(sim, sp)| (*sim, sp.clone())).collect()
            };
            for (sim, space) in new {
                self.known.insert(sim);
                if let SpaceId::Channel { n, .. } = space {
                    heard.actions.push(Action::Open { n });
                }
            }
            // What the simulations were sent.
            let mail: Vec<(SimId, ToSim)> = {
                let s = self.started.lock().unwrap();
                s.inboxes.iter().flat_map(|(sim, rx)| rx.try_iter().map(move |m| (*sim, m)).collect::<Vec<_>>()).collect()
            };
            for (sim, m) in mail {
                quiet = false;
                match m {
                    ToSim::Hand { character, to, after } => {
                        let from = self.space_of(sim).map_or(0, |s| Self::channel_n(&s));
                        let why = after.iter().find_map(|a| if let After::Channel { why, .. } = a { Some(*why) } else { None }).expect("why they move");
                        self.seats.insert(character, to.sim);
                        heard.actions.push(Action::Move { who: character, from, to: Self::channel_n(&to.space), why });
                        self.send(ToDirectory::Placed { character, space: to.space, sim: to.sim });
                    }
                    ToSim::Stop => {
                        self.stopped.insert(sim);
                        self.post.close_sim(sim);
                        let n = self.space_of(sim).map_or(0, |s| Self::channel_n(&s));
                        heard.actions.push(Action::Close { n, into: 0 });
                    }
                    _ => {}
                }
            }
            // What the bots' browsers were told.
            while let Ok(m) = self.gate.try_recv() {
                if let ToGate::Conn { conn, msg } = m {
                    match msg {
                        ToConn::Error { text } => {
                            heard.errors.insert(conn.character, text);
                        }
                        ToConn::Notice { text } => heard.notices.entry(conn.character).or_default().push(text),
                        _ => {}
                    }
                }
            }
            if quiet {
                return heard;
            }
        }
    }

    /// A bot's way in, as the gate makes it: the directory's claim, and the simulation it names
    /// taking them in.
    fn claim(&mut self, who: CharacterId) -> (ChannelNo, SimId) {
        {
            let mut t = Db::tables(&self.tables);
            if !t.characters.contains_key(&who) {
                t.add_character(who, &format!("Bot{who}"));
            }
        }
        self.send(ToDirectory::Claim { conn: conn(who), name: format!("Bot{who}") });
        let mut claimed = None;
        while let Ok(m) = self.gate.try_recv() {
            if let ToGate::Conn { conn: c, msg: ToConn::Claimed(cl) } = m
                && c.character == who
            {
                claimed = Some(*cl);
            }
        }
        let cl = claimed.unwrap_or_else(|| panic!("bot {who} was claimed"));
        self.seats.insert(who, cl.sim);
        self.send(ToDirectory::Placed { character: who, space: cl.space.clone(), sim: cl.sim });
        (cl.channel, cl.sim)
    }

    /// What each channel's simulation would say its players are doing.
    fn send_standings(&mut self, standing: &dyn Fn(CharacterId) -> Standing, now: Millis) {
        let calm = self.dir.tuning.calm_after_ms();
        let mut by_sim: BTreeMap<SimId, Vec<(CharacterId, Standing)>> = BTreeMap::new();
        for (who, sim) in &self.seats {
            let s = standing(*who);
            if s.hindrance(now, &self.dir.tuning).is_some() || s.fought.is_some_and(|f| now - f < calm) {
                by_sim.entry(*sim).or_default().push((*who, s));
            }
        }
        let sims: Vec<SimId> = self.known.iter().filter(|s| !self.stopped.contains(s)).copied().collect();
        for sim in sims {
            let standings = by_sim.remove(&sim).unwrap_or_default();
            self.send(ToDirectory::Standings { sim, standings });
        }
    }

    fn region(&self) -> Option<&ruina_channels::Region> {
        self.dir.region(&self.region)
    }
}

impl Arena for DirArena {
    fn arrive(&mut self, who: CharacterId, ties: &Social, now: Millis) -> Placed {
        self.dir.clock = Some(now);
        self.sync_parties(ties);
        let why = self.dir.placing(who).why;
        let (n, _) = self.claim(who);
        self.settle();
        Placed { n, why }
    }

    fn leave(&mut self, who: CharacterId, now: Millis) {
        self.dir.clock = Some(now);
        self.send(ToDirectory::Release { conn: conn(who) });
        self.seats.remove(&who);
        self.settle();
    }

    fn change(&mut self, who: CharacterId, to: Target, standing: &Standing, ties: &Social, now: Millis) -> Result<Action, Refusal> {
        self.dir.clock = Some(now);
        self.sync_parties(ties);
        let from = self.seats[&who];
        self.send(ToDirectory::Change { conn: conn(who), from, to, standing: *standing, dev: false });
        let heard = self.settle();
        if let Some(text) = heard.errors.get(&who) {
            return Err(refusal_of(text));
        }
        heard.actions.into_iter().find(|a| matches!(a, Action::Move { who: w, .. } if *w == who)).ok_or(Refusal::NotHere)
    }

    fn joined_party(&mut self, who: CharacterId, standing: &Standing, ties: &Social, now: Millis) -> Follow {
        self.dir.clock = Some(now);
        let s = *standing;
        self.send_standings(&|w| if w == who { s } else { Standing::default() }, now);
        self.sync_parties(ties);
        let heard = self.settle();
        if let Some(a) = heard.actions.into_iter().find(|a| matches!(a, Action::Move { who: w, .. } if *w == who)) {
            return Follow::Now(a);
        }
        let waiting = heard
            .notices
            .get(&who)
            .and_then(|n| n.iter().find_map(|t| t.strip_prefix("You'll join your party's channel as soon as you can. ")).map(refusal_of));
        waiting.map_or(Follow::Stay, Follow::Later)
    }

    fn left_party(&mut self, _who: CharacterId, ties: &Social) {
        self.sync_parties(ties);
        self.settle();
    }

    fn review(&mut self, now: Millis, ties: &Social, standing: &dyn Fn(CharacterId) -> Standing) -> Vec<Action> {
        self.dir.clock = Some(now);
        self.sync_parties(ties);
        self.send_standings(standing, now);
        let before = self.region().and_then(|r| r.merge());
        let dir = &mut self.dir;
        self.rt.block_on(dir.review(now));
        let mut actions = self.settle().actions;
        if let Some(m) = self.region().and_then(|r| r.merge())
            && before != Some(m)
        {
            actions.push(Action::Merging { from: m.from, into: m.into, at: m.moves_at });
        }
        actions
    }

    fn channel_of(&self, who: CharacterId) -> Option<ChannelNo> {
        self.region().and_then(|r| r.channel_of(who))
    }

    fn channels(&self) -> Vec<(ChannelNo, usize)> {
        self.region().map(|r| r.channels().map(|c| (c.n, c.players.len())).collect()).unwrap_or_default()
    }

    fn merge(&self) -> Option<Merge> {
        self.region().and_then(|r| r.merge())
    }

    fn tuning(&self) -> &Tuning {
        &self.dir.tuning
    }
}

/// `plan`'s crowd played against the directory with `t`, start to end.
fn played(plan: Plan, t: &Tuning) -> (Tally, DirArena) {
    let mut arena = DirArena::new(t.clone());
    let mut crowd = Crowd::new(plan, START);
    let length = crowd.plan.length(t);
    let tally = crowd.run(&mut arena, length).clone();
    (tally, arena)
}

#[test]
fn a_crowd_fills_the_directorys_channels_keeps_its_parties_together_and_they_merge_back() {
    let t = Tuning::small();
    let (tally, arena) = played(Plan::small(1), &t);
    assert_eq!(tally.broken, Vec::<String>::new(), "{tally:#?}");
    // It filled: channels opened for it, each a simulation started.
    assert!(tally.peak_channels >= 4, "{tally:#?}");
    assert!(tally.fullest <= t.hard_cap);
    // Parties came together, and joined one another's channels by invitation.
    assert!(tally.placed.get("Party").copied().unwrap_or(0) > 20, "{tally:#?}");
    assert!(tally.moved.get("Party").copied().unwrap_or(0) > 0, "{tally:#?}");
    assert!(tally.moved.get("Choice").copied().unwrap_or(0) > 0, "{tally:#?}");
    // It thinned: quiet channels merged, their players moved across, until one was left playing.
    assert!(tally.merges >= 1 && tally.moved.get("Merge").copied().unwrap_or(0) > 0, "{tally:#?}");
    assert_eq!(tally.left_open, 1, "{tally:#?}");
    let running: Vec<SpaceId> = arena.running().into_iter().filter(|s| !s.is_copy()).collect();
    assert_eq!(running.len(), 1, "one channel's simulation still running: {running:?}");
}

#[test]
fn arrivals_together_fill_channels_in_turn() {
    // Ten come in at the same moment, as a tick's worth of connections would: each placement is
    // counted before the next is made, so no channel is filled past its soft cap of three.
    let t = Tuning { soft_cap: 3, hard_cap: 4, open_ahead: 0, quiet: 2, merge_fill: 2, ..Tuning::small() };
    assert_eq!(t.check(), Ok(()));
    let mut arena = DirArena::new(t);
    arena.dir.clock = Some(START);
    let placed: Vec<ChannelNo> = (1..=10).map(|who| arena.claim(who).0).collect();
    assert_eq!(placed, vec![1, 1, 1, 2, 2, 2, 3, 3, 3, 4]);
    arena.settle();
    let mut running: Vec<String> = arena.running().iter().map(|s| s.to_string()).collect();
    running.sort();
    assert_eq!(running, ["channel:emberholm:1", "channel:emberholm:2", "channel:emberholm:3", "channel:emberholm:4"]);
    // Someone back a moment later goes back where they were, past the soft cap if need be.
    arena.leave(2, START + 1_000);
    arena.claim(11);
    assert_eq!(arena.claim(2).0, 1);
}
