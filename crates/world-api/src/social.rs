//! The social tier's messages in. It keeps parties (later friends and guilds): who is in which,
//! who leads, the invitations waiting. It knows who is online and where from the directory, and
//! tells the directory (which keeps copies' owners) whenever someone's party changes. A party's
//! members hear it as it is whenever it, or where they are, changes.

use serde::{Deserialize, Serialize};

use crate::gate::SpaceView;
use crate::ids::{CharacterId, Conn, Millis, Owner, SessionId, SpaceId};

/// What the social tier is sent.
#[derive(Debug, Serialize, Deserialize)]
pub enum ToSocial {
    // ---- From a player's connection ----
    /// Invite someone playing: by id, or by name.
    Invite {
        conn: Conn,
        to: Option<CharacterId>,
        name: Option<String>,
    },
    /// Answer the invitation from `from`.
    Answer {
        conn: Conn,
        from: CharacterId,
        accept: bool,
    },
    Leave {
        conn: Conn,
    },
    /// The leader removes someone.
    Kick {
        conn: Conn,
        who: CharacterId,
    },
    /// The leader hands the lead on.
    Lead {
        conn: Conn,
        who: CharacterId,
    },

    // ---- From the directory ----
    /// Someone came online, through this connection, there.
    Online {
        conn: Conn,
        name: String,
        place: Place,
    },
    /// Their connection ended.
    Offline {
        character: CharacterId,
        session: SessionId,
    },
    /// They play somewhere else now.
    Placed {
        character: CharacterId,
        place: Place,
    },
    /// A copy someone owns, as it is now (made, entered, left, handed over).
    Copy {
        owner: Owner,
        copy: CopyNote,
    },
    /// A copy closed.
    CopyClosed {
        owner: Owner,
        space: SpaceId,
    },

    // ---- From the accounts ----
    /// A character is gone for good (deleted).
    Forget {
        character: CharacterId,
    },
}

/// Where someone plays, as their party sees it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Place {
    pub space: SpaceId,
    pub view: SpaceView,
}

/// A copy of an instance, as its owner's party sees it: which, how many are in it, and since when
/// nobody has been (it closes a while after).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CopyNote {
    pub space: SpaceId,
    pub instance: String,
    pub name: String,
    pub inside: usize,
    pub empty_since: Option<Millis>,
}

/// A party as its members see it (src/net/worldLink.ts PartyView).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PartyView {
    pub id: u64,
    pub leader: CharacterId,
    /// In the order they joined; `place` is where they play (None while offline).
    pub members: Vec<PartyMemberView>,
    /// The party's copies: how many are inside, and in how many seconds one closes if nobody is.
    pub dungeons: Vec<PartyCopyView>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PartyMemberView {
    pub id: CharacterId,
    pub name: String,
    pub online: bool,
    pub place: Option<SpaceView>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartyCopyView {
    pub id: String,
    pub name: String,
    pub inside: usize,
    pub closes_in: Option<u64>,
}

/// An invitation waiting for an answer: from whom, and how long it has left (ms).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InviteView {
    pub from: CharacterId,
    pub name: String,
    pub ms: u64,
}
