//! Rain showers that water every crop on the isle, and a wind that wanders round the compass and
//! fills (or empties) your sails (src/sim/life/weather.ts).

use crate::jsmath::JsMath;
use super::content::{farm, storm};
use super::Life;

pub fn raining(life: &Life) -> bool {
    life.state.clock < life.state.weather.rain_until
}

pub fn step_weather(life: &mut Life, _dt: f64) {
    let c = life.state.clock;
    let w = &life.state.weather;
    if c >= w.next_rain && c >= w.rain_until {
        let [lo, hi] = farm().rain.lasts_seconds;
        let [glo, ghi] = farm().rain.gap_seconds;
        let rain_until = c + lo + life.rand() * (hi - lo);
        let next_rain = rain_until + glo + life.rand() * (ghi - glo);
        life.state.weather.rain_until = rain_until;
        life.state.weather.next_rain = next_rain;
        life.toast("🌧️ Rain sweeps in from the sea - every field drinks it in", "info");
    }
    // Smooth and deterministic: the same clock always has the same wind.
    let w = &mut life.state.weather;
    w.wind_dir = 0.9 + 0.75 * (c / 190.0).js_sin() + 0.3 * (c / 57.0 + 1.3).js_sin();
    w.wind_speed = 0.72 + 0.22 * (c / 97.0 + 0.4).js_sin();
}

/// Hour of the day, 0..24, from the world clock.
pub fn hour_of_day(life: &Life) -> f64 {
    let sky = &life.zone.recipe.sky;
    let days = life.state.clock / sky.day_length_seconds + sky.start_hour / 24.0;
    (days - days.floor()) * 24.0
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
