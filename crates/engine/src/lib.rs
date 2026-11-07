//! Ruina's rules, one copy: the server runs them natively to decide what happens, and the browser
//! runs them compiled to WebAssembly (crates/engine-wasm) to predict it and to play offline (the
//! browser's game is session): movement and traversal (player, open), combat and
//! skills (player, combat, skills, actors, missiles, tuning), creatures and their brains (actor, actors,
//! ai, pack, content, creatures), the island's life systems (life), the mini-games (minigames) and
//! the battlefield's layout (world), and a world split between simulations (border). Nothing here reads a clock, starts a thread or does I/O: whoever
//! runs the rules hands in the time and the inputs, so the same inputs give the same results.

#![recursion_limit = "256"]

pub mod actor;
pub mod actors;
pub mod ai;
pub mod border;
pub mod bots;
pub mod bundles;
/// Scenarios run through the rules, whose answers the golden tests hold.
pub mod checks;
pub mod combat;
pub mod content;
pub mod creatures;
pub mod event;
pub mod ids;
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
