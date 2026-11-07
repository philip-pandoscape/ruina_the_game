//! The directory's messages in. The directory is the source of truth for routing: which simulation
//! plays each space (under a lease with an epoch, kept in a table), and where each character is
//! (granted to a connection and a simulation under an epoch of their own, which every write about
//! them carries). It starts simulations as spaces are needed (a character's home channel, a party's
//! copy of a dungeon), closes copies long empty, and keeps the copies' owners as parties form and
//! break up.

use ruina_channels::{Standing, Target};
use serde::{Deserialize, Serialize};

use crate::ids::{CharacterId, Conn, Epoch, Millis, Owner, PartyId, SimId, SpaceId};
use crate::post::{Answer, Reply};

/// What the directory is sent.
#[derive(Debug, Serialize, Deserialize)]
pub enum ToDirectory {
    /// A connection takes a character up (signed in, and the character theirs): grant them to it
    /// under a new epoch, put out whoever had them, and say where they play (`ToConn::Claimed`).
    Claim { conn: Conn, name: String },
    /// A connection let go (it ended).
    Release { conn: Conn },
    /// A simulation asks where a character goes next (`ToSim::Routed` or `ToSim::Unrouted`).
    Route { character: CharacterId, from: SimId, to: Destination },
    /// A simulation took a character in (from a connection or another simulation).
    Placed { character: CharacterId, space: SpaceId, sim: SimId },
    /// A copy's occupancy changed: how many are in it, and since when nobody has been.
    Occupancy { space: SpaceId, inside: usize, empty_since: Option<Millis> },
    /// The social tier: parties changed. The party of each character who changed, and copies that
    /// were one owner's and are another's now (a party formed and took its leader's copies, or
    /// broke up and left them to whoever was left). The directory passes each simulation its part
    /// in one message (`ToSim::Parties`).
    /// `leaders`: who leads each party in `changed` (someone who joins a party in another channel
    /// goes to its leader's).
    Parties {
        changed: Vec<(CharacterId, Option<PartyId>)>,
        hand: Vec<(Owner, Owner)>,
        #[serde(default)]
        leaders: Vec<(PartyId, CharacterId)>,
    },
    /// Whether a character is being played (answered with `Answer::Playing`).
    IsPlaying { character: CharacterId, reply: Reply },
    /// A character is gone for good (deleted): forget them, and the channels take down what they
    /// built.
    Forget { character: CharacterId },
    /// A player asks for their region's channels as they see them, through the simulation they play
    /// in, which says what they're doing (answered with `ToConn::Channels`).
    Channels { conn: Conn, standing: Standing },
    /// A player asks to go to another channel, or their party's, through the simulation they play in
    /// (`from`), which says what they're doing and whether they're an admin (who may open a channel
    /// by going to it). Moved (`ToSim::Hand`), or told why not.
    Change { conn: Conn, from: SimId, to: Target, standing: Standing, dev: bool },
    /// A channel's simulation, once a second: what its players who aren't free to go anywhere are
    /// doing (a pack, a fight, a vehicle, the air, a table). The rest are free.
    Standings { sim: SimId, standings: Vec<(CharacterId, Standing)> },
    /// The server is stopping: every simulation writes everyone's life; answer once all are written
    /// (`Answer::Written`).
    SaveAll { reply: Reply },
    /// An answer to something the directory asked.
    Answer { id: u64, answer: Answer },
}

/// Where a simulation asks to send a character.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Destination {
    /// Into the copy of an instance that's theirs (their party's, theirs alone, or everyone's for a
    /// shared developer zone), made now if there isn't one. `zone`: a developer zone, from the
    /// Admin menu, rather than a dungeon through its portal.
    Copy { instance: String, zone: bool },
    /// Out to their home channel.
    Home,
}

/// A grant: a space, the simulation playing it, and the epoch it was granted under.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Grant {
    pub space: SpaceId,
    pub sim: SimId,
    pub epoch: Epoch,
}

/// A simulation's lease on its space: what it plays, under which epoch, until when (renewed by the
/// directory while it runs), and the 256 m chunks it owns (a region's channel owns the region's; a
/// copy, none of the world's).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Lease {
    pub space: SpaceId,
    pub sim: SimId,
    pub epoch: Epoch,
    pub until: Millis,
    pub chunks: Vec<(i32, i32)>,
}
