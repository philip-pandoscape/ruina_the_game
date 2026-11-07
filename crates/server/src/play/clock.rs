//! The world's clock: frames at 60 a second from the world's epoch, a server tick every third
//! (`TICK_HZ`, 20 a second). Every game numbers its ticks by it, so a tick is the same moment in
//! every channel and copy, and later on every server (`.plans/world/research.md`, tick numbers);
//! a browser's timelines run on across moves between them. The engine reads no clock: the tick is
//! handed to it.

use std::time::{SystemTime, UNIX_EPOCH};

use super::TICK_HZ;

/// The world's epoch: 2026-01-01 00:00:00 UTC, in milliseconds since 1970.
pub const EPOCH_MS: u64 = 1_767_225_600_000;

/// The world's tick at `now`: server ticks since the epoch.
pub fn world_tick(now: SystemTime) -> u64 {
    let ms = now.duration_since(UNIX_EPOCH).map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    ms.saturating_sub(EPOCH_MS) * u64::from(TICK_HZ) / 1000
}

/// The tick a browser drew everyone else at, which it sends in sixteenths of a tick and of which
/// the wire carries the low 32 bits, read back in full against the game's tick `now`: the nearest
/// tick with those low bits (a browser is never months away from the server it plays on).
pub fn seen_at(now: u64, low: u32) -> f64 {
    let now16 = now.wrapping_mul(16);
    // How far behind now it is, in sixteenths (negative if ahead).
    let behind = i64::from((now16 as u32).wrapping_sub(low) as i32);
    (now16 as i64 - behind) as f64 / 16.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn ticks_count_from_the_epoch_at_the_server_s_rate() {
        let at = |ms: u64| world_tick(UNIX_EPOCH + Duration::from_millis(ms));
        assert_eq!(at(EPOCH_MS), 0);
        assert_eq!(at(EPOCH_MS - 5_000), 0, "before the epoch is the epoch");
        assert_eq!(at(EPOCH_MS + 1_000), u64::from(TICK_HZ));
        assert_eq!(at(EPOCH_MS + 49), 0);
        assert_eq!(at(EPOCH_MS + 50), 1);
        // 2026-11-06: about 26.5 million seconds in.
        assert!((520_000_000..540_000_000).contains(&at(1_793_923_200_000)));
    }

    #[test]
    fn a_view_comes_back_whole_from_its_low_bits() {
        // A year in, a tick's sixteenths are well past what 32 bits hold.
        let now = 365 * 24 * 3600 * u64::from(TICK_HZ);
        assert!(now * 16 > u64::from(u32::MAX));
        for (back, frac) in [(0, 0), (3, 8), (40, 15), (1, 1)] {
            let seen16 = (now - back) * 16 + frac;
            assert_eq!(seen_at(now, seen16 as u32), seen16 as f64 / 16.0, "{back} ticks back");
        }
        // A browser a moment ahead of the server (its clock a little fast) reads as ahead.
        assert_eq!(seen_at(now, ((now + 1) * 16) as u32), (now + 1) as f64);
        // Small ticks, as the tests' games have, read as they are.
        assert_eq!(seen_at(10, 9 * 16 + 4), 9.25);
    }
}
