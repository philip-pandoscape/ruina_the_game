//! World-api's post between processes: the tiers' `Transport` carried over links.
//!
//! Each process runs one node. A message for an address another process takes goes over the link to
//! that process as world-api's `Envelope` (the address and the message), and arrives in that
//! process's inbox, to be handed to the tier it's for (`deliver`, into the process's own post). Which
//! process takes which address is the directory's word, kept in a `Book`: a simulation is where the
//! lease on its space says, and a gate, the store, social and the directory where the nodes table
//! says (`crates/server/src/cluster`).

use std::collections::HashMap;
use std::sync::RwLock;

use ruina_world_api::post::{Address, Envelope, Message, Transport};

use crate::{Config, Inbox, Link, Node};

/// What world-api's post speaks on its links (raised when its messages change in a way an older
/// process can't read: processes speaking different versions refuse each other's links).
pub const PROTOCOL: &str = "world-api/1";

/// The defaults, speaking world-api's post.
pub fn config() -> Config {
    Config::speaking(PROTOCOL)
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
pub struct LinkPost {
    node: Node<Envelope>,
    book: RwLock<Book>,
}

impl LinkPost {
    pub fn new(node: Node<Envelope>) -> LinkPost {
        LinkPost { node, book: RwLock::default() }
    }

    pub fn node(&self) -> &Node<Envelope> {
        &self.node
    }

    /// The directory's word: `at` is taken by `node` at `addr`.
    pub fn place(&self, at: Address, node: &str, addr: &str) {
        self.book.write().unwrap().place(at, node, addr);
    }

    pub fn forget(&self, at: Address) {
        self.book.write().unwrap().forget(at);
    }

    /// The link to whoever takes `at`, if anyone is known to.
    pub fn link_to(&self, at: Address) -> Option<Link<Envelope>> {
        let book = self.book.read().unwrap();
        let (node, addr) = book.find(at)?;
        Some(self.node.link(node, addr))
    }
}

impl Transport for LinkPost {
    /// Never waits: queued on the link to the process that takes `to` (`Link::push`). False if no
    /// process is known to take it, the message doesn't fit its address, or the link is full.
    fn send(&self, to: Address, msg: Message) -> bool {
        if !msg.fits(to) {
            return false;
        }
        let Some(link) = self.link_to(to) else { return false };
        link.push(&Envelope { to, msg }).is_ok()
    }
}

/// Hands what arrives in a process's inbox to its own post, addressed as it was sent, until the
/// node stops. `local`: the process's in-process post (tokio channels), which delivers to its tiers.
pub async fn deliver(mut inbox: Inbox<Envelope>, local: &dyn Transport) {
    while let Some(e) = inbox.recv().await {
        let Envelope { to, msg } = e.msg;
        if !local.send(to, msg) {
            eprintln!("post: a message for {to:?} from {} found nobody to take it here", e.from);
        }
    }
}
