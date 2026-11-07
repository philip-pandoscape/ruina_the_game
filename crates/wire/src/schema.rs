//! What each kind of record holds: its fields in wire order, which tier still refreshes each one, and
//! how a field runs on by itself between two updates (a frame counter), so a value that ran on as
//! expected costs nothing. The browser's copy is src/net/wire/schema.ts; the golden fixtures hold
//! the two to the same lists (tests/golden.rs writes the schema beside them).
//!
//! Every field is an i32. Positions are centimetres, turns are 65536ths of a full turn, speeds are
//! centimetres a second, and a place in one of the content's lists is its index (plus one where 0
//! means none). The fields that change most often come first, so the mask of what changed is a byte
//! or two.

use serde::{Deserialize, Serialize};

/// The most fields any kind may have (a player has 34): a mask of what changed fits in 40 bits, which
/// the browser reads as an ordinary number.
pub const MAX_FIELDS: usize = 40;

/// One record's values.
pub type Fields = [i32; MAX_FIELDS];

/// What a record is of. Its number is its byte on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[repr(u8)]
pub enum Kind {
    /// Someone playing, or a bot: what everyone else needs to draw them.
    Player = 1,
    /// A monster, a townsperson, a training dummy.
    Creature = 2,
    /// A cart, a boat or a mount someone has out.
    Vehicle = 3,
    /// A trade pack lying on the ground.
    Item = 4,
    Arrow = 5,
    Meteor = 6,
}

impl Kind {
    pub const ALL: [Kind; 6] = [Kind::Player, Kind::Creature, Kind::Vehicle, Kind::Item, Kind::Arrow, Kind::Meteor];

    pub fn from_byte(b: u8) -> Option<Kind> {
        Kind::ALL.into_iter().find(|k| *k as u8 == b)
    }

    pub fn fields(self) -> &'static [Field] {
        match self {
            Kind::Player => PLAYER,
            Kind::Creature => CREATURE,
            Kind::Vehicle => VEHICLE,
            Kind::Item => ITEM,
            Kind::Arrow => ARROW,
            Kind::Meteor => METEOR,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Kind::Player => "player",
            Kind::Creature => "creature",
            Kind::Vehicle => "vehicle",
            Kind::Item => "item",
            Kind::Arrow => "arrow",
            Kind::Meteor => "meteor",
        }
    }
}

/// How often something is refreshed, by how far it is from whoever is looking (interest.rs). Its
/// number is its two bits on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[repr(u8)]
pub enum Tier {
    /// Close by: every field, every tick.
    Near = 0,
    /// Further: what a crowd body is drawn from, every fourth tick.
    Mid = 1,
    /// Far: where it is and little else, about once a second.
    Far = 2,
}

impl Tier {
    pub fn from_bits(b: u8) -> Option<Tier> {
        match b {
            0 => Some(Tier::Near),
            1 => Some(Tier::Mid),
            2 => Some(Tier::Far),
            _ => None,
        }
    }

    /// Whether an update sent at this tier refreshes a field that's refreshed out to `field`.
    pub fn refreshes(self, field: Tier) -> bool {
        field >= self
    }
}

/// How a field runs on between updates when nothing else happens to it. The guess is made from the
/// value the update is measured against and the ticks since, the same way on both sides.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Run {
    /// Stays as it was.
    Still,
    /// Counts up `per` a tick while it isn't negative (-1: not going), to `cap` at most.
    Up { per: i32, cap: i32 },
    /// Counts down `per` a tick while it's above 0, to 0.
    Down { per: i32 },
}

impl Run {
    /// The value `base` runs on to after `ticks`.
    pub fn guess(self, base: i32, ticks: u32) -> i32 {
        match self {
            Run::Still => base,
            Run::Up { per, cap } => {
                if base < 0 {
                    base
                } else {
                    let up = i64::from(base) + i64::from(per) * i64::from(ticks);
                    up.min(i64::from(cap)) as i32
                }
            }
            Run::Down { per } => {
                if base <= 0 {
                    base
                } else {
                    (i64::from(base) - i64::from(per) * i64::from(ticks)).max(0) as i32
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Field {
    pub name: &'static str,
    /// The furthest tier still refreshing it: Far fields go at every tier, Near ones only close by.
    pub tier: Tier,
    pub run: Run,
}

const fn f(name: &'static str, tier: Tier, run: Run) -> Field {
    Field { name, tier, run }
}

/// Rules frames in a server tick: a frame counter runs on three a tick.
pub const FRAMES_PER_TICK: i32 = 3;
const STILL: Run = Run::Still;
/// A frame counter: -1 while what it counts isn't going.
const FRAMES: Run = Run::Up { per: FRAMES_PER_TICK, cap: i32::MAX };
/// A frame counter that stops at 999 (frames since landing, since taking off).
const SINCE: Run = Run::Up { per: FRAMES_PER_TICK, cap: 999 };
const NEAR: Tier = Tier::Near;
const MID: Tier = Tier::Mid;
const FAR: Tier = Tier::Far;

/// A player as everyone else draws them (crates/server's presence, src/net/worldPeers.ts SHOWN).
/// Frame counters for a swing, a cast and a movement skill are -1 outside their mode.
pub const PLAYER: &[Field] = &[
    f("x", FAR, STILL),
    f("z", FAR, STILL),
    f("y", FAR, STILL),
    f("facing", FAR, STILL),
    // Metres run (centimetres, wrapping): the stride clock, read only by how much it moved.
    f("run", NEAR, STILL),
    f("vx", MID, STILL),
    f("vz", MID, STILL),
    f("vy", MID, STILL),
    f("mode", MID, STILL),
    // 1 grounded, 2 sprinting, 4 crouching.
    f("flags", MID, STILL),
    f("attackIndex", MID, STILL),
    f("attackFrame", MID, FRAMES),
    f("castAbility", MID, STILL),
    f("castFrame", MID, FRAMES),
    f("actionId", NEAR, STILL),
    f("actionFrame", NEAR, FRAMES),
    f("flipFrame", NEAR, FRAMES),
    f("landFrame", NEAR, SINCE),
    // Hundredths.
    f("landImpact", NEAR, STILL),
    f("takeoffFrame", NEAR, SINCE),
    f("stun", NEAR, Run::Down { per: FRAMES_PER_TICK }),
    f("downFrame", FAR, FRAMES),
    // Hundredths of a hit point.
    f("hp", FAR, STILL),
    f("team", FAR, STILL),
    f("weapon", MID, STILL),
    f("comboVariants", NEAR, STILL),
    // Thousandths, -1000..1000.
    f("bank", NEAR, STILL),
    f("crouchFrame", NEAR, STILL),
    f("airspeed", NEAR, STILL),
    // The glider's and the carried pack's places in their lists, plus one (0: none).
    f("glider", MID, STILL),
    f("pack", MID, STILL),
    // Riding: the vehicle (its id on its owner's life), the seat, and whose vehicle it is when it
    // isn't theirs: a handle (1 is you).
    f("vehicle", MID, STILL),
    f("seat", MID, STILL),
    f("host", MID, STILL),
];

/// A creature (crates/server's actors_json, src/net/worldFeed.ts NetActor). Its height is above its
/// own patch of ground.
pub const CREATURE: &[Field] = &[
    f("x", FAR, STILL),
    f("z", FAR, STILL),
    f("y", FAR, STILL),
    f("facing", FAR, STILL),
    f("state", MID, STILL),
    // Frames into its behaviour state, and how long the state lasts (progress is the one over the other).
    f("stateFrame", MID, FRAMES),
    f("wait", MID, STILL),
    // Ten-thousandths of its most.
    f("hp", FAR, STILL),
    f("deadFrame", FAR, FRAMES),
    // Where a slam it winds up lands.
    f("targetX", NEAR, STILL),
    f("targetZ", NEAR, STILL),
    // Its place in the creatures' kinds (it changes as a slime grows).
    f("kind", FAR, STILL),
];

/// The most cargo slots a vehicle's record carries.
pub const CARGO_SLOTS: usize = 16;

/// A vehicle (the life's Vehicle, as src/render/open/life.ts draws someone else's).
pub const VEHICLE: &[Field] = &[
    f("x", FAR, STILL),
    f("z", FAR, STILL),
    f("y", FAR, STILL),
    f("heading", FAR, STILL),
    f("pitch", MID, STILL),
    f("roll", MID, STILL),
    f("speed", MID, STILL),
    // Thousandths.
    f("steer", NEAR, STILL),
    f("throttle", NEAR, STILL),
    f("sail", MID, STILL),
    // 1 grounded, 2 swimming.
    f("flags", MID, STILL),
    // Each cargo slot: the pack's place in the packs' list, plus one (0: empty).
    f("cargo0", MID, STILL),
    f("cargo1", MID, STILL),
    f("cargo2", MID, STILL),
    f("cargo3", MID, STILL),
    f("cargo4", MID, STILL),
    f("cargo5", MID, STILL),
    f("cargo6", MID, STILL),
    f("cargo7", MID, STILL),
    f("cargo8", MID, STILL),
    f("cargo9", MID, STILL),
    f("cargo10", MID, STILL),
    f("cargo11", MID, STILL),
    f("cargo12", MID, STILL),
    f("cargo13", MID, STILL),
    f("cargo14", MID, STILL),
    f("cargo15", MID, STILL),
];

/// A trade pack on the ground.
pub const ITEM: &[Field] = &[f("x", FAR, STILL), f("z", FAR, STILL), f("y", FAR, STILL), f("rot", FAR, STILL)];

/// An arrow in flight: where it is, its velocity, its side, and who loosed it (a handle; 1 is you).
pub const ARROW: &[Field] =
    &[f("x", FAR, STILL), f("z", FAR, STILL), f("y", FAR, STILL), f("vx", FAR, STILL), f("vz", FAR, STILL), f("team", FAR, STILL), f("owner", FAR, STILL)];

/// A meteor on its way down.
pub const METEOR: &[Field] = &[
    f("x", FAR, STILL),
    f("z", FAR, STILL),
    f("ticksLeft", FAR, Run::Down { per: 1 }),
    f("fallTicks", FAR, STILL),
    f("team", FAR, STILL),
    // Centimetres.
    f("radius", FAR, STILL),
];

/// Something that happened, shown once (a heal, an explosion, an arrow striking; and, for the one
/// player it's about, a hit, a hurt or a heal with its number): never measured against anything.
pub const EVENT: &[Field] = &[f("x", FAR, STILL), f("z", FAR, STILL), f("y", FAR, STILL), f("kind", FAR, STILL), f("size", FAR, STILL)];

/// Which field of a kind is a reference to another entity, written as a handle: a player's host,
/// an arrow's owner.
pub fn reference(kind: Kind) -> Option<usize> {
    match kind {
        Kind::Player => Some(33),
        Kind::Arrow => Some(6),
        _ => None,
    }
}

/// A player's modes, in the order the wire numbers them (the engine's Mode).
pub const MODES: [&str; 7] = ["normal", "attack", "cast", "action", "swim", "glide", "ride"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_fits_and_starts_where_it_stands() {
        for k in Kind::ALL {
            let fields = k.fields();
            assert!(fields.len() <= MAX_FIELDS, "{}", k.name());
            // Interest reads where each record is from its first two fields.
            assert_eq!((fields[0].name, fields[1].name), ("x", "z"), "{}", k.name());
            assert_eq!(Kind::from_byte(k as u8), Some(k));
        }
        assert_eq!(VEHICLE.len(), 11 + CARGO_SLOTS);
        assert_eq!(PLAYER[reference(Kind::Player).unwrap()].name, "host");
        assert_eq!(ARROW[reference(Kind::Arrow).unwrap()].name, "owner");
        assert_eq!((EVENT[0].name, EVENT[1].name), ("x", "z"));
    }

    #[test]
    fn counters_run_on_as_the_rules_count() {
        assert_eq!(FRAMES.guess(-1, 5), -1, "not going");
        assert_eq!(FRAMES.guess(0, 4), 12);
        assert_eq!(SINCE.guess(990, 4), 999, "stops at its cap");
        assert_eq!(SINCE.guess(999, 1), 999);
        let stun = Run::Down { per: 3 };
        assert_eq!((stun.guess(10, 2), stun.guess(10, 9), stun.guess(0, 3)), (4, 0, 0));
        assert_eq!(STILL.guess(7, 100), 7);
        // Far apart in time it still can't overflow.
        assert_eq!(FRAMES.guess(i32::MAX - 1, u32::MAX), i32::MAX);
    }
}
