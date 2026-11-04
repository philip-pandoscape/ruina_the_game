// One frame for every actor in the world: its brain, its lean, bringing it back when it has been
// dead long enough, and everything a pack of them does together - a dying one bursting into
// pieces, a caller gathering the others in, a burst group reforming one size up.
// server/src/actors.rs runs the same frame the same way; tests/ai-conformance.spec.ts compares
// whole packs of them frame by frame.

import type { Sim } from '../sim';
import type { GameEvent } from '../types';
import { LEAN, MOVE, STEP } from '../../tuning';
import { actorKind, findKind, kindMass, LADDERS, sizeFor, sizeUp } from '../../content/actors';
import { becomeKind, isAlive, type Actor, type Actors } from '../actor';
import { behaviour, draw, forceState, restState, startBrain, stepBrain, type BrainCtx, type Peer, type Sighting } from '../ai/brain';
import { len } from '../math';

/** Frames a dead piece of a burst lies there (its death clip plays out) before it is cleared away. */
const CLEAR_AFTER = 60;
/** How close to a gatherer something has to be pulled before it is taken in. */
const TOUCH = 0.35;
/** A slam only catches someone standing on the ground, not someone jumping over it. */
const SLAM_LIFT = 1.0;

/** Everything a frame of actors needs from the world around them. */
export interface ActorWorld {
  actors: Actors;
  seen: Sighting;
  frame: number;
  /** Ground height, for where effects appear. */
  ground(x: number, z: number): number;
  emit(e: GameEvent): void;
  /** A slam landed here; whoever stands in it is the world's business. */
  slam(x: number, z: number, radius: number, damage: number, knock: number): void;
}

/** The training yard and the open world: one player, the rules' own events. */
export function updateActors(sim: Sim): void {
  const p = sim.player;
  const ground = (x: number, z: number): number => (sim.world.terrain ? sim.world.terrain.height(x, z) : 0);
  stepActors({
    actors: sim.actors,
    seen: sim.sighting(),
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
      const before = p.hp;
      sim.takeHit(damage, nx, nz, knock);
      if (p.hp < before) sim.emit({ type: 'hurt', frame: sim.frame, damage: before - p.hp, x: p.pos.x, y: p.pos.y + 1.6, z: p.pos.z });
    },
  });
}

const kin = (a: Actor, o: Actor): boolean => o !== a && a.ladder >= 0 && o.ladder === a.ladder && isAlive(o) && !o.gone;

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
    peers.push({ id: a.id, x: a.x, z: a.z, radius: a.radius, ladder: a.ladder, calling: a.calling, rallyTo: a.rallyTo, group: a.group });
    if (a.ladder >= 0) live[a.ladder] += a.mass;
  }

  const ctx: BrainCtx = { peers, out: [] };
  const n = list.length;
  for (let i = 0; i < n; i++) {
    const a = list[i];
    a.flashFrame = Math.min(a.flashFrame + 1, 999);
    if (isAlive(a)) {
      if (a.angry > 0) a.angry--;
      if (a.slamCd > 0) a.slamCd--;
      if (a.gatherCd > 0) a.gatherCd--;
      if (a.calling >= 0) a.calling++;
      const calmBeyond = a.brain ? behaviour(a.brain)?.anger?.calmBeyond : undefined;
      if (a.angry > 0 && calmBeyond !== undefined && len(a.x - a.homeX, a.z - a.homeZ) > calmBeyond) {
        a.angry = 0;
        a.rallyTo = 0;
      }
      if (a.fuse > 0 && --a.fuse === 0) ctx.out.push({ t: 'fuseOut', id: a.id });
      if (a.pulled > 0) a.pulled--;
      else stepBrain(a, w.seen, ctx);
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
            startBrain(a, w.seen);
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
  }

  // A rally ends when its caller stops calling, whatever the reason.
  for (const a of list) {
    if (a.rallyTo === 0) continue;
    const c = w.actors.get(a.rallyTo);
    if (!c || !isAlive(c) || c.gone || c.calling < 0) a.rallyTo = 0;
  }

  w.actors.removeWhere((a) => a.transient && (a.gone || a.deadFrame >= CLEAR_AFTER));
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
  forceState(next, 'call', w.seen);
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
    startBrain(c, w.seen);
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
  startBrain(c, w.seen);
  w.emit({ type: 'actorGrow', frame: w.frame, id: c.id, kind: c.kind, x, y: w.ground(x, z), z });
}
