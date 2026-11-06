//! Every creature with a file of its own in shared/creatures/: its kinds, brains and attacks, all
//! data for the shared engine parts (design/goblins.md). The same files in the same order as
//! src/content/creatures.ts: a kind travels on the wire as its index, after those in
//! shared/actors.json, so a new creature goes on the end.

pub const FILES: &[&str] = &[include_str!("../../shared/creatures/goblin.json")];
