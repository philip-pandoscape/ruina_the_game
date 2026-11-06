//! The noise an island grows from (src/sim/terrain.ts): integer hashing rather than a random
//! stream, so the same seed grows the same island in any language, and smooth value noise summed
//! over octaves. Plain arithmetic in the TypeScript's order, so both give the same bits.

use crate::jsmath::{js_max, js_min};

/// JavaScript's ToInt32 (`x | 0`): the integer part, wrapped to 32 bits; 0 for NaN and the infinities.
pub fn to_int32(x: f64) -> i32 {
    if x.abs() < 2_147_483_648.0 {
        // Truncates toward zero, as ToInt32 does.
        return x as i32;
    }
    if !x.is_finite() {
        return 0;
    }
    x.trunc().rem_euclid(4_294_967_296.0) as u32 as i32
}

/// A grid point's hash in [0, 1).
pub fn hash2(ix: i32, iz: i32, seed: i32) -> f64 {
    let mut h = (ix as u32).wrapping_mul(0x27d4_eb2d) ^ (iz as u32).wrapping_mul(0x1656_67b1) ^ (seed as u32).wrapping_mul(0x9e37_79b1);
    h = (h ^ (h >> 15)).wrapping_mul(0x85eb_ca6b);
    h = (h ^ (h >> 13)).wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    f64::from(h) / 4_294_967_296.0
}

/// Smooth value noise in 0..1.
pub fn value_noise(x: f64, z: f64, seed: i32) -> f64 {
    let ix = x.floor();
    let iz = z.floor();
    let fx = x - ix;
    let fz = z - iz;
    let ux = fx * fx * (3.0 - 2.0 * fx);
    let uz = fz * fz * (3.0 - 2.0 * fz);
    let (i0, i1, j0, j1) = (to_int32(ix), to_int32(ix + 1.0), to_int32(iz), to_int32(iz + 1.0));
    let a = hash2(i0, j0, seed);
    let b = hash2(i1, j0, seed);
    let c = hash2(i0, j1, seed);
    let d = hash2(i1, j1, seed);
    a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz
}

/// Fractal noise in roughly -1..1.
pub fn fbm(x: f64, z: f64, octaves: u32, seed: i32) -> f64 {
    let mut sum = 0.0;
    let mut amp = 0.5;
    let mut norm = 0.0;
    let mut f = 1.0;
    for o in 0..octaves {
        sum += amp * (value_noise(x * f, z * f, seed.wrapping_add((o as i32).wrapping_mul(1013))) * 2.0 - 1.0);
        norm += amp;
        amp *= 0.5;
        f *= 2.03;
    }
    sum / norm
}

/// 0 at `a`, 1 at `b`, eased between (either way round).
pub fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    let t = js_max(0.0, js_min(1.0, (x - a) / (b - a)));
    t * t * (3.0 - 2.0 * t)
}

/// From `a` to `b` by `t`.
pub fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_numbers_as_the_browser() {
        // src/sim/terrain.ts in Node 24: hash2(3, -7, 7342), valueNoise(12.25, -3.5, 7362),
        // fbm(1.7, 2.9, 4, 7362), and hash2(4294967297, 2147483648, -5), whose numbers wrap.
        assert_eq!(hash2(3, -7, 7342), 0.8172645743470639);
        assert_eq!(value_noise(12.25, -3.5, 7362), 0.550675879141636);
        assert_eq!(fbm(1.7, 2.9, 4, 7362), 0.3002955019495546);
        assert_eq!(hash2(to_int32(4_294_967_297.0), to_int32(2_147_483_648.0), -5), 0.6168647522572428);
    }

    #[test]
    fn javascript_int32() {
        assert_eq!(to_int32(-3.7), -3);
        assert_eq!(to_int32(4_294_967_297.0), 1);
        assert_eq!(to_int32(2_147_483_648.0), i32::MIN);
        assert_eq!(to_int32(f64::NAN), 0);
        assert_eq!(to_int32(f64::INFINITY), 0);
    }
}
