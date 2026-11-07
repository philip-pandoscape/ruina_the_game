//! One process among several: its links (crates/link), the tiers' post with its way to the rest of
//! the world (a `LinkPost` whose book of who takes which address is filled from the directory's
//! tables), what arrives on its links, and the simulations it hosts (a sim's process).
//!
//! - **The book.** A simulation is where the lease on its space says (`space_leases`: its node and
//!   address), a gate where its row in `nodes` says, and the store, social and the directory where
//!   the services' row says. Mail for an address the book hasn't got yet is parked and looked up at
//!   once; mail parked too long comes back: a player on their way into a simulation nobody can find
//!   is sent back where they came from (`Returned`), as one process does when a simulation is gone.
//! - **What arrives** goes to the tier it's for in this process, never on again (so two processes
//!   can't pass a message back and forth). A player sent into a simulation that has stopped here goes
//!   back where they came from.
//! - **A simulation hosted here** runs on a thread of its own, as in one process, with a keeper
//!   renewing its lease in the directory's table: renewed, it hears `LeaseNote::Renewed`; lost (the
//!   database out of reach, or another granted the space), it hears `Lost` and stops at once, and
//!   whoever plays the space next starts from what was written.

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ruina_link::post::LinkPost;
use ruina_link::{Config, Inbox, Node};
use ruina_world_api::post::{Address, Envelope, Message};
use ruina_world_api::sim::{LeaseNote, ToSim};
use ruina_world_api::{Epoch, GateId, SimId, Transport};
use sqlx::PgPool;
use tokio::sync::{oneshot, watch};

use crate::cluster::keeper::{Keeper, Kept, Lost, Timing};
use crate::cluster::leases::{self, Leased};
use crate::cluster::nodes::{self, GONE_AFTER};
use crate::cluster::wire::{PROTOCOL, Spawn, Wire};
use crate::cluster::{Playing, Role, Status};
use crate::directory::SimSetup;
use crate::post::Post;
use crate::sim::SimHost;
use crate::store::now_ms;

/// How long mail waits for the book to say where its address is before it comes back.
const PARKED_FOR: Duration = Duration::from_secs(10);
/// How often the book is looked over (the services' address, a new start of theirs found).
const LOOK_EVERY: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, Default)]
struct Count {
    received: u64,
    last: u64,
    in_order: bool,
}

/// One process of the world, among several.
pub struct Process {
    pub role: Role,
    pub id: String,
    pub db: PgPool,
    /// The tiers' post: their mailboxes here, and the rest of the world through `remote`.
    pub post: Arc<Post>,
    pub remote: Arc<LinkPost<Wire>>,
    lease: Timing,
    incarnation: i64,
    hosted: Mutex<BTreeMap<SimId, Playing>>,
    counts: Mutex<HashMap<(String, u64), Count>>,
    stopping: watch::Sender<bool>,
}

impl Process {
    /// Starts this process's links on `link` (dialled at `advertise` if given), writes it into the
    /// directory (with its gate's id, a gate's) and starts looking after its book and its mail.
    pub async fn start(
        role: Role,
        id: &str,
        db: PgPool,
        link: SocketAddr,
        advertise: Option<String>,
        lease: Timing,
        gate: Option<GateId>,
    ) -> std::io::Result<Arc<Process>> {
        let config = Config { advertise, ..Config::speaking(PROTOCOL) };
        let (node, inbox) = Node::<Wire>::start(id, link, config).await?;
        let remote = Arc::new(LinkPost::new(node.clone()));
        let post = Post::new();
        post.set_remote(remote.clone());
        let incarnation = node.incarnation() as i64;
        nodes::register(&db, id, role.name(), node.advertised(), incarnation).await.map_err(std::io::Error::other)?;
        if let Some(g) = gate {
            nodes::set_gate(&db, id, g.0 as i32).await.map_err(std::io::Error::other)?;
        }
        nodes::spawn_heartbeat(db.clone(), id.to_string(), incarnation);
        let p = Arc::new(Process {
            role,
            id: id.to_string(),
            db,
            post,
            remote,
            lease,
            incarnation,
            hosted: Mutex::default(),
            counts: Mutex::default(),
            stopping: watch::channel(false).0,
        });
        println!("{role} {id}: links on {} (dialled at {}), in the directory", node.local_addr(), node.advertised());
        tokio::spawn(p.clone().keep_book());
        tokio::spawn(p.clone().take(inbox));
        Ok(p)
    }

    pub fn node(&self) -> &Node<Wire> {
        self.remote.node()
    }

    pub fn status(&self) -> Status {
        let stats = self.node().stats();
        Status {
            node: self.id.clone(),
            role: self.role,
            incarnation: self.node().incarnation(),
            sims: self.hosted.lock().unwrap().values().cloned().collect(),
            delivered: stats.delivered,
            duplicates: stats.duplicates,
        }
    }

    /// Where `at` is taken, by the directory's tables.
    async fn find(&self, at: Address) -> Option<(String, String)> {
        let row: Result<Option<(String, String)>, sqlx::Error> = match at {
            Address::Sim(id) => {
                sqlx::query_as("SELECT node, address FROM space_leases WHERE sim = $1 AND node IS NOT NULL").bind(id.0 as i64).fetch_optional(&self.db).await
            }
            Address::Gate(g) => {
                sqlx::query_as("SELECT id, address FROM nodes WHERE gate = $1 ORDER BY seen_at DESC LIMIT 1").bind(g.0 as i32).fetch_optional(&self.db).await
            }
            Address::Store | Address::Social | Address::Directory => sqlx::query_as(
                "SELECT id, address FROM nodes WHERE role = 'services' AND seen_at > now() - $1 * interval '1 millisecond' ORDER BY started_at DESC LIMIT 1",
            )
            .bind(GONE_AFTER.as_millis() as i64)
            .fetch_optional(&self.db)
            .await,
        };
        row.unwrap_or_else(|e| {
            eprintln!("{} {}: couldn't read the directory ({e})", self.role, self.id);
            None
        })
    }

    /// Keeps the book: what mail is parked for is looked up at once, the services' address every
    /// moment (a new start of theirs is found), and mail parked too long comes back.
    async fn keep_book(self: Arc<Self>) {
        let mut every = tokio::time::interval(LOOK_EVERY);
        loop {
            tokio::select! {
                _ = every.tick() => {
                    for at in [Address::Store, Address::Social, Address::Directory] {
                        if self.post.holds(at) {
                            continue;
                        }
                        if let Some((node, addr)) = self.find(at).await
                            && self.remote.find(at) != Some((node.clone(), addr.clone()))
                        {
                            self.remote.place(at, &node, &addr);
                        }
                    }
                    for (at, msg) in self.remote.expire(PARKED_FOR) {
                        self.undeliverable(at, msg);
                    }
                }
                _ = self.remote.wanted() => {}
            }
            for at in self.remote.missing() {
                if let Some((node, addr)) = self.find(at).await {
                    self.remote.place(at, &node, &addr);
                }
            }
        }
    }

    fn undeliverable(&self, to: Address, msg: Message) {
        if let Some(character) = send_back(self.post.as_ref(), msg) {
            eprintln!("{} {}: character {character} couldn't be sent back from {to:?}", self.role, self.id);
        }
    }

    /// What arrives on the links.
    async fn take(self: Arc<Self>, mut inbox: Inbox<Wire>) {
        while let Some(e) = inbox.recv().await {
            match &e.msg {
                Wire::Status => {
                    let _ = self.node().reply(&e, &Wire::Here(self.status()));
                    continue;
                }
                Wire::Count { stream, n } => {
                    let mut counts = self.counts.lock().unwrap();
                    let c = counts.entry((e.from.clone(), *stream)).or_insert(Count { in_order: true, ..Count::default() });
                    c.in_order &= *n == c.last + 1;
                    c.received += 1;
                    c.last = *n;
                    continue;
                }
                Wire::Tally { stream } => {
                    let c = self.counts.lock().unwrap().get(&(e.from.clone(), *stream)).copied().unwrap_or(Count { in_order: true, ..Count::default() });
                    let _ = self.node().reply(&e, &Wire::Counted { stream: *stream, received: c.received, in_order: c.in_order, last: c.last });
                    continue;
                }
                _ => {}
            }
            match e.msg {
                Wire::Post(Envelope { to, msg }) => {
                    if let Err(msg) = self.post.here(to, msg) {
                        self.undeliverable(to, msg);
                    }
                }
                Wire::Spawn(s) => {
                    if self.role == Role::Sim {
                        self.host(s);
                    } else {
                        eprintln!("{} {}: asked to start simulation {}, but this isn't a sim's process", self.role, self.id, s.lease.sim.0);
                    }
                }
                _ => {}
            }
        }
    }

    /// Starts a simulation here, as the directory asks: on a thread of its own, with a keeper
    /// renewing its lease.
    fn host(self: &Arc<Self>, s: Spawn) {
        let id = s.lease.sim;
        // Asked twice (the directory's process started again, and asked again): it runs already.
        if self.post.holds(Address::Sim(id)) {
            return;
        }
        let space = s.lease.space.to_string();
        let lease = leases::Lease { leased: Leased::space(&space), sim: id.0 as i64, epoch: s.lease.epoch.0 as i64 };
        // Its first deadline counts from the grant, as the directory's clock had it: never later
        // than the lease really runs out.
        let since = Duration::from_millis((now_ms() - s.granted_ms).max(0) as u64);
        let asked = Instant::now().checked_sub(since).unwrap_or_else(Instant::now);
        let keeper = Keeper::start(self.db.clone(), lease, self.lease, asked);
        self.hosted.lock().unwrap().insert(id, Playing { space: space.clone(), sim: id.0, epoch: s.lease.epoch.0, holding: true, why: None });
        let setup = SimSetup { lease: s.lease, owner: s.owner, expel_after: Duration::from_millis(s.expel_after_ms) };
        let inbox = self.post.open_sim(id);
        let (done, ended) = oneshot::channel::<()>();
        let post = self.post.clone();
        let started = std::thread::Builder::new().name(format!("sim-{}", id.0)).spawn(move || {
            let transport: Arc<dyn Transport> = post.clone();
            let mut sim = SimHost::new(setup, inbox, transport);
            sim.stop_when_lost = true;
            sim.run();
            post.close_sim(id);
            let _ = done.send(());
        });
        if let Err(e) = started {
            eprintln!("{} {}: couldn't start simulation {} ({e})", self.role, self.id, id.0);
            self.post.close_sim(id);
            return;
        }
        println!("{} {}: plays {space} as simulation {} under epoch {}", self.role, self.id, id.0, self.hosted.lock().unwrap()[&id].epoch);
        let p = self.clone();
        tokio::spawn(async move {
            let mut notes = keeper.notes();
            let mut ended = std::pin::pin!(ended);
            let mut stopping = p.stopping.subscribe();
            let (why, lost) = loop {
                tokio::select! {
                    _ = &mut ended => break ("its simulation stopped".to_string(), false),
                    _ = until_true(&mut stopping) => {
                        p.post.sim(id, ToSim::Stop);
                        break ("the process is stopping".to_string(), false);
                    }
                    changed = notes.changed() => {
                        if changed.is_err() {
                            break ("its keeper stopped".to_string(), false);
                        }
                        let said = *notes.borrow_and_update();
                        match said {
                            Kept::Holding { epoch, until } => {
                                p.post.sim(id, ToSim::Lease(LeaseNote::Renewed { epoch: Epoch(epoch as u64), until }));
                            }
                            Kept::Lost { epoch, why } => {
                                p.post.sim(id, ToSim::Lease(LeaseNote::Lost { epoch: Epoch(epoch as u64) }));
                                break (format!("its lease was lost ({})", match why { Lost::Gone => "granted anew, or run out", Lost::Unreachable => "the directory out of reach", Lost::Released => "let go" }), true);
                            }
                        }
                    }
                }
            };
            if !lost {
                // Stopped (a copy closed, the process stopping): the space is let go at once.
                let _ = keeper.release().await;
            }
            if let Some(pl) = p.hosted.lock().unwrap().get_mut(&id) {
                pl.holding = false;
                pl.why = Some(why.clone());
            }
            println!("{} {}: stopped playing {space} ({why})", p.role, p.id);
        });
    }

    /// Stopping: every simulation here stops (writing its players' lives) and lets its space go,
    /// and the process leaves the directory.
    pub async fn stop(&self) {
        self.stopping.send_replace(true);
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.hosted.lock().unwrap().values().any(|p| p.holding) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let _ = nodes::leave(&self.db, &self.id, self.incarnation).await;
        self.node().stop();
    }
}

/// Mail that couldn't be delivered: a player on their way into a simulation that isn't there goes
/// back where they came from (`Returned`), as one process does when a simulation is gone; anything
/// else is dropped, as in one process. The character who couldn't be sent back either, if any.
fn send_back(post: &dyn Transport, msg: Message) -> Option<ruina_world_api::CharacterId> {
    match msg {
        Message::Sim(ToSim::Transfer(m)) => {
            let (from, character) = (m.from, m.character);
            (!post.sim(from, ToSim::Returned { moving: m, text: "That place is gone.".into() })).then_some(character)
        }
        Message::Sim(ToSim::Returned { moving, .. }) => Some(moving.character),
        _ => None,
    }
}

/// Resolves once `w` is true (holding no lock on it when it does, so the future can be sent).
async fn until_true(w: &mut watch::Receiver<bool>) {
    let _ = w.wait_for(|s| *s).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::life::Life;
    use crate::open::zone::emberholm;
    use crate::player::{Build, Player};
    use crate::world::Spawn as At;
    use ruina_world_api::sim::{Carried, Entry, Member, Moving};
    use ruina_world_api::{Conn, SpaceId};

    fn moving(from: SimId) -> Box<Moving> {
        let conn = Conn { gate: GateId(1), character: 42, session: 7 };
        let member = Member { conn, name: "Ana".into(), dev: false, epoch: Epoch(3), party: None, home: SpaceId::channel("emberholm", 1), keep_saved: false };
        let carried =
            Carried { player: Player::new(At { x: 1.0, z: 2.0, facing: 0.0 }, 0, Build::default()), life: Box::new(Life::new(emberholm(), None, None)) };
        Box::new(Moving { character: 42, member, carried, entry: Entry::Entrance, after: Vec::new(), from })
    }

    #[test]
    fn a_player_sent_into_a_simulation_that_isnt_there_goes_back_where_they_came_from() {
        let post = Post::new();
        let from = post.open_sim(SimId(5));
        assert_eq!(send_back(post.as_ref(), Message::Sim(ToSim::Transfer(moving(SimId(5))))), None);
        match from.try_recv() {
            Ok(ToSim::Returned { moving, text }) => assert_eq!((moving.character, text.as_str()), (42, "That place is gone.")),
            other => panic!("{other:?}"),
        }
        // Where they came from is gone too: said, and nothing else to do.
        assert_eq!(send_back(post.as_ref(), Message::Sim(ToSim::Transfer(moving(SimId(6))))), Some(42));
        // Anything else is dropped, as in one process.
        assert_eq!(send_back(post.as_ref(), Message::Sim(ToSim::Stop)), None);
    }
}
