//! Ruina's game server. The rules are the engine's (crates/engine); the server keeps everyone's
//! accounts and islands, plays the world online and talks to the browsers:
//!
//! - `db`: Postgres, its pool and migrations.
//! - `http`: the one port: the account API, the game's files, the admins' pages, the WebSocket.
//! - `accounts`: accounts, sign-in and sessions, and the characters each account holds.
//! - `play`: Emberholm online: each channel's game, every party's copy of a dungeon, parties, the
//!   mini-game tables, and a player's connection.
//! - `combat`: combat on the wire (the rules are the engine's): what input bytes mean, and the
//!   arrows, meteors and effects a browser is sent.

#![recursion_limit = "256"]

// The rules, reached from here as they always were (crate::player, crate::life...).
pub use ruina_engine::{actor, actors, ai, bots, content, creatures, jsmath, life, minigames, missiles, open, pack, player, rng, skills, tuning, world};

pub mod accounts;
pub mod combat;
pub mod db;
pub mod http;
pub mod play;
