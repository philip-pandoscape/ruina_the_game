//! Ruina's rules, the same ones the browser's TypeScript runs (src/sim/), so the server decides what
//! happens and the browser predicts it alike: movement and traversal (player, open), combat and
//! skills (player, skills, actors, missiles, tuning), creatures and their brains (actor, actors,
//! ai, pack, content, creatures), the island's life systems (life), the mini-games (minigames) and
//! the battlefield's layout (world). Nothing here reads a clock, starts a thread or does I/O: whoever
//! runs the rules hands in the time and the inputs, so the same inputs give the same results.

#![recursion_limit = "256"]

pub mod actor;
pub mod actors;
pub mod ai;
pub mod bots;
/// The checks' scenarios (the conformance tier's, and the engine's golden tests).
pub mod checks;
pub mod content;
pub mod creatures;
pub mod event;
pub mod jsmath;
pub mod life;
pub mod minigames;
pub mod missiles;
pub mod open;
pub mod pack;
pub mod player;
pub mod rng;
pub mod session;
pub mod skills;
pub mod training;
pub mod tuning;
pub mod world;
pub mod yard;
