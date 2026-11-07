//! The borders of a world of regions crossed on foot, by cart with a passenger, by boat and by
//! glider, the world split between two simulations at the border between its regions: each crossing
//! the same to the bit as in one simulation (no jump), every input run once (none lost), and
//! everyone and everything held by one simulation at a time (nothing twice). The worlds are
//! map.rs's fixtures: a mainland of two regions across a land border, and an islet across the sea
//! from Emberholm.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde_json::Value;

use super::messages::{Input, Post, Says};
use super::split::Split;
use super::{Owners, SimId};
use crate::checks::border::canon;
use crate::ids::EntityId;
use crate::jsmath::JsMath;
use crate::life::content::rideable;
use crate::life::{Life, vehicles};
use crate::open::Sim as Stepping;
use crate::open::colliders::ground_at;
use crate::open::map::{WorldMap, region_recipe};
use crate::open::zone::Recipe;
use crate::player::{Actions, Mode, Player};
use crate::world::Spawn;

/// A region two chunks a side round (`mid`, 0), its island round (`land`, 0) (as map.rs's tests
/// make them).
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

/// Two regions across a land border at x = 1536 m, one island grown half by each.
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
            _ => region_recipe(id),
        })
        .expect("a world")
    })
}

/// Emberholm and, across the sea to its east, an islet (x 1024 to 1536 m).
fn archipelago() -> &'static WorldMap {
    static W: OnceLock<WorldMap> = OnceLock::new();
    W.get_or_init(|| {
        let file = r#"{ "chunk": 256, "blend": 64, "sea": { "level": 0, "depth": 30 }, "regions": [
            { "id": "emberholm", "chunks": { "x": -3, "z": -3, "w": 6, "d": 6 } },
            { "id": "islet", "chunks": { "x": 4, "z": -1, "w": 2, "d": 2 } } ] }"#;
        WorldMap::from_json(file, |id| if id == "islet" { Some(small_region("islet", 7, 1280.0, 1280.0, 110.0, 6.0)) } else { region_recipe(id) })
            .expect("a world")
    })
}

const STEPS: u32 = 3;
const WEST: SimId = SimId(1);
const EAST: SimId = SimId(2);

fn client(slot: usize) -> EntityId {
    EntityId::character(slot as i64 + 1)
}

/// A world of `map`'s, one simulation or split at chunk `x` between WEST and EAST, the channel a
/// copy of `region`.
fn world(map: &'static WorldMap, region: &str, split_at: Option<i32>) -> Split {
    let zone = map.zone(map.region(region).expect("the region"));
    let owners = match split_at {
        Some(x) => Owners::split_x(map, x, WEST, EAST),
        None => Owners::one(map, WEST),
    };
    Split::new(map, zone, Some(&zone.terrain), owners, 50.0)
}

/// Someone standing on the ground at (x, z), facing `facing`, in `slot`, with a life of `region`'s.
#[allow(clippy::too_many_arguments)]
fn stand(s: &mut Split, map: &'static WorldMap, region: &str, slot: usize, x: f64, z: f64, facing: f64, with: Option<SimId>) {
    let zone = map.zone(map.region(region).expect("the region"));
    let index = &s.sims[0].world.index;
    let mut p = Player::new(Spawn { x, z, facing }, 0, crate::player::Build::default());
    p.pos.y = ground_at(map, index, x, z, map.height(x, z).max(map.water) + 1.2, 1.2);
    p.grounded = true;
    let mut life = Box::new(Life::new(zone, None, None));
    life.drain_events();
    s.join(slot, client(slot), slot as i64 + 1, p, life, with);
}

/// A vehicle summoned by the player in `slot` with `deed`, and boarded: its id.
fn drive_off(s: &mut Split, slot: usize, deed: &str) -> i64 {
    let at = s.owner_of(slot).expect("the driver");
    let sim = s.sim_mut(at);
    let (p, life) = sim.players.open_mut(client(slot)).expect("the driver");
    let life = life.expect("a life");
    life.give(deed, 1, true);
    let world = &sim.world;
    let id = vehicles::summon(life, &mut Stepping { player: p, world, owner: slot as i64 + 1 }, deed).expect("summoned");
    let v = life.land.vehicles.iter().find(|v| v.id == id).expect("the vehicle").clone();
    let (x, _, z) = vehicles::anchor_world(&v, &rideable(&v.def).seats[0]);
    p.pos.x = x + v.heading.js_cos();
    p.pos.z = z - v.heading.js_sin();
    assert!(vehicles::board(life, &mut Stepping { player: p, world, owner: slot as i64 + 1 }, id), "aboard");
    id
}

/// The player in `slot` climbs into the second seat of `host`'s vehicle `id`.
fn ride_along(s: &mut Split, slot: usize, host: usize, id: i64) {
    let at = s.owner_of(slot).expect("the passenger");
    let sim = s.sim_mut(at);
    let v = sim.players.vehicle_of(host as i64 + 1, id).expect("the vehicle beside them");
    let (x, _, z) = vehicles::anchor_world(&v, &rideable(&v.def).seats[1]);
    let p = sim.players.open_mut(client(slot)).expect("the passenger").0;
    p.pos.x = x - 1.2 * v.heading.js_cos();
    p.pos.z = z + 1.2 * v.heading.js_sin();
    assert!(sim.players.ride_along(client(slot), host as i64 + 1, id, "Driver"), "riding along");
}

/// How a crossing went: each tick's hash, and where each player stood and whose they were.
struct Crossed {
    split: Split,
    ticks: Vec<String>,
    /// Each tick, each player's (x, z), their owner and what they were doing.
    path: Vec<Vec<(f64, f64, SimId, Mode)>>,
}

/// Plays `ticks` ticks, everyone in `slots` pressing what `press` says for that tick, checking as
/// it goes that every input given was run once and that each of them is held by one simulation.
fn cross(s: Split, slots: &[usize], ticks: u64, press: impl Fn(u64, usize) -> Actions) -> Crossed {
    cross_with(s, slots, ticks, press, true, |_, _| {})
}

/// The same, `mail` seeing what's posted at the end of each tick before it's delivered (to lose a
/// handoff, or send it twice). Not `strict`, a player on their way between simulations is held by
/// none, and runs their inputs late, but never twice and never not at all.
fn cross_with(
    mut s: Split,
    slots: &[usize],
    ticks: u64,
    press: impl Fn(u64, usize) -> Actions,
    strict: bool,
    mut mail: impl FnMut(u64, &mut Vec<Post>),
) -> Crossed {
    let mut seq: BTreeMap<usize, u32> = slots.iter().map(|&k| (k, 0)).collect();
    let (mut hashes, mut path) = (Vec::new(), Vec::new());
    for tick in 1..=ticks {
        s.begin_tick(tick, f64::from(STEPS), 0.0);
        for &k in slots {
            let a = press(tick, k);
            let first = seq[&k] + 1;
            seq.insert(k, first + STEPS - 1);
            let held = Actions { attack_pressed: false, jump_pressed: false, slide_pressed: false, ability_slot: 0, movement_slot: 0, ..a };
            let inputs = (0..STEPS).map(|n| Input { seq: first + n, view: None, actions: if n == 0 { a } else { held } }).collect();
            s.queue(client(k), inputs);
        }
        let done = s.finish_tick();
        let canon: Value = canon(&mut s, &done);
        let h = crate::checks::crowd::fnv(0xcbf2_9ce4_8422_2325, &canon.to_string());
        hashes.push(format!("{h:016x}"));
        let mut here = Vec::new();
        for &k in slots {
            // Held by exactly one simulation, which has run every input it was given.
            let holders: Vec<SimId> = s.sims.iter().filter(|m| m.players.is_own(k)).map(|m| m.id).collect();
            if !strict && holders.is_empty() {
                continue;
            }
            assert_eq!(holders.len(), 1, "player {k} held by {holders:?} at tick {tick}");
            let sim = s.sim(holders[0]);
            let (p, last, _) = sim.players.open_view(client(k)).expect("the player");
            if strict {
                assert_eq!(last, seq[&k], "player {k}'s inputs run at tick {tick}");
            } else {
                assert!(last <= seq[&k], "player {k} ran inputs not given yet at tick {tick}");
            }
            here.push((p.pos.x, p.pos.z, holders[0], p.mode));
        }
        // Every vehicle out is one life's, once.
        let mut out: Vec<(i64, i64)> = Vec::new();
        for m in &s.sims {
            for (_, owner, _, life) in m.players.each_open() {
                out.extend(life.into_iter().flat_map(|l| l.land.vehicles.iter().map(move |v| (owner, v.id))));
            }
        }
        let n = out.len();
        out.sort();
        out.dedup();
        assert_eq!(out.len(), n, "a vehicle held twice at tick {tick}");
        path.push(here);
        s.end_tick();
        mail(tick, &mut s.mail);
    }
    Crossed { split: s, ticks: hashes, path }
}

/// The crossing played split and in one simulation: the same, tick for tick, and handed over once
/// each way it crossed.
fn the_same(one: &Crossed, split: &Crossed) {
    let parted = one.ticks.iter().zip(&split.ticks).position(|(a, b)| a != b);
    assert_eq!(parted, None, "the split world parted from one simulation's at tick {:?}", parted.map(|t| t + 1));
}

#[test]
fn on_foot_across_a_land_border() {
    let map = mainland();
    let run = |split_at| {
        let mut s = world(map, "fells", split_at);
        stand(&mut s, map, "fells", 0, 1490.0, 0.0, std::f64::consts::FRAC_PI_2, None);
        cross(s, &[0], 400, |_, _| Actions { move_x: 1.0, ..Actions::default() })
    };
    let (one, split) = (run(None), run(Some(6)));
    the_same(&one, &split);
    // Handed over once, 28 m into the downs, and never back.
    let owners: Vec<SimId> = split.path.iter().map(|t| t[0].2).collect();
    let at = owners.iter().position(|&o| o == EAST).expect("handed over");
    assert!(owners[at..].iter().all(|&o| o == EAST));
    let x = split.path[at - 1][0].0;
    assert!((1536.0 + 28.0..1536.0 + 31.0).contains(&x), "handed over at x = {x}");
}

/// Someone walking east across the mainland's border, split (or not), with what the gate and the
/// mail do to it.
fn walk_east(split_at: Option<i32>, lag: u64, strict: bool, mail: impl FnMut(u64, &mut Vec<Post>)) -> Crossed {
    let map = mainland();
    let mut s = world(map, "fells", split_at);
    s.gate.lag = lag;
    s.count = true;
    stand(&mut s, map, "fells", 0, 1490.0, 0.0, std::f64::consts::FRAC_PI_2, None);
    cross_with(s, &[0], 400, |_, _| Actions { move_x: 1.0, ..Actions::default() }, strict, mail)
}

#[test]
fn a_gate_that_hears_late_sends_inputs_to_the_old_owner_which_sends_them_on() {
    let one = walk_east(None, 0, true, |_, _| {});
    for lag in [1, 3] {
        let split = walk_east(Some(6), lag, true, |_, _| {});
        the_same(&one, &split);
        assert_eq!(split.split.counts.strays, lag, "a tick's inputs sent on for each tick the gate was late");
    }
}

#[test]
fn a_handoff_said_twice_is_taken_once() {
    let one = walk_east(None, 0, true, |_, _| {});
    let twice = |_: u64, mail: &mut Vec<Post>| {
        let again: Vec<Post> = mail.iter().filter(|p| matches!(p.says, Says::Handoff(_))).cloned().collect();
        mail.extend(again);
    };
    let split = walk_east(Some(6), 0, true, twice);
    the_same(&one, &split);
    assert_eq!(split.split.counts.handoffs, 2, "sent twice");
}

#[test]
fn a_handoff_lost_on_the_way_is_sent_again_and_nothing_is_lost_or_run_twice() {
    let mut lost = false;
    let lose_once = |_: u64, mail: &mut Vec<Post>| {
        if !lost && let Some(i) = mail.iter().position(|p| matches!(p.says, Says::Handoff(_))) {
            mail.remove(i);
            lost = true;
        }
    };
    let split = walk_east(Some(6), 0, false, lose_once);
    // On their way for a tick (held by nobody), then taken when it came again, and on east.
    let gap = split.path.iter().position(|t| t.is_empty()).expect("a tick on the way");
    assert_eq!(split.path[gap - 1][0].2, WEST);
    assert_eq!(split.path[gap + 1][0].2, EAST);
    assert_eq!(split.path.iter().filter(|t| t.is_empty()).count(), 1, "on the way for one tick");
    // Every input given was run or is still to be (none lost); none twice, as each runs past the last.
    let mut s = split.split;
    let d = s.sim_mut(EAST).players.depart(0).expect("the walker, east");
    let given = 400 * STEPS;
    let waiting: Vec<u32> = d.queue.iter().map(|q| q.0).collect();
    assert_eq!(d.last_seq + waiting.len() as u32, given, "run {} and waiting {waiting:?}", d.last_seq);
    assert!(waiting.iter().zip(waiting.iter().skip(1)).all(|(a, b)| b == &(a + 1)) && waiting.first().is_none_or(|&f| f == d.last_seq + 1));
}

#[test]
fn what_is_said_under_an_older_epoch_is_refused() {
    let crossed = walk_east(Some(6), 0, true, |_, _| {});
    let mut s = crossed.split;
    let (west, east) = (s.sim(WEST), s.sim(EAST));
    assert_eq!((west.epochs[&0], east.epochs[&0]), (super::Epoch(1), super::Epoch(1)), "handed over once");
    let ghost = west.players.player(0).expect("the walker's ghost, west").clone();
    // A ghost of them said under the epoch before the handoff: refused.
    let mut stale = ghost.clone();
    stale.pos.x = 0.0;
    let old = super::messages::GhostPlayer { slot: 0, client: client(0), owner: 1, epoch: super::Epoch(0), player: stale, vehicles: Vec::new(), history: None };
    s.sim_mut(WEST).take_ghosts(EAST, super::messages::Ghosts { players: vec![old.clone()], ..Default::default() });
    assert_eq!(s.sim(WEST).players.player(0).expect("still seen").pos.x, ghost.pos.x);
    // And handed over under it again: refused, nobody seated twice.
    let d = s.sim_mut(EAST).players.depart(0).expect("the walker");
    let mut back = super::messages::Moving::of(d, super::Epoch(0), None);
    back.player.pos.x = 1700.0;
    let t = s.sim_mut(WEST).take_handoff(super::messages::Handoff { players: vec![back] });
    assert!(t.players.is_empty() && !s.sim(WEST).players.is_own(0));
}

#[test]
fn by_cart_with_a_passenger_across_a_land_border() {
    let map = mainland();
    let run = |split_at| {
        let mut s = world(map, "fells", split_at);
        stand(&mut s, map, "fells", 0, 1470.0, CART_Z, std::f64::consts::FRAC_PI_2, None);
        let id = drive_off(&mut s, 0, "deed.farmCart");
        let with = s.owner_of(0);
        stand(&mut s, map, "fells", 1, 1468.0, CART_Z + 3.0, 0.0, with);
        ride_along(&mut s, 1, 0, id);
        let c = cross(s, &[0, 1], 420, |_, k| if k == 0 { Actions { stick_y: 1.0, ..Actions::default() } } else { Actions::default() });
        (c, id)
    };
    let ((one, _), (split, id)) = (run(None), run(Some(6)));
    the_same(&one, &split);
    // The driver and the passenger went over together, in the same tick, and the cart with them.
    let owners: Vec<(SimId, SimId)> = split.path.iter().map(|t| (t[0].2, t[1].2)).collect();
    assert!(owners.iter().all(|(a, b)| a == b), "apart: {owners:?}");
    let at = owners.iter().position(|o| o.0 == EAST).expect("handed over");
    let x = split.path[at - 1][0].0;
    assert!((1536.0 + 28.0..1536.0 + 31.0).contains(&x), "handed over at x = {x}");
    let east = split.split.sim(EAST);
    let (driver, _, life) = east.players.open_view(client(0)).expect("the driver");
    let v = life.expect("a life").land.vehicles.iter().find(|v| v.id == id).expect("the cart, with its driver's life");
    assert!(v.x > 1564.0 && driver.vehicle == id, "the cart at {}", v.x);
    let p = east.players.open_view(client(1)).expect("the passenger").0;
    assert_eq!((p.mode, p.host, p.vehicle), (Mode::Ride, 1, id));
}

/// Where the cart crosses (it brushes a tree on the way, 15 m short of the border).
const CART_Z: f64 = 0.0;

#[test]
fn by_glider_across_a_land_border() {
    let map = mainland();
    let run = |split_at| {
        let mut s = world(map, "fells", split_at);
        stand(&mut s, map, "fells", 0, 1500.0, 0.0, std::f64::consts::FRAC_PI_2, None);
        // High over the fells, both jumps spent, the wayfarer on their back: jump to open it.
        let at = s.owner_of(0).expect("the glider");
        let (p, life) = s.sim_mut(at).players.open_mut(client(0)).expect("the glider");
        life.expect("a life").state.glider = "wayfarer".into();
        p.glider = "wayfarer".into();
        p.pos.y += 40.0;
        p.grounded = false;
        p.jumps_used = 2;
        let east = Actions { move_x: 1.0, ..Actions::default() };
        cross(s, &[0], 200, move |tick, _| if tick == 2 { Actions { jump_pressed: true, jump_held: true, ..east } } else { east })
    };
    let (one, split) = (run(None), run(Some(6)));
    the_same(&one, &split);
    let owners: Vec<SimId> = split.path.iter().map(|t| t[0].2).collect();
    let at = owners.iter().position(|&o| o == EAST).expect("handed over");
    let x = split.path[at - 1][0].0;
    assert!((1536.0 + 28.0..1536.0 + 34.0).contains(&x), "handed over at x = {x}");
    // In the air as it crossed: the glider open on both sides of the handoff.
    assert_eq!((split.path[at - 1][0].3, split.path[at][0].3), (Mode::Glide, Mode::Glide));
    assert!(split.path[at][0].0 > x, "on the way east");
    let p = split.split.sim(owners[owners.len() - 1]).players.player(0).expect("the glider").clone();
    assert!(p.pos.x > 1600.0, "glided on to {}", p.pos.x);
}

#[test]
fn by_boat_across_the_sea() {
    let map = archipelago();
    // The islet's west shore, where the water gets deep enough for a boat.
    let mut shore = 1280.0;
    while map.height(shore, 0.0) > map.water + 0.3 {
        shore -= 0.5;
    }
    let run = |split_at| {
        let mut s = world(map, "islet", split_at);
        stand(&mut s, map, "islet", 0, shore + 3.0, 0.0, -std::f64::consts::FRAC_PI_2, None);
        let id = drive_off(&mut s, 0, "deed.rowboat");
        let with = s.owner_of(0);
        stand(&mut s, map, "islet", 1, shore + 4.0, 2.0, 0.0, with);
        ride_along(&mut s, 1, 0, id);
        let row = Actions { stick_y: 1.0, ..Actions::default() };
        let c = cross(s, &[0, 1], 1400, move |_, k| if k == 0 { row } else { Actions::default() });
        (c, id)
    };
    let ((one, _), (split, id)) = (run(None), run(Some(4)));
    the_same(&one, &split);
    let owners: Vec<(SimId, SimId)> = split.path.iter().map(|t| (t[0].2, t[1].2)).collect();
    assert!(owners.iter().all(|(a, b)| a == b), "apart: {owners:?}");
    let at = owners.iter().position(|o| o.0 == WEST).expect("handed over");
    let x = split.path[at - 1][0].0;
    assert!((1024.0 - 31.0..=1024.0 - 28.0).contains(&x), "handed over at x = {x}");
    let west = split.split.sim(WEST);
    let (rower, _, life) = west.players.open_view(client(0)).expect("the rower");
    let v = life.expect("a life").land.vehicles.iter().find(|v| v.id == id).expect("the boat, with its owner's life");
    assert!(v.x < 996.0 && rower.vehicle == id, "the boat at {}", v.x);
    let p = west.players.open_view(client(1)).expect("the passenger").0;
    assert_eq!((p.mode, p.host, p.vehicle), (Mode::Ride, 1, id));
}
