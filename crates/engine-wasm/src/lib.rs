//! The engine for the browser: ruina-engine compiled to WebAssembly and called from JavaScript
//! (src/engine/wasm.ts) through plain functions on numbers, so no binding generator is needed and the
//! same calls work in the browser and in Node (the tests). The same functions build natively too,
//! so a test can hold the WebAssembly to the native results bit for bit (`probe` below).
//!
//! The first of the rules to come through here: Emberholm's ground and colliders, which the browser
//! asks about every frame (where to draw a shadow, where the camera may go). The rest follows them
//! (the refactor's Phase 8).

use std::sync::OnceLock;

use ruina_engine::open::OpenWorld;
use ruina_engine::open::colliders::ground_at;
use ruina_engine::open::zone::emberholm;

/// Emberholm with its colliders, made the first time anything asks.
fn island() -> &'static OpenWorld {
    static W: OnceLock<OpenWorld> = OnceLock::new();
    W.get_or_init(|| OpenWorld::new(emberholm()))
}

/// The terrain's height at (x, z).
#[unsafe(no_mangle)]
pub extern "C" fn ground_height(x: f64, z: f64) -> f64 {
    island().terrain().height(x, z)
}

/// Where someone at (x, y, z) stands: the terrain or the highest deck, roof or floor they can step
/// onto from `y`, at most `step_up` above it (crates/engine/src/open/colliders.rs ground_at).
#[unsafe(no_mangle)]
pub extern "C" fn ground_at_point(x: f64, z: f64, y: f64, step_up: f64) -> f64 {
    let w = island();
    ground_at(w.terrain(), &w.index, x, z, y, step_up)
}

/// The ground's surface at (x, z): grass, sand, rock and the rest (crates/engine/src/open/zone.rs).
#[unsafe(no_mangle)]
pub extern "C" fn surface_at(x: f64, z: f64) -> u32 {
    u32::from(island().terrain().surface_at(x, z))
}

/// A fingerprint of `n` ground queries at points drawn from `seed`: the terrain's height, where
/// someone stands two metres up, and the surface. The same number natively and in WebAssembly, or
/// the two disagree somewhere.
#[unsafe(no_mangle)]
pub extern "C" fn probe(n: u32, seed: u32) -> u64 {
    let mut rng = ruina_engine::rng::Rng::new(seed);
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |bits: u64| {
        for b in bits.to_le_bytes() {
            hash = (hash ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
        }
    };
    let r = island().radius;
    for _ in 0..n {
        let x = (rng.next_f64() * 2.0 - 1.0) * r;
        let z = (rng.next_f64() * 2.0 - 1.0) * r;
        let h = ground_height(x, z);
        mix(h.to_bits());
        mix(ground_at_point(x, z, h + 2.0, 1.2).to_bits());
        mix(u64::from(surface_at(x, z)));
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_island_answers() {
        // The spawn is on land, not under the sea.
        let s = &emberholm().recipe.spawn;
        assert!(ground_height(s.x, s.z) > 0.0);
        assert_eq!(probe(100, 1), probe(100, 1));
    }
}
