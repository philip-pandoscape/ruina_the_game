//! The world: regions placed on a grid of chunks (shared/world.json, built from
//! content/world.json), and the open sea wherever no region stands. Each region is a zone grown from
//! its recipe the first time anything asks. Its recipe is written in world coordinates and its grid
//! covers exactly its chunks (contentc checks both), so a region is placed by where it is, never
//! moved there. The rules ask the ground through the map, so they work the same on any region and
//! across their borders: how high it is, how steep, what it's made of, how deep the water is over
//! it, and where the edge of the world is.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

use super::zone::{Recipe, Zone, surface};

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
    sea: Sea,
    regions: Vec<RegionFile>,
}

/// One region of the world: where it stands, and its zone, grown when first asked for.
pub struct Region {
    pub id: String,
    pub chunks: Chunks,
    recipe: Recipe,
    zone: OnceLock<Zone>,
}

impl Region {
    /// The region's zone: its ground, colliders and recipe, grown the first time anything asks.
    pub fn zone(&self) -> &Zone {
        self.zone.get_or_init(|| Zone::grow(self.recipe.clone()))
    }
}

/// Every region of a world and the sea between them, answering the ground anywhere in it.
pub struct WorldMap {
    /// Metres a chunk is on a side.
    pub chunk: f64,
    /// Sea level, the same everywhere.
    pub water: f64,
    /// The open sea's floor, where no region stands.
    pub sea_floor: f64,
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
            regions.push(Region { id: r.id, chunks: c, recipe: rec, zone: OnceLock::new() });
        }
        if regions.is_empty() {
            return Err("a world has at least one region".into());
        }
        Ok(WorldMap { chunk: file.chunk, water: file.sea.level, sea_floor: file.sea.level - file.sea.depth, regions, by_chunk, bounds })
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
        self.region_at(x, z).map(Region::zone)
    }

    /// Ground height at a world point: a region's terrain, or the open sea's floor.
    pub fn height(&self, x: f64, z: f64) -> f64 {
        self.zone_at(x, z).map_or(self.sea_floor, |zn| zn.terrain.height(x, z))
    }

    /// dh/dx and dh/dz of the ground under a point (the open sea's floor is flat).
    pub fn gradient(&self, x: f64, z: f64) -> (f64, f64) {
        self.zone_at(x, z).map_or((0.0, 0.0), |zn| zn.terrain.gradient(x, z))
    }

    /// Steepness at a point: rise over run along the steepest direction of its ground.
    pub fn slope(&self, x: f64, z: f64) -> f64 {
        self.zone_at(x, z).map_or(0.0, |zn| zn.terrain.slope(x, z))
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
            r.zone();
        }
    }
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
        let t = &r.zone().terrain;
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
        assert_eq!(w.height(800.0, 0.0), w.sea_floor);
        assert_eq!(w.depth(800.0, 0.0), 30.0);
        assert!(w.inside(759.0, -759.0, 8.0));
        assert!(!w.inside(761.0, 0.0, 8.0));
        assert_eq!(w.keep_inside(900.0, -10.0, 8.0), (760.0, -10.0));
    }

    /// A world of two regions across the sea from each other: Emberholm, and to its west an islet two
    /// chunks across (x 1024 to 1536 m, z -256 to 256 m), its recipe written where it stands.
    fn archipelago() -> &'static WorldMap {
        static W: OnceLock<WorldMap> = OnceLock::new();
        W.get_or_init(|| {
            let file = r#"{ "chunk": 256, "sea": { "level": 0, "depth": 30 }, "regions": [
                { "id": "emberholm", "chunks": { "x": -3, "z": -3, "w": 6, "d": 6 } },
                { "id": "islet", "chunks": { "x": 4, "z": -1, "w": 2, "d": 2 } } ] }"#;
            WorldMap::from_json(file, |id| if id == "islet" { Some(islet()) } else { zone_recipe(id) }).expect("a world")
        })
    }

    fn islet() -> Recipe {
        serde_json::from_value(serde_json::json!({
            "id": "islet", "name": "The Islet", "seed": 7, "climate": "temperate",
            "terrain": {
                "cells": 256, "cell": 2.0, "water": 0.0, "origin": [1280.0, 0.0],
                "island": { "x": 1280.0, "z": 0.0, "radius": 110.0, "lobes": [[3, 12.0, 0.4]], "warp": 10.0, "warpScale": 90.0 },
                "shore": { "beach": 20.0, "beachHeight": 2.0, "inlandRise": 0.02, "seabedSlope": 0.085, "seabedCurve": 0.00035, "maxDepth": 30.0 },
                "hills": { "scale": 120.0, "height": 6.0, "detailScale": 40.0, "detail": 1.0, "inlandFrom": 20.0, "inlandTo": 80.0 },
                "sandBelow": 1.6, "rockSlope": 1.2
            },
            "scatter": { "trees": 0.002, "rocks": 0.0005, "clearOfRoad": 5.0, "clearOfStructure": 4.0 },
            "spawn": { "x": 1280.0, "z": 0.0, "facing": 0.0 },
            "places": [], "npcs": [], "workbenches": [], "outposts": [], "housePlots": [], "nodes": [], "updrafts": [],
            "sky": { "dayLengthSeconds": 1800.0, "startHour": 8.5, "sunrise": 5.5, "sunset": 20.0 },
            "slimes": { "x": 1280.0, "z": 0.0, "count": 0, "r": 10.0 },
            "dummy": { "x": 1290.0, "z": 0.0 }
        }))
        .expect("the islet's recipe")
    }

    #[test]
    fn regions_stand_where_the_world_puts_them_with_open_sea_between() {
        let w = archipelago();
        let islet = w.region_at(1280.0, 0.0).expect("the islet stands at its chunks");
        assert_eq!(islet.id, "islet");
        let t = &islet.zone().terrain;
        assert_eq!((t.min_x, t.min_z, t.max_x(), t.max_z()), (1024.0, -256.0, 1536.0, 256.0));
        assert!(w.height(1280.0, 0.0) > w.water, "its middle is dry land: {}", w.height(1280.0, 0.0));
        // Between the two, open sea.
        assert!(w.region_at(900.0, 0.0).is_none());
        assert_eq!(w.depth(900.0, 0.0), 30.0);
        // Emberholm is the same island in this world as in the main one.
        let e = w.region("emberholm").expect("Emberholm").zone();
        assert_eq!(e.terrain.heights(), world_map().region("emberholm").expect("Emberholm").zone().terrain.heights());
        // The edge of the world is round every region's chunks together, the sea between them included.
        assert!(w.inside(1500.0, 200.0, 8.0) && w.inside(1000.0, -700.0, 8.0));
        assert!(!w.inside(1530.0, 0.0, 8.0) && !w.inside(0.0, 765.0, 8.0));
    }

    #[test]
    fn a_world_of_regions_is_solid_with_all_of_them() {
        let w = archipelago();
        let world = OpenWorld::on(w, w.region("emberholm").expect("Emberholm").zone());
        let count = |id: &str| w.region(id).expect("a region").zone().obstacles.len();
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
        let mut world = OpenWorld::on(w, w.region("emberholm").expect("Emberholm").zone());
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
        let file = r#"{ "chunk": 256, "sea": { "level": 0, "depth": 30 }, "regions": [
            { "id": "emberholm", "chunks": { "x": -3, "z": -3, "w": 6, "d": 6 } },
            { "id": "emberholm", "chunks": { "x": 2, "z": 0, "w": 2, "d": 2 } } ] }"#;
        let e = WorldMap::from_json(file, zone_recipe).err().expect("refused");
        assert!(e.contains("chunk (2, 0) is another region's"), "{e}");
    }
}
