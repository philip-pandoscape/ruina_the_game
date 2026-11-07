//! The directory: the source of truth for where everyone plays. It keeps
//! - which simulation plays each space: a region's channel, or an instance's copy, each granted to
//!   its simulation under a lease with an epoch (`leases.rs`), renewed while it runs;
//! - where each character is, granted to a connection and a simulation under an epoch of their own
//!   that every write about them carries (`grants.rs`: bumped by each claim and each move), their
//!   home channel, and where they were last;
//! - the copies of instances, and whose each is.
//!
//! It starts a simulation the first time its space is needed (a character's home channel, a party's
//! copy of a dungeon), and closes a copy COPY_KEPT after the last player left it.
//!
//! A dungeon is played as World of Warcraft plays one: through its portal a party goes into its own
//! copy (someone on their own, into theirs), which nobody else sees; a copy is kept for COPY_KEPT
//! after the last player leaves it, so whoever comes back within that finds it as they left it; and
//! whoever is in a copy but no longer in the party it belongs to is put out after EXPEL_AFTER (the
//! copy's simulation does that). A party that forms takes over its leader's copies; one that breaks
//! up leaves its copies to whoever was left in it. Parties are the social tier's: it tells the
//! directory whenever someone's changes, and the directory passes each simulation its part.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use ruina_world_api::directory::{Destination, Grant, Lease, ToDirectory};
use ruina_world_api::gate::{Claimed, SpaceView, ToConn};
use ruina_world_api::post::{Answer, Reply};
use ruina_world_api::sim::ToSim;
use ruina_world_api::social::{CopyNote, Place, ToSocial};
use ruina_world_api::{Address, CharacterId, Conn, Millis, Owner, PartyId, SimId, SpaceId, Transport};

use crate::open::dungeon::dungeon;
use crate::open::map::world_map;
use crate::store::{Db, now_ms};

/// Characters' grants, home channels and copies' numbers, on their rows.
pub mod grants;
/// Spaces' leases.
pub mod leases;

use leases::{Leases, RENEW_EVERY};

/// How long a copy of a dungeon is kept once the last player has left it.
pub const COPY_KEPT: Duration = Duration::from_secs(30 * 60);
/// How long someone has to leave a copy once they're no longer in the party it belongs to.
pub const EXPEL_AFTER: Duration = Duration::from_secs(60);

/// What starting a simulation needs: its lease (its id, its space and the chunks it owns), and for
/// a copy whose it is; how long whoever doesn't belong in a copy may stay.
#[derive(Clone, Debug)]
pub struct SimSetup {
    pub lease: Lease,
    pub owner: Option<Owner>,
    pub expel_after: Duration,
}

/// Starts simulations: each on a thread of its own in this process (`crate::sim::Threads`); later,
/// in whichever process the directory places it.
pub trait Spawner: Send + Sync {
    fn start(&self, setup: SimSetup);
}

/// A space being played.
struct Running {
    lease: Lease,
    /// A copy's: whose it is, which instance, how many are in it and since when nobody has been.
    copy: Option<Copy>,
}

struct Copy {
    owner: Owner,
    instance: String,
    name: String,
    inside: usize,
    empty_since: Option<Millis>,
}

/// Someone playing: through which connection.
struct Who {
    conn: Conn,
}

/// The server stopping: every simulation's lives being written.
struct Saving {
    reply: Reply,
    waiting: usize,
    lives: usize,
}

pub struct Directory<L: Leases> {
    post: Arc<dyn Transport>,
    db: Db,
    leases: L,
    spawner: Arc<dyn Spawner>,
    /// Where characters live: the world's first region.
    region: String,
    spaces: BTreeMap<SpaceId, Running>,
    copies: BTreeMap<(Owner, String), SpaceId>,
    who: HashMap<CharacterId, Who>,
    /// Where each character is, or was last (a copy they may come back to).
    last: HashMap<CharacterId, SpaceId>,
    /// Each character's home channel, and its number.
    homes: HashMap<CharacterId, (SpaceId, u32)>,
    /// Who is in which party (the social tier's, as it tells it).
    parties: HashMap<CharacterId, PartyId>,
    /// Characters granted to a space they're on their way into: it isn't closed under them.
    pending: HashMap<CharacterId, SpaceId>,
    saving: HashMap<u64, Saving>,
    next_ask: u64,
    /// How long a copy is kept empty (the tests shorten it).
    pub copy_kept: Duration,
    /// How long a copy's simulation lets whoever doesn't belong stay.
    pub expel_after: Duration,
}

impl<L: Leases> Directory<L> {
    pub fn new(post: Arc<dyn Transport>, db: Db, leases: L, spawner: Arc<dyn Spawner>) -> Self {
        let region = world_map().regions().first().map(|r| r.id.clone()).expect("the world has a region");
        Directory {
            post,
            db,
            leases,
            spawner,
            region,
            spaces: BTreeMap::new(),
            copies: BTreeMap::new(),
            who: HashMap::new(),
            last: HashMap::new(),
            homes: HashMap::new(),
            parties: HashMap::new(),
            pending: HashMap::new(),
            saving: HashMap::new(),
            next_ask: 0,
            copy_kept: COPY_KEPT,
            expel_after: EXPEL_AFTER,
        }
    }

    /// Runs the directory: its messages as they come, its copies swept and its leases renewed.
    pub fn spawn(mut self, mut inbox: mpsc::UnboundedReceiver<ToDirectory>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut sweep = tokio::time::interval(Duration::from_millis(250));
            let mut renewed = tokio::time::Instant::now();
            loop {
                tokio::select! {
                    msg = inbox.recv() => match msg {
                        Some(m) => self.handle(m).await,
                        None => return,
                    },
                    _ = sweep.tick() => {
                        self.sweep(now_ms()).await;
                        if renewed.elapsed() >= RENEW_EVERY {
                            renewed = tokio::time::Instant::now();
                            self.renew().await;
                        }
                    }
                }
            }
        })
    }

    pub async fn handle(&mut self, msg: ToDirectory) {
        match msg {
            ToDirectory::Claim { conn, name } => self.claim(conn, name).await,
            ToDirectory::Release { conn } => {
                if self.who.get(&conn.character).is_some_and(|w| w.conn == conn) {
                    self.who.remove(&conn.character);
                    self.post.social(ToSocial::Offline { character: conn.character, session: conn.session });
                }
            }
            ToDirectory::Route { character, from, to } => self.route(character, from, to).await,
            ToDirectory::Placed { character, space, sim } => {
                if self.spaces.get(&space).is_some_and(|r| r.lease.sim == sim) {
                    self.pending.remove(&character);
                    self.last.insert(character, space.clone());
                    if self.who.contains_key(&character) {
                        let place = self.place(&space);
                        self.post.social(ToSocial::Placed { character, place });
                    }
                }
            }
            ToDirectory::Occupancy { space, inside, empty_since } => {
                if let Some(c) = self.spaces.get_mut(&space).and_then(|r| r.copy.as_mut()) {
                    c.inside = inside;
                    c.empty_since = empty_since;
                    self.tell_copy(&space);
                }
            }
            ToDirectory::Parties { changed, hand } => self.parties(changed, hand),
            ToDirectory::IsPlaying { character, reply } => {
                self.post.answer(reply, Answer::Playing(self.who.contains_key(&character)));
            }
            ToDirectory::Forget { character, channel } => {
                self.who.remove(&character);
                self.last.remove(&character);
                self.homes.remove(&character);
                self.parties.remove(&character);
                self.pending.remove(&character);
                if let Some(n) = channel
                    && let Some(r) = self.spaces.get(&SpaceId::channel(&self.region, n))
                {
                    self.post.sim(r.lease.sim, ToSim::ResidentGone { character });
                }
                self.post.social(ToSocial::Forget { character });
            }
            ToDirectory::SaveAll { reply } => {
                self.next_ask += 1;
                let id = self.next_ask;
                let sims: Vec<SimId> = self.spaces.values().map(|r| r.lease.sim).collect();
                let mut waiting = 0;
                for sim in sims {
                    if self.post.sim(sim, ToSim::SaveAll { reply: Reply { to: Address::Directory, id } }) {
                        waiting += 1;
                    }
                }
                if waiting == 0 {
                    self.post.answer(reply, Answer::Written { lives: 0 });
                } else {
                    self.saving.insert(id, Saving { reply, waiting, lives: 0 });
                }
            }
            ToDirectory::Answer { id, answer } => {
                if let (Some(s), Answer::Written { lives }) = (self.saving.get_mut(&id), answer) {
                    s.lives += lives;
                    s.waiting -= 1;
                    if s.waiting == 0 {
                        let s = self.saving.remove(&id).expect("there");
                        self.post.answer(s.reply, Answer::Written { lives: s.lives });
                    }
                }
            }
        }
    }

    /// A connection takes a character up: a newer grant (whoever had them is put out), their home
    /// channel, and where they come in: back into the copy they were in, if it's still there and
    /// still theirs, else their home channel.
    async fn claim(&mut self, conn: Conn, name: String) {
        let character = conn.character;
        let g = match grants::claim(&self.db, character, conn.session).await {
            Ok(g) => g,
            Err(e) => {
                eprintln!("could not grant character {character}: {e}");
                self.post.conn(conn, ToConn::Turned { text: "The server couldn't take your character up just now. Try again in a moment.".into() });
                return;
            }
        };
        if let Some(old) = self.who.get(&character)
            && old.conn != conn
        {
            self.post.conn(old.conn, ToConn::Kicked);
        }
        // Their home is a channel of the region their saved position is in (the world's first, for a newcomer).
        let region = g.space.as_ref().and_then(|s| s.region()).filter(|r| world_map().region(r).is_some()).unwrap_or(&self.region).to_string();
        let home = SpaceId::channel(&region, g.channel);
        let into = match self.last.get(&character) {
            Some(s) if s.is_copy() && self.spaces.contains_key(s) && self.may_be_in(character, s) => s.clone(),
            _ => home.clone(),
        };
        let (home_sim, sim) = match (self.ensure(&home, None).await, self.ensure(&into, None).await) {
            (Ok(h), Ok(s)) => (h, s),
            (Err(e), _) | (_, Err(e)) => {
                eprintln!("could not start a simulation for character {character}: {e}");
                self.post.conn(conn, ToConn::Turned { text: "The server couldn't find you a place just now. Try again in a moment.".into() });
                return;
            }
        };
        self.who.insert(character, Who { conn });
        self.homes.insert(character, (home.clone(), g.channel));
        self.last.insert(character, into.clone());
        self.pending.insert(character, into.clone());
        let party = self.parties.get(&character).copied();
        let claimed = Claimed { epoch: g.epoch, home, home_sim, space: into.clone(), sim, channel: g.channel, party };
        self.post.conn(conn, ToConn::Claimed(Box::new(claimed)));
        let place = self.place(&into);
        self.post.social(ToSocial::Online { conn, name, place });
    }

    /// Where a simulation asks to send a character: into the copy of an instance that's theirs
    /// (made now if there isn't one), or home. Granted there under a newer epoch.
    async fn route(&mut self, character: CharacterId, from: SimId, to: Destination) {
        let space = match &to {
            Destination::Copy { instance, zone } => self.copy_for(character, instance, *zone).await,
            Destination::Home => match self.homes.get(&character).cloned() {
                Some((home, _)) => self.ensure(&home, None).await.map(|_| home),
                None => Err("You aren't playing.".to_string()),
            },
        };
        let space = match space {
            Ok(s) => s,
            Err(text) => {
                self.post.sim(from, ToSim::Unrouted { character, text });
                return;
            }
        };
        let epoch = match grants::bump(&self.db, character).await {
            Ok(e) => e,
            Err(e) => {
                eprintln!("could not grant character {character} to {space}: {e}");
                self.post.sim(from, ToSim::Unrouted { character, text: "The server couldn't take you there just now.".into() });
                return;
            }
        };
        let sim = self.spaces[&space].lease.sim;
        self.pending.insert(character, space.clone());
        self.post.sim(from, ToSim::Routed { character, to: Grant { space, sim, epoch }, why: to });
    }

    /// The copy of `instance` that's `character`'s: their party's, theirs alone, or everyone's (a
    /// developer zone everyone shares), made now if there isn't one.
    async fn copy_for(&mut self, character: CharacterId, instance: &str, zone: bool) -> Result<SpaceId, String> {
        let def = dungeon(instance).filter(|d| d.developer == zone).ok_or("There's no such place.")?;
        let owner = if def.shared { Owner::Everyone } else { Owner::of(character, self.parties.get(&character).copied()) };
        let key = (owner, def.id.clone());
        if let Some(s) = self.copies.get(&key).filter(|s| self.spaces.contains_key(*s)) {
            return Ok(s.clone());
        }
        let n = grants::next_copy(&self.db).await?;
        let space = SpaceId::copy(&def.id, n);
        self.ensure(&space, Some(owner)).await?;
        self.copies.insert(key, space.clone());
        self.tell_copy(&space);
        Ok(space)
    }

    /// The simulation playing `space`, started now (under a new lease) if none is.
    async fn ensure(&mut self, space: &SpaceId, owner: Option<Owner>) -> Result<SimId, String> {
        if let Some(r) = self.spaces.get(space) {
            return Ok(r.lease.sim);
        }
        let sim = self.leases.next_sim().await?;
        let chunks = match space.region().and_then(|r| world_map().region(r)) {
            Some(r) => (r.chunks.x..r.chunks.x + r.chunks.w).flat_map(|x| (r.chunks.z..r.chunks.z + r.chunks.d).map(move |z| (x, z))).collect(),
            None => Vec::new(),
        };
        let lease = self.leases.grant(space, sim, chunks).await?;
        // Played already: among several processes the directory may have started again while the
        // simulation that has the space plays on. It's taken as it is, and nothing is started.
        let adopted = lease.sim != sim;
        let sim = lease.sim;
        let copy = match space {
            SpaceId::Copy { instance, .. } => {
                let def = dungeon(instance).ok_or("There's no such place.")?;
                let owner = owner.unwrap_or(Owner::Everyone);
                Some(Copy { owner, instance: instance.clone(), name: def.name.clone(), inside: 0, empty_since: Some(now_ms()) })
            }
            SpaceId::Channel { .. } => None,
        };
        let setup = SimSetup { lease: lease.clone(), owner: copy.as_ref().map(|c| c.owner), expel_after: self.expel_after };
        self.spaces.insert(space.clone(), Running { lease, copy });
        if !adopted {
            self.spawner.start(setup);
        }
        Ok(sim)
    }

    /// A space's simulation lost its lease (among several processes: its process stopped, or was cut
    /// off from the directory's table). The space is let go here, so the next to need it starts it
    /// anew, under the next epoch, on a process that's there; whoever played in it comes back in
    /// (`Rejoin`), to their life as it was last written.
    fn let_go(&mut self, space: &SpaceId, sim: SimId) {
        if !self.spaces.get(space).is_some_and(|r| r.lease.sim == sim) {
            return;
        }
        let r = self.spaces.remove(space).expect("there");
        self.copies.retain(|_, s| s != space);
        let inside: Vec<CharacterId> = self.last.iter().filter(|(_, s)| *s == space).map(|(c, _)| *c).collect();
        for c in inside {
            self.last.remove(&c);
            self.pending.remove(&c);
            if let Some(w) = self.who.get(&c) {
                self.post.conn(w.conn, ToConn::Rejoin { text: "The place you were in moved to another server.".into() });
            }
        }
        if let Some(c) = r.copy
            && let Owner::Party(_) = c.owner
        {
            self.post.social(ToSocial::CopyClosed { owner: c.owner, space: space.clone() });
        }
    }

    /// Whether someone belongs in a copy: it's their party's, theirs on their own, or everyone's.
    fn may_be_in(&self, character: CharacterId, space: &SpaceId) -> bool {
        let party = self.parties.get(&character).copied();
        self.spaces.get(space).and_then(|r| r.copy.as_ref()).is_some_and(|c| c.owner == Owner::Everyone || c.owner == Owner::of(character, party))
    }

    /// A space as a party sees it.
    fn place(&self, space: &SpaceId) -> Place {
        let name = space.instance().and_then(dungeon).map_or("", |d| d.name.as_str());
        Place { space: space.clone(), view: SpaceView::of(space, name) }
    }

    /// The social tier hears a party's copy as it is now.
    fn tell_copy(&self, space: &SpaceId) {
        let Some(c) = self.spaces.get(space).and_then(|r| r.copy.as_ref()) else { return };
        if let Owner::Party(_) = c.owner {
            let note = CopyNote { space: space.clone(), instance: c.instance.clone(), name: c.name.clone(), inside: c.inside, empty_since: c.empty_since };
            self.post.social(ToSocial::Copy { owner: c.owner, copy: note });
        }
    }

    /// Parties changed: who is in which, and copies handed from one owner to another (where the new
    /// owner hasn't one of that instance already). Each simulation hears its part in one message.
    fn parties(&mut self, changed: Vec<(CharacterId, Option<PartyId>)>, hand: Vec<(Owner, Owner)>) {
        for &(c, p) in &changed {
            match p {
                Some(p) => self.parties.insert(c, p),
                None => self.parties.remove(&c),
            };
        }
        let mut owners: BTreeMap<SimId, Owner> = BTreeMap::new();
        for (from, to) in hand {
            let keys: Vec<(Owner, String)> = self.copies.keys().filter(|(o, _)| *o == from).cloned().collect();
            for key in keys {
                if self.copies.contains_key(&(to, key.1.clone())) {
                    continue;
                }
                let space = self.copies.remove(&key).expect("there");
                if let Some(r) = self.spaces.get_mut(&space) {
                    if let Some(c) = r.copy.as_mut() {
                        c.owner = to;
                    }
                    owners.insert(r.lease.sim, to);
                }
                if let Owner::Party(_) = from {
                    self.post.social(ToSocial::CopyClosed { owner: from, space: space.clone() });
                }
                self.copies.insert((to, key.1), space.clone());
                self.tell_copy(&space);
            }
        }
        // Each simulation: its players whose party changed, and its new owner.
        let mut parts: BTreeMap<SimId, Vec<(CharacterId, Option<PartyId>)>> = BTreeMap::new();
        for (c, p) in changed {
            if let Some(sim) = self.last.get(&c).and_then(|s| self.spaces.get(s)).map(|r| r.lease.sim) {
                parts.entry(sim).or_default().push((c, p));
            }
        }
        let sims: std::collections::BTreeSet<SimId> = parts.keys().chain(owners.keys()).copied().collect();
        for sim in sims {
            let changed = parts.remove(&sim).unwrap_or_default();
            self.post.sim(sim, ToSim::Parties { changed, owner: owners.get(&sim).copied() });
        }
    }

    /// Closes the copies empty for `copy_kept` that nobody is on their way into.
    pub async fn sweep(&mut self, now: Millis) {
        let kept = self.copy_kept.as_millis() as Millis;
        let closing: Vec<SpaceId> = self
            .spaces
            .iter()
            .filter(|(s, r)| {
                r.copy.as_ref().is_some_and(|c| c.inside == 0 && c.empty_since.is_some_and(|t| now - t >= kept)) && !self.pending.values().any(|p| p == *s)
            })
            .map(|(s, _)| s.clone())
            .collect();
        for space in closing {
            let Some(r) = self.spaces.remove(&space) else { continue };
            self.copies.retain(|_, s| *s != space);
            self.post.sim(r.lease.sim, ToSim::Stop);
            if let Err(e) = self.leases.release(&space, r.lease.sim).await {
                eprintln!("could not give up {space}'s lease: {e}");
            }
            if let Some(c) = r.copy
                && let Owner::Party(_) = c.owner
            {
                self.post.social(ToSocial::CopyClosed { owner: c.owner, space });
            }
        }
    }

    /// Renews the leases held; a simulation whose lease another holder has taken hears it lost.
    async fn renew(&mut self) {
        let held: Vec<Lease> = self.spaces.values().map(|r| r.lease.clone()).collect();
        match self.leases.renew(&held).await {
            Ok(r) => {
                for l in self.spaces.values_mut() {
                    l.lease.until = r.until;
                }
                for lost in r.lost {
                    eprintln!("lost the lease on {} (epoch {}) to another holder", lost.space, lost.epoch.0);
                    self.post.sim(lost.sim, ToSim::Lease(ruina_world_api::sim::LeaseNote::Lost { epoch: lost.epoch }));
                    self.let_go(&lost.space, lost.sim);
                }
            }
            Err(e) => eprintln!("could not renew the leases: {e}"),
        }
    }

    /// The simulation playing a space, if one is (tests).
    pub fn sim_of(&self, space: &SpaceId) -> Option<SimId> {
        self.spaces.get(space).map(|r| r.lease.sim)
    }
}
