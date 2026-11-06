//! The world: regions placed on a grid of chunks (shared/world.json, built from
//! content/world.json), and the open sea wherever no region stands. Each region is a zone grown from
//! its recipe the first time anything asks. Its recipe is written in world coordinates and its grid
//! covers exactly its chunks (contentc checks both), so a region is placed by where it is, never
//! moved there. The rules ask the ground through the map, so they work the same on any region and
//! across their borders: how high it is, how steep, what it's made of, how deep the water is over
//! it, and where the edge of the world is.
//!
//! Borders have no seam. Near a chunk's edge the ground is shared with what's across it, by weights
//! that step smoothly from one chunk to the next over `blend` metres either side and always sum to
//! one: the ground there is each neighbour's as its recipe grew it (a region's held at its edge past
//! it, the open sea's its floor), weighed together. Where every weight is one region's, its ground is
//! its own to the bit. A region bakes the blend into its grid as it grows, so what's drawn is what's
//! walked on; and since the ground at a point is the same sum whichever side works it out, two
//! regions' edges are the same heights. The open sea near a region slopes to meet it the same way.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

use super::generate::{Generated, generate};
use super::noise::smoothstep;
use super::zone::{Heightfield, Recipe, Zone, surface};

mod built {
    include!(concat!(env!("OUT_DIR"), "/zones.rs"));
}

/// Where a region stands: its first chunk, and how many chunks it spans along x (`w`) and z (`d`).
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chunks {
    pub x: i32,
    pub z: i32,
    pub w: i32,
    pub d: i32,
}

#[derive(Deserialize)]
struct RegionFile {
    id: String,
    chunks: Chunks,
}

#[derive(Deserialize)]
struct Sea {
    level: f64,
    depth: f64,
}

#[derive(Deserialize)]
struct WorldFile {
    chunk: f64,
    blend: f64,
    sea: Sea,
    regions: Vec<RegionFile>,
}

/// One region of the world: where it stands, and its zone, grown when first asked for
/// (WorldMap::zone).
pub struct Region {
    pub id: String,
    pub chunks: Chunks,
    recipe: Recipe,
    zone: OnceLock<Zone>,
    /// Its ground as its recipe grows it, before its borders are blended, while what's across them
    /// needs it: kept if a region borders it or the blend changed it (otherwise its zone's ground is
    /// the same), or grown alone for a neighbour that grew first.
    raw: OnceLock<Heightfield>,
}

/// Whose ground: a region's, by its place in the map, or the open sea's (None).
type Owner = Option<usize>;

/// Every region of a world and the sea between them, answering the ground anywhere in it.
pub struct WorldMap {
    /// Metres a chunk is on a side.
    pub chunk: f64,
    /// Sea level, the same everywhere.
    pub water: f64,
    /// The open sea's floor, where no region stands.
    pub sea_floor: f64,
    /// Metres either side of a chunk's edge over which the ground is shared with what's across it.
    pub blend: f64,
    regions: Vec<Region>,
    by_chunk: BTreeMap<(i32, i32), usize>,
    /// The edge of the world: every region's chunks together, as (min x, min z, max x, max z).
    bounds: [f64; 4],
}

impl WorldMap {
    /// A world from its file (shared/world.json's shape), each region's recipe found by `recipe`.
    pub fn from_json(text: &str, recipe: impl Fn(&str) -> Option<Recipe>) -> Result<WorldMap, String> {
        let file: WorldFile = serde_json::from_str(text).map_err(|e| format!("not a world: {e}"))?;
        let mut regions = Vec::new();
        let mut by_chunk = BTreeMap::new();
        let mut bounds = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for (i, r) in file.regions.into_iter().enumerate() {
            let rec = recipe(&r.id).ok_or_else(|| format!("no zone {:?} for the world's region", r.id))?;
            let c = r.chunks;
            for cx in c.x..c.x + c.w {
                for cz in c.z..c.z + c.d {
                    if by_chunk.insert((cx, cz), i).is_some() {
                        return Err(format!("{}: chunk ({cx}, {cz}) is another region's", r.id));
                    }
                }
            }
            bounds[0] = bounds[0].min(c.x as f64 * file.chunk);
            bounds[1] = bounds[1].min(c.z as f64 * file.chunk);
            bounds[2] = bounds[2].max((c.x + c.w) as f64 * file.chunk);
            bounds[3] = bounds[3].max((c.z + c.d) as f64 * file.chunk);
            regions.push(Region { id: r.id, chunks: c, recipe: rec, zone: OnceLock::new(), raw: OnceLock::new() });
        }
        if regions.is_empty() {
            return Err("a world has at least one region".into());
        }
        if !(file.blend >= 0.0 && file.blend <= file.chunk / 2.0) {
            return Err(format!("blend {} isn't between 0 and half a chunk", file.blend));
        }
        Ok(WorldMap { chunk: file.chunk, water: file.sea.level, sea_floor: file.sea.level - file.sea.depth, blend: file.blend, regions, by_chunk, bounds })
    }

    pub fn regions(&self) -> &[Region] {
        &self.regions
    }

    pub fn region(&self, id: &str) -> Option<&Region> {
        self.regions.iter().find(|r| r.id == id)
    }

    /// The chunk a point is in.
    pub fn chunk_of(&self, x: f64, z: f64) -> (i32, i32) {
        ((x / self.chunk).floor() as i32, (z / self.chunk).floor() as i32)
    }

    /// The region a point is in, if any (the open sea is in none).
    pub fn region_at(&self, x: f64, z: f64) -> Option<&Region> {
        self.by_chunk.get(&self.chunk_of(x, z)).map(|&i| &self.regions[i])
    }

    /// The zone of the region a point is in, grown if it hasn't been.
    pub fn zone_at(&self, x: f64, z: f64) -> Option<&Zone> {
        self.region_at(x, z).map(|r| self.zone(r))
    }

    /// A region's zone: its ground, colliders and recipe, grown the first time anything asks, its
    /// ground along its borders blended with what's across them.
    pub fn zone<'a>(&'a self, r: &'a Region) -> &'a Zone {
        r.zone.get_or_init(|| {
            let mut g = generate(&r.recipe);
            let raw = g.terrain.clone();
            let changed = self.blend_borders(self.index_of(r), &raw, &mut g.terrain);
            if changed || self.borders_a_region(r) {
                let _ = r.raw.set(raw);
            }
            Zone::of(r.recipe.clone(), g)
        })
    }

    /// What a zone's recipe grows, its ground blended along its borders where this world places it
    /// (if it's one of its regions): what the browser draws, the same ground the rules walk on.
    pub fn generate(&self, recipe: &Recipe) -> Generated {
        let mut g = generate(recipe);
        if let Some(i) = self.regions.iter().position(|r| r.id == recipe.id) {
            let raw = g.terrain.clone();
            self.blend_borders(i, &raw, &mut g.terrain);
        }
        g
    }

    fn index_of(&self, r: &Region) -> usize {
        self.regions.iter().position(|o| std::ptr::eq(o, r)).expect("a region of this map")
    }

    /// Whether another region stands on a chunk beside (or diagonally beside) one of a region's.
    fn borders_a_region(&self, r: &Region) -> bool {
        let c = r.chunks;
        (c.x - 1..=c.x + c.w).any(|cx| (c.z - 1..=c.z + c.d).any(|cz| self.by_chunk.get(&(cx, cz)).is_some_and(|&i| !std::ptr::eq(&self.regions[i], r))))
    }

    /// A region's ground as its recipe grows it, before its borders are blended.
    fn raw(&self, i: usize) -> &Heightfield {
        let r = &self.regions[i];
        if let Some(h) = r.raw.get() {
            return h;
        }
        // Grown with nothing blended and nothing kept: its own ground is as it grew.
        if let Some(z) = r.zone.get() {
            return &z.terrain;
        }
        r.raw.get_or_init(|| generate(&r.recipe).terrain)
    }

    /// Who the ground at a point is shared between, and how much each has of it: up to four chunks'
    /// owners, each chunk's weight a smooth step across every chunk edge within `blend` of the point,
    /// the weights summing to one; an owner of several of the chunks has their weights together. In
    /// the order of their owners (the open sea first), so every side works the same sum.
    fn owners(&self, x: f64, z: f64) -> ([(Owner, f64); 4], usize) {
        let (cx, cz) = self.chunk_of(x, z);
        let (wx, wz) = (self.steps(x - cx as f64 * self.chunk), self.steps(z - cz as f64 * self.chunk));
        let mut out: [(Owner, f64); 4] = [(None, 0.0); 4];
        let mut n = 0;
        for &(dx, ax) in wx.iter().filter(|(_, w)| *w > 0.0) {
            for &(dz, az) in wz.iter().filter(|(_, w)| *w > 0.0) {
                let owner = self.by_chunk.get(&(cx + dx, cz + dz)).copied();
                let w = ax * az;
                match out[..n].iter_mut().find(|(o, _)| *o == owner) {
                    Some(slot) => slot.1 += w,
                    None => {
                        out[n] = (owner, w);
                        n += 1;
                    }
                }
            }
        }
        out[..n].sort_by_key(|(o, _)| o.map_or(0, |i| i + 1));
        (out, n)
    }

    /// Along one axis, a point `u` metres into its chunk: the weights of the chunk before it (-1),
    /// its own (0) and the one after it (1).
    fn steps(&self, u: f64) -> [(i32, f64); 3] {
        let b = self.blend;
        if b > 0.0 && u < b {
            let s = smoothstep(0.0, 1.0, (u + b) / (2.0 * b));
            [(-1, 1.0 - s), (0, s), (1, 0.0)]
        } else if b > 0.0 && u > self.chunk - b {
            let s = smoothstep(0.0, 1.0, (u - (self.chunk - b)) / (2.0 * b));
            [(-1, 0.0), (0, 1.0 - s), (1, s)]
        } else {
            [(-1, 0.0), (0, 1.0), (1, 0.0)]
        }
    }

    /// The ground at a point as its owners grew it, weighed together: the owner of the chunk it's in
    /// plus each other's share of the difference, so where they agree it's exactly theirs. `own` is
    /// the region working it out, with its own ground as grown (its grid holds the point).
    fn blended(&self, x: f64, z: f64, own: Option<(usize, &Heightfield)>) -> f64 {
        let (owners, n) = self.owners(x, z);
        let at = |o: Owner| match (o, own) {
            (None, _) => self.sea_floor,
            (Some(i), Some((me, hf))) if i == me => vertex_or_height(hf, x, z),
            (Some(i), _) => vertex_or_height(self.raw(i), x, z),
        };
        let base = self.by_chunk.get(&self.chunk_of(x, z)).copied();
        let h0 = at(base);
        let mut h = h0;
        for &(o, w) in &owners[..n] {
            if o != base {
                h += w * (at(o) - h0);
            }
        }
        h
    }

    /// Blends a region's ground along its borders, from `raw` (as grown) into `out`: whether any of it
    /// changed. Only a band `blend` wide round its grid can share its ground, as its chunks inside are
    /// all its own.
    fn blend_borders(&self, i: usize, raw: &Heightfield, out: &mut Heightfield) -> bool {
        let band = (self.blend / raw.cell).ceil() as usize;
        let n = raw.n;
        let mut changed = false;
        for j in 0..n {
            for k in 0..n {
                if j > band && j + band < n - 1 && k > band && k + band < n - 1 {
                    continue;
                }
                let (x, z) = (raw.vx(k), raw.vz(j));
                if self.owners(x, z).1 < 2 {
                    continue;
                }
                let h = self.blended(x, z, Some((i, raw))) as f32;
                let at = j * n + k;
                if h.to_bits() != out.heights()[at].to_bits() {
                    out.heights_mut()[at] = h;
                    changed = true;
                }
            }
        }
        changed
    }

    /// Ground height at a world point: a region's terrain, or the open sea's floor, sloping to meet
    /// any region within `blend` of it.
    pub fn height(&self, x: f64, z: f64) -> f64 {
        match self.zone_at(x, z) {
            Some(zn) => zn.terrain.height(x, z),
            None => self.sea_ground(x, z),
        }
    }

    /// The open sea's ground at a point: its floor, or blended with a region's near one.
    fn sea_ground(&self, x: f64, z: f64) -> f64 {
        if self.owners(x, z).1 < 2 { self.sea_floor } else { self.blended(x, z, None) }
    }

    /// dh/dx and dh/dz of the ground under a point (the open sea's floor is flat but near a region).
    pub fn gradient(&self, x: f64, z: f64) -> (f64, f64) {
        if let Some(zn) = self.zone_at(x, z) {
            return zn.terrain.gradient(x, z);
        }
        if self.owners(x, z).1 < 2 {
            return (0.0, 0.0);
        }
        const E: f64 = 0.5;
        ((self.sea_ground(x + E, z) - self.sea_ground(x - E, z)) / (2.0 * E), (self.sea_ground(x, z + E) - self.sea_ground(x, z - E)) / (2.0 * E))
    }

    /// Steepness at a point: rise over run along the steepest direction of its ground.
    pub fn slope(&self, x: f64, z: f64) -> f64 {
        let (gx, gz) = self.gradient(x, z);
        (gx * gx + gz * gz).sqrt()
    }

    /// What the ground under a point is made of (the open sea's floor is sand).
    pub fn surface_at(&self, x: f64, z: f64) -> u8 {
        self.zone_at(x, z).map_or(surface::SAND, |zn| zn.terrain.surface_at(x, z))
    }

    /// How deep the water is over a point (0 on dry land).
    pub fn depth(&self, x: f64, z: f64) -> f64 {
        (self.water - self.height(x, z)).max(0.0)
    }

    /// Whether a point is within the edge of the world, `margin` metres in from it.
    pub fn inside(&self, x: f64, z: f64, margin: f64) -> bool {
        let [x0, z0, x1, z1] = self.bounds;
        x >= x0 + margin && x <= x1 - margin && z >= z0 + margin && z <= z1 - margin
    }

    /// A point brought back within the edge of the world, `margin` metres in from it.
    pub fn keep_inside(&self, x: f64, z: f64, margin: f64) -> (f64, f64) {
        let [x0, z0, x1, z1] = self.bounds;
        (x.clamp(x0 + margin, x1 - margin), z.clamp(z0 + margin, z1 - margin))
    }

    /// Grows every region that hasn't been (what's solid in a world is all its regions' colliders).
    pub fn grow_all(&self) {
        for r in &self.regions {
            self.zone(r);
        }
    }
}

/// A grid's height at a point held to its edges: a vertex's own height when the point is one (as it
/// is wherever two regions' grids meet: every region's cell is the same, a whole number to a
/// chunk), so both sides of a border read the same number.
fn vertex_or_height(hf: &Heightfield, x: f64, z: f64) -> f64 {
    let x = x.clamp(hf.min_x, hf.max_x());
    let z = z.clamp(hf.min_z, hf.max_z());
    let (gx, gz) = ((x - hf.min_x) / hf.cell, (z - hf.min_z) / hf.cell);
    if gx == gx.floor() && gz == gz.floor() { hf.heights()[gz as usize * hf.n + gx as usize] as f64 } else { hf.height(x, z) }
}

/// A zone's recipe as built into the engine (shared/zones/<id>.json), or as given in its place
/// (crate::bundles), by its id.
pub fn zone_recipe(id: &str) -> Option<Recipe> {
    let (_, compiled) = built::ZONES.iter().find(|(z, _)| *z == id)?;
    let text = crate::bundles::bundle(&format!("zones/{id}.json"), compiled);
    Some(serde_json::from_str(text).unwrap_or_else(|e| panic!("shared/zones/{id}.json is a zone recipe: {e}")))
}

/// The world (shared/world.json), each region grown the first time anything asks.
pub fn world_map() -> &'static WorldMap {
    static W: OnceLock<WorldMap> = OnceLock::new();
    W.get_or_init(|| {
        let text = crate::bundles::bundle("world.json", include_str!("../../../../shared/world.json"));
        WorldMap::from_json(text, zone_recipe).unwrap_or_else(|e| panic!("shared/world.json: {e}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open::OpenWorld;

    #[test]
    fn emberholm_is_the_world_s_first_region_round_its_origin() {
        let w = world_map();
        let r = w.region_at(0.0, 0.0).expect("Emberholm stands at the origin");
        assert_eq!(r.id, "emberholm");
        assert_eq!(r.chunks, Chunks { x: -3, z: -3, w: 6, d: 6 });
        let t = &w.zone(r).terrain;
        // Its grid covers exactly its chunks.
        assert_eq!((t.min_x, t.min_z, t.max_x(), t.max_z()), (-768.0, -768.0, 768.0, 768.0));
        // Inside it, the ground is its terrain's, to the bit.
        for (x, z) in [(0.0, -264.0), (40.0, 110.0), (-262.5, 116.25), (700.0, -700.0)] {
            assert_eq!(w.height(x, z).to_bits(), t.height(x, z).to_bits());
            assert_eq!(w.surface_at(x, z), t.surface_at(x, z));
        }
    }

    #[test]
    fn past_every_region_is_open_sea_to_the_edge_of_the_world() {
        let w = world_map();
        assert!(w.region_at(800.0, 0.0).is_none());
        // Past the blend round Emberholm, the open sea's floor.
        assert_eq!(w.height(840.0, 0.0), w.sea_floor);
        assert_eq!(w.depth(840.0, 0.0), 30.0);
        assert_eq!(w.gradient(840.0, 0.0), (0.0, 0.0));
        assert!(w.inside(759.0, -759.0, 8.0));
        assert!(!w.inside(761.0, 0.0, 8.0));
        assert_eq!(w.keep_inside(900.0, -10.0, 8.0), (760.0, -10.0));
    }

    /// A world of two regions across the sea from each other: Emberholm, and to its west an islet two
    /// chunks across (x 1024 to 1536 m, z -256 to 256 m), its recipe written where it stands.
    fn archipelago() -> &'static WorldMap {
        static W: OnceLock<WorldMap> = OnceLock::new();
        W.get_or_init(|| {
            let file = r#"{ "chunk": 256, "blend": 64, "sea": { "level": 0, "depth": 30 }, "regions": [
                { "id": "emberholm", "chunks": { "x": -3, "z": -3, "w": 6, "d": 6 } },
                { "id": "islet", "chunks": { "x": 4, "z": -1, "w": 2, "d": 2 } } ] }"#;
            WorldMap::from_json(file, |id| if id == "islet" { Some(islet()) } else { zone_recipe(id) }).expect("a world")
        })
    }

    fn islet() -> Recipe {
        small_region("islet", 7, 1280.0, 1280.0, 110.0, 6.0)
    }

    /// A region two chunks a side round (`mid`, 0), its island round (`land`, 0).
    fn small_region(id: &str, seed: u32, mid: f64, land: f64, radius: f64, hills: f64) -> Recipe {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": id, "seed": seed, "climate": "temperate",
            "terrain": {
                "cells": 256, "cell": 2.0, "water": 0.0, "origin": [mid, 0.0],
                "island": { "x": land, "z": 0.0, "radius": radius, "lobes": [[3, 12.0, 0.4]], "warp": 10.0, "warpScale": 90.0 },
                "shore": { "beach": 20.0, "beachHeight": 2.0, "inlandRise": 0.02, "seabedSlope": 0.085, "seabedCurve": 0.00035, "maxDepth": 30.0 },
                "hills": { "scale": 120.0, "height": hills, "detailScale": 40.0, "detail": 1.0, "inlandFrom": 20.0, "inlandTo": 80.0 },
                "sandBelow": 1.6, "rockSlope": 1.2
            },
            "scatter": { "trees": 0.002, "rocks": 0.0005, "clearOfRoad": 5.0, "clearOfStructure": 4.0 },
            "spawn": { "x": land, "z": 0.0, "facing": 0.0 },
            "places": [], "npcs": [], "workbenches": [], "outposts": [], "housePlots": [], "nodes": [], "updrafts": [],
            "sky": { "dayLengthSeconds": 1800.0, "startHour": 8.5, "sunrise": 5.5, "sunset": 20.0 },
            "slimes": { "x": land, "z": 0.0, "count": 0, "r": 10.0 },
            "dummy": { "x": land + 10.0, "z": 0.0 }
        }))
        .expect("a small region's recipe")
    }

    /// Two regions across a land border at x = 1536 m: one island grown half by each, each half from
    /// its own recipe (its own seed and hills), so they differ where they meet until the border blends
    /// them.
    fn mainland() -> &'static WorldMap {
        static W: OnceLock<WorldMap> = OnceLock::new();
        W.get_or_init(|| {
            let file = r#"{ "chunk": 256, "blend": 64, "sea": { "level": 0, "depth": 30 }, "regions": [
                { "id": "emberholm", "chunks": { "x": -3, "z": -3, "w": 6, "d": 6 } },
                { "id": "fells", "chunks": { "x": 4, "z": -1, "w": 2, "d": 2 } },
                { "id": "downs", "chunks": { "x": 6, "z": -1, "w": 2, "d": 2 } } ] }"#;
            WorldMap::from_json(file, |id| match id {
                "fells" => Some(small_region("fells", 11, 1280.0, 1536.0, 190.0, 9.0)),
                "downs" => Some(small_region("downs", 23, 1792.0, 1536.0, 190.0, 3.0)),
                _ => zone_recipe(id),
            })
            .expect("a world")
        })
    }

    #[test]
    fn regions_across_a_land_border_meet_with_no_seam() {
        let w = mainland();
        let (fells, downs) = (&w.zone(w.region("fells").expect("fells")).terrain, &w.zone(w.region("downs").expect("downs")).terrain);
        assert_eq!((fells.max_x(), downs.min_x), (1536.0, 1536.0));
        // Grown alone, the two halves don't meet: their hills differ.
        let (raw_f, raw_d) = (
            generate(&small_region("fells", 11, 1280.0, 1536.0, 190.0, 9.0)).terrain,
            generate(&small_region("downs", 23, 1792.0, 1536.0, 190.0, 3.0)).terrain,
        );
        let n = fells.n;
        let apart = (0..n).map(|j| (raw_f.heights()[j * n + n - 1] - raw_d.heights()[j * n]).abs()).fold(0.0f32, f32::max);
        assert!(apart > 0.5, "the halves grown alone differ along the border by up to {apart} m");
        // Blended, the border's heights are the same numbers on both sides, all the way along.
        for j in 0..n {
            assert_eq!(fells.heights()[j * n + n - 1].to_bits(), downs.heights()[j * n].to_bits(), "row {j}");
        }
        // Walking over it, the ground never jumps.
        let mut last = w.height(1400.0, 0.0);
        let mut x = 1400.0;
        while x < 1680.0 {
            x += 0.25;
            let h = w.height(x, 0.0);
            assert!((h - last).abs() < 0.25, "a step of {} m at x = {x}", h - last);
            last = h;
        }
    }

    #[test]
    fn you_can_walk_from_one_region_into_the_next() {
        use crate::open::colliders::ground_at;
        use crate::open::step_player;
        use crate::player::{Actions, Build, Mode, Player};
        use crate::world::Spawn;
        let w = mainland();
        let mut world = OpenWorld::on(w, w.zone(w.region("fells").expect("fells")));
        let (x, z) = (1460.0, 0.0);
        let mut p = Player::new(Spawn { x, z, facing: std::f64::consts::FRAC_PI_2 }, 0, Build::default());
        p.pos.y = ground_at(w, &world.index, x, z, w.water, 1.2);
        assert!(w.height(x, z) > w.water && w.height(1620.0, 0.0) > w.water, "dry land either side of the border");
        let on = Actions { move_x: 1.0, ..Default::default() };
        for _ in 0..60 * 60 {
            step_player(&mut p, &on, &mut world, None, 0);
            assert!(p.mode != Mode::Swim, "never in the water: {:?}", p.pos);
            if p.pos.x > 1600.0 {
                break;
            }
        }
        assert_eq!(w.region_at(p.pos.x, p.pos.z).map(|r| r.id.as_str()), Some("downs"), "walked into the downs: {:?}", p.pos);
    }

    #[test]
    fn a_region_meets_the_open_sea_with_no_seam() {
        for (w, at) in [
            (world_map(), [(768.0, 0.0), (0.0, -768.0), (768.0, 768.0), (-768.0, 300.0)]),
            (archipelago(), [(1536.0, 10.0), (1024.0, -100.0), (1300.0, 256.0), (1536.0, -256.0)]),
        ] {
            for (x, z) in at {
                for (dx, dz) in [(1e-6, 0.0), (0.0, 1e-6), (1e-6, 1e-6)] {
                    let (a, b) = (w.height(x - dx, z - dz), w.height(x + dx, z + dz));
                    assert!((a - b).abs() < 1e-3, "at ({x}, {z}): {a} inside, {b} outside");
                }
            }
        }
    }

    #[test]
    fn a_region_s_ground_is_its_own_but_within_the_blend_of_its_edge() {
        let w = world_map();
        let blended = &w.zone(w.region("emberholm").expect("Emberholm")).terrain;
        let grown = generate(&zone_recipe("emberholm").expect("Emberholm")).terrain;
        let n = grown.n;
        let band = (w.blend / grown.cell) as usize;
        let mut changed = 0;
        for j in 0..n {
            for k in 0..n {
                let (a, b) = (blended.heights()[j * n + k], grown.heights()[j * n + k]);
                if a.to_bits() != b.to_bits() {
                    changed += 1;
                    assert!(j <= band || k <= band || j >= n - 1 - band || k >= n - 1 - band, "({k}, {j}) is inside");
                }
            }
        }
        assert!(changed > 0, "Emberholm's edge is shallower than the open sea in places, and slopes to meet it");
        // The open sea's floor beyond it is where its edge was blended to.
        assert!((w.height(768.0, 0.0) - (grown.height(768.0, 0.0) + w.sea_floor) / 2.0).abs() < 1e-4);
    }

    #[test]
    fn regions_stand_where_the_world_puts_them_with_open_sea_between() {
        let w = archipelago();
        let islet = w.region_at(1280.0, 0.0).expect("the islet stands at its chunks");
        assert_eq!(islet.id, "islet");
        let t = &w.zone(islet).terrain;
        assert_eq!((t.min_x, t.min_z, t.max_x(), t.max_z()), (1024.0, -256.0, 1536.0, 256.0));
        assert!(w.height(1280.0, 0.0) > w.water, "its middle is dry land: {}", w.height(1280.0, 0.0));
        // Between the two, open sea.
        assert!(w.region_at(900.0, 0.0).is_none());
        assert_eq!(w.depth(900.0, 0.0), 30.0);
        // Emberholm is the same island in this world as in the main one.
        let e = w.zone(w.region("emberholm").expect("Emberholm"));
        assert_eq!(e.terrain.heights(), super::super::zone::emberholm().terrain.heights());
        // The edge of the world is round every region's chunks together, the sea between them included.
        assert!(w.inside(1500.0, 200.0, 8.0) && w.inside(1000.0, -700.0, 8.0));
        assert!(!w.inside(1530.0, 0.0, 8.0) && !w.inside(0.0, 765.0, 8.0));
    }

    #[test]
    fn a_world_of_regions_is_solid_with_all_of_them() {
        let w = archipelago();
        let world = OpenWorld::on(w, w.zone(w.region("emberholm").expect("Emberholm")));
        let count = |id: &str| w.zone(w.region(id).expect("a region")).obstacles.len();
        assert_eq!(world.index.obstacles.len(), count("emberholm") + count("islet"));
        assert!(count("islet") > 0, "the islet has its trees and rocks");
    }

    #[test]
    fn you_can_swim_from_one_region_to_the_next() {
        use crate::open::colliders::ground_at;
        use crate::open::step_player;
        use crate::player::{Actions, Build, Mode, Player};
        use crate::world::Spawn;
        let w = archipelago();
        let mut world = OpenWorld::on(w, w.zone(w.region("emberholm").expect("Emberholm")));
        // In the sea off Emberholm's west coast, swimming west for the islet.
        let (x, z) = (700.0, 0.0);
        let mut p = Player::new(Spawn { x, z, facing: std::f64::consts::FRAC_PI_2 }, 0, Build::default());
        p.pos.y = ground_at(w, &world.index, x, z, w.water, 1.2);
        let west = Actions { move_x: 1.0, ..Default::default() };
        let mut crossed = None;
        for i in 0..60 * 400 {
            step_player(&mut p, &west, &mut world, None, 0);
            if crossed.is_none() && w.region_at(p.pos.x, p.pos.z).is_some_and(|r| r.id == "islet") {
                crossed = Some(i);
            }
            if p.mode != Mode::Swim && crossed.is_some() {
                break;
            }
        }
        assert!(crossed.is_some(), "still at sea at {:?}, {:?}", p.pos, p.mode);
        assert!(p.pos.x > 1024.0 && p.mode != Mode::Swim, "ashore on the islet: {:?}, {:?}", p.pos, p.mode);
    }

    #[test]
    fn regions_may_not_share_a_chunk() {
        let file = r#"{ "chunk": 256, "blend": 64, "sea": { "level": 0, "depth": 30 }, "regions": [
            { "id": "emberholm", "chunks": { "x": -3, "z": -3, "w": 6, "d": 6 } },
            { "id": "emberholm", "chunks": { "x": 2, "z": 0, "w": 2, "d": 2 } } ] }"#;
        let e = WorldMap::from_json(file, zone_recipe).err().expect("refused");
        assert!(e.contains("chunk (2, 0) is another region's"), "{e}");
    }
}
