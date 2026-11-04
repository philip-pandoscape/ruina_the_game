//! Yggdrasil game server: accounts and the open world kept in Postgres, and the PvP battlefield
//! (simulation, interest management, wire protocol and networking).

pub mod accounts;
pub mod actor;
pub mod ai;
pub mod actors;
pub mod channels;
pub mod content;
pub mod db;
pub mod game;
pub mod http;
pub mod interest;
pub mod net;
pub mod player;
pub mod protocol;
pub mod skills;
pub mod sim;
pub mod terrain;
pub mod tuning;
pub mod world;
pub mod world_socket;
