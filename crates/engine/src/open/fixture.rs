//! The tests' worlds (tests/fixtures/world/): files in the shape of shared/world.json and
//! shared/regions/<id>.json, built in here for the engine's tests and, with the `fixture-world`
//! feature, for other crates' (the server's borders and simulations).
//!
//! - `world()`: three regions. Emberholm round the origin, as it is in the game; Saltmere across a
//!   chunk of open sea to its west (x 1024 to 2048 m); Thornmarch beside Saltmere across a land
//!   border at x = 2048 m, one island grown half by each from its own recipe.
//! - `far()`: Emberholm, and Farholt, a small flat isle 102 km to its west, for drawing far from the
//!   origin.
//!
//! The browser plays them through the same files: given to its engines in place of shared/ before
//! they read anything (`bundles`, the WebAssembly's content_use; ?fixture=world on a development
//! server).

use std::collections::BTreeMap;
use std::sync::OnceLock;

use super::map::{WorldMap, region_recipe};
use super::zone::Recipe;

const WORLD: &str = include_str!("../../../../tests/fixtures/world/world.json");
const FAR: &str = include_str!("../../../../tests/fixtures/world/far.json");
/// The fixture regions' recipes, by id; the rest (Emberholm) are the game's own.
const REGIONS: &[(&str, &str)] = &[
    ("saltmere", include_str!("../../../../tests/fixtures/world/regions/saltmere.json")),
    ("thornmarch", include_str!("../../../../tests/fixtures/world/regions/thornmarch.json")),
    ("farholt", include_str!("../../../../tests/fixtures/world/regions/farholt.json")),
];

/// The x of the land border between Saltmere and Thornmarch.
pub const LAND_BORDER: f64 = 2048.0;
/// The x of the open sea's border with Saltmere (Emberholm's west edge is a chunk nearer, at 768 m).
pub const SEA_BORDER: f64 = 1024.0;

/// A region's recipe in the tests' worlds: a fixture region's, or the game's own.
pub fn recipe(id: &str) -> Option<Recipe> {
    match REGIONS.iter().find(|(r, _)| *r == id) {
        Some((_, text)) => Some(serde_json::from_str(text).unwrap_or_else(|e| panic!("tests/fixtures/world/regions/{id}.json is a region's recipe: {e}"))),
        None => region_recipe(id),
    }
}

/// The three regions: Emberholm, Saltmere across the sea, Thornmarch across a land border.
pub fn world() -> &'static WorldMap {
    static W: OnceLock<WorldMap> = OnceLock::new();
    W.get_or_init(|| WorldMap::from_json(WORLD, recipe).unwrap_or_else(|e| panic!("tests/fixtures/world/world.json: {e}")))
}

/// Emberholm, and Farholt 102 km away.
pub fn far() -> &'static WorldMap {
    static W: OnceLock<WorldMap> = OnceLock::new();
    W.get_or_init(|| WorldMap::from_json(FAR, recipe).unwrap_or_else(|e| panic!("tests/fixtures/world/far.json: {e}")))
}

/// What to give a whole engine in place of shared/ (crate::bundles::give, the WebAssembly's
/// content_use) for it to play a fixture world (`world` or `far`): its world.json, and the fixture
/// regions' recipes.
pub fn bundles(which: &str) -> Option<BTreeMap<String, String>> {
    let world = match which {
        "world" => WORLD,
        "far" => FAR,
        _ => return None,
    };
    let mut out = BTreeMap::from([("world.json".to_string(), world.to_string())]);
    for (id, text) in REGIONS {
        out.insert(format!("regions/{id}.json"), (*text).to_string());
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use std::f64::consts::FRAC_PI_2;

    use super::*;
    use crate::actors::Actors;
    use crate::combat::Players;
    use crate::jsmath::len;
    use crate::life::{Life, vehicles};
    use crate::open::colliders::ground_at;
    use crate::open::{OpenWorld, Sim, step_player};
    use crate::player::{Actions, Build, Mode, Player};
    use crate::world::{Spawn, World};

    /// How far round the player the browser holds regions (src/app/regions.ts GROW).
    const REACH: f64 = 600.0;

    fn place(w: &WorldMap, id: &str) -> usize {
        w.place_of(id).expect("a region of the fixture world")
    }

    fn region_of(w: &WorldMap, x: f64, z: f64) -> Option<&str> {
        w.region_at(x, z).map(|r| r.id.as_str())
    }

    /// Emberholm's zone: the region lives belong to in the fixture world, as in the game.
    fn home() -> &'static super::super::zone::Zone {
        let w = world();
        w.zone(w.region("emberholm").expect("Emberholm"))
    }

    /// A world holding only what's near (x, z), as the browser holds it round the player.
    fn near(x: f64, z: f64) -> OpenWorld {
        let w = world();
        let mut o = OpenWorld::playing(w, home(), &[], 0.0);
        o.hold(&w.near(x, z, REACH));
        o
    }

    /// Someone standing (or swimming) at (x, z), facing west (+x).
    fn standing(o: &OpenWorld, x: f64, z: f64) -> Player {
        let mut p = Player::new(Spawn { x, z, facing: FRAC_PI_2 }, 0, Build::default());
        let hf = o.terrain();
        p.pos.y = ground_at(hf, &o.index, x, z, hf.height(x, z).max(hf.water), 1.2);
        p.grounded = true;
        p
    }

    /// Steps `p` with `a` until `done` (at most `frames` steps), the world holding what's near them
    /// as they go, as the browser does: every step's position, and how many regions were grown on
    /// the spot (ground asked for that wasn't held).
    fn travel(o: &mut OpenWorld, p: &mut Player, a: &Actions, frames: usize, mut done: impl FnMut(&Player) -> bool) -> Vec<(u64, u64, u64)> {
        let mut path = Vec::new();
        for _ in 0..frames {
            let want = o.map.near(p.pos.x, p.pos.z, REACH);
            if want != o.held() {
                o.hold(&want);
            }
            step_player(p, a, o, None, 0);
            path.push((p.pos.x.to_bits(), p.pos.y.to_bits(), p.pos.z.to_bits()));
            if done(p) {
                break;
            }
        }
        path
    }

    #[test]
    fn the_fixture_world_stands_as_its_file_says() {
        let w = world();
        assert_eq!(w.regions().iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["emberholm", "saltmere", "thornmarch"]);
        assert_eq!(region_of(w, 0.0, 0.0), Some("emberholm"));
        assert_eq!(region_of(w, 900.0, 0.0), None, "a chunk of open sea between Emberholm and Saltmere");
        assert_eq!(region_of(w, SEA_BORDER + 1.0, 0.0), Some("saltmere"));
        assert_eq!(region_of(w, LAND_BORDER + 1.0, 0.0), Some("thornmarch"));
        // Emberholm is the game's, to the bit.
        assert_eq!(home().terrain.heights(), super::super::zone::emberholm().terrain.heights());
        // Land either side of the land border, sea between Emberholm and Saltmere.
        assert!(w.height(LAND_BORDER - 20.0, 0.0) > w.water && w.height(LAND_BORDER + 20.0, 0.0) > w.water);
        assert!(w.height(SEA_BORDER, 0.0) < w.water - 10.0);
        // Its borders meet with no seam.
        let (s, t) = (&w.zone(w.region("saltmere").expect("s")).terrain, &w.zone(w.region("thornmarch").expect("t")).terrain);
        for j in 0..s.n {
            assert_eq!(s.heights()[j * s.n + s.n - 1].to_bits(), t.heights()[j * t.n].to_bits(), "row {j}");
        }
        // The far world's isle stands 102 km out.
        let f = far();
        assert_eq!(region_of(f, 102_656.0, 0.0), Some("farholt"));
        assert!(f.height(102_656.0, 0.0) > f.water, "dry land in its middle");
        assert!(bundles("world").is_some_and(|b| b.contains_key("world.json") && b.contains_key("regions/thornmarch.json")));
    }

    #[test]
    fn you_walk_across_the_land_border_with_nothing_grown_on_the_spot() {
        let w = world();
        let x0 = LAND_BORDER - 70.0;
        let mut o = near(x0, 0.0);
        let mut p = standing(&o, x0, 0.0);
        let west = Actions { move_x: 1.0, ..Default::default() };
        let path = travel(&mut o, &mut p, &west, 60 * 60, |p| p.pos.x > LAND_BORDER + 70.0 || p.mode == Mode::Swim);
        assert_ne!(p.mode, Mode::Swim, "on foot all the way: {:?}", p.pos);
        assert_eq!(region_of(w, p.pos.x, p.pos.z), Some("thornmarch"), "walked into Thornmarch: {:?}", p.pos);
        assert_eq!(o.map.unheld(), 0, "every step's ground was held before it was reached");
        // The same steps as in the world grown whole, to the bit.
        let mut whole = OpenWorld::on(w, home());
        let mut q = standing(&whole, x0, 0.0);
        let mut same = Vec::new();
        for _ in 0..path.len() {
            step_player(&mut q, &west, &whole, None, 0);
            same.push((q.pos.x.to_bits(), q.pos.y.to_bits(), q.pos.z.to_bits()));
        }
        assert_eq!(path, same);
        whole.hold(&[]);
    }

    #[test]
    fn you_swim_from_emberholm_across_the_open_sea_to_saltmere() {
        let w = world();
        // Off Emberholm's west coast, swimming west.
        let x0 = 560.0;
        let mut o = near(x0, 0.0);
        let mut p = standing(&o, x0, 0.0);
        assert!(w.depth(x0, 0.0) > 1.0, "in the water off Emberholm");
        let west = Actions { move_x: 1.0, sprint_held: true, ..Default::default() };
        let mut swam = false;
        travel(&mut o, &mut p, &west, 60 * 400, |p| {
            swam |= p.mode == Mode::Swim;
            swam && p.mode != Mode::Swim && p.pos.x > SEA_BORDER
        });
        assert!(swam, "swam");
        assert_eq!(region_of(w, p.pos.x, p.pos.z), Some("saltmere"), "ashore on Saltmere: {:?}, {:?}", p.pos, p.mode);
        assert_ne!(p.mode, Mode::Swim);
        assert_eq!(o.map.unheld(), 0);
        // Emberholm was dropped behind on the way: nothing within reach of Saltmere's shore holds it.
        assert!(!o.map.holds(place(w, "emberholm")) || p.pos.x < 768.0 + REACH);
    }

    #[test]
    fn you_glide_across_the_land_border() {
        let w = world();
        let (x0, z0) = (LAND_BORDER - 60.0, 0.0);
        let mut o = near(x0, z0);
        let mut p = standing(&o, x0, z0);
        // Up in the air over Saltmere with a glider, both jumps spent: a third press opens it.
        p.glider = "wayfarer".into();
        p.pos.y += 40.0;
        p.grounded = false;
        p.jumps_used = 2;
        let jump = Actions { jump_pressed: true, jump_held: true, ..Default::default() };
        travel(&mut o, &mut p, &jump, 3, |p| p.mode == Mode::Glide);
        assert_eq!(p.mode, Mode::Glide, "the glider is open");
        let west = Actions { move_x: 1.0, ..Default::default() };
        let mut crossed_gliding = false;
        travel(&mut o, &mut p, &west, 60 * 30, |p| {
            crossed_gliding |= p.mode == Mode::Glide && p.pos.x > LAND_BORDER;
            crossed_gliding
        });
        assert!(crossed_gliding, "glided over the border: {:?}, {:?}", p.pos, p.mode);
        assert_eq!(region_of(w, p.pos.x, p.pos.z), Some("thornmarch"));
        assert_eq!(o.map.unheld(), 0);
    }

    #[test]
    fn a_cart_with_a_passenger_drives_across_the_land_border() {
        let w = world();
        let (x0, z0) = (LAND_BORDER - 90.0, 0.0);
        let mut open = near(x0, z0);
        let flat = World { radius: 1e6, obstacles: Vec::new(), team_spawns: [Spawn { x: x0, z: z0, facing: 0.0 }; 2] };
        let mut players = Players::new(50.0);
        // The driver and a friend standing beside them.
        let driver = standing(&open, x0, z0);
        let friend = standing(&open, x0, z0 + 3.0);
        players.join_open(1, 1, driver, Box::new(Life::new(home(), None, None)));
        players.join_open(2, 2, friend, Box::new(Life::new(home(), None, None)));
        let (p, life) = players.open_mut(1).expect("the driver");
        let life = life.expect("a life");
        life.give("deed.farmCart", 1, true);
        let id = vehicles::summon(life, &mut Sim { player: p, world: &open, owner: 1 }, "deed.farmCart").expect("a cart");
        // Turned to face west, the driver in its seat.
        let v = life.state.vehicles.iter_mut().find(|v| v.id == id).expect("the cart");
        (v.x, v.z, v.heading) = (x0, z0, FRAC_PI_2);
        assert!(vehicles::board(life, &mut Sim { player: p, world: &open, owner: 1 }, id), "in the driver's seat");
        let (fx, fz) = {
            let v = players.vehicle_of(1, id).expect("the cart");
            let (sx, _, sz) = vehicles::anchor_world(&v, &crate::life::content::rideable(&v.def).seats[1]);
            (sx, sz)
        };
        let p = players.open_mut(2).expect("the friend").0;
        (p.pos.x, p.pos.z) = (fx, fz);
        assert!(players.ride_along(2, 1, id, "Driver"), "riding along");
        let mut actors = Actors::new();
        let (mut seq, steps) = (0u32, 3u32);
        let go = Actions { stick_y: 1.0, ..Default::default() };
        for tick in 1..=600u64 {
            let at = players.vehicle_of(1, id).expect("the cart");
            let want = open.map.near(at.x, at.z, REACH);
            if want != open.held() {
                open.hold(&want);
            }
            players.inputs_per_tick = f64::from(steps);
            players.gather_movers(&mut open);
            let (first, held) = (seq + 1, Actions { jump_pressed: false, ..go });
            seq += steps;
            players.queue_actions(1, (0..steps).map(|n| (first + n, 0.0, if n == 0 { go } else { held })));
            players.queue_actions(2, (0..steps).map(|n| (first + n, 0.0, Actions::default())));
            players.step_in(&mut actors, &flat, tick, Some(&mut open));
            players.seat_passengers(&open);
            if at.x > LAND_BORDER + 60.0 {
                break;
            }
        }
        let cart = players.vehicle_of(1, id).expect("the cart");
        assert_eq!(region_of(w, cart.x, cart.z), Some("thornmarch"), "the cart drove into Thornmarch: {:?}", (cart.x, cart.z));
        let (friend, _, _) = players.open_view(2).expect("the friend");
        assert_eq!((friend.mode, friend.host, friend.vehicle), (Mode::Ride, 1, id), "still riding along");
        assert!(len(friend.pos.x - cart.x, friend.pos.z - cart.z) < 3.0, "in the cart: {:?} and {:?}", friend.pos, (cart.x, cart.z));
        assert_eq!(region_of(w, friend.pos.x, friend.pos.z), Some("thornmarch"));
        assert_eq!(open.map.unheld(), 0);
    }

    #[test]
    fn a_region_dropped_behind_and_grown_again_ahead_is_the_same() {
        // A fresh copy of the fixture world, nothing grown in it: Saltmere, then Thornmarch ahead with
        // Saltmere let go behind, then back to Saltmere, grown again.
        let fresh = WorldMap::from_json(WORLD, recipe).expect("the fixture world");
        let (s, t) = (place(&fresh, "saltmere"), place(&fresh, "thornmarch"));
        let print = |z: &super::super::zone::Zone| {
            (z.terrain.heights().iter().map(|h| h.to_bits()).collect::<Vec<_>>(), z.clear.clone(), z.obstacles.len(), z.boxes.len(), z.decks.len())
        };
        let mut v = fresh.view();
        v.hold(&[s]);
        let first = print(&v.held_region(s).expect("held").zone);
        v.hold(&[t]);
        let ahead = print(&v.held_region(t).expect("held").zone);
        v.hold(&[s]);
        assert_eq!(fresh.grows(s), 2, "grown again after being let go");
        // Thornmarch's edges were grown for Saltmere first (kept for the world), then it whole.
        assert_eq!(fresh.grows(t), 2);
        assert_eq!(print(&v.held_region(s).expect("held").zone), first);
        // And the same as in the world grown whole, in whatever order its tests grew it.
        let whole = world();
        assert_eq!(print(whole.zone(whole.region("saltmere").expect("s"))), first);
        assert_eq!(print(whole.zone(whole.region("thornmarch").expect("t"))), ahead);
    }
}
