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

/// Every mailbox in this process, and the way to the rest of the world.
#[derive(Default)]
pub struct Post {
    /// Where mail for an address this process doesn't hold goes (another process's tiers, over a
    /// transport between processes: crates/link). None in one process alone.
    remote: RwLock<Option<Arc<dyn Transport>>>,
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

    /// Mail for addresses not held here goes through `remote` from now on.
    pub fn set_remote(&self, remote: Arc<dyn Transport>) {
        *write(&self.remote) = Some(remote);
    }

    /// Mail this process has no mailbox for: to the rest of the world, if there's a way there.
    #[allow(clippy::result_large_err)]
    fn elsewhere(&self, to: Address, msg: Message) -> Result<(), Message> {
        let remote = read(&self.remote).clone();
        match remote {
            Some(r) => r.send(to, msg),
            None => Err(msg),
        }
    }

    pub fn open_directory(&self) -> mpsc::UnboundedReceiver<ToDirectory> {
        let (tx, rx) = mpsc::unbounded_channel();
        *write(&self.directory) = Some(tx);
        rx
    }
}

impl Post {
    /// Delivers to a mailbox in this process only (mail that came from another process: never
    /// sent on again, so two processes can't pass it back and forth). Handed back if there's none.
    #[allow(clippy::result_large_err)]
    pub fn here(&self, to: Address, msg: Message) -> Result<(), Message> {
        match (to, msg) {
            (Address::Sim(id), Message::Sim(m)) => match read(&self.sims).get(&id).cloned() {
                Some(tx) => tx.send(m).map_err(|e| Message::Sim(e.0)),
                None => Err(Message::Sim(m)),
            },
            (Address::Gate(id), Message::Gate(m)) => match read(&self.gates).get(&id).cloned() {
                Some(tx) => tx.send(m).map_err(|e| Message::Gate(e.0)),
                None => Err(Message::Gate(m)),
            },
            (Address::Store, Message::Store(m)) => match read(&self.store).clone() {
                Some(tx) => tx.send(m).map_err(|e| Message::Store(e.0)),
                None => Err(Message::Store(m)),
            },
            (Address::Social, Message::Social(m)) => match read(&self.social).clone() {
                Some(tx) => tx.send(m).map_err(|e| Message::Social(e.0)),
                None => Err(Message::Social(m)),
            },
            (Address::Directory, Message::Directory(m)) => match read(&self.directory).clone() {
                Some(tx) => tx.send(m).map_err(|e| Message::Directory(e.0)),
                None => Err(Message::Directory(m)),
            },
            // A message that doesn't fit its address.
            (_, m) => Err(m),
        }
    }

    /// Whether a mailbox for  is in this process.
    pub fn holds(&self, to: Address) -> bool {
        match to {
            Address::Sim(id) => read(&self.sims).contains_key(&id),
            Address::Gate(id) => read(&self.gates).contains_key(&id),
            Address::Store => read(&self.store).is_some(),
            Address::Social => read(&self.social).is_some(),
            Address::Directory => read(&self.directory).is_some(),
        }
    }
}

impl Transport for Post {
    #[allow(clippy::result_large_err)]
    fn send(&self, to: Address, msg: Message) -> Result<(), Message> {
        if !msg.fits(to) {
            return Err(msg);
        }
        if self.holds(to) {
            return self.here(to, msg);
        }
        self.elsewhere(to, msg)
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

    /// The rest of the world, standing in: whatever is sent there is kept.
    #[derive(Default)]
    struct Elsewhere(std::sync::Mutex<Vec<Address>>);

    impl Transport for Elsewhere {
        fn send(&self, to: Address, _msg: Message) -> Result<(), Message> {
            self.0.lock().unwrap().push(to);
            Ok(())
        }
    }

    #[test]
    fn mail_for_another_process_goes_there_and_mail_from_one_stays_here() {
        let post = Post::new();
        let elsewhere = Arc::new(Elsewhere::default());
        post.set_remote(elsewhere.clone());
        let sim = post.open_sim(SimId(5));
        assert!(post.holds(Address::Sim(SimId(5))) && !post.holds(Address::Sim(SimId(6))) && !post.holds(Address::Store));
        // Held here: delivered here.
        assert!(post.sim(SimId(5), ToSim::Stop));
        assert!(matches!(sim.try_recv(), Ok(ToSim::Stop)));
        // Not held here: on to the rest of the world.
        assert!(post.sim(SimId(6), ToSim::Stop));
        assert!(post.send(Address::Store, Message::Store(ruina_world_api::store::ToStore::LoadMarket { reply: SimId(5) })).is_ok());
        assert_eq!(*elsewhere.0.lock().unwrap(), vec![Address::Sim(SimId(6)), Address::Store]);
        // What came from another process is delivered here or not at all: never sent on again.
        assert!(post.here(Address::Sim(SimId(6)), Message::Sim(ToSim::Stop)).is_err());
        assert_eq!(elsewhere.0.lock().unwrap().len(), 2);
        assert!(post.here(Address::Sim(SimId(5)), Message::Sim(ToSim::Stop)).is_ok());
    }
}
