// Weather and the Clock: written from its rules (`rules` below); every number from the content and the rules.

import playSource from '../../../crates/server/src/sim/mod.rs?raw';
import { FARM } from '../../content/farming';
import { CLOCK, LABOR } from '../../content/trade';
import { STORM } from '../../content/traversal';
import vehiclesSource from '../../../crates/engine/src/life/vehicles.rs?raw';
import { sailEfficiency, hourAt, rainAt } from '../../engine/life';
import { EMBERHOLM } from '../../engine/zone';
import weatherSource from '../../../crates/engine/src/life/weather.rs?raw';
import { SIM_HZ } from '../../content/tuning';
import { degrees, duration, metres, num, pct } from '../format';
import { system, table } from '../kit';
import { md, phrase, raw } from '../md';
import { sourceNumber } from '../source';

/** Every number the groups of `pattern` find in the rules' source; `what` names them for the error. */
function numbers(source: string, pattern: RegExp, what: string): number[] {
  const m = pattern.exec(source);
  const out = m ? m.slice(1).map(Number) : [];
  if (!out.length || out.some((n) => !Number.isFinite(n))) throw new Error(`the rules' source no longer says ${what} where the bible looks (${pattern})`);
  return out;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** An hour of the day, 0 to 24, as a clock shows it. */
function clockTime(hour: number) {
  const minutes = Math.round(hour * 60) % (24 * 60);
  return raw(`<span class="v">${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}</span>`);
}

const POINTS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/**
 * The compass point a heading points to. A heading is the rules' angle, from north (+Z) toward the
 * west (+X), as the zone recipes' map convention has it; a bearing turns the other way.
 */
function compass(heading: number): string {
  const bearing = (((-heading * 180) / Math.PI) % 360) + 360;
  return POINTS[Math.round(bearing / 45) % POINTS.length];
}

export const weather = system({
  id: 'weather',
  title: 'Weather and the Clock',
  summary: 'The world clock, day and night, rain and wind, and time passing while you are away.',
  icon: '🌦️',
  keywords: ['rain', 'wind', 'day', 'night', 'time', 'hour', 'sun', 'storm', 'offline', 'away', 'clock', 'shower'],
  rules: ['crates/engine/src/life/weather.rs', 'crates/engine/src/life/mod.rs', 'crates/server/src/sim/mod.rs'],
  content: ['shared/trade.json#clock', 'shared/farming.json#rain', 'shared/regions/*.json#sky'],
  body: () => {
    const sky = EMBERHOLM.sky;
    const rain = FARM.rain;
    // Showers come one to a slot (weather.rs): a shower and a gap, on average, starting up to the jitter into it.
    const slot = (rain.lastsSeconds[0] + rain.lastsSeconds[1]) / 2 + (rain.gapSeconds[0] + rain.gapSeconds[1]) / 2;
    const jitter = Math.max(0, (rain.gapSeconds[1] - rain.gapSeconds[0] - (rain.lastsSeconds[1] - rain.lastsSeconds[0])) / 2);
    // The first showers on a new island's clock, as the rules work them out.
    const showers: Array<{ start: number; end: number }> = [];
    for (let at = rainAt(0).next, i = 0; i < 5; i++) {
      const s = rainAt(at + 1e-3);
      showers.push({ start: s.start, end: s.end });
      at = s.next;
    }
    const [dirMid, dirA, dirPa, dirB, dirPb] = numbers(
      weatherSource,
      /wind_dir = ([\d.]+) \+ ([\d.]+) \* \(c \/ ([\d.]+)\)\.js_sin\(\) \+ ([\d.]+) \* \(c \/ ([\d.]+) \+ [\d.]+\)\.js_sin\(\)/,
      'how the wind turns',
    );
    const [strMid, strA, strP] = numbers(weatherSource, /wind_speed = ([\d.]+) \+ ([\d.]+) \* \(c \/ ([\d.]+) \+ [\d.]+\)\.js_sin\(\)/, 'how the wind blows');
    const [sailBase, sailWind] = numbers(vehiclesSource, /eff \* \(([\d.]+) \+ ([\d.]+) \* wind_speed\)/, 'how much the wind’s strength fills a sail');
    const [stormBase, stormWind] = numbers(weatherSource, /k \* \(([\d.]+) \+ ([\d.]+) \* life\.weather\.wind_speed\)/, 'how the wind whips up a storm');
    // The time away is caught up as the server loads your island (load_island).
    const awayAtAll = sourceNumber(playSource, /if away > ([\d.]+) \{\s*life\.state\.clock \+= away;/, 'how long away counts as away');
    const welcome = sourceNumber(playSource, /if away > ([\d.]+) \{\s*life\.toast\(/, 'how long away earns a welcome back');
    const daylight = ((sky.sunset - sky.sunrise) / 24) * sky.dayLengthSeconds;
    const round = (x: number) => 2 * Math.PI * x;
    return md`
Your island keeps time, and the sky and the weather run on a clock everyone in the world shares. Day turns to night, showers sweep in and water the fields, and a wind wanders round the compass and fills the sails. While you are away your island's clock runs on, up to a point.

## Your Island's Clock

Your island has a clock of its own: the seconds it has run. It moves on by a step each frame of play, ${SIM_HZ} times a second, and what is yours alone counts on it: crops growing, a gathering spot coming back, a contract running out, a vehicle being repaired.

What stands in the world (your house, your farm's animals, a pack you made) counts on the land's clock instead: online the world's (the server's), the same for everyone and running whether or not you play, so the tax falls due, an animal's feed runs out and a pack goes stale while you are away. Playing alone, the world is yours and the land's clock is your island's.

## Day and Night

A whole day, sunrise to sunrise, lasts ${duration(sky.dayLengthSeconds)} of real time. The hour is worked out from a clock: online the world's own clock (the server's), so everyone in the world sees the same hour at the same moment; playing alone, your island's clock, which starts at ${clockTime(hourAt(sky, 0))} on a new island.

$$
hour = the part after the point of (clock ÷ ${num(sky.dayLengthSeconds)} + ${num(sky.startHour)} ÷ 24) × 24
$$

The sun rises at ${clockTime(sky.sunrise)} and sets at ${clockTime(sky.sunset)}, so of every day ${duration(daylight)} is daylight and ${duration(sky.dayLengthSeconds - daylight)} is night. The hour changes how the world looks and nothing else: crops grow, prices hold and creatures fight the same by night as by day.

## Rain

Showers come and go on the weather's clock, and every shower waters every field on your island while it falls: a crop in the rain grows as if it had been watered, ${pct(FARM.water.boost - 1)} faster ([[systems/farming]]). Hand-watering lasts until a plant's next stage; the rain's watering lasts as long as the rain.

- A shower lasts ${duration(rain.lastsSeconds[0])} to ${duration(rain.lastsSeconds[1])}, and the dry spell between two showers ${duration(rain.gapSeconds[0])} to ${duration(rain.gapSeconds[1])}.
- Exactly: the clock is cut into slots of ${duration(slot)}, an average shower and an average dry spell. Each slot's shower starts up to ${duration(jitter)} into it and lasts its length; where in its range each falls is drawn from the slot's number, not from anyone's dice, so the same clock always has the same rain.
- Online the rain runs on the world's clock, so it rains on everyone in the world at once. Playing alone it runs on your island's clock, and a new island's first shower comes ${duration(rain.firstAfter)} in.
- Out at sea, rain whips up a storm over deep water (below).

$$
shower k starts at ${num(rain.firstAfter)} + k × ${num(slot)} + up to ${num(jitter)} seconds
$$

The very first shower on a clock comes without the extra.

${table(
  ['Shower', 'Starts', 'Lasts', 'Then Dry For'],
  showers.map((s, i) => [
    phrase`The ${['first', 'second', 'third', 'fourth', 'fifth'][i] ?? 'next'}`,
    duration(s.start),
    duration(s.end - s.start),
    i + 1 < showers.length ? duration(showers[i + 1].start - s.end) : '',
  ]),
  [1, 2, 3],
)}

The table is a new island's first showers, playing alone, its clock counted from when it began.

## Wind

The wind is the same for everyone in the world at the same moment, and it changes smoothly: its direction swings back and forth round its middle, one long swing every ${duration(round(dirPa))} with a shorter one every ${duration(round(dirPb))} over it, and its strength rises and falls every ${duration(round(strP))}.

$$
direction = ${num(dirMid)} + ${num(dirA)} × sin(t ÷ ${num(dirPa)}) + ${num(dirB)} × sin(t ÷ ${num(dirPb)} + …), in radians
strength = ${num(strMid)} + ${num(strA)} × sin(t ÷ ${num(strP)} + …)
$$

So it blows toward the ${compass(dirMid)} on the whole (from the ${compass(dirMid + Math.PI)}), swinging as far as ${degrees(dirA + dirB)} either way, from blowing toward the ${compass(dirMid - dirA - dirB)} round to the ${compass(dirMid + dirA + dirB)}. Its strength runs from ${pct(strMid - strA)} to ${pct(strMid + strA)} of full.

What the rules do with it: a sail. A boat that sails on the wind (the throttle trims its sail) has a top speed of its own times how well its sail takes the wind at its angle, times ${num(sailBase)} + ${num(sailWind)} × the wind's strength. With the wind behind you a sail takes ${pct(sailEfficiency(0), 0)} of it; with the wind in your face, only ${pct(sailEfficiency(Math.PI), 0)}. [[systems/vehicles]] has the rest of sailing.

${table(
  ['Wind', 'Behind You', '45° Off Behind', 'Across', '45° Off Ahead', 'In Your Face'],
  [['The sail takes', ...[0, 0.25, 0.5, 0.75, 1].map((k) => pct(sailEfficiency(Math.PI * k), 0))]],
  [1, 2, 3, 4, 5],
)}

## Storms at Sea

While it rains, the sea over deep water gets rough: not at all where it is shallower than ${metres(STORM.fromDepth)}, rising to a full storm where it is ${metres(STORM.fullDepth)} deep or more, and fiercer the stronger the wind. A storm buffets small boats and breaks up their hulls; [[systems/vehicles]] says how fast.

$$
depth share = (depth − ${metres(STORM.fromDepth)}) ÷ (${metres(STORM.fullDepth)} − ${metres(STORM.fromDepth)}), from 0 to 1
storm = depth share × (${num(stormBase)} + ${num(stormWind)} × the wind's strength)
$$

## Time Away

When you come back to your island (online, when the server loads it as you join; playing alone, when the game loads it), the time since you left is caught up at once: up to ${duration(CLOCK.maxOfflineSeconds)} of it, counted at ${pct(CLOCK.offlineFactor, 0)} of its length. Away for less than ${duration(awayAtAll)}, nothing happens.

- Your island's clock moves on by that much, and everything that waits on it with it: gathering spots come back, contracts run out. (The tax, an animal's feed and a pack's age wait on the land's clock, which never stopped.)
- Every crop grows by that much, at the pace it had when you left (watered or not), and wakes unwatered. Rain while you were away doesn't count.
- Every animal grows and gives for as much of that time as it was fed for ([[systems/livestock]]).
- Labor comes back at ${LABOR.offlinePerMinute} a minute, rather than the ${LABOR.perMinute} it does while you play ([[systems/economy]]).
- Away for more than ${duration(welcome)}, you are told how long has passed on ${EMBERHOLM.name}.

The sky and the weather don't need catching up: they run on the world's clock, which never stopped.
`;
  },
});
