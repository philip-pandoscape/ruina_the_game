//! The directory: the source of truth for where everyone plays. It keeps
//! - which simulation plays each space: a region's channel, or an instance's copy, each granted to
//!   its simulation under a lease with an epoch (`leases.rs`), renewed while it runs;
//! - where each character is, granted to a connection and a simulation under an epoch of their own
//!   that every write about them carries (`grants.rs`: bumped by each claim and each move), the
//!   region they play in, and where they were last;
//! - each region's channels, by the channels' policy (`crates/channels`, a `Region` for each): where
//!   someone coming in is placed, when another channel opens and a quiet one merges, who may change
//!   channel; reviewed once a second, what it answers carried out (a channel's simulation started,
//!   players moved between channels standing where they stood, an emptied channel's stopped);
//! - the copies of instances, and whose each is.
//!
//! It starts a simulation the first time its space is needed (a channel the policy opens, a party's
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

use ruina_channels::{Action, Follow, PartyTies, Placement, Region, Standing, Target, Ties, Tuning, Why};
use ruina_world_api::directory::{Destination, Grant, Lease, ToDirectory};
use ruina_world_api::gate::{Claimed, SpaceView, ToConn};
use ruina_world_api::post::{Answer, Reply};
use ruina_world_api::sim::{After, ToSim};
use ruina_world_api::social::{CopyNote, Place, ToSocial};
use ruina_world_api::{Address, CharacterId, Conn, Millis, Owner, PartyId, SimId, SpaceId, Transport};

use crate::open::dungeon::dungeon;
use crate::open::map::world_map;
use crate::store::{Db, now_ms};

/// The channels' crowd of bots played against the directory (tests).
#[cfg(test)]
mod crowd;
/// Characters' grants and copies' numbers, on their rows.
pub mod grants;
/// Spaces' leases.
pub mod leases;
/// A region played in parts by several simulations (R10.19).
pub mod parts;

use leases::{Leases, RENEW_EVERY};

/// How often the channels' policy is asked what's due (merges, followers, channels opened ahead).
const REVIEW_EVERY: Duration = Duration::from_secs(1);

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
    /// Playing part of its region beside other simulations (its lease's chunks): who owns which
    /// chunk, and the slots its own players take (crates/server/src/sim/border.rs).
    pub part: Option<Part>,
}

/// A simulation's part of a region played by several.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Part {
    pub owners: ruina_engine::border::Owners,
    pub seats: std::ops::Range<usize>,
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
    /// Where a newcomer plays: the world's first region.
    region: String,
    spaces: BTreeMap<SpaceId, Running>,
    copies: BTreeMap<(Owner, String), SpaceId>,
    who: HashMap<CharacterId, Who>,
    /// Where each character is, or was last (a copy they may come back to).
    last: HashMap<CharacterId, SpaceId>,
    /// The region each character plays in (where they come out of a copy).
    homes: HashMap<CharacterId, String>,
    /// Each region's channels and who plays in which (the channels' policy).
    regions: BTreeMap<String, Region>,
    /// The channels' numbers (the content's; the tests' own).
    pub tuning: Tuning,
    /// What each channel's simulation last said its players who aren't free are doing.
    standings: HashMap<SimId, HashMap<CharacterId, Standing>>,
    /// Who is in which party, who is in each and who leads it (the social tier's, as it tells it).
    parties: HashMap<CharacterId, PartyId>,
    members: HashMap<PartyId, Vec<CharacterId>>,
    leaders: HashMap<PartyId, CharacterId>,
    /// Characters granted to a space they're on their way into: it isn't closed under them.
    pending: HashMap<CharacterId, SpaceId>,
    saving: HashMap<u64, Saving>,
    next_ask: u64,
    /// How long a copy is kept empty (the tests shorten it).
    pub copy_kept: Duration,
    /// How long a copy's simulation lets whoever doesn't belong stay.
    pub expel_after: Duration,
    /// Tests: the time the channels go by (a crowd's own clock), in place of the world's.
    pub clock: Option<Millis>,
    /// Regions played in parts, by several simulations each, and where each is cut (chunks' x:
    /// parts.rs); every other region is played whole.
    pub cuts: BTreeMap<String, Vec<i32>>,
    /// The parts a space is played in, each part's lease (the space's own is the first's).
    parts: BTreeMap<SpaceId, Vec<Lease>>,
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
            regions: BTreeMap::new(),
            tuning: ruina_channels::tuning().clone(),
            standings: HashMap::new(),
            parties: HashMap::new(),
            members: HashMap::new(),
            leaders: HashMap::new(),
            pending: HashMap::new(),
            saving: HashMap::new(),
            next_ask: 0,
            copy_kept: COPY_KEPT,
            expel_after: EXPEL_AFTER,
            clock: None,
            cuts: BTreeMap::new(),
            parts: BTreeMap::new(),
        }
    }

    /// Runs the directory: its messages as they come, its copies swept and its leases renewed.
    pub fn spawn(mut self, mut inbox: mpsc::UnboundedReceiver<ToDirectory>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut sweep = tokio::time::interval(Duration::from_millis(250));
            let mut renewed = tokio::time::Instant::now();
            let mut reviewed = tokio::time::Instant::now();
            loop {
                tokio::select! {
                    msg = inbox.recv() => match msg {
                        Some(m) => self.handle(m).await,
                        None => return,
                    },
                    _ = sweep.tick() => {
                        self.sweep(now_ms()).await;
                        if reviewed.elapsed() >= REVIEW_EVERY {
                            reviewed = tokio::time::Instant::now();
                            self.review(now_ms()).await;
                        }
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
                    // Their channel is kept for them a while (the policy's rejoinWithin).
                    let now = self.now();
                    for r in self.regions.values_mut() {
                        r.leave(conn.character, now);
                    }
                    self.post.social(ToSocial::Offline { character: conn.character, session: conn.session });
                }
            }
            ToDirectory::Route { character, from, to } => self.route(character, from, to).await,
            ToDirectory::Placed { character, space, sim } => {
                if self.spaces.get(&space).is_some_and(|r| r.lease.sim == sim) {
                    self.pending.remove(&character);
                    // Into a copy: out of their channel (it's kept for them a while).
                    if space.is_copy() {
                        let now = self.now();
                        for r in self.regions.values_mut() {
                            r.leave(character, now);
                        }
                    }
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
            ToDirectory::Parties { changed, hand, leaders } => self.parties(changed, hand, leaders).await,
            ToDirectory::IsPlaying { character, reply } => {
                self.post.answer(reply, Answer::Playing(self.who.contains_key(&character)));
            }
            ToDirectory::Forget { character } => {
                self.who.remove(&character);
                self.last.remove(&character);
                self.homes.remove(&character);
                self.parties.remove(&character);
                self.pending.remove(&character);
                for r in self.regions.values_mut() {
                    r.forget(character);
                }
                // Their land stands in every channel: it comes down in each, and their plots are free.
                for r in self.spaces.values().filter(|r| !r.lease.space.is_copy()) {
                    self.post.sim(r.lease.sim, ToSim::CharacterGone { character });
                }
                self.post.social(ToSocial::Forget { character });
            }
            ToDirectory::Channels { conn, standing } => {
                let view = self.channels_view(conn.character, &standing);
                self.post.conn(conn, ToConn::Channels(Box::new(view)));
            }
            ToDirectory::Change { conn, from, to, standing, dev } => self.change(conn, from, to, standing, dev).await,
            ToDirectory::Standings { sim, standings } => {
                self.standings.insert(sim, standings.into_iter().collect());
            }
            ToDirectory::SaveAll { reply } => {
                self.next_ask += 1;
                let id = self.next_ask;
                let mut sims: Vec<SimId> = self.spaces.values().map(|r| r.lease.sim).collect();
                // A region's parts too: every part's players are written.
                sims.extend(self.parts.values().flatten().map(|l| l.sim));
                sims.sort();
                sims.dedup();
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

    /// A connection takes a character up: a newer grant (whoever had them is put out), and where
    /// they come in: back into the copy they were in, if it's still there and still theirs, else a
    /// channel of their region as the channels' policy places them (each placement counted before
    /// the next is made, so arrivals together fill channels as they should).
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
        // They play in the region their saved position is in (the world's first, for a newcomer).
        let region = g.space.as_ref().and_then(|s| s.region()).filter(|r| world_map().region(r).is_some()).unwrap_or(&self.region).to_string();
        let in_copy = match self.last.get(&character) {
            Some(s) if s.is_copy() && self.spaces.contains_key(s) && self.may_be_in(character, s) => Some(s.clone()),
            _ => None,
        };
        // Into a channel, placed there; into a copy, the channel they'd be placed in is where they'd
        // come out (and whose estates they see meanwhile).
        let channel = match &in_copy {
            Some(_) => self.home_channel(&region, character),
            None => self.arrive(&region, character).await,
        };
        let home = SpaceId::channel(&region, channel);
        let into = in_copy.unwrap_or_else(|| home.clone());
        let (home_sim, sim) = match (self.ensure(&home, None).await, self.ensure(&into, None).await) {
            (Ok(h), Ok(s)) => (h, s),
            (Err(e), _) | (_, Err(e)) => {
                eprintln!("could not start a simulation for character {character}: {e}");
                if let Some(r) = self.regions.get_mut(&region) {
                    r.forget(character);
                }
                self.post.conn(conn, ToConn::Turned { text: "The server couldn't find you a place just now. Try again in a moment.".into() });
                return;
            }
        };
        self.who.insert(character, Who { conn });
        self.homes.insert(character, region);
        self.last.insert(character, into.clone());
        self.pending.insert(character, into.clone());
        let party = self.parties.get(&character).copied();
        let claimed = Claimed { epoch: g.epoch, home, home_sim, space: into.clone(), sim, channel, party };
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
                Some(region) => {
                    let n = self.arrive(&region, character).await;
                    let home = SpaceId::channel(&region, n);
                    self.ensure(&home, None).await.map(|_| home)
                }
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
        // A region played in parts: a simulation for each, the space's lease the first's.
        let cuts = space.region().and_then(|r| self.cuts.get(r)).cloned().unwrap_or_default();
        let split = parts::parts(&chunks, &cuts);
        if split.len() > 1 {
            return self.ensure_parts(space, sim, split, &cuts).await;
        }
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
        let setup = SimSetup { lease: lease.clone(), owner: copy.as_ref().map(|c| c.owner), expel_after: self.expel_after, part: None };
        self.spaces.insert(space.clone(), Running { lease, copy });
        if !adopted {
            self.spawner.start(setup);
        }
        Ok(sim)
    }

    /// A channel of a region played in parts: a simulation for each part (the first `first`), each
    /// owning its chunks and told who owns the rest and which slots it seats its own players in. The
    /// space's lease is the first part's, and so is where its players come in: whoever stands in
    /// another's is handed over there as the first tick ends (crates/engine/src/border).
    async fn ensure_parts(&mut self, space: &SpaceId, first: SimId, split: Vec<Vec<(i32, i32)>>, cuts: &[i32]) -> Result<SimId, String> {
        let split: Vec<Vec<(i32, i32)>> = split.into_iter().take(parts::MOST_PARTS).collect();
        let mut sims = vec![first];
        for _ in 1..split.len() {
            sims.push(self.leases.next_sim().await?);
        }
        let lease = self.leases.grant(space, first, split[0].clone()).await?;
        if lease.sim != first {
            // Played already, by another process's parts: taken as it is, nothing started.
            let sim = lease.sim;
            self.spaces.insert(space.clone(), Running { lease, copy: None });
            return Ok(sim);
        }
        let owners = parts::owners(world_map(), cuts, &sims);
        let mut leases = Vec::new();
        for (k, chunks) in split.into_iter().enumerate() {
            let l = Lease { sim: sims[k], chunks, ..lease.clone() };
            let part = Part { owners: owners.clone(), seats: parts::seats(k) };
            self.spawner.start(SimSetup { lease: l.clone(), owner: None, expel_after: self.expel_after, part: Some(part) });
            leases.push(l);
        }
        self.spaces.insert(space.clone(), Running { lease, copy: None });
        self.parts.insert(space.clone(), leases);
        Ok(first)
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
        self.parts.remove(space);
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
    async fn parties(&mut self, changed: Vec<(CharacterId, Option<PartyId>)>, hand: Vec<(Owner, Owner)>, leaders: Vec<(PartyId, CharacterId)>) {
        // Who joined a party (one they weren't in, and don't lead), and who left theirs.
        let joined: Vec<CharacterId> = changed
            .iter()
            .filter(|(c, p)| p.is_some_and(|p| self.parties.get(c) != Some(&p) && leaders.iter().all(|(lp, l)| *lp != p || l != c)))
            .map(|(c, _)| *c)
            .collect();
        let left: Vec<CharacterId> = changed.iter().filter(|(_, p)| p.is_none()).map(|(c, _)| *c).collect();
        for &(c, p) in &changed {
            match p {
                Some(p) => self.parties.insert(c, p),
                None => self.parties.remove(&c),
            };
        }
        for (p, l) in leaders {
            self.leaders.insert(p, l);
        }
        self.members.clear();
        for (c, p) in &self.parties {
            self.members.entry(*p).or_default().push(*c);
        }
        self.leaders.retain(|p, _| self.members.contains_key(p));
        for c in left {
            for r in self.regions.values_mut() {
                r.left_party(c);
            }
        }
        // An invitation into a party in another channel takes them there, now or once they may go.
        for c in joined {
            self.follow(c).await;
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

    // ---------- Channels (crates/channels) ----------

    /// The time now, as the channels go by it: the world's clock (or a test's).
    fn now(&self) -> Millis {
        self.clock.unwrap_or_else(now_ms)
    }

    /// A region's channels, as the policy keeps them (tests).
    pub fn region(&self, id: &str) -> Option<&Region> {
        self.regions.get(id)
    }

    /// Where the policy would place `who` coming in now, and why (tests).
    pub fn placing(&self, who: CharacterId) -> ruina_channels::Placed {
        let region = self.region_of(who);
        match self.regions.get(&region) {
            Some(r) => r.place(who, &self.ties(), self.now(), &self.tuning),
            None => ruina_channels::Placed { n: 1, why: Placement::New },
        }
    }

    /// Who belongs with whom, as placing asks it (parties, from the social tier).
    fn ties(&self) -> PartyMap<'_> {
        PartyMap { parties: &self.parties, members: &self.members, leaders: &self.leaders }
    }

    /// What `who` is doing, as their channel's simulation last said (free, if it said nothing of them).
    fn standing_of(standings: &HashMap<SimId, HashMap<CharacterId, Standing>>, sim: Option<SimId>, who: CharacterId) -> Standing {
        sim.and_then(|s| standings.get(&s)).and_then(|m| m.get(&who)).copied().unwrap_or_default()
    }

    /// The simulation playing channel `n` of `region`, if one is.
    fn channel_sim(&self, region: &str, n: u32) -> Option<SimId> {
        self.spaces.get(&SpaceId::channel(region, n)).map(|r| r.lease.sim)
    }

    /// The region a character plays in.
    fn region_of(&self, character: CharacterId) -> String {
        self.homes.get(&character).cloned().unwrap_or_else(|| self.region.clone())
    }

    /// `character` comes into `region`: placed by the policy (a channel opened for them if it must
    /// be), and the channel they're in.
    async fn arrive(&mut self, region: &str, character: CharacterId) -> u32 {
        let now = self.now();
        let ties = PartyMap { parties: &self.parties, members: &self.members, leaders: &self.leaders };
        let r = self.regions.entry(region.to_string()).or_insert_with(|| Region::new(region));
        let (placed, actions) = r.arrive(character, &ties, now, &self.tuning);
        for a in actions {
            self.carry_out(region, a).await;
        }
        placed.n
    }

    /// The channel `character` would be placed in in `region`, open (opened now if it must be), and
    /// nobody seated: where someone in a copy would come out.
    fn home_channel(&mut self, region: &str, character: CharacterId) -> u32 {
        let now = self.now();
        let ties = PartyMap { parties: &self.parties, members: &self.members, leaders: &self.leaders };
        let r = self.regions.entry(region.to_string()).or_insert_with(|| Region::new(region));
        let placed = r.place(character, &ties, now, &self.tuning);
        if placed.why == Placement::New {
            r.open_channel(placed.n, now);
        }
        placed.n
    }

    /// Once a second: every region's merges, followers and channels opened ahead, carried out.
    pub async fn review(&mut self, now: Millis) {
        let ids: Vec<String> = self.regions.keys().cloned().collect();
        for id in ids {
            let actions = {
                let ties = PartyMap { parties: &self.parties, members: &self.members, leaders: &self.leaders };
                let (standings, spaces) = (&self.standings, &self.spaces);
                let Some(r) = self.regions.get_mut(&id) else { continue };
                let at = |who: CharacterId| r.channel_of(who).and_then(|n| spaces.get(&SpaceId::channel(&id, n))).map(|s| s.lease.sim);
                let seats: HashMap<CharacterId, Option<SimId>> = r.channels().flat_map(|c| c.players.iter().map(|p| (*p, at(*p)))).collect();
                r.review(now, &ties, |who| Self::standing_of(standings, seats.get(&who).copied().flatten(), who), &self.tuning)
            };
            for a in actions {
                self.carry_out(&id, a).await;
            }
        }
    }

    /// What the policy answered, done: a channel's simulation started; its players told it's
    /// merging; someone moved; an emptied channel's simulation stopped.
    async fn carry_out(&mut self, region: &str, action: Action) {
        match action {
            Action::Open { n } => {
                if let Err(e) = self.ensure(&SpaceId::channel(region, n), None).await {
                    eprintln!("could not open channel {n} of {region}: {e}");
                }
            }
            Action::Merging { from, into, at } => {
                let players: Vec<CharacterId> =
                    self.regions.get(region).and_then(|r| r.channel(from)).map(|c| c.players.iter().copied().collect()).unwrap_or_default();
                let secs = ((at - self.now()).max(0) + 999) / 1000;
                for who in players {
                    let Some(conn) = self.who.get(&who).map(|w| w.conn) else { continue };
                    self.post.conn(conn, ToConn::Notice { text: format!("This channel is closing: you'll be moved to Channel {into} in {secs} seconds.") });
                    let view = self.channels_view(who, &Standing::default());
                    self.post.conn(conn, ToConn::Channels(Box::new(view)));
                }
            }
            Action::Move { who, from, to, why } => self.hand(region, who, from, to, why).await,
            Action::Close { n, .. } => {
                let space = SpaceId::channel(region, n);
                if let Some(r) = self.spaces.remove(&space) {
                    self.standings.remove(&r.lease.sim);
                    self.post.sim(r.lease.sim, ToSim::Stop);
                    if let Err(e) = self.leases.release(&space, r.lease.sim).await {
                        eprintln!("could not give up {space}'s lease: {e}");
                    }
                }
            }
        }
    }

    /// Moves `who` from channel `from` to channel `to` of `region` (the policy has them there
    /// already): granted there under a newer epoch, and handed over by the simulation they're in,
    /// standing where they stand.
    async fn hand(&mut self, region: &str, who: CharacterId, from: u32, to: u32, why: Why) {
        let space = SpaceId::channel(region, to);
        let (Some(from_sim), Ok(to_sim)) = (self.channel_sim(region, from), self.ensure(&space, None).await) else {
            eprintln!("could not move character {who} from channel {from} to {to} of {region}");
            return;
        };
        let epoch = match grants::bump(&self.db, who).await {
            Ok(e) => e,
            Err(e) => {
                eprintln!("could not grant character {who} to {space}: {e}");
                return;
            }
        };
        self.pending.insert(who, space.clone());
        self.post.sim(from_sim, ToSim::Hand { character: who, to: Grant { space, sim: to_sim, epoch }, after: vec![After::Channel { from, why }] });
    }

    /// Someone who joined a party: to its channel now if the rules allow, else as soon as they do
    /// (they're told why they wait).
    async fn follow(&mut self, who: CharacterId) {
        let region = self.region_of(who);
        let now = self.now();
        let follow = {
            let ties = PartyMap { parties: &self.parties, members: &self.members, leaders: &self.leaders };
            let sim =
                self.regions.get(&region).and_then(|r| r.channel_of(who)).and_then(|n| self.spaces.get(&SpaceId::channel(&region, n))).map(|r| r.lease.sim);
            let standing = Self::standing_of(&self.standings, sim, who);
            let Some(r) = self.regions.get_mut(&region) else { return };
            r.joined_party(who, &standing, &ties, now, &self.tuning)
        };
        match follow {
            Follow::Now(a) => self.carry_out(&region, a).await,
            Follow::Later(r) => {
                if let Some(conn) = self.who.get(&who).map(|w| w.conn) {
                    self.post.conn(conn, ToConn::Notice { text: format!("You'll join your party's channel as soon as you can. {}", r.sentence()) });
                }
            }
            Follow::Stay => {}
        }
    }

    /// Someone's region's channels, as they see them.
    fn channels_view(&self, who: CharacterId, standing: &Standing) -> ruina_channels::ChannelsView {
        let region = self.region_of(who);
        let ties = self.ties();
        match self.regions.get(&region) {
            Some(r) => r.view(who, standing, &ties, self.now(), &self.tuning),
            None => Region::new(&region).view(who, standing, &ties, self.now(), &self.tuning),
        }
    }

    /// Someone asks to change channel (`from`: the simulation they play in): moved, or told why not.
    /// An admin may open a channel by going to it.
    async fn change(&mut self, conn: Conn, from: SimId, to: Target, standing: Standing, dev: bool) {
        let who = conn.character;
        let region = self.region_of(who);
        let now = self.now();
        if dev
            && let Target::Channel(n) = to
            && let Some(r) = self.regions.get_mut(&region)
            && r.open_channel(n, now)
        {
            self.carry_out(&region, Action::Open { n }).await;
        }
        let done = {
            let ties = PartyMap { parties: &self.parties, members: &self.members, leaders: &self.leaders };
            match self.regions.get_mut(&region) {
                Some(r) if self.spaces.get(&SpaceId::channel(&region, r.channel_of(who).unwrap_or(0))).is_some_and(|s| s.lease.sim == from) => {
                    r.change(who, to, &standing, &ties, now, &self.tuning)
                }
                _ => Err(ruina_channels::Refusal::NotHere),
            }
        };
        match done {
            Ok(a) => self.carry_out(&region, a).await,
            Err(r) => {
                self.post.conn(conn, ToConn::Error { text: r.sentence() });
            }
        }
    }
}

/// Parties as the channels' policy asks of them (the social tier's, as the directory keeps them).
struct PartyMap<'a> {
    parties: &'a HashMap<CharacterId, PartyId>,
    members: &'a HashMap<PartyId, Vec<CharacterId>>,
    leaders: &'a HashMap<PartyId, CharacterId>,
}

impl Ties for PartyMap<'_> {
    fn party(&self, who: CharacterId) -> Option<PartyTies> {
        let p = self.parties.get(&who)?;
        let members = self.members.get(p).cloned().unwrap_or_else(|| vec![who]);
        let leader = self.leaders.get(p).copied().or_else(|| members.first().copied())?;
        Some(PartyTies { leader, members })
    }
}
