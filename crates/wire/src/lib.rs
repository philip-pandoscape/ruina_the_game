//! What a browser hears of the world, and how: the protocol for crowds (R10.8). A sim packs each
//! entity's record once a tick into the 32 m cell it stands in (record, pack); the gate keeps a
//! Viewer for each connection and writes its update from the cells around its player, nearest and
//! most overdue first, as deltas against what the browser acknowledged, within a byte budget
//! (viewer, interest); the browser applies updates in order and acknowledges each (heard, ack;
//! src/net/wire is its own copy). No I/O, clocks or threads: the gate sends the bytes.
//!
//! The protocol byte by byte, and why it is as it is: crates/wire/AGENTS.md.
//!
//! - **schema**: what each kind of record holds, field by field.
//! - **record**: a record, an introduction, an effect, and a sim's Frame of them by cell.
//! - **pack**: the engine's players, creatures, vehicles, packs, arrows, meteors and effects as records
//!   (the default `engine` feature: the sims need it, a gate doesn't).
//! - **interest**: tiers by distance, their rates and caps.
//! - **viewer**: a connection's handles, baselines, updates in flight, priorities and budget, and
//!   the update it's sent each tick.
//! - **ack**: what the browser sends back.
//! - **decode**, **heard**: reading updates and applying them, as the browser does.

pub mod ack;
pub mod bytes;
pub mod decode;
pub mod heard;
pub mod interest;
#[cfg(feature = "engine")]
pub mod pack;
pub mod record;
pub mod schema;
pub mod viewer;

pub use ack::Ack;
pub use record::{Cell, CellRecords, Event, Frame, Intro, Record};
pub use schema::{Fields, Kind, Tier};
pub use viewer::{View, Viewer};
