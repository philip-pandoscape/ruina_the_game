import type { Life } from './life';
import { FARM } from '../../content/farming';
import { STORM } from '../../content/traversal';

// Rain showers that water every crop on the isle, and a wind that wanders round the compass and
// fills (or empties) your sails.

export const raining = (life: Life): boolean => life.state.clock < life.state.weather.rainUntil;

export function stepWeather(life: Life, _dt: number): void {
  const w = life.state.weather;
  const c = life.state.clock;
  if (c >= w.nextRain && c >= w.rainUntil) {
    const [lo, hi] = FARM.rain.lastsSeconds;
    const [glo, ghi] = FARM.rain.gapSeconds;
    w.rainUntil = c + lo + life.rand() * (hi - lo);
    w.nextRain = w.rainUntil + glo + life.rand() * (ghi - glo);
    life.toast('🌧️ Rain sweeps in from the sea - every field drinks it in', 'info');
  }
  stepWind(life);
}

/** Smooth and deterministic: the same clock always has the same wind. */
export function stepWind(life: Life): void {
  const w = life.state.weather;
  const c = life.state.clock;
  w.windDir = 0.9 + 0.75 * Math.sin(c / 190) + 0.3 * Math.sin(c / 57 + 1.3);
  w.windSpeed = 0.72 + 0.22 * Math.sin(c / 97 + 0.4);
}

/** Hour of the day, 0..24, from the world clock. */
export function hourOfDay(life: Life): number {
  const sky = life.zone.recipe.sky;
  const days = life.state.clock / sky.dayLengthSeconds + sky.startHour / 24;
  return (days - Math.floor(days)) * 24;
}

/** How much daylight there is, 0 (night) to 1 (full day), easing through dawn and dusk. */
export function daylight(life: Life): number {
  const { sunrise, sunset } = life.zone.recipe.sky;
  const h = hourOfDay(life);
  const up = Math.min(1, Math.max(0, (h - (sunrise - 0.75)) / 1.5));
  const down = Math.min(1, Math.max(0, ((sunset + 0.75) - h) / 1.5));
  return Math.min(up, down);
}

/** How rough the sea is over water this deep right now, 0 (calm) to 1 (a full storm). */
export function stormAt(life: Life, depth: number): number {
  if (!raining(life)) return 0;
  const k = Math.min(1, Math.max(0, (depth - STORM.fromDepth) / (STORM.fullDepth - STORM.fromDepth)));
  return k * (0.6 + 0.4 * life.state.weather.windSpeed);
}
