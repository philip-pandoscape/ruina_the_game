// Swimming and Gliding: written from its rules (`rules` below); every number from the content and the rules.

import { CARRY } from '../../content/trade';
import { GLIDE, GROUND, RIDE_CAMERA, SWIM } from '../../content/traversal';
import { GLIDERS } from '../../content/vehicles';
import traverseSource from '../../../crates/engine/src/open/traverse.rs?raw';
import { EMBERHOLM } from '../../engine/zone';
import { SIM_HZ } from '../../content/tuning';
import { accel, duration, frames, key, metres, num, pct, speed, speedKmh, turnRate } from '../format';
import { system, table } from '../kit';
import { link, md, phrase, raw } from '../md';
import { sourceNumber } from '../source';
import { nearestPlace } from '../things/refs';

/** Every number the groups of `pattern` find in the rules' source; `what` names them for the error. */
function numbers(source: string, pattern: RegExp, what: string): number[] {
  const m = pattern.exec(source);
  const out = m ? m.slice(1).map(Number) : [];
  if (!out.length || out.some((n) => !Number.isFinite(n))) throw new Error(`the rules' source no longer says ${what} where the bible looks (${pattern})`);
  return out;
}

export const swimmingAndGliding = system({
  id: 'swimming-gliding',
  title: 'Swimming and Gliding',
  summary: 'Wading, swimming and climbing out of the water; opening a glider, its flight, dives, flares, gusts and rising air.',
  icon: '🪁',
  keywords: ['glider', 'gliders', 'glide', 'swim', 'swimming', 'water', 'flight', 'fly', 'updraft', 'wade', 'dive', 'flare', 'gust', 'stall'],
  rules: ['crates/engine/src/open/traverse.rs', 'src/main.ts'],
  content: [
    'shared/traversal.json#swim',
    'shared/traversal.json#glide',
    'shared/traversal.json#camera',
    'shared/vehicles.json#gliders',
    'shared/regions/*.json#updrafts',
  ],
  body: () => {
    const keep = sourceNumber(
      traverseSource,
      /p\.vel\.x \*= ([\d.]+);\s*p\.vel\.z \*= [\d.]+;\s*p\.events\.push\(Event::Splash/,
      'how much speed you keep going into the water',
    );
    const bob = sourceNumber(traverseSource, /\(p\.mode_frame as f64 \* [\d.]+\)\.js_sin\(\) \* ([\d.]+)/, 'how far a swimmer bobs');
    const standOut = sourceNumber(traverseSource, /hf\.water - under < sw\.depth - ([\d.]+) \{/, 'how shallow the water is where you stand up');
    const lookAhead = sourceNumber(
      traverseSource,
      /let ax = p\.pos\.x \+ p\.facing\.js_sin\(\) \* ([\d.]+);/,
      'how far ahead an edge to climb out on is looked for',
    );
    const [below, above] = numbers(traverseSource, /ahead > hf\.water - ([\d.]+) && ahead < hf\.water \+ ([\d.]+)/, 'how high an edge you can climb out on');
    const outForward = sourceNumber(traverseSource, /p\.vel\.x = p\.facing\.js_sin\(\) \* ([\d.]+);/, 'how fast you climb out forward');
    const faceFrom = sourceNumber(
      traverseSource,
      /if hs > ([\d.]+) \{\s*p\.facing = p\.vel\.x\.js_atan2/,
      'how fast you must be going to face it as the wing opens',
    );
    const steerFrom = sourceNumber(traverseSource, /if mag > ([\d.]+) \{\s*let want = a\.move_x\.js_atan2/, 'how far you push the stick before a glider turns');
    const stallK = sourceNumber(traverseSource, /vy -= \(g\.stall_speed - p\.airspeed\) \* ([\d.]+);/, 'how fast a stalled glider drops');
    const gravity = sourceNumber(traverseSource, /\/ dt \/ ([\d.]+)\) \* g\.zoom_lift/, 'gravity, in the zoom climb');
    const fade = sourceNumber(traverseSource, /\(\(u\.top - y\) \/ ([\d.]+)\)\.min\(1\.0\)/, 'how far below its top rising air fades');
    const spire = EMBERHOLM.terrain.mountains.find((m) => m.id === 'windspire') ?? EMBERHOLM.terrain.mountains[0];
    const from = spire?.top ?? 0;
    return md`
Water and air are the two ways off Emberholm's paths. Deep water floats you and you swim; from any height a glider turns a fall into a flight, and rising air at the foot of the Windspire carries you back up.

## Wading

Where the water over your feet is deeper than ${metres(GROUND.wadeDepth)} you wade, at ${pct(GROUND.wadeSpeed)} of your speed ([[systems/moving]]). It is how deep your feet are that counts, not the seabed: up on a pier you walk as usual.

## Swimming

Where the water is deeper than ${metres(SWIM.depth)} over the seabed you sink into it until your feet are ${metres(SWIM.float)} under the surface, and then you swim. Going in folds an open glider and splashes away all but ${pct(keep)} of your speed; your jumps are yours again.

- You stay at the surface, bobbing ${metres(bob)} up and down. Nobody dives.
- You swim at ${speedKmh(SWIM.speed)} at a full push, or ${speedKmh(SWIM.sprintSpeed)} holding sprint, in proportion to how far you push. Your speed moves toward that at ${accel(SWIM.accel)}, and you turn toward where you push at up to ${turnRate(SWIM.turnSpeed)}.
- A pack on your back doesn't sink you, but you swim at ${pct(CARRY.swimFactor)} of the speed with one.
- Where the water under you is less than ${metres(SWIM.depth - standOut)} deep, you stand up and walk out.
- At an edge (a pier, a steep bank) press jump to haul yourself out: if there is something to stand on ${metres(lookAhead)} ahead of you, no lower than ${metres(below)} under the surface and no higher than ${metres(above)} over it, you spring up at ${speed(SWIM.climbOut)} and forward at ${speed(outForward)}. That counts as your jump from the ground, so the jump in the air is still yours.

Out at sea the water is deep, and rough in the rain: boats and storms are on [[systems/vehicles]].

## Opening a Glider

A glider is a wing you carry, and opening it is a jump: with both your jumps spent, press jump once more (or press the glider key at any time in the air). It opens only if, in this order:

1. you have a glider (see ${link('gliders', 'the gliders')});
2. you aren't carrying a trade pack, which is too heavy to glide with;
3. you are off the ground;
4. you aren't busy swinging, casting, dodging or the like;
5. you are at least the glider's own lowest height above whatever is under you, the sea counting as a floor.

As it opens, your airspeed starts at your speed across the ground, or the glider's flare speed if that is more, and if you were going faster than ${speed(faceFrom)} you face the way you were going.

## Flying

You steer by pushing the stick where you want to go: the glider turns toward it at up to its turn rate (in proportion to how far off your heading it is, and to your push), and banks into the turn as far as ${raw(`<span class="v">${Math.round((GLIDE.maxBank * 180) / Math.PI)}°</span>`)}. A push under ${pct(steerFrom)} of the way doesn't steer. You always fly the way you face, at your airspeed.

How you hold the wing sets your speed and how fast you sink: hold sprint to **dive** (faster, sinking fast), crouch to **flare** (slow, barely sinking), or neither to **cruise**.

${table(
  ['Glider', 'Attitude', 'Airspeed', 'Sinks', 'Forward per Metre Sunk', 'From the Windspire’s Top'],
  GLIDERS.flatMap((g) =>
    (
      [
        ['Cruise', g.cruiseSpeed, g.sink],
        ['Dive', g.diveSpeed, g.diveSink],
        ['Flare', g.flareSpeed, g.flareSink],
      ] as Array<[string, number, number]>
    ).map(([attitude, v, s], i) => [
      i === 0 ? link(`gliders/${g.id}`, g.name) : '',
      attitude,
      speed(v),
      speed(s),
      metres(v / s, 1),
      phrase`${metres(from * (v / s), 0)} in ${duration(from / s)}`,
    ]),
  ),
  [2, 3, 4, 5],
)}

The last column is how far each reaches in still air from the top of the [[places/windspire|Windspire]], ${metres(from)} up, at that attitude all the way.

### How the Wing Flies

Your airspeed eases toward the attitude's own, closing a share of the gap every frame, and how fast you rise or fall eases toward its sink the same way:

$$
each frame, airspeed += (the attitude's airspeed − airspeed) × k
k = 1 − e^(−ease ÷ ${SIM_HZ})
ease: ${raw(GLIDERS.map((g) => `${g.name} ${num(g.speedEase).html}`).join(', '))} a second
the climb or fall: the same, with ${num(GLIDE.verticalEase)} a second as its ease
$$

- **Zoom.** Speed you shed (flaring out of a dive) comes back as height, the way a swallow pulls up: the energy of the speed you lose turns into climb, a share of it set by the glider. So a dive and then a flare can lift you over a ridge.
- **Stall.** Below its stall speed a glider drops: for every metre a second you are under it, you sink ${speed(stallK)} faster.
- **Rising air** lifts you (below).

$$
climb from a zoom = airspeed × speed shed a second ÷ ${num(gravity)} × zoom
stall drop = ${num(stallK)} × (stall speed − airspeed)
$$

${table(
  ['Glider', 'Stalls Below', 'Opens Above', 'Turns', 'Zoom'],
  GLIDERS.map((g) => [link(`gliders/${g.id}`, g.name), speed(g.stallSpeed), metres(g.minHeight), turnRate(g.turnRate), pct(g.zoomLift)]),
  [1, 2, 3, 4],
)}

### Gust

Pressing ${key('F')} in flight is the wing's gust, if it has one and has recovered: your airspeed jumps up by the gust's speed, you climb at once at the gust's lift (on top of any climb you already had), and the wing needs time to recover before the next. It recovers whether you are flying or not.

${table(
  ['Glider', 'Speed', 'Lift', 'Recovers In'],
  GLIDERS.map((g) => [
    link(`gliders/${g.id}`, g.name),
    g.gust ? phrase`+${speed(g.gust.speed)}` : 'No gust',
    g.gust ? phrase`+${speed(g.gust.lift)}` : '',
    g.gust ? duration(g.gust.cooldownSeconds) : '',
  ]),
  [1, 2, 3],
)}

## Folding and Landing

- Press jump again to fold the wing and drop. Only a fresh press does it, and not in the first ${frames(GLIDE.openFrames)}, so the press that opened it can't fold it again. Folding in the air leaves you the jump in the air once more, and another press after that opens the wing again.
- Touch the ground and the wing folds; you land keeping ${pct(GLIDE.landKeep)} of your speed across the ground.
- Touch the water and it folds, and you swim.
- Fly into a wall you can't slide along and it folds, and you drop.
- A trade pack can't be picked up while you glide.

## Rising Air

Columns of rising air lift a glider inside them: strongest at the core, fading toward the edge, and fading again over the last ${metres(fade)} below the column's top, above which there is none.

$$
lift = strength × (1 − (distance from the core ÷ radius)²) × fade
fade = the smaller of 1 and (top − your height) ÷ ${num(fade)}
$$

${table(
  ['Where', 'Radius', 'Top', 'Strength at the Core'],
  EMBERHOLM.updrafts.map((u) => [link(`places/${nearestPlace(u.x, u.z).id}`), metres(u.r), metres(u.top), phrase`${speed(u.strength)} up`]),
  [1, 2, 3],
)}

Lift adds to how fast you rise, after the attitude's sink, so in the core of the column a cruising ${GLIDERS[0]?.name ?? 'glider'} climbs at about ${speed((EMBERHOLM.updrafts[0]?.strength ?? 0) - (GLIDERS[0]?.sink ?? 0))}.

## The Camera While You Travel

Gliding, the camera hangs ${metres(RIDE_CAMERA.glideDistance)} behind you; riding a mount or driving, ${metres(RIDE_CAMERA.rideDistance)}; in a boat ${metres(RIDE_CAMERA.boatDistance)}, or further back for a long ship. Leave the camera alone for ${duration(RIDE_CAMERA.autoDelay)} while you move and it swings round behind you on its own, closing ${pct(1 - Math.exp(-RIDE_CAMERA.autoFollow))} of the gap in a second. The camera is only how you see: none of the rules above look at it.
`;
  },
});
