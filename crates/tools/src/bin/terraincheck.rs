//! Prints the engine's region for tests/conformance/terrain.test.ts to check against the browser's:
//!   terraincheck            stdin [[x, z], ...] -> stdout [[height, slope, surface], ...]
//!   terraincheck --zone     stdout: Emberholm as the engine grows it from its recipe where the world
//!                           places it, all of it
//!                           (ground, colliders, roads, ramps, placements, waterfalls, buildings)
//!   terraincheck --world <fixture>
//!                           stdin [[x, z], ...] -> stdout [[height, slope, surface], ...] across the
//!                           regions of a fixture world of the tests' (tests/fixtures/world/<fixture>.json),
//!                           for tests/conformance/world.test.ts
use std::io::Read;

use ruina_engine::open::fixture;
use ruina_engine::open::map::world_map;
use ruina_engine::open::zone::{emberholm, emberholm_recipe};
use serde_json::json;

fn main() {
    if std::env::args().any(|a| a == "--zone") {
        let g = world_map().generate(&emberholm_recipe());
        let t = &g.terrain;
        let out = json!({
            "cells": t.cells,
            "cell": t.cell,
            "water": t.water,
            "minX": t.min_x,
            "minZ": t.min_z,
            "heights": t.heights(),
            "surface": t.surface,
            "clear": g.clear,
            "obstacles": g.obstacles,
            "boxes": g.boxes,
            "decks": g.decks,
            "roads": g.roads,
            "ramps": g.ramps,
            "placements": g.placements,
            "falls": g.falls,
            "buildings": g.buildings,
        });
        println!("{out}");
        return;
    }
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).expect("read points from stdin");
    let points: Vec<[f64; 2]> = serde_json::from_str(&raw).expect("stdin is [[x, z], ...]");
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--world") {
        let w = match args.get(i + 1).map(String::as_str) {
            Some("far") => fixture::far(),
            _ => fixture::world(),
        };
        let out: Vec<(f64, f64, u8)> = points.iter().map(|[x, z]| (w.height(*x, *z), w.slope(*x, *z), w.surface_at(*x, *z))).collect();
        println!("{}", serde_json::to_string(&out).unwrap());
        return;
    }
    let t = &emberholm().terrain;
    let out: Vec<(f64, f64, u8)> = points.iter().map(|[x, z]| (t.height(*x, *z), t.slope(*x, *z), t.surface_at(*x, *z))).collect();
    println!("{}", serde_json::to_string(&out).unwrap());
}
