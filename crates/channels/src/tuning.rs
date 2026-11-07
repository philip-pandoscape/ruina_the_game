//! The channels' numbers: `shared/channels.json`, built from `content/channels.json` by
//! `npm run content` (contentc holds them to the same sense as [`Tuning::check`]). Counts are
//! players in play in a channel; times are seconds in the file, read as milliseconds here.

use std::sync::OnceLock;

use serde::Deserialize;

use crate::Millis;

/// How channels fill, open, merge and are changed (docs/world.md, Channels).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tuning {
    /// Arrivals fill a channel up to this many; past it they go to another, or open one.
    pub soft_cap: usize,
    /// Nobody is placed in a channel this full, not with their party, nor coming back to it.
    pub hard_cap: usize,
    /// Another channel opens once the room left below the soft cap in every open one together is
    /// less than this: a crowd still coming finds it there.
    pub open_ahead: usize,
    /// A channel with fewer than this in it is quiet...
    pub quiet: usize,
    /// ...and one quiet this long (seconds) merges, if another can take its players and stay at most
    /// `merge_fill`.
    pub quiet_for: f64,
    /// How full a merge may leave the channel it merges into: below the soft cap, so a merge never
    /// fills one past where another would open.
    pub merge_fill: usize,
    /// How long (seconds) a merging channel's players are told before they're moved.
    pub merge_notice: f64,
    /// How long after that (seconds) a merge waits for someone in a fight, in the air or at a table
    /// before moving them anyway.
    pub merge_wait: f64,
    /// A player changes channel at most once in this long (seconds), by choice or to follow their
    /// party.
    pub change_every: f64,
    /// Someone who struck or took a blow less than this long ago (seconds) is in a fight.
    pub calm_after: f64,
    /// Someone back within this long (seconds) of leaving goes back to the channel they left.
    pub rejoin_within: f64,
    /// How long (seconds) a directory, started anew, hears from the simulations playing on before
    /// it merges or closes any channel: until then it may not know who plays where. Not in the
    /// content file: ten seconds, or none in tests.
    #[serde(default = "settle_default")]
    pub settle: f64,
}

fn settle_default() -> f64 {
    10.0
}

const fn ms(seconds: f64) -> Millis {
    (seconds * 1000.0) as Millis
}

impl Tuning {
    pub fn quiet_for_ms(&self) -> Millis {
        ms(self.quiet_for)
    }

    pub fn settle_ms(&self) -> Millis {
        ms(self.settle)
    }

    pub fn merge_notice_ms(&self) -> Millis {
        ms(self.merge_notice)
    }

    pub fn merge_wait_ms(&self) -> Millis {
        ms(self.merge_wait)
    }

    pub fn change_every_ms(&self) -> Millis {
        ms(self.change_every)
    }

    pub fn calm_after_ms(&self) -> Millis {
        ms(self.calm_after)
    }

    pub fn rejoin_within_ms(&self) -> Millis {
        ms(self.rejoin_within)
    }

    /// What's wrong with these numbers, if anything: counts in order (some quiet below a
    /// comfortable merge, below the soft cap, at most the hard cap), a merge never leaving less
    /// room than would open another channel at once, and no time below zero.
    pub fn check(&self) -> Result<(), String> {
        let mut out = Vec::new();
        if self.quiet == 0 {
            out.push("quiet must be at least 1".to_string());
        }
        if self.quiet > self.merge_fill {
            out.push(format!("quiet ({}) is more than mergeFill ({}): a quiet channel could never merge", self.quiet, self.merge_fill));
        }
        if self.merge_fill >= self.soft_cap {
            out.push(format!("mergeFill ({}) must be below softCap ({})", self.merge_fill, self.soft_cap));
        }
        if self.soft_cap > self.hard_cap {
            out.push(format!("softCap ({}) is more than hardCap ({})", self.soft_cap, self.hard_cap));
        }
        if self.open_ahead >= self.soft_cap.saturating_sub(self.merge_fill) {
            out.push(format!(
                "openAhead ({}) must be less than softCap - mergeFill ({}), or a merge would open another channel at once",
                self.open_ahead,
                self.soft_cap.saturating_sub(self.merge_fill)
            ));
        }
        for (name, v) in [
            ("quietFor", self.quiet_for),
            ("mergeNotice", self.merge_notice),
            ("mergeWait", self.merge_wait),
            ("changeEvery", self.change_every),
            ("calmAfter", self.calm_after),
            ("rejoinWithin", self.rejoin_within),
        ] {
            if !(v.is_finite() && v >= 0.0) {
                out.push(format!("{name} is {v}, where it's a number of seconds from 0"));
            }
        }
        if out.is_empty() { Ok(()) } else { Err(out.join("; ")) }
    }

    /// Small numbers, for tests and the crowd: channels of 20 that fill in minutes, merge in one,
    /// and are changed once a minute.
    pub fn small() -> Tuning {
        Tuning {
            soft_cap: 20,
            hard_cap: 24,
            open_ahead: 2,
            quiet: 5,
            quiet_for: 60.0,
            merge_fill: 15,
            merge_notice: 10.0,
            merge_wait: 10.0,
            change_every: 60.0,
            calm_after: 10.0,
            rejoin_within: 60.0,
            settle: 0.0,
        }
    }
}

/// The game's channels' numbers (`shared/channels.json`).
pub fn tuning() -> &'static Tuning {
    static T: OnceLock<Tuning> = OnceLock::new();
    T.get_or_init(|| {
        let t: Tuning = serde_json::from_str(include_str!("../../../shared/channels.json")).unwrap_or_else(|e| panic!("shared/channels.json: {e}"));
        t.check().unwrap_or_else(|e| panic!("shared/channels.json: {e}"));
        t
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_games_numbers_make_sense_and_so_do_the_tests() {
        let t = tuning();
        assert!(t.soft_cap >= 100, "a channel holds a crowd: {}", t.soft_cap);
        assert_eq!(Tuning::small().check(), Ok(()));
        assert_eq!(t.change_every_ms(), (t.change_every * 1000.0) as Millis);
    }

    #[test]
    fn numbers_out_of_order_say_what_is_wrong() {
        let bad = Tuning { quiet: 30, merge_fill: 25, soft_cap: 20, hard_cap: 10, open_ahead: 0, change_every: -1.0, ..Tuning::small() };
        let e = bad.check().unwrap_err();
        for part in [
            "quiet (30) is more than mergeFill (25)",
            "mergeFill (25) must be below softCap (20)",
            "softCap (20) is more than hardCap (10)",
            "changeEvery is -1",
        ] {
            assert!(e.contains(part), "{e}");
        }
        let crowded = Tuning { open_ahead: 5, ..Tuning::small() };
        assert!(crowded.check().unwrap_err().contains("openAhead (5) must be less than softCap - mergeFill (5)"));
    }
}
