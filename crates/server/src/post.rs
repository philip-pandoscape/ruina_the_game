//! The post: how the server's tiers send each other messages in one process. It is world-api's
//! `Transport` over channels: the store, social and the directory have a mailbox each, and every
//! gate and every simulation one of its own, opened as it starts and closed as it stops. A message
//! for an address with no mailbox is dropped (`send` says false). A transport between processes
//! would carry the envelopes for the addresses this process doesn't hold; the tiers send through
//! `Transport` and don't know which.
//!
//! The simulations run on threads of their own and take their messages at tick boundaries, so
//! theirs are std channels (waited on with a timeout while there's nothing to play); the other
//! tiers are tokio tasks.

use std::collections::HashMap;
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, RwLock};

use tokio::sync::mpsc;

use ruina_world_api::directory::ToDirectory;
use ruina_world_api::gate::ToGate;
use ruina_world_api::sim::ToSim;
use ruina_world_api::social::ToSocial;
use ruina_world_api::store::ToStore;
use ruina_world_api::{Address, GateId, Message, SimId, Transport};

/// Every mailbox in this process.
#[derive(Default)]
pub struct Post {
    sims: RwLock<HashMap<SimId, std_mpsc::Sender<ToSim>>>,
    gates: RwLock<HashMap<GateId, mpsc::UnboundedSender<ToGate>>>,
    store: RwLock<Option<mpsc::UnboundedSender<ToStore>>>,
    social: RwLock<Option<mpsc::UnboundedSender<ToSocial>>>,
    directory: RwLock<Option<mpsc::UnboundedSender<ToDirectory>>>,
}

/// A lock that a tier which panicked while holding it doesn't keep from everyone else.
fn read<T>(l: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    l.read().unwrap_or_else(|e| e.into_inner())
}

fn write<T>(l: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    l.write().unwrap_or_else(|e| e.into_inner())
}

impl Post {
    pub fn new() -> Arc<Post> {
        Arc::new(Post::default())
    }

    /// A simulation's mailbox, opened before it starts.
    pub fn open_sim(&self, id: SimId) -> std_mpsc::Receiver<ToSim> {
        let (tx, rx) = std_mpsc::channel();
        write(&self.sims).insert(id, tx);
        rx
    }

    /// A simulation stopped: its mail goes nowhere now.
    pub fn close_sim(&self, id: SimId) {
        write(&self.sims).remove(&id);
    }

    pub fn has_sim(&self, id: SimId) -> bool {
        read(&self.sims).contains_key(&id)
    }

    pub fn open_gate(&self, id: GateId) -> mpsc::UnboundedReceiver<ToGate> {
        let (tx, rx) = mpsc::unbounded_channel();
        write(&self.gates).insert(id, tx);
        rx
    }

    pub fn open_store(&self) -> mpsc::UnboundedReceiver<ToStore> {
        let (tx, rx) = mpsc::unbounded_channel();
        *write(&self.store) = Some(tx);
        rx
    }

    pub fn open_social(&self) -> mpsc::UnboundedReceiver<ToSocial> {
        let (tx, rx) = mpsc::unbounded_channel();
        *write(&self.social) = Some(tx);
        rx
    }

    pub fn open_directory(&self) -> mpsc::UnboundedReceiver<ToDirectory> {
        let (tx, rx) = mpsc::unbounded_channel();
        *write(&self.directory) = Some(tx);
        rx
    }
}

impl Transport for Post {
    #[allow(clippy::result_large_err)]
    fn send(&self, to: Address, msg: Message) -> Result<(), Message> {
        match (to, msg) {
            (Address::Sim(id), Message::Sim(m)) => match read(&self.sims).get(&id) {
                Some(tx) => tx.send(m).map_err(|e| Message::Sim(e.0)),
                None => Err(Message::Sim(m)),
            },
            (Address::Gate(id), Message::Gate(m)) => match read(&self.gates).get(&id) {
                Some(tx) => tx.send(m).map_err(|e| Message::Gate(e.0)),
                None => Err(Message::Gate(m)),
            },
            (Address::Store, Message::Store(m)) => match read(&self.store).as_ref() {
                Some(tx) => tx.send(m).map_err(|e| Message::Store(e.0)),
                None => Err(Message::Store(m)),
            },
            (Address::Social, Message::Social(m)) => match read(&self.social).as_ref() {
                Some(tx) => tx.send(m).map_err(|e| Message::Social(e.0)),
                None => Err(Message::Social(m)),
            },
            (Address::Directory, Message::Directory(m)) => match read(&self.directory).as_ref() {
                Some(tx) => tx.send(m).map_err(|e| Message::Directory(e.0)),
                None => Err(Message::Directory(m)),
            },
            // A message that doesn't fit its address.
            (_, m) => Err(m),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ruina_world_api::Conn;
    use ruina_world_api::gate::ToConn;

    #[tokio::test]
    async fn mail_reaches_its_mailbox_and_nothing_else() {
        let post = Post::new();
        let mut gate = post.open_gate(GateId(1));
        let sim = post.open_sim(SimId(5));
        let conn = Conn { gate: GateId(1), character: 3, session: 9 };
        assert!(post.conn(conn, ToConn::Notice { text: "hello".into() }));
        assert!(matches!(gate.recv().await, Some(ToGate::Conn { conn: c, msg: ToConn::Notice { .. } }) if c == conn));
        assert!(post.sim(SimId(5), ToSim::Stop));
        assert!(matches!(sim.try_recv(), Ok(ToSim::Stop)));
        // Nobody there, or the wrong kind of message for the address.
        assert!(!post.sim(SimId(6), ToSim::Stop));
        assert!(post.send(Address::Store, Message::Sim(ToSim::Stop)).is_err());
        post.close_sim(SimId(5));
        assert!(!post.sim(SimId(5), ToSim::Stop));
    }
}
