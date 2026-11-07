//! Ruina's game server. The rules are the engine's (crates/engine); the server keeps everyone's
//! accounts and lives, plays the world online and talks to the browsers. It is built in tiers that
//! only send each other messages (crates/world-api), all in one process today:
//!
//! - `gate`: players' connections: sign-in, the welcome, inputs and commands in, updates out.
//! - `sim`: the simulations, one for each region's channel and each instance's copy, each on a
//!   thread of its own: the rules stepped, mini-games, bots, players handed between them.
//! - `store`: what lasts, in Postgres (lives, builds, residents), every write fenced by its epoch.
//! - `social`: parties.
//! - `directory`: who plays where, which simulation plays which space, leases and epochs.
//! - `post`: how their messages reach each other in one process; `start`: starting them all.
//! - `accounts`: accounts, sign-in and sessions, and the characters each account holds.
//! - `http`: the one port: the account API, the game's files, the admins' pages, the WebSocket.

#![recursion_limit = "256"]

// The rules, reached from here as they always were (crate::player, crate::life...).
pub use ruina_engine::{
    actor, actors, ai, bots, combat, content, creatures, ids, jsmath, life, minigames, missiles, open, pack, player, rng, skills, tuning, world,
};

pub mod accounts;
pub mod directory;
pub mod gate;
pub mod http;
pub mod post;
pub mod sim;
pub mod social;
pub mod start;
pub mod store;
