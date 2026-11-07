//! What the processes' links carry (crates/link): the tiers' messages, world-api's envelopes, and
//! beside them the processes' own: the directory starting a simulation in a sim's process, and what
//! each process says of itself (and counts, for the harness).

use ruina_link::post::Carries;
use ruina_world_api::directory::Lease;
use ruina_world_api::post::Envelope;
use ruina_world_api::{Millis, Owner};
use serde::{Deserialize, Serialize};

use crate::cluster::Status;

/// The protocol the processes speak on their links: raised when what they carry changes in a way
/// an older process can't read (world-api's messages among it).
pub const PROTOCOL: &str = "ruina-cluster/3";

#[derive(Debug, Serialize, Deserialize)]
pub enum Wire {
    /// A tier's message, for a tier in the process it reaches.
    Post(Envelope),
    /// The directory starts a simulation here (a sim's process).
    Spawn(Spawn),
    /// What do you play? (a request, answered with `Here`)
    Status,
    Here(Status),
    /// A numbered message on a stream, counted by whoever it reaches (the harness).
    Count {
        stream: u64,
        n: u64,
    },
    /// How many of a stream have you had, and were they in order? (answered with `Counted`)
    Tally {
        stream: u64,
    },
    Counted {
        stream: u64,
        received: u64,
        in_order: bool,
        last: u64,
    },
}

impl Carries for Wire {
    fn wrap(e: Envelope) -> Self {
        Wire::Post(e)
    }

    fn unwrap(self) -> Result<Envelope, Self> {
        match self {
            Wire::Post(e) => Ok(e),
            other => Err(other),
        }
    }
}

/// A simulation to start: its lease (its id, space, epoch and chunks), whose copy it is, how long
/// whoever doesn't belong may stay, and when the lease was granted (by the directory's clock), from
/// which the simulation's keeper counts its first deadline.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Spawn {
    pub lease: Lease,
    pub owner: Option<Owner>,
    pub expel_after_ms: u64,
    pub granted_ms: Millis,
    /// A part of a region played by several simulations (crates/server/src/directory/parts.rs).
    #[serde(default)]
    pub part: Option<crate::directory::Part>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ruina_link::Encoding;
    use ruina_world_api::gate::{ToConn, ToGate};
    use ruina_world_api::sim::ToSim;
    use ruina_world_api::{Address, Conn, Epoch, GateId, Message, SimId, SpaceId};

    #[test]
    fn what_the_links_carry_crosses_whole() {
        let conn = Conn { gate: GateId(2), character: 7, session: 9 };
        let post =
            Wire::Post(Envelope { to: Address::Gate(GateId(2)), msg: Message::Gate(ToGate::Conn { conn, msg: ToConn::Rejoin { text: "Moved.".into() } }) });
        let back = Encoding::MessagePack.round_trip(&post).unwrap();
        assert!(
            matches!(&back, Wire::Post(Envelope { to: Address::Gate(GateId(2)), msg: Message::Gate(ToGate::Conn { conn: c, msg: ToConn::Rejoin { text } }) }) if *c == conn && text == "Moved.")
        );
        let lease = Lease { space: SpaceId::copy("yard", 4), sim: SimId(11), epoch: Epoch(3), until: 99, chunks: vec![(0, -1)] };
        let spawn = Wire::Spawn(Spawn { lease: lease.clone(), owner: Some(Owner::Solo(7)), expel_after_ms: 60_000, granted_ms: 12_345, part: None });
        match Encoding::MessagePack.round_trip(&spawn).unwrap() {
            Wire::Spawn(s) => assert_eq!((s.lease, s.owner, s.expel_after_ms, s.granted_ms), (lease, Some(Owner::Solo(7)), 60_000, 12_345)),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_envelope_goes_in_and_comes_back_out_and_nothing_else_does() {
        let e = Envelope { to: Address::Sim(SimId(3)), msg: Message::Sim(ToSim::Stop) };
        assert!(matches!(Wire::wrap(e).unwrap(), Ok(Envelope { to: Address::Sim(SimId(3)), msg: Message::Sim(ToSim::Stop) })));
        assert!(matches!(Wire::Status.unwrap(), Err(Wire::Status)));
    }
}
