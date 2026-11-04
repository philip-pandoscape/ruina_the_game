//! Carts, cars, boats and mounts (src/sim/life/vehicles.ts). Wheeled things keep their own world
//! velocity and only grip the road sideways, so a handbrake turn really slides; boats sail on
//! whatever wind is blowing and run aground in the shallows; mounts move like you do, faster, and
//! turn like an animal does.
//!
//! The browser predicts its own rides with the TypeScript, so this follows it line for line: the
//! same steps in the same order, with the arithmetic written the same way. The TypeScript hands
//! vehicles around as objects; here they stay inside life.state and are named by id (or index).

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::f64::consts::PI;

use super::content::{self, item_def, js_sign, rideable, Anchor, ItemDef, RideableDef, js_hypot as hypot};
use super::state::Vehicle;
use super::weather::storm_at;
use super::{step_seconds, Life, QuestEvent};
use crate::open::colliders::{ground_at, push_out_of_box};
use crate::open::zone::{surface, to_local, to_world, Heightfield};
use crate::open::Sim;
use crate::player::{angle_diff, Actions, Mode};
use crate::tuning::tuning;

const TAU: f64 = PI * 2.0;
const G: f64 = 9.81 * 1.6;

fn wrap(a: f64) -> f64 {
    if a > PI {
        a - TAU
    } else if a < -PI {
        a + TAU
    } else {
        a
    }
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// A number as a JavaScript condition: anything but 0 and NaN.
fn truthy(a: f64) -> bool {
    a != 0.0 && !a.is_nan()
}

/// JavaScript's `a || b` on numbers.
fn or(a: f64, b: f64) -> f64 {
    if truthy(a) {
        a
    } else {
        b
    }
}

/// src/sim/math.ts len(): a plain square root.
fn len(x: f64, z: f64) -> f64 {
    (x * x + z * z).sqrt()
}

/// src/sim/math.ts turnToward().
fn turn_toward(current: f64, target: f64, max_step: f64) -> f64 {
    let d = angle_diff(current, target);
    let next = current + (-max_step).max(max_step.min(d));
    next.sin().atan2(next.cos())
}

/// Index of the vehicle with this id in life.state.vehicles (TS vehicleById).
pub fn vehicle_index(life: &Life, id: i64) -> Option<usize> {
    life.state.vehicles.iter().position(|v| v.id == id)
}

/// Index of the vehicle the player is riding, if any (TS ridden).
pub fn ridden(life: &Life, sim: &Sim) -> Option<usize> {
    if sim.player.vehicle != 0 { vehicle_index(life, sim.player.vehicle) } else { None }
}

/// A point given in the vehicle's own frame, out in the world.
pub fn anchor_world(v: &Vehicle, a: &Anchor) -> (f64, f64, f64) {
    let (ox, oz) = to_world(a.x, a.z, v.heading);
    (v.x + ox, v.y + a.y - a.z * v.pitch.sin() + a.x * v.roll.sin(), v.z + oz)
}

// ---------- Summoning ----------

fn clear_at(sim: &Sim, x: f64, z: f64, r: f64) -> bool {
    let mut ok = true;
    sim.world.index.each_obstacle(x, z, r + 1.0, |o| {
        if o.r > 0.0 && hypot(o.x - x, o.z - z) < o.r + r {
            ok = false;
        }
    });
    sim.world.index.each_box(x, z, r + 1.0, |b| {
        if b.top > -1e9 && push_out_of_box(b, x, z, r).is_some() {
            ok = false;
        }
    });
    ok
}

/// Where a summoned vehicle appears and which way it faces.
#[derive(Clone, Copy, Debug)]
struct Spot {
    x: f64,
    z: f64,
    heading: f64,
}

/// A place for a land vehicle near you: level, dry, unobstructed.
fn land_spot(sim: &Sim, def: &RideableDef) -> Option<Spot> {
    let p = &*sim.player;
    let hf = sim.terrain();
    for dist in [3.5, 5.0, 7.0, 9.0] {
        for k in 0..12 {
            let a = p.facing + (if k % 2 != 0 { 1.0 } else { -1.0 }) * (k as f64 / 2.0).ceil() * (PI / 6.0);
            let x = p.pos.x + a.sin() * (dist + def.radius);
            let z = p.pos.z + a.cos() * (dist + def.radius);
            if !hf.inside(x, z, 10.0) {
                continue;
            }
            if hf.water - hf.height(x, z) > 0.2 {
                continue;
            }
            if hf.slope(x, z) > 0.5 {
                continue;
            }
            if (hf.height(x, z) - p.pos.y).abs() > 3.0 {
                continue;
            }
            if !clear_at(sim, x, z, def.radius) {
                continue;
            }
            return Some(Spot { x, z, heading: p.facing });
        }
    }
    None
}

/// A place for a boat: the nearest water deep enough, pointing away from the shore.
fn water_spot(sim: &Sim, def: &RideableDef) -> Option<Spot> {
    let p = &*sim.player;
    let hf = sim.terrain();
    let need = def.draft + 0.5;
    let mut dist = 3.0;
    while dist <= 48.0 {
        let mut best: Option<Spot> = None;
        let mut best_depth = 0.0;
        for k in 0..24 {
            let a = (k as f64 / 24.0) * TAU;
            let x = p.pos.x + a.sin() * (dist + def.radius);
            let z = p.pos.z + a.cos() * (dist + def.radius);
            if !hf.inside(x, z, 20.0) {
                continue;
            }
            let depth = hf.water - hf.height(x, z);
            if depth < need {
                continue;
            }
            // The whole hull must float: check bow and stern too.
            let (gx, gz) = hf.gradient(x, z);
            let heading = (-gx).atan2(-gz); // downhill = out to sea
            let bow = hf.water - hf.height(x + heading.sin() * def.length * 0.5, z + heading.cos() * def.length * 0.5);
            let stern = hf.water - hf.height(x - heading.sin() * def.length * 0.5, z - heading.cos() * def.length * 0.5);
            if bow < def.draft || stern < def.draft {
                continue;
            }
            if !clear_at(sim, x, z, def.radius * 0.8) {
                continue;
            }
            if depth > best_depth {
                best_depth = depth;
                best = Some(Spot { x, z, heading });
            }
        }
        if best.is_some() {
            return best;
        }
        dist += 3.0;
    }
    None
}

/// Puts a new vehicle in the world. Returns its id.
fn spawn_vehicle(life: &mut Life, def: &RideableDef, at: Spot, y: f64) -> i64 {
    let v = Vehicle {
        id: life.next_id(),
        def: def.id.clone(),
        x: at.x,
        y,
        z: at.z,
        heading: at.heading,
        vx: 0.0,
        vy: 0.0,
        vz: 0.0,
        speed: 0.0,
        steer: 0.0,
        throttle: 0.0,
        sail: 0.0,
        grounded: true,
        pitch: 0.0,
        roll: 0.0,
        hp: def.hp,
        cargo: vec![0; def.cargo.len()],
        ridden: false,
        swimming: false,
        storm_warned: None,
    };
    let id = v.id;
    life.state.vehicles.push(v);
    life.revision += 1;
    id
}

/// Calls the vehicle (or mount) a deed or whistle in your bag stands for. Returns its id.
pub fn summon(life: &mut Life, sim: &mut Sim, item: &str) -> Option<i64> {
    let it = item_def(item);
    let id = it.vehicle.as_deref().or(it.mount.as_deref()).unwrap_or("");
    if id.is_empty() || life.count(item) < 1 {
        return None;
    }
    let def = rideable(id);
    if sim.player.mode != Mode::Normal || !sim.player.grounded {
        life.toast("Stand on solid ground to summon", "bad");
        return None;
    }
    let fixing = life.state.repairs.as_ref().and_then(|r| r.get(&def.id)).copied().unwrap_or(0.0);
    if fixing > life.state.clock {
        let left = (fixing - life.state.clock).ceil();
        life.toast(format!("Your {} is still being repaired ({left}s)", def.name.to_lowercase()), "bad");
        return None;
    }
    let existing = life.state.vehicles.iter().find(|v| v.def == def.id).map(|v| (v.id, v.cargo.iter().any(|&c| c != 0)));
    if let Some((existing, loaded)) = existing {
        if loaded {
            life.toast(format!("Your {} still has cargo aboard - go to it", def.name), "bad");
            return None;
        }
        recall(life, sim, existing, true);
    }
    let hf = sim.terrain();
    let spot = if def.is_boat() { water_spot(sim, def) } else { land_spot(sim, def) };
    let Some(spot) = spot else {
        life.toast(if def.is_boat() { "No water deep enough nearby - go down to the shore" } else { "No room here" }, "bad");
        return None;
    };
    let y = if def.is_boat() { hf.water } else { ground_at(hf, &sim.world.index, spot.x, spot.z, hf.height(spot.x, spot.z) + 1.0, 0.6) };
    let v = spawn_vehicle(life, def, spot, y);
    life.toast(format!("{} {} summoned", def.icon, def.name), "good");
    life.notify(QuestEvent { vehicle: Some(def.id.clone()), ..QuestEvent::new("summon") });
    Some(v)
}

pub fn recall(life: &mut Life, sim: &mut Sim, id: i64, quiet: bool) -> bool {
    let Some(i) = vehicle_index(life, id) else { return false };
    let v = &life.state.vehicles[i];
    let (busy, loaded) = (v.ridden || sim.player.vehicle == id, v.cargo.iter().any(|&c| c != 0));
    if busy {
        if !quiet {
            life.toast("Get out first", "bad");
        }
        return false;
    }
    if loaded {
        if !quiet {
            life.toast("Unload the cargo first", "bad");
        }
        return false;
    }
    life.state.vehicles.retain(|x| x.id != id);
    life.revision += 1;
    true
}

// ---------- Getting in and out ----------

pub fn board(life: &mut Life, sim: &mut Sim, id: i64) -> bool {
    let Some(i) = vehicle_index(life, id) else { return false };
    let def = rideable(&life.state.vehicles[i].def);
    if def.is_mount() && sim.player.pack != 0 && !def.can_carry_pack {
        life.toast(format!("Your {} won't carry a trade pack - a donkey will", def.name.to_lowercase()), "bad");
        return false;
    }
    if sim.player.mode != Mode::Normal && sim.player.mode != Mode::Swim {
        return false;
    }
    let v = &mut life.state.vehicles[i];
    v.ridden = true;
    let p = &mut *sim.player;
    p.mode = Mode::Ride;
    p.vehicle = v.id;
    p.seat = 0;
    p.vel.x = 0.0;
    p.vel.y = 0.0;
    p.vel.z = 0.0;
    p.grounded = true;
    p.jumps_used = 0;
    p.sprinting = false;
    p.crouching = false;
    p.jump_buffer = 0;
    place_rider(sim, &life.state.vehicles[i]);
    life.notify(QuestEvent { vehicle: Some(def.id.clone()), ..QuestEvent::new("ride") });
    true
}

/// Where you would end up stepping out of a vehicle (dry land or a deck if any side has one):
/// (x, y, z, dry).
pub fn exit_spot(sim: &Sim, v: &Vehicle) -> (f64, f64, f64, bool) {
    let def = rideable(&v.def);
    let hf = sim.terrain();
    let side = def.width / 2.0 + 0.7;
    let tries = [(side, 0.3), (-side, 0.3), (0.0, def.length / 2.0 + 0.8), (0.0, -def.length / 2.0 - 0.8)];
    let mut spot = None;
    for (lx, lz) in tries {
        let (ox, oz) = to_world(lx, lz, v.heading);
        let x = v.x + ox;
        let z = v.z + oz;
        let y = ground_at(hf, &sim.world.index, x, z, v.y.max(hf.water) + 1.5, 2.2);
        let dry = y > hf.water - content::swim().depth + 0.2;
        if dry && clear_at(sim, x, z, tuning().movement.player_radius) {
            return (x, y, z, dry);
        }
        if spot.is_none() {
            spot = Some((x, if dry { y } else { hf.water - content::swim().float }, z, dry));
        }
    }
    // The first try is always kept, so this fallback is never reached.
    spot.unwrap_or((v.x, v.y, v.z, false))
}

pub fn dismount(life: &mut Life, sim: &mut Sim) -> bool {
    let Some(i) = ridden(life, sim) else {
        let p = &mut *sim.player;
        if p.mode == Mode::Ride {
            p.mode = Mode::Normal;
        }
        p.vehicle = 0;
        return false;
    };
    let hf = sim.terrain();
    // Step off on the left; failing that, any side with something to stand on. The TypeScript
    // writes this search out again here; it is exitSpot's, try for try.
    let (x, y, z, dry) = exit_spot(sim, &life.state.vehicles[i]);
    let v = &mut life.state.vehicles[i];
    v.ridden = false;
    // Nobody at the helm: the sail comes down and the oars stop.
    v.sail = 0.0;
    v.throttle = 0.0;
    let p = &mut *sim.player;
    p.vehicle = 0;
    p.mode = Mode::Normal;
    p.pos.x = x;
    p.pos.z = z;
    p.pos.y = if dry { y } else { hf.water - content::swim().float };
    // (The TypeScript also resets prevPos, where the renderer blends from. The server draws nothing.)
    p.grounded = dry;
    p.vel.x = 0.0;
    p.vel.y = 0.0;
    p.vel.z = 0.0;
    true
}

/// Seats the player in the vehicle (driver's seat).
pub fn place_rider(sim: &mut Sim, v: &Vehicle) {
    let def = rideable(&v.def);
    let seat = def.seats.first().copied().unwrap_or_default();
    let (x, y, z) = anchor_world(v, &seat);
    let p = &mut *sim.player;
    p.pos.x = x;
    p.pos.y = y;
    p.pos.z = z;
    p.facing = v.heading;
    p.vel.x = v.vx;
    p.vel.y = v.vy;
    p.vel.z = v.vz;
    p.bank = v.steer;
}

/// The mount a whistle calls.
fn mount_of(it: &ItemDef) -> &'static RideableDef {
    rideable(it.mount.as_deref().unwrap_or(""))
}

/// A JavaScript sort comparator's answer as an Ordering (NaN counts as equal, as there).
fn js_order(d: f64) -> Ordering {
    if d < 0.0 {
        Ordering::Less
    } else if d > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// The mount key: get on (calling it if it is far away or not out), or get off.
pub fn mount_command(life: &mut Life, sim: &mut Sim) {
    if let Some(i) = ridden(life, sim) {
        if rideable(&life.state.vehicles[i].def).is_mount() {
            dismount(life, sim);
        }
        return;
    }
    if sim.player.mode != Mode::Normal || !sim.player.grounded {
        return;
    }
    let whistles: Vec<&'static ItemDef> = life.state.bag.iter().map(|s| item_def(&s.item)).filter(|it| it.cat == "mount").collect();
    if whistles.is_empty() {
        life.toast("You have no mount yet - Sela at the stables sells them", "bad");
        return;
    }
    // Carrying a pack, only a pack animal will do.
    let carrying = sim.player.pack != 0;
    let mut usable: Vec<&'static ItemDef> = whistles.into_iter().filter(|it| !carrying || mount_of(it).can_carry_pack).collect();
    if usable.is_empty() {
        life.toast("Your horse won't carry a trade pack - a donkey will", "bad");
        return;
    }
    // Stable, like Array.prototype.sort: the fastest, and the first in the bag of those.
    usable.sort_by(|a, b| js_order(mount_of(b).run_speed - mount_of(a).run_speed));
    let def = mount_of(usable[0]);
    let p = &*sim.player;
    let (px, py, pz, facing) = (p.pos.x, p.pos.y, p.pos.z, p.facing);
    let id = match life.state.vehicles.iter().position(|x| x.def == def.id) {
        None => spawn_vehicle(life, def, Spot { x: px, z: pz, heading: facing }, py),
        Some(i) => {
            let v = &mut life.state.vehicles[i];
            if hypot(v.x - px, v.z - pz) > 25.0 {
                // It comes when you whistle, cargo and all - never a second one.
                v.x = px;
                v.z = pz;
                v.y = py;
                v.vx = 0.0;
                v.vy = 0.0;
                v.vz = 0.0;
                v.speed = 0.0;
                v.heading = facing;
            }
            v.id
        }
    };
    board(life, sim, id);
}

// ---------- Every step ----------

/// What the driver asks of a vehicle this step.
#[derive(Clone, Copy, Debug)]
struct DriveInput {
    throttle: f64,
    steer: f64,
    handbrake: bool,
    boost: bool,
}

pub fn ride_vehicle(life: &mut Life, sim: &mut Sim, a: &Actions) {
    let Some(i) = ridden(life, sim) else {
        sim.player.mode = Mode::Normal;
        sim.player.vehicle = 0;
        return;
    };
    let id = life.state.vehicles[i].id;
    let def = rideable(&life.state.vehicles[i].def);
    let input = DriveInput { throttle: a.stick_y, steer: -a.stick_x, handbrake: a.jump_held, boost: a.sprint_held };
    if def.is_wheeled() {
        step_wheeled(sim, &mut life.state.vehicles[i], def, &input);
    } else if def.is_boat() {
        boat(life, sim, i, def, &input);
    } else {
        let carrying = sim.player.pack != 0;
        step_mount(sim, &mut life.state.vehicles[i], def, a, carrying);
    }
    // The step can end the ride (a boat breaking up under you): then there is no seat to sit in.
    if sim.player.vehicle != id {
        return;
    }
    let Some(i) = vehicle_index(life, id) else { return };
    place_rider(sim, &life.state.vehicles[i]);
}

pub fn step_vehicles(life: &mut Life, sim: &mut Sim, _a: &Actions) {
    let none = DriveInput { throttle: 0.0, steer: 0.0, handbrake: true, boost: false };
    // The TypeScript walks the list as it was when the loop began: a boat breaking up swaps in a
    // list without it, and the loop carries on through the old one, whose others are the same.
    let ids: Vec<i64> = life.state.vehicles.iter().map(|v| v.id).collect();
    for id in ids {
        let Some(i) = vehicle_index(life, id) else { continue };
        if life.state.vehicles[i].ridden {
            continue;
        }
        let def = rideable(&life.state.vehicles[i].def);
        if def.is_boat() {
            life.state.vehicles[i].sail = 0.0; // an empty boat drifts to a stop (saves from before this rule too)
        }
        if def.is_wheeled() {
            step_wheeled(sim, &mut life.state.vehicles[i], def, &none);
        } else if def.is_boat() {
            boat(life, sim, i, def, &DriveInput { handbrake: false, ..none });
        } else {
            step_mount_idle(sim, &mut life.state.vehicles[i], def);
        }
    }
    // You bump into vehicles you are not riding, like anything else solid.
    let player_radius = tuning().movement.player_radius;
    let p = &mut *sim.player;
    if p.mode != Mode::Ride && p.mode != Mode::Glide {
        for v in &life.state.vehicles {
            if v.ridden {
                continue;
            }
            let def = rideable(&v.def);
            let (cs, n) = circles(v, def);
            for c in &cs[..n] {
                let dx = p.pos.x - c.x;
                let dz = p.pos.z - c.z;
                let min = c.r + player_radius;
                let d2 = dx * dx + dz * dz;
                if d2 >= min * min {
                    continue;
                }
                // Only if you are at its height (not standing on a deck above a boat, say).
                if (p.pos.y - v.y).abs() > 2.2f64.max(def.height) {
                    continue;
                }
                let d = or(d2.sqrt(), 1e-4);
                p.pos.x = c.x + (dx / d) * min;
                p.pos.z = c.z + (dz / d) * min;
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Circle {
    x: f64,
    z: f64,
    r: f64,
}

/// A long vehicle is two circles (front and back), a short one is one: (circles, how many).
fn circles(v: &Vehicle, def: &RideableDef) -> ([Circle; 3], usize) {
    if def.length < def.width * 1.6 {
        return ([Circle { x: v.x, z: v.z, r: def.radius }, Circle::default(), Circle::default()], 1);
    }
    let r = def.width / 2.0 + 0.1;
    let off = def.length / 2.0 - r;
    let fx = v.heading.sin();
    let fz = v.heading.cos();
    (
        [
            Circle { x: v.x + fx * off, z: v.z + fz * off, r },
            Circle { x: v.x - fx * off, z: v.z - fz * off, r },
            Circle { x: v.x, z: v.z, r },
        ],
        3,
    )
}

/// One shove out of something solid; what was driving into it bounces back a little.
fn push(v: &mut Vehicle, impact: &mut f64, nx: f64, nz: f64, depth: f64) {
    v.x += nx * depth;
    v.z += nz * depth;
    let vn = v.vx * nx + v.vz * nz;
    if vn < 0.0 {
        *impact = impact.max(-vn);
        v.vx -= vn * nx * 1.25;
        v.vz -= vn * nz * 1.25;
    }
}

/// Pushes a vehicle out of trees, rocks and walls; returns the hardest impact speed.
fn collide(sim: &Sim, v: &mut Vehicle, def: &RideableDef, solid_decks: bool) -> f64 {
    let idx = &sim.world.index;
    let mut impact = 0.0;
    for _pass in 0..2 {
        // Where the circles were when the pass began: pushes move the vehicle, not its circles.
        let (cs, n) = circles(v, def);
        for c in &cs[..n] {
            idx.each_obstacle(c.x, c.z, c.r + 2.0, |o| {
                if o.r <= 0.0 {
                    return;
                }
                let dx = c.x - o.x;
                let dz = c.z - o.z;
                let min = c.r + o.r;
                let d2 = dx * dx + dz * dz;
                if d2 >= min * min {
                    return;
                }
                let d = or(d2.sqrt(), 1e-4);
                push(v, &mut impact, dx / d, dz / d, min - d);
            });
            idx.each_box(c.x, c.z, c.r + 1.0, |b| {
                if v.y >= b.top - 0.1 {
                    return;
                }
                let Some((px, pz)) = push_out_of_box(b, c.x, c.z, c.r) else { return };
                let l = or(hypot(px, pz), 1e-4);
                push(v, &mut impact, px / l, pz / l, l);
            });
            if solid_decks {
                idx.each_deck(c.x, c.z, c.r + 1.0, |b| {
                    let Some((px, pz)) = push_out_of_box(b, c.x, c.z, c.r) else { return };
                    let l = or(hypot(px, pz), 1e-4);
                    push(v, &mut impact, px / l, pz / l, l);
                });
            }
        }
    }
    let lim = sim.world.radius - 4.0;
    let r = len(v.x, v.z);
    if r > lim {
        v.x *= lim / r;
        v.z *= lim / r;
    }
    impact
}

/// Visual tilt from the ground under the wheels or hooves.
fn settle_tilt(hf: &Heightfield, v: &mut Vehicle, def: &RideableDef, dt: f64) {
    let fx = v.heading.sin();
    let fz = v.heading.cos();
    let hl = def.length * 0.4;
    let hw = def.width * 0.45;
    let front = hf.height(v.x + fx * hl, v.z + fz * hl);
    let back = hf.height(v.x - fx * hl, v.z - fz * hl);
    let left = hf.height(v.x + fz * hw, v.z - fx * hw);
    let right = hf.height(v.x - fz * hw, v.z + fx * hw);
    let pitch = if v.grounded { (front - back).atan2(hl * 2.0) } else { v.pitch };
    let roll = if v.grounded { (left - right).atan2(hw * 2.0) } else { v.roll };
    let k = 1.0 - (-10.0 * dt).exp();
    v.pitch += (clamp(pitch, -0.6, 0.6) - v.pitch) * k;
    v.roll += (clamp(roll, -0.5, 0.5) - v.roll) * k;
}

fn step_wheeled(sim: &Sim, v: &mut Vehicle, d: &RideableDef, inp: &DriveInput) {
    let dt = step_seconds();
    let hf = sim.terrain();
    v.throttle += (inp.throttle - v.throttle) * 1f64.min(9.0 * dt);
    v.steer += (inp.steer - v.steer) * 1f64.min(7.0 * dt);
    let fx = v.heading.sin();
    let fz = v.heading.cos();
    let rx = -fz;
    let rz = fx;
    let mut vf = v.vx * fx + v.vz * fz;
    let mut vs = v.vx * rx + v.vz * rz;
    let surf = hf.surface_at(v.x, v.z);
    let paved = surf == surface::ROAD || surf == surface::PLAZA;
    let boosting = inp.boost && d.boost_speed > 0.0 && v.throttle > 0.3;
    let cap = (if boosting { d.boost_speed } else { d.max_speed }) * (if paved { 1.0 } else { d.offroad }) * (if surf == surface::SAND { 0.8 } else { 1.0 });
    if v.grounded {
        let t = v.throttle;
        if t > 0.05 {
            if vf < -0.3 {
                vf += d.brake * t * dt;
            } else if vf < cap {
                vf = cap.min(vf + d.accel * (if boosting { 1.5 } else { 1.0 }) * t * dt);
            }
        } else if t < -0.05 {
            if vf > 0.3 {
                vf -= d.brake * -t * dt;
            } else if vf > -d.reverse_speed {
                vf = (-d.reverse_speed).max(vf + d.accel * 0.7 * t * dt);
            }
        }
        let res = d.rolling + d.drag * vf.abs();
        vf -= js_sign(vf) * vf.abs().min(res * dt);
        if vf.abs() > cap {
            vf -= js_sign(vf) * (vf.abs() - cap).min((vf.abs() - cap) * 1.8 * dt + 0.4 * dt);
        }
        let (gx, gz) = hf.gradient(v.x, v.z);
        vf -= 9.81 * (gx * fx + gz * fz) * dt * 0.9;
        if inp.handbrake {
            vf -= js_sign(vf) * vf.abs().min(d.brake * 0.45 * dt);
        }
        let sf = clamp(vf.abs() / 3.0, 0.0, 1.0) * (1.0 - 0.4 * clamp(vf.abs() / 1f64.max(d.max_speed), 0.0, 1.0));
        let yaw = v.steer * d.turn_rate * sf * (if vf >= 0.0 { 1.0 } else { -1.0 }) * (if inp.handbrake { 1.35 } else { 1.0 });
        let grip = (if inp.handbrake { d.drift_grip } else { d.grip }) * (if paved { 1.0 } else { 0.75 });
        vs *= (-grip * dt).exp();
        v.vx = fx * vf + rx * vs;
        v.vz = fz * vf + rz * vs;
        v.heading = wrap(v.heading + yaw * dt);
    }
    v.speed = vf;
    move_on_land(sim, v, d, d.climb, 0.8);
}

/// Moves a land vehicle or mount: walls of rock and water stop it, the ground carries it.
fn move_on_land(sim: &Sim, v: &mut Vehicle, def: &RideableDef, climb: f64, max_wade: f64) {
    let dt = step_seconds();
    let hf = sim.terrain();
    let idx = &sim.world.index;
    let nx = v.x + v.vx * dt;
    let nz = v.z + v.vz * dt;
    let run = hypot(nx - v.x, nz - v.z);
    let mut blocked = false;
    if run > 1e-6 {
        let wet = hf.water - hf.height(nx, nz);
        let ground = ground_at(hf, idx, nx, nz, v.y + 0.6, 0.6);
        let rise = ground - v.y;
        if wet > max_wade && !v.swimming {
            blocked = true;
        } else if v.grounded && rise > 0.6 {
            blocked = true;
        } else if v.grounded && rise > 0.02 && ground <= hf.height(nx, nz) + 0.01 && hf.slope(nx, nz) > climb {
            blocked = true;
        }
    }
    if blocked {
        // Lose the speed into the obstacle, keep sliding along it.
        let (gx, gz) = hf.gradient(nx, nz);
        let gl = hypot(gx, gz);
        if gl > 1e-4 {
            let ux = gx / gl;
            let uz = gz / gl;
            let into = v.vx * ux + v.vz * uz;
            if into > 0.0 {
                v.vx -= ux * into;
                v.vz -= uz * into;
            }
        } else {
            v.vx *= -0.2;
            v.vz *= -0.2;
        }
    } else {
        v.x = nx;
        v.z = nz;
    }
    collide(sim, v, def, false);
    let ground = ground_at(hf, idx, v.x, v.z, v.y + 0.6, 0.6);
    if v.grounded {
        let drop = v.y - ground;
        let speed = hypot(v.vx, v.vz);
        if drop > 0.3 + speed * dt * 1.0 {
            v.grounded = false;
            v.vy = 0f64.min(v.vy);
        } else {
            v.vy = (ground - v.y) / dt;
            v.y = ground;
        }
    } else {
        v.vy -= G * dt;
        v.y += v.vy * dt;
        if v.y <= ground {
            if v.vy < -12.0 {
                v.hp = 1f64.max(v.hp - (-v.vy - 12.0) * 20.0);
            }
            v.y = ground;
            v.vy = 0.0;
            v.grounded = true;
        }
    }
    settle_tilt(hf, v, def, dt);
}

/// Steps a boat. It comes off the list for the step, so the rules can toast and roll the island's
/// dice while they move it, and goes back before a storm can break it up (breakUp finds it there).
fn boat(life: &mut Life, sim: &mut Sim, i: usize, d: &RideableDef, inp: &DriveInput) {
    let mut v = std::mem::take(&mut life.state.vehicles[i]);
    let broke = step_boat(life, sim, &mut v, d, inp);
    let id = v.id;
    life.state.vehicles[i] = v;
    if broke {
        break_up(life, sim, id);
    }
}

/// The TypeScript stepBoat, on a boat taken off the list. True when the storm has broken it up:
/// that is where the TypeScript calls breakUp, and what it does to the boat after that is lost
/// with the boat.
fn step_boat(life: &mut Life, sim: &Sim, v: &mut Vehicle, d: &RideableDef, inp: &DriveInput) -> bool {
    let dt = step_seconds();
    let hf = sim.terrain();
    let (wind_dir, wind_speed) = (life.state.weather.wind_dir, life.state.weather.wind_speed);
    let target;
    let mut rel = 0.0;
    if truthy(d.sail) {
        v.sail = clamp(v.sail + inp.throttle * 0.55 * dt, 0.0, 1.0);
        rel = angle_diff(wind_dir, v.heading);
        let eff = sail_efficiency(rel);
        target = v.sail * d.max_speed * eff * (0.6 + 0.4 * wind_speed);
        v.throttle = v.sail;
    } else {
        v.throttle += (inp.throttle - v.throttle) * 1f64.min(5.0 * dt);
        target = if v.throttle >= 0.0 { v.throttle * d.max_speed } else { v.throttle * d.reverse_speed };
    }
    v.steer += (inp.steer - v.steer) * 1f64.min(5.0 * dt);
    let fx = v.heading.sin();
    let fz = v.heading.cos();
    let rx = -fz;
    let rz = fx;
    let mut vf = v.vx * fx + v.vz * fz;
    let mut vs = v.vx * rx + v.vz * rz;
    if vf < target {
        vf = target.min(vf + d.accel * dt);
    } else {
        vf = target.max(vf - (d.brake + d.drag * vf.abs()) * dt);
    }
    let flow = clamp(vf.abs() / (0.4 * d.max_speed), 0.0, 1.0);
    let turn = d.turn_at_rest + (d.turn_rate - d.turn_at_rest) * flow;
    v.heading = wrap(v.heading + v.steer * turn * dt * (if vf < -0.2 { -1.0 } else { 1.0 }));
    vs *= (-d.grip * dt).exp();
    v.vx = fx * vf + rx * vs;
    v.vz = fz * vf + rz * vs;
    v.speed = vf;

    // Shallows: the keel catches and the boat stops dead (a little bounce back).
    let nx = v.x + v.vx * dt;
    let nz = v.z + v.vz * dt;
    let bow_x = nx + fx * d.length * 0.45 * js_sign(or(vf, 1.0));
    let bow_z = nz + fz * d.length * 0.45 * js_sign(or(vf, 1.0));
    let shallow = (hf.water - hf.height(nx, nz)).min(hf.water - hf.height(bow_x, bow_z));
    if shallow < d.draft {
        if vf.abs() > 3.0 && life.state.clock % 1.0 < dt {
            life.toast("Running aground!", "bad");
        }
        v.vx *= -0.15;
        v.vz *= -0.15;
        v.speed = 0.0;
    } else {
        v.x = nx;
        v.z = nz;
    }
    collide(sim, v, d, true);
    v.y = hf.water;
    v.vy = 0.0;
    v.grounded = false;

    // Rough water out at sea in the rain: the swell shoves you about and works the hull loose.
    let storm = storm_at(life, hf.water - hf.height(v.x, v.z));
    if storm > 0.0 {
        let rough = content::storm();
        let shove = (life.rand() - 0.5) * rough.buffet * storm * dt * 10.0;
        v.vx += -fz * shove;
        v.vz += fx * shove;
        v.roll += (life.rand() - 0.5) * 0.06 * storm;
        let rate = rough.hull_damage.iter().find(|[up_to, _]| d.length <= *up_to).map(|[_, rate]| *rate).unwrap_or(2.5);
        v.hp -= rate * storm * dt;
        if v.ridden && !v.storm_warned.unwrap_or(false) {
            v.storm_warned = Some(true);
            life.toast(format!("🌊 The sea is rough - your {}'s hull is taking a beating! Make for shallower water.", d.name.to_lowercase()), "bad");
        }
        if v.hp <= 0.0 {
            return true;
        }
    } else {
        v.storm_warned = Some(false);
    }
    // Heel with the wind in the sail and into the turn; the renderer adds the swell.
    let heel = (if truthy(d.sail) { rel.sin() * 0.12 * v.sail } else { 0.0 }) - v.steer * flow * 0.08;
    v.roll += (heel - v.roll) * (1.0 - (-3.0 * dt).exp());
    v.pitch += (-clamp(vf / 1f64.max(d.max_speed), -1.0, 1.0) * 0.04 - v.pitch) * (1.0 - (-3.0 * dt).exp());
    false
}

/// A boat lost to the storm: its cargo floats where it went down, and it is out for repairs.
fn break_up(life: &mut Life, sim: &mut Sim, id: i64) {
    let Some(i) = vehicle_index(life, id) else { return };
    let def = rideable(&life.state.vehicles[i].def);
    let hf = sim.terrain();
    let (vx, vz) = (life.state.vehicles[i].x, life.state.vehicles[i].z);
    let cargo = life.state.vehicles[i].cargo.clone();
    for (k, &pack) in cargo.iter().enumerate() {
        if pack == 0 {
            continue;
        }
        let Some(j) = life.state.packs.iter().position(|p| p.id == pack) else { continue };
        let a = (k as f64 / 1f64.max(cargo.len() as f64)) * PI * 2.0 + life.rand();
        let x = vx + a.cos() * (1.5 + life.rand() * 2.5);
        let z = vz + a.sin() * (1.5 + life.rand() * 2.5);
        let pk = &mut life.state.packs[j];
        pk.at = "ground".to_string();
        pk.vehicle = 0;
        pk.x = x;
        pk.z = z;
        pk.y = hf.water - 0.15;
        pk.rot = a;
    }
    if life.state.vehicles[i].ridden {
        dismount(life, sim);
    }
    life.state.vehicles.retain(|x| x.id != id);
    let back = life.state.clock + content::storm().repair_seconds;
    life.state.repairs.get_or_insert_with(BTreeMap::new).insert(def.id.clone(), back);
    life.revision += 1;
    let floating = cargo.iter().filter(|&&c| c != 0).count();
    let afloat = if floating != 0 { format!(" {floating} pack{} floating where she went down.", if floating > 1 { "s are" } else { " is" }) } else { String::new() };
    life.toast(format!("💥 Your {} broke up in the swell!{afloat}", def.name.to_lowercase()), "bad");
}

/// How much of the wind a sail can use at this angle off it (0 = wind straight behind).
pub fn sail_efficiency(rel: f64) -> f64 {
    0.25 + 0.75 * (0.5 + 0.5 * rel.cos()).powf(0.6)
}

fn step_mount(sim: &Sim, v: &mut Vehicle, d: &RideableDef, a: &Actions, carrying: bool) {
    let dt = step_seconds();
    let hf = sim.terrain();
    let run_threshold = tuning().movement.run_threshold;
    let mag = 1f64.min(len(a.move_x, a.move_z));
    let gallop = a.sprint_held && !carrying;
    let mut top = if mag < 0.05 {
        0.0
    } else if mag < run_threshold {
        d.walk_speed * (mag / run_threshold)
    } else if gallop {
        d.gallop_speed
    } else {
        d.run_speed
    };
    if carrying {
        top = top.min(or(d.pack_speed, d.walk_speed));
    }
    let depth = hf.water - hf.height(v.x, v.z);
    v.swimming = depth > 1.5;
    if v.swimming {
        top *= 0.45;
    }
    if mag > 0.05 {
        v.heading = turn_toward(v.heading, a.move_x.atan2(a.move_z), d.turn_rate * dt);
    }
    // Animals turn their whole body: speed builds along the heading, not the stick.
    let align = if mag > 0.05 { 0.25f64.max(angle_diff(v.heading, a.move_x.atan2(a.move_z)).cos()) } else { 1.0 };
    let want = top * align;
    if v.speed < want {
        v.speed = want.min(v.speed + d.accel * dt);
    } else {
        v.speed = want.max(v.speed - d.accel * 1.4 * dt);
    }
    v.vx = v.heading.sin() * v.speed;
    v.vz = v.heading.cos() * v.speed;
    v.steer = clamp(angle_diff(v.heading, or(a.move_x, 1e-6).atan2(a.move_z)) * (if mag > 0.05 { 1.0 } else { 0.0 }), -1.0, 1.0);
    if a.jump_pressed && v.grounded && !v.swimming {
        v.vy = d.jump;
        v.grounded = false;
    }
    if v.swimming {
        v.y = hf.water - 1.0;
        v.vy = 0.0;
        v.grounded = true;
        let nx = v.x + v.vx * dt;
        let nz = v.z + v.vz * dt;
        if ground_at(hf, &sim.world.index, nx, nz, v.y + 1.0, 1.0) <= hf.water + 0.6 {
            v.x = nx;
            v.z = nz;
        }
        collide(sim, v, d, true);
        if hf.water - hf.height(v.x, v.z) <= 1.5 {
            v.y = v.y.max(hf.height(v.x, v.z));
        }
        return;
    }
    move_on_land(sim, v, d, content::ground().max_slope * 0.95, 99.0);
}

fn step_mount_idle(sim: &Sim, v: &mut Vehicle, d: &RideableDef) {
    v.speed = 0.0;
    v.vx = 0.0;
    v.vz = 0.0;
    if !v.swimming {
        move_on_land(sim, v, d, content::ground().max_slope, 99.0);
    }
}

/// The seat or cargo slot nearest a point (TS nearestAnchor). `kind` is "seat" or "cargo".
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Anchored {
    pub kind: &'static str,
    pub index: usize,
    pub dist: f64,
}

/// For the interaction prompt: is (x, z) nearer a seat or a cargo slot, and which? With a pack in
/// your arms the cargo bed wins ties - you came over to load it.
pub fn nearest_anchor(v: &Vehicle, x: f64, z: f64, carrying: bool) -> Anchored {
    let def = rideable(&v.def);
    let (lx, lz) = to_local(x - v.x, z - v.z, v.heading);
    let mut best = Anchored { kind: "seat", index: 0, dist: f64::INFINITY };
    for (i, s) in def.seats.iter().take(1).enumerate() {
        let dd = hypot(lx - s.x, lz - s.z);
        if dd < best.dist {
            best = Anchored { kind: "seat", index: i, dist: dd };
        }
    }
    for (i, c) in def.cargo.iter().enumerate() {
        let dd = hypot(lx - c.x, lz - c.z) - if carrying { 0.6 } else { 0.0 };
        if dd < best.dist {
            best = Anchored { kind: "cargo", index: i, dist: dd };
        }
    }
    best
}

/// Distance from (x, z) to the vehicle's hull, roughly.
pub fn distance_to(v: &Vehicle, x: f64, z: f64) -> f64 {
    let def = rideable(&v.def);
    let (lx, lz) = to_local(x - v.x, z - v.z, v.heading);
    let ox = 0f64.max(lx.abs() - def.width / 2.0);
    let oz = 0f64.max(lz.abs() - def.length / 2.0);
    hypot(ox, oz)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::life::state::Pack;
    use crate::life::LifeEvent;
    use crate::open::zone::{emberholm, Obstacle, ObstacleKind};
    use crate::open::OpenWorld;
    use crate::player::{Build, Player, V3};
    use crate::world::Spawn;

    /// Lanternwick's docks, facing out to sea (where the browser tests summon boats).
    const DOCKS: (f64, f64, f64) = (-10.0, -334.0, PI);
    /// The long west road (where the browser test drives the roadster).
    const ROAD: (f64, f64, f64) = (150.0, -210.0, PI / 2.0 + 0.25);

    /// One player on Emberholm, stepped the way the browser steps it.
    struct Island {
        life: Life,
        world: OpenWorld,
        p: Player,
    }

    impl Island {
        fn new() -> Island {
            let zone = emberholm();
            let s = zone.recipe.spawn;
            let mut life = Life::new(zone, None, None);
            life.drain_events();
            Island { life, world: OpenWorld::new(zone), p: Player::new(Spawn { x: s.x, z: s.z, facing: s.facing }, 0, Build::default()) }
        }

        /// On your feet on the ground at (x, z).
        fn stand(&mut self, (x, z, facing): (f64, f64, f64)) {
            let hf = self.world.terrain();
            self.p.pos = V3 { x, y: hf.height(x, z), z };
            self.p.vel = V3::default();
            self.p.facing = facing;
            self.p.mode = Mode::Normal;
            self.p.grounded = true;
        }

        fn with<R>(&mut self, f: impl FnOnce(&mut Life, &mut Sim) -> R) -> R {
            let mut sim = Sim { player: &mut self.p, world: &mut self.world, owner: 1 };
            f(&mut self.life, &mut sim)
        }

        /// Frames as the TypeScript runs them: the ride with your controls, then the island's step.
        fn frames(&mut self, n: usize, a: Actions) {
            for _ in 0..n {
                self.with(|life, sim| {
                    if sim.player.mode == Mode::Ride {
                        ride_vehicle(life, sim, &a);
                    }
                    life.state.clock += step_seconds();
                    step_vehicles(life, sim, &a);
                });
            }
        }

        /// Puts the deed (or whistle) in the bag and calls it.
        fn summon(&mut self, item: &str) -> Option<i64> {
            self.life.give(item, 1, true);
            self.with(|life, sim| summon(life, sim, item))
        }

        fn board(&mut self, id: i64) -> bool {
            self.with(|life, sim| board(life, sim, id))
        }

        fn dismount(&mut self) -> bool {
            self.with(|life, sim| dismount(life, sim))
        }

        fn mount(&mut self) {
            self.with(|life, sim| mount_command(life, sim));
        }

        fn v(&self, id: i64) -> &Vehicle {
            &self.life.state.vehicles[vehicle_index(&self.life, id).expect("the vehicle is out")]
        }

        fn v_mut(&mut self, id: i64) -> &mut Vehicle {
            let i = vehicle_index(&self.life, id).expect("the vehicle is out");
            &mut self.life.state.vehicles[i]
        }

        /// A crate loaded into a vehicle's cargo slot. Returns its id.
        fn load(&mut self, id: i64, slot: usize) -> i64 {
            let pack = self.life.next_id();
            self.life.state.packs.push(Pack { id: pack, def: "harvestCrate".into(), at: "cargo".into(), vehicle: id, slot: slot as i64, ..Default::default() });
            self.v_mut(id).cargo[slot] = pack;
            pack
        }

        fn toasts(&mut self) -> Vec<String> {
            self.life.drain_events().into_iter().filter_map(|e| if let LifeEvent::Toast { text, .. } = e { Some(text) } else { None }).collect()
        }

        /// The first point going south from (x, z) where the water is deeper than `depth`.
        fn south_to(&self, x: f64, mut z: f64, depth: f64) -> (f64, f64) {
            let hf = self.world.terrain();
            for _ in 0..4000 {
                if hf.water - hf.height(x, z) > depth {
                    return (x, z);
                }
                z -= 0.5;
            }
            panic!("no water {depth} m deep south of {x}, {z}");
        }

        /// Somewhere at sea, due south of the docks, at least this deep.
        fn offshore(&self, depth: f64) -> (f64, f64) {
            self.south_to(DOCKS.0, DOCKS.1, depth)
        }

        /// Where the shore meets the sea going south from (x, z).
        fn waterline(&self, x: f64, z: f64) -> (f64, f64) {
            self.south_to(x, z, 0.0)
        }
    }

    fn drive(throttle: f64, steer: f64, handbrake: bool) -> Actions {
        Actions { stick_y: throttle, stick_x: steer, jump_held: handbrake, ..Default::default() }
    }

    fn walk(x: f64, z: f64, sprint: bool) -> Actions {
        Actions { move_x: x, move_z: z, sprint_held: sprint, ..Default::default() }
    }

    /// How fast a vehicle is sliding sideways.
    fn slip(v: &Vehicle) -> f64 {
        (v.vx * -v.heading.cos() + v.vz * v.heading.sin()).abs()
    }

    #[test]
    fn distances_are_measured_the_way_the_browser_measures_them() {
        // Math.hypot in Node and Chrome, where f64::hypot rounds the other way.
        for (a, b, v8) in [
            (6.76, -2.9, 0x401d6c53627f1cceu64),
            (9.28, -7.37, 0x4027b379fd030d39),
            (2.79, -1.44, 0x40091e19b0b06925),
            (6.97, 7.62, 0x4024a76234c8f1fa),
            (-0.63, -4.15, 0x4010ca49bc395736),
            (-6.32, 4.62, 0x401f507989f30977),
        ] {
            assert_eq!(hypot(a, b).to_bits(), v8, "hypot({a}, {b})");
        }
        assert_eq!(hypot(3.0, 4.0), 5.0);
        assert_eq!(hypot(0.0, -0.0), 0.0);
        assert_eq!(hypot(f64::INFINITY, f64::NAN), f64::INFINITY);
        assert!(hypot(f64::NAN, 1.0).is_nan());
    }

    #[test]
    fn a_sail_wants_the_wind_behind_it() {
        assert_eq!(sail_efficiency(0.0), 1.0);
        assert!(sail_efficiency(0.0) > sail_efficiency(PI) * 3.0);
        assert!(sail_efficiency(PI / 2.0) > sail_efficiency(PI));
        assert!((sail_efficiency(PI) - 0.25).abs() < 1e-12);
    }

    #[test]
    fn a_cart_is_summoned_in_front_of_you_on_dry_level_ground() {
        let mut w = Island::new();
        let wb = &w.world.zone.recipe.workbenches[0];
        w.stand((wb.x - 6.0, wb.z + 6.0, 0.0));
        let id = w.summon("deed.farmCart").expect("a farm cart");
        assert_eq!(w.toasts(), ["🛒 Farm Cart summoned"]);
        let (v, p) = (w.v(id), &w.p);
        assert_eq!((v.def.as_str(), v.hp, v.cargo.len()), ("farmCart", 600.0, 4));
        assert_eq!((v.heading, v.grounded, v.ridden), (p.facing, true, false));
        let hf = w.world.terrain();
        assert!(hf.water - hf.height(v.x, v.z) <= 0.2 && hf.slope(v.x, v.z) <= 0.5);
        assert!(v.y >= hf.height(v.x, v.z) && v.y <= hf.height(v.x, v.z) + 1.6);
        let d = hypot(v.x - p.pos.x, v.z - p.pos.z);
        assert!((3.5 + 1.25 - 1e-9..=9.0 + 1.25 + 1e-9).contains(&d), "{d} m away");
        // Calling it again sends the first one home: one of each, ever.
        let again = w.summon("deed.farmCart").expect("called again");
        assert_ne!(again, id);
        assert_eq!(w.life.state.vehicles.len(), 1);
    }

    #[test]
    fn summoning_needs_the_deed_your_feet_on_the_ground_and_room() {
        let mut w = Island::new();
        w.stand((0.0, -200.0, 0.0));
        assert_eq!(w.with(|life, sim| summon(life, sim, "deed.farmCart")), None, "no deed in the bag");
        assert!(w.toasts().is_empty());
        w.p.grounded = false;
        assert_eq!(w.summon("deed.farmCart"), None);
        w.p.grounded = true;
        w.p.mode = Mode::Swim;
        assert_eq!(w.summon("deed.farmCart"), None);
        assert_eq!(w.toasts(), ["Stand on solid ground to summon", "Stand on solid ground to summon"]);
        w.p.mode = Mode::Normal;
        w.world.index.add_obstacle(Obstacle { kind: ObstacleKind::Rock, x: 0.0, z: -200.0, r: 30.0 });
        assert_eq!(w.summon("deed.farmCart"), None);
        assert_eq!(w.toasts(), ["No room here"]);
        assert!(w.life.state.vehicles.is_empty());
    }

    #[test]
    fn a_boat_is_summoned_only_where_the_water_is_deep_enough() {
        let mut w = Island::new();
        w.stand((0.0, -200.0, 0.0));
        assert_eq!(w.summon("deed.rowboat"), None);
        assert_eq!(w.toasts(), ["No water deep enough nearby - go down to the shore"]);
        w.stand(DOCKS);
        let id = w.summon("deed.sloop").expect("a sloop at the docks");
        assert_eq!(w.toasts(), ["⛵ Sloop summoned"]);
        let v = w.v(id);
        let (hf, def) = (w.world.terrain(), rideable("sloop"));
        assert_eq!(v.y, hf.water);
        // Afloat from bow to stern, pointing out to sea.
        for k in [-0.5, 0.0, 0.5] {
            let (x, z) = (v.x + v.heading.sin() * def.length * k, v.z + v.heading.cos() * def.length * k);
            assert!(hf.water - hf.height(x, z) >= def.draft, "afloat at {k}");
        }
        let ahead = (v.x + v.heading.sin() * 10.0, v.z + v.heading.cos() * 10.0);
        assert!(hf.height(ahead.0, ahead.1) < hf.height(v.x, v.z), "deeper ahead");
    }

    #[test]
    fn a_loaded_or_occupied_vehicle_stays_where_it_is() {
        let mut w = Island::new();
        let wb = &w.world.zone.recipe.workbenches[0];
        w.stand((wb.x - 6.0, wb.z + 6.0, 0.0));
        let id = w.summon("deed.farmCart").unwrap();
        w.load(id, 0);
        w.toasts();
        assert_eq!(w.summon("deed.farmCart"), None);
        assert_eq!(w.toasts(), ["Your Farm Cart still has cargo aboard - go to it"]);
        assert!(!w.with(|life, sim| recall(life, sim, id, false)));
        assert!(!w.with(|life, sim| recall(life, sim, id, true)));
        assert_eq!(w.toasts(), ["Unload the cargo first"]);
        w.v_mut(id).cargo[0] = 0;
        assert!(w.board(id));
        assert!(!w.with(|life, sim| recall(life, sim, id, false)));
        assert_eq!(w.toasts(), ["Get out first"]);
        assert!(w.dismount());
        let before = w.life.revision;
        assert!(w.with(|life, sim| recall(life, sim, id, false)));
        assert!(w.life.state.vehicles.is_empty());
        assert_eq!(w.life.revision, before + 1);
    }

    #[test]
    fn a_boat_in_for_repairs_cannot_be_called() {
        let mut w = Island::new();
        w.life.state.clock = 100.0;
        w.life.state.repairs = Some(BTreeMap::from([("rowboat".to_string(), 129.2)]));
        w.stand(DOCKS);
        assert_eq!(w.summon("deed.rowboat"), None);
        assert_eq!(w.toasts(), ["Your rowboat is still being repaired (30s)"]);
        w.life.state.clock = 130.0;
        assert!(w.summon("deed.rowboat").is_some());
    }

    #[test]
    fn boarding_seats_you_and_getting_out_steps_you_off_beside_it() {
        let mut w = Island::new();
        let wb = &w.world.zone.recipe.workbenches[0];
        w.stand((wb.x - 6.0, wb.z + 6.0, 0.0));
        let id = w.summon("deed.farmCart").unwrap();
        w.p.vel = V3 { x: 3.0, y: -1.0, z: 2.0 };
        w.p.jump_buffer = 4;
        w.p.sprinting = true;
        assert!(w.board(id));
        let v = w.v(id).clone();
        let seat = anchor_world(&v, &rideable("farmCart").seats[0]);
        let p = &w.p;
        assert_eq!((p.mode, p.vehicle, p.seat, p.jump_buffer, p.sprinting, p.grounded), (Mode::Ride, id, 0, 0, false, true));
        assert_eq!((p.pos.x, p.pos.y, p.pos.z), seat);
        assert_eq!((p.facing, p.vel.x, p.vel.y, p.vel.z), (v.heading, 0.0, 0.0, 0.0));
        assert!(v.ridden);
        // Already riding: can't get into something else.
        assert!(!w.board(id));
        assert!(w.dismount());
        let (v, p, hf) = (w.v(id), &w.p, w.world.terrain());
        assert!(!v.ridden && v.throttle == 0.0 && v.sail == 0.0);
        assert_eq!((p.mode, p.vehicle, p.grounded), (Mode::Normal, 0, true));
        let off = distance_to(v, p.pos.x, p.pos.z);
        assert!(off > 0.0 && off < 1.5, "{off} m from the hull");
        assert!((p.pos.y - hf.height(p.pos.x, p.pos.z)).abs() < 2.2);
        // Nothing to get out of.
        assert!(!w.dismount());
    }

    #[test]
    fn a_cart_picks_up_speed_tops_out_turns_and_reverses() {
        let mut w = Island::new();
        w.stand(ROAD);
        let id = w.summon("deed.farmCart").expect("a cart on the road");
        w.board(id);
        let (x0, z0) = (w.v(id).x, w.v(id).z);
        let mut top: f64 = 0.0;
        for _ in 0..150 {
            w.frames(1, drive(1.0, 0.0, false));
            top = top.max(w.v(id).speed);
        }
        let v = w.v(id);
        assert!(hypot(v.x - x0, v.z - z0) > 8.0, "drove {} m", hypot(v.x - x0, v.z - z0));
        assert!(top > 5.0 && top <= 8.5 + 1e-9, "top speed {top}");
        // The rider sits in the driver's seat all the way.
        assert_eq!((w.p.pos.x, w.p.pos.y, w.p.pos.z), anchor_world(v, &rideable("farmCart").seats[0]));
        let h0 = v.heading;
        w.frames(60, drive(1.0, 1.0, false));
        assert!(angle_diff(h0, w.v(id).heading).abs() > 0.5, "turned {}", angle_diff(h0, w.v(id).heading));
        w.frames(200, drive(-1.0, 0.0, false));
        let v = w.v(id);
        assert!(v.speed < -1.0 && v.speed >= -3.0 - 1e-9, "reversing at {}", v.speed);
    }

    #[test]
    fn the_handbrake_slides_a_roadster_through_a_turn() {
        let lateral = |handbrake: bool| {
            let mut w = Island::new();
            w.stand(ROAD);
            let id = w.summon("deed.roadster").expect("a roadster on the road");
            w.board(id);
            w.frames(100, drive(1.0, 0.0, false));
            assert!(w.v(id).speed > 12.0, "up to speed: {}", w.v(id).speed);
            w.frames(18, drive(1.0, 1.0, handbrake));
            slip(w.v(id))
        };
        let (drift, grip) = (lateral(true), lateral(false));
        assert!(drift > 1.5 && drift > grip * 1.5, "slides {drift} with the handbrake, {grip} without");
    }

    #[test]
    fn a_sloop_runs_faster_with_the_wind_behind_her() {
        let sail = |wind: f64| {
            let mut w = Island::new();
            w.stand(DOCKS);
            let id = w.summon("deed.sloop").unwrap();
            w.board(id);
            w.life.state.weather.wind_dir = w.v(id).heading + wind;
            w.life.state.weather.wind_speed = 0.8;
            w.frames(420, drive(1.0, 0.0, false));
            let v = w.v(id);
            assert!(v.sail > 0.95 && v.throttle == v.sail);
            v.speed
        };
        let (downwind, upwind) = (sail(0.0), sail(PI));
        assert!(downwind > 4.0 && downwind > upwind * 2.0, "{downwind} m/s downwind, {upwind} upwind");
    }

    #[test]
    fn a_rowboat_runs_aground_in_the_shallows() {
        let mut w = Island::new();
        w.stand(DOCKS);
        let id = w.summon("deed.rowboat").unwrap();
        // Two metres of water off an open beach, bow to the sand.
        let (x, shore) = w.waterline(-60.0, -300.0);
        let (x, z) = w.south_to(x, shore, 2.0);
        let v = w.v_mut(id);
        (v.x, v.z, v.heading) = (x, z, 0.0);
        w.board(id);
        let def = rideable("rowboat");
        let hf = w.world.terrain();
        let mut stopped = 0;
        for _ in 0..600 {
            w.frames(1, drive(1.0, 0.0, false));
            let v = w.v(id);
            assert!(hf.water - hf.height(v.x, v.z) >= def.draft, "never into water shallower than her draft");
            if v.speed == 0.0 {
                stopped += 1;
            }
        }
        assert!(stopped > 0, "she touched bottom");
        assert!(w.v(id).z > z + 5.0 && w.v(id).z < shore, "in the shallows, short of the beach");
        // At speed, on the second: the shout.
        let v = w.v(id).clone();
        let (fx, fz) = (v.heading.sin(), v.heading.cos());
        let i = vehicle_index(&w.life, id).unwrap();
        w.life.state.vehicles[i].vx = fx * 5.0;
        w.life.state.vehicles[i].vz = fz * 5.0;
        w.life.state.clock = 300.0;
        w.toasts();
        w.frames(1, drive(1.0, 0.0, false));
        assert_eq!(w.toasts(), ["Running aground!"]);
        let v = w.v(id);
        assert!(v.vx * fx + v.vz * fz < 0.0, "bounced back");
    }

    #[test]
    fn an_empty_boat_drifts_to_a_stop() {
        let mut w = Island::new();
        w.stand(DOCKS);
        let id = w.summon("deed.sloop").unwrap();
        w.board(id);
        w.life.state.weather.wind_dir = w.v(id).heading;
        w.frames(300, drive(1.0, 0.0, false));
        assert!(w.v(id).sail > 0.9 && w.v(id).speed > 3.0);
        w.dismount();
        w.frames(600, Actions::default());
        let v = w.v(id);
        assert_eq!(v.sail, 0.0);
        assert!(v.speed.abs() < 0.5, "still doing {}", v.speed);
    }

    #[test]
    fn a_storm_breaks_up_a_boat_under_you_and_its_cargo_floats() {
        let mut w = Island::new();
        w.stand(DOCKS);
        let id = w.summon("deed.rowboat").unwrap();
        let pack = w.load(id, 0);
        let (x, z) = w.offshore(16.0);
        let v = w.v_mut(id);
        v.x = x;
        v.z = z;
        v.hp = 25.0;
        w.board(id);
        w.life.state.weather.rain_until = 1000.0;
        w.toasts();
        let mut wreck = None;
        for _ in 0..600 {
            if let Some(i) = vehicle_index(&w.life, id) {
                wreck = Some((w.life.state.vehicles[i].x, w.life.state.vehicles[i].z, w.life.state.clock));
            }
            w.frames(1, drive(0.3, 0.0, false));
        }
        assert!(vehicle_index(&w.life, id).is_none(), "she went down");
        assert_eq!(
            w.toasts(),
            [
                "🌊 The sea is rough - your rowboat's hull is taking a beating! Make for shallower water.",
                "💥 Your rowboat broke up in the swell! 1 pack is floating where she went down.",
            ]
        );
        let hf = w.world.terrain();
        let p = &w.p;
        assert_eq!((p.mode, p.vehicle, p.grounded), (Mode::Normal, 0, false));
        assert_eq!(p.pos.y, hf.water - content::swim().float);
        let (wx, wz, when) = wreck.unwrap();
        let pk = w.life.state.packs.iter().find(|pk| pk.id == pack).unwrap();
        assert_eq!((pk.at.as_str(), pk.vehicle, pk.y), ("ground", 0, hf.water - 0.15));
        let d = hypot(pk.x - wx, pk.z - wz);
        assert!(d > 1.0 && d < 4.5, "floating {d} m from the wreck");
        assert_eq!(w.life.state.repairs.as_ref().unwrap()["rowboat"], when + 90.0);
        // And she's out for repairs.
        w.stand(DOCKS);
        assert_eq!(w.summon("deed.rowboat"), None);
        assert!(w.toasts()[0].starts_with("Your rowboat is still being repaired ("));
    }

    #[test]
    fn a_boat_lost_mid_step_leaves_the_others_their_step() {
        let mut w = Island::new();
        w.stand(DOCKS);
        let lost = w.summon("deed.rowboat").unwrap();
        let other = w.summon("deed.sloop").unwrap();
        let (x, z) = w.offshore(16.0);
        w.load(lost, 1);
        let v = w.v_mut(lost);
        (v.x, v.z, v.hp) = (x, z, 0.01);
        let v = w.v_mut(other);
        (v.x, v.z, v.vx, v.vz) = (x + 24.0, z - 5.0, 3.0, -2.0);
        w.life.state.weather.rain_until = 1000.0;
        w.toasts();
        w.frames(1, Actions::default());
        assert_eq!(w.toasts(), ["💥 Your rowboat broke up in the swell! 1 pack is floating where she went down."]);
        assert_eq!(w.life.state.vehicles.len(), 1);
        let v = w.v(other);
        assert!(v.x > x + 24.0 + 0.04 && v.z < z - 5.0 - 0.02, "the sloop moved on the same step");
        assert_eq!(v.storm_warned, None, "nobody aboard to warn");
    }

    #[test]
    fn a_horse_wont_carry_a_trade_pack_but_a_donkey_will() {
        let mut w = Island::new();
        w.stand((0.0, -200.0, 0.0));
        w.mount();
        assert_eq!(w.toasts(), ["You have no mount yet - Sela at the stables sells them"]);
        w.life.give("whistle.horse", 1, true);
        w.p.pack = 77;
        w.mount();
        assert_eq!(w.toasts(), ["Your horse won't carry a trade pack - a donkey will"]);
        assert!(w.life.state.vehicles.is_empty() && w.p.mode == Mode::Normal);
        w.life.give("whistle.donkey", 1, true);
        w.mount();
        assert_eq!(w.p.mode, Mode::Ride);
        assert_eq!(w.v(w.p.vehicle).def, "donkey");
        // Off again, and the horse that was never called still won't take the pack.
        w.mount();
        assert_eq!(w.p.mode, Mode::Normal);
        w.p.pack = 0;
        w.stand((0.0, -180.0, 0.0));
        w.mount();
        let horse = w.p.vehicle;
        assert_eq!(w.v(horse).def, "horse", "the fastest you have");
        w.mount();
        w.p.pack = 77;
        assert!(!w.board(horse));
        assert_eq!(w.toasts(), ["Your horse won't carry a trade pack - a donkey will"]);
    }

    #[test]
    fn the_whistle_brings_the_same_mount_back() {
        let mut w = Island::new();
        w.life.give("whistle.donkey", 1, true);
        w.stand((0.0, -200.0, 0.0));
        w.mount();
        let id = w.p.vehicle;
        assert_eq!((w.v(id).x, w.v(id).z), (0.0, -200.0));
        w.mount();
        // Nearby, it stays put and you climb on.
        w.stand((10.0, -200.0, 0.0));
        w.mount();
        assert_eq!((w.p.vehicle, w.v(id).x), (id, 0.0));
        w.mount();
        // Far off, it comes to you.
        w.stand((60.0, -170.0, 1.0));
        w.mount();
        assert_eq!(w.p.vehicle, id);
        let v = w.v(id);
        assert_eq!((v.x, v.z, v.heading, v.speed), (60.0, -170.0, 1.0, 0.0));
        assert_eq!(w.life.state.vehicles.iter().filter(|v| v.def == "donkey").count(), 1);
    }

    #[test]
    fn a_mount_gallops_but_a_pack_keeps_it_to_a_trot() {
        // (average over two seconds, fastest) with the sprint key held.
        let pace = |pack: i64, whistle: &str| {
            let mut w = Island::new();
            w.life.give(whistle, 1, true);
            w.stand((0.0, -200.0, 0.0));
            w.p.pack = pack;
            w.mount();
            let id = w.p.vehicle;
            let (x0, z0) = (w.v(id).x, w.v(id).z);
            let mut top: f64 = 0.0;
            for _ in 0..120 {
                w.frames(1, walk(0.0, 1.0, true));
                top = top.max(w.v(id).speed);
            }
            (hypot(w.v(id).x - x0, w.v(id).z - z0) / 2.0, top)
        };
        let (laden, laden_top) = pace(9, "whistle.donkey");
        assert!(laden > 4.5 && laden < 7.6, "donkey with a pack: {laden} m/s");
        assert_eq!(laden_top, 7.5, "its pack pace");
        let (gallop, gallop_top) = pace(0, "whistle.horse");
        assert!(gallop > 10.0, "horse at the gallop: {gallop} m/s");
        assert_eq!(gallop_top, 16.5);
    }

    #[test]
    fn a_donkey_swims_out_and_climbs_back_onto_the_beach() {
        let mut w = Island::new();
        let (x, z) = w.waterline(60.0, -300.0);
        w.life.give("whistle.donkey", 1, true);
        w.stand((x, z + 8.0, PI));
        w.mount();
        let id = w.p.vehicle;
        let hf = w.world.terrain();
        let mut swam = false;
        for _ in 0..400 {
            w.frames(1, walk(0.0, -1.0, false));
            let v = w.v(id);
            if v.swimming {
                swam = true;
                assert!(v.y >= hf.water - 1.0, "riding the surface");
            }
        }
        assert!(swam, "out of its depth");
        w.frames(700, walk(0.0, 1.0, false));
        let v = w.v(id);
        assert!(!v.swimming && hf.height(v.x, v.z) > hf.water, "back on the sand");
    }

    #[test]
    fn a_cart_stops_at_the_waters_edge() {
        let mut w = Island::new();
        let (x, z) = w.waterline(-60.0, -300.0);
        w.stand((x, z + 16.0, PI));
        let id = w.summon("deed.farmCart").expect("a cart on the beach");
        w.board(id);
        let hf = w.world.terrain();
        for _ in 0..300 {
            w.frames(1, drive(1.0, 0.0, false));
            let v = w.v(id);
            assert!(hf.water - hf.height(v.x, v.z) <= 0.8, "wading at most axle-deep");
        }
        let v = w.v(id);
        assert!(hf.water - hf.height(v.x, v.z) > 0.5, "drove into the shallows");
    }

    #[test]
    fn you_bump_into_a_parked_cart_but_not_one_far_below_you() {
        let mut w = Island::new();
        let wb = &w.world.zone.recipe.workbenches[0];
        w.stand((wb.x - 6.0, wb.z + 6.0, 0.0));
        let id = w.summon("deed.farmCart").unwrap();
        w.frames(30, Actions::default());
        let v = w.v(id).clone();
        let (rx, rz) = (-v.heading.cos(), v.heading.sin());
        w.p.pos = V3 { x: v.x + rx * 0.6, y: v.y, z: v.z + rz * 0.6 };
        w.frames(1, Actions::default());
        let parked = w.v(id);
        assert_eq!((parked.x, parked.z), (v.x, v.z), "held by its handbrake");
        let out = hypot(w.p.pos.x - v.x, w.p.pos.z - v.z);
        assert!(out >= 1.05 + 0.35 - 1e-9, "pushed {out} m out");
        // Standing well above it (on a deck, say), you are left alone.
        w.p.pos = V3 { x: v.x + rx * 0.6, y: v.y + 3.0, z: v.z + rz * 0.6 };
        w.frames(1, Actions::default());
        assert_eq!((w.p.pos.x, w.p.pos.z), (v.x + rx * 0.6, v.z + rz * 0.6));
    }

    #[test]
    fn the_nearest_seat_or_cargo_slot_and_the_distance_to_the_hull() {
        let v = Vehicle { def: "farmCart".into(), x: 10.0, z: 20.0, ..Default::default() };
        let a = nearest_anchor(&v, 10.42, 20.95, false);
        assert_eq!((a.kind, a.index), ("seat", 0));
        assert!(a.dist < 1e-9);
        // With a crate in your arms the bed wins.
        let b = nearest_anchor(&v, 10.43, 18.95, true);
        assert_eq!((b.kind, b.index), ("cargo", 2));
        assert!((b.dist + 0.6).abs() < 1e-9);
        assert_eq!(distance_to(&v, 10.5, 21.0), 0.0);
        assert!((distance_to(&v, 10.0 + 0.95 + 2.0, 20.0) - 2.0).abs() < 1e-12);
        // Turned to face +X, the seat (0.42 to the left, 0.95 ahead) turns with it.
        let turned = Vehicle { heading: PI / 2.0, ..v.clone() };
        let (sx, _, sz) = anchor_world(&turned, &rideable("farmCart").seats[0]);
        assert!((sx - 10.95).abs() < 1e-9 && (sz - 19.58).abs() < 1e-9, "{sx} {sz}");
        assert!(nearest_anchor(&turned, sx, sz, false).dist < 1e-9);
        // Pitch and roll lift the seat with the floor.
        let tilted = Vehicle { pitch: 0.1, roll: -0.2, ..v };
        let (_, y, _) = anchor_world(&tilted, &rideable("farmCart").seats[0]);
        assert!((y - (1.05 - 0.95 * 0.1f64.sin() + 0.42 * (-0.2f64).sin())).abs() < 1e-12);
    }

    #[test]
    fn nothing_a_browser_sends_can_break_it() {
        let mut w = Island::new();
        w.stand((0.0, -200.0, 0.0));
        w.life.give("nope", 1, true);
        assert_eq!(w.with(|life, sim| summon(life, sim, "nope")), None);
        assert_eq!(w.with(|life, sim| summon(life, sim, "")), None);
        assert!(!w.board(12345));
        assert!(!w.with(|life, sim| recall(life, sim, 12345, false)));
        assert!(!w.dismount());
        // Riding something that is no longer there puts you back on your feet.
        w.p.mode = Mode::Ride;
        w.p.vehicle = 999;
        w.frames(1, Actions::default());
        assert_eq!((w.p.mode, w.p.vehicle), (Mode::Normal, 0));
        w.p.mode = Mode::Ride;
        w.p.vehicle = 999;
        assert!(!w.dismount());
        assert_eq!((w.p.mode, w.p.vehicle), (Mode::Normal, 0));
        // A vehicle the content no longer knows, with no cargo list, still drives (as a small cart).
        let hf = w.world.terrain();
        let y = hf.height(0.0, -195.0);
        w.life.state.vehicles.push(Vehicle { id: 50, def: "retired".into(), z: -195.0, y, hp: 1.0, grounded: true, ..Default::default() });
        w.frames(10, Actions::default());
        assert!(w.board(50));
        w.frames(30, drive(1.0, 0.5, true));
        assert!(w.dismount());
        let _ = nearest_anchor(w.v(50), 0.0, 0.0, true);
        // A boat with a cargo id that matches no pack breaks up all the same.
        w.stand(DOCKS);
        let id = w.summon("deed.rowboat").unwrap();
        let (x, z) = w.offshore(16.0);
        let v = w.v_mut(id);
        (v.x, v.z, v.hp, v.cargo) = (x, z, 0.01, vec![424242, 0]);
        w.life.state.weather.rain_until = 1e9;
        w.toasts();
        w.frames(1, Actions::default());
        assert!(vehicle_index(&w.life, id).is_none());
        assert_eq!(w.toasts(), ["💥 Your rowboat broke up in the swell! 1 pack is floating where she went down."]);
    }
}
