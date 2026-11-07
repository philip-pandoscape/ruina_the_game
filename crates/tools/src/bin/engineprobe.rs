//! The engine's fingerprint for the browser's engine to match (tests/conformance/engine.test.ts):
//! the same queries the WebAssembly answers, answered natively.
//!
//!   engineprobe <n> <seed>...   prints each seed's fingerprint of n ground queries
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let n: u32 = args.first().and_then(|a| a.parse().ok()).expect("engineprobe <n> <seed>...");
    for seed in &args[1..] {
        let seed: u32 = seed.parse().expect("a seed is a number");
        println!("{}", ruina_engine_wasm::probe(n, seed));
    }
}
