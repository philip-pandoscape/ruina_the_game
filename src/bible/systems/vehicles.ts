// Vehicles and the Shipyard: written from its rules (`rules` below); every number from the content and the rules.

import { ITEMS, VENDORS } from '../../content/items';
import { SHIP_DESIGNS } from '../../content/shipyard';
import { packDef } from '../../content/trade';
import { GROUND, STORM } from '../../content/traversal';
import { type BoatDef, isBoat, MOUNTS, VEHICLES, type WheeledDef } from '../../content/vehicles';
import { sailEfficiency } from '../../sim/life/vehicles';
import { EMBERHOLM } from '../../sim/zone/world';
import { MOVE } from '../../content/tuning';
import { coins, count, degrees, duration, listOf, metres, num, pct, slopeDegrees, speed, speedKmh, times, turnRate } from '../format';
import { join, system, table } from '../kit';
import { link, md, phrase, raw } from '../md';
import { rustConst } from '../source';
import vehiclesSource from '../../sim/life/vehicles.ts?raw';
import interactSource from '../../sim/life/interact.ts?raw';
import weatherSource from '../../sim/life/weather.ts?raw';
import playSource from '../../../crates/server/src/play/mod.rs?raw';

/** The numbers the first groups of `pattern` find in the rules' source: throws when the source has changed shape. */
function nums(source: string, pattern: RegExp, what: string): number[] {
  const m = pattern.exec(source);
  const out = m ? m.slice(1).map(Number) : [];
  if (!out.length || out.some((n) => !Number.isFinite(n))) throw new Error(`the rules' source no longer says ${what} where the bible looks (${pattern})`);
  return out;
}
const one = (source: string, pattern: RegExp, what: string): number => nums(source, pattern, what)[0];
const N = String.raw`(\d+(?:\.\d+)?)`;
const re = (s: string): RegExp => new RegExp(s.replace(/\{N\}/g, N));

/** Every number the vehicle rules keep in their source, read as the page is drawn. */
const rule = () => {
  const v = vehiclesSource;
  const [g1, g2] = nums(v, re(String.raw`const G = {N} \* {N};`), 'the pull of gravity on a vehicle in the air');
  const [hardFrom, , perMs] = nums(
    v,
    re(String.raw`v\.vy < -{N}\) v\.hp = Math\.max\({N}, v\.hp - \(-v\.vy - \d+(?:\.\d+)?\) \* {N}\)`),
    'what a hard landing costs',
  );
  const [overRate, overFlat] = nums(v, re(String.raw`\(Math\.abs\(vf\) - cap\) \* {N} \* dt \+ {N} \* dt`), 'how fast a vehicle sheds speed over its cap');
  const [gravity, slopeShare] = nums(v, re(String.raw`vf -= {N} \* \(g\.x \* fx \+ g\.z \* fz\) \* dt \* {N};`), 'how slopes pull a vehicle');
  const [fullAt, topLoss] = nums(v, re(String.raw`clamp\(Math\.abs\(vf\) \/ {N}, 0, 1\) \* \(1 - {N} \*`), 'how steering grows and fades with speed');
  const [windBase, windShare] = nums(v, re(String.raw`eff \* \({N} \+ {N} \* w\.windSpeed\)`), 'how the wind fills a sail');
  const [sailA, sailB, , , sailPow] = nums(
    v,
    re(String.raw`return {N} \+ {N} \* Math\.pow\({N} \+ {N} \* Math\.cos\(rel\), {N}\);`),
    'how much of the wind a sail can use',
  );
  const [floatFrom, floatMore] = nums(v, re(String.raw`Math\.cos\(a\) \* \({N} \+ life\.rand\(\) \* {N}\)`), 'where lost cargo floats');
  const [stormBase, stormShare] = nums(
    weatherSource,
    re(String.raw`return k \* \({N} \+ {N} \* life\.state\.weather\.windSpeed\)`),
    'how the wind roughens a storm',
  );
  const [windMid, windSwing] = nums(weatherSource, re(String.raw`w\.windSpeed = {N} \+ {N} \* Math\.sin`), 'how strong the wind blows');
  const [ringFrom, ringTo, ringStep] = nums(
    v,
    /for \(let dist = (\d+(?:\.\d+)?); dist <= (\d+(?:\.\d+)?); dist \+= (\d+(?:\.\d+)?)\)/,
    'how far a boat is looked for',
  );
  return {
    gravityInAir: g1 * g2,
    hardFrom,
    perMs,
    landSpots: nums(v, /for \(const dist of \[([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\]\)/, 'how far a land vehicle is looked for'),
    landTries: one(v, /for \(let k = 0; k < (\d+); k\+\+\) \{\s*const a = p\.facing/, 'how many ways round a land vehicle is looked for'),
    landWet: one(v, re(String.raw`hf\.water - hf\.height\(x, z\) > {N}\) continue`), 'how wet a land vehicle may stand'),
    landSlope: one(v, re(String.raw`hf\.slope\(x, z\) > {N}\) continue`), 'how steep a land vehicle may stand'),
    landRise: one(v, re(String.raw`Math\.abs\(hf\.height\(x, z\) - p\.pos\.y\) > {N}\) continue`), 'how far above or below you a land vehicle may stand'),
    keelRoom: one(v, re(String.raw`const need = def\.draft \+ {N};`), 'the water a summoned boat needs under her'),
    ringFrom,
    ringTo,
    ringStep,
    ringTries: one(v, /for \(let k = 0; k < (\d+); k\+\+\) \{\s*const a = \(k \//, 'how many ways round a boat is looked for'),
    sand: one(v, re(String.raw`SURFACE\.sand \? {N} : 1\)`), 'how sand slows a wheeled vehicle'),
    boostThrottle: one(v, re(String.raw`d\.boostSpeed > 0 && v\.throttle > {N}`), 'the throttle a boost needs'),
    boostAccel: one(v, re(String.raw`d\.accel \* \(boosting \? {N} : 1\)`), 'how a boost speeds you up'),
    reverseAccel: one(v, re(String.raw`vf \+ d\.accel \* {N} \* t \* dt`), 'how fast a vehicle speeds up backwards'),
    overRate,
    overFlat,
    gravity,
    slopeShare,
    handbrake: one(v, re(String.raw`d\.brake \* {N} \* dt\);`), 'how hard the handbrake brakes'),
    fullAt,
    topLoss,
    handbrakeTurn: one(v, re(String.raw`inp\.handbrake \? {N} : 1\)`), 'how the handbrake tightens a turn'),
    offroadGrip: one(v, re(String.raw`\(paved \? 1 : {N}\)`), 'how grip falls off the road'),
    throttleEase: one(v, re(String.raw`v\.throttle \+= \(inp\.throttle - v\.throttle\) \* Math\.min\(1, {N} \* dt\);`), 'how quickly the throttle follows you'),
    wade: one(v, re(String.raw`moveOnLand\(sim, v, d, d\.climb, {N}\)`), 'how deep a wheeled vehicle wades'),
    ledge: one(v, re(String.raw`v\.grounded && rise > {N}\) blocked`), 'the highest ledge a vehicle drives up'),
    crest: one(v, re(String.raw`drop > {N} \+ speed \* dt`), 'when a vehicle leaves the ground over a crest'),
    bounce: one(v, re(String.raw`v\.vx -= vn \* nx \* {N};`), 'how a vehicle bounces off what it hits') - 1,
    sailRate: one(v, re(String.raw`v\.sail \+ inp\.throttle \* {N} \* dt`), 'how fast a sail goes up'),
    windBase,
    windShare,
    sailA,
    sailB,
    sailPow,
    oarEase: one(
      v,
      re(String.raw`v\.throttle \+= \(inp\.throttle - v\.throttle\) \* Math\.min\(1, {N} \* dt\);\s*target = `),
      'how quickly the oars follow you',
    ),
    fullTurnAt: one(v, re(String.raw`Math\.abs\(vf\) \/ \({N} \* d\.maxSpeed\)`), 'the speed a boat turns fully at'),
    bow: one(v, re(String.raw`d\.length \* {N} \* Math\.sign\(vf \|\| 1\)`), 'where a boat feels for the bottom'),
    aground: one(v, re(String.raw`v\.vx \*= -{N};\s*v\.vz \*= -\d+(?:\.\d+)?;\s*v\.speed = 0;`), 'how a boat stops on the bottom'),
    buffet: one(v, re(String.raw`STORM\.buffet \* storm \* dt \* {N}`), 'how hard the swell shoves'),
    floatFrom,
    floatMore,
    stormBase,
    stormShare,
    windMid,
    windSwing,
    swimDepth: one(v, re(String.raw`v\.swimming = depth > {N};`), 'how deep a mount swims'),
    swimShare: one(v, re(String.raw`if \(v\.swimming\) top \*= {N};`), 'how fast a mount swims'),
    alignMin: one(v, re(String.raw`Math\.max\({N}, Math\.cos\(angleDiff\(v\.heading`), 'how a mount speeds up while turning'),
    slowShare: one(v, re(String.raw`v\.speed - d\.accel \* {N} \* dt`), 'how fast a mount slows'),
    mountClimb: one(v, re(String.raw`GROUND\.maxSlope \* {N}, 99\)`), 'how steep a mount climbs'),
    whistle: one(v, re(String.raw`Math\.hypot\(v\.x - p\.pos\.x, v\.z - p\.pos\.z\) > {N}\)`), 'how far a mount comes from when you whistle'),
    stepOut: one(v, re(String.raw`const side = def\.width \/ 2 \+ {N};`), 'how far from the side you step out'),
    cargoBias: one(v, re(String.raw`carrying \? {N} : 0\)`), 'how a pack in your arms favours the cargo bed'),
    reach: one(interactSource, re(String.raw`distanceTo\(v, p\.pos\.x, p\.pos\.z\);\s*if \(d > {N}\) continue;`), 'how near a vehicle F reaches'),
    slipReach: one(interactSource, re(String.raw`if \(d > {N}\) continue;\s*const y = hf\.height\(sy\.x, sy\.z\);`), 'how near a slipway F reaches'),
    climbIn: rustConst(playSource, 'CLIMB_IN'),
  };
};

const wheeled = (): WheeledDef[] => VEHICLES.filter((v): v is WheeledDef => v.class === 'wheeled');
const boats = (): BoatDef[] => VEHICLES.filter(isBoat);
const deedOf = (vehicle: string): string | undefined => ITEMS.find((i) => i.vehicle === vehicle)?.id;
/** A boat's hull loss a second at full storm, by its length (the first bracket long enough). */
const stormRate = (b: BoatDef): number | undefined => STORM.hullDamage.find(([len]) => b.length <= len)?.[1];

export const vehicles = system({
  id: 'vehicles',
  title: 'Vehicles and the Shipyard',
  summary: 'Summoning, driving, sailing and riding; cargo and passengers; storms at sea; and building a ship on a slipway.',
  icon: '⛵',
  keywords: ['cart', 'boat', 'ship', 'sail', 'wind', 'drive', 'drift', 'handbrake', 'mount', 'horse', 'donkey', 'deed', 'whistle', 'storm', 'slipway', 'cargo'],
  rules: ['src/sim/life/vehicles.ts', 'src/sim/life/shipyard.ts', 'crates/engine/src/life/vehicles.rs', 'crates/engine/src/life/shipyard.rs'],
  content: ['shared/traversal.json#storm', 'shared/vehicles.json#vehicles', 'shared/vehicles.json#mounts', 'shared/shipyard.json#designs'],
  body: () => {
    const R = rule();
    const spots = R.landSpots;
    const meanWind = R.windBase + R.windShare * R.windMid;
    const angles = [0, 1, 2, 3, 4].map((k) => (k * Math.PI) / 4);
    const sailing = boats().filter((b) => b.sail);
    const design = SHIP_DESIGNS[0];
    const slip = EMBERHOLM.shipyards[0];
    const designSale = VENDORS.flatMap((v) => v.sells.map((s) => ({ v, s }))).find(({ s }) => s.item === design?.design);
    return join(
      md`
Everything you ride is a deed or a whistle in your bag: a deed summons a cart or a boat, a whistle calls a mount. You have at most one of each kind out at a time, and each is yours alone; online, other players' vehicles are solid to you, and some have a seat for you. There are ${count(
        VEHICLES.length,
        'vehicle',
      )} (${raw(VEHICLES.map((v) => link(`vehicles/${v.id}`).html).join(', '))}) and ${count(MOUNTS.length, 'mount')} (${raw(
        MOUNTS.map((m) => link(`mounts/${m.id}`).html).join(', '),
      )}); the biggest ship is built, not bought.

## Summoning and Sending Home

Use a deed from your bag, or from the Rides window (V), to summon what it stands for. You have to be on your feet on solid ground. A boat lost in a storm can't be summoned until it is repaired. If that vehicle is already out somewhere, it is sent home first, unless it has cargo aboard: then go to it.

- **On land** the vehicle appears near you, facing the way you face: the rules try ${count(
        R.landTries,
        'direction',
      )}, starting straight ahead and swinging out to either side, at ${listOf(spots.map((d) => metres(d)))} out from you (plus the vehicle's own size), and take the first spot that is level enough (no steeper than ${slopeDegrees(
        R.landSlope,
      )}), no more than ${metres(R.landWet)} under water, within ${metres(R.landRise)} of your height and clear of trees, rocks and walls. With none, there is no room here.
- **On water** a boat appears in the nearest water deep enough for her: the rules look round you in rings from ${metres(R.ringFrom)} to ${metres(R.ringTo)} out, every ${metres(
        R.ringStep,
      )}, ${count(R.ringTries, 'way')} round each ring, for water at least ${metres(
        R.keelRoom,
      )} deeper than her draft, with her bow and stern afloat too and nothing in the way. In the first ring with any, she takes the deepest, pointing out to sea. With none, go down to the shore.

The Rides window sends a vehicle home again, but only when nobody is in it and its cargo bed is empty.

## Getting In and Out

F within ${metres(R.reach)} of a vehicle's hull offers the nearest of its driver's seat and its cargo slots (with a pack in your arms, a cargo slot counts as ${metres(
        R.cargoBias,
      )} nearer, since you came to load it). You always take the driver's seat of your own vehicle.

- With a pack on your back you can't drive a cart or row a boat: load the pack into it first. A mount carries you with a pack only if it is a pack animal; the others refuse.
- Getting out, you step off on the left, ${metres(R.stepOut)} clear of its side; failing that the right, then the front, then the back: the first with dry ground and room. With none, you get out on the left anyway, swimming if that is water.
- Leave a boat and her sail comes down and her oars stop: she drifts to a stop. A wheeled vehicle nobody drives brakes to a stop.

## Riding Along

Online, another player's vehicle with more than one seat has room for passengers: every seat but the driver's. Walk up to it with your hands free (no pack, on your feet or swimming) and F rides along; the server sits you in the free seat nearest you, if you are within ${metres(
        R.climbIn,
      )} of its hull. You go where its driver goes. F gets you out beside it, and if its owner sends it home or leaves, you step off where you are.

## Cargo

Packs ride in a vehicle's cargo slots: F at the cargo bed loads the pack on your back into the first free slot, or takes one out onto your back. Packs aboard go wherever the vehicle goes, and a vehicle with cargo aboard can't be sent home or summoned anew (see [[systems/trade]] for packs).

## On Wheels

A cart or a car keeps its own velocity and only grips the road sideways, so it can slide.
`,
      table(
        ['Vehicle', 'Top Speed', 'Boost', 'Off the Road', 'Backing', 'Speeds Up', 'Brakes', 'Packs', 'Seats'],
        wheeled().map((v) => [
          link(`vehicles/${v.id}`),
          speedKmh(v.maxSpeed),
          v.boostSpeed ? speed(v.boostSpeed) : '',
          pct(v.offroad),
          speed(v.reverseSpeed),
          phrase`${num(v.accel)} m/s²`,
          phrase`${num(v.brake)} m/s²`,
          v.cargo.length,
          v.seats.length,
        ]),
        [1, 2, 3, 4, 5, 6, 7, 8],
      ),
      md`
**Speed.** The throttle follows your keys within a moment: it closes the gap to them at a rate of ${num(R.throttleEase)} a second. Each second, pushing forward adds the vehicle's acceleration times the throttle, until its top speed here; pulling back brakes at its braking rate, then reverses at ${pct(
        R.reverseAccel,
      )} of its acceleration up to its backing speed. Whatever you do, rolling resistance and drag take speed away. The top speed depends on what is under the wheels: the full top speed on the road and the plaza, a share of it anywhere else, less again on sand. Going faster than that (down a hill, or off the road at speed), a vehicle sheds the excess quickly.

$$
top speed here = top speed × off-road share (off the road) × ${times(R.sand)} (on sand)
speed gained a second = acceleration × throttle, up to the top speed here
speed lost a second = rolling + drag × speed
over the top speed, lost a second = ${num(R.overRate)} × the excess + ${num(R.overFlat)} m/s
$$

**Boost.** Shift, in a vehicle that has one, with the throttle over ${pct(R.boostThrottle)}: it accelerates ${times(R.boostAccel)} as hard, up to its boost speed instead.

**Slopes.** A hill pulls the vehicle down it: ${speed(R.gravity)} a second for every metre of rise in a metre of run, times ${num(
        R.slopeShare,
      )}. Climbing is limited: rising ground steeper than the vehicle's climb is a wall, and so is any ledge more than ${metres(
        R.ledge,
      )} high. Water deeper than ${metres(R.wade)} is a wall too. Driving into a wall loses the speed going into it and slides along it.

**Steering.** The wheel turns the vehicle at its full-lock turn rate, scaled by speed: no turn at a standstill, full turn from ${speed(R.fullAt)}, easing off to ${pct(
        1 - R.topLoss,
      )} of it at top speed. Backing up, it turns the other way.

$$
turn a second = full lock × min(1, speed ÷ ${speed(R.fullAt)}) × (1 − ${num(R.topLoss)} × speed ÷ top speed)
sideways speed after t seconds = sideways speed × e^(−grip × t)
$$

**Grip and drift.** Any sideways slide dies away at the vehicle's grip, ${pct(R.offroadGrip)} of it off the road. The handbrake (Space) brakes at ${pct(
        R.handbrake,
      )} of its braking rate, tightens the turn ${times(R.handbrakeTurn)}, and swaps the grip for the much lower drift grip: throw it mid-turn and the back steps out.
`,
      table(
        ['Vehicle', 'Full Lock', 'Grip', 'Drift Grip', 'Climbs', 'Rolling', 'Drag', 'Hull'],
        wheeled().map((v) => [
          link(`vehicles/${v.id}`),
          turnRate(v.turnRate),
          v.grip,
          v.driftGrip,
          slopeDegrees(v.climb),
          phrase`${num(v.rolling)} m/s²`,
          v.drag,
          v.hp,
        ]),
        [1, 2, 3, 4, 5, 6, 7],
      ),
      md`
**Crests and landings.** On the ground a vehicle follows it; where the ground drops away faster than it can follow (more than ${metres(
        R.crest,
      )} plus the step it travels), it leaves the ground and falls at ${phrase`${num(R.gravityInAir)} m/s²`}. Landing faster than ${speed(R.hardFrom)} costs the hull ${num(R.perMs)} hit points for every m/s over, but never its last hit point.

**Knocks.** A vehicle hitting a tree, a rock or a wall is pushed out of it and loses the speed it had into it, bouncing back with ${pct(R.bounce)} of it. You bump into vehicles you aren't riding, yours and, online, everyone else's.

## Boats

A boat sits in the water at its draft: where the water under her hull, or under her bow (${pct(
        R.bow,
      )} of her length ahead, the way she is going), is shallower than that, she runs aground, stops dead and bounces back with ${pct(
        R.aground,
      )} of her speed. Piers are solid to boats.
`,
      table(
        ['Boat', 'Top Speed', 'Driven By', 'Draft', 'Turns', 'Turns at Rest', 'Speeds Up', 'Packs', 'Seats', 'Hull'],
        boats().map((b) => [
          link(`vehicles/${b.id}`),
          speedKmh(b.maxSpeed),
          b.sail ? 'Sail' : 'Oars',
          metres(b.draft),
          turnRate(b.turnRate),
          turnRate(b.turnAtRest),
          phrase`${num(b.accel)} m/s²`,
          b.cargo.length,
          b.seats.length,
          b.hp,
        ]),
        [1, 3, 4, 5, 6, 7, 8, 9],
      ),
      md`
**Oars.** W and S pull and back water: the oars follow your keys, closing the gap at a rate of ${num(R.oarEase)} a second, and the boat makes for the throttle's share of her top speed (backing, of her backing speed). She speeds up at her acceleration and slows at her braking rate plus her drag times her speed.

**Sails.** A sailing boat's throttle is her sail: W raises it and S lowers it, ${pct(R.sailRate)} of the way a second, and it stays where you leave it. What the sail gives depends on the wind: on how far off her stern it blows, and on how hard. Wind straight behind gives everything; wind dead ahead still gives ${pct(
        R.sailA,
      )}. The wind wanders round the compass and rises and falls through the day ([[systems/weather]]); its strength runs from ${num(R.windMid - R.windSwing)} to ${num(R.windMid + R.windSwing)}.

$$
target speed = sail × top speed × wind share × (${num(R.windBase)} + ${num(R.windShare)} × wind strength)
wind share = ${num(R.sailA)} + ${num(R.sailB)} × (½ + ½ cos angle)^${num(R.sailPow)}
$$
`,
      table(
        ['Wind From', 'Off the Stern', 'Wind Share', ...sailing.map((b) => `${b.name}, Full Sail`)],
        angles.map((a, i) => [
          ['Dead astern', 'On the quarter', 'Abeam', 'Close to the wind', 'Dead ahead'][i],
          degrees(a),
          pct(sailEfficiency(a)),
          ...sailing.map((b) => speed(b.maxSpeed * sailEfficiency(a) * meanWind)),
        ]),
        [1, 2, ...sailing.map((_, i) => i + 3)],
      ),
      md`
The speeds are at the wind's middle strength. **Turning:** a boat turns at her turn-at-rest rate when still (oars can spin a rowboat; a cog barely moves) and gains her full turn rate by ${pct(
        R.fullTurnAt,
      )} of her top speed.

$$
turn a second = turn at rest + (turn rate − turn at rest) × min(1, speed ÷ (${num(R.fullTurnAt)} × top speed))
$$

## Storms at Sea

In the rain, open water turns rough. How rough depends on how deep the water is under the boat and on the wind: calm where it is shallower than ${metres(
        STORM.fromDepth,
      )}, a full storm from ${metres(STORM.fullDepth)}.

$$
depth share = (depth − ${metres(STORM.fromDepth)}) ÷ (${metres(STORM.fullDepth)} − ${metres(STORM.fromDepth)}), between 0 and 1
storm = depth share × (${num(R.stormBase)} + ${num(R.stormShare)} × wind strength), only while it rains
hull lost a second = the rate for her length × storm
$$

The swell also shoves the boat sideways at random, up to ${phrase`${num((STORM.buffet * R.buffet) / 2)} m/s²`} either way in a full storm. Small boats suffer most:
`,
      table(
        ['Boats Up To', 'Hull Lost a Second', 'Boat', 'Hull', 'Lasts in a Full Storm'],
        boats().map((b) => {
          const rate = stormRate(b) ?? 0;
          const bracket = STORM.hullDamage.find(([len]) => b.length <= len);
          return [bracket ? metres(bracket[0]) : '', rate, link(`vehicles/${b.id}`), b.hp, rate ? duration(b.hp / rate) : ''];
        }),
        [0, 1, 3, 4],
      ),
      md`
A boat whose hull runs out breaks up: you are in the water, her packs float where she went down (${metres(R.floatFrom)} to ${metres(
        R.floatFrom + R.floatMore,
      )} from her), and she can't be summoned for ${duration(STORM.repairSeconds)} while she is repaired. Make for shallower water when the sea turns.

## Mounts

A mount moves like you do, faster, and turns its whole body: it turns toward the stick at its turn rate, and its speed builds along the way it faces (at least ${pct(
        R.alignMin,
      )} of it while turning hard). A light push walks it at up to its walk speed (full walk speed at ${pct(
        MOVE.runThreshold,
      )} of the stick); further runs it; Shift gallops. It speeds up at its acceleration and slows ${times(R.slowShare)} as fast. Space jumps.
`,
      table(
        ['Mount', 'Walk', 'Run', 'Gallop', 'With a Pack', 'Jump', 'Turns', 'Speeds Up', 'Packs'],
        MOUNTS.map((m) => [
          link(`mounts/${m.id}`),
          speed(m.walkSpeed),
          speed(m.runSpeed),
          speedKmh(m.gallopSpeed),
          m.canCarryPack ? speed(m.packSpeed) : 'Won’t carry one',
          phrase`${speed(m.jump)} up`,
          turnRate(m.turnRate),
          phrase`${num(m.accel)} m/s²`,
          m.cargo.length,
        ]),
        [1, 2, 3, 5, 6, 7, 8],
      ),
      md`
- **Packs.** Only a pack animal carries you with a pack on your back, and then no faster than its pack speed, and it won't gallop. A pack in its own saddle slot doesn't slow it.
- **Water.** In water deeper than ${metres(R.swimDepth)} it swims at ${pct(R.swimShare)} of its speed and can't jump.
- **Hills.** It climbs slopes up to ${slopeDegrees(GROUND.maxSlope * R.mountClimb)}, a little short of the steepest you can walk.
- **Calling it.** R gets you on your mount, or off it. With no mount out, it appears where you stand; one out but more than ${metres(
        R.whistle,
      )} away comes to you, cargo and all, and one nearer than that takes you straight onto its back where it stands. With several whistles R calls the fastest, or with a pack on your back the fastest that will carry it.

## The Shipyard

Big ships aren't bought: they are built on a slipway, stage by stage, as a house is. ${
        design && designSale
          ? phrase`${link(`npcs/${designSale.v.npc}`)} sells the ${link(`items/${design.design}`)} for ${coins(designSale.s.price)}${
              designSale.s.seals ? phrase` and ${count(designSale.s.seals, 'Charter Seal')}` : ''
            }. `
          : ''
      }Take it to the ${slip ? slip.name : 'slipway'} by [[places/docks]]: within ${metres(R.slipReach)} of the slip, F lays her keel and the design leaves your bag.

1. Each stage wants its material packs: carry one to the slip and F delivers it, if the stage still wants it.
2. When every pack is in, F builds the stage for its labor, and the hull rises.
3. After the last stage, F launches her: the slip clears and her deed goes into your bag (make room for it first). Summon her in water deep enough for her draft.

A slipway holds one ship at a time.
`,
      ...SHIP_DESIGNS.map((d) =>
        join(
          md`### ${link(`ships/${d.id}`)}`,
          table(
            ['Stage', 'What It Is', 'Haul to the Slip', 'Labor'],
            d.stages.map((s) => [
              s.name,
              s.desc,
              raw(
                Object.entries(s.needs)
                  .map(([p, n]) => phrase`${n} × ${link(`packs/${p}`, packDef(p).name)}`.html)
                  .join('<br>'),
              ),
              s.labor,
            ]),
            [3],
          ),
          deedOf(d.vehicle) ? md`Launched, she is the ${link(`vehicles/${d.vehicle}`)}.` : null,
        ),
      ),
    );
  },
});
