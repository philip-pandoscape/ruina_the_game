//! Emberholm for the server: the zone recipe (shared/zones/emberholm.json) and everything the
//! TypeScript generator grows from it (src/sim/zone/generate.ts): the ground, what each patch of it
//! is made of, which cells are kept clear, and the trees, rocks, walls and decks. The generator
//! runs in the browser; tests/conformance/terrain.test.ts bakes its output into server/data/emberholm.zone and
//! checks the copy is current, so both sides play on exactly the same island.

use crate::jsmath::JsMath;
use std::sync::OnceLock;

use serde::Deserialize;

/// What a patch of ground is made of (src/sim/terrain.ts SURFACE).
pub mod surface {
    pub const GRASS: u8 = 0;
    pub const ROAD: u8 = 1;
    pub const SAND: u8 = 2;
    pub const ROCK: u8 = 3;
    pub const SOIL: u8 = 4;
    pub const PLAZA: u8 = 5;
    pub const FOREST: u8 = 6;
}

/// The ground: a regular grid of heights plus a surface type per cell (src/sim/terrain.ts).
pub struct Heightfield {
    /// Cells per side.
    pub cells: usize,
    /// Vertices per side.
    pub n: usize,
    /// Metres per cell.
    pub cell: f64,
    /// Sea level; anything lower is under water.
    pub water: f64,
    /// World X/Z of vertex (0, 0).
    pub min: f64,
    heights: Vec<f32>,
    /// One per cell.
    pub surface: Vec<u8>,
}

impl Heightfield {
    pub fn size(&self) -> f64 {
        self.cells as f64 * self.cell
    }

    pub fn max(&self) -> f64 {
        self.min + self.size()
    }

    /// The four heights of the quad under a point and where in it the point is.
    fn quad(&self, x: f64, z: f64) -> (f64, f64, f64, f64, f64, f64) {
        let c = self.cell;
        let mut gx = (x - self.min) / c;
        let mut gz = (z - self.min) / c;
        let last = self.cells as f64 - 1e-6;
        gx = if gx < 0.0 {
            0.0
        } else if gx > last {
            last
        } else {
            gx
        };
        gz = if gz < 0.0 {
            0.0
        } else if gz > last {
            last
        } else {
            gz
        };
        let i = gx.floor() as usize;
        let j = gz.floor() as usize;
        let fx = gx - i as f64;
        let fz = gz - j as f64;
        let n = self.n;
        let h = |k: usize| self.heights[k] as f64;
        (h(j * n + i), h(j * n + i + 1), h((j + 1) * n + i), h((j + 1) * n + i + 1), fx, fz)
    }

    /// Ground height at a world point, on the same triangles the renderer draws.
    pub fn height(&self, x: f64, z: f64) -> f64 {
        let (a, b, cc, d, fx, fz) = self.quad(x, z);
        // Quad a(0,0) b(1,0) c(0,1) d(1,1), split along a-d.
        if fx >= fz { a + (b - a) * fx + (d - b) * fz } else { a + (cc - a) * fz + (d - cc) * fx }
    }

    /// dh/dx and dh/dz of the triangle under a point.
    pub fn gradient(&self, x: f64, z: f64) -> (f64, f64) {
        let (a, b, cc, d, fx, fz) = self.quad(x, z);
        let c = self.cell;
        if fx >= fz { ((b - a) / c, (d - b) / c) } else { ((d - cc) / c, (cc - a) / c) }
    }

    /// Steepness at a point: rise over run along the steepest direction of its triangle.
    pub fn slope(&self, x: f64, z: f64) -> f64 {
        let (gx, gz) = self.gradient(x, z);
        (gx * gx + gz * gz).sqrt()
    }

    /// Surface type of the cell under a point (water counts as whatever the seabed is).
    pub fn surface_at(&self, x: f64, z: f64) -> u8 {
        let i = ((x - self.min) / self.cell).floor();
        let j = ((z - self.min) / self.cell).floor();
        if i < 0.0 || j < 0.0 || i >= self.cells as f64 || j >= self.cells as f64 {
            return surface::SAND;
        }
        self.surface[j as usize * self.cells + i as usize]
    }

    /// How deep the water is over a point (0 on dry land).
    pub fn depth(&self, x: f64, z: f64) -> f64 {
        (self.water - self.height(x, z)).max(0.0)
    }

    pub fn inside(&self, x: f64, z: f64, margin: f64) -> bool {
        x >= self.min + margin && x <= self.max() - margin && z >= self.min + margin && z <= self.max() - margin
    }
}

/// Something round and solid the world was built with (src/sim/types.ts Obstacle).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ObstacleKind {
    Tree,
    Rock,
    Crate,
    Hay,
    /// Anything round and solid the world was built with (a well, a lamp, a scarecrow).
    Post,
}

#[derive(Clone, Copy, Debug)]
pub struct Obstacle {
    pub kind: ObstacleKind,
    pub x: f64,
    pub z: f64,
    /// Collision radius; 0 once removed.
    pub r: f64,
}

/// A solid oriented rectangle (a building, a wall, a counter), infinitely tall below `top`; or,
/// as a deck, a walkable platform whose ground is at `top` (src/sim/zone/types.ts BoxCollider).
#[derive(Clone, Copy, Debug)]
pub struct BoxCollider {
    pub x: f64,
    pub z: f64,
    pub hw: f64,
    pub hd: f64,
    pub rot: f64,
    pub cos: f64,
    pub sin: f64,
    pub top: f64,
}

pub type Deck = BoxCollider;

/// A rectangle facing `rot`, as the generator builds them (src/sim/zone/generate.ts rect()).
pub fn rect(x: f64, z: f64, hw: f64, hd: f64, rot: f64, top: f64) -> BoxCollider {
    BoxCollider { x, z, hw, hd, rot, cos: rot.js_cos(), sin: rot.js_sin(), top }
}

/// A world offset into a structure's own frame (src/sim/zone/generate.ts toLocal()).
pub fn to_local(dx: f64, dz: f64, rot: f64) -> (f64, f64) {
    let (c, s) = (rot.js_cos(), rot.js_sin());
    (dx * c - dz * s, dx * s + dz * c)
}

/// A structure-local point back out into the world (src/sim/zone/generate.ts toWorld()).
pub fn to_world(lx: f64, lz: f64, rot: f64) -> (f64, f64) {
    let (c, s) = (rot.js_cos(), rot.js_sin());
    (lx * c + lz * s, -lx * s + lz * c)
}

// ---------- The recipe: only what the rules read ----------

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Spawn {
    pub x: f64,
    pub z: f64,
    pub facing: f64,
}

/// Where a dungeon's portal stands in the open world (F within `r` of it takes you in), and where
/// you come out of it again, facing away from it (src/sim/zone/types.ts DungeonDoor).
#[derive(Deserialize, Clone, Debug)]
pub struct DungeonDoor {
    pub id: String,
    pub portal: Portal,
    pub outside: Spawn,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Portal {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub r: f64,
}

impl Portal {
    /// Whether someone standing at (x, y, z) is at it (within its reach, with a step's slack).
    pub fn reaches(&self, x: f64, y: f64, z: f64) -> bool {
        ((x - self.x).powi(2) + (z - self.z).powi(2)).sqrt() <= self.r + 1.0 && (y - self.y).abs() < 4.0
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct Place {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub x: f64,
    pub z: f64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Npc {
    pub id: String,
    pub name: String,
    pub title: String,
    pub x: f64,
    pub z: f64,
    pub facing: f64,
    pub kind: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Workbench {
    pub id: String,
    pub place: String,
    pub x: f64,
    pub z: f64,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Outpost {
    pub id: String,
    pub npc: String,
    pub x: f64,
    pub z: f64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct HousePlot {
    pub id: String,
    pub x: f64,
    pub z: f64,
    pub rot: f64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Node {
    pub kind: String,
    pub x: f64,
    pub z: f64,
    pub rot: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Updraft {
    pub x: f64,
    pub z: f64,
    pub r: f64,
    /// It stops lifting above this height.
    pub top: f64,
    /// Climb rate at its core, m/s.
    pub strength: f64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Shipyard {
    pub id: String,
    pub name: String,
    pub x: f64,
    pub z: f64,
    pub rot: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Sky {
    pub day_length_seconds: f64,
    pub start_hour: f64,
    pub sunrise: f64,
    pub sunset: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Slimes {
    pub x: f64,
    pub z: f64,
    pub count: usize,
    pub r: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Point {
    pub x: f64,
    pub z: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    pub id: String,
    pub name: String,
    pub seed: u32,
    pub climate: String,
    pub spawn: Spawn,
    pub places: Vec<Place>,
    pub npcs: Vec<Npc>,
    pub workbenches: Vec<Workbench>,
    pub outposts: Vec<Outpost>,
    pub house_plots: Vec<HousePlot>,
    pub nodes: Vec<Node>,
    pub updrafts: Vec<Updraft>,
    #[serde(default)]
    pub shipyards: Vec<Shipyard>,
    /// The doors of the island's dungeons (open/dungeon.rs).
    #[serde(default)]
    pub dungeons: Vec<DungeonDoor>,
    pub sky: Sky,
    pub slimes: Slimes,
    pub dummy: Point,
}

/// A zone as the rules see it: the recipe and what was grown from it.
pub struct Zone {
    pub recipe: Recipe,
    pub terrain: Heightfield,
    /// Cells kept free of trees and rocks (and of scarecrows, unless they are farmland), as built.
    pub clear: Vec<u8>,
    pub obstacles: Vec<Obstacle>,
    pub boxes: Vec<BoxCollider>,
    pub decks: Vec<Deck>,
    /// How far from the middle anything can go (src/sim/zone/world.ts: half the island, less 8 m).
    pub radius: f64,
}

/// Reads the baked island (see tests/conformance/terrain.test.ts for the layout).
pub fn parse(b: &[u8], recipe: Recipe) -> Option<Zone> {
    struct Reader<'a> {
        b: &'a [u8],
        at: usize,
    }
    impl Reader<'_> {
        fn take(&mut self, n: usize) -> Option<&[u8]> {
            let s = self.b.get(self.at..self.at + n)?;
            self.at += n;
            Some(s)
        }
        fn u32(&mut self) -> Option<u32> {
            self.take(4).map(|s| u32::from_le_bytes(s.try_into().unwrap()))
        }
        fn f64(&mut self) -> Option<f64> {
            self.take(8).map(|s| f64::from_le_bytes(s.try_into().unwrap()))
        }
        fn rects(&mut self) -> Option<Vec<BoxCollider>> {
            let n = self.u32()? as usize;
            (0..n)
                .map(|_| {
                    Some(BoxCollider {
                        x: self.f64()?,
                        z: self.f64()?,
                        hw: self.f64()?,
                        hd: self.f64()?,
                        rot: self.f64()?,
                        cos: self.f64()?,
                        sin: self.f64()?,
                        top: self.f64()?,
                    })
                })
                .collect()
        }
    }
    let mut r = Reader { b, at: 0 };
    if r.take(4)? != b"RUZN" || r.u32()? != 1 {
        return None;
    }
    let cells = r.u32()? as usize;
    let (cell, water, min) = (r.f64()?, r.f64()?, r.f64()?);
    let n = cells + 1;
    let heights = r.take(n * n * 4)?.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let surface = r.take(cells * cells)?.to_vec();
    let clear = r.take(cells * cells)?.to_vec();
    let count = r.u32()? as usize;
    let mut obstacles = Vec::with_capacity(count);
    for _ in 0..count {
        let kind = match r.take(1)?[0] {
            0 => ObstacleKind::Tree,
            1 => ObstacleKind::Rock,
            2 => ObstacleKind::Crate,
            3 => ObstacleKind::Hay,
            _ => ObstacleKind::Post,
        };
        obstacles.push(Obstacle { kind, x: r.f64()?, z: r.f64()?, r: r.f64()? });
    }
    let boxes = r.rects()?;
    let decks = r.rects()?;
    if r.at != b.len() {
        return None;
    }
    let terrain = Heightfield { cells, n, cell, water, min, heights, surface };
    let radius = terrain.size() / 2.0 - 8.0;
    Some(Zone { recipe, terrain, clear, obstacles, boxes, decks, radius })
}

/// Emberholm, the starter isle, baked into the server.
pub fn emberholm() -> &'static Zone {
    static Z: OnceLock<Zone> = OnceLock::new();
    Z.get_or_init(|| {
        let recipe: Recipe = serde_json::from_str(include_str!("../../../shared/zones/emberholm.json")).expect("shared/zones/emberholm.json is a zone recipe");
        parse(include_bytes!("../../data/emberholm.zone"), recipe).expect("server/data/emberholm.zone is valid: rebake it with npm run bake")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emberholm_loads() {
        let z = emberholm();
        assert_eq!(z.recipe.id, "emberholm");
        assert!(z.obstacles.len() > 100);
        assert!(!z.boxes.is_empty());
        let s = z.recipe.spawn;
        assert!(z.terrain.height(s.x, s.z) > z.terrain.water, "the spawn is on dry land");
    }

    #[test]
    fn local_and_world_frames_undo_each_other() {
        let (lx, lz) = to_local(3.0, -2.0, 0.7);
        let (x, z) = to_world(lx, lz, 0.7);
        assert!((x - 3.0).abs() < 1e-12 && (z + 2.0).abs() < 1e-12);
    }
}
