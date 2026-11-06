//! Getting around an open world: walking over hills (and not up cliffs), wading and swimming,
//! and flying a glider. A port of src/sim/player/traverse.ts: the same arithmetic in the same
//! order, so the browser's prediction and the server agree (tests/conformance/world.test.ts).
//! The TypeScript's events (landing, splashes, the glider opening) are for the screen; the server
//! has none, so they are left out.

use crate::jsmath::JsMath;
use crate::life::content::js_hypot;
use super::colliders::{ground_at, ground_at_decks, in_rect, push_out_of_box};
use super::zone::Updraft;
use super::Sim;
use crate::life::content::{carry, glide, glider_def, ground, js_round, swim};
use crate::player::{angle_diff, len, step_len, turn_toward, Actions, Mode, Player};
use crate::tuning::{combo_for, tuning};

const PI: f64 = std::f64::consts::PI;
const TAU: f64 = std::f64::consts::TAU;

// ---------- Integration over terrain ----------

pub fn integrate_open(sim: &mut Sim) {
    let t = tuning();
    let dt = step_len();
    let hf = sim.terrain();
    let gr = ground();
    {
        let p = &mut *sim.player;
        if p.gust_frames > 0 {
            p.gust_frames -= 1;
        }
        if p.mode == Mode::Ride {
            return; // the vehicle put us in our seat
        }

        if !p.grounded && p.mode != Mode::Swim && p.mode != Mode::Glide {
            let mut g = if p.vel.y > 0.0 { t.jump.gravity_up } else { t.jump.gravity_down };
            if p.mode == Mode::Attack {
                let step = &combo_for(p.weapon, &p.resolved)[p.attack_index];
                if p.attack_frame <= step.startup + step.active {
                    g *= t.attack.air_gravity_scale;
                }
            }
            p.vel.y = (p.vel.y - g * dt).max(-t.jump.max_fall);
        }
    }

    let ox = sim.player.pos.x;
    let oz = sim.player.pos.z;
    let mut dx = sim.player.vel.x * dt;
    let mut dz = sim.player.vel.z * dt;
    // Wading is about how deep your feet are, not the seabed: on a pier you walk normally.
    if sim.player.grounded && hf.water - sim.player.pos.y > gr.wade_depth {
        dx *= gr.wade_speed;
        dz *= gr.wade_speed;
    }
    sim.player.pos.y += sim.player.vel.y * dt;

    // The land as a wall: try the whole move, then slide along whichever axis is free.
    if blocked(sim, ox, oz, ox + dx, oz + dz) {
        if !blocked(sim, ox, oz, ox + dx, oz) {
            dz = 0.0;
            sim.player.vel.z = 0.0;
        } else if !blocked(sim, ox, oz, ox, oz + dz) {
            dx = 0.0;
            sim.player.vel.x = 0.0;
        } else {
            dx = 0.0;
            dz = 0.0;
            sim.player.vel.x = 0.0;
            sim.player.vel.z = 0.0;
            if sim.player.mode == Mode::Glide {
                close_glider(sim, "crash");
            }
        }
    }
    sim.player.pos.x = ox + dx;
    sim.player.pos.z = oz + dz;

    collide_open(sim);
    settle(sim);
    let p = &mut *sim.player;
    if p.grounded && p.mode == Mode::Normal {
        p.run_phase += len(p.vel.x, p.vel.z) * dt;
    }
}

// ---------- Decks ----------
// A deck (a pier, the glider launch, a house floor) is ground on top and open underneath. Walking,
// you step up onto one as high as deck_step (they are built to be walked onto); in the air, only
// within the usual step_up, as you land. One you can't get onto, and too low to pass under, is as
// solid as a wall from the side.

/// How high a deck you can get onto right now: walking, a deck's own step; in the air, as you land.
pub fn deck_reach(p: &Player) -> f64 {
    if p.grounded { ground().deck_step } else { ground().step_up }
}

/// Whether a deck topped at `top` is in the way of feet at `y` that get `reach` up: too high to get
/// onto, too low to pass under.
pub fn deck_in_the_way(top: f64, y: f64, reach: f64) -> bool {
    top > y + reach && top < y + ground().deck_headroom
}

/// Would the move carry you into a deck in your way? collide_open keeps you off their edges; this
/// stops anything fast enough to cross one in a single step.
fn into_deck(sim: &Sim, ox: f64, oz: f64, nx: f64, nz: f64, reach: f64) -> bool {
    let y = sim.player.pos.y;
    let mut hit = false;
    sim.world.index.each_deck(nx, nz, 0.5, |d| {
        if !hit && deck_in_the_way(d.top, y, reach) && in_rect(d, nx, nz, 0.0) && !in_rect(d, ox, oz, 0.0) {
            hit = true;
        }
    });
    hit
}

/// Would moving from (ox, oz) to (nx, nz) walk into a cliff, a wall of rock, a deck's side, or a
/// ledge too high?
fn blocked(sim: &Sim, ox: f64, oz: f64, nx: f64, nz: f64) -> bool {
    let p = &*sim.player;
    let run = js_hypot(nx - ox, nz - oz);
    if run < 1e-7 {
        return false;
    }
    let hf = sim.terrain();
    let gr = ground();
    let reach = deck_reach(p);
    if into_deck(sim, ox, oz, nx, nz, reach) {
        return true;
    }
    let terrain = hf.height(nx, nz);
    let g = ground_at_decks(hf, &sim.world.index, nx, nz, p.pos.y, gr.step_up, reach);
    let rise = g - p.pos.y;
    if rise <= 0.02 {
        return false;
    }
    if g > terrain + 0.01 {
        return false; // a deck or a box top, low enough to step up onto
    }
    if rise > gr.step_up {
        return true;
    }
    // Climbing the terrain itself: only up slopes gentle enough to walk.
    p.grounded && hf.slope(nx, nz) > gr.max_slope
}

/// Trees, rocks, buildings and the edge of the world. (The TypeScript also pushes you out of
/// solid creatures, but only with its training option, which the server never uses.)
pub fn collide_open(sim: &mut Sim) {
    let r = tuning().movement.player_radius;
    let idx = &sim.world.index;
    let p = &mut *sim.player;
    idx.each_obstacle(p.pos.x, p.pos.z, r + 2.0, |o| {
        if o.r <= 0.0 {
            return;
        }
        let ox = p.pos.x - o.x;
        let oz = p.pos.z - o.z;
        let min = o.r + r;
        let d2 = ox * ox + oz * oz;
        if d2 >= min * min {
            return;
        }
        let root = d2.sqrt();
        let d = if root == 0.0 { 0.0001 } else { root };
        let nx = ox / d;
        let nz = oz / d;
        p.pos.x = o.x + nx * min;
        p.pos.z = o.z + nz * min;
        let vn = p.vel.x * nx + p.vel.z * nz;
        if vn < 0.0 {
            p.vel.x -= vn * nx;
            p.vel.z -= vn * nz;
        }
    });
    idx.each_box(p.pos.x, p.pos.z, r + 1.0, |b| {
        if p.pos.y >= b.top - 0.05 {
            return; // standing on it, or flying over
        }
        let Some((px, pz)) = push_out_of_box(b, p.pos.x, p.pos.z, r) else { return };
        p.pos.x += px;
        p.pos.z += pz;
        let h = js_hypot(px, pz);
        let l = if h == 0.0 { 1.0 } else { h };
        let nx = px / l;
        let nz = pz / l;
        let vn = p.vel.x * nx + p.vel.z * nz;
        if vn < 0.0 {
            p.vel.x -= vn * nx;
            p.vel.z -= vn * nz;
        }
    });
    // A deck's side, where it is too high to get onto and too low to pass under. Already beneath
    // one (wading under a pier), you carry on.
    let reach = deck_reach(p);
    idx.each_deck(p.pos.x, p.pos.z, r + 1.0, |d| {
        if !deck_in_the_way(d.top, p.pos.y, reach) || in_rect(d, p.pos.x, p.pos.z, 0.0) {
            return;
        }
        let Some((px, pz)) = push_out_of_box(d, p.pos.x, p.pos.z, r) else { return };
        p.pos.x += px;
        p.pos.z += pz;
        let h = js_hypot(px, pz);
        let l = if h == 0.0 { 1.0 } else { h };
        let nx = px / l;
        let nz = pz / l;
        let vn = p.vel.x * nx + p.vel.z * nz;
        if vn < 0.0 {
            p.vel.x -= vn * nx;
            p.vel.z -= vn * nz;
        }
    });
    let lim = sim.world.radius;
    let rr = len(p.pos.x, p.pos.z);
    if rr > lim {
        p.pos.x *= lim / rr;
        p.pos.z *= lim / rr;
    }
}

/// Ground contact after moving: stay on it, step off it, land on it, or fall into the sea.
fn settle(sim: &mut Sim) {
    let hf = sim.terrain();
    let gr = ground();
    let sw = swim();
    let dt = step_len();
    let g = ground_at_decks(hf, &sim.world.index, sim.player.pos.x, sim.player.pos.z, sim.player.pos.y, gr.step_up, deck_reach(sim.player));
    if sim.player.mode == Mode::Swim {
        return; // update_swim keeps you at the surface
    }
    if sim.player.grounded {
        let p = &mut *sim.player;
        let speed = len(p.vel.x, p.vel.z);
        let drop = p.pos.y - g;
        let snap = gr.snap_down + speed * dt * gr.max_slope * 1.2;
        if drop > snap {
            p.grounded = false; // walked off an edge
        } else {
            p.pos.y = g;
            p.vel.y = 0.0;
            // Too steep to stand on (you landed on a cliff face): slide off it.
            if g <= hf.height(p.pos.x, p.pos.z) + 0.01 && hf.slope(p.pos.x, p.pos.z) > gr.max_slope + 0.35 {
                let (gx, gz) = hf.gradient(p.pos.x, p.pos.z);
                p.grounded = false;
                p.vel.x -= gx * 2.5;
                p.vel.z -= gz * 2.5;
            }
        }
    } else if sim.player.pos.y <= g && sim.player.vel.y <= 0.0 {
        let was_gliding = sim.player.mode == Mode::Glide;
        {
            let p = &mut *sim.player;
            p.grounded = true;
            p.jumps_used = 0;
            p.flip_frame = -1;
            p.land_frame = 0;
            p.land_impact = (-p.vel.y / 20.0).min(1.0);
            p.pos.y = g;
            p.vel.y = 0.0;
        }
        if was_gliding {
            close_glider(sim, "land");
            sim.player.vel.x *= glide().land_keep;
            sim.player.vel.z *= glide().land_keep;
        }
    }
    // Deep water: swim.
    let p = &*sim.player;
    if p.mode != Mode::Ride && hf.water - hf.height(p.pos.x, p.pos.z) > sw.depth && p.pos.y <= hf.water - sw.float + 0.02 {
        enter_swim(sim);
    }
}

// ---------- Swimming ----------

fn enter_swim(sim: &mut Sim) {
    let hf = sim.terrain();
    if sim.player.mode == Mode::Glide {
        close_glider(sim, "water");
    }
    let p = &mut *sim.player;
    p.mode = Mode::Swim;
    p.mode_frame = 0;
    p.grounded = false;
    p.jumps_used = 0;
    p.flip_frame = -1;
    p.vel.y = 0.0;
    p.pos.y = hf.water - swim().float;
    p.vel.x *= 0.35;
    p.vel.z *= 0.35;
}

pub fn update_swim(sim: &mut Sim, a: &Actions) {
    let hf = sim.terrain();
    let sw = swim();
    let dt = step_len();
    let idx = &sim.world.index;
    let p = &mut *sim.player;
    p.mode_frame += 1;
    let mag = len(a.move_x, a.move_z).min(1.0);
    let dx = if mag > 0.05 { a.move_x / len(a.move_x, a.move_z) } else { 0.0 };
    let dz = if mag > 0.05 { a.move_z / len(a.move_x, a.move_z) } else { 0.0 };
    let mut speed = (if a.sprint_held { sw.sprint_speed } else { sw.speed }) * (if mag > 0.05 { mag } else { 0.0 });
    if p.pack != 0 {
        speed *= carry().swim_factor;
    }
    p.sprinting = a.sprint_held && mag > 0.5;
    if mag > 0.05 {
        p.facing = turn_toward(p.facing, dx.js_atan2(dz), sw.turn_speed * dt);
    }
    let tx = dx * speed;
    let tz = dz * speed;
    let ex = tx - p.vel.x;
    let ez = tz - p.vel.z;
    let err = len(ex, ez);
    let step = sw.accel * dt;
    if err <= step {
        p.vel.x = tx;
        p.vel.z = tz;
    } else {
        p.vel.x += (ex / err) * step;
        p.vel.z += (ez / err) * step;
    }
    p.vel.y = 0.0;
    p.pos.y = hf.water - sw.float + (p.mode_frame as f64 * 0.09).js_sin() * 0.04;

    // Shallow enough to stand: walk out.
    let under = ground_at(hf, idx, p.pos.x, p.pos.z, p.pos.y, ground().step_up);
    if hf.water - under < sw.depth - 0.1 {
        p.mode = Mode::Normal;
        p.grounded = true;
        p.pos.y = p.pos.y.max(under);
        return;
    }
    // Jump at an edge (a dock, a steep bank) to haul yourself out.
    if p.jump_buffer > 0 {
        let ax = p.pos.x + p.facing.js_sin() * 1.2;
        let az = p.pos.z + p.facing.js_cos() * 1.2;
        let ahead = ground_at(hf, idx, ax, az, hf.water + 2.2, 2.2);
        if ahead > hf.water - 0.6 && ahead < hf.water + 2.2 {
            p.jump_buffer = 0;
            p.mode = Mode::Normal;
            p.grounded = false;
            p.jumps_used = 1;
            p.vel.y = sw.climb_out;
            p.vel.x = p.facing.js_sin() * 3.0;
            p.vel.z = p.facing.js_cos() * 3.0;
        }
    }
}

// ---------- Gliding ----------

/// Height of your feet above whatever is under you (water counts as a floor).
pub fn height_above_ground(sim: &Sim) -> f64 {
    let p = &*sim.player;
    let hf = sim.terrain();
    let g = hf.water.max(ground_at(hf, &sim.world.index, p.pos.x, p.pos.z, p.pos.y, 0.0));
    p.pos.y - g
}

/// Why the glider will not open right now, or None if it will.
pub fn glider_blocked(sim: &Sim) -> Option<&'static str> {
    let p = &*sim.player;
    if p.glider.is_empty() {
        return Some("You have no glider");
    }
    if p.pack != 0 {
        return Some("Too heavy to glide with a trade pack");
    }
    if p.grounded {
        return Some("Jump first");
    }
    if p.mode != Mode::Normal {
        return Some("Busy");
    }
    if height_above_ground(sim) < glider_def(&p.glider).min_height {
        return Some("Too low to open the glider");
    }
    None
}

pub fn open_glider(sim: &mut Sim) -> bool {
    if glider_blocked(sim).is_some() {
        return false;
    }
    let p = &mut *sim.player;
    let g = glider_def(&p.glider);
    p.mode = Mode::Glide;
    p.mode_frame = 0;
    p.jump_buffer = 0;
    p.flip_frame = -1;
    p.sprinting = false;
    p.crouching = false;
    p.airspeed = len(p.vel.x, p.vel.z).max(g.flare_speed);
    let hs = len(p.vel.x, p.vel.z);
    if hs > 0.5 {
        p.facing = p.vel.x.js_atan2(p.vel.z);
    }
    true
}

/// why: "fold", "land", "crash" or "water".
pub fn close_glider(sim: &mut Sim, _why: &str) {
    let p = &mut *sim.player;
    if p.mode != Mode::Glide {
        return;
    }
    p.mode = Mode::Normal;
    p.mode_frame = 0;
    p.bank = 0.0;
    // Folding mid-air still lets you double jump once more before you need to open it again.
    if !p.grounded {
        p.jumps_used = 1;
    }
}

/// Climb rate from rising air at a point.
pub fn updraft_lift(updrafts: &[Updraft], x: f64, y: f64, z: f64) -> f64 {
    let mut lift = 0.0;
    for u in updrafts {
        let d = js_hypot(x - u.x, z - u.z);
        if d >= u.r || y >= u.top {
            continue;
        }
        let core = 1.0 - (d / u.r) * (d / u.r);
        let cap = ((u.top - y) / 18.0).min(1.0);
        lift += u.strength * core * cap;
    }
    lift
}

/// F in flight: the glider's gust, a burst of speed and lift. Returns false while it recharges.
pub fn gust(sim: &mut Sim) -> bool {
    let p = &mut *sim.player;
    if p.mode != Mode::Glide || p.gust_frames > 0 {
        return false;
    }
    let Some(g) = glider_def(&p.glider).gust else { return false };
    p.airspeed += g.speed;
    p.vel.y = p.vel.y.max(0.0) + g.lift;
    p.gust_frames = js_round(g.cooldown_seconds / step_len()) as i32;
    true
}

pub fn update_glide(sim: &mut Sim, a: &Actions) {
    let gl = glide();
    let dt = step_len();
    let g = glider_def(&sim.player.glider);
    sim.player.mode_frame += 1;

    // Press jump again to fold the wing and drop. A fresh press only: one buffered from just before
    // the wing opened must not fold it again a moment later.
    if a.jump_pressed && sim.player.mode_frame > gl.open_frames {
        sim.player.jump_buffer = 0;
        close_glider(sim, "fold");
        return;
    }

    // Attitude: dive for speed, flare to slow down and bleed speed into height.
    let dive = a.sprint_held;
    let flare = a.crouch_held && !dive;
    let target_speed = if dive { g.dive_speed } else if flare { g.flare_speed } else { g.cruise_speed };
    let target_sink = if dive { g.dive_sink } else if flare { g.flare_sink } else { g.sink };

    let updrafts = &sim.world.zone.recipe.updrafts;
    let p = &mut *sim.player;
    // Heading: turn toward where the stick points, no faster than the wing allows.
    let mag = len(a.move_x, a.move_z).min(1.0);
    let mut turn = 0.0;
    if mag > 0.15 {
        let want = a.move_x.js_atan2(a.move_z);
        let diff = angle_diff(p.facing, want);
        turn = (-g.turn_rate).max(g.turn_rate.min(diff * gl.turn_ease)) * mag;
    }
    p.facing += turn * dt;
    if p.facing > PI {
        p.facing -= TAU;
    }
    if p.facing < -PI {
        p.facing += TAU;
    }
    let bank_want = (turn / g.turn_rate) * gl.max_bank;
    p.bank += (bank_want - p.bank) * (1.0 - (-6.0 * dt).js_exp());

    let prev = p.airspeed;
    p.airspeed += (target_speed - p.airspeed) * (1.0 - (-g.speed_ease * dt).js_exp());
    let mut vy = -target_sink;
    // Speed shed by a flare comes back as height, the way a swallow pulls up out of a dive.
    let shed = prev - p.airspeed;
    if shed > 0.0 {
        vy += ((prev * shed) / dt / 9.81) * g.zoom_lift;
    }
    if p.airspeed < g.stall_speed {
        vy -= (g.stall_speed - p.airspeed) * 2.0;
    }
    vy += updraft_lift(updrafts, p.pos.x, p.pos.y, p.pos.z);
    p.vel.y += (vy - p.vel.y) * (1.0 - (-gl.vertical_ease * dt).js_exp());
    p.vel.x = p.facing.js_sin() * p.airspeed;
    p.vel.z = p.facing.js_cos() * p.airspeed;
}

// The frame-by-frame match with the TypeScript is tests/conformance/world.test.ts; these only check
// that the server's rules hold up on their own.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::open::zone::emberholm;
    use crate::open::{step_player, OpenWorld};
    use crate::player::{Build, Player};
    use crate::world::Spawn;

    /// A player stood on the ground at (x, z), the way the browser places one.
    fn stand(world: &OpenWorld, x: f64, z: f64, facing: f64) -> Player {
        let mut p = Player::new(Spawn { x, z, facing }, 0, Build::default());
        let hf = world.terrain();
        p.pos.y = ground_at(hf, &world.index, x, z, hf.height(x, z) + 1.2, 1.2);
        p
    }

    fn step(p: &mut Player, world: &mut OpenWorld, a: Actions) {
        step_player(p, &a, world, None, 0);
    }

    #[test]
    fn rising_air_is_strongest_at_its_core_and_stops_at_its_top() {
        let u = [Updraft { x: 0.0, z: 0.0, r: 10.0, top: 100.0, strength: 8.0 }];
        assert_eq!(updraft_lift(&u, 0.0, 50.0, 0.0), 8.0);
        assert!(updraft_lift(&u, 5.0, 50.0, 0.0) < 8.0);
        assert_eq!(updraft_lift(&u, 10.0, 50.0, 0.0), 0.0);
        assert_eq!(updraft_lift(&u, 0.0, 100.0, 0.0), 0.0);
        assert!(updraft_lift(&u, 0.0, 95.0, 0.0) < updraft_lift(&u, 0.0, 70.0, 0.0));
    }

    #[test]
    fn off_the_end_of_a_pier_you_swim_and_a_jump_hauls_you_out() {
        let mut world = OpenWorld::new(emberholm());
        let mut p = stand(&world, 17.0, -344.0, PI);
        assert!((p.pos.y - 1.4).abs() < 1e-9, "on the pier: {}", p.pos.y);
        let south = Actions { move_z: -1.0, ..Default::default() };
        for _ in 0..90 {
            step(&mut p, &mut world, south);
        }
        assert_eq!(p.mode, Mode::Swim);
        assert!((p.pos.y - (world.terrain().water - swim().float)).abs() < 0.05);
        // Back to the end of the pier, and jump: up and out of the water.
        let north = Actions { move_z: 1.0, ..Default::default() };
        let mut out = false;
        for i in 0..200 {
            let a = Actions { jump_pressed: i % 10 == 0, jump_held: true, ..north };
            let was = p.mode;
            step(&mut p, &mut world, a);
            if was == Mode::Swim && p.mode != Mode::Swim {
                out = p.mode == Mode::Normal && !p.grounded && p.vel.y > 0.0 && p.jumps_used == 1;
                break;
            }
        }
        assert!(out, "hauled out at the pier, not walked out: {:?} at {:?}", p.mode, p.pos);
    }

    #[test]
    fn a_jump_with_both_spent_opens_the_glider_and_the_ground_folds_it() {
        let mut world = OpenWorld::new(emberholm());
        let mut p = stand(&world, -6.0, -264.0, -PI / 2.0);
        p.glider = "wayfarer".into();
        let west = Actions { move_x: -1.0, ..Default::default() };
        let press = Actions { jump_pressed: true, jump_held: true, ..west };
        let held = Actions { jump_held: true, ..west };
        let mut frames = vec![west; 20];
        frames.push(press);
        frames.extend(vec![held; 20]);
        frames.push(press);
        frames.extend(vec![held; 14]);
        frames.push(press);
        for a in frames {
            step(&mut p, &mut world, a);
        }
        assert_eq!(p.mode, Mode::Glide);
        assert!(glider_blocked(&Sim { player: &mut p, world: &mut world, owner: 0 }) == Some("Busy"));
        assert!(gust(&mut Sim { player: &mut p, world: &mut world, owner: 0 }));
        assert!(!gust(&mut Sim { player: &mut p, world: &mut world, owner: 0 }), "the gust recharges");
        for _ in 0..600 {
            step(&mut p, &mut world, west);
            if p.mode != Mode::Glide {
                break;
            }
        }
        assert_eq!(p.mode, Mode::Normal);
        assert!(p.grounded, "landed");
    }

    #[test]
    fn a_trade_pack_is_too_heavy_to_glide_with() {
        let mut world = OpenWorld::new(emberholm());
        let mut p = stand(&world, 0.0, -264.0, 0.0);
        p.glider = "wayfarer".into();
        p.pack = 1;
        p.grounded = false;
        p.pos.y += 10.0;
        assert_eq!(glider_blocked(&Sim { player: &mut p, world: &mut world, owner: 0 }), Some("Too heavy to glide with a trade pack"));
        p.pack = 0;
        assert_eq!(glider_blocked(&Sim { player: &mut p, world: &mut world, owner: 0 }), None);
        assert!(open_glider(&mut Sim { player: &mut p, world: &mut world, owner: 0 }));
        close_glider(&mut Sim { player: &mut p, world: &mut world, owner: 0 }, "fold");
        assert_eq!((p.mode, p.jumps_used), (Mode::Normal, 1), "folding mid-air leaves a double jump");
    }
}
