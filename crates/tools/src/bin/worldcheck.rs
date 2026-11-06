//! Runs a scripted list of inputs through the Rust open-world rules on Emberholm and prints every
//! frame as JSON, so tests/conformance/world.test.ts can check the TypeScript version (what the
//! browser predicts) gives the same results. The scripts and what they print are the engine's
//! (crates/engine/src/checks/world.rs), which its golden tests hold to the answers this check proved.
//!
//!   worldcheck < script.json

use std::io::Read;

fn main() {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).expect("read script from stdin");
    println!("{}", ruina_engine::checks::world::run(&text).expect("valid script JSON"));
}
