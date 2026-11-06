// One frame for every actor in the world: its brain, its lean, bringing it back when it has been
// dead long enough, and everything a pack of them does together - a dying one bursting into
// pieces, a caller gathering the others in, a burst group reforming one size up, a war-band
// sharing out who strikes and where the rest wait (src/sim/ai/pack.ts), and the blows, throws
// and heals they ask for. server/src/actors.rs runs the same frame the same way;
// tests/conformance/ai.test.ts compares whole packs of them frame by frame.

import type { Sim } from '../sim';
import type { GameEvent } from '../types';
import { LEAN, MOVE, STEP } from '../../tuning';
import { actorKind, findKind, kindMass, LADDERS, sizeFor, sizeUp } from '../../content/actors';
import { attackDef, attackIndex } from '../../content/attacks';
import { becomeKind, isAlive, type Actor, type Actors } from '../actor';
import { behaviour, draw, forceState, restState, sightingAt, startBrain, stepBrain, type Behaviour, type BrainCtx, type Peer, type Sighting } from '../ai/brain';
import { foesOf, pickFoe, sightingOf, type Foe } from '../ai/senses';
import { stepPacks } from '../ai/pack';
import { launch, stepMissiles } from '../combat/missiles';
import { DEG, angleDiff, len } from '../math';

/** Frames a dead piece of a burst lies there (its death clip plays out) before it is cleared away. */
const CLEAR_AFTER = 60;
/** How close to a gatherer something has to be pulled before it is taken in. */
const TOUCH = 0.35;
/** A slam only catches someone standing on the ground, not someone jumping over it. */
const SLAM_LIFT = 1.0;

/** Everything a frame of actors needs from the world around them. */
export interface ActorWorld {
  actors: Actors;
  /** Every player the actors can notice (src/sim/ai/senses.ts). */
  foes: readonly Foe[];
  frame: number;
  /** Ground height, for where effects appear and where missiles land. */
  ground(x: number, z: number): number;
  emit(e: GameEvent): void;
  /** A slam landed here; whoever stands in it is the world's business. */
  slam(x: number, z: number, radius: number, damage: number, knock: number): void;
  /** A creature's blow or missile reached a foe, travelling along (nx, nz). What it does to them is the world's business. */
  hitFoe(id: number, damage: number, nx: number, nz: number, knock: number): void;
}

/** The training yard and the open world: one player, the rules' own events. */
export function updateActors(sim: Sim): void {
  const p = sim.player;
  const ground = (x: number, z: number): number => (sim.world.terrain ? sim.world.terrain.height(x, z) : 0);
  const hurt = (damage: number, nx: number, nz: number, knock: number): void => {
    const before = p.hp;
    sim.takeHit(damage, nx, nz, knock);
    if (p.hp < before) sim.emit({ type: 'hurt', frame: sim.frame, damage: before - p.hp, x: p.pos.x, y: p.pos.y + 1.6, z: p.pos.z });
  };
  stepActors({
    actors: sim.actors,
    foes: foesOf(sim),
    frame: sim.frame,
    ground,
    emit: (e) => sim.emit(e),
    slam: (x, z, radius, damage, knock) => {
      sim.emit({ type: 'slam', frame: sim.frame, x, y: ground(x, z), z, radius });
      const dx = p.pos.x - x;
      const dz = p.pos.z - z;
      const d = len(dx, dz);
      if (p.downFrame >= 0 || d > radius + MOVE.playerRadius) return;
      if (p.pos.y - ground(p.pos.x, p.pos.z) > SLAM_LIFT) return;
      const nx = d > 0.01 ? dx / d : Math.sin(p.facing);
      const nz = d > 0.01 ? dz / d : Math.cos(p.facing);
      hurt(damage, nx, nz, knock);
    },
    hitFoe: (id, damage, nx, nz, knock) => {
      if (id === 1) hurt(damage, nx, nz, knock);
    },
  });
}

/** Kin: the same creature in another size, or the same war-band. */
const kin = (a: Actor, o: Actor): boolean =>
  o !== a && ((a.ladder >= 0 && o.ladder === a.ladder) || (a.band !== 0 && o.band === a.band)) && isAlive(o) && !o.gone;

/** What a brain at a point sees: the nearest foe. */
function nearestAt(foes: readonly Foe[], x: number, z: number): Sighting {
  let best: Foe | undefined;
  let bestDist = Infinity;
  for (const f of foes) {
    const d = len(f.x - x, f.z - z);
    if (d < bestDist) {
      best = f;
      bestDist = d;
    }
  }
  return best ? sightingOf(best) : sightingAt(x, z, false);
}

const brainOf = (a: Actor): Behaviour | undefined => (a.brain ? behaviour(a.brain) : undefined);

/** What an actor's brain sees: a pack creature its chosen foe, anything else the nearest. */
function seeFor(foes: readonly Foe[], a: Actor): Sighting {
  if (!brainOf(a)?.pack) return nearestAt(foes, a.x, a.z);
  for (const f of foes) if (f.id === a.target) return sightingOf(f);
  return sightingAt(a.x, a.z, false);
}

/**
 * Being hit angers it, and every one of its kin close by. Called by everything that deals damage
 * (src/sim/combat/deal.ts), so a monster never needs to know what hit it.
 */
export function provoke(actors: Actors, a: Actor, amount: number): void {
  a.taken += amount;
  if (actors.calm) return;
  const anger = a.brain ? behaviour(a.brain)?.anger : undefined;
  if (!anger) return;
  a.angry = anger.frames;
  if (anger.radius <= 0) return;
  for (const o of actors.all()) {
    if (!kin(a, o) || len(o.x - a.x, o.z - a.z) > anger.radius) continue;
    const theirs = o.brain ? behaviour(o.brain)?.anger : undefined;
    if (theirs) o.angry = Math.max(o.angry, theirs.frames);
  }
}

// A creature that watches for trouble sees a foe in range of its home: it is angry, and so is
// its band near it, as if one of them had been hit.
function notice(actors: Actors, a: Actor, b: Behaviour, f: Foe | undefined): void {
  if (!b.notices || !b.anger || actors.calm || !f) return;
  if (len(f.x - a.x, f.z - a.z) > b.sight || len(f.x - a.homeX, f.z - a.homeZ) > b.leash) return;
  a.angry = b.anger.frames;
  for (const o of actors.all()) {
    if (!kin(a, o) || len(o.x - a.x, o.z - a.z) > b.anger.radius) continue;
    const theirs = o.brain ? behaviour(o.brain)?.anger : undefined;
    if (theirs) o.angry = Math.max(o.angry, theirs.frames);
  }
}

const angerOf = (a: Actor): number => (a.brain ? behaviour(a.brain)?.anger?.frames ?? 0 : 0);

export function stepActors(w: ActorWorld): void {
  const list = w.actors.all();

  // Whatever was killed since the last frame: a caller hands its call on, and anything that
  // bursts does. Spawned pieces join the end of the list and take their first step this frame.
  const before = list.length;
  for (let i = 0; i < before; i++) {
    const a = list[i];
    if (a.deadFrame !== 0 || a.gone) continue;
    if (a.calling >= 0) handOver(w, a);
    a.calling = -1;
    a.rallyTo = 0;
    burst(w, a);
  }

  // What every brain can see of the others, and how much of each creature is about.
  const peers: Peer[] = [];
  const live = LADDERS.map(() => 0);
  const budget = LADDERS.map(() => 0);
  for (const a of list) {
    if (a.ladder >= 0 && !a.transient) budget[a.ladder] += kindMass(a.homeKind);
    if (!isAlive(a) || a.gone) continue;
    peers.push({ id: a.id, x: a.x, z: a.z, radius: a.radius, ladder: a.ladder, calling: a.calling, rallyTo: a.rallyTo, group: a.group, band: a.band });
    if (a.ladder >= 0) live[a.ladder] += a.mass;
  }

  // Who each pack creature is after, whether it has noticed them, and then what its band works
  // out together.
  for (const a of list) {
    const b = brainOf(a);
    if (!b?.pack || !isAlive(a) || a.gone) continue;
    const f = pickFoe(a, w.foes, b.pack.switchAt);
    a.target = f ? f.id : 0;
    notice(w.actors, a, b, f);
  }
  stepPacks(list, w.foes);

  const ctx: BrainCtx = { peers, out: [] };
  const n = list.length;
  for (let i = 0; i < n; i++) {
    const a = list[i];
    a.flashFrame = Math.min(a.flashFrame + 1, 999);
    if (isAlive(a)) {
      if (a.angry > 0) a.angry--;
      if (a.slamCd > 0) a.slamCd--;
      if (a.gatherCd > 0) a.gatherCd--;
      for (let c = 0; c < a.cds.length; c++) if (a.cds[c] > 0) a.cds[c]--;
      if (a.calling >= 0) a.calling++;
      const calmBeyond = a.brain ? behaviour(a.brain)?.anger?.calmBeyond : undefined;
      if (a.angry > 0 && calmBeyond !== undefined && len(a.x - a.homeX, a.z - a.homeZ) > calmBeyond) {
        a.angry = 0;
        a.rallyTo = 0;
      }
      if (a.fuse > 0 && --a.fuse === 0) ctx.out.push({ t: 'fuseOut', id: a.id });
      if (a.pulled > 0) a.pulled--;
      else stepBrain(a, seeFor(w.foes, a), ctx);
    } else {
      a.deadFrame++;
      if (!a.transient) {
        // A home actor comes back where it started, if there's room for it: a pack that has grown
        // or burst into pieces has to be dealt with before the meadow fills up again.
        const k = actorKind(a.homeKind);
        if (k.respawnFrames >= 0 && a.deadFrame >= k.respawnFrames) {
          const m = k.mass ?? 0;
          if (a.ladder < 0 || live[a.ladder] + m <= budget[a.ladder]) {
            w.actors.revive(a);
            startBrain(a, nearestAt(w.foes, a.x, a.z));
            if (a.ladder >= 0) live[a.ladder] += m;
          }
        }
      }
    }
    // Props lean away from a blow and spring back; anything that never leans stays at zero.
    if (a.leanX !== 0 || a.leanZ !== 0 || a.leanVX !== 0 || a.leanVZ !== 0) {
      a.leanVX += (-LEAN.spring * a.leanX - LEAN.damping * a.leanVX) * STEP;
      a.leanVZ += (-LEAN.spring * a.leanZ - LEAN.damping * a.leanVZ) * STEP;
      a.leanX += a.leanVX * STEP;
      a.leanZ += a.leanVZ * STEP;
    }
  }

  // What the brains asked for, in the order they asked.
  for (const r of ctx.out) {
    const a = w.actors.get(r.id);
    if (!a || !isAlive(a) || a.gone) continue;
    if (r.t === 'call') call(w, a);
    else if (r.t === 'pull') pull(w, a);
    else if (r.t === 'absorb') absorb(w, a);
    else if (r.t === 'slam') {
      const s = findKind(a.kind)?.slam;
      if (s) w.slam(a.x, a.z, s.radius, s.damage, s.knock);
    } else if (r.t === 'gatherStart') {
      const radius = a.brain ? behaviour(a.brain)?.gather?.radius ?? 0 : 0;
      w.emit({ type: 'gatherStart', frame: w.frame, id: a.id, x: a.x, y: w.ground(a.x, a.z), z: a.z, radius });
    } else if (r.t === 'broke') {
      w.emit({ type: 'gatherBroken', frame: w.frame, id: a.id, x: a.x, y: w.ground(a.x, a.z) + a.hitHeight, z: a.z });
    } else if (r.t === 'fuseOut') fuseOut(w, a);
    else if (r.t === 'strike') strikeFoes(w, a, r.attack);
    else if (r.t === 'throw') throwAt(w, a, r.attack);
    else if (r.t === 'heal') heal(w, a);
  }

  // Everything thrown, in flight.
  stepMissiles(w.actors, {
    foes: w.foes,
    ground: w.ground,
    hit: (m, f, nx, nz) => w.hitFoe(f.id, m.damage, nx, nz, m.knock),
    land: (m) => w.emit({ type: 'missileLand', frame: w.frame, x: m.x, y: m.y, z: m.z }),
  });

  // A rally ends when its caller stops calling, whatever the reason.
  for (const a of list) {
    if (a.rallyTo === 0) continue;
    const c = w.actors.get(a.rallyTo);
    if (!c || !isAlive(c) || c.gone || c.calling < 0) a.rallyTo = 0;
  }

  w.actors.removeWhere((a) => a.transient && (a.gone || a.deadFrame >= CLEAR_AFTER));
}

// A strike lands: every foe in the cone in front of it and in reach, unless they are jumping
// clear of it or in a dodge's untouchable frames.
function strikeFoes(w: ActorWorld, a: Actor, id: string): void {
  const atk = attackDef(id);
  if (!atk) return;
  const reach = (atk.reach ?? 0) + MOVE.playerRadius;
  const half = ((atk.arc ?? 0) / 2) * DEG;
  for (const f of w.foes) {
    if (f.invuln) continue;
    const dx = f.x - a.x;
    const dz = f.z - a.z;
    const d = len(dx, dz);
    if (d > reach) continue;
    if (Math.abs(angleDiff(a.facing, Math.atan2(dx, dz))) > half && d > MOVE.playerRadius + 0.3) continue;
    if (atk.lift !== undefined && f.air > atk.lift) continue;
    const nx = d > 0.01 ? dx / d : Math.sin(a.facing);
    const nz = d > 0.01 ? dz / d : Math.cos(a.facing);
    w.hitFoe(f.id, atk.damage, nx, nz, atk.knock);
  }
}

// A throw lets go: at the foe it is after, or the nearest.
function throwAt(w: ActorWorld, a: Actor, id: string): void {
  const atk = attackDef(id);
  if (!atk) return;
  let foe: Foe | undefined;
  for (const f of w.foes) if (f.id === a.target) foe = f;
  if (!foe) {
    let bestDist = Infinity;
    for (const f of w.foes) {
      const d = len(f.x - a.x, f.z - a.z);
      if (d < bestDist) {
        foe = f;
        bestDist = d;
      }
    }
  }
  if (foe) launch(w.actors, a, atk, attackIndex(id), foe, w.ground(a.x, a.z));
}

// A drink went down: it is back on its feet by its brain's heal.
function heal(w: ActorWorld, a: Actor): void {
  const h = a.brain ? behaviour(a.brain)?.heal : undefined;
  if (!h) return;
  const was = a.hp;
  a.hp = Math.min(a.maxHp, a.hp + h.amount * a.maxHp);
  w.emit({ type: 'actorHeal', frame: w.frame, id: a.id, x: a.x, y: w.ground(a.x, a.z) + a.hitHeight, z: a.z, amount: a.hp - was });
}

// The caller fell: the nearest of those rallying to it that could gather takes the call over, and
// the rest follow the new one. With nobody able to, they just fight.
function handOver(w: ActorWorld, dead: Actor): void {
  let next: Actor | undefined;
  let nextDist = Infinity;
  for (const o of w.actors.all()) {
    if (o.rallyTo !== dead.id || !isAlive(o) || o.gone || o.gatherCd > 0) continue;
    const b = o.brain ? behaviour(o.brain) : undefined;
    if (!b?.call || !b.gather || !findKind(o.kind)?.gathers) continue;
    const d = len(o.x - dead.x, o.z - dead.z);
    if (d < nextDist) {
      next = o;
      nextDist = d;
    }
  }
  for (const o of w.actors.all()) if (o.rallyTo === dead.id) o.rallyTo = next && o !== next ? next.id : 0;
  if (!next) return;
  next.calling = 0;
  forceState(next, 'call', nearestAt(w.foes, next.x, next.z));
}

// Dying into pieces: they scatter, and have the fuse to be killed in before they reform.
function burst(w: ActorWorld, a: Actor): void {
  const k = findKind(a.kind);
  const lad = LADDERS[a.ladder];
  if (!k?.burst || !lad) return;
  let living = 0;
  for (const o of w.actors.all()) if (o.ladder === a.ladder && isAlive(o) && !o.gone) living++;
  const count = Math.min(k.burst.count, Math.max(0, lad.cap - living));
  if (count <= 0) return;
  const group = w.actors.newGroup();
  const reform = sizeUp(a.kind);
  const base = draw(a) * Math.PI * 2;
  const seen = nearestAt(w.foes, a.x, a.z);
  for (let i = 0; i < count; i++) {
    const seed = (a.seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
    const c = w.actors.spawn({ kind: k.burst.into, x: a.x, z: a.z, seed });
    c.transient = true;
    c.group = group;
    c.fuse = lad.fuse;
    c.reform = reform;
    c.angry = angerOf(c);
    const angle = base + (i * Math.PI * 2) / count;
    c.moveX = Math.sin(angle);
    c.moveZ = Math.cos(angle);
    c.stride = 2 + draw(c);
    startBrain(c, seen);
  }
  w.emit({ type: 'actorBurst', frame: w.frame, kind: a.kind, count, x: a.x, y: w.ground(a.x, a.z) + a.hitHeight, z: a.z });
}

// The pack hears the call: every one of its kin close enough that isn't busy comes running.
function call(w: ActorWorld, caller: Actor): void {
  const c = caller.brain ? behaviour(caller.brain)?.call : undefined;
  if (!c) return;
  for (const o of w.actors.all()) {
    if (!kin(caller, o) || o.group !== 0 || o.calling >= 0) continue;
    if (o.rallyTo !== 0 && o.rallyTo !== caller.id) continue;
    if (len(o.x - caller.x, o.z - caller.z) > c.radius) continue;
    o.rallyTo = caller.id;
    o.angry = Math.max(o.angry, angerOf(o));
  }
  w.emit({ type: 'actorCall', frame: w.frame, id: caller.id, x: caller.x, y: w.ground(caller.x, caller.z), z: caller.z, radius: c.radius });
}

// A frame of gathering: every one of its kin inside the swirl slides in until it touches.
function pull(w: ActorWorld, caster: Actor): void {
  const g = caster.brain ? behaviour(caster.brain)?.gather : undefined;
  if (!g) return;
  for (const o of w.actors.all()) {
    if (!kin(caster, o)) continue;
    const dx = o.x - caster.x;
    const dz = o.z - caster.z;
    const d = len(dx, dz);
    if (d > g.radius) continue;
    const touch = caster.radius + o.radius + 0.1;
    if (d > touch) {
      const step = Math.min(g.pull * STEP, d - touch);
      o.x -= (dx / d) * step;
      o.z -= (dz / d) * step;
    }
    if (o.pulled === 0) restState(o);
    o.pulled = 2;
  }
}

// The cast is done: everything touching it is taken in, and it grows if that's enough.
function absorb(w: ActorWorld, caster: Actor): void {
  let gained = 0;
  let healed = 0;
  for (const o of w.actors.all()) {
    if (!kin(caster, o)) continue;
    if (len(o.x - caster.x, o.z - caster.z) > caster.radius + o.radius + TOUCH) continue;
    gained += o.mass;
    healed += o.hp;
    takeOut(o);
    w.emit({ type: 'actorAbsorbed', frame: w.frame, x: o.x, y: w.ground(o.x, o.z) + o.hitHeight, z: o.z, toX: caster.x, toZ: caster.z });
  }
  if (gained <= 0) return;
  caster.mass += gained;
  const size = sizeFor(caster.ladder, caster.mass);
  if (size && kindMass(size) > kindMass(caster.kind)) {
    becomeKind(caster, actorKind(size));
    caster.hp = caster.maxHp;
    w.emit({ type: 'actorGrow', frame: w.frame, id: caster.id, kind: caster.kind, x: caster.x, y: w.ground(caster.x, caster.z), z: caster.z });
  } else {
    caster.hp = Math.min(caster.maxHp, caster.hp + healed);
  }
}

/** Out of the world without dying: no death, no burst, and a home actor waits to respawn. */
function takeOut(o: Actor): void {
  o.gone = true;
  o.hp = 0;
  o.deadFrame = 0;
  o.rallyTo = 0;
  o.calling = -1;
  o.pulled = 0;
  o.group = 0;
  o.fuse = -1;
}

// A fuse ran out. Two or more of the group left: they come back together, one size up from what
// was killed. One left: it's alone, and dissolves in a while. Alone already: it's gone.
function fuseOut(w: ActorWorld, a: Actor): void {
  if (a.group === 0) {
    if (a.reform === '') {
      a.hp = 0;
      a.deadFrame = 0;
      w.emit({ type: 'actorDie', frame: w.frame, id: a.id, kind: a.kind, x: a.x, y: w.ground(a.x, a.z) + a.hitHeight, z: a.z, killed: false });
    }
    return;
  }
  const group = a.group;
  const members = w.actors.all().filter((o) => o.group === group && isAlive(o) && !o.gone);
  if (members.length < 2) {
    for (const m of members) {
      m.group = 0;
      m.reform = '';
      m.fuse = LADDERS[m.ladder]?.alone ?? -1;
    }
    return;
  }
  let x = 0;
  let z = 0;
  for (const m of members) {
    x += m.x;
    z += m.z;
  }
  x /= members.length;
  z /= members.length;
  const into = members[0].reform;
  const seed = (members[0].seed ^ 0x5bd1e995) >>> 0;
  for (const m of members) takeOut(m);
  if (!findKind(into)) return;
  const c = w.actors.spawn({ kind: into, x, z, seed });
  c.transient = true;
  c.angry = angerOf(c);
  c.gatherCd = Math.floor((c.brain ? behaviour(c.brain)?.gather?.cooldown ?? 0 : 0) / 2);
  startBrain(c, nearestAt(w.foes, x, z));
  w.emit({ type: 'actorGrow', frame: w.frame, id: c.id, kind: c.kind, x, y: w.ground(x, z), z });
}
