//! Player movement and combat rules: a port of src/sim/sim.ts in networked mode (no training
//! dummy, no hit pause, no auto-aim). The browser runs the TypeScript version to predict your own
//! moves, so the two must stay identical. tests/conformance.spec.ts runs both and compares them.

use crate::tuning::{ability, cast_frames_for, cast_kind_of, combo_for, skill_bit, tuning, AttackStep, NO_ABILITY};
use crate::world::{Spawn, World};

const PI: f64 = std::f64::consts::PI;
const TAU: f64 = std::f64::consts::TAU;

#[derive(Clone, Copy, Default, Debug)]
pub struct Actions {
    pub move_x: f64,
    pub move_z: f64,
    pub jump_pressed: bool,
    pub jump_held: bool,
    pub attack_pressed: bool,
    pub slide_pressed: bool,
    pub ability1_pressed: bool, // ability slot 1 (Y / E)
    pub ability2_pressed: bool, // ability slot 2 (RB / Q)
    pub aim_x: f64, // optional target offset in metres (0, 0 = straight ahead)
    pub aim_z: f64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Normal = 0,
    Slide = 1,
    Attack = 2,
    Cast = 3,
}

#[derive(Clone, Copy, Default, Debug)]
pub struct V3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Debug)]
pub struct Player {
    pub pos: V3,
    pub vel: V3,
    pub facing: f64,
    pub mode: Mode,
    pub grounded: bool,
    pub jumps_used: i32,
    pub jump_cut_done: bool,
    pub coyote: i32,
    pub jump_buffer: i32,
    pub attack_buffer: i32,
    pub slide_buffer: i32,
    pub slide_frame: i32,
    pub slide_dir_x: f64,
    pub slide_dir_z: f64,
    pub slide_cooldown: i32,
    pub attack_index: usize,
    pub attack_frame: i32,
    pub attack_queued: bool,
    pub attack_hit: bool,
    pub flip_frame: i32,
    pub land_frame: i32,
    pub land_impact: f64,
    pub takeoff_frame: i32,
    pub run_phase: f64,
    pub hp: f64,
    pub stun: i32,
    pub down_frame: i32,
    pub team: u8,
    // Build (skills and loadout).
    pub weapon: u8,  // 0 sword, 1 club, 2 staff, 3 bow
    pub perks: u32,  // one bit per learned skill (skill_bit in tuning.rs)
    pub ability1: u8, // ability in each slot (NO_ABILITY = empty)
    pub ability2: u8,
    pub ability_buffer1: i32,
    pub ability_buffer2: i32,
    pub cooldown1: i32, // frames until each slot can be used again
    pub cooldown2: i32,
    pub cast_kind: u8,
    pub cast_slot: u8, // which slot the cast came from (1 or 2)
    pub cast_frame: i32,
    pub cast_target_x: f64,
    pub cast_target_z: f64,
    pub fired_cast: u8, // the cast that finished this frame, else 0
}

fn len(x: f64, z: f64) -> f64 {
    (x * x + z * z).sqrt()
}

pub fn angle_diff(a: f64, b: f64) -> f64 {
    let mut d = (b - a) % TAU;
    if d > PI {
        d -= TAU;
    }
    if d < -PI {
        d += TAU;
    }
    d
}

fn turn_toward(current: f64, target: f64, max_step: f64) -> f64 {
    let d = angle_diff(current, target);
    let next = current + d.clamp(-max_step, max_step);
    next.sin().atan2(next.cos())
}

/// A character's skills and loadout. perks has one bit per learned skill.
#[derive(Clone, Copy, Debug)]
pub struct Build {
    pub perks: u32,
    pub weapon: u8,
    pub ability1: u8,
    pub ability2: u8,
}

impl Default for Build {
    fn default() -> Self {
        Build { perks: 1 << skill_bit("sword"), weapon: 0, ability1: NO_ABILITY, ability2: NO_ABILITY }
    }
}

fn step_len() -> f64 {
    1.0 / tuning().sim_hz
}

impl Player {
    pub fn new(spawn: Spawn, team: u8, build: Build) -> Self {
        Player {
            pos: V3 { x: spawn.x, y: 0.0, z: spawn.z },
            vel: V3::default(),
            facing: spawn.facing,
            mode: Mode::Normal,
            grounded: true,
            jumps_used: 0,
            jump_cut_done: true,
            coyote: 0,
            jump_buffer: 0,
            attack_buffer: 0,
            slide_buffer: 0,
            slide_frame: 0,
            slide_dir_x: 0.0,
            slide_dir_z: 1.0,
            slide_cooldown: 0,
            attack_index: 0,
            attack_frame: 0,
            attack_queued: false,
            attack_hit: false,
            flip_frame: -1,
            land_frame: 999,
            land_impact: 0.0,
            takeoff_frame: 999,
            run_phase: 0.0,
            hp: tuning().combat.max_hp,
            stun: 0,
            down_frame: -1,
            team,
            weapon: build.weapon,
            perks: build.perks,
            ability1: build.ability1,
            ability2: build.ability2,
            ability_buffer1: 0,
            ability_buffer2: 0,
            cooldown1: 0,
            cooldown2: 0,
            cast_kind: 0,
            cast_slot: 0,
            cast_frame: 0,
            cast_target_x: 0.0,
            cast_target_z: 0.0,
            fired_cast: 0,
        }
    }

    /// The combo hit that can land right now, if this player is mid-swing and hasn't hit yet.
    pub fn active_swing(&self) -> Option<&'static AttackStep> {
        if self.mode != Mode::Attack || self.attack_hit || self.down_frame >= 0 {
            return None;
        }
        let s = &combo_for(self.weapon, self.perks)[self.attack_index];
        (self.attack_frame > s.startup && self.attack_frame <= s.startup + s.active).then_some(s)
    }

    pub fn step(&mut self, a: &Actions, world: &World) {
        let t = tuning();
        self.fired_cast = 0;
        if a.jump_pressed {
            self.jump_buffer = t.jump.buffer_frames;
        }
        if a.attack_pressed {
            self.attack_buffer = t.attack.buffer_frames;
        }
        if a.slide_pressed {
            self.slide_buffer = t.slide.buffer_frames;
        }
        if a.ability1_pressed {
            self.ability_buffer1 = t.special.buffer_frames;
        }
        if a.ability2_pressed {
            self.ability_buffer2 = t.special.buffer_frames;
        }

        self.land_frame = (self.land_frame + 1).min(999);
        self.takeoff_frame = (self.takeoff_frame + 1).min(999);
        if self.flip_frame >= 0 {
            self.flip_frame = if self.flip_frame + 1 > t.jump.flip_frames { -1 } else { self.flip_frame + 1 };
        }
        if self.slide_cooldown > 0 {
            self.slide_cooldown -= 1;
        }
        if self.cooldown1 > 0 {
            self.cooldown1 -= 1;
        }
        if self.cooldown2 > 0 {
            self.cooldown2 -= 1;
        }
        self.coyote = if self.grounded { t.jump.coyote_frames } else { (self.coyote - 1).max(0) };

        // Releasing jump early gives a short hop.
        if !a.jump_held && !self.jump_cut_done && self.vel.y > 0.0 && self.jumps_used == 1 {
            self.vel.y *= t.jump.short_hop_cut;
            self.jump_cut_done = true;
        }

        if self.down_frame >= 0 {
            self.mode = Mode::Normal;
            self.down_frame += 1;
            if self.grounded {
                self.accelerate_toward(0.0, 0.0, t.movement.ground_decel);
            }
            if self.down_frame >= t.combat.down_frames {
                self.respawn(world);
            }
        } else if self.stun > 0 {
            self.stun -= 1;
            self.mode = Mode::Normal;
            if self.grounded {
                self.accelerate_toward(0.0, 0.0, t.movement.ground_decel);
            } else {
                self.air_control(0.0, 0.0, 0.0);
            }
        } else {
            match self.mode {
                Mode::Cast => self.update_cast(a),
                Mode::Attack => self.update_attack(a),
                Mode::Slide => self.update_slide(a),
                Mode::Normal => self.update_normal(a),
            }
        }

        self.integrate(world);

        if self.jump_buffer > 0 {
            self.jump_buffer -= 1;
        }
        if self.attack_buffer > 0 {
            self.attack_buffer -= 1;
        }
        if self.slide_buffer > 0 {
            self.slide_buffer -= 1;
        }
        if self.ability_buffer1 > 0 {
            self.ability_buffer1 -= 1;
        }
        if self.ability_buffer2 > 0 {
            self.ability_buffer2 -= 1;
        }
    }

    fn input(a: &Actions) -> (f64, f64, f64) {
        let mag = len(a.move_x, a.move_z).min(1.0);
        if mag < 0.05 {
            return (0.0, 0.0, 0.0);
        }
        let l = len(a.move_x, a.move_z);
        (a.move_x / l, a.move_z / l, mag)
    }

    fn try_jump(&mut self, a: &Actions) -> bool {
        let t = tuning();
        if self.jump_buffer <= 0 {
            return false;
        }
        if self.grounded || self.coyote > 0 {
            self.vel.y = t.jump.velocity;
            self.grounded = false;
            self.coyote = 0;
            self.jumps_used = 1;
            self.jump_cut_done = false;
            self.jump_buffer = 0;
            self.takeoff_frame = 0;
            return true;
        }
        if self.jumps_used < 2 {
            self.vel.y = t.jump.double_jump_velocity;
            self.jumps_used = 2;
            self.jump_cut_done = true;
            self.jump_buffer = 0;
            self.flip_frame = 0;
            let (dx, dz, mag) = Self::input(a);
            if mag > 0.0 {
                let s = t.jump.double_jump_steer * t.movement.run_speed * mag;
                self.vel.x = dx * s;
                self.vel.z = dz * s;
                self.facing = dx.atan2(dz);
            }
            return true;
        }
        false
    }

    fn update_normal(&mut self, a: &Actions) {
        let t = tuning();
        self.try_jump(a);
        if self.attack_buffer > 0 {
            self.start_attack(0, a);
            return;
        }
        let slot = self.ready_slot();
        if slot > 0 {
            self.start_cast(slot, a);
            return;
        }
        if self.slide_buffer > 0 && self.grounded && self.slide_cooldown <= 0 {
            self.start_slide(a);
            return;
        }
        let (dx, dz, mag) = Self::input(a);
        if mag > 0.0 {
            self.facing = turn_toward(self.facing, dx.atan2(dz), t.movement.turn_speed * step_len());
        }
        if self.grounded {
            let m = &t.movement;
            let speed = if mag >= m.run_threshold { m.run_speed } else { m.walk_speed * (mag / m.run_threshold) };
            self.accelerate_toward(dx * speed, dz * speed, if speed > 0.01 { m.ground_accel } else { m.ground_decel });
        } else {
            self.air_control(dx, dz, mag);
        }
    }

    fn accelerate_toward(&mut self, tx: f64, tz: f64, rate: f64) {
        let (ex, ez) = (tx - self.vel.x, tz - self.vel.z);
        let err = len(ex, ez);
        let max_delta = rate * step_len();
        if err <= max_delta {
            self.vel.x = tx;
            self.vel.z = tz;
        } else {
            self.vel.x += ex / err * max_delta;
            self.vel.z += ez / err * max_delta;
        }
    }

    fn air_control(&mut self, dx: f64, dz: f64, mag: f64) {
        let m = &tuning().movement;
        let hs = len(self.vel.x, self.vel.z);
        if mag > 0.0 && hs > m.run_speed + 0.01 {
            let heading = turn_toward(self.vel.x.atan2(self.vel.z), dx.atan2(dz), 3.0 * step_len());
            let s = m.run_speed.max(hs - m.air_drag * step_len());
            self.vel.x = heading.sin() * s;
            self.vel.z = heading.cos() * s;
        } else if mag > 0.0 {
            self.accelerate_toward(dx * m.run_speed * mag, dz * m.run_speed * mag, m.air_accel);
        } else if hs > 0.0 {
            let s = (hs - m.air_drag * step_len()).max(0.0);
            self.vel.x *= s / hs;
            self.vel.z *= s / hs;
        }
    }

    fn start_slide(&mut self, a: &Actions) {
        self.mode = Mode::Slide;
        self.slide_frame = 0;
        self.slide_buffer = 0;
        let (dx, dz, mag) = Self::input(a);
        if mag > 0.0 {
            self.facing = dx.atan2(dz);
        }
        self.slide_dir_x = self.facing.sin();
        self.slide_dir_z = self.facing.cos();
    }

    fn update_slide(&mut self, a: &Actions) {
        let s = &tuning().slide;
        self.slide_frame += 1;
        let (dx, dz, mag) = Self::input(a);
        if mag > 0.0 {
            let heading = turn_toward(self.slide_dir_x.atan2(self.slide_dir_z), dx.atan2(dz), s.steer * step_len());
            self.slide_dir_x = heading.sin();
            self.slide_dir_z = heading.cos();
        }
        self.facing = self.slide_dir_x.atan2(self.slide_dir_z);
        let t = (self.slide_frame as f64 / s.frames as f64).min(1.0);
        let speed = s.speed + (s.end_speed - s.speed) * t * t;
        self.vel.x = self.slide_dir_x * speed;
        self.vel.z = self.slide_dir_z * speed;

        if self.jump_buffer > 0 {
            self.mode = Mode::Normal;
            self.slide_cooldown = s.cooldown_frames;
            self.vel.x *= s.jump_carry;
            self.vel.z *= s.jump_carry;
            self.try_jump(a);
            return;
        }
        if self.slide_frame >= s.frames || !self.grounded {
            self.mode = Mode::Normal;
            self.slide_cooldown = s.cooldown_frames;
        }
    }

    fn start_attack(&mut self, index: usize, a: &Actions) {
        self.mode = Mode::Attack;
        self.attack_index = index;
        self.attack_frame = 0;
        self.attack_queued = false;
        self.attack_hit = false;
        self.attack_buffer = 0;
        let (dx, dz, mag) = Self::input(a);
        if mag > 0.0 {
            self.facing = dx.atan2(dz);
        }
        if len(a.aim_x, a.aim_z) > 0.01 {
            self.facing = a.aim_x.atan2(a.aim_z);
        }
    }

    /// An ability slot that was pressed and can be cast now (1 or 2), else 0.
    fn ready_slot(&self) -> u8 {
        if !self.grounded {
            return 0;
        }
        if self.ability_buffer1 > 0 && self.ability1 != NO_ABILITY && self.cooldown1 <= 0 {
            return 1;
        }
        if self.ability_buffer2 > 0 && self.ability2 != NO_ABILITY && self.cooldown2 <= 0 {
            return 2;
        }
        0
    }

    fn set_cooldown(&mut self, slot: u8, frames: i32) {
        match slot {
            1 => self.cooldown1 = frames,
            2 => self.cooldown2 = frames,
            _ => {}
        }
    }

    fn slot_ability(&self, slot: u8) -> u8 {
        if slot == 1 { self.ability1 } else { self.ability2 }
    }

    // Abilities (Healing Circle, Meteor): stand still and cast. Target = aim offset (capped at
    // max_range) if given, otherwise the ability's range in metres straight ahead.
    fn start_cast(&mut self, slot: u8, a: &Actions) {
        let ab = self.slot_ability(slot);
        let s = ability(ab);
        self.mode = Mode::Cast;
        self.cast_kind = cast_kind_of(ab);
        self.cast_slot = slot;
        self.cast_frame = 0;
        if slot == 1 {
            self.ability_buffer1 = 0;
        } else {
            self.ability_buffer2 = 0;
        }
        let (mut ax, mut az) = (a.aim_x, a.aim_z);
        let aim = len(ax, az);
        if aim > 0.01 {
            self.facing = ax.atan2(az);
            let max = s.max_range.unwrap_or(aim);
            if aim > max {
                ax *= max / aim;
                az *= max / aim;
            }
        } else {
            let (dx, dz, mag) = Self::input(a);
            if mag > 0.0 {
                self.facing = dx.atan2(dz);
            }
            ax = self.facing.sin() * s.range;
            az = self.facing.cos() * s.range;
        }
        self.cast_target_x = self.pos.x + ax;
        self.cast_target_z = self.pos.z + az;
    }

    fn update_cast(&mut self, a: &Actions) {
        let t = tuning();
        let ab = self.slot_ability(self.cast_slot);
        self.cast_frame += 1;
        self.accelerate_toward(0.0, 0.0, t.movement.ground_decel); // rooted while casting
        if self.jump_buffer > 0 || self.slide_buffer > 0 {
            // Jumping or sliding cancels the cast.
            self.set_cooldown(self.cast_slot, t.special.cancel_cooldown_frames);
            self.mode = Mode::Normal;
            self.cast_kind = 0;
            self.cast_slot = 0;
            self.cast_frame = 0;
            if !self.try_jump(a) && self.slide_buffer > 0 && self.grounded && self.slide_cooldown <= 0 {
                self.start_slide(a);
            }
            return;
        }
        if self.cast_frame >= cast_frames_for(ab, self.perks) {
            self.set_cooldown(self.cast_slot, ability(ab).cooldown_frames);
            self.mode = Mode::Normal;
            self.fired_cast = self.cast_kind;
            self.cast_kind = 0;
            self.cast_slot = 0;
            self.cast_frame = 0;
        }
    }

    /// Switches to a new build (already checked by the server). Anything in progress is dropped,
    /// so a combo can't continue with a different weapon.
    pub fn apply_build(&mut self, b: Build) {
        self.weapon = b.weapon;
        self.perks = b.perks;
        self.ability1 = b.ability1;
        self.ability2 = b.ability2;
        if self.mode == Mode::Attack || self.mode == Mode::Cast {
            self.mode = Mode::Normal;
        }
        self.attack_index = 0;
        self.attack_frame = 0;
        self.attack_queued = false;
        self.cast_kind = 0;
        self.cast_slot = 0;
        self.cast_frame = 0;
    }

    fn update_attack(&mut self, a: &Actions) {
        let t = tuning();
        let combo = combo_for(self.weapon, self.perks);
        let step = &combo[self.attack_index];
        self.attack_frame += 1;
        let f = self.attack_frame;
        let active_start = step.startup;
        let active_end = step.startup + step.active;
        let total = active_end + step.recovery;

        if self.attack_buffer > 0 && self.attack_index < combo.len() - 1 {
            self.attack_queued = true;
            self.attack_buffer = 0;
        }

        if self.grounded {
            if f <= active_end {
                let push = if f <= active_start { step.lunge * 0.5 } else { step.lunge };
                self.vel.x = self.facing.sin() * push;
                self.vel.z = self.facing.cos() * push;
            } else {
                self.accelerate_toward(0.0, 0.0, t.movement.ground_decel);
            }
        } else {
            self.air_control(0.0, 0.0, 0.0);
        }

        if self.attack_queued && f >= active_end + 2 {
            self.start_attack(self.attack_index + 1, a);
            return;
        }
        if f > active_end + step.cancel_after {
            if self.jump_buffer > 0 && (self.grounded || self.jumps_used < 2) {
                self.mode = Mode::Normal;
                self.try_jump(a);
                return;
            }
            if self.slide_buffer > 0 && self.grounded && self.slide_cooldown <= 0 {
                self.start_slide(a);
                return;
            }
        }
        if f >= total {
            self.mode = Mode::Normal;
        }
    }

    /// Being hit: lose health, get knocked back and briefly stunned (or knocked down at 0 health).
    pub fn take_hit(&mut self, damage: f64, dir_x: f64, dir_z: f64, knock: f64) {
        let c = &tuning().combat;
        if self.down_frame >= 0 {
            return;
        }
        self.hp = (self.hp - damage).max(0.0);
        if self.mode == Mode::Cast {
            // Interrupted: the spell fizzles and needs a moment before it can be tried again.
            let slot = self.cast_slot;
            let current = if slot == 1 { self.cooldown1 } else { self.cooldown2 };
            self.set_cooldown(slot, current.max(tuning().special.interrupt_cooldown_frames));
            self.cast_kind = 0;
            self.cast_slot = 0;
            self.cast_frame = 0;
        }
        self.vel.x = dir_x * knock;
        self.vel.z = dir_z * knock;
        self.vel.y = c.knock_up;
        self.grounded = false;
        self.jumps_used = 1;
        self.jump_cut_done = true;
        self.mode = Mode::Normal;
        self.flip_frame = -1;
        self.stun = c.stun_frames;
        if self.hp <= 0.0 {
            self.stun = 0;
            self.down_frame = 0;
        }
    }

    fn respawn(&mut self, world: &World) {
        let s = world.team_spawns[self.team as usize & 1];
        self.pos = V3 { x: s.x, y: 0.0, z: s.z };
        self.vel = V3::default();
        self.facing = s.facing;
        self.grounded = true;
        self.jumps_used = 0;
        self.hp = tuning().combat.max_hp;
        self.stun = 0;
        self.down_frame = -1;
        self.mode = Mode::Normal;
        self.cast_kind = 0;
        self.cast_slot = 0;
        self.cast_frame = 0;
        self.cooldown1 = 0;
        self.cooldown2 = 0;
    }

    fn integrate(&mut self, world: &World) {
        let t = tuning();
        let dt = step_len();
        if !self.grounded {
            let mut g = if self.vel.y > 0.0 { t.jump.gravity_up } else { t.jump.gravity_down };
            if self.mode == Mode::Attack {
                let step = &combo_for(self.weapon, self.perks)[self.attack_index];
                if self.attack_frame <= step.startup + step.active {
                    g *= t.attack.air_gravity_scale;
                }
            }
            self.vel.y = (self.vel.y - g * dt).max(-t.jump.max_fall);
        }

        self.pos.x += self.vel.x * dt;
        self.pos.y += self.vel.y * dt;
        self.pos.z += self.vel.z * dt;

        self.collide(world);

        if self.pos.y <= 0.0 {
            if !self.grounded && self.vel.y <= 0.0 {
                self.grounded = true;
                self.jumps_used = 0;
                self.flip_frame = -1;
                self.land_frame = 0;
                self.land_impact = (-self.vel.y / 20.0).min(1.0);
            }
            self.pos.y = 0.0;
            self.vel.y = 0.0;
        }

        if self.grounded && self.mode == Mode::Normal {
            self.run_phase += len(self.vel.x, self.vel.z) * dt;
        }
    }

    fn collide(&mut self, world: &World) {
        let pr = tuning().movement.player_radius;
        for o in &world.obstacles {
            let (dx, dz) = (self.pos.x - o.x, self.pos.z - o.z);
            let min = o.r + pr;
            let d2 = dx * dx + dz * dz;
            if d2 >= min * min {
                continue;
            }
            let root = d2.sqrt();
            let d = if root == 0.0 { 0.0001 } else { root };
            let (nx, nz) = (dx / d, dz / d);
            self.pos.x = o.x + nx * min;
            self.pos.z = o.z + nz * min;
            let vn = self.vel.x * nx + self.vel.z * nz;
            if vn < 0.0 {
                self.vel.x -= vn * nx;
                self.vel.z -= vn * nz;
            }
        }
        let r = len(self.pos.x, self.pos.z);
        if r > world.radius {
            self.pos.x *= world.radius / r;
            self.pos.z *= world.radius / r;
        }
    }
}
