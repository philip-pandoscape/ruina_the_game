//! How the tiers' messages reach each other: an address for every tier, an envelope a transport
//! carries, and the transport itself. In one process the server's tiers pass messages over tokio
//! channels (`crates/server/src/post.rs`); a transport between processes carries the same envelopes,
//! framed over TCP, and the tiers don't notice which.

use serde::{Deserialize, Serialize};

use crate::directory::ToDirectory;
use crate::gate::{ToConn, ToGate};
use crate::ids::{Conn, GateId, SimId};
use crate::sim::ToSim;
use crate::social::ToSocial;
use crate::store::ToStore;

/// Where a message goes. A connection is reached through its gate ([`Transport::conn`]).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Serialize, Deserialize)]
pub enum Address {
    Sim(SimId),
    Gate(GateId),
    Store,
    Social,
    Directory,
}

/// Any tier's message.
#[derive(Debug, Serialize, Deserialize)]
pub enum Message {
    Sim(ToSim),
    Gate(ToGate),
    Store(ToStore),
    Social(ToSocial),
    Directory(ToDirectory),
}

impl Message {
    /// Whether it belongs at `to` (a sim's message at a sim, and so on).
    pub fn fits(&self, to: Address) -> bool {
        matches!(
            (self, to),
            (Message::Sim(_), Address::Sim(_))
                | (Message::Gate(_), Address::Gate(_))
                | (Message::Store(_), Address::Store)
                | (Message::Social(_), Address::Social)
                | (Message::Directory(_), Address::Directory)
        )
    }
}

/// A message with its address, as a transport between processes carries it.
#[derive(Debug, Serialize, Deserialize)]
pub struct Envelope {
    pub to: Address,
    pub msg: Message,
}

/// Where an answer goes: the asker's address, and its own number for the question.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Reply {
    pub to: Address,
    pub id: u64,
}

/// An answer to a question one tier asked another.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Answer {
    /// Whether a character is being played.
    Playing(bool),
    /// How many lives were written.
    Written { lives: usize },
}

/// How a tier's messages reach the others. Sending never waits: a message is queued at its address,
/// which takes it in its own time (a simulation at its next tick).
pub trait Transport: Send + Sync {
    /// Sends `msg` to `to`. False if nothing is there to take it (a simulation that stopped, a gate
    /// gone, a message that doesn't fit its address).
    fn send(&self, to: Address, msg: Message) -> bool;

    fn sim(&self, id: SimId, msg: ToSim) -> bool {
        self.send(Address::Sim(id), Message::Sim(msg))
    }

    fn gate(&self, id: GateId, msg: ToGate) -> bool {
        self.send(Address::Gate(id), Message::Gate(msg))
    }

    /// A message for one connection, through its gate.
    fn conn(&self, conn: Conn, msg: ToConn) -> bool {
        self.gate(conn.gate, ToGate::Conn { conn, msg })
    }

    fn store(&self, msg: ToStore) -> bool {
        self.send(Address::Store, Message::Store(msg))
    }

    fn social(&self, msg: ToSocial) -> bool {
        self.send(Address::Social, Message::Social(msg))
    }

    fn directory(&self, msg: ToDirectory) -> bool {
        self.send(Address::Directory, Message::Directory(msg))
    }

    /// An answer, to whoever asked.
    fn answer(&self, reply: Reply, answer: Answer) -> bool {
        match reply.to {
            Address::Gate(g) => self.gate(g, ToGate::Answer { id: reply.id, answer }),
            Address::Directory => self.directory(ToDirectory::Answer { id: reply.id, answer }),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{Conn, GateId};

    #[test]
    fn an_envelope_crosses_as_text_and_back() {
        let conn = Conn { gate: GateId(1), character: 7, session: 99 };
        let e = Envelope { to: Address::Gate(GateId(1)), msg: Message::Gate(ToGate::Conn { conn, msg: ToConn::Notice { text: "Hello".into() } }) };
        assert!(e.msg.fits(e.to));
        assert!(!e.msg.fits(Address::Store));
        let text = serde_json::to_string(&e).unwrap();
        let back: Envelope = serde_json::from_str(&text).unwrap();
        assert_eq!(back.to, e.to);
        assert!(matches!(back.msg, Message::Gate(ToGate::Conn { conn: c, msg: ToConn::Notice { ref text } }) if c == conn && text == "Hello"));
    }
}
