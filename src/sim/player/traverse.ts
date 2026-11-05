// Getting around an open world: walking over hills (and not up cliffs), wading and swimming, and
// flying a glider. The flat training grounds never come here - integrate() in locomotion.ts only
// hands over when the world has terrain - so the server-mirrored rules stay exactly as they were.

import type { Sim } from '../sim';
import { ATTACK, JUMP, STEP, comboFor } from '../../tuning';
import { GLIDE, GROUND, SWIM } from '../../content/traversal';
import { CARRY } from '../../content/trade';
import { glider as gliderDef } from '../../content/vehicles';
import { groundAt, inRect, pushOutOfBox } from '../zone/colliders';
import { isAlive } from '../actor';
import { angleDiff, len, turnToward } from '../math';
import { MOVE } from '../../tuning';
import type { Actions, PlayerState } from '../types';
import type { Updraft } from '../zone/types';

const TAU = Math.PI * 2;

// ---------- Integration over terrain ----------

export function integrateOpen(sim: Sim): void {
  const p = sim.player;
  const hf = sim.world.terrain!;
  if (p.gustFrames > 0) p.gustFrames--;
  if (p.mode === 'ride') return; // the vehicle put us in our seat

  if (!p.grounded && p.mode !== 'swim' && p.mode !== 'glide') {
    let g = p.vel.y > 0 ? JUMP.gravityUp : JUMP.gravityDown;
    if (p.mode === 'attack') {
      const step = comboFor(p.weapon, sim.stats)[p.attackIndex];
      if (p.attackFrame <= step.startup + step.active) g *= ATTACK.airGravityScale;
    }
    p.vel.y = Math.max(-JUMP.maxFall, p.vel.y - g * STEP);
  }

  const ox = p.pos.x;
  const oz = p.pos.z;
  let dx = p.vel.x * STEP;
  let dz = p.vel.z * STEP;
  // Wading is about how deep your feet are, not the seabed: on a pier you walk normally.
  if (p.grounded && hf.water - p.pos.y > GROUND.wadeDepth) {
    dx *= GROUND.wadeSpeed;
    dz *= GROUND.wadeSpeed;
  }
  p.pos.y += p.vel.y * STEP;

  // The land as a wall: try the whole move, then slide along whichever axis is free.
  if (blocked(sim, ox, oz, ox + dx, oz + dz)) {
    if (!blocked(sim, ox, oz, ox + dx, oz)) {
      dz = 0;
      p.vel.z = 0;
    } else if (!blocked(sim, ox, oz, ox, oz + dz)) {
      dx = 0;
      p.vel.x = 0;
    } else {
      dx = 0;
      dz = 0;
      p.vel.x = 0;
      p.vel.z = 0;
      if (p.mode === 'glide') closeGlider(sim, 'crash');
    }
  }
  p.pos.x = ox + dx;
  p.pos.z = oz + dz;

  collideOpen(sim);
  settle(sim);
  if (p.grounded && p.mode === 'normal') p.runPhase += len(p.vel.x, p.vel.z) * STEP;
}

// ---------- Decks ----------
// A deck (a pier, the glider launch, a house floor) is ground on top and open underneath. Walking,
// you step up onto one as high as deckStep (they are built to be walked onto); in the air, only
// within the usual stepUp, as you land. One you can't get onto, and too low to pass under, is as
// solid as a wall from the side.

/** How high a deck you can get onto right now: walking, a deck's own step; in the air, as you land. */
export const deckReach = (p: PlayerState): number => (p.grounded ? GROUND.deckStep : GROUND.stepUp);

/** Whether a deck topped at `top` is in the way of feet at `y` that get `reach` up: too high to get onto, too low to pass under. */
export const deckInTheWay = (top: number, y: number, reach: number): boolean => top > y + reach && top < y + GROUND.deckHeadroom;

/**
 * Would the move carry you into a deck in your way? collideOpen keeps you off their edges; this
 * stops anything fast enough to cross one in a single step.
 */
function intoDeck(sim: Sim, ox: number, oz: number, nx: number, nz: number, reach: number): boolean {
  const y = sim.player.pos.y;
  let hit = false;
  sim.world.index?.eachDeck(nx, nz, 0.5, (d) => {
    if (!hit && deckInTheWay(d.top, y, reach) && inRect(d, nx, nz) && !inRect(d, ox, oz)) hit = true;
  });
  return hit;
}

/** Would moving from (ox, oz) to (nx, nz) walk into a cliff, a wall of rock, a deck's side, or a ledge too high? */
function blocked(sim: Sim, ox: number, oz: number, nx: number, nz: number): boolean {
  const p = sim.player;
  const run = Math.hypot(nx - ox, nz - oz);
  if (run < 1e-7) return false;
  const hf = sim.world.terrain!;
  const reach = deckReach(p);
  if (intoDeck(sim, ox, oz, nx, nz, reach)) return true;
  const terrain = hf.height(nx, nz);
  const ground = groundAt(hf, sim.world.index, nx, nz, p.pos.y, GROUND.stepUp, reach);
  const rise = ground - p.pos.y;
  if (rise <= 0.02) return false;
  if (ground > terrain + 0.01) return false; // a deck or a box top, low enough to step up onto
  if (rise > GROUND.stepUp) return true;
  // Climbing the terrain itself: only up slopes gentle enough to walk.
  return p.grounded && hf.slope(nx, nz) > GROUND.maxSlope;
}

/** Trees, rocks, buildings, solid creatures, and the edge of the world. */
export function collideOpen(sim: Sim): void {
  const p = sim.player;
  const idx = sim.world.index;
  const r = MOVE.playerRadius;
  if (idx) {
    idx.eachObstacle(p.pos.x, p.pos.z, r + 2, (o) => {
      if (o.r <= 0) return;
      const ox = p.pos.x - o.x;
      const oz = p.pos.z - o.z;
      const min = o.r + r;
      const d2 = ox * ox + oz * oz;
      if (d2 >= min * min) return;
      const d = Math.sqrt(d2) || 0.0001;
      const nx = ox / d;
      const nz = oz / d;
      p.pos.x = o.x + nx * min;
      p.pos.z = o.z + nz * min;
      const vn = p.vel.x * nx + p.vel.z * nz;
      if (vn < 0) {
        p.vel.x -= vn * nx;
        p.vel.z -= vn * nz;
      }
    });
    idx.eachBox(p.pos.x, p.pos.z, r + 1, (b) => {
      if (p.pos.y >= b.top - 0.05) return; // standing on it, or flying over
      const push = pushOutOfBox(b, p.pos.x, p.pos.z, r);
      if (!push) return;
      p.pos.x += push.x;
      p.pos.z += push.z;
      const l = Math.hypot(push.x, push.z) || 1;
      const nx = push.x / l;
      const nz = push.z / l;
      const vn = p.vel.x * nx + p.vel.z * nz;
      if (vn < 0) {
        p.vel.x -= vn * nx;
        p.vel.z -= vn * nz;
      }
    });
    // A deck's side, where it is too high to get onto and too low to pass under. Already beneath
    // one (wading under a pier), you carry on.
    const reach = deckReach(p);
    idx.eachDeck(p.pos.x, p.pos.z, r + 1, (d) => {
      if (!deckInTheWay(d.top, p.pos.y, reach) || inRect(d, p.pos.x, p.pos.z)) return;
      const push = pushOutOfBox(d, p.pos.x, p.pos.z, r);
      if (!push) return;
      p.pos.x += push.x;
      p.pos.z += push.z;
      const l = Math.hypot(push.x, push.z) || 1;
      const nx = push.x / l;
      const nz = push.z / l;
      const vn = p.vel.x * nx + p.vel.z * nz;
      if (vn < 0) {
        p.vel.x -= vn * nx;
        p.vel.z -= vn * nz;
      }
    });
  }
  if (sim.opts.training && p.mode !== 'glide') {
    const feet = p.pos.y;
    for (const a of sim.actors.all()) {
      if (!a.solid || !isAlive(a)) continue;
      const ay = sim.world.terrain!.height(a.x, a.z) + a.y;
      if (feet > ay + 1.8) continue;
      const ox = p.pos.x - a.x;
      const oz = p.pos.z - a.z;
      const min = a.radius + r;
      const d2 = ox * ox + oz * oz;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2) || 0.0001;
      p.pos.x = a.x + (ox / d) * min;
      p.pos.z = a.z + (oz / d) * min;
    }
  }
  const lim = sim.world.radius;
  const rr = len(p.pos.x, p.pos.z);
  if (rr > lim) {
    p.pos.x *= lim / rr;
    p.pos.z *= lim / rr;
  }
}

/** Ground contact after moving: stay on it, step off it, land on it, or fall into the sea. */
function settle(sim: Sim): void {
  const p = sim.player;
  const hf = sim.world.terrain!;
  const ground = groundAt(hf, sim.world.index, p.pos.x, p.pos.z, p.pos.y, GROUND.stepUp, deckReach(p));
  if (p.mode === 'swim') return; // updateSwim keeps you at the surface
  if (p.grounded) {
    const speed = len(p.vel.x, p.vel.z);
    const drop = p.pos.y - ground;
    const snap = GROUND.snapDown + speed * STEP * GROUND.maxSlope * 1.2;
    if (drop > snap) {
      p.grounded = false; // walked off an edge
    } else {
      p.pos.y = ground;
      p.vel.y = 0;
      // Too steep to stand on (you landed on a cliff face): slide off it.
      if (ground <= hf.height(p.pos.x, p.pos.z) + 0.01 && hf.slope(p.pos.x, p.pos.z) > GROUND.maxSlope + 0.35) {
        const g = hf.gradient(p.pos.x, p.pos.z);
        p.grounded = false;
        p.vel.x -= g.x * 2.5;
        p.vel.z -= g.z * 2.5;
      }
    }
  } else if (p.pos.y <= ground && p.vel.y <= 0) {
    const wasGliding = p.mode === 'glide';
    p.grounded = true;
    p.jumpsUsed = 0;
    p.flipFrame = -1;
    p.landFrame = 0;
    p.landImpact = Math.min(1, -p.vel.y / 20);
    sim.emit({ type: 'land', frame: sim.frame, x: p.pos.x, y: ground, z: p.pos.z, impact: p.landImpact });
    p.pos.y = ground;
    p.vel.y = 0;
    if (wasGliding) {
      closeGlider(sim, 'land');
      p.vel.x *= GLIDE.landKeep;
      p.vel.z *= GLIDE.landKeep;
    }
  }
  // Deep water: swim.
  if (p.mode !== 'ride' && hf.water - hf.height(p.pos.x, p.pos.z) > SWIM.depth && p.pos.y <= hf.water - SWIM.float + 0.02) {
    enterSwim(sim);
  }
}

// ---------- Swimming ----------

function enterSwim(sim: Sim): void {
  const p = sim.player;
  const hf = sim.world.terrain!;
  if (p.mode === 'glide') closeGlider(sim, 'water');
  const speed = Math.max(Math.abs(p.vel.y), len(p.vel.x, p.vel.z));
  p.mode = 'swim';
  p.modeFrame = 0;
  p.grounded = false;
  p.jumpsUsed = 0;
  p.flipFrame = -1;
  p.vel.y = 0;
  p.pos.y = hf.water - SWIM.float;
  p.vel.x *= 0.35;
  p.vel.z *= 0.35;
  sim.emit({ type: 'splash', frame: sim.frame, x: p.pos.x, y: hf.water, z: p.pos.z, speed });
}

export function updateSwim(sim: Sim, a: Actions): void {
  const p = sim.player;
  const hf = sim.world.terrain!;
  p.modeFrame++;
  const mag = Math.min(1, len(a.moveX, a.moveZ));
  const dx = mag > 0.05 ? a.moveX / len(a.moveX, a.moveZ) : 0;
  const dz = mag > 0.05 ? a.moveZ / len(a.moveX, a.moveZ) : 0;
  let speed = (a.sprintHeld ? SWIM.sprintSpeed : SWIM.speed) * (mag > 0.05 ? mag : 0);
  if (p.pack) speed *= CARRY.swimFactor;
  p.sprinting = a.sprintHeld && mag > 0.5;
  if (mag > 0.05) p.facing = turnToward(p.facing, Math.atan2(dx, dz), SWIM.turnSpeed * STEP);
  const tx = dx * speed;
  const tz = dz * speed;
  const ex = tx - p.vel.x;
  const ez = tz - p.vel.z;
  const err = len(ex, ez);
  const step = SWIM.accel * STEP;
  if (err <= step) {
    p.vel.x = tx;
    p.vel.z = tz;
  } else {
    p.vel.x += (ex / err) * step;
    p.vel.z += (ez / err) * step;
  }
  p.vel.y = 0;
  p.pos.y = hf.water - SWIM.float + Math.sin(p.modeFrame * 0.09) * 0.04;

  // Shallow enough to stand: walk out.
  const under = groundAt(hf, sim.world.index, p.pos.x, p.pos.z, p.pos.y, GROUND.stepUp);
  if (hf.water - under < SWIM.depth - 0.1) {
    p.mode = 'normal';
    p.grounded = true;
    p.pos.y = Math.max(p.pos.y, under);
    return;
  }
  // Jump at an edge (a dock, a steep bank) to haul yourself out.
  if (p.jumpBuffer > 0) {
    const ax = p.pos.x + Math.sin(p.facing) * 1.2;
    const az = p.pos.z + Math.cos(p.facing) * 1.2;
    const ahead = groundAt(hf, sim.world.index, ax, az, hf.water + 2.2, 2.2);
    if (ahead > hf.water - 0.6 && ahead < hf.water + 2.2) {
      p.jumpBuffer = 0;
      p.mode = 'normal';
      p.grounded = false;
      p.jumpsUsed = 1;
      p.vel.y = SWIM.climbOut;
      p.vel.x = Math.sin(p.facing) * 3;
      p.vel.z = Math.cos(p.facing) * 3;
      sim.emit({ type: 'jump', frame: sim.frame, x: p.pos.x, y: p.pos.y, z: p.pos.z });
    }
  }
}

// ---------- Gliding ----------

/** Height of your feet above whatever is under you (water counts as a floor). */
export function heightAboveGround(sim: Sim): number {
  const p = sim.player;
  const hf = sim.world.terrain;
  if (!hf) return p.pos.y;
  const g = Math.max(hf.water, groundAt(hf, sim.world.index, p.pos.x, p.pos.z, p.pos.y, 0));
  return p.pos.y - g;
}

/** Why the glider will not open right now, or null if it will. */
export function gliderBlocked(sim: Sim): string | null {
  const p = sim.player;
  if (!sim.world.terrain) return 'no sky here';
  if (!p.glider) return 'You have no glider';
  if (p.pack) return 'Too heavy to glide with a trade pack';
  if (p.grounded) return 'Jump first';
  if (p.mode !== 'normal') return 'Busy';
  if (heightAboveGround(sim) < gliderDef(p.glider).minHeight) return 'Too low to open the glider';
  return null;
}

export function openGlider(sim: Sim): boolean {
  const p = sim.player;
  if (gliderBlocked(sim)) return false;
  const g = gliderDef(p.glider);
  p.mode = 'glide';
  p.modeFrame = 0;
  p.jumpBuffer = 0;
  p.flipFrame = -1;
  p.sprinting = false;
  p.crouching = false;
  p.airspeed = Math.max(len(p.vel.x, p.vel.z), g.flareSpeed);
  const hs = len(p.vel.x, p.vel.z);
  if (hs > 0.5) p.facing = Math.atan2(p.vel.x, p.vel.z);
  sim.emit({ type: 'glideOpen', frame: sim.frame, x: p.pos.x, y: p.pos.y, z: p.pos.z });
  return true;
}

export function closeGlider(sim: Sim, _why: 'fold' | 'land' | 'crash' | 'water'): void {
  const p = sim.player;
  if (p.mode !== 'glide') return;
  p.mode = 'normal';
  p.modeFrame = 0;
  p.bank = 0;
  // Folding mid-air still lets you double jump once more before you need to open it again.
  if (!p.grounded) p.jumpsUsed = 1;
  sim.emit({ type: 'glideClose', frame: sim.frame, x: p.pos.x, y: p.pos.y, z: p.pos.z });
}

/** Climb rate from rising air at a point. */
export function updraftLift(updrafts: readonly Updraft[], x: number, y: number, z: number): number {
  let lift = 0;
  for (const u of updrafts) {
    const d = Math.hypot(x - u.x, z - u.z);
    if (d >= u.r || y >= u.top) continue;
    const core = 1 - (d / u.r) * (d / u.r);
    const cap = Math.min(1, (u.top - y) / 18);
    lift += u.strength * core * cap;
  }
  return lift;
}

/** F in flight: the glider's gust, a burst of speed and lift. Returns false while it recharges. */
export function gust(sim: Sim): boolean {
  const p = sim.player;
  if (p.mode !== 'glide' || p.gustFrames > 0) return false;
  const g = gliderDef(p.glider);
  if (!g.gust) return false;
  p.airspeed += g.gust.speed;
  p.vel.y = Math.max(p.vel.y, 0) + g.gust.lift;
  p.gustFrames = Math.round(g.gust.cooldownSeconds / STEP);
  sim.emit({ type: 'glideOpen', frame: sim.frame, x: p.pos.x, y: p.pos.y, z: p.pos.z });
  return true;
}

export function updateGlide(sim: Sim, a: Actions): void {
  const p = sim.player;
  const g = gliderDef(p.glider);
  p.modeFrame++;

  // Press jump again to fold the wing and drop. A fresh press only: one buffered from just before
  // the wing opened must not fold it again a moment later.
  if (a.jumpPressed && p.modeFrame > GLIDE.openFrames) {
    p.jumpBuffer = 0;
    closeGlider(sim, 'fold');
    return;
  }

  // Attitude: dive for speed, flare to slow down and bleed speed into height.
  const dive = a.sprintHeld;
  const flare = a.crouchHeld && !dive;
  const targetSpeed = dive ? g.diveSpeed : flare ? g.flareSpeed : g.cruiseSpeed;
  const targetSink = dive ? g.diveSink : flare ? g.flareSink : g.sink;

  // Heading: turn toward where the stick points, no faster than the wing allows.
  const mag = Math.min(1, len(a.moveX, a.moveZ));
  let turn = 0;
  if (mag > 0.15) {
    const want = Math.atan2(a.moveX, a.moveZ);
    const diff = angleDiff(p.facing, want);
    turn = Math.max(-g.turnRate, Math.min(g.turnRate, diff * GLIDE.turnEase)) * mag;
  }
  p.facing = p.facing + turn * STEP;
  if (p.facing > Math.PI) p.facing -= TAU;
  if (p.facing < -Math.PI) p.facing += TAU;
  const bankWant = (turn / g.turnRate) * GLIDE.maxBank;
  p.bank += (bankWant - p.bank) * (1 - Math.exp(-6 * STEP));

  const prev = p.airspeed;
  p.airspeed += (targetSpeed - p.airspeed) * (1 - Math.exp(-g.speedEase * STEP));
  let vy = -targetSink;
  // Speed shed by a flare comes back as height, the way a swallow pulls up out of a dive.
  const shed = prev - p.airspeed;
  if (shed > 0) vy += ((prev * shed) / STEP / 9.81) * g.zoomLift;
  if (p.airspeed < g.stallSpeed) vy -= (g.stallSpeed - p.airspeed) * 2;
  vy += updraftLift(sim.world.zone?.recipe.updrafts ?? [], p.pos.x, p.pos.y, p.pos.z);
  p.vel.y += (vy - p.vel.y) * (1 - Math.exp(-GLIDE.verticalEase * STEP));
  p.vel.x = Math.sin(p.facing) * p.airspeed;
  p.vel.z = Math.cos(p.facing) * p.airspeed;
}
