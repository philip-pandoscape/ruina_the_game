//! Grows a region from its recipe (shared/regions/*.json, built from content/regions/): coastline, cliffs,
//! hills, mountains with a path carved up their face, flattened town squares, graded roads, then the
//! trees and rocks, the buildings' colliders and the decks you can walk on, and last the waterfalls.
//! Same recipe, same seed, same island, every time: the server grows it natively and the browser
//! through the WebAssembly (zone_grow), and tests/conformance/terrain.test.ts holds the two to the
//! bit. The maths is the browser's (jsmath.rs), and heights are kept as single floats, as the
//! browser's Float32Array keeps them.

use std::collections::BTreeMap;
use std::f64::consts::{FRAC_PI_2, PI};

use serde::{Deserialize, Serialize};

use super::buildings::{building_colliders, placed_plan};
use super::noise::{fbm, lerp, smoothstep};
use super::zone::{BoxCollider, Deck, Heightfield, Obstacle, ObstacleKind, Recipe, rect, surface, to_local, to_world};
use crate::jsmath::{JsMath, js_hypot, js_max, js_min, js_round};
use crate::life::content::{StructureDef, prop_def, structure_def};
use crate::rng::Rng;

const TAU: f64 = PI * 2.0;
/// Half the width of the runnel a waterfall's spring spills to the lip along (src/render/open/falls.ts draws its water).
pub const RUNNEL: f64 = 2.2;

// ---------- The recipe's terrain and what it places, as the generator reads them ----------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Terrain {
    /// Cells per side, metres per cell, and sea level.
    pub cells: usize,
    pub cell: f64,
    pub water: f64,
    /// Where the middle of the grid stands in the world (x, z): Emberholm's is the world's origin. A
    /// region's recipe is written in world coordinates, so nothing in it moves when it's placed.
    #[serde(default)]
    pub origin: [f64; 2],
    pub landmass: Landmass,
    #[serde(default)]
    pub bays: Vec<Circle>,
    #[serde(default)]
    pub headlands: Vec<Headland>,
    #[serde(default)]
    pub islets: Vec<Circle>,
    #[serde(default)]
    pub cliffs: Vec<Cliff>,
    pub shore: Shore,
    pub hills: Hills,
    #[serde(default)]
    pub mountains: Vec<Mountain>,
    #[serde(default)]
    pub ramps: Vec<Ramp>,
    #[serde(default)]
    pub pits: Vec<Pit>,
    #[serde(default)]
    pub flatten: Vec<Flatten>,
    #[serde(default)]
    pub roads: Vec<RoadRecipe>,
    /// Waterfalls down a mountain's face (each cut after the trees and rocks are placed, so none of them move).
    #[serde(default)]
    pub falls: Vec<FallsRecipe>,
    pub sand_below: f64,
    pub rock_slope: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Landmass {
    pub x: f64,
    pub z: f64,
    pub radius: f64,
    /// Waves round the coast: [how many, how far out, phase].
    pub lobes: Vec<[f64; 3]>,
    pub warp: f64,
    pub warp_scale: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Circle {
    pub x: f64,
    pub z: f64,
    pub r: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Headland {
    pub x: f64,
    pub z: f64,
    pub r: f64,
    pub push: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Cliff {
    pub x: f64,
    pub z: f64,
    pub r: f64,
    pub h: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Shore {
    pub beach: f64,
    pub beach_height: f64,
    pub inland_rise: f64,
    pub seabed_slope: f64,
    pub seabed_curve: f64,
    pub max_depth: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hills {
    pub scale: f64,
    pub height: f64,
    pub detail_scale: f64,
    pub detail: f64,
    pub inland_from: f64,
    pub inland_to: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Mountain {
    pub id: String,
    pub x: f64,
    pub z: f64,
    pub top: f64,
    pub plateau: f64,
    pub cliff: f64,
    pub skirt: f64,
    pub cliff_drop: f64,
    pub rugged: f64,
    pub crag: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Ramp {
    pub mountain: String,
    pub start_angle: f64,
    pub turns: f64,
    pub direction: f64,
    pub from: f64,
    pub to: f64,
    pub width: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Pit {
    pub x: f64,
    pub z: f64,
    pub r: f64,
    pub depth: f64,
    pub floor: f64,
}

/// The height a flatten levels to: a number, or "auto" (the ground's own height at its middle).
#[derive(Deserialize, Clone, Debug)]
#[serde(untagged)]
pub enum Level {
    At(f64),
    Auto(String),
}

/// Ground levelled to a height: a circle (`r`) or a rectangle (`w`, `d`), blended out over `fall`.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Flatten {
    pub id: String,
    pub x: f64,
    pub z: f64,
    pub r: Option<f64>,
    pub w: Option<f64>,
    pub d: Option<f64>,
    pub fall: f64,
    pub h: Level,
    pub surface: Option<String>,
    pub surface_r: Option<f64>,
    pub sea_fall: Option<f64>,
    /// false: its ground stays open to trees, rocks and scarecrows (the fields).
    pub keep_clear: Option<bool>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct RoadRecipe {
    pub id: String,
    pub width: f64,
    pub points: Vec<[f64; 2]>,
}

/// A waterfall down a mountain's face (src/engine/world/types.ts WaterfallRecipe): distances are out from
/// the mountain's middle along `bearing`.
#[derive(Deserialize, Clone, Debug)]
pub struct FallsRecipe {
    pub id: String,
    pub mountain: String,
    pub bearing: f64,
    pub lip: f64,
    pub foot: f64,
    pub width: f64,
    pub blend: f64,
    pub floor: [f64; 2],
    pub shelf: Shelf,
    pub roof: Hood,
    /// A landing stage on the ledge (a deck to glide down onto), if it has one.
    #[serde(default)]
    pub landing: Option<Landing>,
    /// A totem on the ledge (a post), if it has one.
    #[serde(default)]
    pub totem: Option<Totem>,
    pub spring: Spring,
    pub plunge: Plunge,
    pub speed: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Shelf {
    pub top: f64,
    pub depth: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Hood {
    pub above: f64,
    pub depth: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Landing {
    pub from: f64,
    pub to: f64,
    pub half: f64,
    pub above: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Totem {
    pub at: f64,
    pub across: f64,
    pub above: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Spring {
    pub at: f64,
    pub r: f64,
    pub depth: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Plunge {
    pub at: f64,
    pub along: f64,
    pub across: f64,
    pub depth: f64,
}

/// A structure placed in a zone (`mirror`: a building built left for right).
#[derive(Deserialize, Clone, Debug)]
pub struct StructurePlacement {
    pub id: String,
    pub x: f64,
    pub z: f64,
    pub rot: f64,
    pub tint: Option<f64>,
    pub seed: Option<f64>,
    pub decor: Option<Vec<String>>,
    pub mirror: Option<bool>,
}

/// Props placed one by one, in a ring, along a road or along a fence line.
#[derive(Deserialize, Clone, Debug)]
pub struct PropPlacement {
    pub id: String,
    pub x: Option<f64>,
    pub z: Option<f64>,
    pub rot: Option<f64>,
    pub ring: Option<Ring>,
    pub along: Option<String>,
    pub every: Option<f64>,
    pub line: Option<[[f64; 2]; 2]>,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Ring {
    pub x: f64,
    pub z: f64,
    pub r: f64,
    pub count: f64,
    pub phase: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Forest {
    pub x: f64,
    pub z: f64,
    pub r: f64,
    pub density: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Scatter {
    pub trees: f64,
    pub rocks: f64,
    pub clear_of_road: Option<f64>,
    pub clear_of_structure: Option<f64>,
}

// ---------- What the generator grows ----------

/// A road's centre-line as sampled, for the map, lamp placement and travel by road.
#[derive(Serialize, Clone, Debug)]
pub struct Road {
    pub id: String,
    pub width: f64,
    pub points: Vec<[f64; 2]>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PlacementKind {
    Structure,
    Prop,
    Node,
}

/// Something to draw, with its height already resolved from the terrain.
#[derive(Serialize, Clone, Debug)]
pub struct Placement {
    pub kind: PlacementKind,
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub rot: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tint: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decor: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mirror: Option<bool>,
}

/// A building you can walk into, where it stands; its walls are `boxes` (a range of the zone's boxes:
/// the camera sees through the walls of the one you are in).
#[derive(Serialize, Clone, Debug)]
pub struct PlacedBuilding {
    pub id: String,
    pub mirror: bool,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub rot: f64,
    pub boxes: [usize; 2],
}

/// A stretch out from a waterfall's back wall (s0 to s1), and the height of its top.
#[derive(Serialize, Clone, Copy, Debug)]
pub struct Span {
    pub s0: f64,
    pub s1: f64,
    pub top: f64,
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct LandingInfo {
    pub s0: f64,
    pub s1: f64,
    pub half: f64,
    pub top: f64,
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct TotemInfo {
    pub s: f64,
    pub t: f64,
    pub top: f64,
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct SpringInfo {
    pub x: f64,
    pub z: f64,
    pub at: f64,
    pub r: f64,
    pub level: f64,
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct PlungeInfo {
    pub x: f64,
    pub z: f64,
    pub s: f64,
    pub along: f64,
    pub across: f64,
    pub level: f64,
}

/// A waterfall as the generator cut it (src/engine/world/types.ts WaterfallInfo): the mountain's middle,
/// the unit vectors out along the bearing (u) and across it (v), and where everything is.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WaterfallInfo {
    pub id: String,
    pub cx: f64,
    pub cz: f64,
    pub ux: f64,
    pub uz: f64,
    pub vx: f64,
    pub vz: f64,
    pub lip: f64,
    pub lip_y: f64,
    pub foot: f64,
    pub width: f64,
    pub speed: f64,
    pub shelf: Span,
    pub roof: Span,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub landing: Option<LandingInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub totem: Option<TotemInfo>,
    pub floor: [f64; 2],
    pub spring: SpringInfo,
    pub plunge: PlungeInfo,
    /// How far the spring's runnel reaches either side of the bearing (`RUNNEL`), for drawing it.
    pub runnel: f64,
}

/// Everything grown from a recipe.
pub struct Generated {
    pub terrain: Heightfield,
    pub obstacles: Vec<Obstacle>,
    pub boxes: Vec<BoxCollider>,
    pub decks: Vec<Deck>,
    /// Road centre-lines as sampled polylines.
    pub roads: Vec<Road>,
    /// The carved mountain paths.
    pub ramps: Vec<Vec<[f64; 2]>>,
    /// Cells kept free of trees and rocks (and of scarecrows, unless they are farmland).
    pub clear: Vec<u8>,
    /// Static decoration placed from the recipe, resolved to heights.
    pub placements: Vec<Placement>,
    /// The waterfalls, as cut.
    pub falls: Vec<WaterfallInfo>,
    /// The buildings you can walk into.
    pub buildings: Vec<PlacedBuilding>,
}

/// The grid's shape, apart from its heights, so a pass can read it while it writes them.
#[derive(Clone, Copy)]
struct Grid {
    n: usize,
    cells: usize,
    cell: f64,
    min_x: f64,
    min_z: f64,
}

impl Grid {
    fn vx(&self, i: usize) -> f64 {
        self.min_x + i as f64 * self.cell
    }

    fn vz(&self, j: usize) -> f64 {
        self.min_z + j as f64 * self.cell
    }

    /// Every vertex in the square reaching `r` round (cx, cz), row by row: (i, j, x, z).
    fn each_vertex_near(&self, cx: f64, cz: f64, r: f64, mut f: impl FnMut(usize, usize, f64, f64)) {
        let last = (self.n - 1) as f64;
        let i0 = js_max(0.0, ((cx - r - self.min_x) / self.cell).floor());
        let i1 = js_min(last, ((cx + r - self.min_x) / self.cell).ceil());
        let j0 = js_max(0.0, ((cz - r - self.min_z) / self.cell).floor());
        let j1 = js_min(last, ((cz + r - self.min_z) / self.cell).ceil());
        if !(i0 <= i1 && j0 <= j1) {
            return;
        }
        for j in j0 as usize..=j1 as usize {
            for i in i0 as usize..=i1 as usize {
                f(i, j, self.vx(i), self.vz(j));
            }
        }
    }

    /// The cell under a world point, if it's on the grid.
    fn cell_of(&self, x: f64, z: f64) -> Option<usize> {
        let i = ((x - self.min_x) / self.cell).floor();
        let j = ((z - self.min_z) / self.cell).floor();
        let cells = self.cells as f64;
        if i >= 0.0 && j >= 0.0 && i < cells && j < cells { Some(j as usize * self.cells + i as usize) } else { None }
    }

    /// The cells (by a corner, one cell apart) of a rectangle turned `rot` round (x, z).
    fn cells_in_rect(&self, x: f64, z: f64, hw: f64, hd: f64, rot: f64, mut f: impl FnMut(f64, f64)) {
        let r = js_hypot(hw, hd) + self.cell;
        let mut cz = z - r;
        while cz <= z + r {
            let mut cx = x - r;
            while cx <= x + r {
                let (lx, lz) = to_local(cx - x, cz - z, rot);
                if lx.abs() <= hw && lz.abs() <= hd {
                    f(cx, cz);
                }
                cx += self.cell;
            }
            cz += self.cell;
        }
    }
}

/// A surface's code by its name (zone.rs `surface`), if there's a surface of that name.
fn surface_code(name: &str) -> Option<u8> {
    Some(match name {
        "grass" => surface::GRASS,
        "road" => surface::ROAD,
        "sand" => surface::SAND,
        "rock" => surface::ROCK,
        "soil" => surface::SOIL,
        "plaza" => surface::PLAZA,
        "forest" => surface::FOREST,
        _ => return None,
    })
}

fn get(h: &[f32], k: usize) -> f64 {
    f64::from(h[k])
}

/// `||` on a number: `v`, unless it's 0 or NaN.
fn or(v: f64, otherwise: f64) -> f64 {
    if v == 0.0 || v.is_nan() { otherwise } else { v }
}

/// Grows the zone a recipe describes.
pub fn generate(z: &Recipe) -> Generated {
    let t = &z.terrain;
    let mut hf = Heightfield::new(t.cells, t.cell, t.water, t.origin[0], t.origin[1]);
    let g = Grid { n: hf.n, cells: hf.cells, cell: hf.cell, min_x: hf.min_x, min_z: hf.min_z };
    let n = g.n;
    let seed = z.seed as i32;

    // ---------- Coast: how far inland each point is, in metres (negative out at sea) ----------
    let isl = &t.landmass;
    let landness = |x: f64, zz: f64| -> f64 {
        let dx = x - isl.x;
        let dz = zz - isl.z;
        let r = (dx * dx + dz * dz).sqrt();
        let a = dz.js_atan2(dx);
        let mut big_r = isl.radius;
        for &[k, amp, ph] in &isl.lobes {
            big_r += amp * (k * a + ph).js_sin();
        }
        big_r += isl.warp * fbm(x / isl.warp_scale, zz / isl.warp_scale, 3, seed.wrapping_add(11));
        let mut d = big_r - r;
        for h in &t.headlands {
            if h.r <= 0.0 {
                continue;
            }
            let hd = js_hypot(x - h.x, zz - h.z);
            d += h.push * smoothstep(h.r, 0.0, hd);
        }
        for b in &t.bays {
            d = js_min(d, js_hypot(x - b.x, zz - b.z) - b.r + 14.0 * fbm(x / 34.0, zz / 34.0, 2, seed.wrapping_add(17)));
        }
        for i in &t.islets {
            d = js_max(d, i.r - js_hypot(x - i.x, zz - i.z) + 9.0 * fbm(x / 40.0, zz / 40.0, 2, seed.wrapping_add(23)));
        }
        d
    };

    let sh = t.shore;
    let shore_profile = |d: f64| -> f64 {
        if d >= 0.0 {
            return sh.beach_height * smoothstep(0.0, sh.beach, d) + js_max(0.0, d - sh.beach) * sh.inland_rise;
        }
        let out = -d;
        -js_min(sh.max_depth, out * sh.seabed_slope + out * out * sh.seabed_curve)
    };

    let hills = t.hills;
    let mut coast = vec![0f32; n * n];
    {
        let h_ = hf.heights_mut();
        for j in 0..n {
            let zz = g.vz(j);
            for i in 0..n {
                let x = g.vx(i);
                let d = landness(x, zz);
                coast[j * n + i] = d as f32;
                let mut h = shore_profile(d);
                // Sea cliffs: the same coastline, but it rears straight up instead of shelving.
                for c in &t.cliffs {
                    let k = smoothstep(c.r, c.r * 0.45, js_hypot(x - c.x, zz - c.z));
                    if k <= 0.0 {
                        continue;
                    }
                    let cliff = if d >= 0.0 { c.h * smoothstep(0.0, 9.0, d) + js_max(0.0, d - 9.0) * sh.inland_rise } else { -js_min(sh.max_depth, -d * 0.45) };
                    h = lerp(h, cliff, k);
                }
                if d > 0.0 {
                    let k = smoothstep(hills.inland_from, hills.inland_to, d);
                    let near = smoothstep(4.0, 40.0, d);
                    h += (fbm(x / hills.scale, zz / hills.scale, 4, seed.wrapping_add(31)) * 0.5 + 0.5) * hills.height * k;
                    h += fbm(x / hills.detail_scale, zz / hills.detail_scale, 3, seed.wrapping_add(37)) * hills.detail * near;
                } else {
                    h += fbm(x / 60.0, zz / 60.0, 2, seed.wrapping_add(41)) * 1.2;
                }
                h_[j * n + i] = h as f32;
            }
        }
    }

    // ---------- Mountains: flat top, sheer cliff band, walkable skirt ----------
    let mountain_at = |id: &str| t.mountains.iter().find(|m| m.id == id);
    for m in &t.mountains {
        let reach = m.skirt * (1.0 + m.rugged) + 4.0;
        let h_ = hf.heights_mut();
        g.each_vertex_near(m.x, m.z, reach, |i, j, x, zz| {
            let dx = x - m.x;
            let dz = zz - m.z;
            let dm = (dx * dx + dz * dz).sqrt();
            let phi = dz.js_atan2(dx);
            let wobble = 0.55 * (3.0 * phi + 1.1).js_sin()
                + 0.3 * (7.0 * phi + 2.3).js_sin()
                + 0.35 * fbm(phi.js_cos() * 2.2 + 9.0, phi.js_sin() * 2.2, 2, seed.wrapping_add(51));
            let tt = dm / (1.0 + m.rugged * wobble);
            let low_top = m.top * (1.0 - m.cliff_drop);
            let mut cliffness = 0.0;
            let mut mh = if tt <= m.plateau {
                m.top
            } else if tt <= m.cliff {
                let s = smoothstep(m.plateau, m.cliff, tt);
                cliffness = s * (1.0 - s) * 4.0;
                m.top - (m.top - low_top) * s
            } else {
                low_top * (1.0 - smoothstep(m.cliff, m.skirt, tt))
            };
            mh += m.crag * fbm(x / 9.0, zz / 9.0, 3, seed.wrapping_add(57)) * cliffness;
            let k = j * n + i;
            // Only where the mountain actually stands: its zero-height fringe must not fill in the sea.
            if mh > 0.05 && mh > get(h_, k) {
                h_[k] = mh as f32;
            }
        });
    }

    // ---------- Ramps: a ledge path climbing the cliff along its own contour lines ----------
    let mut ramps: Vec<Vec<[f64; 2]>> = Vec::new();
    for r in &t.ramps {
        let Some(m) = mountain_at(&r.mountain) else { continue };
        let steps = js_max(200.0, js_round(r.turns * 900.0));
        struct Pt {
            x: f64,
            z: f64,
            h: f64,
            rho: f64,
        }
        let mut pts: Vec<Pt> = Vec::new();
        let mut s = 0.0;
        while s <= steps {
            let u = s / steps;
            let phi = r.start_angle + r.direction * u * r.turns * TAU;
            let target = lerp(r.from, r.to, u);
            // Where along this bearing the cliff is exactly at the height the path wants to be.
            let mut lo = m.plateau * 0.7;
            let mut hi = m.skirt;
            for _ in 0..30 {
                let mid = (lo + hi) / 2.0;
                let h = hf.height(m.x + phi.js_cos() * mid, m.z + phi.js_sin() * mid);
                if h > target {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            pts.push(Pt { x: 0.0, z: 0.0, h: target, rho: (lo + hi) / 2.0 });
            s += 1.0;
        }
        // The cliff is craggy; the path should not be.
        for _ in 0..3 {
            let rho: Vec<f64> = pts.iter().map(|p| p.rho).collect();
            for s in 0..pts.len() {
                let mut sum = 0.0;
                let mut cnt = 0.0;
                for o in -12i64..=12 {
                    let q = s as i64 + o;
                    if q < 0 || q >= pts.len() as i64 {
                        continue;
                    }
                    sum += rho[q as usize];
                    cnt += 1.0;
                }
                pts[s].rho = sum / cnt;
            }
        }
        for (s, p) in pts.iter_mut().enumerate() {
            let phi = r.start_angle + r.direction * (s as f64 / steps) * r.turns * TAU;
            p.x = m.x + phi.js_cos() * p.rho;
            p.z = m.z + phi.js_sin() * p.rho;
        }
        ramps.push(pts.iter().map(|p| [p.x, p.z]).collect());
        let half = r.width / 2.0;
        let edge = 2.0;
        let h_ = hf.heights_mut();
        g.each_vertex_near(m.x, m.z, m.skirt + 10.0, |i, j, x, zz| {
            let mut best = f64::INFINITY;
            let mut bh = 0.0;
            for p in pts.iter().step_by(2) {
                let d2 = (p.x - x) * (p.x - x) + (p.z - zz) * (p.z - zz);
                if d2 < best {
                    best = d2;
                    bh = p.h;
                }
            }
            let d = best.sqrt();
            if d > half + edge {
                return;
            }
            let w = 1.0 - smoothstep(half, half + edge, d);
            let k = j * n + i;
            h_[k] = lerp(get(h_, k), bh, w) as f32;
        });
    }

    // ---------- Pits (the quarry) ----------
    for p in &t.pits {
        let h_ = hf.heights_mut();
        g.each_vertex_near(p.x, p.z, p.r + 2.0, |i, j, x, zz| {
            let d = js_hypot(x - p.x, zz - p.z);
            let k = j * n + i;
            h_[k] = (get(h_, k) - p.depth * (1.0 - smoothstep(p.r * p.floor, p.r, d))) as f32;
        });
    }

    // ---------- Flattened ground: squares, fields, plots ----------
    let cells = t.cells;
    let mut clear = vec![0u8; cells * cells];
    let mark_clear = |clear: &mut [u8], x: f64, zz: f64| {
        if let Some(c) = g.cell_of(x, zz) {
            clear[c] = 1;
        }
    };
    // Surfaces are painted into this overlay first, then win over the automatic ones at the end.
    let mut painted = vec![-1i16; cells * cells];

    for f in &t.flatten {
        let target = match f.h {
            Level::At(h) => h,
            Level::Auto(_) => hf.height(f.x, f.z),
        };
        let rect_ = match (f.w, f.d) {
            (Some(w), Some(d)) => Some((w, d)),
            _ => None,
        };
        let fr = f.r.unwrap_or(f64::NAN);
        let reach = (match rect_ {
            Some((w, d)) => js_hypot(w / 2.0, d / 2.0),
            None => fr,
        }) + f.fall
            + 2.0;
        let surf_code = f.surface.as_deref().and_then(surface_code);
        let keep_clear = f.keep_clear != Some(false);
        let h_ = hf.heights_mut();
        g.each_vertex_near(f.x, f.z, reach, |i, j, x, zz| {
            let k = j * n + i;
            let dist = match rect_ {
                Some((w, d)) => {
                    let ox = js_max(0.0, (x - f.x).abs() - w / 2.0);
                    let oz = js_max(0.0, (zz - f.z).abs() - d / 2.0);
                    (ox * ox + oz * oz).sqrt()
                }
                None => js_max(0.0, js_hypot(x - f.x, zz - f.z) - fr),
            };
            let fall = match f.sea_fall {
                Some(sf) if coast[k] < 0.0 => sf,
                _ => f.fall,
            };
            let w = 1.0 - smoothstep(0.0, fall, dist);
            if w > 0.0 {
                h_[k] = lerp(get(h_, k), target, w) as f32;
            }
            if dist <= 0.01 && i < cells && j < cells {
                let cx = x + g.cell / 2.0;
                let cz = zz + g.cell / 2.0;
                if keep_clear {
                    mark_clear(&mut clear, cx, cz);
                }
                if let Some(code) = surf_code {
                    let in_surf = rect_.is_some() || js_hypot(cx - f.x, cz - f.z) <= f.surface_r.unwrap_or(fr);
                    if in_surf && let Some(c) = g.cell_of(cx, cz) {
                        painted[c] = i16::from(code);
                    }
                }
            }
        });
    }

    // ---------- Structure pads: each building sits on level ground ----------
    let mut placements: Vec<Placement> = Vec::new();
    let mut buildings: Vec<PlacedBuilding> = Vec::new();
    let mut boxes: Vec<BoxCollider> = Vec::new();
    let mut decks: Vec<Deck> = Vec::new();
    let mut obstacles: Vec<Obstacle> = Vec::new();
    for s in &z.structures {
        let def = structure_def(&s.id);
        let deckish = def.deck.is_some();
        if !deckish && def.pad != Some(false) {
            let pad = hf.height(s.x, s.z);
            let reach = js_hypot(def.w, def.d) / 2.0 + 3.0;
            let h_ = hf.heights_mut();
            g.each_vertex_near(s.x, s.z, reach + 2.0, |i, j, x, zz| {
                let (lx, lz) = to_local(x - s.x, zz - s.z, s.rot);
                let ox = js_max(0.0, lx.abs() - def.w / 2.0 - 0.6);
                let oz = js_max(0.0, lz.abs() - def.d / 2.0 - 0.6);
                let w = 1.0 - smoothstep(0.0, 3.0, (ox * ox + oz * oz).sqrt());
                let k = j * n + i;
                if w > 0.0 {
                    h_[k] = lerp(get(h_, k), pad, w) as f32;
                }
            });
        }
    }

    // ---------- Roads: graded, smoothed, blended into the land ----------
    let mut roads: Vec<Road> = Vec::new();
    let clear_of_road = z.scatter.clear_of_road.unwrap_or(4.0);
    for road in &t.roads {
        if road.points.is_empty() {
            continue;
        }
        let pts = catmull_rom(&road.points, 2.0);
        // Height profile: follow the land, but smoothly, never steeper than a cart can pull.
        let mut prof: Vec<f64> = pts.iter().map(|&[x, zz]| js_max(0.7, hf.height(x, zz))).collect();
        for _ in 0..3 {
            prof = moving_average(&prof, 7);
        }
        let grade = 0.16;
        for k in 1..prof.len() {
            prof[k] = js_max(prof[k - 1] - grade * 2.0, js_min(prof[k - 1] + grade * 2.0, prof[k]));
        }
        for k in (0..prof.len().saturating_sub(1)).rev() {
            prof[k] = js_max(prof[k + 1] - grade * 2.0, js_min(prof[k + 1] + grade * 2.0, prof[k]));
        }
        roads.push(Road { id: road.id.clone(), width: road.width, points: pts.clone() });
        let half = road.width / 2.0;
        let shoulder = 5.0;
        // Bucket the segments so each vertex only looks at the few nearby.
        let bucket = 16.0;
        let key = |bx: f64, bz: f64| (bx + 1000.0) * 4096.0 + (bz + 1000.0);
        let mut buckets: BTreeMap<i64, Vec<usize>> = BTreeMap::new();
        for k in 0..pts.len().saturating_sub(1) {
            let [ax, az] = pts[k];
            let [bx, bz] = pts[k + 1];
            let x0 = ((js_min(ax, bx) - half - shoulder) / bucket).floor();
            let x1 = ((js_max(ax, bx) + half + shoulder) / bucket).floor();
            let z0 = ((js_min(az, bz) - half - shoulder) / bucket).floor();
            let z1 = ((js_max(az, bz) + half + shoulder) / bucket).floor();
            let mut gx = x0;
            while gx <= x1 {
                let mut gz = z0;
                while gz <= z1 {
                    buckets.entry(key(gx, gz) as i64).or_default().push(k);
                    gz += 1.0;
                }
                gx += 1.0;
            }
        }
        let nearest = |x: f64, zz: f64| -> (f64, f64) {
            let mut bd = f64::INFINITY;
            let mut bh = 0.0;
            let Some(list) = buckets.get(&(key((x / bucket).floor(), (zz / bucket).floor()) as i64)) else { return (bd, bh) };
            for &k in list {
                let [ax, az] = pts[k];
                let [bx, bz] = pts[k + 1];
                let ex = bx - ax;
                let ez = bz - az;
                let l2 = or(ex * ex + ez * ez, 1.0);
                // As `u < 0 ? 0 : u > 1 ? 1 : u`, NaN and -0 included.
                let u = (((x - ax) * ex + (zz - az) * ez) / l2).clamp(0.0, 1.0);
                let px = ax + ex * u - x;
                let pz = az + ez * u - zz;
                let d = (px * px + pz * pz).sqrt();
                if d < bd {
                    bd = d;
                    bh = prof[k] + (prof[k + 1] - prof[k]) * u;
                }
            }
            (bd, bh)
        };
        let (mut min_x, mut max_x, mut min_z, mut max_z) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        for &[x, zz] in &pts {
            min_x = js_min(min_x, x);
            max_x = js_max(max_x, x);
            min_z = js_min(min_z, zz);
            max_z = js_max(max_z, zz);
        }
        let pad = half + shoulder + 2.0;
        let last = (n - 1) as f64;
        let i0 = js_max(0.0, ((min_x - pad - g.min_x) / g.cell).floor());
        let i1 = js_min(last, ((max_x + pad - g.min_x) / g.cell).ceil());
        let j0 = js_max(0.0, ((min_z - pad - g.min_z) / g.cell).floor());
        let j1 = js_min(last, ((max_z + pad - g.min_z) / g.cell).ceil());
        if !(i0 <= i1 && j0 <= j1) {
            continue;
        }
        let h_ = hf.heights_mut();
        for j in j0 as usize..=j1 as usize {
            for i in i0 as usize..=i1 as usize {
                let x = g.vx(i);
                let zz = g.vz(j);
                let (nd, nh) = nearest(x, zz);
                if nd > half + shoulder {
                    continue;
                }
                let w = 1.0 - smoothstep(half, half + shoulder, nd);
                let k = j * n + i;
                h_[k] = lerp(get(h_, k), nh, w) as f32;
                if i < cells && j < cells {
                    let (cd, _) = nearest(x + g.cell / 2.0, zz + g.cell / 2.0);
                    let c = j * cells + i;
                    if cd <= half && painted[c] != i16::from(surface::PLAZA) {
                        painted[c] = i16::from(surface::ROAD);
                    }
                    if cd <= half + clear_of_road {
                        clear[c] = 1;
                    }
                }
            }
        }
    }

    // ---------- Surfaces ----------
    for j in 0..cells {
        for i in 0..cells {
            let c = j * cells + i;
            let x = g.vx(i) + g.cell / 2.0;
            let zz = g.vz(j) + g.cell / 2.0;
            if painted[c] >= 0 {
                hf.surface[c] = painted[c] as u8;
                continue;
            }
            let h = hf.height(x, zz);
            let slope = hf.slope(x, zz);
            let mut s = surface::GRASS;
            for f in &z.forests {
                if js_hypot(x - f.x, zz - f.z) < f.r * 0.85 {
                    s = surface::FOREST;
                }
            }
            if h < t.sand_below && f64::from(coast[j * n + i]) < 70.0 {
                s = surface::SAND;
            }
            if slope > t.rock_slope {
                s = surface::ROCK;
            }
            hf.surface[c] = s;
        }
    }

    // ---------- Buildings: colliders, decks, and what to draw where ----------
    let clear_of_structure = z.scatter.clear_of_structure.unwrap_or(4.0);
    for s in &z.structures {
        let def = structure_def(&s.id);
        let y = if def.sea_level == Some(true) { t.water } else { hf.height(s.x, s.z) };
        placements.push(Placement {
            kind: PlacementKind::Structure,
            id: s.id.clone(),
            x: s.x,
            y,
            z: s.z,
            rot: s.rot,
            tint: s.tint,
            seed: s.seed,
            decor: s.decor.clone(),
            mirror: s.mirror,
        });
        let mirror = s.mirror == Some(true);
        let plan = if def.collider == "building" { placed_plan(&s.id, mirror) } else { None };
        if let Some(plan) = plan {
            let solid = building_colliders(&plan, s.x, s.z, s.rot, y);
            let first = boxes.len();
            boxes.extend_from_slice(&solid.boxes);
            decks.extend_from_slice(&solid.decks);
            obstacles.extend_from_slice(&solid.obstacles);
            buildings.push(PlacedBuilding { id: s.id.clone(), mirror, x: s.x, y, z: s.z, rot: s.rot, boxes: [first, boxes.len()] });
        } else {
            add_collider(def, s.x, s.z, s.rot, y, &mut boxes, &mut obstacles);
        }
        if let Some(deck) = def.deck {
            decks.push(rect(s.x, s.z, def.w / 2.0, def.d / 2.0, s.rot, y + deck));
        }
        // Keep trees out of the way of everything built.
        let margin = def.clear_margin.unwrap_or(clear_of_structure);
        g.cells_in_rect(s.x, s.z, def.w / 2.0 + margin, def.d / 2.0 + margin, s.rot, |cx, cz| mark_clear(&mut clear, cx, cz));
        // Some say what the ground under them is (tilled soil under a farm plot).
        if let Some(ground) = def.surface.as_deref().and_then(surface_code) {
            g.cells_in_rect(s.x, s.z, def.w / 2.0, def.d / 2.0, s.rot, |cx, cz| {
                if let Some(c) = g.cell_of(cx, cz) {
                    hf.surface[c] = ground;
                }
            });
        }
    }
    for p in &z.house_plots {
        g.cells_in_rect(p.x, p.z, 9.0, 9.0, p.rot, |cx, cz| mark_clear(&mut clear, cx, cz));
    }
    for nd in &z.nodes {
        let def = structure_def(&nd.kind);
        let y = hf.height(nd.x, nd.z);
        placements.push(Placement {
            kind: PlacementKind::Node,
            id: nd.kind.clone(),
            x: nd.x,
            y,
            z: nd.z,
            rot: nd.rot,
            tint: None,
            seed: None,
            decor: None,
            mirror: None,
        });
        add_collider(def, nd.x, nd.z, nd.rot, y, &mut boxes, &mut obstacles);
        g.cells_in_rect(nd.x, nd.z, def.w / 2.0 + 2.0, def.d / 2.0 + 2.0, nd.rot, |cx, cz| mark_clear(&mut clear, cx, cz));
    }
    for npc in &z.npcs {
        g.cells_in_rect(npc.x, npc.z, 2.5, 2.5, 0.0, |cx, cz| mark_clear(&mut clear, cx, cz));
    }
    g.cells_in_rect(z.spawn.x, z.spawn.z, 4.0, 4.0, 0.0, |cx, cz| mark_clear(&mut clear, cx, cz));
    for u in &z.updrafts {
        g.cells_in_rect(u.x, u.z, u.r, u.r, 0.0, |cx, cz| mark_clear(&mut clear, cx, cz));
    }

    // Props: placed one by one, in rings, along roads, or along fence lines.
    for p in &z.props {
        let def = prop_def(&p.id);
        let mut put = |x: f64, zz: f64, rot: f64| {
            let y = hf.height(x, zz);
            placements.push(Placement { kind: PlacementKind::Prop, id: p.id.clone(), x, y, z: zz, rot, tint: None, seed: None, decor: None, mirror: None });
            if def.collider == "post" {
                obstacles.push(Obstacle { kind: ObstacleKind::Post, x, z: zz, r: def.r.unwrap_or(0.2), scale: 1.0, rot });
            } else if def.collider == "box" {
                boxes.push(rect(x, zz, def.w / 2.0, def.d / 2.0, rot, y + def.h));
            }
            mark_clear(&mut clear, x, zz);
        };
        if let Some(ring) = p.ring {
            let mut k = 0.0;
            while k < ring.count {
                let a = ring.phase + (k / ring.count) * TAU;
                put(ring.x + a.js_cos() * ring.r, ring.z + a.js_sin() * ring.r, -a);
                k += 1.0;
            }
        } else if let Some(along) = p.along.as_deref().filter(|a| !a.is_empty()) {
            let Some(road) = roads.iter().find(|r| r.id == along) else { continue };
            let every = p.every.unwrap_or(f64::NAN);
            let mut acc = every / 2.0;
            let mut side = 1.0;
            for k in 1..road.points.len() {
                let [ax, az] = road.points[k - 1];
                let [bx, bz] = road.points[k];
                let seg = js_hypot(bx - ax, bz - az);
                acc += seg;
                if acc < every {
                    continue;
                }
                acc = 0.0;
                let nx = -(bz - az) / or(seg, 1.0);
                let nz = (bx - ax) / or(seg, 1.0);
                let off = road.width / 2.0 + 1.2;
                put(bx + nx * off * side, bz + nz * off * side, (bx - ax).js_atan2(bz - az));
                side = -side;
            }
        } else if let Some([[ax, az], [bx, bz]]) = p.line {
            let len = js_hypot(bx - ax, bz - az);
            let count = js_max(1.0, js_round(len / def.w));
            let rot = (bx - ax).js_atan2(bz - az) + FRAC_PI_2;
            let mut k = 0.0;
            while k < count {
                let u = (k + 0.5) / count;
                put(ax + (bx - ax) * u, az + (bz - az) * u, rot);
                k += 1.0;
            }
        } else {
            put(p.x.unwrap_or(f64::NAN), p.z.unwrap_or(f64::NAN), p.rot.unwrap_or(0.0));
        }
    }

    // ---------- Trees and rocks ----------
    let mut rng = Rng::new((z.seed).wrapping_add(101));
    let big_g = 7.0;
    let span = hf.size();
    let across = (span / big_g).floor() as usize;
    for gj in 0..across {
        for gi in 0..across {
            let x = g.min_x + (gi as f64 + rng.next_f64()) * big_g;
            let zz = g.min_z + (gj as f64 + rng.next_f64()) * big_g;
            let roll = rng.next_f64();
            let scale = 0.8 + (1.45 - 0.8) * rng.next_f64();
            let rot = rng.next_f64() * TAU;
            let h = hf.height(x, zz);
            if h < 1.6 {
                continue;
            }
            let Some(c) = g.cell_of(x, zz) else { continue };
            if clear[c] != 0 {
                continue;
            }
            let s = hf.surface[c];
            let slope = hf.slope(x, zz);
            let mut density = z.scatter.trees;
            for f in &z.forests {
                density += f.density * smoothstep(f.r, f.r * 0.35, js_hypot(x - f.x, zz - f.z));
            }
            if (s == surface::GRASS || s == surface::FOREST) && slope < 0.75 && roll < density * big_g * big_g {
                obstacles.push(Obstacle { kind: ObstacleKind::Tree, x, z: zz, r: 0.45 * scale, scale, rot });
                continue;
            }
            let rock_chance = if s == surface::ROCK {
                0.09
            } else if s == surface::SAND {
                0.004
            } else {
                z.scatter.rocks * big_g * big_g
            };
            if s != surface::ROAD && s != surface::PLAZA && s != surface::SOIL && rng.next_f64() < rock_chance {
                let rs = (0.5 + (1.5 - 0.5) * rng.next_f64()) * (if s == surface::ROCK { 1.6 } else { 1.0 });
                obstacles.push(Obstacle { kind: ObstacleKind::Rock, x, z: zz, r: 0.55 * rs, scale: rs, rot });
            }
        }
    }

    // ---------- Waterfalls: a slot cut down the face for the water to fall free ----------
    // Cut last, so every tree and rock elsewhere stands where it always did (they're scattered from
    // one stream of random numbers, cell by cell): only what stood in the slot or a pool goes.
    let mut falls: Vec<WaterfallInfo> = Vec::new();
    for f in &t.falls {
        let Some(m) = mountain_at(&f.mountain) else { continue };
        let ux = f.bearing.js_cos();
        let uz = f.bearing.js_sin();
        let vx = -uz;
        let vz = ux;
        let along = |x: f64, zz: f64| (x - m.x) * ux + (zz - m.z) * uz;
        let across = |x: f64, zz: f64| (x - m.x) * vx + (zz - m.z) * vz;
        let half = f.width / 2.0;
        let shelf_end = f.lip + f.shelf.depth;
        let floor_at = |s: f64| lerp(f.floor[0], f.floor[1], js_min(1.0, js_max(0.0, (s - shelf_end) / (f.foot - shelf_end))));
        let sx = m.x + ux * f.spring.at;
        let sz = m.z + uz * f.spring.at;
        let spring_level = hf.height(sx, sz) - 0.06;
        let lip_y = spring_level;
        let px = m.x + ux * f.plunge.at;
        let pz = m.z + uz * f.plunge.at;
        // A little under the floor at the pool's lowest edge (the floor falls toward the foot).
        let plunge_level = floor_at(f.plunge.at + f.plunge.along) - 0.1;
        let in_plunge = |x: f64, zz: f64| js_hypot((along(x, zz) - f.plunge.at) / f.plunge.along, across(x, zz) / f.plunge.across);
        {
            let h_ = hf.heights_mut();
            g.each_vertex_near(m.x, m.z, f.foot + 12.0, |i, j, x, zz| {
                let k = j * n + i;
                let s = along(x, zz);
                let tt = across(x, zz).abs();
                // The spring: a shallow basin, its water just below the summit, and a runnel to the lip.
                let ds = js_hypot(x - sx, zz - sz);
                if ds < f.spring.r + 1.0 {
                    h_[k] = js_min(get(h_, k), spring_level - f.spring.depth * (1.0 - smoothstep(f.spring.r * 0.55, f.spring.r, ds))) as f32;
                }
                if s > f.spring.at && s < f.lip + 0.5 && tt < RUNNEL {
                    h_[k] = js_min(get(h_, k), spring_level - 0.16) as f32;
                }
                // The slot: sheer at the back, the ledge, then down to its floor; its walls blend into the face.
                if s >= f.lip && s <= f.foot + 2.0 && tt <= half + f.blend {
                    let w = (1.0 - smoothstep(half, half + f.blend, tt)) * (1.0 - smoothstep(f.foot - 1.0, f.foot + 2.0, s));
                    let target = if s <= shelf_end { f.shelf.top } else { floor_at(s) };
                    if w > 0.0 && target < get(h_, k) {
                        h_[k] = lerp(get(h_, k), target, w) as f32;
                    }
                }
                // The plunge pool, in the slot's floor.
                let e = in_plunge(x, zz);
                if e < 1.15 {
                    h_[k] = js_min(get(h_, k), plunge_level - f.plunge.depth * (1.0 - smoothstep(0.6, 1.0, e))) as f32;
                }
            });
        }
        // Nothing grows, stands or lies about in the slot or the pools; their ground is bare.
        let in_slot = |x: f64, zz: f64, pad: f64| {
            let s = along(x, zz);
            s >= f.lip - pad && s <= f.foot + 2.0 + pad && across(x, zz).abs() <= half + f.blend + pad
        };
        for j in 0..cells {
            for i in 0..cells {
                let x = g.vx(i) + g.cell / 2.0;
                let zz = g.vz(j) + g.cell / 2.0;
                if (x - m.x).abs() > f.foot + 14.0 || (zz - m.z).abs() > f.foot + 14.0 {
                    continue;
                }
                let c = j * cells + i;
                let spring =
                    js_hypot(x - sx, zz - sz) < f.spring.r + 0.8 || (along(x, zz) > f.spring.at && along(x, zz) < f.lip + 0.5 && across(x, zz).abs() < RUNNEL);
                let plunge = in_plunge(x, zz) < 1.1;
                if spring || plunge {
                    clear[c] = 1;
                    hf.surface[c] = surface::SAND;
                } else if in_slot(x, zz, 0.5) {
                    clear[c] = 1;
                    hf.surface[c] = surface::ROCK;
                }
            }
        }
        obstacles.retain(|o| !(in_slot(o.x, o.z, 1.5) || js_hypot(o.x - sx, o.z - sz) < f.spring.r + 1.5 || in_plunge(o.x, o.z) < 1.3));
        // The hood over the ledge: solid on top, open underneath for whoever glides in under it. Below
        // it, the landing stage (a deck you glide down onto) and the totem (a post).
        let turn = FRAC_PI_2 - f.bearing;
        let at = |s: f64, tt: f64| (m.x + ux * s + vx * tt, m.z + uz * s + vz * tt);
        let roof_top = f.shelf.top + f.roof.above;
        let r0 = f.lip - 0.5;
        let r1 = f.lip + f.roof.depth;
        let (hx, hz) = at((r0 + r1) / 2.0, 0.0);
        decks.push(rect(hx, hz, half, (r1 - r0) / 2.0, turn, roof_top));
        let landing = f.landing.map(|l| {
            let (l0, l1, top) = (f.lip + l.from, f.lip + l.to, f.shelf.top + l.above);
            let (lx, lz) = at((l0 + l1) / 2.0, 0.0);
            decks.push(rect(lx, lz, l.half, (l1 - l0) / 2.0, turn, top));
            LandingInfo { s0: l0, s1: l1, half: l.half, top }
        });
        let totem = f.totem.map(|t| {
            let top = f.shelf.top + t.above;
            let (tx, tz) = at(f.lip + t.at, t.across);
            boxes.push(rect(tx, tz, 0.35, 0.35, turn, top));
            TotemInfo { s: f.lip + t.at, t: t.across, top }
        });
        // The ledge's walls run out to the landing stage's end, or without one the shelf's.
        let l1 = landing.map_or(shelf_end, |l| l.s1);
        // The ledge's walls, as clean as the hood over them: the ground's cut is a slope a cell wide
        // (two metres), which whoever hits the back wall would otherwise slide down and off the side.
        let (bx, bz) = at(f.lip + 1.0, 0.0);
        boxes.push(rect(bx, bz, half + 1.2, 1.6, turn, roof_top));
        for side in [-1.0, 1.0] {
            let (wx, wz) = at((f.lip - 1.0 + l1) / 2.0, side * (half + 0.9));
            boxes.push(rect(wx, wz, 1.2, (l1 - f.lip + 1.0) / 2.0, turn, roof_top));
        }
        falls.push(WaterfallInfo {
            id: f.id.clone(),
            cx: m.x,
            cz: m.z,
            ux,
            uz,
            vx,
            vz,
            lip: f.lip,
            lip_y,
            foot: f.foot,
            width: f.width,
            speed: f.speed,
            shelf: Span { s0: f.lip, s1: shelf_end, top: f.shelf.top },
            roof: Span { s0: r0, s1: r1, top: roof_top },
            landing,
            totem,
            floor: f.floor,
            spring: SpringInfo { x: sx, z: sz, at: f.spring.at, r: f.spring.r, level: spring_level },
            plunge: PlungeInfo { x: px, z: pz, s: f.plunge.at, along: f.plunge.along, across: f.plunge.across, level: plunge_level },
            runnel: RUNNEL,
        });
    }

    Generated { terrain: hf, obstacles, boxes, decks, roads, ramps, clear, placements, falls, buildings }
}

/// A structure's own solid parts: a box (maybe shallower than its footprint), a post, or walls with a door gap at the front.
fn add_collider(def: &StructureDef, x: f64, z: f64, rot: f64, y: f64, boxes: &mut Vec<BoxCollider>, obstacles: &mut Vec<Obstacle>) {
    match def.collider.as_str() {
        "box" => {
            let d = def.collider_d.unwrap_or(def.d);
            let (ox, oz) = to_world(0.0, def.collider_z.unwrap_or(0.0), rot);
            boxes.push(rect(x + ox, z + oz, def.w / 2.0, d / 2.0, rot, y + def.h));
        }
        "post" => obstacles.push(Obstacle { kind: ObstacleKind::Post, x, z, r: def.r.unwrap_or(0.5), scale: 1.0, rot }),
        "walls" => {
            let t = def.wall.unwrap_or(0.3);
            let hw = def.w / 2.0;
            let hd = def.d / 2.0;
            let door = def.door.unwrap_or(1.4) / 2.0;
            let top = y + def.h;
            let mut add = |lx: f64, lz: f64, w: f64, d: f64| {
                let (ox, oz) = to_world(lx, lz, rot);
                boxes.push(rect(x + ox, z + oz, w / 2.0, d / 2.0, rot, top));
            };
            add(0.0, -hd + t / 2.0, def.w, t); // back
            add(hw - t / 2.0, 0.0, t, def.d); // left side (+X)
            add(-hw + t / 2.0, 0.0, t, def.d); // right side (-X)
            let seg = hw - door;
            add(door + seg / 2.0, hd - t / 2.0, seg, t); // front, either side of the door
            add(-door - seg / 2.0, hd - t / 2.0, seg, t);
        }
        _ => {}
    }
}

/// Centripetal-ish Catmull-Rom through the control points, resampled about every `step` metres.
fn catmull_rom(points: &[[f64; 2]], step: f64) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    let last = points[points.len() - 1];
    let mut p = Vec::with_capacity(points.len() + 2);
    p.push(points[0]);
    p.extend_from_slice(points);
    p.push(last);
    for k in 1..p.len().saturating_sub(2) {
        let [x0, z0] = p[k - 1];
        let [x1, z1] = p[k];
        let [x2, z2] = p[k + 1];
        let [x3, z3] = p[k + 2];
        let len = js_hypot(x2 - x1, z2 - z1);
        let n = js_max(1.0, (len / step).ceil());
        let mut s = 0.0;
        while s < n {
            let u = s / n;
            let u2 = u * u;
            let u3 = u2 * u;
            let x = 0.5 * (2.0 * x1 + (-x0 + x2) * u + (2.0 * x0 - 5.0 * x1 + 4.0 * x2 - x3) * u2 + (-x0 + 3.0 * x1 - 3.0 * x2 + x3) * u3);
            let z = 0.5 * (2.0 * z1 + (-z0 + z2) * u + (2.0 * z0 - 5.0 * z1 + 4.0 * z2 - z3) * u2 + (-z0 + 3.0 * z1 - 3.0 * z2 + z3) * u3);
            out.push([x, z]);
            s += 1.0;
        }
    }
    out.push(last);
    out
}

fn moving_average(v: &[f64], half: i64) -> Vec<f64> {
    (0..v.len())
        .map(|k| {
            let mut s = 0.0;
            let mut c = 0.0;
            for o in -half..=half {
                let q = k as i64 + o;
                if q < 0 || q >= v.len() as i64 {
                    continue;
                }
                s += v[q as usize];
                c += 1.0;
            }
            s / c
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open::zone::emberholm_recipe;

    #[test]
    fn emberholm_grows_whole() {
        // tests/conformance/terrain.test.ts holds all of it to the WebAssembly's; here, that it
        // grows at all: land at the spawn, trees and rocks, buildings with their walls, a road.
        let g = generate(&emberholm_recipe());
        let s = emberholm_recipe().spawn;
        assert!(g.terrain.height(s.x, s.z) > g.terrain.water, "the spawn is on dry land");
        assert!(g.obstacles.len() > 1000, "trees and rocks");
        assert!(!g.buildings.is_empty() && g.buildings.iter().all(|b| b.boxes[1] > b.boxes[0]), "buildings with walls");
        assert!(!g.roads.is_empty() && !g.falls.is_empty() && !g.placements.is_empty());
    }

    #[test]
    fn a_waterfall_s_landing_stage_and_totem_are_where_it_has_them() {
        let whole = generate(&emberholm_recipe());
        let mut bare = emberholm_recipe();
        for f in &mut bare.terrain.falls {
            f.landing = None;
            f.totem = None;
        }
        let g = generate(&bare);
        let n = whole.falls.len();
        assert!(n > 0 && whole.falls.iter().all(|f| f.landing.is_some() && f.totem.is_some()));
        assert!(g.falls.iter().all(|f| f.landing.is_none() && f.totem.is_none()));
        // A deck and a box fewer for each: the stage and the post, and nothing else of the ledge.
        assert_eq!(g.decks.len(), whole.decks.len() - n);
        assert_eq!(g.boxes.len(), whole.boxes.len() - n);
        assert_eq!(g.terrain.heights(), whole.terrain.heights(), "the ground is cut the same");
    }
}
