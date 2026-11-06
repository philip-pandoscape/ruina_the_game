// Swinging, shooting, and what happens when the player is on the receiving end.

import type { Sim } from '../sim';
import { damage } from '../combat/deal';
import { ATTACK, COMBAT, MOVE, NO_ABILITY, NO_MOVEMENT, SPECIAL, comboFor, meleeTargets, pierceTargets } from '../../tuning';
import type { AttackStep } from '../../tuning';
import { DEG, angleDiff, len } from '../math';
import { coneHits, nearest } from '../combat/hit';
import type { Actions } from '../types';
import { accelerateToward, airControl, input, stance, tryJump } from './locomotion';
import { endAction, incomingScale, readyBufferedAction, setCooldown, startAction } from './abilities';
import { heightAboveGround } from './traverse';
import { groundAt } from '../zone/colliders';
import { refillVitals } from './vitals';

export function startAttack(sim: Sim, index: number, a: Actions) : void {
  const p = sim.player;
  p.mode = 'attack';
  p.attackIndex = index;
  p.attackFrame = 0;
  p.attackQueued = false;
  p.attackHit = false;
  p.attackBuffer = 0;
  // Swing at what you aimed at; else ahead, into the fight if you're facing one, or the way you push.
  const { dx, dz, mag } = input(sim, a);
  const face = stance(sim, a);
  if (face !== null) p.facing = face;
  else if (mag > 0) p.facing = Math.atan2(dx, dz);
  if (len(a.aimX, a.aimZ) > 0.01) p.facing = Math.atan2(a.aimX, a.aimZ);
  // Gentle auto-aim toward whatever is nearest and roughly in front (training only for now).
  if (sim.opts.training) {
    const near = nearest(sim.targets(), p.pos.x, p.pos.z, ATTACK.autoAimRange);
    if (near) {
      const toTarget = Math.atan2(near.x - p.pos.x, near.z - p.pos.z);
      if (Math.abs(angleDiff(p.facing, toTarget)) < ATTACK.autoAimDeg * DEG) p.facing = toTarget;
    }
  }
  sim.emit({ type: 'attack', frame: sim.frame, index });
}

export function updateAttack(sim: Sim, a: Actions) : void {
  const p = sim.player;
  const combo = comboFor(p.weapon, sim.stats);
  const step = combo[p.attackIndex];
  p.attackFrame++;
  const f = p.attackFrame;
  const activeStart = step.startup;
  const activeEnd = step.startup + step.active;
  const total = activeEnd + step.recovery;

  if (p.attackBuffer > 0 && p.attackIndex < combo.length - 1) {
    p.attackQueued = true;
    p.attackBuffer = 0;
  }

  if (p.grounded) {
    if (f <= activeEnd) {
      const push = f <= activeStart ? step.lunge * 0.5 : step.lunge;
      p.vel.x = Math.sin(p.facing) * push;
      p.vel.z = Math.cos(p.facing) * push;
    } else {
      accelerateToward(sim, 0, 0, MOVE.groundDecel);
    }
  } else {
    airControl(sim, 0, 0, 0);
  }

  if (sim.opts.training && !step.projectileSpeed && !p.attackHit && f > activeStart && f <= activeEnd) checkHit(sim, step);

  if (p.attackQueued && f >= activeEnd + 2) {
    startAttack(sim, p.attackIndex + 1, a);
    return;
  }
  if (f > activeEnd + step.cancelAfter) {
    if (p.jumpBuffer > 0 && (p.grounded || p.jumpsUsed < 2)) {
      p.mode = 'normal';
      tryJump(sim, a);
      return;
    }
    const buffered = readyBufferedAction(sim);
    if (buffered !== NO_MOVEMENT) {
      startAction(sim, buffered, 0, a);
      return;
    }
  }
  if (f >= total) p.mode = 'normal';
}

export function checkHit(sim: Sim, step: AttackStep) : void {
  const p = sim.player;
  // Too far up in the air to reach anything. Height is measured from the ground under you: on
  // flat ground that is just pos.y (as on the server, game.rs swing), but on hills pos.y is
  // height above the sea, so testing it directly would rule out every swing on the high ground.
  if (heightAboveGround(sim) > 2.0) return;
  let targets = sim.targets();
  // On hills a target can stand well above or below you (a cliff, a pier over the beach). As
  // with the server's rule for fighters, a swing only reaches feet within 2 m of your own.
  if (sim.world.terrain) targets = targets.filter((t) => Math.abs(t.y - p.pos.y) <= 2.0);
  const hits = coneHits(targets, p.pos.x, p.pos.z, p.facing, step.reach, step.arcDeg, meleeTargets(p.weapon, sim.stats));
  if (!hits.length) return;
  p.attackHit = true;
  sim.hitstop = step.hitstop;
  for (const t of hits) damage(sim, t, step.damage, step.knock, p.attackIndex, p.weapon);
}

/**
 * Something took a hit. Everything that deals damage - swings, arrows, blasts - comes through
 * here, so a new weapon never has to learn what kinds of thing exist and a new monster never
 * has to be added to a weapon.
 */

export function checkShot(sim: Sim) : void {
  const p = sim.player;
  const step = comboFor(p.weapon, sim.stats)[p.attackIndex];
  if (!step.projectileSpeed || p.attackFrame !== step.startup + 1) return;
  const dirX = Math.sin(p.facing);
  const dirZ = Math.cos(p.facing);
  sim.emit({
    type: 'shoot',
    frame: sim.frame,
    x: p.pos.x + dirX * 0.6,
    y: p.pos.y + 1.3,
    z: p.pos.z + dirZ * 0.6,
    dirX,
    dirZ,
    speed: step.projectileSpeed,
    range: step.projectileRange ?? 0,
    damage: step.damage,
    pierce: pierceTargets(p.weapon, sim.stats),
    weapon: p.weapon,
  });
}

// Being hit by another fighter: lose health, get knocked back and briefly stunned.

export function takeHit(sim: Sim, damage: number, dirX: number, dirZ: number, knock: number) : void {
  const p = sim.player;
  if (p.downFrame >= 0) return;
  // A dodge's invulnerable frames drop the hit entirely; a guard lets part of it through.
  // Either way the action keeps running: being untouchable is the point of it.
  const scale = incomingScale(sim);
  if (scale <= 0) return;
  const taken = damage * scale;
  p.hp = Math.max(0, p.hp - taken);
  if (p.mode === 'action') {
    // Guarding holds its ground rather than being knocked about.
    if (p.hp <= 0) {
      p.stun = 0;
      p.downFrame = 0;
      endAction(sim);
    }
    return;
  }
  if (p.mode === 'cast') {
    // Interrupted: the spell fizzles and the ability needs a moment before it can be tried again.
    const slot = p.castSlot;
    setCooldown(sim, slot, Math.max(p.cooldowns[slot - 1] ?? 0, SPECIAL.interruptCooldownFrames));
    p.castAbility = NO_ABILITY;
    p.castSlot = 0;
    p.castFrame = 0;
  }
  p.vel.x = dirX * knock;
  p.vel.z = dirZ * knock;
  p.vel.y = COMBAT.knockUp;
  p.grounded = false;
  p.jumpsUsed = 1;
  p.jumpCutDone = true;
  p.mode = 'normal';
  p.flipFrame = -1;
  p.stun = COMBAT.stunFrames;
  if (p.hp <= 0) {
    p.stun = 0;
    p.downFrame = 0;
  }
}

// Back up after a knock-down: at the spawn, with full health, stamina and MP.

export function respawn(sim: Sim) : void {
  const p = sim.player;
  const at = sim.world.respawnAt;
  const s = at ?? sim.world.teamSpawns[p.team] ?? sim.world.spawn;
  // Back on your feet on the ground there: on the island that's the terrain (or a roof) under the
  // spawn, as when you first arrive; in a dungeon, its floor where it's entered; the training
  // grounds and the battlefield are flat at 0.
  const hf = sim.world.terrain;
  const y = hf ? groundAt(hf, sim.world.index, s.x, s.z, (at ? at.y : hf.height(s.x, s.z)) + 1.2, 1.2) : 0;
  p.pos = { x: s.x, y, z: s.z };
  p.vel = { x: 0, y: 0, z: 0 };
  p.facing = s.facing;
  p.grounded = true;
  p.jumpsUsed = 0;
  p.hp = COMBAT.maxHp;
  refillVitals(p);
  p.stun = 0;
  p.downFrame = -1;
  p.mode = 'normal';
  p.castAbility = NO_ABILITY;
  p.castSlot = 0;
  p.castFrame = 0;
  p.cooldowns.fill(0);
  sim.emit({ type: 'respawn', frame: sim.frame, x: s.x, y, z: s.z });
}
