//! Binary message format shared by the server, the load tester and the browser (src/net/netCrowd.ts).
//! Everything is little-endian. Positions are quantised to keep messages small.
//!
//! Server → client
//!   WELCOME  [1][bots u32][tick_hz u8][field f32]
//!   SNAPSHOT [2][tick u32][near_count u16][near entries][mid_count u16][mid entries]
//!            [player_count u8][player entries][has_you u8][you]
//!            [arrow_count u8][arrows][meteor_count u8][meteors][event_count u8][events]
//!            near entry (10 bytes): id u16, x i16 cm, z i16 cm, yaw u8, flags u8, swings u8, hp u8
//!            mid entry (8 bytes):   id u16, x i16 cm, z i16 cm, yaw u8, flags u8
//!            player entry (31 bytes): other real players nearby, with enough detail to animate them:
//!              id u16, x/y/z i16 cm, yaw u8, vx/vz i16 cm/s, mode u8 (0 normal, 1 slide, 2 attack,
//!              3 action, 4 down), flags u8 (team, grounded), attack_index u8, attack_frame u8,
//!              flip_frame i8, hp u8, stun u8, land_frame u8, weapon u8,
//!              combo variants u8 (one bit per unlocked variant: all another client needs of
//!              someone's skill tree to draw them), cast_ability u8 (255 = none), cast_frame u8,
//!              cast target x/z i16 cm
//!            you (195 bytes): your exact state so the browser can correct its prediction:
//!              id u16, last input seq used u32, 14 × f64, (16 + HOTBAR_SLOTS) × i16,
//!              SKILL_WORDS × u32 (the learned set), (14 + HOTBAR_SLOTS) × u8 (see put_you)
//!            arrow (15 bytes): id u16, owner u16 (shooter's player id), x/y/z i16 cm, vx/vz i16 cm/s, team u8
//!            meteor (10 bytes): id u16, x/z i16 cm, ticks until it lands u8, fall ticks u8, team u8,
//!                     radius in tenths of a metre u8
//!            event (8 bytes): kind u8, x/y/z i16 cm, size u8
//!              1 heal, 2 explosion, 3 arrow hit: shown to everyone nearby; size is radius x10.
//!              4 you hit, 5 you were hit, 6 you healed: only ever sent to the one player they
//!              belong to, so the browser can label a number without the server naming who did it.
//!              For these, size is the amount of damage or healing and the position is the victim,
//!              and the top 4 bits of kind say what caused it (see CAUSE_*) so the browser can put
//!              the right icon beside the number. Everything else leaves those bits zero.
//!   FAR      [3][tick u32][count u16] then 4 bytes per fighter in id order:
//!            x 12 bits + z 12 bits (7.8 cm steps over ±160 m), then team bit, down bit, yaw 6 bits
//!   STATS    [4][tick u32][bots u32][alive u32][real_clients u32][virtual_clients u32]
//!            [tick_ms f32][sim_ms f32][snap_ms f32][bytes_per_player_per_s f32][dropped u32]
//!            [pvp_hits u32][bot_hits_on_players u32][rewind_ms f32][saved_by_rewind u32][hits_on_bots u32]
//!
//! Client → server
//!   VIEW     [1][x f32][z f32]   where the player is, so the server knows what's "near"
//!   ATTACH   [2][bot u32]        follow one of the bots instead (used by the load tester)
//!   INPUT    [3][count u8] then per input (15 bytes): seq u32, view u32, move_x i8, move_z i8,
//!            buttons u8, aim_x i8, aim_z i8, slot u8, movement held u8
//!            slot = 1..=HOTBAR_SLOTS for the hotbar, then HOTBAR_SLOTS+1.. for a movement slot
//!            view = the server tick × 16 that the player was looking at, for rewinding hits
//!            buttons: 1 jump pressed, 2 jump held, 4 attack pressed, 8 slide pressed,
//!                     16 sprint held, 32 crouch held
//!            hotbar = the slot used this frame, 1..=HOTBAR_SLOTS, or 0 for none
//!            aim = target offset from the player in quarter metres (0, 0 = straight ahead)
//!   JOIN     [4][team u8]        play as a fighter (team 0 or 1, 255 = either)
//!   LAG      [5][ms u16]         testing: delay this connection's traffic each way by ms
//!   BUILD    [6][weapon u8][SKILL_WORDS × u32 learned set][HOTBAR_SLOTS × ability u8]
//!            [MOVEMENT_SLOTS × movement skill u8]
//!            skills: one bit per learned skill; the server checks the build before using it
//!            one ability per hotbar slot, in slot order, 255 for an empty slot

use crate::player::Player;
use crate::sim::{Battle, MAX_HP};
use crate::skills::SKILL_WORDS;
use crate::tuning::{HOTBAR_SLOTS, MOVEMENT_SKILL_CAP, MOVEMENT_SLOTS};

pub const MSG_WELCOME: u8 = 1;
pub const MSG_SNAPSHOT: u8 = 2;
pub const MSG_FAR: u8 = 3;
pub const MSG_STATS: u8 = 4;

pub const MSG_VIEW: u8 = 1;
pub const MSG_ATTACH: u8 = 2;
pub const MSG_INPUT: u8 = 3;
pub const MSG_JOIN: u8 = 4;
pub const MSG_LAG: u8 = 5;
pub const MSG_BUILD: u8 = 6;

/// Sent in the mode byte instead of a mode when someone is knocked down. One past the last
/// Mode, so adding a mode without moving this would make the two indistinguishable.
pub const MODE_DOWN: u8 = 7;
pub const PLAYER_ENTRY: usize = 31;
// id + ack + 14 f64 + (16 fixed + one cooldown per slot) i16 + perks + (16 fixed + one ability
// per slot) u8. Kept as arithmetic so changing HOTBAR_SLOTS can't silently desync the wire format.
// 15 fixed i16s plus one cooldown per hotbar slot and one per possible movement skill; 17 fixed
// u8s plus the hotbar and the movement slots. Arithmetic so the two sides can't drift.
pub const YOU_ENTRY: usize = 2
    + 4
    + 14 * 8
    + (15 + HOTBAR_SLOTS + MOVEMENT_SKILL_CAP) * 2
    + SKILL_WORDS * 4
    + (17 + HOTBAR_SLOTS + MOVEMENT_SLOTS);
pub const ARROW_ENTRY: usize = 15;
pub const METEOR_ENTRY: usize = 10;
pub const EVENT_ENTRY: usize = 8;
// id u16, kind u8, x/z f32, y u8, facing u8, behaviour state u8, progress u8, hp u8, down u8,
// and where a slam it is winding up will land, as i8 offsets in tenths of a metre. Enough for the
// browser to place one, pick which clip it is playing and warn you; everything else about a
// monster it already knows from shared/actors.json.
pub const ACTOR_ENTRY: usize = 19;

pub const EVENT_HEAL: u8 = 1;
pub const EVENT_EXPLOSION: u8 = 2;
pub const EVENT_ARROW_HIT: u8 = 3;
// Attributed events. The snapshot already goes out per player, so "who did this" needs no extra
// bytes on the wire: these only go to the player they are about.
pub const EVENT_YOU_HIT: u8 = 4;
pub const EVENT_YOU_HURT: u8 = 5;
pub const EVENT_YOU_HEAL: u8 = 6;

// What caused an attributed event, packed into the top 4 bits of its kind.
pub const CAUSE_WEAPON: u8 = 1; // plus the weapon index: 1 sword, 2 club, 3 staff, 4 bow
pub const CAUSE_METEOR: u8 = 5;
pub const CAUSE_HEAL: u8 = 6;
pub const CAUSE_BOT: u8 = 7;
pub const CAUSE_MONSTER: u8 = 8;

// Inputs travel as small integers; the browser applies the same rounding to its own prediction.
pub fn input_axis(v: i8) -> f64 {
    v as f64 / 127.0
}

pub fn aim_axis(v: i8) -> f64 {
    v as f64 * 0.25
}

fn clamp_i16(v: f64) -> [u8; 2] {
    (v.round().clamp(-32768.0, 32767.0) as i16).to_le_bytes()
}

fn small(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}

pub fn put_player(out: &mut Vec<u8>, id: u16, p: &Player) {
    out.extend_from_slice(&id.to_le_bytes());
    out.extend_from_slice(&clamp_i16(p.pos.x * 100.0));
    out.extend_from_slice(&clamp_i16(p.pos.y * 100.0));
    out.extend_from_slice(&clamp_i16(p.pos.z * 100.0));
    out.push(yaw_u8(p.facing as f32));
    out.extend_from_slice(&clamp_i16(p.vel.x * 100.0));
    out.extend_from_slice(&clamp_i16(p.vel.z * 100.0));
    out.push(if p.down_frame >= 0 { MODE_DOWN } else { p.mode as u8 });
    out.push((p.team & 1) | if p.grounded { 2 } else { 0 });
    out.push(p.attack_index as u8);
    out.push(small(p.attack_frame));
    out.push(p.flip_frame.clamp(-1, 127) as i8 as u8);
    out.push(p.hp.round().clamp(0.0, 255.0) as u8);
    out.push(small(p.stun));
    out.push(small(p.land_frame));
    out.push(p.weapon);
    out.push(p.resolved.combo_variant_bits);
    out.push(p.cast_ability);
    out.push(small(p.cast_frame));
    out.extend_from_slice(&clamp_i16(p.cast_target_x * 100.0));
    out.extend_from_slice(&clamp_i16(p.cast_target_z * 100.0));
    out.push(p.action_id);
    out.push(small(p.action_frame));
}

pub fn put_you(out: &mut Vec<u8>, id: u16, ack: u32, p: &Player) {
    out.extend_from_slice(&id.to_le_bytes());
    out.extend_from_slice(&ack.to_le_bytes());
    for v in [
        p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, p.facing, p.action_dir_x, p.action_dir_z, p.land_impact, p.run_phase, p.hp,
        p.cast_target_x, p.cast_target_z,
    ] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for v in [
        p.jumps_used, p.coyote, p.jump_buffer, p.attack_buffer, p.action_buffer, p.attack_frame,
        p.flip_frame, p.land_frame, p.takeoff_frame, p.stun, p.down_frame, p.ability_buffer, p.cast_frame, p.crouch_frame,
        p.action_frame,
    ] {
        out.extend_from_slice(&(v.clamp(-32768, 32767) as i16).to_le_bytes());
    }
    for &c in p.cooldowns.iter() {
        out.extend_from_slice(&(c.clamp(-32768, 32767) as i16).to_le_bytes());
    }
    for i in 0..MOVEMENT_SKILL_CAP {
        let c = p.movement_cooldowns.get(i).copied().unwrap_or(0);
        out.extend_from_slice(&(c.clamp(-32768, 32767) as i16).to_le_bytes());
    }
    for w in p.skills {
        out.extend_from_slice(&w.to_le_bytes());
    }
    for v in [
        p.mode as u8,
        p.grounded as u8,
        p.jump_cut_done as u8,
        p.attack_index as u8,
        p.attack_queued as u8,
        p.attack_hit as u8,
        p.team,
        p.weapon,
        p.cast_ability,
        p.cast_slot,
        p.fired_ability,
        p.ability_buffer_slot,
        p.sprinting as u8,
        p.crouching as u8,
        p.action_id,
        p.action_slot,
        p.action_buffer_id,
    ] {
        out.push(v);
    }
    out.extend_from_slice(&p.abilities);
    out.extend_from_slice(&p.movement);
}

pub fn cm16(v: f64) -> [u8; 2] {
    clamp_i16(v * 100.0)
}

pub const FLAG_TEAM: u8 = 1;
pub const FLAG_DOWN: u8 = 2;
pub const FLAG_SWINGING: u8 = 4;

pub const NEAR_ENTRY: usize = 10;
pub const MID_ENTRY: usize = 8;
pub const FAR_ENTRY: usize = 4;

const TAU: f32 = std::f32::consts::TAU;

pub fn cm(v: f32) -> [u8; 2] {
    ((v * 100.0).round().clamp(-32768.0, 32767.0) as i16).to_le_bytes()
}

pub fn yaw_u8(yaw: f32) -> u8 {
    ((yaw.rem_euclid(TAU) / TAU * 256.0) as u32 & 255) as u8
}

pub fn flags(b: &Battle, i: usize) -> u8 {
    let mut f = 0;
    if b.team[i] == 1 {
        f |= FLAG_TEAM;
    }
    if b.hp[i] <= 0.0 {
        f |= FLAG_DOWN;
    }
    if b.attack_t[i] >= 0.0 {
        f |= FLAG_SWINGING;
    }
    f
}

pub fn put_near(out: &mut Vec<u8>, b: &Battle, i: usize) {
    out.extend_from_slice(&(i as u16).to_le_bytes());
    out.extend_from_slice(&cm(b.x[i]));
    out.extend_from_slice(&cm(b.z[i]));
    out.push(yaw_u8(b.yaw[i]));
    out.push(flags(b, i));
    out.push(b.swings[i]);
    out.push((b.hp[i].max(0.0) / MAX_HP * 255.0) as u8);
}

pub fn put_mid(out: &mut Vec<u8>, b: &Battle, i: usize) {
    out.extend_from_slice(&(i as u16).to_le_bytes());
    out.extend_from_slice(&cm(b.x[i]));
    out.extend_from_slice(&cm(b.z[i]));
    out.push(yaw_u8(b.yaw[i]));
    out.push(flags(b, i));
}

pub fn welcome(bots: usize, tick_hz: u32, field: f32) -> Vec<u8> {
    let mut out = vec![MSG_WELCOME];
    out.extend_from_slice(&(bots as u32).to_le_bytes());
    out.push(tick_hz as u8);
    out.extend_from_slice(&field.to_le_bytes());
    out
}

// Every fighter, coarsely, once a second. Built once and sent to everyone.
pub fn far(b: &Battle) -> Vec<u8> {
    let mut out = Vec::with_capacity(7 + b.n * FAR_ENTRY);
    out.push(MSG_FAR);
    out.extend_from_slice(&(b.tick as u32).to_le_bytes());
    out.extend_from_slice(&(b.n as u16).to_le_bytes());
    let q = |v: f32| (((v + 160.0) / 320.0 * 4095.0).round().clamp(0.0, 4095.0)) as u32;
    for i in 0..b.n {
        let packed = q(b.x[i]) | (q(b.z[i]) << 12);
        out.extend_from_slice(&packed.to_le_bytes()[..3]);
        let f = flags(b, i) & (FLAG_TEAM | FLAG_DOWN);
        out.push(f | ((yaw_u8(b.yaw[i]) >> 2) << 2));
    }
    out
}

pub struct StatsMsg {
    pub tick: u64,
    pub bots: usize,
    pub alive: usize,
    pub real_clients: usize,
    pub virtual_clients: usize,
    pub tick_ms: f32,
    pub sim_ms: f32,
    pub snap_ms: f32,
    pub bytes_per_player_per_s: f32,
    pub dropped: u32,
    pub pvp_hits: u32,
    pub bot_hits_on_players: u32,
    pub rewind_ms: f32,
    pub saved_by_rewind: u32,
    pub hits_on_bots: u32,
}

pub fn stats(s: &StatsMsg) -> Vec<u8> {
    let mut out = vec![MSG_STATS];
    out.extend_from_slice(&(s.tick as u32).to_le_bytes());
    for v in [s.bots, s.alive, s.real_clients, s.virtual_clients] {
        out.extend_from_slice(&(v as u32).to_le_bytes());
    }
    for v in [s.tick_ms, s.sim_ms, s.snap_ms, s.bytes_per_player_per_s] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&s.dropped.to_le_bytes());
    out.extend_from_slice(&s.pvp_hits.to_le_bytes());
    out.extend_from_slice(&s.bot_hits_on_players.to_le_bytes());
    out.extend_from_slice(&s.rewind_ms.to_le_bytes());
    out.extend_from_slice(&s.saved_by_rewind.to_le_bytes());
    out.extend_from_slice(&s.hits_on_bots.to_le_bytes());
    out
}

/// Packs one actor for the wire. `progress` is how far through its current behaviour state it
/// is, which is what the browser turns back into an animation time.
#[allow(clippy::too_many_arguments)]
pub fn put_actor(
    out: &mut [u8; ACTOR_ENTRY],
    id: u32,
    kind: u8,
    x: f64,
    z: f64,
    y: f64,
    facing: f64,
    state: u8,
    progress: f64,
    hp_fraction: f64,
    dead_frame: i32,
    target_dx: f64,
    target_dz: f64,
) {
    let tau = std::f64::consts::PI * 2.0;
    out[0..2].copy_from_slice(&(id as u16).to_le_bytes());
    out[2] = kind;
    out[3..7].copy_from_slice(&(x as f32).to_le_bytes());
    out[7..11].copy_from_slice(&(z as f32).to_le_bytes());
    out[11] = (y * 50.0).clamp(0.0, 255.0) as u8;
    out[12] = (facing.rem_euclid(tau) / tau * 255.0).round().clamp(0.0, 255.0) as u8;
    out[13] = state;
    out[14] = (progress * 255.0).clamp(0.0, 255.0) as u8;
    out[15] = (hp_fraction * 255.0).clamp(0.0, 255.0) as u8;
    out[16] = if dead_frame < 0 { 0 } else { (dead_frame + 1).min(255) as u8 };
    out[17] = (target_dx * 10.0).round().clamp(-127.0, 127.0) as i8 as u8;
    out[18] = (target_dz * 10.0).round().clamp(-127.0, 127.0) as i8 as u8;
}
