//! Runs behaviours through the Rust rules and prints every frame as JSON, so
//! tests/conformance/ai.test.ts can check the TypeScript version agrees. The scenarios and what they
//! print are the engine's (crates/engine/src/checks/ai.rs), which its golden tests hold to the
//! answers this check proved.
//!
//!   aicheck < scenario.json

use std::io::Read;

fn main() {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).expect("read the scenario from stdin");
    println!("{}", ruina_engine::checks::ai::run(&raw).expect("a scenario"));
}
