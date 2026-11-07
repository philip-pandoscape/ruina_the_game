// Combat: written from its rules (`rules` below); every number from the content and the rules.

import { actorKind } from '../../content/actors';
import { statBase, STATS } from '../../content/skills';
import { EMBERHOLM } from '../../engine/zone';
import {
  ABILITIES,
  ATTACK,
  type AttackStep,
  COMBAT,
  HOTBAR_SLOTS,
  MOVEMENT_SKILLS,
  MOVEMENT_SLOTS,
  MP,
  SIM_HZ,
  SPECIAL,
  STAMINA,
  WEAPONS,
} from '../../content/tuning';
import { count, duration, frames, framesAsSeconds, key, metres, num, pct, speed, times } from '../format';
import { system, table } from '../kit';
import { link, md, phrase, raw } from '../md';
import { rustConst, sourceNumber } from '../source';
import { nearestPlace } from '../things/refs';
import playerSource from '../../../crates/engine/src/player.rs?raw';
import actorsSource from '../../../crates/engine/src/actors.rs?raw';
import serverCombat from '../../../crates/engine/src/combat.rs?raw';
import serverPlay from '../../../crates/server/src/play/mod.rs?raw';

// Numbers the rules keep in their source rather than in the tuning: your combo is the engine's
// (player.rs), the arc a swing catches creatures in is the engine's too (actors.rs), and where a
// swing reaches from, how far back it is judged and how an arrow flies the server decides online
// (combat.rs).
const QUEUE = () => sourceNumber(playerSource, /attack_queued && f >= active_end \+ (\d+)/, 'when a queued hit starts');
const WINDUP_LUNGE = () => sourceNumber(playerSource, /step\.lunge \* ([\d.]+) \} else \{ step\.lunge \}/, 'the lunge during a wind-up');
const SWING_HEIGHT = () => sourceNumber(serverCombat, /feet\.is_none_or\(\|\(above, _\)\| above <= ([\d.]+)\)/, 'how high a swing still reaches from');
const FEET_APART = () =>
  sourceNumber(serverCombat, /\(y \+ ground_under\(floor, terrain, x, z\) - fy\)\.abs\(\) <= ([\d.]+)\)/, 'how far below or above a swing reaches');
const REWIND = () => rustConst(serverCombat, 'MAX_REWIND_TICKS');
const ON_TOP = () => sourceNumber(actorsSource, /!in_cone && dist > a\.radius \+ ([\d.]+) \{/, 'how close counts as on top of you');
const ARROW_AHEAD = () => sourceNumber(serverCombat, /x: shooter\.pos\.x \+ dx \* ([\d.]+),/, 'where an arrow starts');
const ARROW_HEIGHT = () => rustConst(serverCombat, 'ARROW_HEIGHT');
const ARROW_RADIUS = () => rustConst(serverCombat, 'ARROW_RADIUS');
const ARROW_HOP = () => sourceNumber(serverCombat, /\(travel \/ ([\d.]+)\)\.ceil\(\)/, 'how far an arrow moves between checks');
const SLAM_LIFT = () => rustConst(serverCombat, 'SLAM_LIFT');
const TICK_HZ = () => rustConst(serverPlay, 'TICK_HZ');

const stepFrames = (s: AttackStep): number => s.startup + s.active + s.recovery;

/** Frames a whole combo takes with every hit pressed in time: each hit but the last ends as the next one starts. */
function comboFrames(combo: readonly AttackStep[]): number {
  let total = 0;
  combo.forEach((s, i) => {
    total += i < combo.length - 1 ? s.startup + s.active + QUEUE() : stepFrames(s);
  });
  return total;
}

const statOf = (id: string): number => statBase(STATS.findIndex((s) => s.id === id));

export const combat = system({
  id: 'combat',
  title: 'Combat',
  summary: 'Health, stamina and MP; weapon combos, hits and knockback; casting abilities; dodges, blocks and getting knocked down.',
  icon: '⚔️',
  keywords: ['fight', 'fighting', 'attack', 'combo', 'damage', 'health', 'hp', 'stamina', 'mp', 'mana', 'dodge', 'block', 'stun', 'knockback', 'cast', 'spell'],
  rules: ['crates/engine/src/player.rs', 'crates/engine/src/combat.rs'],
  content: [
    'shared/tuning.json#attack',
    'shared/tuning.json#special',
    'shared/tuning.json#combat',
    'shared/tuning.json#stamina',
    'shared/tuning.json#mp',
    'shared/tuning.json#hotbar',
  ],
  body: () => {
    const ground = ABILITIES.find((a) => a.target === 'ground');
    const block = MOVEMENT_SKILLS.find((m) => m.action.damageTaken !== undefined);
    const dummy = actorKind('dummy');
    const dummySpot = EMBERHOLM.spawns.find((s) => s.kind === 'dummy')!;
    const dummyPlace = nearestPlace(dummySpot.x, dummySpot.z);
    return md`
Fighting in Ruina plays like a platform fighter: quick combos you can cut short with a jump or a slide, dodges with frames nothing can touch, and spells you stand still to cast. What you can do is your build, learned in the skill tree ([[systems/skills]]); this page says how each part of a fight works, step by step. The rules run ${SIM_HZ} times a second, and many timings below are counted in those steps, called frames.

Online the game's server runs every rule. Your browser predicts your own moves so they answer at once, but whether a blow landed is the server's say ([[systems/combat/online|see Online]]).

## Health, Stamina and MP

Everyone has the same three bars.

${table(
  ['Bar', 'Most', 'Comes Back', 'Spent On'],
  [
    ['Health', COMBAT.maxHp, 'Only by healing, or by getting back up after a knock-down', 'Every blow that lands on you'],
    [
      'Stamina',
      STAMINA.max,
      phrase`${num(STAMINA.regenPerSecond)} a second, once ${framesAsSeconds(STAMINA.regenDelayFrames)} have passed since you last spent any`,
      'Dodges: each costs its stamina as it starts',
    ],
    ['MP', MP.max, phrase`${num(MP.regenPerSecond)} a second, always`, 'Abilities: each costs its MP as the cast goes off'],
  ],
  [1],
)}

From empty, stamina takes ${duration(STAMINA.max / STAMINA.regenPerSecond)} to fill and MP ${duration(MP.max / MP.regenPerSecond)}. A dodge or a cast you can't afford simply doesn't start, and the screen tells you which bar was short. Health doesn't come back by itself: only a heal (such as [[abilities/heal]]) or getting back up after a knock-down restores it.

## The Combo

Each weapon has a combo: a fixed run of hits, each with its own timing, damage and reach ([[weapons]] lists every hit). Press attack and the first hit starts; press again while it plays and the next hit follows.

- **A press is remembered** for ${frames(ATTACK.bufferFrames)}, so pressing slightly early still counts.
- **Each hit has three parts.** The *wind-up*, when nothing can be hit yet; the *live* frames, when it lands on whatever is in reach; and the *recovery*, while you finish the movement.
- **The next hit** is queued by any press during the current one and starts ${frames(QUEUE())} after the live frames end. Let a hit play out to the end of its recovery without pressing and the combo is over: the next press starts it again from the first hit.
- **Cutting it short.** Once a hit is its *cancel after* frames into its recovery, a jump or a slide ends the attack there and then.
- **Moving while you swing.** On the ground a hit carries you forward at its *lunge* speed (at ${pct(WINDUP_LUNGE())} of it during the wind-up), then slows you to a stop. In the air you keep drifting the way you were going, and gravity is ${times(ATTACK.airGravityScale)} as strong through the wind-up and the live frames, so an air attack hangs.
- **Which way you swing.** At the start of each hit you turn toward what you are aiming at (the enemy the game has marked for you, when it is in reach); otherwise ahead in a fight, or the way you are pushing.

With every hit pressed in time, here is how long each weapon's whole combo takes and what it deals if every hit lands, before any skill changes it:

${table(
  ['Weapon', 'Hits', 'Damage', 'Whole Combo', 'Damage a Second'],
  WEAPONS.map((w) => {
    const total = w.combo.reduce((t, s) => t + s.damage, 0);
    const f = comboFrames(w.combo);
    return [
      link(`weapons/${w.name}`, w.title),
      w.combo.length,
      raw(w.combo.map((s) => num(s.damage).html).join(' + ')),
      frames(f),
      num(total / (f / SIM_HZ), 1),
    ];
  }),
  [1, 3, 4],
)}

## How a Hit Lands

### A Swing

On each of a swing's live frames, until it has caught something, the rules look for everything that can be hit:

1. Within the hit's *reach* of you, plus the target's own body: a big creature is hit from further away.
2. Inside the hit's *arc*, half of it each side of the way you face. Something right on top of you, within ${metres(ON_TOP())} of its body, is caught even outside the arc.
3. Not out of reach in height. Swinging from more than ${metres(SWING_HEIGHT())} above the ground under you reaches nothing, and on a slope only targets whose feet are within ${metres(FEET_APART())} of yours are hit.
4. Nearest first, up to the most targets your weapon reaches at once: ${count(statOf('melee.maxTargets'), 'target')} unless a skill raises it ([[skills/cleave]] does).

A swing lands once: everything it caught takes its damage on that frame, and the rest of its live frames catch nothing more.

### An Arrow

A bow's hits are shots. Each arrow is loosed on the first live frame, ${metres(ARROW_AHEAD())} in front of you and ${metres(ARROW_HEIGHT())} up, and flies straight at the hit's speed until it has gone the hit's range. It moves in hops of no more than ${metres(ARROW_HOP())}, so nothing thin is skipped, and hits whatever it passes within ${metres(ARROW_RADIUS())} of the body of, so long as it flies below the top of it. An arrow hits ${count(statOf('projectile.pierce'), 'target')} unless a skill lets it pierce more ([[skills/piercing]]), each of them once.

### What a Blow Does to a Creature

It loses the damage from its health and flashes; it gets angry, and so does its kin close by; a blow of at least its *poise* knocks it out of whatever it was doing; and it rocks with the blow. Your blows don't push creatures about. At nothing it dies, or bursts into pieces: [[systems/creatures]] has the rest.

### Who Can Be Hurt

- **Creatures** ([[creatures]]): every blow lands on them.
- **The training dummy** stands at ${link(`places/${dummyPlace.id}`, dummyPlace.name)} for practice: it takes every blow, has ${dummy.maxHp} health, and is back ${frames(dummy.respawnFrames)} after you knock it down.
- **Townsfolk** are never hit, by anything.
- **Other players** never: on the island everyone is on one side, so your swings, arrows and meteors pass through other players, and your Healing Circle heals them too.

## Being Hit

A blow on you goes through these steps, in this order:

1. **Knocked down already?** Then it misses.
2. **Untouchable?** In a dodge's untouchable frames the blow misses entirely, and the dodge carries on.
3. **Guarding?** During a guard's active frames you take part of it: ${block ? phrase`${pct(block.action.damageTaken ?? 1)} with ${link(`movement/${block.id}`, block.name)}` : 'a share'}.
4. **The damage comes off your health.**
5. **In the middle of a movement skill** (a guard, a dodge, a slide) you keep your feet: no knockback and no stun. That is the point of a guard.
6. **Casting?** The spell fizzles: nothing is spent, and that hotbar slot can't be used again for at least ${frames(SPECIAL.interruptCooldownFrames)}.
7. **Knocked back and stunned.** You are thrown along the blow at its *knock* speed and up at ${speed(COMBAT.knockUp)}, then stunned for ${frames(COMBAT.stunFrames)}: no control at all, sliding to a stop on the ground or drifting through the air.

### Knocked Down

When your health reaches nothing you are knocked down. You lie still for ${frames(COMBAT.downFrames)}, then get back up at the island's arrival spot (in a dungeon, where you came in) with full health, stamina and MP and every hotbar cooldown cleared. While you are down nothing can hit you, and no creature takes you for a target.

## Movement Skills

Movement skills are dodges and guards. You learn them in the tree and put them in your ${count(MOVEMENT_SLOTS, 'movement slot')} (${key('Q')} and ${key('E')}, or the bumpers); the slide everyone has, on its own key. They follow the same rules:

- **On the ground only**, and only when nothing else is going on.
- **Stamina or a cooldown.** A dodge costs stamina as it starts and won't start without enough; the others have a cooldown that begins when they end.
- **A timeline.** Start-up (you slow down), active (you move at its speed, easing toward its end speed, faster at first), recovery (you slow to a stop).
- **A committed direction**: the way you push as it starts, the way you face, or straight back. Only the slide can be steered as it goes.
- **Untouchable frames**, counted from its start, when nothing can hurt you. A guard instead takes part of each blow for as long as you hold it, then recovers.
- **The slide**: jump out of it for a long jump that keeps part of its speed; it ends if you leave the ground.

${table(
  ['Skill', 'Costs', 'Start-Up', 'Active', 'Recovery', 'Untouchable'],
  MOVEMENT_SKILLS.map((m) => [
    link(`movement/${m.id}`, m.name),
    m.staminaCost ? phrase`${m.staminaCost} stamina` : m.cooldownFrames ? phrase`${frames(m.cooldownFrames)} cooldown` : 'Nothing',
    frames(m.action.startup),
    frames(m.action.active),
    frames(m.action.recovery),
    m.action.invulnFrom !== undefined && m.action.invulnTo !== undefined ? phrase`frames ${m.action.invulnFrom} to ${m.action.invulnTo}` : 'None',
  ]),
)}

## Abilities

Abilities are spells on your hotbar: ${count(HOTBAR_SLOTS, 'slot')}, on the number keys. Casting one goes like this:

1. **Starting.** A press is remembered for ${frames(SPECIAL.bufferFrames)}. The cast starts only on the ground, with nothing else going on, the slot's cooldown run down and enough MP for it.
2. **Aiming.** A spell aimed at the ground is placed with a circle: hold its key, move the circle, let go to cast. It reaches as far as the spell's furthest range${
      ground ? phrase` (${metres(ground.maxRange ?? 0)} for ${link(`abilities/${ground.id}`, ground.name)})` : ''
    }; cast without aiming, it goes off at its own range straight ahead. Other spells go off on you.
3. **Casting.** You stand rooted for the cast time. Jumping or sliding cancels it: nothing is spent, and the slot waits ${frames(SPECIAL.cancelCooldownFrames)}. Being hit interrupts it ([[systems/combat/being-hit|see Being Hit]]).
4. **Going off.** The cooldown starts, the MP is paid, and the effects happen. A heal restores health to you and everyone on your side inside its circle, up to their most. A delayed blast lands after its delay and hurts everything on the other side within its radius, throwing it outward.

${table(
  ['Ability', 'Cast', 'Cooldown', 'MP', 'Does'],
  ABILITIES.map((a) => [link(`abilities/${a.id}`, a.name), frames(a.castFrames), frames(a.cooldownFrames), a.mpCost ?? 0, a.desc]),
  [3],
)}

Skills change all of these: cast time, cooldown, radius, healing and damage go through the tree's modifiers ([[systems/skills]]).

## Online

Your browser sends the server what you press, ${SIM_HZ} times a second; the server runs your moves with the same rules, in order, and answers ${TICK_HZ()} times a second. Nothing your browser says about itself is believed.

- **Swings** are judged where your screen showed what you swung at. The server keeps where every player and creature stood, tick by tick, and checks each swing against the moment you were looking at, up to ${duration(REWIND() / TICK_HZ())} back: what was in reach on your screen is hit, even if it has moved on since.
- **Everything that lands at once** is worked out against where everyone stood as that moment began, then lands in a fixed order: on whom it lands, then from whom. A blow on someone already knocked down, or on a creature already dead, does nothing.
- **Arrows and meteors** fly and fall on the server, which hits whatever they reach there.
- **A creature's blow** on you goes through the same steps as any other blow: a dodge's untouchable frames make it miss. A slam only catches you on the ground, no more than ${metres(SLAM_LIFT())} above it.
`;
  },
});
