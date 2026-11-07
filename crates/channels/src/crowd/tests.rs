use super::*;
use crate::tuning::tuning;

/// Some moment on the world's clock.
const START: Millis = 1_793_000_000_000;

/// `plan`'s crowd played against the policy in memory with `t`, from start to end.
fn played(plan: Plan, t: &Tuning) -> Tally {
    let mut here = Here::new(t.clone());
    let mut crowd = Crowd::new(plan, START);
    let length = crowd.plan.length(t);
    crowd.run(&mut here, length).clone()
}

#[test]
fn a_crowd_fills_a_region_a_channel_opens_parties_stay_together_and_a_quiet_channel_merges() {
    let t = Tuning::small();
    let mut here = Here::new(t.clone());
    let mut crowd = Crowd::new(Plan::small(1), START);
    // It fills: once the crowd has come, channels have opened for it, and none is past its hard cap.
    let ramp = crowd.plan.ramp as u64;
    let filling = crowd.run(&mut here, ramp).clone();
    assert!(filling.peak_online > 3 * t.soft_cap, "a crowd of {} at most", filling.peak_online);
    assert!(filling.peak_channels >= 4, "{filling:#?}");
    assert!(filling.fullest <= t.hard_cap);
    // Parties came together: placed with their party, or joined it after.
    assert!(filling.placed.get("Party").copied().unwrap_or(0) > 20, "{filling:#?}");
    // It thins: quiet channels merge until the last of the crowd has gone and one channel is left.
    let length = crowd.plan.length(&t) - ramp;
    let all = crowd.run(&mut here, length).clone();
    assert_eq!(all.broken, Vec::<String>::new(), "{all:#?}");
    assert!(all.merges >= 3 && all.closed >= all.merges, "{all:#?}");
    assert_eq!(all.left_open, 1, "{all:#?}");
    assert_eq!(all.opened, all.closed + 1, "every channel opened but the last has closed");
    assert_eq!(all.arrivals, all.departures + all.blips, "everyone came and went");
    assert!(all.moved.get("Merge").copied().unwrap_or(0) > 0, "{all:#?}");
    // Parties are kept together: a party split between channels is one whose member came back to
    // where it was a moment ago, or waits on the rules to join it, and not for long.
    assert!(all.longest_split <= (t.change_every + t.rejoin_within + 300.0) as Millis * 1000, "{all:#?}");
    // Moves and refusals of every kind happened.
    for why in ["Choice", "Party", "Merge"] {
        assert!(all.moved.get(why).copied().unwrap_or(0) > 0, "no {why} moves: {all:#?}");
    }
    for r in ["Pack", "Combat", "Wait"] {
        assert!(all.refused.get(r).copied().unwrap_or(0) > 0, "no {r} refusals: {all:#?}");
    }
}

#[test]
fn the_same_crowd_plays_out_the_same_way_and_another_differently() {
    let t = Tuning::small();
    let a = played(Plan::small(3), &t);
    assert_eq!(a, played(Plan::small(3), &t));
    assert_ne!(a, played(Plan::small(4), &t));
}

#[test]
fn crowds_of_other_seeds_break_nothing() {
    let t = Tuning::small();
    for seed in 10..16 {
        let tally = played(Plan::small(seed), &t);
        assert_eq!(tally.broken, Vec::<String>::new(), "seed {seed}: {tally:#?}");
        assert_eq!(tally.left_open, 1, "seed {seed}");
    }
}

#[test]
fn thousands_play_by_the_games_own_numbers() {
    let t = tuning();
    let tally = played(Plan::large(7), t);
    assert_eq!(tally.broken, Vec::<String>::new(), "{tally:#?}");
    assert!(tally.peak_online > 2 * t.soft_cap, "{tally:#?}");
    assert!(tally.peak_channels >= 3, "{tally:#?}");
    assert!(tally.fullest <= t.hard_cap);
    assert_eq!(tally.left_open, 1);
}

#[test]
#[ignore = "a measurement, run by hand: cargo test --release -p ruina-channels crowds_measured -- --ignored --nocapture"]
// A measurement reads the clock; the crowd and the policy never do.
#[allow(clippy::disallowed_methods, clippy::disallowed_types)]
fn crowds_measured() {
    for (name, plan, t) in [("small", Plan::small(1), Tuning::small()), ("large", Plan::large(7), tuning().clone())] {
        let started = std::time::Instant::now();
        let tally = played(plan, &t);
        println!("{name}: {:.2} s\n{tally:#?}", started.elapsed().as_secs_f64());
    }
}
