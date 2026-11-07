//! A zone as the rules see it: its recipe (shared/regions/, built from content/regions/) and what the
//! generator (generate.rs) grows from it: the ground, what each patch of it is made of, which cells
//! are kept clear, and the trees, rocks, walls and decks. Emberholm is grown the first time anything
//! asks (about a tenth of a second). The browser grows it with this same code, through the
//! WebAssembly (zone_grow); tests/conformance/terrain.test.ts holds the two to each other.

use crate::jsmath::JsMath;

use serde::{Deserialize, Serialize};

use super::generate::{Forest, PropPlacement, Scatter, StructurePlacement, Terrain};
use super::spawns::ZoneSpawn;

/// What a patch of ground is made of (src/engine/world/terrain.ts SURFACE).
pub mod surface {
    pub const GRASS: u8 = 0;
    pub const ROAD: u8 = 1;
    pub const SAND: u8 = 2;
    pub const ROCK: u8 = 3;
    pub const SOIL: u8 = 4;
    pub const PLAZA: u8 = 5;
    pub const FOREST: u8 = 6;
}

/// The ground: a regular grid of heights plus a surface type per cell (src/engine/world/terrain.ts).
#[derive(Clone)]
pub struct Heightfield {
    /// Cells per side.
    pub cells: usize,
    /// Vertices per side.
    pub n: usize,
    /// Metres per cell.
    pub cell: f64,
    /// Sea level; anything lower is under water.
    pub water: f64,
    /// World X and Z of vertex (0, 0).
    pub min_x: f64,
    pub min_z: f64,
    heights: Vec<f32>,
    /// One per cell.
    pub surface: Vec<u8>,
}

impl Heightfield {
    /// A flat grid at height 0, all grass: `cells` a side, `cell` metres each, centred on (cx, cz).
    pub fn new(cells: usize, cell: f64, water: f64, cx: f64, cz: f64) -> Self {
        let n = cells + 1;
        let half = (cells as f64 * cell) / 2.0;
        Heightfield { cells, n, cell, water, min_x: cx - half, min_z: cz - half, heights: vec![0.0; n * n], surface: vec![surface::GRASS; cells * cells] }
    }

    /// A grid another engine grew (the browser's worker grows regions and hands them over): `heights`
    /// row by row, a surface per cell; None if they aren't a grid `cells` across's.
    pub fn from_parts(cells: usize, cell: f64, water: f64, min_x: f64, min_z: f64, heights: Vec<f32>, surface: Vec<u8>) -> Option<Self> {
        let n = cells + 1;
        (heights.len() == n * n && surface.len() == cells * cells).then_some(Heightfield { cells, n, cell, water, min_x, min_z, heights, surface })
    }

    /// World X of vertex column `i`.
    pub fn vx(&self, i: usize) -> f64 {
        self.min_x + i as f64 * self.cell
    }

    /// World Z of vertex row `j`.
    pub fn vz(&self, j: usize) -> f64 {
        self.min_z + j as f64 * self.cell
    }

    /// The column and row of the cell under a point, which may lie outside the grid.
    pub fn cell_of(&self, x: f64, z: f64) -> (f64, f64) {
        (((x - self.min_x) / self.cell).floor(), ((z - self.min_z) / self.cell).floor())
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

    pub fn max_x(&self) -> f64 {
        self.min_x + self.size()
    }

    pub fn max_z(&self) -> f64 {
        self.min_z + self.size()
    }

    /// The four heights of the quad under a point and where in it the point is.
    fn quad(&self, x: f64, z: f64) -> (f64, f64, f64, f64, f64, f64) {
        let c = self.cell;
        let mut gx = (x - self.min_x) / c;
        let mut gz = (z - self.min_z) / c;
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
        let (i, j) = self.cell_of(x, z);
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
        x >= self.min_x + margin && x <= self.max_x() - margin && z >= self.min_z + margin && z <= self.max_z() - margin
    }
}

/// Something round and solid the world was built with (src/engine/shapes.ts Obstacle).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ObstacleKind {
    Tree,
    Rock,
    Crate,
    Hay,
    /// Anything round and solid the world was built with (a well, a lamp, a scarecrow).
    Post,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
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
/// as a deck, a walkable platform whose ground is at `top` (src/engine/world/types.ts BoxCollider).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
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

/// A rectangle facing `rot`, as the generator builds them.
pub fn rect(x: f64, z: f64, hw: f64, hd: f64, rot: f64, top: f64) -> BoxCollider {
    BoxCollider { x, z, hw, hd, rot, cos: rot.js_cos(), sin: rot.js_sin(), top }
}

/// A world offset into a structure's own frame.
pub fn to_local(dx: f64, dz: f64, rot: f64) -> (f64, f64) {
    let (c, s) = (rot.js_cos(), rot.js_sin());
    (dx * c - dz * s, dx * s + dz * c)
}

/// A structure-local point back out into the world.
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
/// you come out of it again, facing away from it (src/engine/world/types.ts DungeonDoor).
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
    /// Unique across the world (contentc): what its time to come back is kept by.
    pub id: String,
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
    /// The doors into the dungeons in it (open/dungeon.rs), each named for the instance it opens into.
    #[serde(default)]
    pub doors: Vec<DungeonDoor>,
    pub sky: Sky,
    /// The creatures it brings to life where it's played: slimes in their meadow, the training
    /// dummy (open/spawns.rs).
    #[serde(default)]
    pub spawns: Vec<ZoneSpawn>,
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
    /// How far from the middle anything can go (src/engine/world/region.ts: half the island, less 8 m).
    pub radius: f64,
}

impl Zone {
    /// Grows the zone its recipe describes (the browser too, through the WebAssembly): about a tenth
    /// of a second for Emberholm.
    pub fn grow(recipe: Recipe) -> Zone {
        let g = super::generate::generate(&recipe);
        Zone::of(recipe, g)
    }

    /// The zone a recipe grew into.
    pub fn of(recipe: Recipe, g: super::generate::Generated) -> Zone {
        let radius = g.terrain.size() / 2.0 - 8.0;
        Zone { recipe, terrain: g.terrain, clear: g.clear, obstacles: g.obstacles, boxes: g.boxes, decks: g.decks, radius }
    }
}

/// Emberholm's recipe (shared/regions/emberholm.json, built from content/regions/).
pub fn emberholm_recipe() -> Recipe {
    super::map::region_recipe("emberholm").expect("shared/regions/emberholm.json")
}

/// Emberholm, the starter isle and the world's first region, grown the first time anything asks.
pub fn emberholm() -> &'static Zone {
    let map = super::map::world_map();
    map.zone(map.region("emberholm").expect("Emberholm is a region of the world (shared/world.json)"))
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
