//! The store's messages in. The store keeps what lasts (in Postgres): characters' lives and builds,
//! and what a channel's residents have built (until land has tables of its own). Every write about a
//! character carries the epoch the directory granted them under, and is refused if a newer grant has
//! been made since (another window took them over; another simulation plays them now). Writes that
//! belong together (a pot paid out to one of two players) go in one transaction.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::{CharacterId, Conn, Epoch, SimId, SpaceId};
use crate::post::Reply;

/// What the store is sent.
#[derive(Debug, Serialize, Deserialize)]
pub enum ToStore {
    /// A character's life, build and when it was saved, for the connection taking them up
    /// (answered with `ToConn::Life`).
    LoadLife { character: CharacterId, reply: Conn },
    /// The residents of a channel and what they've built (answered with `ToSim::Residents`).
    LoadResidents { channel: u32, reply: SimId },
    /// Lives to write: one alone, or several in one transaction (each kept or none), each fenced by
    /// its epoch. Then what to say, and to whom.
    WriteLives { writes: Vec<LifeWrite>, then: Then },
    /// A character's build, kept by id (fenced).
    WriteBuild { character: CharacterId, epoch: Epoch, build: Value },
}

/// A life to write: whose, under which grant, the life as saved (`{state, player}`), and the space
/// its position is in.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LifeWrite {
    pub character: CharacterId,
    pub epoch: Epoch,
    pub life: Value,
    pub space: SpaceId,
    /// The simulation writing it and its lease (on its own space, a copy's for a life saved in one):
    /// once several processes share the world, the store checks that lease too, so a simulation
    /// that lost its space can't write even for a character nobody granted elsewhere.
    pub writer: Option<Writer>,
    /// Tell this connection once it's written (`ToConn::Saved`).
    pub tell: Option<Conn>,
}

/// Who writes: a simulation, the space it plays and the epoch of its lease there.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Writer {
    pub sim: SimId,
    pub space: SpaceId,
    pub epoch: Epoch,
}

/// What follows a write.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Then {
    Nothing,
    /// The life was started over: tell its connection (`ToConn::Reset`) once it's written.
    Reset(Conn),
    /// Answer how many were written (`Answer::Written`), written or not.
    Answer(Reply),
}

/// A channel's resident: who, their name, and their life's state (what they've built is in it).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Resident {
    pub character: CharacterId,
    pub name: String,
    pub state: Value,
}

/// Why a write was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Refused {
    /// A newer grant was made since (another window, another simulation): the write is stale.
    Stale,
    /// No such character (deleted).
    Gone,
}
