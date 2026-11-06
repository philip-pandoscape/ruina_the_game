//! Buildings you can walk into: their plans (shared/buildings.json, built from content/buildings/
//! and content/furniture/, as src/content/buildings.ts reads them) and what's solid about one where
//! the island places it:
//!   - its outer walls, as boxes broken at each doorway and arch;
//!   - a wall upstairs over a ground-floor doorway, as a deck you meet upstairs but walk under below;
//!   - each upper floor as decks, less the stairwells;
//!   - each stair tread as a deck a step higher than the last, with the space under the high end
//!     filled (a deck just under head height: solid from the floor, beneath the treads above it);
//!   - a rail round a stairwell's open edges;
//!   - furniture: boxes and posts on the ground floor, decks upstairs (so you walk under them below);
//!   - a roof over it all, halfway up the slope, for anyone coming down from above.
//!
//! A plan's frame: origin at the middle of its footprint on the ground, front to +Z, +X to the right
//! as you face the front from outside. Each wall is a string of 2 m modules read left to right from
//! outside ('D' and 'O' doors, 'A' an open arch and '_' nothing at all let you through).

use std::collections::BTreeMap;
use std::f64::consts::{FRAC_PI_2, PI};
use std::sync::OnceLock;

use serde::Deserialize;

use super::zone::{BoxCollider, Deck, Obstacle, ObstacleKind, rect};
use crate::jsmath::{JsMath, js_max, js_min};

/// Metres per storey (the kit's walls are 3 m high).
pub const STOREY: f64 = 3.0;
/// Metres per module along a wall.
pub const MODULE: f64 = 2.0;
/// How far the walls reach in from the footprint's edge, as the rules see them.
pub const WALL: f64 = 0.3;
/// Half the width of a doorway in a door module, and of the opening in an arch.
const DOOR_HALF: f64 = 0.65;
const ARCH_HALF: f64 = 0.82;
/// The kit's stair: 14 treads climbing a storey over 4.33 m, 1.64 m wide, its well 4 m long.
const STAIR_TREADS: u32 = 14;
const STAIR_RUN: f64 = 4.33;
const STAIR_HALF_WIDTH: f64 = 0.82;
const STAIR_LENGTH: f64 = 4.0;
/// Head height, less a little: a deck this far over a floor stops you, and you walk under anything higher.
const HEAD: f64 = 1.9;

#[derive(Deserialize, Clone, Debug)]
pub struct StoreyPlan {
    pub front: String,
    pub back: String,
    pub left: String,
    pub right: String,
}

/// A flight of stairs up from `storey` to the one above: its foot at (x, z), turned so it climbs toward -Z by `rot`.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct StairPlan {
    pub storey: f64,
    pub x: f64,
    pub z: f64,
    pub rot: f64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct RoofPlan {
    /// Which way the ridge runs: "x" or "z".
    pub ridge: String,
}

/// A piece of furniture set down in a plan, on a storey, `y` above its floor.
#[derive(Deserialize, Clone, Debug)]
pub struct ItemPlan {
    pub id: String,
    pub x: f64,
    pub z: f64,
    pub rot: Option<f64>,
    pub storey: Option<f64>,
    pub y: Option<f64>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct BuildingPlan {
    pub id: String,
    pub w: f64,
    pub d: f64,
    pub storeys: Vec<StoreyPlan>,
    pub roof: RoofPlan,
    #[serde(default)]
    pub stairs: Vec<StairPlan>,
    #[serde(default)]
    pub items: Vec<ItemPlan>,
}

/// A piece of furniture as the rules see it: its footprint and height, and how it blocks you
/// ("box", "post" of radius `r`, or "none").
#[derive(Deserialize, Clone, Debug)]
pub struct FurnitureDef {
    pub w: f64,
    pub d: f64,
    pub h: f64,
    pub collider: String,
    pub r: Option<f64>,
}

#[derive(Deserialize)]
struct BuildingsFile {
    furniture: BTreeMap<String, FurnitureDef>,
    plans: Vec<BuildingPlan>,
}

fn file() -> &'static BuildingsFile {
    static F: OnceLock<BuildingsFile> = OnceLock::new();
    F.get_or_init(|| {
        serde_json::from_str(crate::bundles::bundle("buildings.json", include_str!("../../../../shared/buildings.json")))
            .unwrap_or_else(|e| panic!("shared/buildings.json doesn't match crates/engine/src/open/buildings.rs: {e}"))
    })
}

/// The plan of the building whose structure has this id, if it has one.
pub fn building_plan(id: &str) -> Option<&'static BuildingPlan> {
    file().plans.iter().find(|p| p.id == id)
}

/// A piece of furniture, or nothing solid (no collider) for one that doesn't exist.
fn furniture_def(id: &str) -> &'static FurnitureDef {
    static NONE: FurnitureDef = FurnitureDef { w: 0.0, d: 0.0, h: 0.0, collider: String::new(), r: None };
    file().furniture.get(id).unwrap_or(&NONE)
}

/// The modules of one wall, spaces dropped.
fn modules(s: &str) -> Vec<char> {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

#[derive(Clone, Copy, PartialEq)]
enum Side {
    Front,
    Right,
    Back,
    Left,
}

const SIDES: [Side; 4] = [Side::Front, Side::Right, Side::Back, Side::Left];

fn wall(storey: &StoreyPlan, side: Side) -> &str {
    match side {
        Side::Front => &storey.front,
        Side::Right => &storey.right,
        Side::Back => &storey.back,
        Side::Left => &storey.left,
    }
}

/// How many modules a side holds.
fn side_length(plan: &BuildingPlan, side: Side) -> f64 {
    (if side == Side::Front || side == Side::Back { plan.w } else { plan.d }) / MODULE
}

/// A point in a plan's frame turned by `rot` (as three.js turns about Y, and as the zone's to_world does).
pub fn turn(x: f64, z: f64, rot: f64) -> (f64, f64) {
    let c = rot.js_cos();
    let s = rot.js_sin();
    (x * c + z * s, -x * s + z * c)
}

/// Which openings let you through, with how wide: doorways and arches, and open sides.
fn opening(ch: char) -> Option<f64> {
    match ch {
        'D' | 'O' => Some(DOOR_HALF),
        'A' => Some(ARCH_HALF),
        '_' => Some(MODULE / 2.0),
        _ => None,
    }
}

struct Tread {
    x: f64,
    z: f64,
    hw: f64,
    hd: f64,
    rot: f64,
    top: f64,
}

/// The treads of a flight, in the plan's frame, each with the height of its top above the storey's floor.
fn stair_treads(st: &StairPlan) -> Vec<Tread> {
    let step = STAIR_RUN / f64::from(STAIR_TREADS);
    (0..STAIR_TREADS)
        .map(|k| {
            let k = f64::from(k);
            let (ox, oz) = turn(0.0, -(k + 0.5) * step, st.rot);
            Tread { x: st.x + ox, z: st.z + oz, hw: STAIR_HALF_WIDTH, hd: step / 2.0, rot: st.rot, top: ((k + 1.0) * STOREY) / f64::from(STAIR_TREADS) }
        })
        .collect()
}

struct Well {
    x: f64,
    z: f64,
    hw: f64,
    hd: f64,
    rot: f64,
}

/// The stairwell a flight cuts in the floor above: a module wide, the stair's length long, from its foot.
fn stairwell(st: &StairPlan) -> Well {
    let (ox, oz) = turn(0.0, -STAIR_LENGTH / 2.0, st.rot);
    Well { x: st.x + ox, z: st.z + oz, hw: MODULE / 2.0, hd: STAIR_LENGTH / 2.0, rot: st.rot }
}

/// The plan seen in a mirror (left and right swapped): for a second house that isn't the first one's twin.
pub fn mirror_plan(plan: &BuildingPlan) -> BuildingPlan {
    let rev = |s: &str| modules(s).into_iter().rev().collect::<String>();
    BuildingPlan {
        id: plan.id.clone(),
        w: plan.w,
        d: plan.d,
        storeys: plan.storeys.iter().map(|s| StoreyPlan { front: rev(&s.front), back: rev(&s.back), left: rev(&s.right), right: rev(&s.left) }).collect(),
        roof: plan.roof.clone(),
        stairs: plan.stairs.iter().map(|s| StairPlan { x: -s.x, rot: -s.rot, ..*s }).collect(),
        items: plan.items.iter().map(|it| ItemPlan { x: -it.x, rot: Some(-it.rot.unwrap_or(0.0)), ..it.clone() }).collect(),
    }
}

/// The plan for a structure placed in a zone (mirrored if the placement asks).
pub fn placed_plan(id: &str, mirror: bool) -> Option<BuildingPlan> {
    building_plan(id).map(|p| if mirror { mirror_plan(p) } else { p.clone() })
}

/// Where each side's middle is on the footprint's edge, and its turn (along it is +x, outward +z).
fn side_frame(plan: &BuildingPlan, side: Side) -> (f64, f64, f64) {
    match side {
        Side::Front => (0.0, plan.d / 2.0, 0.0),
        Side::Right => (plan.w / 2.0, 0.0, FRAC_PI_2),
        Side::Back => (0.0, -plan.d / 2.0, PI),
        Side::Left => (-plan.w / 2.0, 0.0, -FRAC_PI_2),
    }
}

/// The stretches of a side (metres from its left end, seen from outside) that are wall rather than opening.
fn solid_spans(row: &[char]) -> Vec<(f64, f64)> {
    let cuts: Vec<(f64, f64)> = row
        .iter()
        .enumerate()
        .filter_map(|(i, &ch)| opening(ch).map(|h| (i as f64 * MODULE + MODULE / 2.0 - h, i as f64 * MODULE + MODULE / 2.0 + h)))
        .collect();
    let mut spans = Vec::new();
    let mut at = 0.0;
    for (a, b) in cuts {
        if a > at + 1e-6 {
            spans.push((at, a));
        }
        at = js_max(at, b);
    }
    let end = row.len() as f64 * MODULE;
    if end > at + 1e-6 {
        spans.push((at, end));
    }
    spans
}

/// Spans in `a` not covered by any span in `b`.
fn minus(a: Vec<(f64, f64)>, b: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut out = a;
    for &(c0, c1) in b {
        let mut next = Vec::new();
        for (s0, s1) in out {
            if c1 <= s0 || c0 >= s1 {
                next.push((s0, s1));
            } else {
                if c0 > s0 + 1e-6 {
                    next.push((s0, c0));
                }
                if c1 < s1 - 1e-6 {
                    next.push((c1, s1));
                }
            }
        }
        out = next;
    }
    out
}

/// The floor of a storey as few rectangles as its tiles allow (rows merged, then equal rows stacked):
/// (x, z, hw, hd) in the plan's frame.
fn floor_rects(plan: &BuildingPlan, storey: f64) -> Vec<(f64, f64, f64, f64)> {
    let nx = plan.w / MODULE;
    let nz = plan.d / MODULE;
    let holes: Vec<Well> = plan.stairs.iter().filter(|s| s.storey == storey - 1.0).map(stairwell).collect();
    let solid = |i: f64, j: f64| {
        let x = -plan.w / 2.0 + MODULE / 2.0 + i * MODULE;
        let z = -plan.d / 2.0 + MODULE / 2.0 + j * MODULE;
        !holes.iter().any(|h| {
            let (lx, lz) = turn(x - h.x, z - h.z, -h.rot);
            lx.abs() < h.hw - 0.01 && lz.abs() < h.hd - 0.01
        })
    };
    let mut rows: Vec<Vec<(f64, f64)>> = Vec::new();
    let mut j = 0.0;
    while j < nz {
        let mut runs = Vec::new();
        let mut start = -1.0;
        let mut i = 0.0;
        while i <= nx {
            let on = i < nx && solid(i, j);
            if on && start < 0.0 {
                start = i;
            }
            if !on && start >= 0.0 {
                runs.push((start, i));
                start = -1.0;
            }
            i += 1.0;
        }
        rows.push(runs);
        j += 1.0;
    }
    let mut out = Vec::new();
    let mut used: Vec<Vec<bool>> = rows.iter().map(|r| vec![false; r.len()]).collect();
    for j in 0..rows.len() {
        for k in 0..rows[j].len() {
            if used[j][k] {
                continue;
            }
            let (a, b) = rows[j][k];
            let mut j1 = j;
            while j1 + 1 < rows.len() {
                let Some(m) = rows[j1 + 1].iter().enumerate().position(|(kk, &(c, d))| c == a && d == b && !used[j1 + 1][kk]) else {
                    break;
                };
                used[j1 + 1][m] = true;
                j1 += 1;
            }
            out.push((
                -plan.w / 2.0 + ((a + b) / 2.0) * MODULE,
                -plan.d / 2.0 + ((j as f64 + j1 as f64 + 1.0) / 2.0) * MODULE,
                ((b - a) / 2.0) * MODULE,
                ((j1 as f64 + 1.0 - j as f64) / 2.0) * MODULE,
            ));
        }
    }
    out
}

/// The roof's span (across the ridge).
fn roof_span(plan: &BuildingPlan) -> f64 {
    if plan.roof.ridge == "z" { plan.w } else { plan.d }
}

/// How far the kit's roofs rise over their walls, by span.
fn roof_rise(span: f64) -> f64 {
    if span == 4.0 {
        3.73
    } else if span == 6.0 {
        4.89
    } else if span == 8.0 {
        6.0
    } else {
        4.0
    }
}

/// Everything solid about a building.
#[derive(Default)]
pub struct BuildingColliders {
    pub boxes: Vec<BoxCollider>,
    pub decks: Vec<Deck>,
    pub obstacles: Vec<Obstacle>,
}

/// Everything solid about a building placed at (x, z), turned `rot`, standing on ground at y.
pub fn building_colliders(plan: &BuildingPlan, x: f64, z: f64, rot: f64, y: f64) -> BuildingColliders {
    let mut out = BuildingColliders::default();
    let storeys = plan.storeys.len();
    let top = y + storeys as f64 * STOREY + 0.12;
    // A rectangle in the plan's frame, out into the world.
    let place = |lx: f64, lz: f64, hw: f64, hd: f64, lrot: f64, t: f64| {
        let (ox, oz) = turn(lx, lz, rot);
        rect(x + ox, z + oz, hw, hd, rot + lrot, t)
    };

    for side in SIDES {
        let (fx, fz, frot) = side_frame(plan, side);
        let len = side_length(plan, side) * MODULE;
        // A span along this side as a slab inside its edge.
        let slab = |(a, b): (f64, f64), t: f64| {
            let (ox, oz) = turn((a + b) / 2.0 - len / 2.0, -WALL / 2.0, frot);
            place(fx + ox, fz + oz, (b - a) / 2.0, WALL / 2.0, frot, t)
        };
        let ground = solid_spans(&modules(wall(&plan.storeys[0], side)));
        for &span in &ground {
            out.boxes.push(slab(span, top));
        }
        // Upstairs, wall where the ground floor has a doorway: solid up there, open below.
        for s in 1..storeys {
            for span in minus(solid_spans(&modules(wall(&plan.storeys[s], side))), &ground) {
                out.decks.push(slab(span, y + s as f64 * STOREY + HEAD));
            }
        }
    }

    for s in 1..storeys {
        for (rx, rz, hw, hd) in floor_rects(plan, s as f64) {
            out.decks.push(place(rx, rz, hw, hd, 0.0, y + s as f64 * STOREY));
        }
    }

    for st in &plan.stairs {
        let floor = y + st.storey * STOREY;
        let treads = stair_treads(st);
        for t in &treads {
            out.decks.push(place(t.x, t.z, t.hw, t.hd, t.rot, floor + t.top));
        }
        // Under the high end, where the treads clear your head, a filler keeps you from walking under them.
        let high: Vec<&Tread> = treads.iter().filter(|t| t.top >= HEAD + 0.05).collect();
        if let (Some(a), Some(b)) = (high.first(), high.last()) {
            let hd = (high.len() as f64 * (a.hd * 2.0)) / 2.0;
            out.decks.push(place((a.x + b.x) / 2.0, (a.z + b.z) / 2.0, a.hw, hd, st.rot, floor + HEAD));
        }
        // A rail round the stairwell upstairs, on its open edges: not where you step off at the top, nor along an outer wall.
        let well = stairwell(st);
        let rail_top = floor + STOREY + 1.1;
        for (ex, ez, along) in [(-well.hw, 0.0, false), (well.hw, 0.0, false), (0.0, well.hd, true)] {
            let (ox, oz) = turn(ex, ez, well.rot);
            let px = well.x + ox;
            let pz = well.z + oz;
            if (px.abs() - plan.w / 2.0).abs() < 0.5 || (pz.abs() - plan.d / 2.0).abs() < 0.5 {
                continue;
            }
            out.decks.push(place(px, pz, if along { well.hw } else { 0.06 }, if along { 0.06 } else { well.hd }, well.rot, rail_top));
        }
    }

    for it in &plan.items {
        // On a table or a shelf.
        if it.y.unwrap_or(0.0) > 0.05 {
            continue;
        }
        let def = furniture_def(&it.id);
        if def.collider == "none" || def.collider.is_empty() {
            continue;
        }
        let storey = it.storey.unwrap_or(0.0);
        let floor = y + storey * STOREY;
        let r = it.rot.unwrap_or(0.0);
        let post = def.collider == "post";
        if storey == 0.0 {
            if post {
                let (ox, oz) = turn(it.x, it.z, rot);
                let radius = def.r.unwrap_or(js_min(def.w, def.d) / 2.0);
                out.obstacles.push(Obstacle { kind: ObstacleKind::Post, x: x + ox, z: z + oz, r: radius, scale: 1.0, rot: rot + r });
            } else {
                out.boxes.push(place(it.x, it.z, def.w / 2.0, def.d / 2.0, r, floor + def.h));
            }
        } else {
            let half = if post { def.r.unwrap_or(js_min(def.w, def.d) / 2.0) * 0.85 } else { 0.0 };
            // `half || w / 2`: no half (or none to speak of) means the footprint's.
            let or = |v: f64, w: f64| if v == 0.0 || v.is_nan() { w } else { v };
            out.decks.push(place(it.x, it.z, or(half, def.w / 2.0), or(half, def.d / 2.0), r, floor + js_min(HEAD, js_max(0.7, def.h))));
        }
    }

    // The roof: something to come down on from the air, well over the top floor.
    out.decks.push(place(0.0, 0.0, plan.w / 2.0, plan.d / 2.0, 0.0, top + roof_rise(roof_span(plan)) / 2.0));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_plan_reads_and_stands() {
        assert!(file().plans.len() >= 10);
        for p in &file().plans {
            let solid = building_colliders(p, 0.0, 0.0, 0.0, 0.0);
            assert!(!solid.boxes.is_empty(), "{} has walls", p.id);
            assert!(!solid.decks.is_empty(), "{} has a roof", p.id);
            let mirrored = building_colliders(&mirror_plan(p), 0.0, 0.0, 0.0, 0.0);
            assert_eq!(mirrored.boxes.len(), solid.boxes.len(), "{} mirrored has as many walls", p.id);
        }
    }

    #[test]
    fn a_doorway_breaks_the_wall() {
        assert_eq!(solid_spans(&modules(". D .")), vec![(0.0, 2.35), (3.65, 6.0)]);
        assert_eq!(minus(vec![(0.0, 6.0)], &[(0.0, 2.35), (3.65, 6.0)]), vec![(2.35, 3.65)]);
    }
}
