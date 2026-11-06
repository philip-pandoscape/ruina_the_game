//! Player movement and combat rules: a port of src/sim/sim.ts in networked mode (no training
//! dummy, no hit pause, no auto-aim). The browser runs the TypeScript version to predict your own
//! moves, so the two must stay identical. tests/conformance/player.test.ts runs both and compares them.
//! Open worlds reuse these pieces from crate::open::step_player (tests/conformance/world.test.ts).

use crate::ai::{Foe, ACT_CAST, ACT_DODGE, ACT_FREE, ACT_GUARD, ACT_RECOVER, ACT_STUNNED, ACT_SWING};
use crate::jsmath::JsMath;
use crate::life::content::carry;
use crate::skills::{base_levels, node_index, resolve_skills, same_levels, set_skill, Levels, ResolvedSkills, SkillSet, EMPTY_SKILLS};
use crate::tuning::{
    ability, ability_cooldown, ability_mp_for, cast_frames_for, combo_for, movement_action, movement_cooldown_for, movement_stamina_for, slide_skill,
    tuning, AttackStep, HOTBAR_SLOTS, MOVEMENT_SLOTS, NO_ABILITY, NO_MOVEMENT,
};
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
    /// Hotbar slot pressed this frame: 0 for none, otherwise 1..=HOTBAR_SLOTS.
    pub ability_slot: u8,
    /// Movement slot pressed this frame: 0 for none, otherwise 1..=MOVEMENT_SLOTS.
    pub movement_slot: u8,
    pub movement_held: u8,
    pub sprint_held: bool,
    pub crouch_held: bool,
    pub aim_x: f64, // optional target offset in metres (0, 0 = straight ahead)
    pub aim_z: f64,
    /// The raw stick (or WASD), before it is turned into a world direction: x is right, y is
    /// forward. Vehicles steer with it (tank controls); everything on foot uses move_x / move_z.
    pub stick_x: f64,
    pub stick_y: f64,
    /// Combat stance: the world direction to keep facing while moving (unit length), so the stick
    /// strafes and backs off instead of turning you. 0, 0 faces the way you move.
    pub face_x: f64,
    pub face_z: f64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Normal = 0,
    Attack = 1,
    Cast = 2,
    /// A data-driven movement skill: a dodge, a guard, or the slide everyone has.
    Action = 3,
    /// Open worlds only (src/sim/player/traverse.ts and src/sim/life/vehicles.ts).
    Swim = 4,
    Glide = 5,
    Ride = 6,
    // Keep MODE_DOWN in protocol.rs one past the last of these.
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
    /// A buffered action press, so a slide asked for a few frames early still happens.
    pub action_buffer: i32,
    pub action_buffer_id: u8,
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
    /// Spent by dodges; refills a moment after it was last spent (tuning().stamina).
    pub stamina: f64,
    /// Frames before stamina starts refilling again, counted down from the last spend.
    pub stamina_delay: i32,
    /// Spent by casting; refills steadily (tuning().mp).
    pub mp: f64,
    pub stun: i32,
    pub down_frame: i32,
    pub team: u8,
    // Build (skills and loadout).
    pub weapon: u8,  // 0 sword, 1 club, 2 staff, 3 bow
    pub skills: SkillSet, // which skills are learned (skills.rs)
    /// The level of each skill in the skill book (skills.rs book()), which adds to what it does.
    /// An open-world player's island keeps the experience behind them and sets these
    /// (crate::life::progress::sync_levels); on the battlefield they stay at 1.
    pub levels: Levels,
    /// Resolved once when the build or a level changes, never in a frame.
    pub resolved: ResolvedSkills,
    pub abilities: [u8; HOTBAR_SLOTS], // one per hotbar slot (NO_ABILITY = empty)
    pub cooldowns: [i32; HOTBAR_SLOTS],  // frames until each slot can be used again
    pub ability_buffer: i32,
    pub ability_buffer_slot: u8, // 1..=HOTBAR_SLOTS, 0 when nothing is buffered
    pub movement: [u8; MOVEMENT_SLOTS],
    /// Per skill rather than per slot, so one moved between Q and E keeps its timer and the
    /// built-in slide has somewhere to live.
    pub movement_cooldowns: Vec<i32>,
    pub action_id: u8, // the movement skill running right now, NO_MOVEMENT when none
    pub action_frame: i32,
    pub action_dir_x: f64,
    pub action_dir_z: f64,
    pub action_slot: u8,
    pub sprinting: bool,
    pub crouching: bool,
    pub crouch_frame: i32,
    pub cast_ability: u8, // the ability being cast, NO_ABILITY when not casting
    pub cast_slot: u8, // which hotbar slot the cast came from, 1..=HOTBAR_SLOTS
    pub cast_frame: i32,
    pub cast_target_x: f64,
    pub cast_target_z: f64,
    pub fired_ability: u8, // the ability whose cast finished this frame, else NO_ABILITY
    /// The movement skill that started this frame (the slide too), else NO_MOVEMENT: the
    /// TypeScript's `action` event, which trains it in an open world.
    pub started_action: u8,
    // ---- Open-world traversal (src/sim/types.ts). Always at rest on the battlefield. ----
    /// The trade pack on your back (an id in the life systems), 0 for none.
    pub pack: i64,
    /// What you are riding (a vehicle id in the life systems), 0 on foot; and which seat.
    pub vehicle: i64,
    pub seat: u8,
    /// Riding along in someone else's vehicle: whose (their character), 0 in your own or on foot.
    /// Their vehicle numbers are their island's, so `vehicle` is one of theirs then.
    pub host: i64,
    /// The glider you have equipped ("" for none), and its airspeed while open.
    pub glider: String,
    pub airspeed: f64,
    /// Lean into a turn, -1..1, for the glider and the body.
    pub bank: f64,
    /// Frames since the current traversal mode began (glider opening, swim strokes).
    pub mode_frame: i32,
    /// Frames until the glider's gust can be used again.
    pub gust_frames: i32,
}

pub(crate) fn len(x: f64, z: f64) -> f64 {
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

pub(crate) fn turn_toward(current: f64, target: f64, max_step: f64) -> f64 {
    let d = angle_diff(current, target);
    let next = current + d.clamp(-max_step, max_step);
    next.js_sin().js_atan2(next.js_cos())
}

/// A character's skills and loadout.
#[derive(Clone, Copy, Debug)]
pub struct Build {
    pub skills: SkillSet,
    pub weapon: u8,
    pub abilities: [u8; HOTBAR_SLOTS],
    pub movement: [u8; MOVEMENT_SLOTS],
}

impl Default for Build {
    fn default() -> Self {
        let mut skills = EMPTY_SKILLS;
        if let Some(i) = node_index("sword") {
            set_skill(&mut skills, i, true);
        }
        Build { skills, weapon: 0, abilities: [NO_ABILITY; HOTBAR_SLOTS], movement: [NO_MOVEMENT; MOVEMENT_SLOTS] }
    }
}

pub(crate) fn step_len() -> f64 {
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
            action_buffer: 0,
            action_buffer_id: NO_MOVEMENT,
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
            stamina: tuning().stamina.max,
            stamina_delay: 0,
            mp: tuning().mp.max,
            stun: 0,
            down_frame: -1,
            team,
            weapon: build.weapon,
            skills: build.skills,
            levels: base_levels(),
            resolved: resolve_skills(&build.skills, &[]),
            abilities: build.abilities,
            cooldowns: [0; HOTBAR_SLOTS],
            movement: build.movement,
            movement_cooldowns: vec![0; tuning().movement_skills.len()],
            action_id: NO_MOVEMENT,
            action_frame: 0,
            action_dir_x: 0.0,
            action_dir_z: 1.0,
            action_slot: 0,
            ability_buffer: 0,
            ability_buffer_slot: 0,
            sprinting: false,
            crouching: false,
            crouch_frame: 0,
            cast_ability: NO_ABILITY,
            cast_slot: 0,
            cast_frame: 0,
            cast_target_x: 0.0,
            cast_target_z: 0.0,
            fired_ability: NO_ABILITY,
            started_action: NO_MOVEMENT,
            pack: 0,
            vehicle: 0,
            seat: 0,
            host: 0,
            glider: String::new(),
            airspeed: 0.0,
            bank: 0.0,
            mode_frame: 0,
            gust_frames: 0,
        }
    }

    /// A movement slot that was pressed and can run now (1..=MOVEMENT_SLOTS), else 0. Unlike an
    /// ability these aren't buffered: a dodge you asked for two frames ago is one you no longer want.
    fn buffer_action(&mut self, id: u8) {
        let Some(def) = movement_action(id) else { return };
        let Some(frames) = def.buffer_frames else { return };
        self.action_buffer = frames;
        self.action_buffer_id = id;
    }

    /// A buffered action that can start right now, else NO_MOVEMENT.
    fn ready_buffered_action(&self) -> u8 {
        let id = self.action_buffer_id;
        if self.action_buffer <= 0 || id == NO_MOVEMENT || !self.grounded {
            return NO_MOVEMENT;
        }
        if self.movement_cooldowns.get(id as usize).copied().unwrap_or(0) > 0 || self.stamina < movement_stamina_for(id, &self.resolved) {
            return NO_MOVEMENT;
        }
        id
    }

    fn ready_movement(&self, a: &Actions) -> u8 {
        let slot = a.movement_slot;
        if slot < 1 || slot as usize > MOVEMENT_SLOTS || !self.grounded {
            return 0;
        }
        let m = self.movement[slot as usize - 1];
        // A dodge costs stamina instead of having a cooldown: without enough, it doesn't start.
        if m == NO_MOVEMENT
            || movement_action(m).is_none()
            || self.movement_cooldowns.get(m as usize).copied().unwrap_or(0) > 0
            || self.stamina < movement_stamina_for(m, &self.resolved)
        {
            return 0;
        }
        slot
    }

    /// Begins a movement skill. The direction is fixed now and not steered afterwards, which is
    /// what makes a dodge a commitment rather than a hover.
    /// `slot` is the Q / E slot it came from, or 0 for a built-in like the slide.
    fn start_action(&mut self, id: u8, slot: u8, a: &Actions) {
        let Some(def) = movement_action(id) else { return };
        self.mode = Mode::Action;
        self.action_id = id;
        self.action_slot = slot;
        self.action_frame = 0;
        self.attack_queued = false;
        self.action_buffer = 0;
        self.action_buffer_id = NO_MOVEMENT;
        self.spend_stamina(movement_stamina_for(id, &self.resolved));
        let (dx, dz, mag) = Self::input(a);
        if def.direction == "input" && mag > 0.05 {
            self.action_dir_x = dx;
            self.action_dir_z = dz;
            // Fighting, you dodge any way you push without turning from the fight.
            if self.stance(a).is_none() {
                self.facing = dx.js_atan2(dz);
            }
        } else if def.direction == "backward" {
            self.action_dir_x = -self.facing.js_sin();
            self.action_dir_z = -self.facing.js_cos();
        } else {
            self.action_dir_x = self.facing.js_sin();
            self.action_dir_z = self.facing.js_cos();
        }
        self.started_action = id;
    }

    pub(crate) fn update_action(&mut self, a: &Actions) {
        let Some(def) = movement_action(self.action_id) else {
            self.end_action();
            return;
        };
        let (startup, active, recovery, speed, hold) = (def.startup, def.active, def.recovery, def.speed, def.hold);
        let (end_speed, steer, jump_carry, ground_only) = (def.end_speed, def.steer, def.jump_carry, def.ground_only);
        self.action_frame += 1;
        let f = self.action_frame;
        let active_end = startup + active;
        // A held action (a guard) drops as soon as you let go, without skipping its recovery.
        let released = hold && a.movement_held != self.action_slot;
        let decel = tuning().movement.ground_decel;

        // Steerable actions turn toward where you're pushing; the rest keep the way they committed.
        if let Some(rate) = steer {
            let (dx, dz, mag) = Self::input(a);
            if mag > 0.0 {
                let heading = turn_toward(self.action_dir_x.js_atan2(self.action_dir_z), dx.js_atan2(dz), rate * step_len());
                self.action_dir_x = heading.js_sin();
                self.action_dir_z = heading.js_cos();
            }
            self.facing = self.action_dir_x.js_atan2(self.action_dir_z);
        }

        if f <= startup {
            self.accelerate_toward(0.0, 0.0, decel);
        } else if f <= active_end && !released {
            if speed > 0.0 {
                // Eases from `speed` to `end_speed` across the active frames, quadratically.
                let t = match end_speed {
                    Some(_) => ((f - startup) as f64 / active.max(1) as f64).min(1.0),
                    None => 0.0,
                };
                let now = speed + (end_speed.unwrap_or(speed) - speed) * t * t;
                self.vel.x = self.action_dir_x * now;
                self.vel.z = self.action_dir_z * now;
            } else {
                self.accelerate_toward(0.0, 0.0, decel);
            }
            // Jumping out of a slide is a long jump that keeps most of its speed.
            if let Some(carry) = jump_carry {
                if self.jump_buffer > 0 {
                    self.end_action();
                    self.vel.x *= carry;
                    self.vel.z *= carry;
                    self.try_jump(a);
                    return;
                }
            }
            if ground_only && !self.grounded {
                self.end_action();
                return;
            }
        } else {
            self.accelerate_toward(0.0, 0.0, decel);
        }
        // Checked after the branch, not inside the tail of it, so an action with no recovery ends
        // on the last of its active frames rather than lingering one frame longer.
        if f >= active_end + recovery || (released && f >= startup + recovery) {
            self.end_action();
        }
    }

    fn end_action(&mut self) {
        // Cooldowns are per skill, so one moved between Q and E keeps its timer.
        if self.action_id != NO_MOVEMENT {
            let frames = movement_cooldown_for(self.action_id, &self.resolved);
            if let Some(c) = self.movement_cooldowns.get_mut(self.action_id as usize) {
                *c = frames;
            }
        }
        self.mode = Mode::Normal;
        self.action_id = NO_MOVEMENT;
        self.action_frame = 0;
        self.action_slot = 0;
    }

    /// How much of an incoming hit lands. 0 is an invulnerable dodge frame, 1 a clean hit.
    fn incoming_scale(&self) -> f64 {
        if self.mode != Mode::Action {
            return 1.0;
        }
        let Some(def) = movement_action(self.action_id) else { return 1.0 };
        let f = self.action_frame;
        if let (Some(from), Some(to)) = (def.invuln_from, def.invuln_to) {
            if f >= from && f <= to {
                return 0.0;
            }
        }
        if let Some(scale) = def.damage_taken {
            if f > def.startup && f <= def.startup + def.active {
                return scale;
            }
        }
        1.0
    }

    /// The combo hit that can land right now, if this player is mid-swing and hasn't hit yet.
    pub fn active_swing(&self) -> Option<AttackStep> {
        if self.mode != Mode::Attack || self.attack_hit || self.down_frame >= 0 {
            return None;
        }
        let s = &combo_for(self.weapon, &self.resolved)[self.attack_index];
        (self.attack_frame > s.startup && self.attack_frame <= s.startup + s.active).then(|| s.clone())
    }

    /// One step of the rules on the flat battlefield (src/sim/sim.ts step() in networked mode).
    /// Open worlds step through crate::open::step_player, which shares every piece of this but the
    /// modes only they have and the ground.
    pub fn step(&mut self, a: &Actions, world: &World) {
        self.begin_step(a);
        if self.down_frame >= 0 {
            if self.update_down() {
                self.respawn(world.team_spawns[self.team as usize & 1]);
            }
        } else if self.stun > 0 {
            self.update_stun();
        } else {
            match self.mode {
                Mode::Action => self.update_action(a),
                Mode::Cast => self.update_cast(a),
                Mode::Attack => self.update_attack(a),
                Mode::Normal => self.update_normal(a),
                // Only open worlds have these, and they step through crate::open::traverse.
                Mode::Swim | Mode::Glide | Mode::Ride => self.update_normal(a),
            }
        }
        self.update_crouch_frame();
        self.integrate(world);
        self.end_step();
    }

    /// The start of every step: remember presses, count down timers, cut a short hop, and drop
    /// sprinting and crouching (only normal control sets them again).
    pub(crate) fn begin_step(&mut self, a: &Actions) {
        let t = tuning();
        self.fired_ability = NO_ABILITY;
        self.started_action = NO_MOVEMENT;
        if a.jump_pressed {
            self.jump_buffer = t.jump.buffer_frames;
        }
        if a.attack_pressed {
            self.attack_buffer = t.attack.buffer_frames;
        }
        if a.slide_pressed {
            self.buffer_action(slide_skill());
        }
        if a.ability_slot >= 1 && a.ability_slot as usize <= HOTBAR_SLOTS {
            self.ability_buffer = t.special.buffer_frames;
            self.ability_buffer_slot = a.ability_slot;
        }

        self.land_frame = (self.land_frame + 1).min(999);
        self.takeoff_frame = (self.takeoff_frame + 1).min(999);
        if self.flip_frame >= 0 {
            self.flip_frame = if self.flip_frame + 1 > t.jump.flip_frames { -1 } else { self.flip_frame + 1 };
        }
        for c in self.cooldowns.iter_mut() {
            if *c > 0 {
                *c -= 1;
            }
        }
        for c in self.movement_cooldowns.iter_mut() {
            if *c > 0 {
                *c -= 1;
            }
        }
        self.regen_vitals();
        self.coyote = if self.grounded { t.jump.coyote_frames } else { (self.coyote - 1).max(0) };

        // Releasing jump early gives a short hop.
        if !a.jump_held && !self.jump_cut_done && self.vel.y > 0.0 && self.jumps_used == 1 {
            self.vel.y *= t.jump.short_hop_cut;
            self.jump_cut_done = true;
        }

        // Sprinting and crouching only happen while you have normal control; every other mode
        // (stunned, sliding, attacking, casting, knocked down) drops them.
        self.sprinting = false;
        self.crouching = false;
    }

    /// Once a step: stamina refills once a moment has passed since it was last spent; MP always
    /// does (src/sim/player/vitals.ts regenVitals).
    fn regen_vitals(&mut self) {
        let t = tuning();
        if self.stamina_delay > 0 {
            self.stamina_delay -= 1;
        } else {
            self.stamina = (self.stamina + t.stamina.regen_per_second * step_len()).min(t.stamina.max);
        }
        self.mp = (self.mp + t.mp.regen_per_second * step_len()).min(t.mp.max);
    }

    /// A dodge starting: pays its stamina, and holds off the refill for a moment. Free moves don't.
    fn spend_stamina(&mut self, cost: f64) {
        if cost <= 0.0 {
            return;
        }
        self.stamina = (self.stamina - cost).max(0.0);
        self.stamina_delay = tuning().stamina.regen_delay_frames;
    }

    /// A cast going off: pays its MP.
    fn spend_mp(&mut self, cost: f64) {
        if cost > 0.0 {
            self.mp = (self.mp - cost).max(0.0);
        }
    }

    /// Full stamina and MP: someone new, or back on their feet.
    pub(crate) fn refill_vitals(&mut self) {
        self.stamina = tuning().stamina.max;
        self.stamina_delay = 0;
        self.mp = tuning().mp.max;
    }

    /// Knocked down: lie still. True on the frame it is time to get back up; where depends on the
    /// world (a team's spawn on the battlefield, the island's own in an open world).
    pub(crate) fn update_down(&mut self) -> bool {
        let t = tuning();
        self.mode = Mode::Normal;
        self.down_frame += 1;
        if self.grounded {
            self.accelerate_toward(0.0, 0.0, t.movement.ground_decel);
        }
        self.down_frame >= t.combat.down_frames
    }

    /// Stunned after a hit: no control until it wears off.
    pub(crate) fn update_stun(&mut self) {
        self.stun -= 1;
        self.mode = Mode::Normal;
        if self.grounded {
            self.accelerate_toward(0.0, 0.0, tuning().movement.ground_decel);
        } else {
            self.air_control(0.0, 0.0, 0.0);
        }
    }

    /// Eases the body down into a crouch and back up.
    pub(crate) fn update_crouch_frame(&mut self) {
        self.crouch_frame = if self.crouching {
            (self.crouch_frame + 1).min(tuning().movement.crouch_enter_frames)
        } else {
            (self.crouch_frame - 1).max(0)
        };
    }

    /// The end of every step: buffered presses that were not used run out.
    pub(crate) fn end_step(&mut self) {
        if self.jump_buffer > 0 {
            self.jump_buffer -= 1;
        }
        if self.attack_buffer > 0 {
            self.attack_buffer -= 1;
        }
        if self.action_buffer > 0 {
            self.action_buffer -= 1;
            if self.action_buffer == 0 {
                self.action_buffer_id = NO_MOVEMENT;
            }
        }
        if self.ability_buffer > 0 {
            self.ability_buffer -= 1;
            if self.ability_buffer == 0 {
                self.ability_buffer_slot = 0;
            }
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

    /// Combat stance: the heading to keep facing while fighting, so the stick strafes, backs off
    /// and dodges in any direction instead of turning you; None to face the way you move.
    /// Sprinting always runs free.
    fn stance(&self, a: &Actions) -> Option<f64> {
        if self.sprinting || len(a.face_x, a.face_z) < 0.5 {
            return None;
        }
        Some(a.face_x.js_atan2(a.face_z))
    }

    /// Share of full speed when moving along (dx, dz) while facing `facing`: all of it straight
    /// ahead, strafe_speed sideways, back_speed backing away, blended in between.
    fn stance_speed(facing: f64, dx: f64, dz: f64) -> f64 {
        let m = &tuning().movement;
        let ahead = dx * facing.js_sin() + dz * facing.js_cos();
        if ahead >= 0.0 {
            m.strafe_speed + (1.0 - m.strafe_speed) * ahead
        } else {
            m.strafe_speed + (m.back_speed - m.strafe_speed) * -ahead
        }
    }

    fn try_jump(&mut self, a: &Actions) -> bool {
        let t = tuning();
        if self.jump_buffer <= 0 {
            return false;
        }
        if self.grounded || self.coyote > 0 {
            // A trade pack on your back (open worlds only) weighs the jump down.
            self.vel.y = if self.pack != 0 { t.jump.velocity * carry().jump_factor } else { t.jump.velocity };
            self.grounded = false;
            self.coyote = 0;
            self.jumps_used = 1;
            self.jump_cut_done = false;
            self.jump_buffer = 0;
            self.takeoff_frame = 0;
            return true;
        }
        // A trade pack on your back is too heavy for the second jump.
        if self.jumps_used < 2 && self.pack == 0 {
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
                // Fighting, you keep facing the fight and flip whichever way you jumped.
                if self.stance(a).is_none() {
                    self.facing = dx.js_atan2(dz);
                }
            }
            return true;
        }
        false
    }

    pub(crate) fn update_normal(&mut self, a: &Actions) {
        let t = tuning();
        let move_slot = self.ready_movement(a);
        if move_slot > 0 {
            self.start_action(self.movement[move_slot as usize - 1], move_slot, a);
            return;
        }
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
        let buffered = self.ready_buffered_action();
        if buffered != NO_MOVEMENT {
            self.start_action(buffered, 0, a);
            return;
        }
        let (dx, dz, mag) = Self::input(a);
        // Crouch wins over sprint if you somehow hold both, and neither applies in the air. Nobody
        // sprints with a trade pack on their back.
        self.crouching = a.crouch_held && self.grounded;
        self.sprinting = !self.crouching && a.sprint_held && self.grounded && mag >= t.movement.run_threshold && self.pack == 0;

        // Fighting, you keep facing the fight and strafe; otherwise you turn the way you go.
        let face = self.stance(a);
        if let Some(f) = face {
            self.facing = turn_toward(self.facing, f, t.movement.turn_speed * step_len());
        } else if mag > 0.0 {
            self.facing = turn_toward(self.facing, dx.js_atan2(dz), t.movement.turn_speed * step_len());
        }

        if self.grounded {
            let m = &t.movement;
            let mut speed = if self.crouching {
                m.crouch_speed * (mag / m.run_threshold).min(1.0)
            } else if mag >= m.run_threshold {
                if self.sprinting { m.sprint_speed } else { m.run_speed }
            } else {
                m.walk_speed * (mag / m.run_threshold)
            };
            if self.pack != 0 {
                speed *= carry().speed_factor;
            }
            if face.is_some() && mag > 0.0 {
                speed *= Self::stance_speed(self.facing, dx, dz);
            }
            let rate = if speed <= 0.01 {
                m.ground_decel
            } else if self.sprinting {
                m.sprint_accel
            } else {
                m.ground_accel
            };
            self.accelerate_toward(dx * speed, dz * speed, rate);
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
            let heading = turn_toward(self.vel.x.js_atan2(self.vel.z), dx.js_atan2(dz), 3.0 * step_len());
            let s = m.run_speed.max(hs - m.air_drag * step_len());
            self.vel.x = heading.js_sin() * s;
            self.vel.z = heading.js_cos() * s;
        } else if mag > 0.0 {
            self.accelerate_toward(dx * m.run_speed * mag, dz * m.run_speed * mag, m.air_accel);
        } else if hs > 0.0 {
            let s = (hs - m.air_drag * step_len()).max(0.0);
            self.vel.x *= s / hs;
            self.vel.z *= s / hs;
        }
    }

    fn start_attack(&mut self, index: usize, a: &Actions) {
        self.mode = Mode::Attack;
        self.attack_index = index;
        self.attack_frame = 0;
        self.attack_queued = false;
        self.attack_hit = false;
        self.attack_buffer = 0;
        // Swing at what you aimed at; else ahead, into the fight if you're facing one, or the way you push.
        let (dx, dz, mag) = Self::input(a);
        if let Some(f) = self.stance(a) {
            self.facing = f;
        } else if mag > 0.0 {
            self.facing = dx.js_atan2(dz);
        }
        if len(a.aim_x, a.aim_z) > 0.01 {
            self.facing = a.aim_x.js_atan2(a.aim_z);
        }
    }

    /// An ability slot that was pressed and can be cast now (1 or 2), else 0.
    fn ready_slot(&self) -> u8 {
        if !self.grounded {
            return 0;
        }
        if self.ability_buffer <= 0 {
            return 0;
        }
        let slot = self.ability_buffer_slot;
        if slot < 1 || slot as usize > HOTBAR_SLOTS {
            return 0;
        }
        let i = slot as usize - 1;
        let ab = self.abilities[i];
        if ab == NO_ABILITY || self.cooldowns[i] > 0 || self.mp < ability_mp_for(ab, &self.resolved) {
            return 0;
        }
        slot
    }

    fn set_cooldown(&mut self, slot: u8, frames: i32) {
        if slot >= 1 && slot as usize <= HOTBAR_SLOTS {
            self.cooldowns[slot as usize - 1] = frames;
        }
    }

    fn slot_ability(&self, slot: u8) -> u8 {
        if slot >= 1 && slot as usize <= HOTBAR_SLOTS { self.abilities[slot as usize - 1] } else { NO_ABILITY }
    }

    // Abilities (Healing Circle, Meteor): stand still and cast. Target = aim offset (capped at
    // max_range) if given, otherwise the ability's range in metres straight ahead.
    fn start_cast(&mut self, slot: u8, a: &Actions) {
        let ab = self.slot_ability(slot);
        let s = ability(ab);
        self.mode = Mode::Cast;
        self.cast_ability = ab;
        self.cast_slot = slot;
        self.cast_frame = 0;
        self.ability_buffer = 0;
        self.ability_buffer_slot = 0;
        let (mut ax, mut az) = (a.aim_x, a.aim_z);
        let aim = len(ax, az);
        if aim > 0.01 {
            self.facing = ax.js_atan2(az);
            let max = s.max_range.unwrap_or(aim);
            if aim > max {
                ax *= max / aim;
                az *= max / aim;
            }
        } else {
            // Unaimed, it goes off ahead: of the fight when you're facing one, else the way you push.
            let (dx, dz, mag) = Self::input(a);
            if let Some(f) = self.stance(a) {
                self.facing = f;
            } else if mag > 0.0 {
                self.facing = dx.js_atan2(dz);
            }
            ax = self.facing.js_sin() * s.range;
            az = self.facing.js_cos() * s.range;
        }
        self.cast_target_x = self.pos.x + ax;
        self.cast_target_z = self.pos.z + az;
    }

    pub(crate) fn update_cast(&mut self, a: &Actions) {
        let t = tuning();
        let ab = self.slot_ability(self.cast_slot);
        self.cast_frame += 1;
        self.accelerate_toward(0.0, 0.0, t.movement.ground_decel); // rooted while casting
        if self.jump_buffer > 0 || self.action_buffer > 0 {
            // Jumping or sliding cancels the cast.
            self.set_cooldown(self.cast_slot, t.special.cancel_cooldown_frames);
            self.mode = Mode::Normal;
            self.cast_ability = NO_ABILITY;
            self.cast_slot = 0;
            self.cast_frame = 0;
            if !self.try_jump(a) {
                let buffered = self.ready_buffered_action();
                if buffered != NO_MOVEMENT {
                    self.start_action(buffered, 0, a);
                }
            }
            return;
        }
        if self.cast_frame >= cast_frames_for(ab, &self.resolved) {
            self.set_cooldown(self.cast_slot, ability_cooldown(ab, &self.resolved));
            // Paid as it goes off, so a cast you cancel or that's interrupted costs nothing.
            self.spend_mp(ability_mp_for(ab, &self.resolved));
            self.mode = Mode::Normal;
            self.fired_ability = ab;
            self.cast_ability = NO_ABILITY;
            self.cast_slot = 0;
            self.cast_frame = 0;
        }
    }

    /// Switches to a new build (already checked by the server). Anything in progress is dropped,
    /// so a combo can't continue with a different weapon.
    pub fn apply_build(&mut self, b: Build) {
        self.weapon = b.weapon;
        self.skills = b.skills;
        self.resolved = resolve_skills(&b.skills, &self.levels);
        self.abilities = b.abilities;
        self.movement = b.movement;
        if self.mode == Mode::Attack || self.mode == Mode::Cast || self.mode == Mode::Action {
            self.mode = Mode::Normal;
        }
        self.action_id = NO_MOVEMENT;
        self.action_frame = 0;
        self.attack_index = 0;
        self.attack_frame = 0;
        self.attack_queued = false;
        self.cast_ability = NO_ABILITY;
        self.cast_slot = 0;
        self.cast_frame = 0;
    }

    /// New skill levels (one per skills::book() entry). What the build does is worked out again
    /// only if one actually changed, as the TypeScript's Sim.stats does. Nothing in progress is
    /// dropped: a level only changes numbers.
    pub fn set_levels(&mut self, levels: &[u32]) {
        if same_levels(&self.levels, levels) {
            return;
        }
        self.levels = levels.to_vec();
        self.resolved = resolve_skills(&self.skills, &self.levels);
    }

    pub(crate) fn update_attack(&mut self, a: &Actions) {
        let t = tuning();
        // Copied out: the rest of this borrows self mutably.
        let combo_len = combo_for(self.weapon, &self.resolved).len();
        let step = combo_for(self.weapon, &self.resolved)[self.attack_index].clone();
        let step = &step;
        self.attack_frame += 1;
        let f = self.attack_frame;
        let active_start = step.startup;
        let active_end = step.startup + step.active;
        let total = active_end + step.recovery;

        if self.attack_buffer > 0 && self.attack_index < combo_len - 1 {
            self.attack_queued = true;
            self.attack_buffer = 0;
        }

        if self.grounded {
            if f <= active_end {
                let push = if f <= active_start { step.lunge * 0.5 } else { step.lunge };
                self.vel.x = self.facing.js_sin() * push;
                self.vel.z = self.facing.js_cos() * push;
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
            let buffered = self.ready_buffered_action();
            if buffered != NO_MOVEMENT {
                self.start_action(buffered, 0, a);
                return;
            }
        }
        if f >= total {
            self.mode = Mode::Normal;
        }
    }

    /// What a creature can tell about this player, as foe `id` (foesOf in src/sim/ai/senses.ts):
    /// where they are and going, how hurt, what their weapon reaches, and what they are doing.
    pub fn foe(&self, id: u32, ground: f64) -> Foe {
        let combo = combo_for(self.weapon, &self.resolved);
        let (mut reach, mut ranged) = (0.0f64, false);
        for s in combo {
            if s.projectile_speed > 0.0 {
                ranged = true;
            } else {
                reach = reach.max(s.reach);
            }
        }
        Foe {
            id,
            x: self.pos.x,
            y: self.pos.y,
            z: self.pos.z,
            vx: self.vel.x,
            vz: self.vel.z,
            facing: self.facing,
            hp: self.hp / tuning().combat.max_hp,
            reach,
            ranged,
            act: self.foe_act(combo),
            invuln: self.incoming_scale() <= 0.0,
            air: self.pos.y - ground,
        }
    }

    /// What this player is doing, as a creature reads it (foeAct in src/sim/ai/senses.ts).
    fn foe_act(&self, combo: &[AttackStep]) -> u8 {
        if self.stun > 0 {
            return ACT_STUNNED;
        }
        match self.mode {
            Mode::Attack => match combo.get(self.attack_index) {
                Some(s) if self.attack_frame <= s.startup + s.active => ACT_SWING,
                _ => ACT_RECOVER,
            },
            Mode::Cast => ACT_CAST,
            Mode::Action => match movement_action(self.action_id) {
                Some(d) if d.hold => ACT_GUARD,
                Some(d) if d.invuln_from.is_some() => ACT_DODGE,
                _ => ACT_FREE,
            },
            _ => ACT_FREE,
        }
    }

    /// Being hit: lose health, get knocked back and briefly stunned (or knocked down at 0 health).
    pub fn take_hit(&mut self, damage: f64, dir_x: f64, dir_z: f64, knock: f64) {
        let c = &tuning().combat;
        if self.down_frame >= 0 {
            return;
        }
        // A dodge's invulnerable frames drop the hit entirely; a guard lets part of it through.
        // Either way the action keeps running: being untouchable is the point of it.
        let scale = self.incoming_scale();
        if scale <= 0.0 {
            return;
        }
        self.hp = (self.hp - damage * scale).max(0.0);
        if self.mode == Mode::Action {
            // Guarding holds its ground rather than being knocked about.
            if self.hp <= 0.0 {
                self.stun = 0;
                self.down_frame = 0;
                self.end_action();
            }
            return;
        }
        if self.mode == Mode::Cast {
            // Interrupted: the spell fizzles and needs a moment before it can be tried again.
            let slot = self.cast_slot;
            let current = if slot >= 1 && slot as usize <= HOTBAR_SLOTS { self.cooldowns[slot as usize - 1] } else { 0 };
            self.set_cooldown(slot, current.max(tuning().special.interrupt_cooldown_frames));
            self.cast_ability = NO_ABILITY;
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

    /// Back on your feet at `s`, with full health, stamina and MP.
    pub(crate) fn respawn(&mut self, s: Spawn) {
        self.pos = V3 { x: s.x, y: 0.0, z: s.z };
        self.vel = V3::default();
        self.facing = s.facing;
        self.grounded = true;
        self.jumps_used = 0;
        self.hp = tuning().combat.max_hp;
        self.refill_vitals();
        self.stun = 0;
        self.down_frame = -1;
        self.mode = Mode::Normal;
        self.cast_ability = NO_ABILITY;
        self.cast_slot = 0;
        self.cast_frame = 0;
        self.cooldowns = [0; HOTBAR_SLOTS];
    }

    fn integrate(&mut self, world: &World) {
        let t = tuning();
        let dt = step_len();
        if !self.grounded {
            let mut g = if self.vel.y > 0.0 { t.jump.gravity_up } else { t.jump.gravity_down };
            if self.mode == Mode::Attack {
                let step = &combo_for(self.weapon, &self.resolved)[self.attack_index];
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::{book_index, skills_from};
    use crate::world::{battlefield, SEED};

    #[test]
    fn a_dodge_costs_stamina_by_its_level_instead_of_cooling_down() {
        let world = battlefield(SEED);
        let build = Build { skills: skills_from(&["sword", "dodgeRoll"]), weapon: 0, abilities: [NO_ABILITY; HOTBAR_SLOTS], movement: [0, NO_MOVEMENT] };
        let (max, cost) = (tuning().stamina.max, tuning().movement_skills[0].stamina_cost);
        let dodge = Actions { movement_slot: 1, move_z: 1.0, ..Default::default() };
        let after_a_dodge = |level: u32| {
            let mut p = Player::new(world.team_spawns[0], 0, build);
            let mut levels = base_levels();
            levels[book_index("dodgeRoll").unwrap()] = level;
            p.set_levels(&levels);
            p.step(&dodge, &world);
            assert_eq!((p.mode, p.started_action), (Mode::Action, 0), "the dodge started, and says so for one frame");
            let left = p.stamina;
            assert_eq!(p.stamina_delay, tuning().stamina.regen_delay_frames, "and nothing refills for a moment");
            let mut frames = 0;
            while p.mode == Mode::Action && frames < 200 {
                p.step(&Actions::default(), &world);
                assert_eq!(p.started_action, NO_MOVEMENT);
                frames += 1;
            }
            assert_eq!(p.movement_cooldowns[0], 0, "no cooldown");
            left
        };
        assert!(cost > 0.0);
        assert_eq!(after_a_dodge(1), max - cost);
        assert_eq!(after_a_dodge(10), max - cost * (1.0 - 0.03 * 9.0), "each level makes it 3% cheaper");
        // Without enough it doesn't start; it refills, and then it does.
        let mut p = Player::new(world.team_spawns[0], 0, build);
        p.stamina = cost - 1.0;
        p.step(&dodge, &world);
        assert_eq!((p.mode, p.stamina), (Mode::Normal, (cost - 1.0 + tuning().stamina.regen_per_second * step_len()).min(max)));
        let mut frames = 0;
        while p.stamina < cost && frames < 600 {
            p.step(&Actions::default(), &world);
            frames += 1;
        }
        p.step(&dodge, &world);
        assert_eq!(p.mode, Mode::Action);
        // Getting back up fills it again.
        p.respawn(world.team_spawns[0]);
        assert_eq!((p.stamina, p.stamina_delay, p.mp), (max, 0, tuning().mp.max));
        // The guard is no dodge: it keeps its short cooldown and costs nothing.
        assert_eq!(tuning().movement_skills[2].stamina_cost, 0.0);
        assert!(tuning().movement_skills[2].cooldown_frames > 0);
    }

    #[test]
    fn a_cast_pays_its_mp_when_it_goes_off_and_waits_for_enough() {
        let world = battlefield(SEED);
        let mut build = Build { skills: skills_from(&["club", "heal"]), weapon: 1, ..Build::default() };
        build.abilities[0] = 0;
        let cost = tuning().abilities[0].mp_cost;
        let max = tuning().mp.max;
        let regen = tuning().mp.regen_per_second * step_len();
        let cast = Actions { ability_slot: 1, ..Default::default() };
        let mut p = Player::new(world.team_spawns[0], 0, build);
        p.step(&cast, &world);
        assert_eq!((p.mode, p.mp), (Mode::Cast, max), "nothing paid as it starts");
        // Interrupted: it fizzles, and costs nothing.
        p.take_hit(1.0, 0.0, 1.0, 0.0);
        assert_eq!(p.mp, max);
        for _ in 0..240 {
            p.step(&Actions::default(), &world);
        }
        p.cooldowns = [0; HOTBAR_SLOTS];
        p.step(&cast, &world);
        let mut frames = 0;
        while p.fired_ability == NO_ABILITY && frames < 200 {
            p.step(&Actions::default(), &world);
            frames += 1;
        }
        assert_eq!(p.mp, max - cost, "paid as it goes off");
        // Without enough it doesn't start, until enough has come back.
        p.cooldowns = [0; HOTBAR_SLOTS];
        p.mp = cost - regen * 3.0;
        p.step(&cast, &world);
        assert_eq!(p.mode, Mode::Normal);
        for _ in 0..4 {
            p.step(&Actions::default(), &world);
        }
        assert_eq!(p.mode, Mode::Cast, "the press waited in its buffer for the MP");
        // A new build keeps the levels it was given.
        let mut p = Player::new(world.team_spawns[0], 0, build);
        let mut levels = base_levels();
        levels[book_index("sword").unwrap()] = 3;
        p.set_levels(&levels);
        p.apply_build(build);
        assert_eq!(p.resolved.combo[0][0].damage, tuning().weapons[0].combo[0].damage * (1.0 + 0.03 * 2.0));
    }
}
