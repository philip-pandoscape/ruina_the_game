//! A gate's messages in. A gate holds players' connections: it signs them in, takes their
//! characters up through the directory, the store and the simulation they play in, and from then on
//! passes what they press and ask on to that simulation, and what the tiers say back to them. It
//! builds each client's update from a tick's records and encodes everything a browser hears (today
//! the JSON the browser has always read: `crates/server/src/gate/encode.rs`).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::{CharacterId, Conn, EntityId, Epoch, Millis, PartyId, SimId, SpaceId};
use crate::post::Answer;
use crate::records::TickOut;
use crate::social::{InviteView, PartyView};

/// What a gate is sent.
#[derive(Debug, Serialize, Deserialize)]
pub enum ToGate {
    /// For one connection.
    Conn { conn: Conn, msg: ToConn },
    /// What a simulation's tick produced, for every connection playing there.
    Tick(Arc<TickOut>),
    /// An answer to something the gate asked (`id` is its own).
    Answer { id: u64, answer: Answer },
}

/// What a connection is sent: answers on its way in, where its inputs go now, and everything its
/// browser is told.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ToConn {
    // ---- On the way in ----
    /// The directory took the character up for this connection: their grant, their home channel,
    /// and where they play (both simulations running).
    Claimed(Box<Claimed>),
    /// The store read their life (with their land beside it), and gave them a block of ids for what
    /// they place (`next`, `end`).
    Life { life: Option<Value>, build: Option<Value>, saved_at: Option<Millis>, ids: Option<(i64, i64)> },
    /// The simulation took them in: where they are, the build they play with, and (in a channel) its
    /// estates and plot claims.
    Arrived { space: SpaceView, build: Value, estates: Option<Estates> },
    /// Their home channel's estates and claims (for a connection arriving in a copy).
    Estates(Estates),
    /// They couldn't be taken up (the server is stopping, a simulation is gone): the connection ends.
    Turned { text: String },

    // ---- While playing ----
    /// They play in another simulation now: their inputs go there from here on. Their browser hears
    /// where it is (`space`), and everything it saw is somewhere else.
    Moved { sim: SimId, space: SpaceView },
    /// Another window took the character over: say so and hang up.
    Kicked,
    /// Their life was written (at that time).
    Saved { at: Millis },
    /// Their life was started over, and written.
    Reset,
    /// Something went wrong for them (said as is).
    Error { text: String },
    /// Something to read.
    Notice { text: String },
    /// Someone they could see left.
    Left { id: EntityId },
    /// A resident's estate, changed (houses, farms, ships on the slipway).
    Estate { id: CharacterId, name: String, estate: Value },
    /// Who holds which house plot: plot -> name.
    Claims { claims: Value },
    /// Their mini-game challenges: the one they sent and the one waiting for their answer.
    Challenges { sent: Value, waiting: Value },
    /// The game at their table as they may see it (None: they're up from the table).
    Table { table: Option<Value> },
    /// Their party as it is now (None: they're in none).
    Party { party: Option<PartyView> },
    /// An invitation waiting for their answer (None: there's none now).
    PartyInvite { invite: Option<InviteView> },
    /// Their region's channels as they see them (crates/channels).
    Channels(Box<ruina_channels::ChannelsView>),
    /// They were moved to another channel: from where, to where, and why.
    ChannelMoved { from: u32, to: u32, why: ruina_channels::Why },
}

/// The directory's grant of a character to a connection.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Claimed {
    /// Every write of their life carries it.
    pub epoch: Epoch,
    /// Their home channel (a channel of the region they live in), and the simulation playing it.
    pub home: SpaceId,
    pub home_sim: SimId,
    /// Where they come in: their home channel, or the copy they were in a moment ago.
    pub space: SpaceId,
    pub sim: SimId,
    /// Their home channel's number (what the welcome calls their channel).
    pub channel: u32,
    pub party: Option<PartyId>,
}

/// A channel's estates (everyone else's houses, farms and ships) and who holds which house plot.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Estates {
    pub estates: Value,
    pub claims: Value,
}

/// Where a player is, as a browser is told (src/net/worldLink.ts SpaceView).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SpaceView {
    /// A channel of the world.
    Channel { channel: u32 },
    /// A copy of a dungeon or a developer zone: which, its name, and the copy's number.
    Dungeon { dungeon: String, name: String, copy: u64 },
}

impl SpaceView {
    /// How a browser is told about a space (`name`: an instance's, for a copy).
    pub fn of(space: &SpaceId, name: &str) -> SpaceView {
        match space {
            SpaceId::Channel { n, .. } => SpaceView::Channel { channel: *n },
            SpaceId::Copy { instance, n } => SpaceView::Dungeon { dungeon: instance.clone(), name: name.to_string(), copy: *n },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_space_reads_as_the_browser_expects() {
        let c = SpaceView::of(&SpaceId::channel("emberholm", 2), "");
        assert_eq!(serde_json::to_value(&c).unwrap(), serde_json::json!({ "kind": "channel", "channel": 2 }));
        let d = SpaceView::of(&SpaceId::copy("goblinsDread", 7), "Goblin's Dread");
        assert_eq!(serde_json::to_value(&d).unwrap(), serde_json::json!({ "kind": "dungeon", "dungeon": "goblinsDread", "name": "Goblin's Dread", "copy": 7 }));
    }
}
