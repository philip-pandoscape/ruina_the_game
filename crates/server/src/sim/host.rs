//! A simulation's thread. It owns its game alone, takes its mail at tick boundaries (and waits for
//! mail while nobody is there and no mini-game goes on), steps the game 20 times a second, sends
//! what each tick produced to the gates its players are connected through, and writes lives through
//! the store. Moving a player to another space (a dungeon's portal, a way out, a developer zone) goes
//! through the directory, which says where and grants them there under a newer epoch; the player is
//! then handed over whole, their connection, player and life in one message (`ToSim::Transfer`), and
//! what still comes here for them is sent on.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::mpsc as std_mpsc;
use std::time::{Duration, Instant};

use ruina_world_api::directory::Destination;
use ruina_world_api::gate::{ToConn, ToGate};
use ruina_world_api::records::TickOut;
use ruina_world_api::sim::{After, Arrival, Ask, Entry, LeaseNote, Moving, Spot, ToSim};
use ruina_world_api::store::{LifeWrite, Then, ToStore};
use ruina_world_api::{CharacterId, Conn, GateId, Owner, SimId, SpaceId, TICK_HZ, Transport};

use super::Game;
use crate::directory::{COPY_KEPT, SimSetup, Spawner};
use crate::open::dungeon::{door_into, dungeon};
use crate::post::Post;
use crate::skills::saved_build;
use crate::store::now_ms;

/// How long mail for someone handed on is sent on after them.
const FORWARD_FOR: Duration = Duration::from_secs(30);
/// How long an empty simulation sleeps before it looks round again (its copy may be put out).
const IDLE: Duration = Duration::from_secs(1);

/// Someone on their way somewhere, until the directory says where: where they come in there, what
/// happens then, and whether they must still be free to go.
struct Route {
    entry: Entry,
    after: Vec<After>,
    free: bool,
}

pub struct Sim {
    pub id: SimId,
    pub game: Game,
    inbox: std_mpsc::Receiver<ToSim>,
    post: Arc<dyn Transport>,
    /// A channel's residents aren't read yet: arrivals wait for them.
    residents: bool,
    waiting: Vec<Arrival>,
    routing: HashMap<CharacterId, Route>,
    /// Lives of characters who left while on their way: written once the directory has answered,
    /// under the grant it made.
    held: HashMap<CharacterId, LifeWrite>,
    /// Where characters handed on went, and when: mail for them is sent on.
    gone: HashMap<CharacterId, (SimId, Instant)>,
    /// A copy's occupancy as last told to the directory.
    told: Option<(usize, bool)>,
    period: Duration,
}

impl Sim {
    /// A simulation for its lease's space.
    pub fn new(setup: SimSetup, inbox: std_mpsc::Receiver<ToSim>, post: Arc<dyn Transport>) -> Sim {
        let lease = setup.lease;
        let mut game = match &lease.space {
            SpaceId::Channel { region, n } => Game::channel(lease.sim, region, *n),
            SpaceId::Copy { instance, n } => {
                let def = dungeon(instance).unwrap_or_else(|| panic!("no instance {instance:?}"));
                Game::copy(lease.sim, def, *n, setup.owner.unwrap_or(Owner::Everyone))
            }
        };
        game.lease = lease.epoch;
        if let Some(c) = game.copy_mut() {
            c.expel_after = setup.expel_after;
        }
        let residents = match &lease.space {
            SpaceId::Channel { n, .. } => {
                post.store(ToStore::LoadResidents { channel: *n, reply: lease.sim });
                false
            }
            SpaceId::Copy { .. } => true,
        };
        Sim {
            id: lease.sim,
            game,
            inbox,
            post,
            residents,
            waiting: Vec::new(),
            routing: HashMap::new(),
            held: HashMap::new(),
            gone: HashMap::new(),
            told: None,
            period: Duration::from_secs_f64(1.0 / f64::from(TICK_HZ)),
        }
    }

    /// Plays until told to stop: mail at each tick boundary, then a tick while anyone is here.
    pub fn run(mut self) {
        let mut next = Instant::now() + self.period;
        loop {
            let busy = self.game.has_players() || self.game.has_tables();
            if !busy {
                // Nothing to play: wait for mail (or a while, to look round).
                match self.inbox.recv_timeout(IDLE) {
                    Ok(msg) => {
                        if !self.handle_safely(msg) {
                            return;
                        }
                    }
                    Err(std_mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std_mpsc::RecvTimeoutError::Disconnected) => return,
                }
                if !self.drain() {
                    return;
                }
                self.flush();
                next = Instant::now() + self.period;
                continue;
            }
            if !self.drain() {
                return;
            }
            // One bad moment mustn't stop the simulation.
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.tick())).is_err() {
                eprintln!("simulation {} ({}) failed a tick", self.id.0, self.game.at);
            }
            self.flush();
            let now = Instant::now();
            if next > now {
                std::thread::sleep(next - now);
                next += self.period;
            } else {
                next = now + self.period;
            }
        }
    }

    /// Takes every message waiting. False once told to stop.
    fn drain(&mut self) -> bool {
        loop {
            match self.inbox.try_recv() {
                Ok(msg) => {
                    if !self.handle_safely(msg) {
                        return false;
                    }
                }
                Err(std_mpsc::TryRecvError::Empty) => return true,
                Err(std_mpsc::TryRecvError::Disconnected) => return false,
            }
        }
    }

    fn handle_safely(&mut self, msg: ToSim) -> bool {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.handle(msg))) {
            Ok(go_on) => go_on,
            Err(_) => {
                eprintln!("simulation {} ({}) failed a message", self.id.0, self.game.at);
                true
            }
        }
    }

    /// One tick: the game stepped, its records to the gates, whoever doesn't belong in a copy put
    /// out in time.
    pub fn tick(&mut self) {
        let out = self.game.step();
        self.publish(out);
        for who in self.game.sweep_copy(Instant::now()) {
            self.out_of_copy(who, Vec::new());
        }
        self.gone.retain(|_, (_, at)| at.elapsed() < FORWARD_FOR);
    }

    /// A tick's records, to every gate a player here is connected through.
    fn publish(&self, out: TickOut) {
        let mut gates: Vec<GateId> = self.game.members.values().map(|m| m.conn.gate).collect();
        gates.sort();
        gates.dedup();
        if gates.is_empty() {
            return;
        }
        let out = Arc::new(out);
        for g in gates {
            self.post.gate(g, ToGate::Tick(out.clone()));
        }
    }

    /// What the game said and the lives it wants written, sent; a copy's occupancy, when it changed.
    pub fn flush(&mut self) {
        for (conn, msg) in self.game.said.drain(..) {
            self.post.conn(conn, msg);
        }
        for (writes, then) in self.game.writes.drain(..) {
            self.post.store(ToStore::WriteLives { writes, then });
        }
        if let Some(c) = self.game.copy_of() {
            let now = (self.game.members.len(), c.empty_since.is_some());
            if self.told != Some(now) {
                self.told = Some(now);
                let empty_since = c.empty_since.map(|t| now_ms() - t.elapsed().as_millis() as i64);
                self.post.directory(ruina_world_api::directory::ToDirectory::Occupancy { space: self.game.at.clone(), inside: now.0, empty_since });
            }
        }
    }

    /// One message. False to stop.
    pub fn handle(&mut self, msg: ToSim) -> bool {
        match msg {
            ToSim::Arrive(a) => {
                if self.residents {
                    self.arrive(*a);
                } else {
                    self.waiting.push(*a);
                }
            }
            ToSim::Depart { conn } => {
                let c = conn.character;
                if self.game.members.contains_key(&c) {
                    if let Some(w) = self.game.leave(conn) {
                        if self.routing.contains_key(&c) {
                            self.held.insert(c, w);
                        } else {
                            self.post.store(ToStore::WriteLives { writes: vec![w], then: Then::Nothing });
                        }
                    }
                } else if let Some((sim, _)) = self.gone.get(&c) {
                    self.post.sim(*sim, ToSim::Depart { conn });
                }
            }
            ToSim::Inputs { conn, inputs } => {
                let c = conn.character;
                match self.game.members.get(&c) {
                    Some(m) if m.conn == conn => self.game.inputs_seen(c, inputs.into_iter().map(|i| (i.seq, i.view, i.raw))),
                    Some(_) => {}
                    None => {
                        if let Some((sim, _)) = self.gone.get(&c) {
                            self.post.sim(*sim, ToSim::Inputs { conn, inputs });
                        }
                    }
                }
            }
            ToSim::Ask { conn, ask } => {
                let c = conn.character;
                match self.game.members.get(&c) {
                    Some(m) if m.conn == conn => {
                        if let Err(text) = self.ask(conn, ask) {
                            self.post.conn(conn, ToConn::Error { text });
                        }
                    }
                    Some(_) => {}
                    None => match self.gone.get(&c) {
                        Some((sim, _)) => {
                            self.post.sim(*sim, ToSim::Ask { conn, ask });
                        }
                        None => {
                            self.post.conn(conn, ToConn::Error { text: "You aren't playing.".into() });
                        }
                    },
                }
            }
            ToSim::Routed { character, to, why: _ } => self.routed(character, to),
            ToSim::Unrouted { character, text } => {
                self.routing.remove(&character);
                if let Some(w) = self.held.remove(&character) {
                    self.post.store(ToStore::WriteLives { writes: vec![w], then: Then::Nothing });
                }
                self.game.say(character, ToConn::Error { text });
            }
            ToSim::Transfer(m) => self.adopt(*m),
            ToSim::Returned { moving, text } => {
                let m = *moving;
                let p = m.carried.player.pos;
                let at = Spot { x: p.x, y: p.y, z: p.z, facing: m.carried.player.facing };
                let conn = m.member.conn;
                self.game.put(m.member, m.carried, at);
                self.gone.remove(&m.character);
                self.post.conn(conn, ToConn::Error { text });
                self.placed(m.character);
            }
            ToSim::Parties { changed, owner } => self.game.parties(&changed, owner),
            ToSim::Residents(list) => {
                for r in list {
                    self.game.add_resident(r.character, &r.name, &r.state);
                }
                self.game.estates.loaded = true;
                self.residents = true;
                for a in std::mem::take(&mut self.waiting) {
                    self.arrive(a);
                }
            }
            ToSim::ResidentGone { character } => self.game.remove_resident(character),
            ToSim::Estates { conn } => {
                self.post.conn(conn, ToConn::Estates(self.game.estates_for(conn.character)));
            }
            ToSim::SaveAll { reply } => {
                let writes = self.game.lives_now();
                self.post.store(ToStore::WriteLives { writes, then: Then::Answer(reply) });
            }
            ToSim::Lease(LeaseNote::Lost { epoch }) => {
                // One process carries on (nobody else plays its spaces); among several this stops.
                eprintln!("simulation {} lost its lease on {} (epoch {})", self.id.0, self.game.at, epoch.0);
            }
            ToSim::Lease(LeaseNote::Renewed { epoch, .. }) => self.game.lease = epoch,
            ToSim::Stop => {
                // Whoever left with a game paid out since: written as the copy closes.
                let writes: Vec<LifeWrite> = self.game.lives_now();
                if !writes.is_empty() {
                    self.post.store(ToStore::WriteLives { writes, then: Then::Nothing });
                }
                return false;
            }
        }
        true
    }

    /// Someone comes in from their connection: in, their welcome's parts back to them.
    fn arrive(&mut self, a: Arrival) {
        let conn = a.conn;
        let (estates, build) = self.game.join(a);
        self.gone.remove(&conn.character);
        self.post.conn(conn, ToConn::Arrived { space: self.game.space_view(), build, estates });
        self.placed(conn.character);
    }

    /// The directory hears where someone is now.
    fn placed(&self, character: CharacterId) {
        self.post.directory(ruina_world_api::directory::ToDirectory::Placed { character, space: self.game.at.clone(), sim: self.id });
    }

    /// What a player asks of their game. Err: why not, for them.
    fn ask(&mut self, conn: Conn, ask: Ask) -> Result<(), String> {
        let c = conn.character;
        match ask {
            Ask::Command { seq, command } => {
                if !self.game.command(c, seq, command) {
                    return Err("That isn't allowed here.".into());
                }
            }
            Ask::Build { build } => {
                // Checked against the skill points this character has earned so far, and kept by id.
                let b = self.game.set_build(c, &build).ok_or("That build isn't allowed.")?;
                let epoch = self.game.members.get(&c).map(|m| m.epoch).unwrap_or_default();
                self.post.store(ToStore::WriteBuild { character: c, epoch, build: saved_build(&b) });
            }
            // Starting a life over is a developer command: an admin's only.
            Ask::Reset if !self.game.members.get(&c).is_some_and(|m| m.dev) => {}
            Ask::Reset => {
                if self.game.copy_of().is_some() {
                    // A fresh life starts at the region's spawn, which isn't in here: out first.
                    self.out_of_copy(c, vec![After::Reset]);
                } else {
                    self.reset(conn);
                }
            }
            Ask::Challenge { to, game, stake, seed, turn } => self.game.challenge_timed(c, to, game, stake, seed, turn)?,
            Ask::Withdraw => self.game.withdraw(c),
            Ask::Answer { from, accept } => self.game.answer(c, from, accept)?,
            Ask::Move { table, m } => self.game.table_move(c, table, &m)?,
            Ask::Concede { table } => self.game.concede(c, table)?,
            Ask::Dungeon { id, enter: true } => self.enter_dungeon(c, &id)?,
            Ask::Dungeon { enter: false, .. } => self.leave_dungeon(c)?,
            Ask::Zone { id, team } => self.enter_zone(c, &id, team)?,
        }
        Ok(())
    }

    /// Starts someone's life over here, and writes it (their browser hears `reset` once it's written).
    fn reset(&mut self, conn: Conn) {
        if let Some(w) = self.game.reset(conn.character) {
            self.post.store(ToStore::WriteLives { writes: vec![w], then: Then::Reset(conn) });
        }
    }

    /// Through a dungeon's portal: into the copy that's theirs (their party's, or theirs alone).
    fn enter_dungeon(&mut self, c: CharacterId, id: &str) -> Result<(), String> {
        let def = dungeon(id).ok_or("There's no such place.")?;
        let door = door_into(&def.id).ok_or("There's no way into that from here.")?;
        if self.game.copy_of().is_some() {
            return Err("You're in a dungeon already.".into());
        }
        let (x, y, z, free) = self.game.whereabouts(c).ok_or("You aren't playing.")?;
        if !door.portal.reaches(x, y, z) {
            return Err(format!("You're too far from the way into {}.", def.name));
        }
        if !free {
            return Err("Put down what you're carrying and get your feet on the ground first.".into());
        }
        self.route(c, Destination::Copy { instance: def.id.clone(), zone: false }, Entry::Entrance, Vec::new(), true);
        Ok(())
    }

    /// Out through a copy's way out, back to their home channel outside its door.
    fn leave_dungeon(&mut self, c: CharacterId) -> Result<(), String> {
        let copy = self.game.copy_of().ok_or("You aren't in a dungeon.")?;
        let (x, y, z, _) = self.game.whereabouts(c).ok_or("You aren't playing.")?;
        if !copy.def.at_exit(x, y, z) {
            return Err("You're too far from the way out.".into());
        }
        let name = copy.def.name.clone();
        let kept = COPY_KEPT.as_secs() / 60;
        self.out_of_copy(c, vec![After::Notice(format!("{name} is kept as you left it for {kept} minutes after everyone has gone."))]);
        Ok(())
    }

    /// Into a developer zone, from the Admin menu: admins only. A zone everyone shares (the
    /// battlefield) has one copy for all of them; any other, one for each party, as a dungeon has.
    /// Out again through its way out, as from a dungeon, at its own door.
    fn enter_zone(&mut self, c: CharacterId, id: &str, team: Option<u8>) -> Result<(), String> {
        let admin = self.game.members.get(&c).is_some_and(|m| m.dev);
        if !admin {
            return Err("Only an admin can go there.".into());
        }
        let def = dungeon(id).filter(|d| d.developer).ok_or("There's no such place.")?;
        def.door.as_ref().ok_or("That place has no way out.")?;
        // There already: onto the side asked for.
        if self.game.copy_of().is_some_and(|cp| cp.def.id == def.id) {
            self.game.take_side(c, team);
            return Ok(());
        }
        let a = def.arrival();
        let at = Spot { x: a.x, y: a.y, z: a.z, facing: a.facing };
        self.route(c, Destination::Copy { instance: def.id.clone(), zone: true }, Entry::At(at), vec![After::Side(team)], false);
        Ok(())
    }

    /// Out of the copy someone is in, to their home channel, outside its door.
    fn out_of_copy(&mut self, c: CharacterId, after: Vec<After>) {
        let Some(at) = self.game.outside() else { return };
        self.route(c, Destination::Home, Entry::At(at), after, false);
    }

    /// Asks the directory where `c` goes; they're handed over when it answers.
    fn route(&mut self, c: CharacterId, to: Destination, entry: Entry, after: Vec<After>, free: bool) {
        if self.routing.contains_key(&c) {
            return;
        }
        self.routing.insert(c, Route { entry, after, free });
        self.post.directory(ruina_world_api::directory::ToDirectory::Route { character: c, from: self.id, to });
    }

    /// The directory's answer: hand them over, under the grant it made there.
    fn routed(&mut self, character: CharacterId, to: ruina_world_api::directory::Grant) {
        let Some(r) = self.routing.remove(&character) else { return };
        if let Some(mut w) = self.held.remove(&character) {
            // They left on the way: their life is written under the new grant, and they stay where
            // they were (the directory hears so).
            w.epoch = to.epoch;
            self.post.store(ToStore::WriteLives { writes: vec![w], then: Then::Nothing });
            self.placed(character);
            return;
        }
        if r.free && !self.game.whereabouts(character).is_some_and(|w| w.3) {
            if let Some(m) = self.game.members.get_mut(&character) {
                m.epoch = to.epoch;
            }
            self.game.say(character, ToConn::Error { text: "Put down what you're carrying and get your feet on the ground first.".into() });
            self.placed(character);
            return;
        }
        let Some((member, carried)) = self.game.take(character) else {
            self.placed(character);
            return;
        };
        let mut info = member.info();
        info.epoch = to.epoch;
        let moving = Box::new(Moving { character, member: info, carried, entry: r.entry, after: r.after, from: self.id });
        match self.post.transfer(to.sim, moving) {
            Ok(()) => {
                self.gone.insert(character, (to.sim, Instant::now()));
            }
            Err(m) => {
                // Nobody there to take them (it stopped): back where they were.
                eprintln!("simulation {} for {} wasn't there to take character {character}", to.sim.0, to.space);
                let p = m.carried.player.pos;
                let at = Spot { x: p.x, y: p.y, z: p.z, facing: m.carried.player.facing };
                let conn = m.member.conn;
                self.game.put(m.member, m.carried, at);
                self.post.conn(conn, ToConn::Error { text: "That place is gone.".into() });
                self.placed(character);
            }
        }
    }

    /// Someone handed over from another simulation: in, standing where they come in, and told
    /// where they are; or back where they came from if there's no room.
    fn adopt(&mut self, m: Moving) {
        let character = m.character;
        if let Some(c) = self.game.copy_of()
            && !self.game.members.contains_key(&character)
            && self.game.headcount() >= c.def.max_players
        {
            let text = format!("{} is full.", c.def.name);
            let from = m.from;
            self.post.sim(from, ToSim::Returned { moving: Box::new(m), text });
            return;
        }
        let Moving { member, carried, entry, after, .. } = m;
        let at = match entry {
            Entry::At(s) => s,
            Entry::Entrance => {
                self.game.arrival().unwrap_or(Spot { x: carried.player.pos.x, y: carried.player.pos.y, z: carried.player.pos.z, facing: carried.player.facing })
            }
        };
        let conn = member.conn;
        self.game.put(member, carried, at);
        self.gone.remove(&character);
        self.post.conn(conn, ToConn::Moved { sim: self.id, space: self.game.space_view() });
        for a in after {
            match a {
                After::Reset => self.reset(conn),
                After::Side(team) => self.game.take_side(character, team),
                After::Notice(text) => {
                    self.post.conn(conn, ToConn::Notice { text });
                }
            }
        }
        self.placed(character);
    }
}

/// Starts each simulation on a thread of its own, its mailbox opened in the post first.
pub struct Threads {
    pub post: Arc<Post>,
}

impl Spawner for Threads {
    fn start(&self, setup: SimSetup) {
        let id = setup.lease.sim;
        let inbox = self.post.open_sim(id);
        let post = self.post.clone();
        let name = format!("sim-{}", id.0);
        std::thread::Builder::new()
            .name(name)
            .spawn(move || {
                let transport: Arc<dyn Transport> = post.clone();
                Sim::new(setup, inbox, transport).run();
                post.close_sim(id);
            })
            .expect("start a simulation's thread");
    }
}
