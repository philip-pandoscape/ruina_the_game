//! Ids for things in the world, the same everywhere: a kind and a number in one 64-bit word
//! (`.plans/world/research.md`, 3.5). Inside the engine and the server a player, a bot or a creature
//! is known by its `EntityId`; what a browser is sent names them its own way (the server's gate).
//!
//! - A character keeps its database id.
//! - A bot is numbered by the simulation it plays in and its count there.
//! - A creature is numbered by spawn and generation (crate::actors): the n-th the space brought to
//!   life (its spawn list first, in order), and how many times those numbers have come round.
//! - Placed things (houses, fields, ships) will take theirs from a database sequence.

use serde::{Deserialize, Serialize};

/// What sort of thing an id names: the top 8 bits of an [`EntityId`].
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
#[repr(u8)]
pub enum EntityKind {
    /// A player's character, by its database id.
    Character = 1,
    /// A bot: a player without a socket, its inputs decided by a brain (crate::bots).
    Bot = 2,
    /// A creature (crate::actors).
    Creature = 3,
    /// Something built, planted or left in the world (land, to come).
    Placed = 4,
}

/// A thing in the world: its kind in the top 8 bits, its number in the 56 below.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EntityId(u64);

const KIND_SHIFT: u32 = 56;
const NUMBER: u64 = (1 << KIND_SHIFT) - 1;

impl EntityId {
    fn of(kind: EntityKind, number: u64) -> EntityId {
        EntityId((kind as u64) << KIND_SHIFT | (number & NUMBER))
    }

    /// A character, by its database id.
    pub fn character(id: i64) -> EntityId {
        EntityId::of(EntityKind::Character, id as u64)
    }

    /// A bot: the `n`-th to join the simulation `sim` (each counts its own).
    pub fn bot(sim: u64, n: u32) -> EntityId {
        EntityId::of(EntityKind::Bot, (sim & 0xff_ffff) << 32 | u64::from(n))
    }

    /// A creature, by its number in its space (crate::actors: its spawn in the low 16 bits, its
    /// generation above).
    pub fn creature(number: u32) -> EntityId {
        EntityId::of(EntityKind::Creature, u64::from(number))
    }

    /// The whole word, as it travels.
    pub fn raw(self) -> u64 {
        self.0
    }

    /// An id from its whole word. None if its kind isn't one.
    pub fn from_raw(raw: u64) -> Option<EntityId> {
        let id = EntityId(raw);
        id.kind().map(|_| id)
    }

    pub fn kind(self) -> Option<EntityKind> {
        match self.0 >> KIND_SHIFT {
            1 => Some(EntityKind::Character),
            2 => Some(EntityKind::Bot),
            3 => Some(EntityKind::Creature),
            4 => Some(EntityKind::Placed),
            _ => None,
        }
    }

    /// Its number within its kind.
    pub fn number(self) -> u64 {
        self.0 & NUMBER
    }

    /// The character it is, if it's one.
    pub fn as_character(self) -> Option<i64> {
        (self.kind() == Some(EntityKind::Character)).then_some(self.number() as i64)
    }

    /// The simulation and count of a bot, if it's one.
    pub fn as_bot(self) -> Option<(u64, u32)> {
        (self.kind() == Some(EntityKind::Bot)).then_some((self.number() >> 32, self.number() as u32))
    }

    /// A creature's number, if it's one.
    pub fn as_creature(self) -> Option<u32> {
        (self.kind() == Some(EntityKind::Creature)).then_some(self.number() as u32)
    }
}

impl std::fmt::Display for EntityId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.kind() {
            Some(EntityKind::Character) => write!(f, "character {}", self.number()),
            Some(EntityKind::Bot) => write!(f, "bot {} of sim {}", self.number() as u32, self.number() >> 32),
            Some(EntityKind::Creature) => write!(f, "creature {}", self.number()),
            Some(EntityKind::Placed) => write!(f, "placed {}", self.number()),
            None => write!(f, "entity {:#x}", self.0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_keeps_its_kind_and_number() {
        let c = EntityId::character(123_456);
        assert_eq!((c.kind(), c.as_character()), (Some(EntityKind::Character), Some(123_456)));
        assert_eq!(c.as_bot(), None);
        let b = EntityId::bot(7, 42);
        assert_eq!((b.kind(), b.as_bot()), (Some(EntityKind::Bot), Some((7, 42))));
        let k = EntityId::creature(3 << 16 | 17);
        assert_eq!(k.as_creature(), Some(3 << 16 | 17));
        // Different kinds with the same number are different things.
        assert_ne!(EntityId::character(5), EntityId::creature(5));
        assert_eq!(EntityId::from_raw(c.raw()), Some(c));
        assert_eq!(EntityId::from_raw(42), None);
        assert_eq!(serde_json::to_string(&c).unwrap(), c.raw().to_string());
    }
}
