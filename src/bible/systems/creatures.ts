// Creatures and Their AI: written from its rules (`rules` below); every number from the content and the rules.

import { actorKind, actorKindIds, LADDERS } from '../../content/actors';
import { type AttackDef, attackDef } from '../../content/attacks';
import { FACTION, type Behaviour, BEHAVIOURS, type BehaviourState, type Guard, FOE_HEIGHT } from '../../engine/creatures';
import { EMBERHOLM } from '../../engine/zone';
import { count, duration, frames, framesAsSeconds, metres, num, pct, speed } from '../format';
import { system, table } from '../kit';
import { esc } from '../../util/html';
import { type Html, link, md, phrase, raw } from '../md';
import { sourceNumber, tsConst } from '../source';
import { nearestPlace } from '../things/refs';
import stepSource from '../../sim/actors/step.ts?raw';
import packSource from '../../sim/ai/pack.ts?raw';
import brainSource from '../../sim/ai/brain.ts?raw';
import missilesSource from '../../sim/combat/missiles.ts?raw';

// Numbers the rules keep in their source rather than in the content.
const CLEAR_AFTER = () => tsConst(stepSource, 'CLEAR_AFTER');
const TOUCH = () => tsConst(stepSource, 'TOUCH');
const SLAM_LIFT = () => tsConst(stepSource, 'SLAM_LIFT');
const GROUP = () => tsConst(packSource, 'GROUP');
const MISSILE_LIFE = () => tsConst(missilesSource, 'LIFE');
const STRIKE_ON_TOP = () => sourceNumber(stepSource, /d > MOVE\.playerRadius \+ ([\d.]+)\) continue/, 'how close a strike catches you outside its arc');
const BURST_STRIDE = () => sourceNumber(stepSource, /c\.stride = ([\d.]+) \+ draw\(c\)/, 'how far a burst piece scatters');
const REFORM_CALM = () => sourceNumber(stepSource, /gather\?\.cooldown \?\? 0\) : 0\) \/ (\d+)\)/, 'how much sooner a reformed creature can gather');
const LUNGE_STOP = () => sourceNumber(brainSource, /len\(seen\.x - a\.x, seen\.z - a\.z\) <= a\.radius \+ ([\d.]+);/, 'how close a lunge stops');
const WANDER_SHARE = () => sourceNumber(brainSource, /draw\(a\) \* b\.leash \* ([\d.]+);/, 'how far from home a stroll goes');
const THROW_AHEAD = () => sourceNumber(missilesSource, /const ox = a\.x \+ Math\.sin\(a\.facing\) \* ([\d.]+);/, 'where a throw starts');
const THROW_HEIGHT = () => sourceNumber(missilesSource, /const oy = groundY \+ a\.hitHeight \* ([\d.]+);/, 'how high a throw starts');
const THROW_AT = () => sourceNumber(missilesSource, /foe\.y \+ ([\d.]+) - oy/, 'how high on you a throw comes down');
const THROW_SOONEST = () => sourceNumber(missilesSource, /Math\.max\(d \/ speed, ([\d.]+)\)/, 'the shortest flight of a throw');

const FACTION_NAME: Record<number, string> = {
  [FACTION.hostile]: 'Hostile',
  [FACTION.neutral]: 'Townsfolk',
  [FACTION.prop]: 'Practice',
};

const brain = (id: string): Behaviour => {
  const b = BEHAVIOURS.find((x) => x.id === id);
  if (!b) throw new Error(`the creatures page names a brain that isn't in the content: ${id}`);
  return b;
};

const words = (id: string): string =>
  id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** What a kind is called: its own name, or its id in words (townsfolk by their trade). */
const kindName = (id: string): string => actorKind(id).name ?? words(id.replace(/^npc-/, ''));

const creatureLink = (id: string): Html => link(`creatures/${id}`, kindName(id));

/** A span of frames drawn from [lo, hi], as time. */
const span = (r: readonly [number, number] | readonly number[]): Html =>
  r[0] === r[1] ? framesAsSeconds(r[0]) : phrase`${framesAsSeconds(r[0])} to ${framesAsSeconds(r[1])}`;

/** A condition a brain's guard waits for, in words. */
function condition(c: string, b: Behaviour): Html {
  if (c.startsWith('!')) {
    const inner = c.slice(1);
    if (inner === 'angry') return phrase`calm again`;
    if (inner === 'foeSwinging') return phrase`its foe not swinging`;
    return phrase`not ${condition(inner, b)}`;
  }
  const [name, arg = ''] = c.split(':');
  switch (name) {
    case 'called':
      return phrase`called by its pack`;
    case 'angry':
      return phrase`angry, with a foe in sight`;
    case 'threatened':
      return phrase`angry, with its foe within ${metres(b.fleeWithin ?? 0)}`;
    case 'canCall':
      return phrase`able to call its pack`;
    case 'slam':
      return phrase`able to slam`;
    case 'allies':
      return phrase`at least ${b.call?.need ?? 0} of its kin within ${metres(b.gather?.radius ?? 0)}`;
    case 'callOver':
      return phrase`calling for ${framesAsSeconds(b.call?.giveUp ?? 0)}`;
    case 'broken':
      return phrase`hurt by ${pct(b.gather?.breakAt ?? 0)} of its health since it began`;
    case 'fuseLow':
      return phrase`its fuse down to ${framesAsSeconds(b.regroupAt ?? 0)}`;
    case 'token':
      return phrase`given a token`;
    case 'opening':
      return phrase`let in by an opening`;
    case 'afraid':
      return phrase`afraid`;
    case 'near':
      return phrase`its foe within ${metres(Number(arg))}`;
    case 'far':
      return phrase`its foe further than ${metres(Number(arg))}`;
    case 'hurt':
      return phrase`down to ${pct(Number(arg))} of its health`;
    case 'foeMelee':
      return phrase`its foe holding a weapon that swings`;
    case 'foeRanged':
      return phrase`its foe holding a bow`;
    case 'foeSwinging':
      return phrase`its foe swinging`;
    case 'ready':
      return phrase`its ${attackName(arg)} ready`;
    case 'canHeal':
      return phrase`a potion left and below ${pct(b.heal?.below ?? 0)} of its health`;
    default:
      return phrase`${c}`;
  }
}

const conditions = (c: string | string[] | undefined, b: Behaviour): Html | null =>
  c === undefined ? null : raw((Array.isArray(c) ? c : [c]).map((x) => condition(x, b).html).join(' and '));

const guards = (gs: readonly Guard[], b: Behaviour): Html =>
  raw(
    gs
      .map((g) => {
        const when = conditions(g.if, b);
        const to = raw(`<b>${esc(g.to)}</b>`);
        return when ? phrase`if ${when}: ${to}` : phrase`otherwise ${to}`;
      })
      .map((h) => h.html)
      .join('; '),
  );

const TOWARD: Record<string, string> = {
  wander: 'toward you if it sees you, home if it has strayed, anywhere otherwise',
  player: 'at its foe',
  away: 'away from its foe',
  keep: 'on the way it was already going',
  caller: 'to the one calling',
  ally: 'to its nearest kin',
  group: 'to the middle of its burst group',
};

const WALK_TO: Record<string, string> = {
  foe: 'at its foe',
  slot: 'to its place on the ring round its foe',
  rally: 'to its friends, or home',
  home: 'home',
  away: 'straight away from its foe',
  wander: 'to a spot near home',
};

const attackName = (id: string | undefined): string => (id ? id.replace(/^[a-z]+-/, '') : 'attack');

/** The number a condition takes (`far:3`) in the guard of a state that also waits for `with`. */
function argOf(b: Behaviour, state: string, with_: string, name: string): number | null {
  const s = b.states.find((x) => x.name === state);
  const gs = s && typeof s.next !== 'string' ? s.next : [];
  for (const g of gs) {
    const cs = g.if === undefined ? [] : Array.isArray(g.if) ? g.if : [g.if];
    if (!cs.includes(with_)) continue;
    const hit = cs.find((c) => c.startsWith(`${name}:`));
    if (hit) return Number(hit.slice(name.length + 1));
  }
  return null;
}

/** What a state does, in words. */
function does(s: BehaviourState): Html {
  const extra = [s.calls ? 'calling its pack' : '', s.token ? 'holding a token' : '', s.face === 'foe' ? 'facing its foe' : ''].filter(Boolean).join(', ');
  const tail = extra ? phrase`, ${extra}` : '';
  switch (s.act) {
    case 'wait':
      return phrase`Stands${tail}`;
    case 'advance': {
      const g = s.gait;
      const how = g && g.height > 0 ? 'Hops' : 'Moves';
      const far = g ? phrase` ${metres(g.distance)}` : '';
      const toward = s.toward ?? 'wander';
      const stop = toward === 'player' && s.stop !== undefined ? phrase`, stopping ${metres(s.stop)} short` : '';
      return phrase`${how}${far} ${TOWARD[toward] ?? toward}${stop}${tail}`;
    }
    case 'windup':
      return phrase`Crouches, having picked where it will land: where its foe stands${tail}`;
    case 'leap':
      return phrase`Leaps there and slams as it lands${tail}`;
    case 'channel':
      return phrase`Gathers its kin in${tail}`;
    case 'walk': {
      const stop = s.stop ? phrase`, stopping ${metres(s.stop)} short` : '';
      return phrase`Walks at ${speed(s.speed ?? 0)} ${WALK_TO[s.toward ?? ''] ?? s.toward ?? ''}${stop}${tail}`;
    }
    case 'strike':
      return phrase`Strikes: its ${attackName(s.attack)}${tail}`;
    case 'throw':
      return phrase`Throws: its ${attackName(s.attack)}${tail}`;
    case 'heal':
      return phrase`Drinks its potion${tail}`;
    default:
      return phrase`${s.act}`;
  }
}

/** A brain as a table: each state, what it does, for how long, and what comes next. */
function brainTable(b: Behaviour): Html {
  return table(
    ['State', 'Does', 'For', 'Then'],
    b.states.map((s) => {
      const next = typeof s.next === 'string' ? raw(`<b>${esc(s.next)}</b>`) : guards(s.next, b);
      const cut = s.interrupt?.length ? phrase`${raw('<br>')}Cut short ${guards(s.interrupt, b)}` : '';
      return [raw(`<b>${s.name}</b>`), does(s), span(s.frames), phrase`${next}${cut}`];
    }),
  );
}

/** The attacks a brain uses, as a table. */
function attacksTable(ids: readonly string[]): Html {
  const list = ids.map((id) => attackDef(id)).filter((a): a is AttackDef => !!a);
  return table(
    ['Attack', 'Kind', 'Wind-Up', 'Turns to You For', 'Damage', 'Knock', 'Reach', 'Again After'],
    list.map((a) => [
      attackName(a.id),
      a.kind === 'strike' ? 'A blow in front of it' : 'A lobbed missile',
      frames(a.windup),
      frames(a.track),
      a.damage,
      speed(a.knock),
      a.kind === 'strike'
        ? phrase`${metres(a.reach ?? 0)}, ${raw(`<span class="v">${a.arc ?? 0}°</span>`)} wide`
        : phrase`${metres(a.range ?? 0)} at ${speed(a.speed ?? 0)}`,
      phrase`${framesAsSeconds(a.cooldown[0])} to ${framesAsSeconds(a.cooldown[1])}`,
    ]),
    [4],
  );
}

export const creatures = system({
  id: 'creatures',
  title: 'Creatures and Their AI',
  summary: 'How creatures see you, choose what to do, fight as a pack, throw things, grow, burst and come back.',
  icon: '👺',
  keywords: ['monster', 'monsters', 'enemy', 'enemies', 'ai', 'brain', 'slime', 'goblin', 'pack', 'aggro', 'respawn', 'boss'],
  rules: [
    'src/sim/actor.ts',
    'src/sim/actors/step.ts',
    'src/sim/ai/brain.ts',
    'src/sim/ai/pack.ts',
    'src/sim/ai/senses.ts',
    'src/sim/combat/missiles.ts',
    'crates/engine/src/actor.rs',
    'crates/engine/src/actors.rs',
    'crates/engine/src/ai.rs',
    'crates/engine/src/pack.rs',
    'crates/engine/src/missiles.rs',
  ],
  content: ['shared/behaviours.json#behaviours', 'shared/creatures.json#creatures', 'shared/zones/*.json#slimes'],
  body: () => {
    const slime = brain('slime');
    const slimelet = brain('slimelet');
    const goblin = brain('goblin');
    const pack = goblin.pack!;
    const ladder = LADDERS[0];
    const z = EMBERHOLM;
    const meadow = nearestPlace(z.slimes.x, z.slimes.z);
    const used = new Set(actorKindIds().map((id) => actorKind(id).brain));
    const unused = BEHAVIOURS.filter((b) => !used.has(b.id));
    // The distance past which a goblin on its ring will throw rather than wait.
    const throwFrom = argOf(goblin, 'engage', 'foeMelee', 'far');
    // Alone against one foe, a goblin's nerve goes below this much health; with friends near, lower.
    const nerve = (friends: number) => pack.braveAt + pack.foeWorth - pack.friendWorth * friends;
    const call = slime.call!;
    const gather = slime.gather!;
    const sizes = ladder ? ladder.kinds.map((id) => actorKind(id)) : [];

    return md`
Everything in the world that isn't a player is an *actor*: a creature that fights, one of the townsfolk, or a prop like the training dummy. No creature has code of its own. Each is data: its kind (health, size, what it bursts into), its attacks, and a *brain*, a small list of states it moves between. The same rules run them in your browser and on the server, frame for frame, so a creature does exactly the same thing in both.

${table(
  ['Kind', 'Side', 'Health', 'Body Radius', 'Brain', 'Comes Back'],
  actorKindIds().map((id) => {
    const k = actorKind(id);
    return [
      k.faction === FACTION.neutral ? link('npcs', kindName(id)) : creatureLink(id),
      FACTION_NAME[k.faction] ?? '',
      k.maxHp,
      metres(k.radius),
      k.brain ?? 'None',
      k.respawnFrames < 0 ? 'Not by itself' : frames(k.respawnFrames),
    ];
  }),
  [2, 3],
)}

Townsfolk are never anyone's target and never hurt. Props (the dummy) take blows but don't fight back.

## Where They Are

On ${z.name}, ${count(z.slimes.count, 'slime')} live within ${metres(z.slimes.r)} of the middle of ${link(`places/${meadow.id}`, meadow.name)}, with the training dummy beside them. Online, creatures belong to the channel: everyone in it sees and fights the same ones. A war-band of goblins is set down together, every one of them a member of the same band.

## How a Creature Sees You

To a creature every player who isn't knocked down is a *foe*, and it knows only this about each:

- where they are, how fast they are going and which way they face;
- how much health they have left;
- how far their weapon's swings reach (the longest of its combo), or that it is a bow;
- what they are doing: free, swinging (winding up or live), recovering from a swing, casting, guarding, dodging or stunned;
- whether they are in a dodge's untouchable frames, and how high their feet are off the ground.

A creature that fights in a pack keeps after the foe it has chosen unless another is more than ${metres(pack.switchAt)} closer; any other creature just watches the nearest.

## Brains

A brain is a list of states. Each state does one thing (stands, hops, walks, strikes, throws, gathers its kin...) for a number of frames drawn from its range as it begins. When the time is up it moves on: to a named state, or to the first of its *guards* whose conditions all hold. Some states also have guards checked every frame, which cut them short. A creature draws its random numbers from a stream of its own, seeded where it was born, so its choices never depend on anything else in the world.

A brain only ever moves its own creature. Whatever reaches another (a call to the pack, a slam, a blow, a stone) is asked for, and done once every brain has had its turn, so the order creatures are stepped in can't change what happens.

## Anger

A creature with a temper is calm until something sets it off:

- **Hitting it** angers it, and every one of its *kin* within its anger's reach: its own kind in any size, or the rest of its war-band.
- **Seeing you**, for a creature that keeps watch (goblins): a foe within its sight, while that foe is within its leash of its home, angers it and its kin in reach.
- **It calms down** when its anger runs out, or straight away if it has been drawn further from home than it will go.

${table(
  ['Brain', 'Sees', 'Angry For', 'Rouses Kin Within', 'Calms Beyond Home'],
  BEHAVIOURS.filter((b) => b.anger).map((b) => [
    b.id,
    metres(b.sight),
    framesAsSeconds(b.anger!.frames),
    b.anger!.radius ? metres(b.anger!.radius) : 'Nobody',
    metres(b.anger!.calmBeyond),
  ]),
)}

## The Slimes

A slime leaves you alone until you hit one. Then the pack fights as one: the slime you hit calls the others, gathers them in and grows a size, and every slime you kill bursts into pieces that come back bigger if you don't finish them.

${brainTable(slime)}

### Calling and Gathering

A slime can *call* its pack when all of this holds: it is angry, its foe is in sight, it was hit within the last ${frames(call.struckWithin)}, it isn't gathering again too soon, it isn't calling or answering a call already, no other slime within ${metres(call.radius)} is calling, and at least ${count(call.need, 'free slime')} (not answering another call, not a burst piece) are within ${metres(call.radius)}.

1. **The call.** Every slime of its kind within ${metres(call.radius)} that is free comes running to it, angry. The caller hops toward its nearest kin as they come.
2. **The gathering** starts once at least ${count(call.need, 'slime')} are within ${metres(gather.radius)} of the caller, and lasts ${frames(slime.states.find((s) => s.act === 'channel')?.frames[0] ?? 0)}. Every slime within ${metres(gather.radius)} slides toward it at ${speed(gather.pull)} until it touches, and stays put meanwhile.
3. **Taken in.** When the gathering ends, every slime touching the caller (within ${metres(TOUCH())} of its body) is taken in. Their mass is added to the caller's: if that reaches a bigger size it becomes it, at full health; if not, it heals by the health it took in.
4. **Broken.** Hurt the caller by ${pct(gather.breakAt)} of its health while it gathers and the cast breaks: it is dazed for a moment and can't gather again for ${framesAsSeconds(gather.cooldown)}, the same wait as after a gathering that finishes.
5. **No answer.** A caller nobody joins gives up after ${framesAsSeconds(call.giveUp)} and fights on. If a caller dies, the nearest slime answering it that could gather takes the call over, and the rest follow the new one.

### The Slam

A slime that is angry, has its foe within its slam's range and has waited out its last slam (${span(slime.slamCooldown ?? [0, 0])}, drawn each time) winds up: it picks the spot where its foe stands, crouches, then leaps there (no further than its leap) and slams as it lands. Everyone within the slam's radius, plus their own body, is hit, so long as they are on the ground, no more than ${metres(SLAM_LIFT())} above it: jump as it lands, or step out of the circle.

### Sizes

A slime comes in ${count(sizes.length, 'size')}, by its *mass*: gathering adds the mass of what it takes in, and it grows to the biggest size its mass reaches.

${table(
  ['Size', 'Mass', 'Health', 'Slam', 'Slam Reach', 'Bursts Into'],
  sizes.map((k) => [
    creatureLink(k.id),
    k.mass ?? 0,
    k.maxHp,
    k.slam ? phrase`${k.slam.damage} in ${metres(k.slam.radius)}` : 'None',
    k.slam ? phrase`from ${metres(k.slam.range)}, leaping ${metres(k.slam.leap)}` : '',
    k.burst ? phrase`${k.burst.count} ${link(`creatures/${k.burst.into}`, kindName(k.burst.into) + (k.burst.count === 1 ? '' : 's'))}` : 'Nothing',
  ]),
  [1, 2],
)}

### Bursting and Reforming

A slime that dies bursts into its pieces: as many as its kind says, but never so many that the slimes alive would pass ${ladder ? ladder.cap : 0}. The pieces scatter evenly round where it fell, each hopping between ${metres(BURST_STRIDE())} and ${metres(BURST_STRIDE() + 1)} away, already angry, and share a fuse of ${frames(ladder?.fuse ?? 0)}.

- **Kill them all** before the fuse runs out and that's the end of it.
- **Two or more left** when it runs out come back together at their middle as one slime a size up from the one you killed (the biggest size stays the biggest), angry, and able to gather after ${pct(1 / REFORM_CALM())} of the usual wait.
- **One left** is on its own: it dissolves ${frames(ladder?.alone ?? 0)} later. A piece that dissolves wasn't killed, so it counts for no quest.

The pieces have a brain of their own. They run from you when you come within ${metres(slimelet.fleeWithin ?? 0)}, huddle toward each other while angry, and head back to the middle of their group when the fuse has ${frames(slimelet.regroupAt ?? 0)} left:

${brainTable(slimelet)}

## Goblins and the War-Band

Goblins fight as a war-band. One goblin alone fights you fairly; ten of them wear you down from every side. Before the brains take their turn each frame, the band works out together who is brave enough to fight, who may strike, and where the rest wait.

${brainTable(goblin)}

### Courage

Each goblin weighs its chances every frame:

$$
courage = health left + ${num(pack.friendWorth)} × friends − ${num(pack.foeWorth)} × foes
$$

counting friends of its band and foes within ${metres(pack.friendRadius)}, and health as a share of its most. Below ${num(pack.braveAt)} it is afraid, and stays afraid until its courage is back to ${num(pack.calmAt)}. So alone against one of you a goblin turns tail below ${pct(nerve(0))} of its health; with two friends beside it, below ${pct(Math.max(0, nerve(2)))}. An afraid goblin runs to whichever of its band (not afraid itself) has the most of the band within ${metres(GROUP())} of it, so chasing it leads you into the rest; with nobody to run to it runs home.

### Who Strikes

Only a few goblins may strike one foe at a time. They hold *tokens*, as many as the number fighting that foe allows; a goblin in the middle of a strike keeps its token until it is done, and the nearest of the others take what is left.

${table(
  ['Goblins Fighting You', 'May Strike at Once'],
  pack.tokens.map((t, i) => [i === pack.tokens.length - 1 ? phrase`${i + 1} or more` : phrase`${i + 1}`, t]),
  [0, 1],
)}

An *opening* lets one more in: the nearest waiting goblin within ${metres(pack.openingRange)} goes if you are recovering from a swing, casting or stunned, or if it stands more than ${raw(`<span class="v">${pack.backArc}°</span>`)} round from where you face, behind you. A goblin given a token closes in, stabs, then backs off and thinks again. It won't come in while you are swinging: it waits for you to stop.

### The Ring

The goblins without a token wait on a ring round you, ${metres(pack.ring)} outside the reach of your weapon, so a sword holds them further off than a bow, which has no reach at all and lets them wait right beside you. Their places are spread at most ${raw(`<span class="v">${pack.spread}°</span>`)} apart, bunched up behind you, each keeping the order it already stands in so none has to cross another. From the ring a goblin throws stones at a foe whose weapon swings${throwFrom ? phrase`, when it is more than ${metres(throwFrom)} away` : ''} and its throw is ready.

### Their Attacks

${attacksTable(goblin.attacks ?? [])}

- **A strike** turns to follow you through the first part of its wind-up, then commits, so you can step aside. The blow lands on the frame the wind-up ends, on everyone within its reach plus their own body and inside its arc, or right on top of it (within ${metres(STRIKE_ON_TOP())} of its body) even outside the arc. A foe whose feet are higher off the ground than its *lift* has jumped clear, and a dodge's untouchable frames make it miss. After the blow it lunges on, stopping at arm's length (${metres(LUNGE_STOP())} beyond its body).
- **A throw** aims through most of its wind-up and lets go as it ends ([[systems/creatures/missiles|see Missiles]]).
- **Each attack** then waits a cooldown drawn from its range before it can be used again.

### The Potion and Flinching

A goblin carries ${count(goblin.heal?.charges ?? 0, 'potion')}. Afraid, below ${pct(goblin.heal?.below ?? 0)} of its health and out of reach, it drinks: when the drink is done it is back up by ${pct(goblin.heal?.amount ?? 0)} of its most. A blow of at least its kind's *poise* (${actorKind('goblin').poise ?? 0}) knocks it out of whatever it was doing into a flinch, and spills a potion it was drinking. Once it is calm again it walks home, and from there it strolls about within ${metres(goblin.leash * WANDER_SHARE())} of home until something rouses it.

## Missiles

A thrown stone starts ${metres(THROW_AHEAD())} in front of the thrower at ${pct(THROW_HEIGHT())} of its height. It is aimed where its foe will be, leading them by the attack's share of how far they would go while it flies, but no further away than its range. It is lobbed so as to come down at the foe's chest, ${metres(THROW_AT())} above their feet, after flying that far at its speed (never in less than ${duration(THROW_SOONEST())}), and gravity pulls it down as it goes. It hits the first foe whose body it passes through (within their body plus its own size across, between their feet and ${metres(FOE_HEIGHT)} above them) unless they are in a dodge's untouchable frames; otherwise it lands where it meets the ground, or is gone after ${frames(MISSILE_LIFE())}.

## Coming Back

- **Creatures the island placed** come back where they first stood, as what they were first, once their kind's time is up: but only if there is room. The slimes alive, counted by mass and with every piece and grown slime among them, plus the one coming back, may not pass the mass the meadow started with. So a pack that has grown, or burst into pieces, has to be dealt with before the meadow fills again.
- **Pieces and reformed slimes** never come back, and what is left of them is cleared away ${frames(CLEAR_AFTER())} after they die.
- **A slime taken in** by another is out of the world, not dead: it counts for no kill, and comes back like any other when there is room.

## Other Brains

${unused.length ? md`The content holds ${count(unused.length, 'more brain', 'more brains')} that no creature uses yet.` : ''}

${raw(unused.map((b) => md`### ${words(b.id)}`.html + brainTable(b).html).join(''))}
`;
  },
});
