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
//!              3 cast, 4 down), flags u8 (team, grounded), attack_index u8, attack_frame u8,
//!              slide_frame u8, flip_frame i8, hp u8, stun u8, land_frame u8, weapon u8, perks u16,
//!              cast_kind u8, cast_frame u8, cast target x/z i16 cm
//!            you (171 bytes): your exact state so the browser can correct its prediction:
//!              id u16, last input seq used u32, 14 × f64, 18 × i16, perks u32, 13 × u8 (see put_you)
//!            arrow (15 bytes): id u16, owner u16 (shooter's player id), x/y/z i16 cm, vx/vz i16 cm/s, team u8
//!            meteor (9 bytes): id u16, x/z i16 cm, ticks until it lands u8, fall ticks u8, team u8
//!            event (8 bytes): kind u8 (1 heal, 2 explosion, 3 arrow hit), x/y/z i16 cm, size u8
//!   FAR      [3][tick u32][count u16] then 4 bytes per fighter in id order:
//!            x 12 bits + z 12 bits (7.8 cm steps over ±160 m), then team bit, down bit, yaw 6 bits
//!   STATS    [4][tick u32][bots u32][alive u32][real_clients u32][virtual_clients u32]
//!            [tick_ms f32][sim_ms f32][snap_ms f32][bytes_per_player_per_s f32][dropped u32]
//!            [pvp_hits u32][bot_hits_on_players u32][rewind_ms f32][saved_by_rewind u32][hits_on_bots u32]
//!
//! Client → server
//!   VIEW     [1][x f32][z f32]   where the player is, so the server knows what's "near"
//!   ATTACH   [2][bot u32]        follow one of the bots instead (used by the load tester)
//!   INPUT    [3][count u8] then per input (13 bytes): seq u32, view u32, move_x i8, move_z i8,
//!            buttons u8, aim_x i8, aim_z i8
//!            view = the server tick × 16 that the player was looking at, for rewinding hits
//!            buttons: 1 jump pressed, 2 jump held, 4 attack pressed, 8 slide pressed,
//!                     16 ability slot 1, 32 ability slot 2
//!            aim = target offset from the player in quarter metres (0, 0 = straight ahead)
//!   JOIN     [4][team u8]        play as a fighter (team 0 or 1, 255 = either)
//!   LAG      [5][ms u16]         testing: delay this connection's traffic each way by ms
//!   BUILD    [6][skills u16][weapon u8][ability1 u8][ability2 u8]
//!            skills: one bit per learned skill; the server checks the build before using it

use crate::player::Player;
use crate::sim::{Battle, MAX_HP};

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

pub const PLAYER_ENTRY: usize = 31;
pub const YOU_ENTRY: usize = 171;
pub const ARROW_ENTRY: usize = 15;
pub const METEOR_ENTRY: usize = 9;
pub const EVENT_ENTRY: usize = 8;

pub const EVENT_HEAL: u8 = 1;
pub const EVENT_EXPLOSION: u8 = 2;
pub const EVENT_ARROW_HIT: u8 = 3;

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
    out.push(if p.down_frame >= 0 { 4 } else { p.mode as u8 });
    out.push((p.team & 1) | if p.grounded { 2 } else { 0 });
    out.push(p.attack_index as u8);
    out.push(small(p.attack_frame));
    out.push(small(p.slide_frame));
    out.push(p.flip_frame.clamp(-1, 127) as i8 as u8);
    out.push(p.hp.round().clamp(0.0, 255.0) as u8);
    out.push(small(p.stun));
    out.push(small(p.land_frame));
    out.push(p.weapon);
    out.extend_from_slice(&(p.perks as u16).to_le_bytes());
    out.push(p.cast_kind);
    out.push(small(p.cast_frame));
    out.extend_from_slice(&clamp_i16(p.cast_target_x * 100.0));
    out.extend_from_slice(&clamp_i16(p.cast_target_z * 100.0));
}

pub fn put_you(out: &mut Vec<u8>, id: u16, ack: u32, p: &Player) {
    out.extend_from_slice(&id.to_le_bytes());
    out.extend_from_slice(&ack.to_le_bytes());
    for v in [
        p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, p.facing, p.slide_dir_x, p.slide_dir_z, p.land_impact, p.run_phase, p.hp,
        p.cast_target_x, p.cast_target_z,
    ] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for v in [
        p.jumps_used, p.coyote, p.jump_buffer, p.attack_buffer, p.slide_buffer, p.slide_frame, p.slide_cooldown, p.attack_frame,
        p.flip_frame, p.land_frame, p.takeoff_frame, p.stun, p.down_frame, p.ability_buffer1, p.ability_buffer2, p.cooldown1,
        p.cooldown2, p.cast_frame,
    ] {
        out.extend_from_slice(&(v.clamp(-32768, 32767) as i16).to_le_bytes());
    }
    out.extend_from_slice(&p.perks.to_le_bytes());
    for v in [
        p.mode as u8,
        p.grounded as u8,
        p.jump_cut_done as u8,
        p.attack_index as u8,
        p.attack_queued as u8,
        p.attack_hit as u8,
        p.team,
        p.weapon,
        p.ability1,
        p.ability2,
        p.cast_kind,
        p.cast_slot,
        p.fired_cast,
    ] {
        out.push(v);
    }
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
