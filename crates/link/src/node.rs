//! A node: one process's end of all its links. It listens for links in, dials links out (out.rs),
//! and hands what arrives to its inbox, once each and in order per link (inbound.rs).

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::net::{TcpListener, ToSocketAddrs};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use crate::Config;
use crate::out::{Link, Out, SendError};

/// What a node's messages must be: written and read by serde, and sent between threads.
pub trait Message: Serialize + DeserializeOwned + Send + 'static {}

impl<T: Serialize + DeserializeOwned + Send + 'static> Message for T {}

/// A message's id: the start of the node that sent it (its incarnation) and its number on the link
/// it came by. The same every time the message is delivered (to a receiver that restarted before
/// acknowledging it, say), so whatever must happen once can be keyed by it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct MsgId {
    pub incarnation: u64,
    pub seq: u64,
}

/// A message as it arrives.
#[derive(Debug)]
pub struct Envelope<M> {
    /// The node that sent it.
    pub from: String,
    pub id: MsgId,
    pub msg: M,
    /// Its request id, when the sender waits for an answer (`Node::reply`); 0 when not.
    pub(crate) request: u64,
}

impl<M> Envelope<M> {
    /// Whether the sender waits for an answer (`Node::reply`).
    pub fn wants_reply(&self) -> bool {
        self.request != 0
    }
}

/// What happens to a node's links, for whoever needs to know (a gate re-routing, a test).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// A link's connection came up; `incarnation`: which start of the peer answered.
    Up { peer: String, incarnation: u64 },
    /// A link's connection went down; it's being dialled again.
    Down { peer: String, why: String },
    /// The peer is a new start of itself: what it never acknowledged is being sent again.
    Restarted { peer: String, was: u64, now: u64 },
    /// The peer won't take the link (it speaks another protocol, or isn't who was dialled).
    Refused { peer: String, why: String },
}

/// Where a node's messages arrive.
pub struct Inbox<M> {
    rx: mpsc::Receiver<Envelope<M>>,
}

impl<M> Inbox<M> {
    /// The next message; None once the node has stopped.
    pub async fn recv(&mut self) -> Option<Envelope<M>> {
        self.rx.recv().await
    }

    pub fn try_recv(&mut self) -> Option<Envelope<M>> {
        self.rx.try_recv().ok()
    }
}

/// What a node has taken in so far.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NodeStats {
    /// Messages delivered (to the inbox, or as answers).
    pub delivered: u64,
    /// Messages that arrived again after they'd been delivered, and were dropped.
    pub duplicates: u64,
    /// Messages that couldn't be read (skipped, and said so on stderr).
    pub undecodable: u64,
    /// Connections taken in.
    pub calls: u64,
}

#[derive(Default)]
pub(crate) struct Counters {
    pub delivered: AtomicU64,
    pub duplicates: AtomicU64,
    pub undecodable: AtomicU64,
    pub calls: AtomicU64,
}

/// What a node has delivered from one peer: which start of it, and up to which number.
pub(crate) struct FromPeer {
    pub incarnation: u64,
    pub delivered: u64,
}

impl FromPeer {
    /// A connection from the peer says hello: its start, and the oldest message it still holds.
    /// The last delivered, which it needn't send again.
    pub fn meet(&mut self, incarnation: u64, first_unacked: u64) -> u64 {
        let before = first_unacked.saturating_sub(1);
        if self.incarnation != incarnation {
            // A new start numbers its messages afresh.
            self.incarnation = incarnation;
            self.delivered = before;
        } else {
            // Whatever it no longer holds was delivered (by this node, or a start of it before).
            self.delivered = self.delivered.max(before);
        }
        self.delivered
    }
}

pub(crate) struct Shared<M> {
    pub id: String,
    pub incarnation: u64,
    pub local: SocketAddr,
    /// Where other nodes dial this one.
    pub advertise: String,
    /// The protocol and encoding, as the handshake says them.
    pub protocol: String,
    pub config: Config,
    pub links: Mutex<HashMap<String, Arc<Out>>>,
    pub from_peers: Mutex<HashMap<String, Arc<tokio::sync::Mutex<FromPeer>>>>,
    /// Where each peer that has called this node takes messages (its hello said), for answers.
    pub addresses: Mutex<HashMap<String, String>>,
    pub inbox: mpsc::Sender<Envelope<M>>,
    /// Requests waiting for their answers, by id.
    pub pending: Mutex<HashMap<u64, oneshot::Sender<M>>>,
    next_request: AtomicU64,
    pub events: broadcast::Sender<Event>,
    pub stop: watch::Sender<bool>,
    pub counters: Counters,
}

impl<M> Shared<M> {
    pub fn event(&self, e: Event) {
        let _ = self.events.send(e);
    }

    pub fn peer_state(&self, peer: &str) -> Arc<tokio::sync::Mutex<FromPeer>> {
        self.from_peers
            .lock()
            .unwrap()
            .entry(peer.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(FromPeer { incarnation: 0, delivered: 0 })))
            .clone()
    }

    /// A request id no other start of this node has used (they begin at the start's random
    /// incarnation), so a late answer meant for an earlier start can't be mistaken for one now.
    pub fn next_request(&self) -> u64 {
        loop {
            let id = self.next_request.fetch_add(1, Ordering::Relaxed);
            if id != 0 {
                return id;
            }
        }
    }
}

impl<M: Message> Shared<M> {
    /// A message taken in, in its turn: an answer goes to whoever is waiting for it, anything else
    /// to the inbox (waiting while the inbox is full, which holds the link back).
    pub async fn deliver(&self, from: &str, id: MsgId, request: u64, reply_to: u64, body: &[u8]) -> io::Result<()> {
        let msg: M = match self.config.encoding.decode(body) {
            Ok(m) => m,
            Err(e) => {
                self.counters.undecodable.fetch_add(1, Ordering::Relaxed);
                eprintln!("link {}: message {} from {from} unreadable, skipped: {e}", self.id, id.seq);
                return Ok(());
            }
        };
        self.counters.delivered.fetch_add(1, Ordering::Relaxed);
        if reply_to != 0 {
            // An answer nobody waits for any more (it came too late) is dropped.
            if let Some(waiting) = self.pending.lock().unwrap().remove(&reply_to) {
                let _ = waiting.send(msg);
            }
            return Ok(());
        }
        self.inbox.send(Envelope { from: from.to_string(), id, msg, request }).await.map_err(|_| io::Error::other("the inbox is closed"))
    }
}

/// One process's end of all its links.
pub struct Node<M> {
    pub(crate) shared: Arc<Shared<M>>,
}

impl<M> Clone for Node<M> {
    fn clone(&self) -> Self {
        Node { shared: self.shared.clone() }
    }
}

impl<M: Message> Node<M> {
    /// Starts a node named `id` (unique among the processes that link to each other: the
    /// directory's node id), listening on `listen` (port 0 for any free port).
    pub async fn start(id: impl Into<String>, listen: impl ToSocketAddrs, config: Config) -> io::Result<(Node<M>, Inbox<M>)> {
        let listener = TcpListener::bind(listen).await?;
        let local = listener.local_addr()?;
        let incarnation = fresh_incarnation();
        let (tx, rx) = mpsc::channel(config.inbox.max(1));
        let shared = Arc::new(Shared {
            id: id.into(),
            incarnation,
            local,
            advertise: config.advertise.clone().unwrap_or_else(|| local.to_string()),
            protocol: format!("{}+{}", config.protocol, config.encoding.name()),
            config,
            links: Mutex::default(),
            from_peers: Mutex::default(),
            addresses: Mutex::default(),
            inbox: tx,
            pending: Mutex::default(),
            next_request: AtomicU64::new(incarnation),
            events: broadcast::channel(1024).0,
            stop: watch::channel(false).0,
            counters: Counters::default(),
        });
        tokio::spawn(accept(shared.clone(), listener));
        Ok((Node { shared }, Inbox { rx }))
    }

    pub fn id(&self) -> &str {
        &self.shared.id
    }

    /// Which start of this node this is: a random number drawn when it started.
    pub fn incarnation(&self) -> u64 {
        self.shared.incarnation
    }

    /// The address it listens on.
    pub fn local_addr(&self) -> SocketAddr {
        self.shared.local
    }

    /// The address other nodes dial it at (`Config::advertise`, or the one it listens on).
    pub fn advertised(&self) -> &str {
        &self.shared.advertise
    }

    /// The link to `peer`, dialled at `addr`: made the first time, the same one after. Given
    /// another address (the peer moved, as the directory says), it dials that from then on.
    pub fn link(&self, peer: &str, addr: &str) -> Link<M> {
        let mut links = self.shared.links.lock().unwrap();
        if let Some(out) = links.get(peer) {
            out.dial(addr);
            return Link::new(self.shared.clone(), out.clone());
        }
        let out = Arc::new(Out::new(peer, addr, self.shared.incarnation));
        links.insert(peer.to_string(), out.clone());
        tokio::spawn(crate::out::run(self.shared.clone(), out.clone()));
        Link::new(self.shared.clone(), out)
    }

    /// The link to a peer that has called this node (its hello said where it takes messages), or
    /// one already made.
    pub fn link_back(&self, peer: &str) -> Option<Link<M>> {
        if let Some(out) = self.shared.links.lock().unwrap().get(peer) {
            return Some(Link::new(self.shared.clone(), out.clone()));
        }
        let addr = self.shared.addresses.lock().unwrap().get(peer).cloned()?;
        Some(self.link(peer, &addr))
    }

    /// Answers a message whose sender waits for it (`Link::request`). Never waits (as `Link::push`).
    pub fn reply(&self, to: &Envelope<M>, msg: &M) -> Result<MsgId, SendError> {
        if to.request == 0 {
            return Err(SendError::NotAsked);
        }
        let link = self.link_back(&to.from).ok_or(SendError::Closed)?;
        link.queue(msg, 0, to.request, link.limit())
    }

    /// What happens to this node's links from now on.
    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.shared.events.subscribe()
    }

    pub fn stats(&self) -> NodeStats {
        let c = &self.shared.counters;
        NodeStats {
            delivered: c.delivered.load(Ordering::Relaxed),
            duplicates: c.duplicates.load(Ordering::Relaxed),
            undecodable: c.undecodable.load(Ordering::Relaxed),
            calls: c.calls.load(Ordering::Relaxed),
        }
    }

    /// Stops listening and drops every connection. Whatever wasn't acknowledged is lost with this
    /// start of the node; a peer's link to it keeps trying, and finds the next start.
    pub fn stop(&self) {
        self.shared.stop.send_replace(true);
        self.shared.pending.lock().unwrap().clear();
    }
}

async fn accept<M: Message>(shared: Arc<Shared<M>>, listener: TcpListener) {
    let mut stop = shared.stop.subscribe();
    loop {
        tokio::select! {
            r = listener.accept() => match r {
                Ok((stream, _)) => {
                    shared.counters.calls.fetch_add(1, Ordering::Relaxed);
                    tokio::spawn(crate::inbound::serve(shared.clone(), stream));
                }
                // Out of file handles, say: try again in a moment rather than stop listening.
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            },
            _ = crate::until(&mut stop, |s| *s) => return,
        }
    }
}

/// A number for this start of the node: random (std's hasher keys come from the system's
/// randomness) and never 0.
fn fresh_incarnation() -> u64 {
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
    h.write_u32(std::process::id());
    h.finish().max(1)
}
