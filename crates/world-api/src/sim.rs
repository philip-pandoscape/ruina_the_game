//! A simulation's messages in. A simulation plays one space (a region's channel, or an instance's
//! copy) on a thread of its own, and owns everything in it: the players there and their lives, the
//! creatures, the bots, the mini-games' tables, the channel's residents. It takes its messages at
//! tick boundaries, and everything it says goes out as messages too: to the gates (a tick's records,
//! what a browser is told), the store (lives to write), the directory (where someone goes next, who
//! is in a copy).

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use ruina_engine::life::progress::sync_levels;
use ruina_engine::life::state::LifeState;
use ruina_engine::life::{Command, Life, Placement};
use ruina_engine::open::map::world_map;
use ruina_engine::player::{Build, Player};
use ruina_engine::world::Spawn;

use ruina_engine::border::messages::{Barrier, Post};

use crate::directory::{Destination, Grant};
use crate::ids::{CharacterId, Conn, EntityId, Epoch, Millis, Owner, PartyId, SimId, SpaceId};
use crate::input::Input;
use crate::store::Resident;

/// What a simulation is sent.
#[derive(Debug, Serialize, Deserialize)]
pub enum ToSim {
    /// A character comes in from a connection, once the directory has granted them here and the
    /// store has read their life. The simulation answers the connection: `ToConn::Arrived`.
    Arrive(Box<Arrival>),
    /// A connection ended: out they go (unless a newer connection has their seat), and their life
    /// is written.
    Depart { conn: Conn },
    /// What a player pressed, frame by frame, from their connection (a replaced window's are dropped).
    Inputs { conn: Conn, inputs: Vec<Input> },
    /// What a player asks of their game (the browser's text messages), from their connection, to
    /// answer it there.
    Ask { conn: Conn, ask: Ask },
    /// The directory's answer to `ToDirectory::Route`: where the character goes, granted there under
    /// a new epoch; the simulation hands them over (`Transfer`).
    Routed { character: CharacterId, to: Grant, why: Destination },
    /// Or why they can't go.
    Unrouted { character: CharacterId, text: String },
    /// A character handed over from another simulation, with their life (a portal, a way out, a
    /// developer zone, another channel; later a border).
    Transfer(Box<Moving>),
    /// The directory moves a character to another channel (their choice, their party, a merge),
    /// granted there: hand them over standing where they stand (`Transfer`), and what then.
    Hand { character: CharacterId, to: Grant, after: Vec<After> },
    /// A character this simulation handed over, sent back by one that couldn't take them (it's
    /// full), with why.
    Returned { moving: Box<Moving>, text: String },
    /// Parties changed (the social tier's, passed on by the directory): the party of each character
    /// here who changed, and this copy's new owner if it has one (a party formed and took its
    /// leader's copies, or broke up and left them to whoever was left). One message, so the two
    /// are never seen half done.
    Parties { changed: Vec<(CharacterId, Option<PartyId>)>, owner: Option<Owner> },
    /// A channel's residents and what they've built, as the store read them when it started.
    Residents(Vec<Resident>),
    /// A resident gone for good (their character was deleted): what they built comes down.
    ResidentGone { character: CharacterId },
    /// A connection arriving in a copy asks for its home channel's estates and plot claims.
    Estates { conn: Conn },
    /// The server is stopping: call the games off, and write everyone's life; answer `reply` once
    /// the store has.
    SaveAll { reply: crate::post::Reply },
    /// The directory's word on this simulation's lease.
    Lease(LeaseNote),
    /// What a neighbour playing another part of this simulation's region trades with it at a point
    /// of a tick (crates/engine/src/border): ghosts, blows and heals across, creatures' slams and
    /// blows, handoffs.
    Border(Box<Parcel>),
    /// Stop (a copy closed, or the server going).
    Stop,
}

/// One simulation's parcel for a neighbour of its region at one point of a tick (`at`): the posts
/// for it (none, often: it still goes, so the neighbour knows it has everything), and who the
/// players handed over in it are. The engine's border messages carry the rest
/// (`ruina_engine::border::messages`).
#[derive(Debug, Serialize, Deserialize)]
pub struct Parcel {
    pub from: SimId,
    /// The tick it belongs to (the world's), and where in it.
    pub tick: u64,
    pub at: Barrier,
    pub posts: Vec<Post>,
    /// The players handed over in it, by character: their connection and grant, which go with them.
    pub members: Vec<(CharacterId, Member)>,
    /// The names of the players its ghosts show (and whether each is a bot), by id: what the
    /// neighbour's players are shown of them.
    pub names: Vec<(EntityId, String, bool)>,
}

/// What a player asks of the game they're in.
#[derive(Debug, Serialize, Deserialize)]
pub enum Ask {
    /// A command for their life, given on input `seq` (the engine's `life::Command`).
    Command {
        seq: u32,
        command: Command,
    },
    /// A new build (skills and loadout), as the browser sends it.
    Build {
        build: Value,
    },
    /// Start their life over (an admin's).
    Reset,
    /// Mini-games: challenge someone here, take it back, answer one, move at your table, concede.
    Challenge {
        to: CharacterId,
        game: usize,
        stake: f64,
        seed: Option<u32>,
        turn: Option<f64>,
    },
    Withdraw,
    Answer {
        from: CharacterId,
        accept: bool,
    },
    Move {
        table: u64,
        m: Value,
    },
    Concede {
        table: u64,
    },
    /// Through a dungeon's portal (`enter`), or back out of it.
    Dungeon {
        id: String,
        enter: bool,
    },
    /// Into a developer zone (admins only), on a side.
    Zone {
        id: String,
        team: Option<u8>,
    },
    /// Their region's channels, as they see them (the directory answers).
    Channels,
    /// To another channel, or their party's (the directory decides).
    Channel {
        to: ruina_channels::Target,
    },
}

/// A character coming in from a connection.
#[derive(Debug, Serialize, Deserialize)]
pub struct Arrival {
    pub conn: Conn,
    pub name: String,
    /// An admin: the developer commands and zones are theirs.
    pub dev: bool,
    /// Their grant here: every write of their life carries it.
    pub epoch: Epoch,
    pub party: Option<PartyId>,
    /// Their home channel: where they come out of a copy.
    pub home: SpaceId,
    /// Their life as saved (`{state, player}`), None for a newcomer.
    pub life: Option<Value>,
    /// Their build as kept (by id), if they have one.
    pub build: Option<Value>,
    /// When it was saved, and the time now: the time they were away.
    pub saved_at: Option<Millis>,
    pub now: Millis,
}

/// Who a player is, as they travel between simulations with their connection.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Member {
    pub conn: Conn,
    pub name: String,
    pub dev: bool,
    pub epoch: Epoch,
    pub party: Option<PartyId>,
    pub home: SpaceId,
    /// Their saved life couldn't be read: nothing of this visit is written over it.
    pub keep_saved: bool,
}

/// A spot in a space, and which way you face there.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Spot {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub facing: f64,
}

/// Where someone handed over comes in.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum Entry {
    /// Where the space is entered (a copy's way in).
    Entrance,
    /// Standing here (on whatever is there to stand on).
    At(Spot),
}

/// What happens once someone handed over is in.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum After {
    /// Their life starts over (an admin's reset, asked for in a copy).
    Reset,
    /// Onto a side (a developer zone's).
    Side(Option<u8>),
    /// Something for them to read.
    Notice(String),
    /// They came from channel `from` (why): their browser hears it once it knows where it is.
    Channel { from: u32, why: ruina_channels::Why },
}

/// A character handed from one simulation to another: who they are, their player and life, where
/// they come in and what happens then, and where they came from (to be sent back if they can't be
/// taken).
#[derive(Debug, Serialize, Deserialize)]
pub struct Moving {
    pub character: CharacterId,
    pub member: Member,
    pub carried: Carried,
    pub entry: Entry,
    pub after: Vec<After>,
    pub from: SimId,
}

/// The directory's word on a simulation's lease.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum LeaseNote {
    /// Renewed until then.
    Renewed { epoch: Epoch, until: Millis },
    /// Lost: another holder has the space. One process alone carries on (and says so); a
    /// simulation among several stops before its lease runs out.
    Lost { epoch: Epoch },
}

/// A player and their life, carried from one simulation to another. In one process they move as
/// they are. Between processes they travel as their state: the player's ([`PlayerState`]), and the
/// life's (its state and what's going on: what's being placed, resting, whose plots are whose);
/// the skills' numbers are worked out again from the build and the life's experience. What a step
/// keeps for itself alone (its events, what the life has yet to say) doesn't travel.
///
/// [`PlayerState`]: crate::records::PlayerState
pub struct Carried {
    pub player: Player,
    pub life: Box<Life>,
}

impl std::fmt::Debug for Carried {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Carried {{ at ({:.1}, {:.1}, {:.1}) }}", self.player.pos.x, self.player.pos.y, self.player.pos.z)
    }
}

#[derive(Serialize, Deserialize)]
struct CarriedForm {
    player: crate::records::PlayerState,
    region: String,
    state: LifeState,
    placing: Option<Placement>,
    resting: bool,
    revision: u64,
    plot_owners: BTreeMap<String, String>,
    dungeon: Option<String>,
}

impl Serialize for Carried {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let l = &self.life;
        CarriedForm {
            player: crate::records::PlayerState::of(&self.player),
            region: l.zone.recipe.id.clone(),
            state: l.state.clone(),
            placing: l.placing.clone(),
            resting: l.resting,
            revision: l.revision,
            plot_owners: l.plot_owners.clone(),
            dungeon: l.dungeon.clone(),
        }
        .serialize(s)
    }
}

impl<'de> Deserialize<'de> for Carried {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Carried, D::Error> {
        let f = CarriedForm::deserialize(d)?;
        let map = world_map();
        let region = map.region(&f.region).ok_or_else(|| serde::de::Error::custom(format!("no region {:?} in this world", f.region)))?;
        let mut life = Box::new(Life::new(map.zone(region), None, None));
        life.state = f.state;
        life.placing = f.placing;
        life.resting = f.resting;
        life.revision = f.revision;
        life.plot_owners = f.plot_owners;
        life.dungeon = f.dungeon;
        let s = &f.player;
        let mut player = Player::new(Spawn { x: s.pos.x, z: s.pos.z, facing: s.facing }, s.team, Build::default());
        // The levels are the life's experience; the build's numbers are worked out with them.
        sync_levels(&life, &mut player);
        s.apply(&mut player);
        Ok(Carried { player, life })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::PlayerState;
    use ruina_engine::open::zone::emberholm;

    #[test]
    fn a_player_and_their_life_travel_whole_between_processes() {
        let zone = emberholm();
        let s = zone.recipe.spawn;
        let mut life = Box::new(Life::new(zone, None, None));
        life.state.coins = 1234.0;
        life.state.skill_xp.insert("sword".into(), 50.0);
        life.revision = 9;
        life.resting = true;
        let mut player = Player::new(Spawn { x: s.x + 3.0, z: s.z - 2.0, facing: 1.25 }, 1, Build::default());
        sync_levels(&life, &mut player);
        player.hp = 41.5;
        player.pos.y = 7.25;
        player.attack_frame = 6;
        let carried = Carried { player, life };
        let text = serde_json::to_string(&carried).unwrap();
        let back: Carried = serde_json::from_str(&text).unwrap();
        assert_eq!(PlayerState::of(&back.player), PlayerState::of(&carried.player));
        assert_eq!(back.player.levels, carried.player.levels, "the levels, from the life's experience");
        assert_eq!(back.life.state, carried.life.state);
        assert_eq!((back.life.revision, back.life.resting), (9, true));
        assert_eq!(back.life.zone.recipe.id, "emberholm");
        // And it says the same again.
        assert_eq!(serde_json::to_string(&back).unwrap(), text);
    }
}
