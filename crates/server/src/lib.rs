//! Ruina's game server: accounts, characters and the open world kept in Postgres, the world's
//! channels and dungeon copies, and the PvP battlefield (its simulation, interest management, wire
//! protocol and networking). The rules themselves are the engine's (crates/engine).

#![recursion_limit = "256"]

// The rules, reached from here as they always were (crate::player, crate::life...).
pub use ruina_engine::{actor, actors, ai, content, creatures, jsmath, life, minigames, missiles, open, pack, player, rng, sim, skills, tuning, world};

pub mod accounts;
pub mod channels;
pub mod characters;
pub mod db;
pub mod game;
pub mod http;
pub mod interest;
pub mod net;
pub mod parties;
pub mod protocol;
pub mod spaces;
pub mod world_game;
pub mod world_socket;
