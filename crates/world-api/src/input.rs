//! What a browser's input bytes mean: one frame of what a player pressed, as the gate reads it off
//! the wire (src/net/netPlayer.ts quantize, src/net/worldLink.ts sendInput) and the simulation
//! turns it into the rules' `Actions`. The browser applies the same rounding to its own prediction.

use serde::{Deserialize, Serialize};

use ruina_engine::jsmath::JsMath;
use ruina_engine::player::Actions;
use ruina_engine::tuning::HOTBAR_SLOTS;

/// Bytes per input in an open world: 8 for the player, then the raw stick (vehicles steer with it).
pub const OPEN_INPUT: usize = 10;

/// One frame of what a player pressed: its sequence number, the tick (in sixteenths, the low 32
/// bits) at which the browser drew everyone else (lag compensation), and its bytes.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Input {
    pub seq: u32,
    pub view: u32,
    pub raw: [u8; OPEN_INPUT],
}

// Inputs travel as small integers.
fn input_axis(v: i8) -> f64 {
    v as f64 / 127.0
}

fn aim_axis(v: i8) -> f64 {
    v as f64 * 0.25
}

/// The combat-stance heading byte as a direction: 0 is none, 1..=255 a heading in 255 steps.
fn face_axis(v: u8) -> (f64, f64) {
    if v == 0 {
        return (0.0, 0.0);
    }
    let yaw = (v - 1) as f64 * std::f64::consts::TAU / 255.0;
    (yaw.js_sin(), yaw.js_cos())
}

/// One input as a browser packs it, 8 bytes: move x and z (i8, ±127 for full), the buttons (1 jump
/// pressed, 2 jump held, 4 attack pressed, 8 slide pressed, 16 sprint held, 32 crouch held), aim x
/// and z (i8: the target's offset from the player in quarter metres, 0, 0 straight ahead), the slot
/// used this frame (1..=HOTBAR_SLOTS the hotbar, past that a movement slot, 0 none), the movement
/// skill held, and the combat stance's heading (0 to face the way you move, else 1..=255 a heading
/// to keep facing).
pub fn actions_from(raw: [u8; 8]) -> Actions {
    let b = raw[2];
    let (face_x, face_z) = face_axis(raw[7]);
    Actions {
        move_x: input_axis(raw[0] as i8),
        move_z: input_axis(raw[1] as i8),
        jump_pressed: b & 1 != 0,
        jump_held: b & 2 != 0,
        attack_pressed: b & 4 != 0,
        slide_pressed: b & 8 != 0,
        sprint_held: b & 16 != 0,
        crouch_held: b & 32 != 0,
        ability_slot: if raw[5] <= HOTBAR_SLOTS as u8 { raw[5] } else { 0 },
        // Values past the hotbar are the movement slots, so one byte covers both.
        movement_slot: raw[5].saturating_sub(HOTBAR_SLOTS as u8),
        movement_held: raw[6],
        aim_x: aim_axis(raw[3] as i8),
        aim_z: aim_axis(raw[4] as i8),
        stick_x: 0.0,
        stick_y: 0.0,
        face_x,
        face_z,
    }
}

/// Open worlds: the 10 bytes a browser packs per input: actions_from's 8, plus the raw stick.
pub fn open_actions_from(raw: [u8; OPEN_INPUT]) -> Actions {
    let mut a = actions_from([raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7]]);
    a.stick_x = input_axis(raw[8] as i8);
    a.stick_y = input_axis(raw[9] as i8);
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_input_reads_as_the_browser_packed_it() {
        // Full right, half back, attack and sprint, aim two metres ahead, the second hotbar slot,
        // and a stance heading a quarter of the way round.
        let a = actions_from([127, (-64i8) as u8, 4 | 16, 0, 8, 2, 0, 65]);
        assert_eq!((a.move_x, a.move_z), (1.0, -64.0 / 127.0));
        assert!(a.attack_pressed && a.sprint_held && !a.jump_pressed);
        assert_eq!((a.aim_x, a.aim_z, a.ability_slot, a.movement_slot), (0.0, 2.0, 2, 0));
        assert!((a.face_x - 1.0).abs() < 0.03 && a.face_z.abs() < 0.03, "{} {}", a.face_x, a.face_z);
        // Past the hotbar, the slot byte is a movement slot.
        let b = actions_from([0, 0, 0, 0, 0, HOTBAR_SLOTS as u8 + 1, 1, 0]);
        assert_eq!((b.ability_slot, b.movement_slot, b.movement_held), (0, 1, 1));
        let c = open_actions_from([0, 0, 0, 0, 0, 0, 0, 0, (-127i8) as u8, 127]);
        assert_eq!((c.stick_x, c.stick_y), (-1.0, 1.0));
    }
}
