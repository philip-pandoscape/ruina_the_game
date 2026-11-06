//! Ruina's game server. The rules are the engine's (crates/engine); the server keeps everyone's
//! accounts and islands, plays the world online and talks to the browsers:
//!
//! - `db`: Postgres, its pool and migrations.
//! - `http`: the one port: the account API, the game's files, the admins' pages, the WebSockets.
//! - `accounts`: accounts, sign-in and sessions, and the characters each account holds.
//! - `play`: Emberholm online: each channel's game, every party's copy of a dungeon, parties, the
//!   mini-game tables, and a player's connection.
//! - `combat`: players fighting, with lag compensation (the world's and the battlefield's).
//! - `protocol`: the battlefield's binary messages, which combat still writes.
//! - `battle`: the PvP battlefield's loop and networking, until it becomes a developer zone.

#![recursion_limit = "256"]

// The rules, reached from here as they always were (crate::player, crate::life...).
pub use ruina_engine::{actor, actors, ai, bots, content, creatures, jsmath, life, minigames, missiles, open, pack, player, rng, sim, skills, tuning, world};

pub mod accounts;
pub mod battle;
pub mod combat;
pub mod db;
pub mod http;
pub mod play;
pub mod protocol;
