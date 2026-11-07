//! The store's messages in. The store keeps what lasts (in Postgres): characters' lives and builds;
//! land, a row a piece by where it stands; the house plots' claims; the ledger; the world's market.
//! Every write about a character carries the epoch the directory granted them under, and is refused
//! if a newer grant has been made since (another window took them over; another simulation plays
//! them now). Writes that belong together (a pot paid out to one of two players, a life and the land
//! lent to it) go in one transaction.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::{CharacterId, Conn, Epoch, SimId, SpaceId};
use crate::post::Reply;

/// What the store is sent.
#[derive(Debug, Serialize, Deserialize)]
pub enum ToStore {
    /// A character's life, build and when it was saved, for the connection taking them up
    /// (answered with `ToConn::Life`): the life with their land beside it (`{state, land, player}`:
    /// the land is lent to it while they play), and a block of ids for what they place.
    LoadLife { character: CharacterId, reply: Conn },
    /// A region's land: everyone's, by owner, the plots' claims and the world's market (answered with
    /// `ToSim::Land`).
    LoadLand { region: String, reply: SimId },
    /// Lives to write: one alone, or several in one transaction (each kept or none), each fenced by
    /// its epoch, each with the land lent to it (beside its state, as rows) and what it kept for the
    /// ledger; the writer hears what the ledger has now (`ToSim::Recorded`). Then what to say, and to
    /// whom.
    WriteLives { writes: Vec<LifeWrite>, then: Then },
    /// A house plot claimed with the house just put on it (its row and the claim together, first come
    /// in the whole world): answered with `ToSim::Claim`.
    ClaimPlot { character: CharacterId, epoch: Epoch, plot: String, house: Value, reply: SimId },
    /// Houses taken down by a region's keeper, their tax unpaid too long at `at` (the world's clock),
    /// and their plots let go. Each is taken down only if it still is, as the store has it (an owner
    /// who paid meanwhile keeps theirs). `writer`: the keeper and its lease.
    TakeDown { houses: Vec<i64>, at: f64, writer: Writer },
    /// A pack sold at a trading post, lowering the world's demand there (`at` on the world's clock).
    Sold { outpost: String, pack: String, at: f64 },
    /// The world's market as it stands (answered with `ToSim::Market`).
    LoadMarket { reply: SimId },
    /// A block of ids for what a character places (answered with `ToSim::Ids`).
    ReserveIds { character: CharacterId, reply: SimId },
    /// A character's land given back by the simulation it was lent to, after their life's last write
    /// there (they left the world), under the grant they played under: it's the store's to keep
    /// again (a newer lend, a newer window's, stays).
    ReturnLand { character: CharacterId, epoch: Epoch },
    /// Someone (`by`, under their grant) acting on a piece of `owner`'s land (a pack on the ground, a
    /// vehicle left out) while `owner` isn't playing: the store gives it to the first who asks, and
    /// only while `owner`'s land isn't lent to their life (answered with `ToSim::Taken`).
    TakePiece { piece: i64, owner: CharacterId, by: CharacterId, epoch: Epoch, reply: SimId },
    /// A transfer between characters (a mini-game's pot) and the lives it changes, in one
    /// transaction, once: sent again with its key, nothing is written again.
    Transfer { transfer: Transfer, writes: Vec<LifeWrite> },
    /// A character's build, kept by id (fenced).
    WriteBuild { character: CharacterId, epoch: Epoch, build: Value },
}

/// A life to write: whose, under which grant, the life as saved (`{state, land, player}`: the store
/// keeps the land in rows beside it), and the space its position is in.
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

/// A region's land as the store keeps it: everyone's who has any there, by owner (with their name),
/// who holds each house plot, and the world's market.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RegionLand {
    /// (owner, their name, their land as the engine keeps it).
    pub holdings: Vec<(CharacterId, String, Value)>,
    /// (plot, its holder, their name).
    pub claims: Vec<(String, CharacterId, String)>,
    pub market: Value,
}

/// What became of a plot's claim.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClaimResult {
    /// The plot is theirs.
    Yours,
    /// Someone else claimed it first.
    Theirs { holder: CharacterId, name: String },
    /// Their grant moved on before it was written: nothing was.
    Stale,
}

/// What became of taking a piece of someone's land.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum TakeResult {
    /// It's theirs now: the rows taken (a vehicle comes with what's in its bed), as (kind, piece).
    Yours(Vec<(String, Value)>),
    /// Its owner is playing: their land is lent to their life, which alone changes it.
    Lent,
    /// It isn't theirs any more (someone took it first, or they moved it), or it's nothing that can
    /// be taken (only a pack on the ground or a vehicle can).
    Gone,
    /// The taker's grant moved on before it was written: nothing was.
    Stale,
}

/// A transfer between characters: which one it is (`key`, the same however often it's sent), what
/// kind, each one's side (what they gained, negative for what they gave, and from whom), and what
/// it was for.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Transfer {
    pub key: String,
    pub kind: String,
    /// (character, the other party, coins gained).
    pub sides: Vec<(CharacterId, String, f64)>,
    pub detail: Value,
}

/// Why a write was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Refused {
    /// A newer grant was made since (another window, another simulation): the write is stale.
    Stale,
    /// No such character (deleted).
    Gone,
}
