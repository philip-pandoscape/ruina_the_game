import {
  ABILITIES,
  ATTACK,
  castFramesFor,
  castKindOf,
  comboFor,
  COMBAT,
  DEFAULT_BUILD,
  DUMMY,
  JUMP,
  MOVE,
  NO_ABILITY,
  PERK,
  SKILLS,
  SLIDE,
  SPECIAL,
  STEP,
  type AttackStep,
  type Build,
} from '../tuning';
import type { Actions, DummyState, GameEvent, PlayerState, Spawn, World } from './types';

export interface SimOptions {
  // Training: the dummy is a target, hits pause the action briefly, and attacks auto-aim.
  // Networked play turns these off, because the server decides what gets hit.
  // server/src/player.rs must follow the same rules (tests/conformance.spec.ts checks it).
  training: boolean;
}

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// Shortest signed angle from a to b.
// Plain square root instead of Math.hypot, so Rust (server/src/player.rs) gets identical results.
const len = (x: number, z: number) => Math.sqrt(x * x + z * z);

function angleDiff(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

function turnToward(current: number, target: number, maxStep: number): number {
  const d = angleDiff(current, target);
  const next = current + Math.max(-maxStep, Math.min(maxStep, d));
  return Math.atan2(Math.sin(next), Math.cos(next));
}

// Fixed-step game rules: 60 steps per second, same result every time for the same inputs.
export class Sim {
  frame = 0;
  hitstop = 0;
  player!: PlayerState;
  dummy!: DummyState;
  private pending: GameEvent[] = [];
  readonly log: GameEvent[] = [];

  constructor(
    readonly world: World,
    readonly opts: SimOptions = { training: true },
  ) {
    this.reset();
  }

  reset(spawn: Spawn = this.world.spawn, team = 0, build: Build = DEFAULT_BUILD): void {
    this.frame = 0;
    this.hitstop = 0;
    this.pending = [];
    this.log.length = 0;
    const pos = { x: spawn.x, y: 0, z: spawn.z };
    this.player = {
      pos,
      prevPos: { ...pos },
      vel: { x: 0, y: 0, z: 0 },
      facing: spawn.facing,
      prevFacing: spawn.facing,
      mode: 'normal',
      grounded: true,
      jumpsUsed: 0,
      jumpCutDone: true,
      coyote: 0,
      jumpBuffer: 0,
      attackBuffer: 0,
      slideBuffer: 0,
      slideFrame: 0,
      slideDirX: 0,
      slideDirZ: 1,
      slideCooldown: 0,
      attackIndex: 0,
      attackFrame: 0,
      attackQueued: false,
      attackHit: false,
      flipFrame: -1,
      landFrame: 999,
      landImpact: 0,
      takeoffFrame: 999,
      runPhase: 0,
      hp: COMBAT.maxHp,
      stun: 0,
      downFrame: -1,
      team,
      weapon: build.weapon,
      perks: build.perks,
      ability1: build.ability1,
      ability2: build.ability2,
      abilityBuffer1: 0,
      abilityBuffer2: 0,
      cooldown1: 0,
      cooldown2: 0,
      castSlot: 0,
      castKind: 0,
      castFrame: 0,
      castTargetX: 0,
      castTargetZ: 0,
      firedCast: 0,
    };
    this.dummy = {
      x: this.world.dummy.x,
      z: this.world.dummy.z,
      hp: DUMMY.hp,
      tiltX: 0,
      tiltZ: 0,
      tiltVX: 0,
      tiltVZ: 0,
      flashFrame: 999,
      brokenFrame: -1,
    };
  }

  // Switches skills and loadout, the way the server does (server/src/player.rs apply_build): any
  // attack or cast in progress is dropped.
  setBuild(b: Build): void {
    const p = this.player;
    p.weapon = b.weapon;
    p.perks = b.perks;
    p.ability1 = b.ability1;
    p.ability2 = b.ability2;
    if (p.mode === 'attack' || p.mode === 'cast') p.mode = 'normal';
    p.attackIndex = 0;
    p.attackFrame = 0;
    p.attackQueued = false;
    p.castKind = 0;
    p.castSlot = 0;
    p.castFrame = 0;
  }

  // Events since the last call (the renderer uses these for effects).
  drainEvents(): GameEvent[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  private emit(e: GameEvent): void {
    this.pending.push(e);
    this.log.push(e);
    if (this.log.length > 500) this.log.shift();
  }

  step(a: Actions): void {
    this.frame++;
    const p = this.player;
    p.prevPos = { ...p.pos };
    p.prevFacing = p.facing;
    p.firedCast = 0;

    // Presses are remembered for a few frames so slightly early inputs still count.
    if (a.jumpPressed) p.jumpBuffer = JUMP.bufferFrames;
    if (a.attackPressed) p.attackBuffer = ATTACK.bufferFrames;
    if (a.slidePressed) p.slideBuffer = SLIDE.bufferFrames;
    if (a.ability1Pressed) p.abilityBuffer1 = SPECIAL.bufferFrames;
    if (a.ability2Pressed) p.abilityBuffer2 = SPECIAL.bufferFrames;

    // Hit pause (training only): everything freezes briefly when a hit lands. Buffered presses are kept.
    if (this.opts.training && this.hitstop > 0) {
      this.hitstop--;
      return;
    }

    p.landFrame = Math.min(p.landFrame + 1, 999);
    p.takeoffFrame = Math.min(p.takeoffFrame + 1, 999);
    if (p.flipFrame >= 0) p.flipFrame = p.flipFrame + 1 > JUMP.flipFrames ? -1 : p.flipFrame + 1;
    if (p.slideCooldown > 0) p.slideCooldown--;
    if (p.cooldown1 > 0) p.cooldown1--;
    if (p.cooldown2 > 0) p.cooldown2--;
    p.coyote = p.grounded ? JUMP.coyoteFrames : Math.max(0, p.coyote - 1);

    // Releasing jump early gives a short hop.
    if (!a.jumpHeld && !p.jumpCutDone && p.vel.y > 0 && p.jumpsUsed === 1) {
      p.vel.y *= JUMP.shortHopCut;
      p.jumpCutDone = true;
    }

    if (p.downFrame >= 0) {
      // Knocked down: lie still, then get back up at the team's spawn point.
      p.mode = 'normal';
      p.downFrame++;
      if (p.grounded) this.accelerateToward(0, 0, MOVE.groundDecel);
      if (p.downFrame >= COMBAT.downFrames) this.respawn();
    } else if (p.stun > 0) {
      // Stunned after a hit: no control until it wears off.
      p.stun--;
      p.mode = 'normal';
      if (p.grounded) this.accelerateToward(0, 0, MOVE.groundDecel);
      else this.airControl(0, 0, 0);
    } else if (p.mode === 'cast') this.updateCast(a);
    else if (p.mode === 'attack') this.updateAttack(a);
    else if (p.mode === 'slide') this.updateSlide(a);
    else this.updateNormal(a);

    this.integrate();
    if (p.mode === 'attack') this.checkShot();
    if (this.opts.training) this.updateDummy();

    if (p.jumpBuffer > 0) p.jumpBuffer--;
    if (p.attackBuffer > 0) p.attackBuffer--;
    if (p.slideBuffer > 0) p.slideBuffer--;
    if (p.abilityBuffer1 > 0) p.abilityBuffer1--;
    if (p.abilityBuffer2 > 0) p.abilityBuffer2--;
  }

  private input(a: Actions): { dx: number; dz: number; mag: number } {
    const mag = Math.min(1, len(a.moveX, a.moveZ));
    if (mag < 0.05) return { dx: 0, dz: 0, mag: 0 };
    const l = len(a.moveX, a.moveZ);
    return { dx: a.moveX / l, dz: a.moveZ / l, mag };
  }

  private tryJump(a: Actions): boolean {
    const p = this.player;
    if (p.jumpBuffer <= 0) return false;
    if (p.grounded || p.coyote > 0) {
      p.vel.y = JUMP.velocity;
      p.grounded = false;
      p.coyote = 0;
      p.jumpsUsed = 1;
      p.jumpCutDone = false;
      p.jumpBuffer = 0;
      p.takeoffFrame = 0;
      this.emit({ type: 'jump', frame: this.frame, x: p.pos.x, y: p.pos.y, z: p.pos.z });
      return true;
    }
    if (p.jumpsUsed < 2) {
      p.vel.y = JUMP.doubleJumpVelocity;
      p.jumpsUsed = 2;
      p.jumpCutDone = true;
      p.jumpBuffer = 0;
      p.flipFrame = 0;
      const { dx, dz, mag } = this.input(a);
      if (mag > 0) {
        // Like a platform fighter, the double jump lets you change direction instantly.
        const s = JUMP.doubleJumpSteer * MOVE.runSpeed * mag;
        p.vel.x = dx * s;
        p.vel.z = dz * s;
        p.facing = Math.atan2(dx, dz);
      }
      this.emit({ type: 'doubleJump', frame: this.frame, x: p.pos.x, y: p.pos.y, z: p.pos.z });
      return true;
    }
    return false;
  }

  private updateNormal(a: Actions): void {
    const p = this.player;
    this.tryJump(a);
    if (p.attackBuffer > 0) {
      this.startAttack(0, a);
      return;
    }
    const slot = this.readySlot();
    if (slot) {
      this.startCast(slot, a);
      return;
    }
    if (p.slideBuffer > 0 && p.grounded && p.slideCooldown <= 0) {
      this.startSlide(a);
      return;
    }

    const { dx, dz, mag } = this.input(a);
    if (mag > 0) p.facing = turnToward(p.facing, Math.atan2(dx, dz), MOVE.turnSpeed * STEP);

    if (p.grounded) {
      const speed = mag >= MOVE.runThreshold ? MOVE.runSpeed : MOVE.walkSpeed * (mag / MOVE.runThreshold);
      this.accelerateToward(dx * speed, dz * speed, speed > 0.01 ? MOVE.groundAccel : MOVE.groundDecel);
    } else {
      this.airControl(dx, dz, mag);
    }
  }

  private accelerateToward(tx: number, tz: number, rate: number): void {
    const v = this.player.vel;
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

  private airControl(dx: number, dz: number, mag: number): void {
    const v = this.player.vel;
    const hs = len(v.x, v.z);
    if (mag > 0 && hs > MOVE.runSpeed + 0.01) {
      // Faster than running (e.g. a slide jump): keep the momentum but allow steering.
      const heading = turnToward(Math.atan2(v.x, v.z), Math.atan2(dx, dz), 3 * STEP);
      const s = Math.max(MOVE.runSpeed, hs - MOVE.airDrag * STEP);
      v.x = Math.sin(heading) * s;
      v.z = Math.cos(heading) * s;
    } else if (mag > 0) {
      this.accelerateToward(dx * MOVE.runSpeed * mag, dz * MOVE.runSpeed * mag, MOVE.airAccel);
    } else if (hs > 0) {
      const s = Math.max(0, hs - MOVE.airDrag * STEP);
      v.x *= s / hs;
      v.z *= s / hs;
    }
  }

  private startSlide(a: Actions): void {
    const p = this.player;
    p.mode = 'slide';
    p.slideFrame = 0;
    p.slideBuffer = 0;
    const { dx, dz, mag } = this.input(a);
    if (mag > 0) p.facing = Math.atan2(dx, dz);
    p.slideDirX = Math.sin(p.facing);
    p.slideDirZ = Math.cos(p.facing);
    this.emit({ type: 'slide', frame: this.frame, x: p.pos.x, y: p.pos.y, z: p.pos.z });
  }

  private updateSlide(a: Actions): void {
    const p = this.player;
    p.slideFrame++;
    const { dx, dz, mag } = this.input(a);
    if (mag > 0) {
      const heading = turnToward(Math.atan2(p.slideDirX, p.slideDirZ), Math.atan2(dx, dz), SLIDE.steer * STEP);
      p.slideDirX = Math.sin(heading);
      p.slideDirZ = Math.cos(heading);
    }
    p.facing = Math.atan2(p.slideDirX, p.slideDirZ);
    const t = Math.min(1, p.slideFrame / SLIDE.frames);
    const speed = SLIDE.speed + (SLIDE.endSpeed - SLIDE.speed) * t * t;
    p.vel.x = p.slideDirX * speed;
    p.vel.z = p.slideDirZ * speed;

    if (p.jumpBuffer > 0) {
      // Slide jump: a long jump that keeps most of the slide's speed.
      p.mode = 'normal';
      p.slideCooldown = SLIDE.cooldownFrames;
      p.vel.x *= SLIDE.jumpCarry;
      p.vel.z *= SLIDE.jumpCarry;
      this.tryJump(a);
      return;
    }
    if (p.slideFrame >= SLIDE.frames || !p.grounded) {
      p.mode = 'normal';
      p.slideCooldown = SLIDE.cooldownFrames;
    }
  }

  // An ability slot that was pressed and can be cast now (1 or 2), else 0.
  private readySlot(): number {
    const p = this.player;
    if (!p.grounded) return 0;
    if (p.abilityBuffer1 > 0 && p.ability1 !== NO_ABILITY && p.cooldown1 <= 0) return 1;
    if (p.abilityBuffer2 > 0 && p.ability2 !== NO_ABILITY && p.cooldown2 <= 0) return 2;
    return 0;
  }

  private setCooldown(slot: number, frames: number): void {
    if (slot === 1) this.player.cooldown1 = frames;
    else if (slot === 2) this.player.cooldown2 = frames;
  }

  // Abilities (Healing Circle, Meteor): stand still and cast. The target is your aim offset if you
  // gave one (capped at maxRange), otherwise the ability's range in metres straight ahead.
  private startCast(slot: number, a: Actions): void {
    const p = this.player;
    const ability = slot === 1 ? p.ability1 : p.ability2;
    const s = ABILITIES[ability];
    p.mode = 'cast';
    p.castKind = castKindOf(ability);
    p.castSlot = slot;
    p.castFrame = 0;
    if (slot === 1) p.abilityBuffer1 = 0;
    else p.abilityBuffer2 = 0;
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
      const { dx, dz, mag } = this.input(a);
      if (mag > 0) p.facing = Math.atan2(dx, dz);
      ax = Math.sin(p.facing) * (s.range ?? 0);
      az = Math.cos(p.facing) * (s.range ?? 0);
    }
    p.castTargetX = p.pos.x + ax;
    p.castTargetZ = p.pos.z + az;
  }

  private updateCast(a: Actions): void {
    const p = this.player;
    const ability = p.castSlot === 1 ? p.ability1 : p.ability2;
    p.castFrame++;
    this.accelerateToward(0, 0, MOVE.groundDecel); // rooted while casting
    if (p.jumpBuffer > 0 || p.slideBuffer > 0) {
      // Jumping or sliding cancels the cast.
      this.setCooldown(p.castSlot, SPECIAL.cancelCooldownFrames);
      p.mode = 'normal';
      p.castKind = 0;
      p.castSlot = 0;
      p.castFrame = 0;
      if (!this.tryJump(a) && p.slideBuffer > 0 && p.grounded && p.slideCooldown <= 0) this.startSlide(a);
      return;
    }
    if (p.castFrame >= castFramesFor(ability, p.perks)) {
      this.setCooldown(p.castSlot, ABILITIES[ability].cooldownFrames);
      p.mode = 'normal';
      p.firedCast = p.castKind;
      this.emit({ type: 'cast', frame: this.frame, kind: p.castKind, x: p.castTargetX, z: p.castTargetZ, casterX: p.pos.x, casterZ: p.pos.z });
      p.castKind = 0;
      p.castSlot = 0;
      p.castFrame = 0;
    }
  }

  private startAttack(index: number, a: Actions): void {
    const p = this.player;
    const d = this.dummy;
    p.mode = 'attack';
    p.attackIndex = index;
    p.attackFrame = 0;
    p.attackQueued = false;
    p.attackHit = false;
    p.attackBuffer = 0;
    const { dx, dz, mag } = this.input(a);
    if (mag > 0) p.facing = Math.atan2(dx, dz);
    if (len(a.aimX, a.aimZ) > 0.01) p.facing = Math.atan2(a.aimX, a.aimZ);
    // Gentle auto-aim toward a nearby target that's roughly in front (training only for now).
    const tx = d.x - p.pos.x;
    const tz = d.z - p.pos.z;
    if (this.opts.training && d.brokenFrame < 0 && len(tx, tz) < ATTACK.autoAimRange) {
      const toTarget = Math.atan2(tx, tz);
      if (Math.abs(angleDiff(p.facing, toTarget)) < ATTACK.autoAimDeg * DEG) p.facing = toTarget;
    }
    this.emit({ type: 'attack', frame: this.frame, index });
  }

  private updateAttack(a: Actions): void {
    const p = this.player;
    const combo = comboFor(p.weapon, p.perks);
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
        this.accelerateToward(0, 0, MOVE.groundDecel);
      }
    } else {
      this.airControl(0, 0, 0);
    }

    if (this.opts.training && !step.projectileSpeed && !p.attackHit && f > activeStart && f <= activeEnd) this.checkHit(step);

    if (p.attackQueued && f >= activeEnd + 2) {
      this.startAttack(p.attackIndex + 1, a);
      return;
    }
    if (f > activeEnd + step.cancelAfter) {
      if (p.jumpBuffer > 0 && (p.grounded || p.jumpsUsed < 2)) {
        p.mode = 'normal';
        this.tryJump(a);
        return;
      }
      if (p.slideBuffer > 0 && p.grounded && p.slideCooldown <= 0) {
        this.startSlide(a);
        return;
      }
    }
    if (f >= total) p.mode = 'normal';
  }

  private checkHit(step: AttackStep): void {
    const p = this.player;
    const d = this.dummy;
    if (d.brokenFrame >= 0 || p.pos.y > 2.0) return;
    const dx = d.x - p.pos.x;
    const dz = d.z - p.pos.z;
    const dist = len(dx, dz);
    if (dist > step.reach + DUMMY.radius) return;
    const toTarget = Math.atan2(dx, dz);
    const inCone = Math.abs(angleDiff(p.facing, toTarget)) <= (step.arcDeg / 2) * DEG;
    if (!inCone && dist > DUMMY.radius + 0.3) return;

    p.attackHit = true;
    const nx = dist > 0 ? dx / dist : Math.sin(p.facing);
    const nz = dist > 0 ? dz / dist : Math.cos(p.facing);
    this.hitstop = step.hitstop;
    this.hitDummy(step.damage, nx, nz, step.knock, p.attackIndex, Math.max(0.5, Math.min(1.6, p.pos.y + 1.1)));
  }

  // Training: the dummy takes a hit travelling along (nx, nz). Arrows and meteors use this too.
  hitDummy(damage: number, nx: number, nz: number, knock: number, index: number, y: number): void {
    const d = this.dummy;
    if (d.brokenFrame >= 0) return;
    d.hp = Math.max(0, d.hp - damage);
    d.tiltVX += nx * knock;
    d.tiltVZ += nz * knock;
    d.flashFrame = 0;
    this.emit({
      type: 'hit',
      frame: this.frame,
      index,
      damage,
      x: d.x - nx * DUMMY.radius,
      y,
      z: d.z - nz * DUMMY.radius,
      dirX: nx,
      dirZ: nz,
    });
    if (d.hp <= 0) {
      d.brokenFrame = 0;
      this.emit({ type: 'dummyBreak', frame: this.frame, x: d.x, y: 1, z: d.z });
    }
  }

  // Effects from outside the player's own rules (the training range's arrows and spells).
  addEvent(e: GameEvent): void {
    this.emit(e);
  }

  // A bow looses its arrow on the first active frame, from where the server fires it (game.rs).
  private checkShot(): void {
    const p = this.player;
    const step = comboFor(p.weapon, p.perks)[p.attackIndex];
    if (!step.projectileSpeed || p.attackFrame !== step.startup + 1) return;
    const dirX = Math.sin(p.facing);
    const dirZ = Math.cos(p.facing);
    this.emit({
      type: 'shoot',
      frame: this.frame,
      x: p.pos.x + dirX * 0.6,
      y: p.pos.y + 1.3,
      z: p.pos.z + dirZ * 0.6,
      dirX,
      dirZ,
      speed: step.projectileSpeed,
      range: step.projectileRange ?? 0,
      damage: step.damage,
      pierce: p.perks & PERK.piercing ? SKILLS.pierceTargets : 1,
    });
  }

  // Being hit by another fighter: lose health, get knocked back and briefly stunned.
  takeHit(damage: number, dirX: number, dirZ: number, knock: number): void {
    const p = this.player;
    if (p.downFrame >= 0) return;
    p.hp = Math.max(0, p.hp - damage);
    if (p.mode === 'cast') {
      // Interrupted: the spell fizzles and the ability needs a moment before it can be tried again.
      const slot = p.castSlot;
      this.setCooldown(slot, Math.max(slot === 1 ? p.cooldown1 : p.cooldown2, SPECIAL.interruptCooldownFrames));
      p.castKind = 0;
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

  private respawn(): void {
    const p = this.player;
    const s = this.world.teamSpawns[p.team] ?? this.world.spawn;
    p.pos = { x: s.x, y: 0, z: s.z };
    p.vel = { x: 0, y: 0, z: 0 };
    p.facing = s.facing;
    p.grounded = true;
    p.jumpsUsed = 0;
    p.hp = COMBAT.maxHp;
    p.stun = 0;
    p.downFrame = -1;
    p.mode = 'normal';
    p.castKind = 0;
    p.castSlot = 0;
    p.castFrame = 0;
    p.cooldown1 = 0;
    p.cooldown2 = 0;
    this.emit({ type: 'respawn', frame: this.frame, x: s.x, y: 0, z: s.z });
  }

  private integrate(): void {
    const p = this.player;
    if (!p.grounded) {
      let g = p.vel.y > 0 ? JUMP.gravityUp : JUMP.gravityDown;
      if (p.mode === 'attack') {
        const step = comboFor(p.weapon, p.perks)[p.attackIndex];
        if (p.attackFrame <= step.startup + step.active) g *= ATTACK.airGravityScale;
      }
      p.vel.y = Math.max(-JUMP.maxFall, p.vel.y - g * STEP);
    }

    p.pos.x += p.vel.x * STEP;
    p.pos.y += p.vel.y * STEP;
    p.pos.z += p.vel.z * STEP;

    this.collide();

    if (p.pos.y <= 0) {
      if (!p.grounded && p.vel.y <= 0) {
        p.grounded = true;
        p.jumpsUsed = 0;
        p.flipFrame = -1;
        p.landFrame = 0;
        p.landImpact = Math.min(1, -p.vel.y / 20);
        this.emit({ type: 'land', frame: this.frame, x: p.pos.x, y: 0, z: p.pos.z, impact: p.landImpact });
      }
      p.pos.y = 0;
      p.vel.y = 0;
    }

    if (p.grounded && p.mode === 'normal') p.runPhase += len(p.vel.x, p.vel.z) * STEP;
  }

  private collide(): void {
    const p = this.player;
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
    for (const o of this.world.obstacles) push(o.x, o.z, o.r);
    if (this.opts.training && p.pos.y < 1.8) push(this.dummy.x, this.dummy.z, DUMMY.radius);

    const r = len(p.pos.x, p.pos.z);
    if (r > this.world.radius) {
      p.pos.x *= this.world.radius / r;
      p.pos.z *= this.world.radius / r;
    }
  }

  private updateDummy(): void {
    const d = this.dummy;
    d.tiltVX += (-DUMMY.spring * d.tiltX - DUMMY.damping * d.tiltVX) * STEP;
    d.tiltVZ += (-DUMMY.spring * d.tiltZ - DUMMY.damping * d.tiltVZ) * STEP;
    d.tiltX += d.tiltVX * STEP;
    d.tiltZ += d.tiltVZ * STEP;
    d.flashFrame = Math.min(d.flashFrame + 1, 999);
    if (d.brokenFrame >= 0) {
      d.brokenFrame++;
      if (d.brokenFrame >= DUMMY.resetFrames) {
        d.brokenFrame = -1;
        d.hp = DUMMY.hp;
      }
    }
  }
}
