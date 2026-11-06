//! Rain showers that water every crop on the isle, and a wind that wanders round the compass and
//! fills (or empties) your sails (src/sim/life/weather.ts). Both run on the weather's clock: online
//! the world's (the server's own, which the channel hands every island each tick), so everyone on
//! Emberholm is rained on and sails on the same wind at the same moment; offline and in the rules'
//! checks the island's. Nothing in them is left to the island's dice, so the same clock always has
//! the same weather, here and in the browser.

use crate::jsmath::JsMath;
use super::content::{farm, storm};
use super::Life;

pub fn raining(life: &Life) -> bool {
    life.state.clock < life.state.weather.rain_until
}

/// The clock the weather runs on, in seconds: the world's when the channel has set it
/// (Life::world_clock), else the island's.
pub fn weather_clock(life: &Life) -> f64 {
    life.world_clock.unwrap_or(life.state.clock)
}

/// Showers come one to a slot of this many seconds (a shower and a gap, on average), starting up to
/// the second number of seconds into it: so they last lastsSeconds and come gapSeconds apart.
fn slot() -> (f64, f64) {
    let r = &farm().rain;
    let slot = (r.lasts_seconds[0] + r.lasts_seconds[1]) / 2.0 + (r.gap_seconds[0] + r.gap_seconds[1]) / 2.0;
    let jitter = 0f64.max((r.gap_seconds[1] - r.gap_seconds[0] - (r.lasts_seconds[1] - r.lasts_seconds[0])) / 2.0);
    (slot, jitter)
}

/// A number in [0, 1) for slot `k` and what it decides (`n`): the same for everyone, in both rules
/// (the TypeScript's dice, with Math.imul's wrapping 32-bit products).
fn dice(k: i64, n: u32) -> f64 {
    let mut h = (k as i32 as u32).wrapping_mul(0x9e37_79b1) ^ n.wrapping_mul(0x85eb_ca77);
    h = (h ^ (h >> 16)).wrapping_mul(0x7feb_352d);
    h = (h ^ (h >> 15)).wrapping_mul(0x846c_a68b);
    (h ^ (h >> 16)) as f64 / 4_294_967_296.0
}

/// Shower `k` on the weather's clock, (start, end): the first comes firstAfter seconds in, the rest
/// a slot apart, give or take.
fn shower(k: i64) -> (f64, f64) {
    let r = &farm().rain;
    let (slot, jitter) = slot();
    let start = r.first_after + k as f64 * slot + if k == 0 { 0.0 } else { jitter * dice(k, 1) };
    (start, start + r.lasts_seconds[0] + (r.lasts_seconds[1] - r.lasts_seconds[0]) * dice(k, 2))
}

/// The rain at a moment on the weather's clock (TS rainAt).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rain {
    pub raining: bool,
    /// This slot's shower.
    pub start: f64,
    pub end: f64,
    /// When the next shower starts.
    pub next: f64,
}

pub fn rain_at(t: f64) -> Rain {
    let (slot, _) = slot();
    let k = 0f64.max(((t - farm().rain.first_after) / slot).floor()) as i64;
    let (start, end) = shower(k);
    if t < start {
        return Rain { raining: false, start, end, next: start };
    }
    Rain { raining: t < end, start, end, next: shower(k + 1).0 }
}

pub fn step_weather(life: &mut Life, _dt: f64) {
    let c = life.state.clock;
    let t = weather_clock(life);
    let r = rain_at(t);
    let was = c < life.state.weather.rain_until;
    // Kept in the island's own clock, which everything that asks about the rain counts in.
    let w = &mut life.state.weather;
    w.rain_until = if r.raining { c + (r.end - t) } else { w.rain_until.min(c) };
    w.next_rain = c + (r.next - t);
    // Said as it starts, not on arriving in the middle of one.
    if r.raining && !was && t - r.start < 1.0 {
        life.toast("🌧️ Rain sweeps in from the sea - every field drinks it in", "info");
    }
    step_wind(life);
}

/// Smooth and deterministic: the same clock always has the same wind.
pub fn step_wind(life: &mut Life) {
    let c = weather_clock(life);
    let w = &mut life.state.weather;
    w.wind_dir = 0.9 + 0.75 * (c / 190.0).js_sin() + 0.3 * (c / 57.0 + 1.3).js_sin();
    w.wind_speed = 0.72 + 0.22 * (c / 97.0 + 0.4).js_sin();
}

/// How rough the sea is over water this deep right now, 0 (calm) to 1 (a full storm).
pub fn storm_at(life: &Life, depth: f64) -> f64 {
    if !raining(life) {
        return 0.0;
    }
    let s = storm();
    let k = ((depth - s.from_depth) / (s.full_depth - s.from_depth)).clamp(0.0, 1.0);
    k * (0.6 + 0.4 * life.state.weather.wind_speed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::life::LifeEvent;
    use crate::open::zone::emberholm;

    /// rainAt as src/sim/life/weather.ts works it out, to the last bit: (t, raining, start, end, next).
    const BROWSER: [(f64, bool, f64, f64, f64); 10] = [
        (0.0, false, 240.0, 370.96530275652185, 240.0),
        (239.0, false, 240.0, 370.96530275652185, 240.0),
        (240.0, true, 240.0, 370.96530275652185, 983.9430155046284),
        (300.0, true, 240.0, 370.96530275652185, 983.9430155046284),
        (400.0, false, 240.0, 370.96530275652185, 983.9430155046284),
        (1000.0, true, 983.9430155046284, 1101.4316743402742, 1693.8431939273141),
        (5000.0, false, 4592.312170029618, 4691.087984668557, 5360.571019051131),
        (123456.5, false, 123296.18334829574, 123441.47021974204, 123953.02136573591),
        (1762300000.0, false, 1762299390.7330143, 1762299488.1632354, 1762300209.9376085),
        (1762310077.25, false, 1762310136.8058028, 1762310283.342108, 1762310136.8058028),
    ];

    #[test]
    fn the_rain_falls_when_the_browser_says_it_does() {
        for (t, raining, start, end, next) in BROWSER {
            assert_eq!(rain_at(t), Rain { raining, start, end, next }, "at {t}");
        }
    }

    #[test]
    fn showers_last_and_come_apart_as_the_farming_tuning_says() {
        let r = &farm().rain;
        let mut prev = rain_at(1.76e9);
        for _ in 0..20_000 {
            let s = rain_at(prev.next + 0.001);
            let lasts = s.end - s.start;
            let gap = s.start - prev.end;
            assert!(lasts >= r.lasts_seconds[0] && lasts <= r.lasts_seconds[1], "a shower of {lasts} s");
            assert!(gap >= r.gap_seconds[0] && gap <= r.gap_seconds[1], "a gap of {gap} s");
            prev = s;
        }
    }

    #[test]
    fn islands_with_their_own_clocks_share_the_worlds_weather() {
        let mut a = Life::new(emberholm(), None, None);
        let mut b = Life::new(emberholm(), None, None);
        // Their clocks ran on differently while their players were away.
        a.state.clock = 1234.5;
        b.state.clock = 98_765.0;
        // A moment in the world's first shower's slot, a few seconds into it.
        let shower = rain_at(1.76e9);
        let t = if shower.raining { 1.76e9 } else { shower.next + 3.0 };
        for life in [&mut a, &mut b] {
            life.world_clock = Some(t);
            step_weather(life, 1.0 / 60.0);
        }
        assert!(raining(&a) && raining(&b));
        assert_eq!(a.state.weather.rain_until - a.state.clock, b.state.weather.rain_until - b.state.clock);
        assert_eq!((a.state.weather.wind_dir, a.state.weather.wind_speed), (b.state.weather.wind_dir, b.state.weather.wind_speed));
        // Arriving in the middle of a shower isn't news.
        let said = |l: &mut Life| l.drain_events().into_iter().any(|e| matches!(e, LifeEvent::Toast { ref text, .. } if text.starts_with("🌧️")));
        assert!(!said(&mut a));
        // Offline the island's own clock is the weather's: its first shower comes firstAfter in.
        let mut c = Life::new(emberholm(), None, None);
        c.drain_events();
        c.state.clock = 239.99;
        step_weather(&mut c, 1.0 / 60.0);
        assert!(!raining(&c));
        c.state.clock = 240.01;
        step_weather(&mut c, 1.0 / 60.0);
        assert!(raining(&c));
        assert!(said(&mut c), "it says so as it starts");
    }
}
