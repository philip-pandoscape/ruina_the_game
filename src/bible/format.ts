// Numbers as the bible shows them, each with its unit. Every helper takes the game's own value
// (from the content, the tuning or the rules) and returns it ready for a page, so prose never holds
// a number typed by hand (src/bible/md.ts).

import { SIM_HZ } from '../tuning';
import { money } from '../ui/theme/icons';
import { Html, plainNumber, raw } from './md';

const v = (text: string, title?: string): Html => raw(`<span class="v"${title ? ` title="${title}"` : ''}>${text}</span>`);
const NB = ' ';

/** A number, grouped and with at most `digits` decimals. */
export const num = (n: number, digits = 2): Html => v(plainNumber(n, digits));

/** A number with its unit after it: 3.2 m/s, 0.45 m. */
export const unit = (n: number, u: string, digits = 2): Html => v(`${plainNumber(n, digits)}${NB}${u}`);

export const metres = (n: number, digits = 2): Html => unit(n, 'm', digits);
export const speed = (n: number, digits = 2): Html => unit(n, 'm/s', digits);
export const accel = (n: number): Html => unit(n, 'm/s²');

/** A speed in metres a second, and what that is in kilometres an hour. */
export const speedKmh = (n: number): Html => v(`${plainNumber(n)}${NB}m/s <small>(${plainNumber(Math.round(n * 3.6))}${NB}km/h)</small>`);

/** Seconds, as they read best: 0.25 s, 45 s, 2 min 30 s, 1.5 h. */
export function duration(seconds: number): Html {
  return v(durationText(seconds));
}

export function durationText(seconds: number): string {
  const s = Math.abs(seconds);
  if (s < 60) return `${plainNumber(seconds, s < 10 ? 2 : 1)}${NB}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = Math.round(s - m * 60);
    return r ? `${m}${NB}min ${r}${NB}s` : `${m}${NB}min`;
  }
  const h = s / 3600;
  return `${plainNumber(h, 1)}${NB}h`;
}

/** Rule frames (the rules step SIM_HZ times a second) as seconds, the frames after them. */
export const frames = (f: number): Html => v(`${durationText(f / SIM_HZ)} <small>(${plainNumber(f)}${NB}${f === 1 ? 'frame' : 'frames'})</small>`);

/** Rule frames as seconds alone. */
export const framesAsSeconds = (f: number): Html => duration(f / SIM_HZ);

/** A share: 0.55 → 55%. */
export const pct = (fraction: number, digits = 1): Html => v(`${plainNumber(fraction * 100, digits)}%`);

/** A change: 0.15 → +15%, −0.12 → −12%. */
export const change = (fraction: number, digits = 1): Html => {
  const p = fraction * 100;
  const text = plainNumber(Math.abs(p), digits);
  return v(`${text === '0' ? '' : p > 0 ? '+' : '−'}${text}%`);
};

/** A multiplier: ×1.25. */
export const times = (n: number): Html => v(`×${plainNumber(n)}`);

/** A slope, given as rise over run, in degrees. */
export const slopeDegrees = (riseOverRun: number): Html => v(`${Math.round((Math.atan(riseOverRun) * 180) / Math.PI)}°`);

/** An angle in radians, in degrees. */
export const degrees = (radians: number): Html => v(`${plainNumber(Math.round((radians * 180) / Math.PI))}°`);

/** A turn rate in radians a second, in degrees a second. */
export const turnRate = (radiansPerSecond: number): Html => v(`${plainNumber(Math.round((radiansPerSecond * 180) / Math.PI))}°/s`);

/** Copper as the game shows money: gold, silver and copper coins. */
export const coins = (copper: number): Html => raw(money(Math.round(copper), 14));

/** From one number to another: 3–5, with a unit after if given. */
export const range = (r: readonly [number, number] | readonly number[], u?: string): Html =>
  v(r[0] === r[1] ? `${plainNumber(r[0])}${u ? NB + u : ''}` : `${plainNumber(r[0])}–${plainNumber(r[1])}${u ? NB + u : ''}`);

/** A count with its noun: 1 slot, 3 slots. */
export const count = (n: number, one: string, many = `${one}s`): Html => v(`${plainNumber(n)}${NB}${n === 1 ? one : many}`);

/** Words joined as a sentence lists them: a, b and c. */
export function listOf(parts: Array<Html | string>): Html {
  const html = parts.map((p) => (p instanceof Html ? p.html : p));
  if (html.length <= 1) return raw(html.join(''));
  return raw(`${html.slice(0, -1).join(', ')} and ${html[html.length - 1]}`);
}

/** A key on the keyboard or a controller's button, as the game draws them. */
export const key = (name: string): Html => raw(`<span class="key">${name.replace(/[&<>]/g, '')}</span>`);
