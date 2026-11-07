//! Who is sent what: interest on 32 m cells, in three tiers by distance. The old battle server had
//! the same three on a 4 m grid (near within 30 m every tick, at most 256; mid within 90 m every
//! fourth tick; far as a shared 4-byte position): `git show 04da4b6:crates/server/src/battle/interest.rs`.
//! Here the tiers are rates of a priority each entity accumulates (crate::viewer), so a budget that
//! runs short slows the furthest first and starves nobody.
//!
//! - **Near**, within 40 m: every field, every tick (20 a second), the nearest 120 at most. 40 m
//!   rather than the old 30: a hero is drawn up close out to about there (src/render/open/peersView.ts
//!   switches to crowd bodies past it), and 120 detailed heroes is what a client can draw.
//! - **Mid**, to 120 m: what a crowd body is drawn from, every fourth tick (5 a second), 400 at most.
//! - **Far**, to 250 m: where it is, which way it faces, its side, its health and whether it's down,
//!   about once a second, 1000 at most. Beyond 250 m nothing: the fog has it.
//!
//! Something already in sight is kept a little past the edge (10 m), and the nearest of those
//! over a cap are judged 5 m nearer than newcomers, so nothing flickers in and out at a boundary.

use crate::schema::{Kind, Tier};

pub const NEAR: f64 = 40.0;
pub const MID: f64 = 120.0;
pub const FAR: f64 = 250.0;
/// Something in sight stays in sight until it's this much past its kind's reach.
pub const KEEP_MARGIN: f64 = 10.0;
/// The furthest anything is kept in sight.
pub const KEEP: f64 = FAR + KEEP_MARGIN;
/// Something in sight is judged this much nearer than a newcomer when a tier is over its cap.
pub const KNOWN_EDGE: f64 = 5.0;

pub const NEAR_CAP: usize = 120;
pub const MID_CAP: usize = 400;
pub const FAR_CAP: usize = 1000;

/// Effects are shown within this distance (crates/server's EFFECT_RADIUS), the nearest 48 at most,
/// and those told to a player about themselves, 24 at most (the engine's MAX_OWN_EVENTS).
pub const EVENTS_WITHIN: f64 = 90.0;
pub const EVENTS_CAP: usize = 48;
pub const TOLD_CAP: usize = 24;

/// The priority a tier adds each tick: something is due once it reaches 1.
pub fn rate(t: Tier) -> f32 {
    match t {
        Tier::Near => 1.0,
        Tier::Mid => 0.25,
        Tier::Far => 0.05,
    }
}

/// Ticks between two refreshes at a tier, when the budget allows.
pub fn every(t: Tier) -> u32 {
    match t {
        Tier::Near => 1,
        Tier::Mid => 4,
        Tier::Far => 20,
    }
}

/// How far each kind is sent at all: small things and what flies only to the middle distance.
pub fn reach(k: Kind) -> f64 {
    match k {
        Kind::Item | Kind::Arrow | Kind::Meteor => MID,
        _ => FAR,
    }
}

/// Whether a kind always goes at the near rate wherever it is in reach (what flies, which is drawn
/// moving and gone in a moment).
pub fn always_near(k: Kind) -> bool {
    matches!(k, Kind::Arrow | Kind::Meteor)
}

/// The tier each candidate is in, given its squared distance (m²), its kind and whether it's in
/// sight already: `None` for one that isn't sent (out of reach, or over a cap).
pub fn tiers(cands: &[(f64, Kind, bool)]) -> Vec<Option<Tier>> {
    let mut out = vec![None; cands.len()];
    // Distances as judged for the caps: what's in sight a little nearer.
    let judged = |i: usize| cands[i].0.sqrt() - if cands[i].2 { KNOWN_EDGE } else { 0.0 };
    let mut pool: Vec<usize> = Vec::new();
    for (i, &(d2, kind, _)) in cands.iter().enumerate() {
        let r = reach(kind);
        if d2 > r * r {
            continue;
        }
        if always_near(kind) {
            out[i] = Some(Tier::Near);
        } else {
            pool.push(i);
        }
    }
    let mut rest = Vec::new();
    for (tier, radius, cap) in [(Tier::Near, NEAR, NEAR_CAP), (Tier::Mid, MID, MID_CAP), (Tier::Far, FAR, FAR_CAP)] {
        // Those within this tier's radius, and whatever a nearer tier had no room for.
        let (mut inside, outside): (Vec<usize>, Vec<usize>) = pool.drain(..).partition(|&i| cands[i].0 <= radius * radius);
        inside.append(&mut rest);
        if inside.len() > cap {
            inside.select_nth_unstable_by(cap, |&a, &b| judged(a).total_cmp(&judged(b)));
            rest = inside.split_off(cap);
        }
        for &i in &inside {
            out[i] = Some(tier);
        }
        pool = outside;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(d: f64, kind: Kind) -> (f64, Kind, bool) {
        (d * d, kind, false)
    }

    #[test]
    fn tiers_go_by_distance_and_kind() {
        let t = tiers(&[
            at(10.0, Kind::Player),
            at(80.0, Kind::Creature),
            at(200.0, Kind::Player),
            at(300.0, Kind::Player),
            at(150.0, Kind::Item),
            at(100.0, Kind::Arrow),
        ]);
        assert_eq!(t, vec![Some(Tier::Near), Some(Tier::Mid), Some(Tier::Far), None, None, Some(Tier::Near)]);
    }

    #[test]
    fn a_crowd_over_a_cap_spills_into_the_next_tier() {
        // 150 within 20 m: the nearest 120 near, the other 30 mid.
        let cands: Vec<_> = (0..150).map(|i| at(1.0 + f64::from(i) * 0.1, Kind::Player)).collect();
        let t = tiers(&cands);
        assert_eq!(t.iter().filter(|x| **x == Some(Tier::Near)).count(), NEAR_CAP);
        assert_eq!(t.iter().filter(|x| **x == Some(Tier::Mid)).count(), 30);
        assert_eq!(t[0], Some(Tier::Near));
        assert_eq!(t[149], Some(Tier::Mid));
        // 2000 all within 50 m: 120 near, 400 mid, 1000 far, the rest not sent.
        let crowd: Vec<_> = (0..2000).map(|i| at(41.0 + f64::from(i) * 0.004, Kind::Player)).collect();
        let t = tiers(&crowd);
        let n = |tier| t.iter().filter(|x| **x == Some(tier)).count();
        assert_eq!((n(Tier::Near), n(Tier::Mid), n(Tier::Far)), (0, MID_CAP, FAR_CAP));
    }

    #[test]
    fn what_is_in_sight_keeps_its_place_at_a_cap() {
        // 121 at the same distance, the last in sight already: it is one of the 120.
        let mut cands: Vec<_> = (0..121).map(|_| at(10.0, Kind::Player)).collect();
        cands[120].2 = true;
        assert_eq!(tiers(&cands)[120], Some(Tier::Near));
    }
}
