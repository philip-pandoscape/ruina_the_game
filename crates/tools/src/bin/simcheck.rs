//! Runs a scripted list of inputs through the Rust player rules and prints every frame as JSON,
//! so tests/conformance/player.test.ts can check the TypeScript version gives the same results. The
//! scripts and what they print are the engine's (crates/engine/src/checks/player.rs), which its
//! golden tests hold to the answers this check proved.
//!
//!   simcheck < script.json

use std::io::Read;

fn main() {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).expect("read script from stdin");
    println!("{}", ruina_engine::checks::player::run(&text).expect("valid script JSON"));
}
