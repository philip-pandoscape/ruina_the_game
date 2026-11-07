// Moving and Climbing: written from its rules (`rules` below); every number from the content and the rules.

import { ARCH_HALF, DOOR_HALF, MODULE, STAIR, STOREY, WALL } from '../../content/buildings';
import { CARRY } from '../../content/trade';
import { GROUND } from '../../content/traversal';
import inputSource from '../../input/input.ts?raw';
import playerSource from '../../../crates/engine/src/player.rs?raw';
import traverseSource from '../../../crates/engine/src/open/traverse.rs?raw';
import buildingsSource from '../../../crates/engine/src/open/buildings.rs?raw';
import zoneSource from '../../../crates/engine/src/open/zone.rs?raw';
import { EMBERHOLM } from '../../engine/zone';
import { ATTACK, JUMP, MOVE, MOVEMENT_SKILLS, SIM_HZ, STEP } from '../../content/tuning';
import { accel, count, duration, frames, metres, num, pct, slopeDegrees, speed, speedKmh, turnRate } from '../format';
import { system, table } from '../kit';
import { link, md, phrase } from '../md';
import { rustConst, sourceNumber, tsConst } from '../source';

/** How high a jump at `v` takes you, and how long it rises, under gravity `g`. */
const rise = (v: number, g: number) => ({ height: (v * v) / (2 * g), time: v / g });

export const movingAndClimbing = system({
  id: 'moving',
  title: 'Moving and Climbing',
  summary: 'Walking, running, sprinting, jumping, sliding and crouching; slopes, steps, ledges, decks and stairs.',
  icon: '🏃',
  keywords: ['walk', 'run', 'sprint', 'jump', 'double jump', 'slide', 'crouch', 'climb', 'slope', 'stairs', 'step', 'speed', 'fall'],
  rules: [
    'crates/engine/src/player.rs',
    'crates/engine/src/open/traverse.rs',
    'crates/engine/src/open/colliders.rs',
    'crates/engine/src/open/buildings.rs',
    'crates/engine/src/open/zone.rs',
    'src/input/input.ts',
  ],
  content: [
    'shared/tuning.json#simHz',
    'shared/tuning.json#move',
    'shared/tuning.json#jump',
    'shared/tuning.json#attack',
    'shared/tuning.json#movementSkills',
    'shared/traversal.json#ground',
    'shared/trade.json#carry',
  ],
  body: () => {
    const dead = sourceNumber(playerSource, /if mag < ([\d.]+) \{\s*return \(0\.0, 0\.0, 0\.0\);/, 'the stick’s dead zone');
    const airTurn = sourceNumber(playerSource, /dx\.js_atan2\(dz\), ([\d.]+) \* step_len\(\)\)/, 'how fast you steer a fast jump');
    const crouchSlide = tsConst(inputSource, 'CROUCH_SLIDE_SPEED');
    const snapK = sourceNumber(traverseSource, /speed \* dt \* gr\.max_slope \* ([\d.]+)/, 'how far the ground may drop away under you');
    const steepExtra = sourceNumber(traverseSource, /gr\.max_slope \+ ([\d.]+) \{/, 'how steep ground is before you slide off it');
    const head = rustConst(buildingsSource, 'HEAD');
    const rail = sourceNumber(buildingsSource, /rail_top = floor \+ STOREY \+ ([\d.]+)/, 'how high a stairwell’s rail is');
    const furnitureLow = sourceNumber(buildingsSource, /js_min\(HEAD, js_max\(([\d.]+), def\.h\)\)/, 'the lowest an upstairs piece of furniture is');
    const edgeMargin = sourceNumber(zoneSource, /terrain\.size\(\) \/ 2\.0 - ([\d.]+);/, 'how far in from its edge the world ends');
    const slide = MOVEMENT_SKILLS.find((m) => m.id === 'slide');
    const sa = slide?.action;
    const jump = rise(JUMP.velocity, JUMP.gravityUp);
    const double = rise(JUMP.doubleJumpVelocity, JUMP.gravityUp);
    const packed = rise(JUMP.velocity * CARRY.jumpFactor, JUMP.gravityUp);
    const hop = rise(JUMP.velocity * JUMP.shortHopCut, JUMP.gravityUp);
    const snap = (v: number) => GROUND.snapDown + v * STEP * GROUND.maxSlope * snapK;
    const size = EMBERHOLM.terrain.cells * EMBERHOLM.terrain.cell;
    return md`
On foot you are quick and light: you walk, run and sprint, crouch and slide, jump and jump again in the air, and climb anything that isn't too steep. The rules move you ${SIM_HZ} times a second (each of those steps is a *frame*), the same in your browser as on the server, which has the last word online. To the rules you are a round body ${metres(MOVE.playerRadius * 2)} across.

## Walking, Running and Sprinting

How far you push the stick sets your pace; a key is a full push. A push of less than ${pct(dead)} of the way is no push at all.

${table(
  ['Pace', 'How', 'Speed'],
  [
    ['Walk', phrase`Push less than ${pct(MOVE.runThreshold)} of the way: the further, the faster`, phrase`up to ${speedKmh(MOVE.walkSpeed)}`],
    ['Run', phrase`Push ${pct(MOVE.runThreshold)} of the way or more`, speedKmh(MOVE.runSpeed)],
    ['Sprint', 'Hold sprint while you run, on the ground, without a pack', speedKmh(MOVE.sprintSpeed)],
    ['Crouch', 'Hold crouch, on the ground', phrase`up to ${speedKmh(MOVE.crouchSpeed)}`],
    ['Carrying a pack', phrase`Any pace but a sprint, at ${pct(CARRY.speedFactor)} of its speed`, phrase`up to ${speedKmh(MOVE.runSpeed * CARRY.speedFactor)}`],
  ],
)}

$$
walking speed = ${speed(MOVE.walkSpeed)} × push ÷ ${num(MOVE.runThreshold)}
crouching speed = ${speed(MOVE.crouchSpeed)} × the smaller of 1 and push ÷ ${num(MOVE.runThreshold)}
$$

Your speed doesn't change at once. On the ground it moves toward the pace you ask for by ${speed(MOVE.groundAccel)} every second (${speed(MOVE.sprintAccel)} when sprinting), and toward a standstill by ${speed(MOVE.groundDecel)} every second when you let go. So a run is reached in ${duration(MOVE.runSpeed / MOVE.groundAccel)}, a sprint in ${duration(MOVE.sprintSpeed / MOVE.sprintAccel)}, and a run stops in ${duration(MOVE.runSpeed / MOVE.groundDecel)}. The change is to your whole velocity, so turning round at a run takes about as long as stopping and starting again. You turn to face the way you go at up to ${turnRate(MOVE.turnSpeed)}: all but at once.

Crouching wins over sprinting if you hold both. Sprinting needs a run's push, firm ground under you and no pack on your back.

### Facing a Fight

In a fight (with an enemy marked, or for a moment after you swing or cast) you keep facing where the camera looks, and the stick moves you any way you push without turning you: full speed straight ahead, ${pct(MOVE.strafeSpeed)} of it to the side, ${pct(MOVE.backSpeed)} of it backing away, and a blend in between. Sprinting always runs free, facing where you go.

$$
ahead = cos(the angle between where you face and where you push)
going forward: share of full speed = ${num(MOVE.strafeSpeed)} + (1 − ${num(MOVE.strafeSpeed)}) × ahead
going back: share of full speed = ${num(MOVE.strafeSpeed)} + (${num(MOVE.backSpeed)} − ${num(MOVE.strafeSpeed)}) × −ahead
$$

## Jumping

Press jump on the ground and you leave it at ${speed(JUMP.velocity)} upward. Gravity pulls you down at ${accel(JUMP.gravityUp)} while you rise and ${accel(JUMP.gravityDown)} once you fall, so the fall is snappier than the rise, and you never fall faster than ${speed(JUMP.maxFall)}.

$$
height = take-off speed² ÷ (2 × gravity while rising)
${num(JUMP.velocity)}² ÷ (2 × ${num(JUMP.gravityUp)}) = ${metres(jump.height)}, reached after ${duration(jump.time)}
$$

${table(
  ['Jump', 'Takes Off At', 'Rises For', 'Rises'],
  [
    ['A jump', speed(JUMP.velocity), duration(jump.time), metres(jump.height)],
    ['The jump in the air', speed(JUMP.doubleJumpVelocity), duration(double.time), metres(double.height)],
    ['A jump with a pack on your back', speed(JUMP.velocity * CARRY.jumpFactor), duration(packed.time), metres(packed.height)],
  ],
  [1, 2, 3],
)}

- **Short hops.** Let go of jump while you are still rising from the ground and your upward speed is cut to ${pct(JUMP.shortHopCut)} of what it was. Let go at once and you rise only about ${metres(hop.height)}. Only the jump from the ground is cut short.
- **A moment's grace.** For ${frames(JUMP.coyoteFrames)} after you walk off an edge you can still jump as if you were on it.
- **Early presses count.** A press of jump up to ${frames(JUMP.bufferFrames)} before you land jumps the moment you land.
- **The jump in the air.** One more press in the air jumps again, at ${speed(JUMP.doubleJumpVelocity)}, and turns you at once, the way a platform fighter does: if you push the stick, your speed across the ground becomes ${num(JUMP.doubleJumpSteer)} × ${speed(MOVE.runSpeed)} × your push, the way you push. Push nothing and you keep the way you were going. In a fight you keep facing it and flip whichever way you jumped.
- **With a pack.** A trade pack is too heavy for the jump in the air, and the jump from the ground leaves at ${pct(CARRY.jumpFactor)} of its speed.
- **The glider.** With both jumps spent, a third press opens your glider, if you have one and are high enough: [[systems/swimming-gliding]].

### In the Air

Pushing the stick in the air steers you toward a run's speed at ${accel(MOVE.airAccel)}; let go and the air slows you by ${speed(MOVE.airDrag)} every second. Going faster than a run (out of a slide, say) you keep your speed, losing only ${speed(MOVE.airDrag)} of it a second until you are down to a run, and you steer at up to ${turnRate(airTurn)}. Swinging a weapon in the air, gravity pulls at only ${pct(ATTACK.airGravityScale)} of its strength while the swing winds up and lands, so you hang there to hit ([[systems/combat]]).

## Crouching and Sliding

Hold crouch on the ground to crouch: you move at a crouch's pace (above), and your body takes ${frames(MOVE.crouchEnterFrames)} to get all the way down, and as long to get up. In the air crouch doesn't crouch; on a glider it flares.

Everyone can slide; nobody needs to learn it (${link('movement/slide', 'the slide')}). Press the slide key, or press crouch while you run faster than ${speed(crouchSlide)}; standing still, crouch only crouches.

${
  sa
    ? md`
- A slide starts only on the ground, and only once the last one has cooled down: ${frames(slide?.cooldownFrames ?? 0)} after it ends. A press up to ${frames(sa.bufferFrames ?? 0)} early still counts.
- It shoots you off at ${speed(sa.speed)} the way you push (or the way you face, pushing nothing) and eases down to ${speed(sa.endSpeed ?? sa.speed)} over ${frames(sa.active)}, slowly at first and then faster.
- You can steer it at up to ${turnRate(sa.steer ?? 0)}.
- Leave the ground (off the edge of something) and it ends.
- Jump out of it for a long jump: you keep ${pct(sa.jumpCarry ?? 1)} of the slide's speed, then jump. Faster than a run in the air, you keep that speed (above).

$$
slide speed = ${speed(sa.speed)} + (${speed(sa.endSpeed ?? sa.speed)} − ${speed(sa.speed)}) × t², where t = frames into the slide ÷ ${num(sa.active)}
$$
`
    : ''
}

## Slopes, Steps and Edges

Out in the open world the ground is a grid of heights ([[systems/world]]), and its steepness is measured as rise over run on the patch under your feet.

- **Slopes.** You can walk up ground as steep as ${slopeDegrees(GROUND.maxSlope)}. Steeper ground is a wall to someone on their feet.
- **Steps.** A ledge or the top of a box up to ${metres(GROUND.stepUp)} above your feet you step straight onto. Nothing higher can be climbed in one go, on any slope.
- **Walls.** When a step would carry you into something you can't climb, the rules try it along each of the map's two directions alone and keep whichever is free, so you slide along walls rather than stick to them.
- **Going downhill.** You keep your feet on ground that falls away beneath you, up to a limit each frame that grows with your speed (below). Beyond it you have walked off an edge, and fall.
- **Too steep to stand on.** Land on ground steeper than ${slopeDegrees(GROUND.maxSlope + steepExtra)} (a cliff face) and you can't stand: you are pushed off down it.
- **Wading.** Where the water at your feet is deeper than ${metres(GROUND.wadeDepth)} you wade at ${pct(GROUND.wadeSpeed)} of your speed. It is the water over your feet that counts, so on a pier you walk as usual. Deeper still you swim: [[systems/swimming-gliding]].
- **Things in the way.** Trees, rocks and posts are round, and stand in your way at any height: even a glider high over a forest is nudged round each trunk it passes over. Walls, counters and boxes are rectangles, solid from the ground up to their top, so you can stand on one or fly over it. You are pushed out of anything you run into and keep the part of your speed that runs along it.
- **The edge of the world.** The world ends ${metres(edgeMargin)} short of the edge of its grid: on ${EMBERHOLM.name}, ${metres(size / 2 - edgeMargin)} from the middle, far out at sea.

$$
the most the ground may drop in one frame = ${metres(GROUND.snapDown)} + speed ÷ ${SIM_HZ} × ${num(GROUND.maxSlope)} × ${num(snapK)}
at a run: ${metres(snap(MOVE.runSpeed))}; at a sprint: ${metres(snap(MOVE.sprintSpeed))}
$$

## Decks, Floors and Stairs

A deck is ground on top and open underneath: the piers, the glider launch, every upper floor, each stair tread and every roof.

- On foot you step up onto a deck as high as ${metres(GROUND.deckStep)} above your feet, more than a plain step, as decks are built to be walked onto. Landing on one from the air, only as high as a plain step, ${metres(GROUND.stepUp)}.
- A deck you can't get onto, and that is lower than ${metres(GROUND.deckHeadroom)} above your feet, is a wall from the side. One at least that high you walk, wade or swim under, like a pier over the water. Once you are under one, its edge doesn't hold you in.

### Buildings You Can Walk Into

The village's houses are built on a grid of ${metres(MODULE)} squares, ${metres(STOREY)} to a storey (${link('buildings', 'the buildings')} list them).

- Their walls reach ${metres(WALL)} in from the footprint and are solid from the ground up. A doorway leaves a gap ${metres(DOOR_HALF * 2)} wide, an arch one ${metres(ARCH_HALF * 2)} wide.
- Upstairs, a wall standing over a doorway below is a deck: solid up there, and you walk under it downstairs.
- Each upper floor is a deck, less its stairwells.
- A flight of stairs climbs a storey in ${count(STAIR.treads, 'tread')} over ${metres(STAIR.run)}, each tread a deck ${metres(STOREY / STAIR.treads)} above the last: an easy step. Under the high end of a flight, where the treads clear your head (${metres(head)}), the space is filled, so you can't walk in under them.
- A rail ${metres(rail)} high runs round a stairwell's open edges upstairs, but not where you step off the top of the stairs.
- Furniture on the ground floor is solid. Upstairs it is a deck (at least ${metres(furnitureLow)} up), so it never blocks the room below.
- Every roof is a deck halfway up its slope, for anyone coming down on it from the air.
`;
  },
});
