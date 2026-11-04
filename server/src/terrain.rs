//! Emberholm's ground, for the server. The island is grown by the TypeScript generator
//! (src/sim/zone/generate.ts); tests/terrain.spec.ts bakes its height grid into
//! server/data/emberholm.terrain and checks the copy is current, and this samples it on the same
//! triangles as Heightfield.height() in src/sim/terrain.ts, so both sides stand on the same ground.
//!
//! File: b"RUHF", u32 version (1), u32 cells, f64 cell size, f64 water level, f64 world X/Z of
//! vertex (0, 0), then (cells + 1)^2 little-endian f32 heights, row by row.

use std::sync::OnceLock;

pub struct Terrain {
    pub cells: usize,
    pub n: usize,
    pub cell: f64,
    pub water: f64,
    pub min: f64,
    heights: Vec<f32>,
}

impl Terrain {
    pub fn parse(b: &[u8]) -> Option<Terrain> {
        if b.len() < 36 || &b[0..4] != b"RUHF" || u32::from_le_bytes(b[4..8].try_into().ok()?) != 1 {
            return None;
        }
        let cells = u32::from_le_bytes(b[8..12].try_into().ok()?) as usize;
        let f = |o: usize| b[o..o + 8].try_into().ok().map(f64::from_le_bytes);
        let (cell, water, min) = (f(12)?, f(20)?, f(28)?);
        let n = cells + 1;
        let data = &b[36..];
        if data.len() != n * n * 4 {
            return None;
        }
        let heights = data.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        Some(Terrain { cells, n, cell, water, min, heights })
    }

    /// Emberholm, baked into the server.
    pub fn emberholm() -> &'static Terrain {
        static T: OnceLock<Terrain> = OnceLock::new();
        T.get_or_init(|| Terrain::parse(include_bytes!("../data/emberholm.terrain")).expect("server/data/emberholm.terrain is valid"))
    }

    pub fn max(&self) -> f64 {
        self.min + self.cells as f64 * self.cell
    }

    /// Ground height at a world point: the same arithmetic as Heightfield.height().
    pub fn height(&self, x: f64, z: f64) -> f64 {
        let c = self.cell;
        let mut gx = (x - self.min) / c;
        let mut gz = (z - self.min) / c;
        let last = self.cells as f64 - 1e-6;
        gx = if gx < 0.0 { 0.0 } else if gx > last { last } else { gx };
        gz = if gz < 0.0 { 0.0 } else if gz > last { last } else { gz };
        let i = gx.floor() as usize;
        let j = gz.floor() as usize;
        let fx = gx - i as f64;
        let fz = gz - j as f64;
        let n = self.n;
        let h = |k: usize| self.heights[k] as f64;
        let a = h(j * n + i);
        let b = h(j * n + i + 1);
        let cc = h((j + 1) * n + i);
        let d = h((j + 1) * n + i + 1);
        // Quad a(0,0) b(1,0) c(0,1) d(1,1), split along a-d.
        if fx >= fz { a + (b - a) * fx + (d - b) * fz } else { a + (cc - a) * fz + (d - cc) * fx }
    }

    pub fn inside(&self, x: f64, z: f64, margin: f64) -> bool {
        x >= self.min + margin && x <= self.max() - margin && z >= self.min + margin && z <= self.max() - margin
    }
}

/// Where newcomers (and the lost) arrive: the zone recipe's spawn point.
pub fn spawn() -> (f64, f64) {
    static S: OnceLock<(f64, f64)> = OnceLock::new();
    *S.get_or_init(|| {
        let z: serde_json::Value = serde_json::from_str(include_str!("../../shared/zones/emberholm.json")).expect("shared/zones/emberholm.json is valid");
        (z["spawn"]["x"].as_f64().unwrap_or(0.0), z["spawn"]["z"].as_f64().unwrap_or(0.0))
    })
}

/// How far below the ground a reported position may be before it can't be right (feet sink a
/// little into slopes, and positions are a step old).
const BURIED: f64 = 3.0;

/// Where to put a player back if where they say they are is impossible: under the ground, or off
/// the island. None when it's fine.
pub fn correction(t: &Terrain, x: f64, y: f64, z: f64, spawn: (f64, f64)) -> Option<(f64, f64, f64)> {
    if !(x.is_finite() && y.is_finite() && z.is_finite()) || !t.inside(x, z, 0.0) {
        let (sx, sz) = spawn;
        return Some((sx, t.height(sx, sz).max(t.water) + 0.5, sz));
    }
    let ground = t.height(x, z);
    (y < ground - BURIED).then(|| (x, ground + 0.5, z))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny() -> Terrain {
        // 2 x 2 cells of 10 m from (-10, -10): a slope rising to the east, 0 to 20 m.
        let mut b = b"RUHF".to_vec();
        b.extend(1u32.to_le_bytes());
        b.extend(2u32.to_le_bytes());
        for v in [10.0f64, 0.0, -10.0] {
            b.extend(v.to_le_bytes());
        }
        for _row in 0..3 {
            for h in [0.0f32, 10.0, 20.0] {
                b.extend(h.to_le_bytes());
            }
        }
        Terrain::parse(&b).unwrap()
    }

    #[test]
    fn samples_the_grid_on_its_triangles() {
        let t = tiny();
        assert_eq!(t.height(-10.0, -10.0), 0.0);
        assert_eq!(t.height(0.0, 0.0), 10.0);
        assert!((t.height(5.0, -3.0) - 15.0).abs() < 1e-9);
        // Off the edge it holds the edge's height.
        assert!((t.height(50.0, 0.0) - 20.0).abs() < 1e-4);
    }

    #[test]
    fn puts_back_the_buried_and_the_lost() {
        let t = tiny();
        assert_eq!(correction(&t, 0.0, 9.0, 0.0, (0.0, 0.0)), None);
        assert_eq!(correction(&t, 0.0, 2.0, 0.0, (0.0, 0.0)), Some((0.0, 10.5, 0.0)));
        assert_eq!(correction(&t, 99.0, 50.0, 0.0, (-10.0, -10.0)), Some((-10.0, 0.5, -10.0)));
        assert!(correction(&t, f64::NAN, 0.0, 0.0, (0.0, 0.0)).is_some());
    }

    #[test]
    fn emberholm_is_baked_in() {
        let t = Terrain::emberholm();
        assert_eq!(t.n * t.n, t.heights.len());
        assert!(t.inside(0.0, -264.0, 0.0));
    }
}
