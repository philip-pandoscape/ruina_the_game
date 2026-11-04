// Movement skills (Q / E) and castable abilities: the state machines that run between a
// button press and an effect going off.

import type { Sim } from '../sim';
import { ABILITIES, HOTBAR_SLOTS, MOVE, MOVEMENT_SKILLS, MOVEMENT_SLOTS, NO_ABILITY, NO_MOVEMENT, SPECIAL, STEP, abilityCooldown, castFramesFor, movementAction } from '../../tuning';
import { len, turnToward } from '../math';
import type { Actions } from '../types';
import { accelerateToward, input, stance, tryJump } from './locomotion';

export function bufferAction(sim: Sim, id: number) : void {
  const def = movementAction(id);
  if (!def?.bufferFrames) return;
  sim.player.actionBuffer = def.bufferFrames;
  sim.player.actionBufferId = id;
}

// A buffered action that can start right now, else NO_MOVEMENT.

export function readyBufferedAction(sim: Sim) : number {
  const p = sim.player;
  const id = p.actionBufferId;
  if (p.actionBuffer <= 0 || id === NO_MOVEMENT || !p.grounded) return NO_MOVEMENT;
  if ((p.movementCooldowns[id] ?? 0) > 0) return NO_MOVEMENT;
  return id;
}

export function readyMovement(sim: Sim, a: Actions) : number {
  const p = sim.player;
  const slot = a.movementSlot;
  if (slot < 1 || slot > MOVEMENT_SLOTS || !p.grounded) return 0;
  const m = p.movement[slot - 1];
  if (m === NO_MOVEMENT || !movementAction(m) || (p.movementCooldowns[m] ?? 0) > 0) return 0;
  return slot;
}

// Begins a movement skill. The direction is fixed now and not steered afterwards, which is what
// makes a dodge a commitment rather than a hover.
// `slot` is the Q / E slot it came from, or 0 for a built-in like the slide.

export function startAction(sim: Sim, id: number, slot: number, a: Actions) : void {
  const p = sim.player;
  const def = movementAction(id)!;
  p.mode = 'action';
  p.actionId = id;
  p.actionSlot = slot;
  p.actionFrame = 0;
  p.attackQueued = false;
  p.actionBuffer = 0;
  p.actionBufferId = NO_MOVEMENT;
  const { dx, dz, mag } = input(sim, a);
  if (def.direction === 'input' && mag > 0.05) {
    p.actionDirX = dx;
    p.actionDirZ = dz;
    // Fighting, you dodge any way you push without turning from the fight.
    if (stance(sim, a) === null) p.facing = Math.atan2(dx, dz);
  } else if (def.direction === 'backward') {
    p.actionDirX = -Math.sin(p.facing);
    p.actionDirZ = -Math.cos(p.facing);
  } else {
    p.actionDirX = Math.sin(p.facing);
    p.actionDirZ = Math.cos(p.facing);
  }
  sim.emit({ type: 'action', frame: sim.frame, id, x: p.pos.x, y: p.pos.y, z: p.pos.z });
}

export function updateAction(sim: Sim, a: Actions) : void {
  const p = sim.player;
  const def = movementAction(p.actionId);
  if (!def) {
    endAction(sim);
    return;
  }
  p.actionFrame++;
  const f = p.actionFrame;
  const activeEnd = def.startup + def.active;
  // A held action (a guard) drops as soon as you let go, without skipping its recovery.
  const released = def.hold === true && a.movementHeld !== p.actionSlot;

  // Steerable actions turn toward where you're pushing; the rest keep the way they committed.
  if (def.steer) {
    const { dx, dz, mag } = input(sim, a);
    if (mag > 0) {
      const heading = turnToward(Math.atan2(p.actionDirX, p.actionDirZ), Math.atan2(dx, dz), def.steer * STEP);
      p.actionDirX = Math.sin(heading);
      p.actionDirZ = Math.cos(heading);
    }
    p.facing = Math.atan2(p.actionDirX, p.actionDirZ);
  }

  if (f <= def.startup) {
    accelerateToward(sim, 0, 0, MOVE.groundDecel);
  } else if (f <= activeEnd && !released) {
    if (def.speed > 0) {
      // Eases from `speed` to `endSpeed` across the active frames, quadratically.
      const t = def.endSpeed === undefined ? 0 : Math.min(1, (f - def.startup) / Math.max(1, def.active));
      const speed = def.speed + ((def.endSpeed ?? def.speed) - def.speed) * t * t;
      p.vel.x = p.actionDirX * speed;
      p.vel.z = p.actionDirZ * speed;
    } else {
      accelerateToward(sim, 0, 0, MOVE.groundDecel);
    }
    // Jumping out of a slide is a long jump that keeps most of its speed.
    if (def.jumpCarry !== undefined && p.jumpBuffer > 0) {
      endAction(sim);
      p.vel.x *= def.jumpCarry;
      p.vel.z *= def.jumpCarry;
      tryJump(sim, a);
      return;
    }
    if (def.groundOnly && !p.grounded) {
      endAction(sim);
      return;
    }
  } else {
    accelerateToward(sim, 0, 0, MOVE.groundDecel);
  }
  // Checked after the branch, not inside the tail of it, so an action with no recovery ends on
  // the last of its active frames rather than lingering one frame longer.
  if (f >= activeEnd + def.recovery || (released && f >= def.startup + def.recovery)) endAction(sim);
}

export function endAction(sim: Sim) : void {
  const p = sim.player;
  const id = p.actionId;
  // Cooldowns are per skill, so one moved between Q and E keeps its timer.
  if (id !== NO_MOVEMENT) p.movementCooldowns[id] = MOVEMENT_SKILLS[id]?.cooldownFrames ?? 0;
  p.mode = 'normal';
  p.actionId = NO_MOVEMENT;
  p.actionFrame = 0;
  p.actionSlot = 0;
}

// Whether a hit right now passes through, and how much of it lands. 1 is a clean hit.

export function incomingScale(sim: Sim) : number {
  const p = sim.player;
  if (p.mode !== 'action') return 1;
  const def = movementAction(p.actionId);
  if (!def) return 1;
  const f = p.actionFrame;
  if (def.invulnFrom !== undefined && def.invulnTo !== undefined && f >= def.invulnFrom && f <= def.invulnTo) return 0;
  if (def.damageTaken !== undefined && f > def.startup && f <= def.startup + def.active) return def.damageTaken;
  return 1;
}

// The hotbar slot that was pressed and can be cast now (1..HOTBAR_SLOTS), else 0.

export function readySlot(sim: Sim) : number {
  const p = sim.player;
  if (!p.grounded || p.abilityBuffer <= 0) return 0;
  const slot = p.abilityBufferSlot;
  if (slot < 1 || slot > HOTBAR_SLOTS) return 0;
  if (p.abilities[slot - 1] === NO_ABILITY || p.cooldowns[slot - 1] > 0) return 0;
  return slot;
}

export function setCooldown(sim: Sim, slot: number, frames: number) : void {
  if (slot >= 1 && slot <= HOTBAR_SLOTS) sim.player.cooldowns[slot - 1] = frames;
}

// Abilities (Healing Circle, Meteor): stand still and cast. The target is your aim offset if you
// gave one (capped at maxRange), otherwise the ability's range in metres straight ahead.

export function startCast(sim: Sim, slot: number, a: Actions) : void {
  const p = sim.player;
  const ability = p.abilities[slot - 1];
  const s = ABILITIES[ability];
  p.mode = 'cast';
  p.castAbility = ability;
  p.castSlot = slot;
  p.castFrame = 0;
  p.abilityBuffer = 0;
  p.abilityBufferSlot = 0;
  let ax = a.aimX;
  let az = a.aimZ;
  const aim = len(ax, az);
  if (aim > 0.01) {
    p.facing = Math.atan2(ax, az);
    const max = s.maxRange ?? aim;
    if (aim > max) {
      ax *= max / aim;
      az *= max / aim;
    }
  } else {
    // Unaimed, it goes off ahead: of the fight when you're facing one, else the way you push.
    const { dx, dz, mag } = input(sim, a);
    const face = stance(sim, a);
    if (face !== null) p.facing = face;
    else if (mag > 0) p.facing = Math.atan2(dx, dz);
    ax = Math.sin(p.facing) * (s.range ?? 0);
    az = Math.cos(p.facing) * (s.range ?? 0);
  }
  p.castTargetX = p.pos.x + ax;
  p.castTargetZ = p.pos.z + az;
}

export function updateCast(sim: Sim, a: Actions) : void {
  const p = sim.player;
  const ability = p.abilities[p.castSlot - 1];
  p.castFrame++;
  accelerateToward(sim, 0, 0, MOVE.groundDecel); // rooted while casting
  if (p.jumpBuffer > 0 || p.actionBuffer > 0) {
    // Jumping or sliding cancels the cast.
    setCooldown(sim, p.castSlot, SPECIAL.cancelCooldownFrames);
    p.mode = 'normal';
    p.castAbility = NO_ABILITY;
    p.castSlot = 0;
    p.castFrame = 0;
    if (!tryJump(sim, a)) {
      const buffered = readyBufferedAction(sim);
      if (buffered !== NO_MOVEMENT) startAction(sim, buffered, 0, a);
    }
    return;
  }
  if (p.castFrame >= castFramesFor(ability, sim.stats)) {
    setCooldown(sim, p.castSlot, abilityCooldown(ability, sim.stats));
    p.mode = 'normal';
    p.firedAbility = ability;
    sim.emit({ type: 'cast', frame: sim.frame, ability, x: p.castTargetX, z: p.castTargetZ, casterX: p.pos.x, casterZ: p.pos.z });
    p.castAbility = NO_ABILITY;
    p.castSlot = 0;
    p.castFrame = 0;
  }
}
