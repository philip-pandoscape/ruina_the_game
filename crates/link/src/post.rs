//! World-api's post between processes: the tiers' `Transport` carried over links.
//!
//! Each process runs one node. A message for an address another process takes goes over the link to
//! that process as world-api's `Envelope` (the address and the message), and the process it reaches
//! hands it to the tier it's for, in its own post. Which process takes which address is the
//! directory's word, kept in a `Book` (`place`). Mail for an address nobody is known to take yet (a
//! simulation just started elsewhere) is parked, and goes as soon as the book says where; what waits
//! too long comes back to the caller (`expire`), who knows what to do with it (a player on their
//! way somewhere is sent back where they came from).
//!
//! A node's links may carry more than envelopes (a process's own messages beside the tiers'):
//! `Carries` says how an envelope goes into what they carry and comes back out.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

use ruina_world_api::post::{Address, Envelope, Message, Transport};
use tokio::sync::Notify;

use crate::{Config, Link, Node};

/// What world-api's post speaks on its links (raised when its messages change in a way an older
/// process can't read: processes speaking different versions refuse each other's links).
pub const PROTOCOL: &str = "world-api/1";

/// The defaults, speaking world-api's post.
pub fn config() -> Config {
    Config::speaking(PROTOCOL)
}

/// What a node's links carry, when world-api's envelopes are among it.
pub trait Carries: crate::Message + Sized {
    fn wrap(e: Envelope) -> Self;
    /// The envelope it carries, if it's one (else itself, unchanged).
    fn unwrap(self) -> Result<Envelope, Self>;
}

impl Carries for Envelope {
    fn wrap(e: Envelope) -> Self {
        e
    }

    fn unwrap(self) -> Result<Envelope, Self> {
        Ok(self)
    }
}

/// Where each address is taken: the node (process) and where to dial it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Book {
    places: HashMap<Address, (String, String)>,
}

impl Book {
    /// `at` is taken by `node`, dialled at `addr`.
    pub fn place(&mut self, at: Address, node: &str, addr: &str) {
        self.places.insert(at, (node.to_string(), addr.to_string()));
    }

    pub fn forget(&mut self, at: Address) {
        self.places.remove(&at);
    }

    /// The node taking `at`, and its address.
    pub fn find(&self, at: Address) -> Option<(&str, &str)> {
        self.places.get(&at).map(|(n, a)| (n.as_str(), a.as_str()))
    }
}

/// The tiers' messages to other processes, over links.
pub struct LinkPost<M: Carries = Envelope> {
    node: Node<M>,
    book: RwLock<Book>,
    /// Mail for addresses not in the book yet, oldest first.
    parked: Mutex<HashMap<Address, VecDeque<(Instant, Message)>>>,
    /// Told when mail is parked: whoever fills the book (from the directory) looks it up.
    missing: Notify,
}

impl<M: Carries> LinkPost<M> {
    pub fn new(node: Node<M>) -> LinkPost<M> {
        LinkPost { node, book: RwLock::default(), parked: Mutex::default(), missing: Notify::new() }
    }

    pub fn node(&self) -> &Node<M> {
        &self.node
    }

    /// The directory's word: `at` is taken by `node` at `addr`. Mail parked for it goes now.
    pub fn place(&self, at: Address, node: &str, addr: &str) {
        self.book.write().unwrap().place(at, node, addr);
        let parked = self.parked.lock().unwrap().remove(&at);
        if let Some(parked) = parked {
            let link = self.node.link(node, addr);
            for (_, msg) in parked {
                if let Err(SendBack(msg)) = push(&link, at, msg) {
                    eprintln!("post: a message for {at:?} couldn't be queued for {node}: {msg:?}");
                }
            }
        }
    }

    /// Nobody takes `at` any more (its process went, its simulation stopped).
    pub fn forget(&self, at: Address) {
        self.book.write().unwrap().forget(at);
    }

    /// Where `at` is taken, if the book knows.
    pub fn find(&self, at: Address) -> Option<(String, String)> {
        self.book.read().unwrap().find(at).map(|(n, a)| (n.to_string(), a.to_string()))
    }

    /// The addresses mail is parked for.
    pub fn missing(&self) -> Vec<Address> {
        self.parked.lock().unwrap().keys().copied().collect()
    }

    /// Resolves when mail is parked for an address the book doesn't have.
    pub async fn wanted(&self) {
        self.missing.notified().await
    }

    /// Mail parked longer than `max`, taken out (to be sent back where it came from, or dropped).
    pub fn expire(&self, max: Duration) -> Vec<(Address, Message)> {
        let mut out = Vec::new();
        let mut parked = self.parked.lock().unwrap();
        for (at, q) in parked.iter_mut() {
            while q.front().is_some_and(|(since, _)| since.elapsed() > max) {
                out.push((*at, q.pop_front().expect("there").1));
            }
        }
        parked.retain(|_, q| !q.is_empty());
        out
    }

    /// The link to whoever takes `at`, if anyone is known to.
    pub fn link_to(&self, at: Address) -> Option<Link<M>> {
        let book = self.book.read().unwrap();
        let (node, addr) = book.find(at)?;
        Some(self.node.link(node, addr))
    }
}

struct SendBack(Message);

/// The message comes back whole when it can't be queued: as big as it was.
#[allow(clippy::result_large_err)]
fn push<M: Carries>(link: &Link<M>, to: Address, msg: Message) -> Result<(), SendBack> {
    let wrapped = M::wrap(Envelope { to, msg });
    match link.push(&wrapped) {
        Ok(_) => Ok(()),
        Err(_) => match wrapped.unwrap() {
            Ok(e) => Err(SendBack(e.msg)),
            Err(_) => unreachable!("an envelope wrapped comes back out"),
        },
    }
}

impl<M: Carries> Transport for LinkPost<M> {
    /// Never waits: queued on the link to the process that takes `to` (`Link::push`), or parked
    /// until the book says where that is. Handed back if the message doesn't fit its address, or the
    /// link is full (the process there is far behind, or gone).
    #[allow(clippy::result_large_err)]
    fn send(&self, to: Address, msg: Message) -> Result<(), Message> {
        if !msg.fits(to) {
            return Err(msg);
        }
        let Some(link) = self.link_to(to) else {
            self.parked.lock().unwrap().entry(to).or_default().push_back((Instant::now(), msg));
            self.missing.notify_one();
            return Ok(());
        };
        push(&link, to, msg).map_err(|SendBack(m)| m)
    }
}
