// How the player moves: the stick, jumps, acceleration, gravity and what it bumps into.
// These are systems over one shared PlayerState rather than independent modules - the state
// is a single blob by nature, and splitting it apart would only scatter it.

import type { Sim } from '../sim';
import { startAttack } from './attacks';
import { readyBufferedAction, readyMovement, readySlot, startAction, startCast } from './abilities';
import { ATTACK, JUMP, MOVE, NO_MOVEMENT, STEP, comboFor } from '../../content/tuning';
import { len, turnToward } from '../math';
import { CARRY } from '../../content/trade';
import { integrateOpen } from './traverse';
import { isAlive } from '../actor';
import type { Actions } from '../types';

export function input(_sim: Sim, a: Actions): { dx: number; dz: number; mag: number } {
  const mag = Math.min(1, len(a.moveX, a.moveZ));
  if (mag < 0.05) return { dx: 0, dz: 0, mag: 0 };
  const l = len(a.moveX, a.moveZ);
  return { dx: a.moveX / l, dz: a.moveZ / l, mag };
}

/**
 * Combat stance: the heading to keep facing while fighting, so the stick strafes, backs off and
 * dodges in any direction instead of turning you; null to face the way you move. Sprinting always
 * runs free.
 */
export function stance(sim: Sim, a: Actions): number | null {
  if (sim.player.sprinting || len(a.faceX, a.faceZ) < 0.5) return null;
  return Math.atan2(a.faceX, a.faceZ);
}

/** Share of full speed when moving along (dx, dz) while facing `facing`: all of it straight ahead,
 * strafeSpeed sideways, backSpeed backing away, blended in between. */
export function stanceSpeed(facing: number, dx: number, dz: number): number {
  const ahead = dx * Math.sin(facing) + dz * Math.cos(facing);
  return ahead >= 0 ? MOVE.strafeSpeed + (1 - MOVE.strafeSpeed) * ahead : MOVE.strafeSpeed + (MOVE.backSpeed - MOVE.strafeSpeed) * -ahead;
}

export function tryJump(sim: Sim, a: Actions): boolean {
  const p = sim.player;
  if (p.jumpBuffer <= 0) return false;
  if (p.grounded || p.coyote > 0) {
    p.vel.y = p.pack ? JUMP.velocity * CARRY.jumpFactor : JUMP.velocity;
    p.grounded = false;
    p.coyote = 0;
    p.jumpsUsed = 1;
    p.jumpCutDone = false;
    p.jumpBuffer = 0;
    p.takeoffFrame = 0;
    sim.emit({ type: 'jump', frame: sim.frame, x: p.pos.x, y: p.pos.y, z: p.pos.z });
    return true;
  }
  // A trade pack on your back is too heavy for the second jump.
  if (p.jumpsUsed < 2 && !p.pack) {
    p.vel.y = JUMP.doubleJumpVelocity;
    p.jumpsUsed = 2;
    p.jumpCutDone = true;
    p.jumpBuffer = 0;
    p.flipFrame = 0;
    const { dx, dz, mag } = input(sim, a);
    if (mag > 0) {
      // Like a platform fighter, the double jump lets you change direction instantly. Fighting,
      // you keep facing the fight and flip whichever way you jumped.
      const s = JUMP.doubleJumpSteer * MOVE.runSpeed * mag;
      p.vel.x = dx * s;
      p.vel.z = dz * s;
      if (stance(sim, a) === null) p.facing = Math.atan2(dx, dz);
    }
    sim.emit({ type: 'doubleJump', frame: sim.frame, x: p.pos.x, y: p.pos.y, z: p.pos.z });
    return true;
  }
  return false;
}

export function updateNormal(sim: Sim, a: Actions): void {
  const p = sim.player;
  const move = readyMovement(sim, a);
  if (move) {
    startAction(sim, p.movement[move - 1], move, a);
    return;
  }
  tryJump(sim, a);
  if (p.attackBuffer > 0) {
    startAttack(sim, 0, a);
    return;
  }
  const slot = readySlot(sim);
  if (slot) {
    startCast(sim, slot, a);
    return;
  }
  const buffered = readyBufferedAction(sim);
  if (buffered !== NO_MOVEMENT) {
    startAction(sim, buffered, 0, a);
    return;
  }

  const { dx, dz, mag } = input(sim, a);

  // Crouch wins over sprint if you somehow hold both, and neither applies in the air.
  p.crouching = a.crouchHeld && p.grounded;
  p.sprinting = !p.crouching && a.sprintHeld && p.grounded && mag >= MOVE.runThreshold && !p.pack;

  // Fighting, you keep facing the fight and strafe; otherwise you turn the way you go.
  const face = stance(sim, a);
  if (face !== null) p.facing = turnToward(p.facing, face, MOVE.turnSpeed * STEP);
  else if (mag > 0) p.facing = turnToward(p.facing, Math.atan2(dx, dz), MOVE.turnSpeed * STEP);

  if (p.grounded) {
    let speed: number;
    if (p.crouching) speed = MOVE.crouchSpeed * Math.min(1, mag / MOVE.runThreshold);
    else if (mag >= MOVE.runThreshold) speed = p.sprinting ? MOVE.sprintSpeed : MOVE.runSpeed;
    else speed = MOVE.walkSpeed * (mag / MOVE.runThreshold);
    if (p.pack) speed *= CARRY.speedFactor;
    if (face !== null && mag > 0) speed *= stanceSpeed(p.facing, dx, dz);
    const rate = speed <= 0.01 ? MOVE.groundDecel : p.sprinting ? MOVE.sprintAccel : MOVE.groundAccel;
    accelerateToward(sim, dx * speed, dz * speed, rate);
  } else {
    airControl(sim, dx, dz, mag);
  }
}

export function accelerateToward(sim: Sim, tx: number, tz: number, rate: number): void {
  const v = sim.player.vel;
  const ex = tx - v.x;
  const ez = tz - v.z;
  const err = len(ex, ez);
  const maxDelta = rate * STEP;
  if (err <= maxDelta) {
    v.x = tx;
    v.z = tz;
  } else {
    v.x += (ex / err) * maxDelta;
    v.z += (ez / err) * maxDelta;
  }
}

export function airControl(sim: Sim, dx: number, dz: number, mag: number): void {
  const v = sim.player.vel;
  const hs = len(v.x, v.z);
  if (mag > 0 && hs > MOVE.runSpeed + 0.01) {
    // Faster than running (e.g. a slide jump): keep the momentum but allow steering.
    const heading = turnToward(Math.atan2(v.x, v.z), Math.atan2(dx, dz), 3 * STEP);
    const s = Math.max(MOVE.runSpeed, hs - MOVE.airDrag * STEP);
    v.x = Math.sin(heading) * s;
    v.z = Math.cos(heading) * s;
  } else if (mag > 0) {
    accelerateToward(sim, dx * MOVE.runSpeed * mag, dz * MOVE.runSpeed * mag, MOVE.airAccel);
  } else if (hs > 0) {
    const s = Math.max(0, hs - MOVE.airDrag * STEP);
    v.x *= s / hs;
    v.z *= s / hs;
  }
}

// A movement slot that was pressed and can run now (1..MOVEMENT_SLOTS), else 0. Unlike an
// ability these aren't buffered: a dodge you asked for two frames ago is a dodge you no longer
// want.

export function integrate(sim: Sim): void {
  // Open worlds have hills, cliffs and water; see traverse.ts. Flat ground stays exactly as below.
  if (sim.world.terrain) return integrateOpen(sim);
  const p = sim.player;
  if (!p.grounded) {
    let g = p.vel.y > 0 ? JUMP.gravityUp : JUMP.gravityDown;
    if (p.mode === 'attack') {
      const step = comboFor(p.weapon, sim.stats)[p.attackIndex];
      if (p.attackFrame <= step.startup + step.active) g *= ATTACK.airGravityScale;
    }
    p.vel.y = Math.max(-JUMP.maxFall, p.vel.y - g * STEP);
  }

  p.pos.x += p.vel.x * STEP;
  p.pos.y += p.vel.y * STEP;
  p.pos.z += p.vel.z * STEP;

  collide(sim);

  if (p.pos.y <= 0) {
    if (!p.grounded && p.vel.y <= 0) {
      p.grounded = true;
      p.jumpsUsed = 0;
      p.flipFrame = -1;
      p.landFrame = 0;
      p.landImpact = Math.min(1, -p.vel.y / 20);
      sim.emit({ type: 'land', frame: sim.frame, x: p.pos.x, y: 0, z: p.pos.z, impact: p.landImpact });
    }
    p.pos.y = 0;
    p.vel.y = 0;
  }

  if (p.grounded && p.mode === 'normal') p.runPhase += len(p.vel.x, p.vel.z) * STEP;
}

export function collide(sim: Sim): void {
  const p = sim.player;
  const push = (cx: number, cz: number, r: number) => {
    const dx = p.pos.x - cx;
    const dz = p.pos.z - cz;
    const min = r + MOVE.playerRadius;
    const d2 = dx * dx + dz * dz;
    if (d2 >= min * min) return;
    const d = Math.sqrt(d2) || 0.0001;
    const nx = dx / d;
    const nz = dz / d;
    p.pos.x = cx + nx * min;
    p.pos.z = cz + nz * min;
    const vn = p.vel.x * nx + p.vel.z * nz;
    if (vn < 0) {
      p.vel.x -= vn * nx;
      p.vel.z -= vn * nz;
    }
  };
  for (const o of sim.world.obstacles) push(o.x, o.z, o.r);
  if (sim.opts.training && p.pos.y < 1.8) {
    for (const a of sim.actors.all()) if (a.solid && isAlive(a)) push(a.x, a.z, a.radius);
  }

  const r = len(p.pos.x, p.pos.z);
  if (r > sim.world.radius) {
    p.pos.x *= sim.world.radius / r;
    p.pos.z *= sim.world.radius / r;
  }
}

// Every actor, every frame: let its brain drive it, settle any lean, and bring it back if it
// has been dead long enough. Nothing here knows what a slime or a dummy is.
