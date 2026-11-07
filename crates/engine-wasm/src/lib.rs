//! The engine for the browser: ruina-engine compiled to WebAssembly and called from JavaScript
//! (src/engine/wasm.ts) through plain functions on numbers, so no binding generator is needed and the
//! same calls work in the browser and in Node (the tests). The same functions build natively too,
//! so a test can hold the WebAssembly to the native results bit for bit (`probe` below).
//!
//! Text goes both ways through linear memory: the browser writes its input (a recipe, an id) into
//! room `alloc` gives and hands over where and how long; an answer in text (JSON) is left at
//! `out_ptr()`, its length returned. Big arrays (the island's heights) are read where they lie.
//!
//! What comes through here: the browser's game (`session`), the world's regions (where they stand,
//! `world_layout`; a region grown whole by the page's worker, `region_grow`, and handed to the
//! page's game, `session_adopt_region`), growing a zone from its recipe, the colliders of a building
//! plan, Emberholm's ground, the mini-games' boards (`minigames`), what a build's skills make of its
//! attacks and spells (`skills`), and content given in place of the compiled bundles
//! (`content_use`, before anything is read: the tests that add content as data, and the fixture
//! worlds).

mod minigames;
mod session;
mod skills;

use std::cell::RefCell;
use std::sync::OnceLock;

use ruina_engine::open::OpenWorld;
use ruina_engine::open::buildings::{building_colliders as solids_of, placed_plan};
use ruina_engine::open::colliders::ground_at;
use ruina_engine::open::generate::Generated;
use ruina_engine::open::map::{region_recipe_text, world_map};
use ruina_engine::open::zone::{Recipe, emberholm};

/// Emberholm with its colliders, made the first time anything asks.
fn island() -> &'static OpenWorld {
    static W: OnceLock<OpenWorld> = OnceLock::new();
    W.get_or_init(|| OpenWorld::new(emberholm()))
}

thread_local! {
    /// The zone grown last (`zone_grow`, `region_grow`), for the `zone_*` calls to read.
    static GROWN: RefCell<Option<Generated>> = const { RefCell::new(None) };
    /// The edges of the region grown last as its recipe grew them (`region_grow`; none for `zone_grow`).
    static GROWN_EDGES: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    /// The last answer in text, at `out_ptr()`.
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Room for `n` bytes of input, given back with `dealloc`.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// Gives back room `alloc` gave.
///
/// # Safety
/// `p` came from `alloc(n)` and isn't used again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(p: *mut u8, n: usize) {
    drop(unsafe { Vec::from_raw_parts(p, 0, n.max(1)) });
}

/// The text the browser wrote at `p` (`n` bytes), or nothing if it isn't UTF-8.
///
/// # Safety
/// `p..p + n` lies in room `alloc` gave.
pub(crate) unsafe fn text<'a>(p: *const u8, n: usize) -> &'a str {
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(p, n) }).unwrap_or("")
}

/// Leaves an answer at `out_ptr()` and says how long it is.
pub(crate) fn give(s: String) -> usize {
    OUT.with(|o| {
        let mut o = o.borrow_mut();
        *o = s.into_bytes();
        o.len()
    })
}

/// Where the last answer in text is.
#[unsafe(no_mangle)]
pub extern "C" fn out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

/// Content bundles to read in place of the compiled ones: at `p` (`n` bytes), a JSON object of each
/// bundle by its path under shared/ ("items.json", "regions/emberholm.json"). Only before anything has
/// been read; 1 if taken, 0 if not (too late, or not such an object).
///
/// # Safety
/// `p..p + n` lies in room `alloc` gave.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn content_use(p: *const u8, n: usize) -> u32 {
    let Ok(serde_json::Value::Object(given)) = serde_json::from_str(unsafe { text(p, n) }) else { return 0 };
    let bundles = given.into_iter().map(|(path, b)| (path, b.to_string())).collect();
    u32::from(ruina_engine::bundles::give(bundles))
}

/// Grows the zone the recipe at `p` (JSON, `n` bytes) describes, for the `zone_*` calls to read:
/// 1, or 0 if it isn't a recipe.
///
/// # Safety
/// `p..p + n` lies in room `alloc` gave.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zone_grow(p: *const u8, n: usize) -> u32 {
    let Ok(recipe) = serde_json::from_str::<Recipe>(unsafe { text(p, n) }) else {
        return 0;
    };
    // As the world places it: a region's ground blended along its borders, as the rules have it.
    let g = world_map().generate(&recipe);
    GROWN.with(|z| *z.borrow_mut() = Some(g));
    GROWN_EDGES.with(|e| e.borrow_mut().clear());
    1
}

/// Where the world's regions stand (src/engine/world/layout.ts), as JSON at `out_ptr()`: the chunk's
/// size, the blend, sea level and the open sea's floor, the edge of the world (`bounds`: min x, min
/// z, max x, max z), and each region by its place: its `id`, `name`, `climate`, `chunks` and grid
/// (`cells` of `cell` metres, from `minX`, `minZ`). Returns its length.
#[unsafe(no_mangle)]
pub extern "C" fn world_layout() -> usize {
    let w = world_map();
    let regions: Vec<serde_json::Value> = w
        .regions()
        .iter()
        .map(|r| {
            let (rec, c) = (r.recipe(), r.chunks);
            let t = &rec.terrain;
            let half = t.cells as f64 * t.cell / 2.0;
            serde_json::json!({
                "id": r.id, "name": rec.name, "climate": rec.climate,
                "chunks": { "x": c.x, "z": c.z, "w": c.w, "d": c.d },
                "cells": t.cells, "cell": t.cell, "minX": t.origin[0] - half, "minZ": t.origin[1] - half,
            })
        })
        .collect();
    give(
        serde_json::json!({ "chunk": w.chunk, "blend": w.blend, "water": w.water, "seaFloor": w.sea_floor, "bounds": w.bounds(), "regions": regions })
            .to_string(),
    )
}

/// Grows the region at `place` in the world's map whole, as the page's worker grows it to hand over
/// (WorldMap::grow_whole): its borders blended where the world places it, for the `zone_*` calls to
/// read, its edges as its recipe grew them too (`zone_edges_*`). 1, or 0 if there's no region there.
#[unsafe(no_mangle)]
pub extern "C" fn region_grow(place: u32) -> u32 {
    let w = world_map();
    if place as usize >= w.regions().len() {
        return 0;
    }
    let (g, edges) = w.grow_whole(place as usize);
    GROWN.with(|z| *z.borrow_mut() = Some(g));
    GROWN_EDGES.with(|e| *e.borrow_mut() = edges.heights().to_vec());
    1
}

/// The edges of the region grown last as its recipe grew them, before its borders were blended
/// (f32, the outer two rows and columns: ruina_engine::open::map::Edges), for the page's game to
/// read the ground across a border from (`session_adopt_region`).
#[unsafe(no_mangle)]
pub extern "C" fn zone_edges_ptr() -> *const f32 {
    GROWN_EDGES.with(|e| e.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn zone_edges_len() -> usize {
    GROWN_EDGES.with(|e| e.borrow().len())
}

/// The recipe of the region at `place` as the engine reads it (shared/regions/<id>.json, or the one
/// given), as JSON at `out_ptr()`. Returns its length, 0 if there's no region there.
#[unsafe(no_mangle)]
pub extern "C" fn region_recipe(place: u32) -> usize {
    let Some(r) = world_map().regions().get(place as usize) else { return 0 };
    region_recipe_text(&r.id).map_or(0, |t| give(t.to_string()))
}

fn grown<T>(f: impl FnOnce(&Generated) -> T) -> T {
    GROWN.with(|z| f(z.borrow().as_ref().expect("zone_grow first")))
}

/// The grown zone's heights, vertex by vertex, row by row (f32).
#[unsafe(no_mangle)]
pub extern "C" fn zone_heights_ptr() -> *const f32 {
    grown(|g| g.terrain.heights().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn zone_heights_len() -> usize {
    grown(|g| g.terrain.heights().len())
}

/// What each cell of the grown zone's ground is made of (zone.rs `surface`).
#[unsafe(no_mangle)]
pub extern "C" fn zone_surface_ptr() -> *const u8 {
    grown(|g| g.terrain.surface.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn zone_surface_len() -> usize {
    grown(|g| g.terrain.surface.len())
}

/// The grown zone's cells kept clear of trees and rocks.
#[unsafe(no_mangle)]
pub extern "C" fn zone_clear_ptr() -> *const u8 {
    grown(|g| g.clear.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn zone_clear_len() -> usize {
    grown(|g| g.clear.len())
}

/// The rest of the grown zone, as JSON at `out_ptr()`: its grid's shape, colliders, roads, ramps,
/// placements, waterfalls and buildings. Returns its length.
#[unsafe(no_mangle)]
pub extern "C" fn zone_json() -> usize {
    grown(|g| {
        let t = &g.terrain;
        give(
            serde_json::json!({
                "cells": t.cells,
                "cell": t.cell,
                "water": t.water,
                "minX": t.min_x,
                "minZ": t.min_z,
                "obstacles": g.obstacles,
                "boxes": g.boxes,
                "decks": g.decks,
                "roads": g.roads,
                "ramps": g.ramps,
                "placements": g.placements,
                "falls": g.falls,
                "buildings": g.buildings,
            })
            .to_string(),
        )
    })
}

/// Everything solid about the building plan named at `p` (`n` bytes), mirrored or not, standing on
/// ground at `y` at (x, z) turned `rot`: `{boxes, decks, obstacles}` as JSON at `out_ptr()`. Returns
/// its length, or 0 if there's no such plan.
///
/// # Safety
/// `p..p + n` lies in room `alloc` gave.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn building_colliders(p: *const u8, n: usize, mirror: u32, x: f64, z: f64, rot: f64, y: f64) -> usize {
    let Some(plan) = placed_plan(unsafe { text(p, n) }, mirror != 0) else {
        return 0;
    };
    let c = solids_of(&plan, x, z, rot, y);
    give(serde_json::json!({ "boxes": c.boxes, "decks": c.decks, "obstacles": c.obstacles }).to_string())
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
    // Over the first region and a little past it: the ground where players may go.
    let r = island().zone.radius;
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
