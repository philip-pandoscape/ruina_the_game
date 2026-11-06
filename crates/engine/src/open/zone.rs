//! A zone as the rules see it: its recipe (shared/zones/, built from content/zones/) and what the
//! generator (generate.rs) grows from it: the ground, what each patch of it is made of, which cells
//! are kept clear, and the trees, rocks, walls and decks. Emberholm is grown the first time anything
//! asks (about a tenth of a second). The browser grows it with this same code, through the
//! WebAssembly (zone_grow); tests/conformance/terrain.test.ts holds the two to each other.

use crate::jsmath::JsMath;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::generate::{Forest, PropPlacement, Scatter, StructurePlacement, Terrain};

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
    /// A flat grid at height 0, all grass: `cells` a side, `cell` metres each, centred on the origin.
    pub fn new(cells: usize, cell: f64, water: f64) -> Self {
        let n = cells + 1;
        Heightfield { cells, n, cell, water, min: -(cells as f64 * cell) / 2.0, heights: vec![0.0; n * n], surface: vec![surface::GRASS; cells * cells] }
    }

    /// World position of vertex `i` along either axis.
    pub fn vx(&self, i: usize) -> f64 {
        self.min + i as f64 * self.cell
    }

    /// The heights, a row of vertices at a time ((cells + 1) squared).
    pub fn heights(&self) -> &[f32] {
        &self.heights
    }

    pub(crate) fn heights_mut(&mut self) -> &mut [f32] {
        &mut self.heights
    }

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
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ObstacleKind {
    Tree,
    Rock,
    Crate,
    Hay,
    /// Anything round and solid the world was built with (a well, a lamp, a scarecrow).
    Post,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Obstacle {
    pub kind: ObstacleKind,
    pub x: f64,
    pub z: f64,
    /// Collision radius; 0 once removed.
    pub r: f64,
    /// How big it's drawn and which way it's turned (a tree's, a rock's); the rules don't read them.
    pub scale: f64,
    pub rot: f64,
}

/// A solid oriented rectangle (a building, a wall, a counter), infinitely tall below `top`; or,
/// as a deck, a walkable platform whose ground is at `top` (src/sim/zone/types.ts BoxCollider).
#[derive(Clone, Copy, Debug, Serialize)]
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
    /// The ground the generator grows (open/generate.rs), and what it places on it.
    pub terrain: Terrain,
    #[serde(default)]
    pub structures: Vec<StructurePlacement>,
    #[serde(default)]
    pub props: Vec<PropPlacement>,
    #[serde(default)]
    pub forests: Vec<Forest>,
    pub scatter: Scatter,
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

impl Zone {
    /// Grows the zone its recipe describes (src/sim/zone/generate.ts in the browser, until it runs
    /// this too): about a tenth of a second for Emberholm.
    pub fn grow(recipe: Recipe) -> Zone {
        let g = super::generate::generate(&recipe);
        let radius = g.terrain.size() / 2.0 - 8.0;
        Zone { recipe, terrain: g.terrain, clear: g.clear, obstacles: g.obstacles, boxes: g.boxes, decks: g.decks, radius }
    }
}

/// Emberholm's recipe (shared/zones/emberholm.json, built from content/zones/).
pub fn emberholm_recipe() -> Recipe {
    serde_json::from_str(crate::bundles::bundle("zones/emberholm.json", include_str!("../../../../shared/zones/emberholm.json")))
        .expect("shared/zones/emberholm.json is a zone recipe")
}

/// Emberholm, the starter isle, grown the first time anything asks.
pub fn emberholm() -> &'static Zone {
    static Z: OnceLock<Zone> = OnceLock::new();
    Z.get_or_init(|| Zone::grow(emberholm_recipe()))
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
