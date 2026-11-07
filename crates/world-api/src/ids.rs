//! Who and where: the ids every tier's messages carry.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub use ruina_engine::ids::{EntityId, EntityKind};

/// A character, by its database id (`characters.id`).
pub type CharacterId = i64;
/// One browser window's connection to a character: a random number the gate draws for it.
pub type SessionId = i64;
/// The world's clock: server ticks since the world's epoch (2026-01-01 UTC), [`crate::TICK_HZ`] a
/// second, the same moment in every simulation.
pub type Tick = u64;
/// A wall-clock time, in milliseconds since 1970 (UTC). Times that cross between tiers are these,
/// never an `Instant`, which means nothing in another process.
pub type Millis = i64;

/// A simulation: one thread playing one space (a region's channel, or an instance's copy). Its id
/// is unique across every process on a database (the directory draws it from a sequence).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SimId(pub u64);

/// A gate: the tier that holds players' connections.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct GateId(pub u32);

/// A party (the social tier's).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PartyId(pub u64);

/// A grant's number. The directory bumps it every time it grants something: a space to a
/// simulation (a lease), a character to a connection and the simulation playing them. Every write
/// carries the epoch it was granted under, and the store refuses one older than the latest
/// (Kleppmann's fencing tokens; `characters.live_session` was the first of them).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Epoch(pub u64);

impl Epoch {
    pub fn next(self) -> Epoch {
        Epoch(self.0 + 1)
    }
}

/// A connection: the gate holding it, the character it plays and its session. Messages for a
/// browser are addressed to one.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Serialize, Deserialize)]
pub struct Conn {
    pub gate: GateId,
    pub character: CharacterId,
    pub session: SessionId,
}

/// Where a position is: a region's channel (the world, played as copies for crowds), or a copy of
/// an instance (a dungeon or a developer zone, a space of its own). Written as a key everywhere it
/// goes (the database, logs, messages): `channel:<region>:<n>`, `copy:<instance>:<n>`.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum SpaceId {
    /// Channel `n` of a region (the world there).
    Channel { region: String, n: u32 },
    /// Copy `n` of an instance (numbers are unique across every instance, and every process on a
    /// database).
    Copy { instance: String, n: u64 },
}

impl SpaceId {
    pub fn channel(region: &str, n: u32) -> SpaceId {
        SpaceId::Channel { region: region.to_string(), n }
    }

    pub fn copy(instance: &str, n: u64) -> SpaceId {
        SpaceId::Copy { instance: instance.to_string(), n }
    }

    pub fn is_copy(&self) -> bool {
        matches!(self, SpaceId::Copy { .. })
    }

    /// The instance a copy is of.
    pub fn instance(&self) -> Option<&str> {
        match self {
            SpaceId::Copy { instance, .. } => Some(instance),
            SpaceId::Channel { .. } => None,
        }
    }

    /// The region a channel is of.
    pub fn region(&self) -> Option<&str> {
        match self {
            SpaceId::Channel { region, .. } => Some(region),
            SpaceId::Copy { .. } => None,
        }
    }
}

impl fmt::Display for SpaceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SpaceId::Channel { region, n } => write!(f, "channel:{region}:{n}"),
            SpaceId::Copy { instance, n } => write!(f, "copy:{instance}:{n}"),
        }
    }
}

impl FromStr for SpaceId {
    type Err = String;

    fn from_str(s: &str) -> Result<SpaceId, String> {
        let bad = || format!("not a space: {s:?}");
        let mut parts = s.splitn(3, ':');
        let (kind, name, n) = (parts.next().ok_or_else(bad)?, parts.next().ok_or_else(bad)?, parts.next().ok_or_else(bad)?);
        if name.is_empty() {
            return Err(bad());
        }
        match kind {
            "channel" => Ok(SpaceId::channel(name, n.parse().map_err(|_| bad())?)),
            "copy" => Ok(SpaceId::copy(name, n.parse().map_err(|_| bad())?)),
            _ => Err(bad()),
        }
    }
}

impl Serialize for SpaceId {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for SpaceId {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<SpaceId, D::Error> {
        String::deserialize(d)?.parse().map_err(serde::de::Error::custom)
    }
}

/// Whose copy of an instance it is: a party's, someone's on their own, or everyone's allowed in (a
/// developer zone everyone shares, the battlefield).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Owner {
    Party(PartyId),
    Solo(CharacterId),
    Everyone,
}

impl Owner {
    /// Whose a copy made for `character` is: their party's, or theirs on their own.
    pub fn of(character: CharacterId, party: Option<PartyId>) -> Owner {
        match party {
            Some(p) => Owner::Party(p),
            None => Owner::Solo(character),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_space_is_written_and_read_as_its_key() {
        for s in [SpaceId::channel("emberholm", 3), SpaceId::copy("goblinsDread", 12)] {
            let key = s.to_string();
            assert_eq!(key.parse::<SpaceId>(), Ok(s.clone()));
            assert_eq!(serde_json::to_string(&s).unwrap(), format!("\"{key}\""));
            assert_eq!(serde_json::from_str::<SpaceId>(&format!("\"{key}\"")).unwrap(), s);
        }
        assert_eq!(SpaceId::channel("emberholm", 1).to_string(), "channel:emberholm:1");
        for bad in ["", "channel", "channel:emberholm", "channel::1", "room:x:1", "channel:emberholm:-1", "copy:yard:x"] {
            assert!(bad.parse::<SpaceId>().is_err(), "{bad}");
        }
    }

    #[test]
    fn a_copy_belongs_to_a_party_or_to_someone_alone() {
        assert_eq!(Owner::of(7, Some(PartyId(2))), Owner::Party(PartyId(2)));
        assert_eq!(Owner::of(7, None), Owner::Solo(7));
        assert_eq!(Epoch(4).next(), Epoch(5));
    }
}
