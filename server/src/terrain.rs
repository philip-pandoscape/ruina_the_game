//! Emberholm's ground, for code that only needs the ground: a thin layer over the whole island in
//! server/src/open/zone.rs.

use crate::open::zone::{emberholm, Heightfield};

pub type Terrain = Heightfield;

impl Heightfield {
    /// Emberholm, baked into the server.
    pub fn emberholm() -> &'static Heightfield {
        &emberholm().terrain
    }
}

/// Where newcomers (and the lost) arrive: the zone recipe's spawn point.
pub fn spawn() -> (f64, f64) {
    let s = emberholm().recipe.spawn;
    (s.x, s.z)
}

/// Where to put someone back if (x, y, z) can't be right: not a number, off the island, or more
/// than 3 m under the ground. None if it's fine.
pub fn correction(t: &Terrain, x: f64, y: f64, z: f64, spawn: (f64, f64)) -> Option<(f64, f64, f64)> {
    if !x.is_finite() || !y.is_finite() || !z.is_finite() || !t.inside(x, z, 0.0) {
        return Some((spawn.0, t.height(spawn.0, spawn.1) + 0.5, spawn.1));
    }
    let ground = t.height(x, z);
    if y < ground - 3.0 {
        return Some((x, ground + 0.5, z));
    }
    None
}
