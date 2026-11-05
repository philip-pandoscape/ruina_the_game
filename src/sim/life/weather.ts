import type { Life } from './life';
import { FARM } from '../../content/farming';
import { STORM } from '../../content/traversal';

// Rain showers that water every crop on the isle, and a wind that wanders round the compass and
// fills (or empties) your sails. Both run on the weather's clock: online the world's, the server's
// own, so everyone on Emberholm is rained on and sails on the same wind at the same moment; offline
// (and in the rules' tests) the island's. Nothing in them is left to the island's dice, so the same
// clock always has the same weather, here and on the server (server/src/life/weather.rs).

export const raining = (life: Life): boolean => life.state.clock < life.state.weather.rainUntil;

/** The clock the weather runs on, in seconds: online the world's (Life.worldClock), offline the island's. */
export function weatherClock(life: Life): number {
  return life.worldClock?.() ?? life.state.clock;
}

const RAIN = FARM.rain;
/**
 * Showers come one to a slot of this many seconds (a shower and a gap, on average), starting up to
 * JITTER seconds into it: so they last lastsSeconds and come gapSeconds apart, as the dice fall.
 */
const SLOT = (RAIN.lastsSeconds[0] + RAIN.lastsSeconds[1]) / 2 + (RAIN.gapSeconds[0] + RAIN.gapSeconds[1]) / 2;
const JITTER = Math.max(0, (RAIN.gapSeconds[1] - RAIN.gapSeconds[0] - (RAIN.lastsSeconds[1] - RAIN.lastsSeconds[0])) / 2);

/** A number in [0, 1) for slot `k` and what it decides (`n`): the same for everyone, in both rules. */
function dice(k: number, n: number): number {
  let h = (Math.imul(k | 0, 0x9e3779b1) ^ Math.imul(n, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Shower `k` on the weather's clock: the first comes firstAfter seconds in, the rest a slot apart, give or take. */
function shower(k: number): { start: number; end: number } {
  const start = RAIN.firstAfter + k * SLOT + (k === 0 ? 0 : JITTER * dice(k, 1));
  return { start, end: start + RAIN.lastsSeconds[0] + (RAIN.lastsSeconds[1] - RAIN.lastsSeconds[0]) * dice(k, 2) };
}

/** The rain at `t` on the weather's clock: whether it's raining, this slot's shower, and when the next one starts. */
export function rainAt(t: number): { raining: boolean; start: number; end: number; next: number } {
  const k = Math.max(0, Math.floor((t - RAIN.firstAfter) / SLOT));
  const s = shower(k);
  if (t < s.start) return { raining: false, start: s.start, end: s.end, next: s.start };
  return { raining: t < s.end, start: s.start, end: s.end, next: shower(k + 1).start };
}

export function stepWeather(life: Life, _dt: number): void {
  const w = life.state.weather;
  const c = life.state.clock;
  const t = weatherClock(life);
  const r = rainAt(t);
  const was = c < w.rainUntil;
  // Kept in the island's own clock, which everything that asks about the rain counts in.
  w.rainUntil = r.raining ? c + (r.end - t) : Math.min(w.rainUntil, c);
  w.nextRain = c + (r.next - t);
  // Said as it starts, not on arriving in the middle of one.
  if (r.raining && !was && t - r.start < 1) life.toast('🌧️ Rain sweeps in from the sea - every field drinks it in', 'info');
  stepWind(life);
}

/** Smooth and deterministic: the same clock always has the same wind. */
export function stepWind(life: Life): void {
  const w = life.state.weather;
  const c = weatherClock(life);
  w.windDir = 0.9 + 0.75 * Math.sin(c / 190) + 0.3 * Math.sin(c / 57 + 1.3);
  w.windSpeed = 0.72 + 0.22 * Math.sin(c / 97 + 0.4);
}

/** Hour of the day, 0..24, `seconds` into a clock: the island's own, or online the server's. */
export function hourAt(sky: { dayLengthSeconds: number; startHour: number }, seconds: number): number {
  const days = seconds / sky.dayLengthSeconds + sky.startHour / 24;
  return (days - Math.floor(days)) * 24;
}

/**
 * Hour of the day, 0..24, from the island's clock. Online the sky follows the server's clock
 * instead (src/main.ts), which everyone shares: each island's clock runs on by itself while you're
 * away, so no two islands agree on the hour.
 */
export function hourOfDay(life: Life): number {
  return hourAt(life.zone.recipe.sky, life.state.clock);
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
