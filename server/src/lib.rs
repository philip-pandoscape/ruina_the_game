//! Ruina's game server (the crate keeps the working name yggdrasil-server): accounts, characters
//! and the open world kept in Postgres, and the PvP battlefield
//! (simulation, interest management, wire protocol and networking).

#![recursion_limit = "256"]

pub mod accounts;
pub mod actor;
pub mod actors;
pub mod ai;
pub mod channels;
pub mod characters;
pub mod content;
pub mod creatures;
pub mod db;
pub mod game;
pub mod http;
pub mod interest;
pub mod jsmath;
pub mod life;
pub mod minigames;
pub mod missiles;
pub mod net;
pub mod open;
pub mod pack;
pub mod parties;
pub mod player;
pub mod protocol;
pub mod sim;
pub mod skills;
pub mod spaces;
pub mod tuning;
pub mod world;
pub mod world_game;
pub mod world_socket;
