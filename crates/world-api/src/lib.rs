//! The messages between the server's tiers, and the ids, ticks and epochs they carry. Types and
//! pure functions only: nothing here reads a clock, starts a thread or touches a socket or a disk.
//!
//! ```text
//! browser ─WebSocket─▶ gate ──inputs, what a player asks──▶ sim (a region's channel, an instance's copy)
//!                       ▲  ◀── a tick's records by cell, private state ──┘
//!   directory: who plays where, which sim plays which space, leases and epochs
//!   store: what lasts (lives, builds, residents), every write fenced by an epoch
//!   social: parties (later friends and guilds)
//! ```
//!
//! Every message is addressed ([`Address`]: a sim by its id, a gate by its id, a connection by its
//! gate, character and session) and is `Serialize + Deserialize`, so the server's tiers pass the
//! same values to each other in one process (tokio channels, `crates/server/src/post.rs`) as a
//! transport between processes carries ([`Envelope`], [`Transport`]). No tier reaches into another's
//! state: what one needs of another comes as a message.
//!
//! - [`ids`]: entities, characters, sessions, simulations, gates, parties, spaces, owners, epochs.
//! - [`input`]: what a browser's input bytes mean.
//! - [`records`]: what a simulation's tick produced, by 32 m cell and per player, for the gates.
//! - [`sim`], [`gate`], [`store`], [`social`], [`directory`]: each tier's messages in.
//! - [`post`]: addresses, envelopes and the transport they cross.

pub mod directory;
pub mod gate;
pub mod ids;
pub mod input;
pub mod post;
pub mod records;
pub mod sim;
pub mod social;
pub mod store;

pub use ids::{CharacterId, Conn, EntityId, EntityKind, Epoch, GateId, Millis, Owner, PartyId, SessionId, SimId, SpaceId, Tick};
pub use post::{Address, Envelope, Message, Transport};

/// Server ticks a second: the world's clock steps every simulation 20 times a second, three of the
/// rules' 60 Hz frames each.
pub const TICK_HZ: u32 = 20;
/// The rules' frames in one server tick.
pub const FRAMES_PER_TICK: u64 = (60 / TICK_HZ) as u64;
