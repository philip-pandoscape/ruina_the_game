//! The engine's things packed into records: what a sim calls once per entity per tick. Each field is
//! rounded here, once, to what the wire carries (crate::schema says the units); the browser turns them
//! back (src/net/wire/feed.ts).

use std::f64::consts::TAU;
use std::sync::Arc;

use ruina_engine::actor::Actor;
use ruina_engine::combat::{Arrow, Effect, Meteor};
use ruina_engine::life::content::{glider_index, packs, rideable_index};
use ruina_engine::life::state::{Pack, Vehicle};
use ruina_engine::player::{Mode, Player};

use crate::record::{Event, Intro, Record};
use crate::schema::{CARGO_SLOTS, Fields, Kind, MAX_FIELDS};

/// A stand-in for the world's 64-bit entity ids (crates/world-api's EntityId, coming with the
/// server's tiers): the kind in the top byte, the id below it. Vehicles and packs, which their owner's
/// life numbers, mix the owner in.
pub fn key(kind: Kind, id: i64) -> u64 {
    (u64::from(kind as u8) << 56) | (id as u64 & ((1 << 56) - 1))
}

/// The same for something its owner's life numbers (a vehicle, a pack).
pub fn owned_key(kind: Kind, owner: i64, id: i64) -> u64 {
    // FNV-1a over the two ids: different owners' vehicle 1 are different things.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in owner.to_le_bytes().into_iter().chain(id.to_le_bytes()) {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    (u64::from(kind as u8) << 56) | (h & ((1 << 56) - 1))
}

/// Metres to centimetres.
pub fn cm(v: f64) -> i32 {
    round(v * 100.0)
}

/// Hundredths.
pub fn centi(v: f64) -> i32 {
    round(v * 100.0)
}

/// Thousandths.
pub fn milli(v: f64) -> i32 {
    round(v * 1000.0)
}

/// A heading as 65536ths of a turn, 0..65535.
pub fn turn(a: f64) -> i32 {
    if !a.is_finite() {
        return 0;
    }
    (round(a.rem_euclid(TAU) / TAU * 65536.0)) & 0xffff
}

/// A small signed angle (a pitch, a roll) as 65536ths of a turn.
pub fn tilt(a: f64) -> i32 {
    round(a / TAU * 65536.0)
}

fn round(v: f64) -> i32 {
    if v.is_finite() { v.round().clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32 } else { 0 }
}

/// Small whole numbers (frames, places in lists) as they are.
fn int(v: impl TryInto<i32>) -> i32 {
    v.try_into().unwrap_or(i32::MAX)
}

/// A place in a list as the wire counts it: one more than its index, 0 for none.
fn place(index: Option<usize>) -> i32 {
    index.map_or(0, |i| int(i + 1))
}

/// The place of a pack (by its content id) in the packs' list, plus one.
pub fn pack_place(def: &str) -> i32 {
    place(packs().iter().position(|p| p.id == def))
}

fn fields(values: &[i32]) -> Fields {
    let mut f = [0; MAX_FIELDS];
    f[..values.len()].copy_from_slice(values);
    f
}

/// A player as everyone else sees them. `carried`: the content id of the pack on their back, if
/// they have one; `host`: the key of whoever's vehicle they ride along in (0: none, or their own).
pub fn player(key: u64, id: i64, name: Arc<str>, bot: bool, p: &Player, carried: Option<&str>, host: u64) -> Record {
    let frames_in = |mode: Mode, frame: i32| if p.mode == mode { frame } else { -1 };
    let flags = i32::from(p.grounded) | i32::from(p.sprinting) << 1 | i32::from(p.crouching) << 2;
    let values = [
        cm(p.pos.x),
        cm(p.pos.z),
        cm(p.pos.y),
        turn(p.facing),
        // Metres run, wrapping: the browser reads only how far it moved since the last.
        (p.run_phase * 100.0).round() as i64 as i32,
        cm(p.vel.x),
        cm(p.vel.z),
        cm(p.vel.y),
        p.mode as i32,
        flags,
        int(p.attack_index),
        frames_in(Mode::Attack, p.attack_frame),
        i32::from(p.cast_ability),
        frames_in(Mode::Cast, p.cast_frame),
        i32::from(p.action_id),
        frames_in(Mode::Action, p.action_frame),
        p.flip_frame,
        p.land_frame,
        centi(p.land_impact),
        p.takeoff_frame,
        p.stun,
        p.down_frame,
        centi(p.hp),
        i32::from(p.team),
        i32::from(p.weapon),
        i32::from(p.resolved.combo_variant_bits),
        milli(p.bank),
        p.crouch_frame,
        cm(p.airspeed),
        if p.glider.is_empty() { 0 } else { place(glider_index(&p.glider)) },
        carried.map_or(0, pack_place),
        p.vehicle as i32,
        i32::from(p.seat),
        0,
    ];
    Record { key, owner: key, intro: Intro::Player { id, name, bot }, fields: fields(&values), refers: host }
}

/// A creature, unless it has been taken out of the world for now (absorbed, merged).
pub fn creature(key: u64, a: &Actor) -> Option<Record> {
    if a.gone {
        return None;
    }
    let hp = if a.max_hp > 0.0 { round(a.hp / a.max_hp * 10_000.0) } else { 0 };
    let values = [
        cm(a.x),
        cm(a.z),
        cm(a.y),
        turn(a.facing),
        int(a.state),
        a.state_frame,
        a.wait,
        hp,
        a.dead_frame,
        cm(a.target_x),
        cm(a.target_z),
        i32::from(a.kind_index),
    ];
    Some(Record { key, owner: 0, intro: Intro::Creature { id: i64::from(a.id) }, fields: fields(&values), refers: 0 })
}

/// A vehicle someone has out, `owner` its owner's character and `owner_key` their key; `packs` their
/// life's packs, for what's in its cargo.
pub fn vehicle(key: u64, owner_key: u64, owner: i64, v: &Vehicle, packs: &[Pack]) -> Record {
    let flags = i32::from(v.grounded) | i32::from(v.swimming) << 1;
    let mut values =
        vec![cm(v.x), cm(v.z), cm(v.y), turn(v.heading), tilt(v.pitch), tilt(v.roll), cm(v.speed), milli(v.steer), milli(v.throttle), milli(v.sail), flags];
    for slot in 0..CARGO_SLOTS {
        let id = v.cargo.get(slot).copied().unwrap_or(0);
        let def = (id != 0).then(|| packs.iter().find(|p| p.id == id)).flatten();
        values.push(def.map_or(0, |p| pack_place(&p.def)));
    }
    let def = rideable_index(&v.def).map_or(u32::MAX, |i| u32::try_from(i).unwrap_or(u32::MAX));
    Record { key, owner: owner_key, intro: Intro::Vehicle { owner, id: v.id, def }, fields: fields(&values), refers: 0 }
}

/// A pack lying on the ground.
pub fn item(key: u64, owner_key: u64, owner: i64, p: &Pack) -> Record {
    let def = packs().iter().position(|d| d.id == p.def).map_or(u32::MAX, |i| u32::try_from(i).unwrap_or(u32::MAX));
    let values = [cm(p.x), cm(p.z), cm(p.y), turn(p.rot)];
    Record { key, owner: owner_key, intro: Intro::Item { owner, id: p.id, def }, fields: fields(&values), refers: 0 }
}

/// An arrow in flight, `owner` the key of whoever loosed it.
pub fn arrow(key: u64, a: &Arrow, owner: u64) -> Record {
    let values = [cm(a.x), cm(a.z), cm(a.y), cm(a.dx * a.speed), cm(a.dz * a.speed), i32::from(a.team), 0];
    Record { key, owner, intro: Intro::Arrow { id: i64::from(a.id) }, fields: fields(&values), refers: owner }
}

pub fn meteor(key: u64, m: &Meteor) -> Record {
    let values = [cm(m.x), cm(m.z), int(m.ticks_left), int(m.fall_ticks), i32::from(m.team), cm(m.radius)];
    Record { key, owner: 0, intro: Intro::Meteor { id: i64::from(m.id) }, fields: fields(&values), refers: 0 }
}

/// An effect, for everyone near it or (told) for the one player it's about.
pub fn effect(e: &Effect) -> Event {
    Event::new(cm(e.x), cm(e.y), cm(e.z), i32::from(e.kind), i32::from(e.size))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ruina_engine::player::Build;
    use ruina_engine::world::Spawn;

    #[test]
    fn a_player_packs_in_the_schema_s_units() {
        let mut p = Player::new(Spawn { x: 12.345, z: -3.0, facing: std::f64::consts::FRAC_PI_2 }, 1, Build::default());
        p.pos.y = 4.5;
        p.hp = 87.5;
        p.mode = Mode::Normal;
        p.attack_frame = 9;
        p.glider = "swiftwing".into();
        let r = player(key(Kind::Player, 7), 7, "Ada".into(), false, &p, Some("ciderCask"), 0);
        let f = |name: &str| r.fields[crate::schema::PLAYER.iter().position(|x| x.name == name).unwrap()];
        assert_eq!((f("x"), f("z"), f("y")), (1235, -300, 450));
        assert_eq!(f("facing"), 16384, "a quarter turn");
        assert_eq!(f("hp"), 8750);
        assert_eq!(f("team"), 1);
        assert_eq!(f("attackFrame"), -1, "a swing's frame only while swinging");
        assert_eq!(f("glider"), 2, "swiftwing is the second glider");
        assert_eq!(f("pack"), pack_place("ciderCask"));
        assert!(f("pack") > 0);
        assert_eq!(r.kind(), Kind::Player);
    }

    #[test]
    fn turns_wrap_and_tilts_keep_their_sign() {
        assert_eq!(turn(0.0), 0);
        assert_eq!(turn(-std::f64::consts::FRAC_PI_2), 49152);
        assert_eq!(turn(TAU), 0);
        assert_eq!(turn(f64::NAN), 0);
        assert_eq!(tilt(-0.1), -1043);
        assert_eq!(cm(f64::INFINITY), 0);
        assert_eq!(cm(1e12), i32::MAX);
        assert_ne!(owned_key(Kind::Vehicle, 7, 1), owned_key(Kind::Vehicle, 8, 1));
        assert_ne!(key(Kind::Player, 7), key(Kind::Creature, 7));
    }
}
