import { actorKindAt } from '../content/actors';
import { ABILITIES, abilityRadius, AIM, CAMERA, comboFor, groundRange, isGroundTargeted, NO_ABILITY } from '../content/tuning';
import type { Engine } from '../engine/engine';
import type { CombatInput, Input } from '../input/input';
import type { NetActor } from '../net/worldFeed';
import type { FollowCamera } from '../render/camera';
import { isAlive } from '../sim/actor';
import type { Actions } from '../sim/types';
import { createTargeting, type Targeting } from './targeting';

// Aiming: who you're aimed at, the circle a ground-aimed spell is placed with, aim assist and the
// combat stance. Each rendered frame reads the aiming controls (update), and each rules step turns
// what you pressed into what the rules see (aim).

const DEG = Math.PI / 180;
/** Frames the combat stance holds after your last swing or cast. */
const STANCE_LINGER = 90;

/** Someone else in the world as drawn on this screen, with their side and health. */
interface Drawn {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  team: number;
  hp: number;
}

export interface AimingParts {
  engine: Engine;
  follow: FollowCamera;
  input: Input;
  /** The game marks the enemy you most likely mean before you pick one (`?softLock`). */
  softLock: boolean;
  /** What to call each actor kind on the target plate. */
  names: Record<string, string>;
  /** Online: the server's monsters, where they're drawn on this screen. */
  netActors: () => readonly NetActor[];
  /** Online: everyone else in the world (players and bots), where they're drawn. */
  peers: () => readonly Drawn[];
}

export class Aiming {
  /** Who you're aimed at: a soft lock you can override with Tab (targeting.ts). */
  readonly lockOn: Targeting;
  /** The ground-aimed circle while it's up: where it is, the ability's range and the circle's radius. */
  readonly reticle = { x: 0, z: 0, range: 0, radius: 0 };
  /** 0, or 1 or 2 while that ability is held down to place its circle. */
  slot = 0;
  /** Test hook: swing at the nearest enemy you can see within reach. */
  autoAttack = false;
  private autoCooldown = 0;
  private lastFight = -Infinity;
  // The circle is a cursor you push around, held as an offset from wherever you are. It can't be a
  // raycast through the middle of the screen: the camera always looks straight at you, so that point
  // is always your own feet however you tilt the sticks.
  private readonly offset = { x: 0, z: 0 };
  private combat: CombatInput;
  // Escape while placing a circle, kept until a rules step has seen it: a fast screen draws frames
  // that run no step at all, and a press read in one of those would otherwise be lost.
  private cancelWaiting = false;

  constructor(private readonly parts: AimingParts) {
    const { engine, follow } = parts;
    this.lockOn = createTargeting({
      rules: engine,
      camera: () => follow.camera,
      yaw: () => follow.yaw,
      online: engine.online,
      softLock: parts.softLock,
      names: parts.names,
      netActors: parts.netActors,
      peers: parts.peers,
    });
    this.combat = parts.input.pollCombat();
  }

  /** Picks the next (1) or previous (-1) enemy around you, as Tab does. */
  cycleTarget(step: number): void {
    this.lockOn.cycle(step);
  }

  /** In a fight: an enemy marked, or a swing or cast just made. The hero's weapon is out for it. */
  inAFight(): boolean {
    return this.lockOn.mark() !== null || this.parts.engine.frame - this.lastFight < STANCE_LINGER;
  }

  /** Whether an enemy you could aim at stands within `r` of (x, z). */
  enemyAt(x: number, z: number, r: number): boolean {
    let hit = false;
    this.forEachEnemy((ex, ez) => {
      if (!hit && (ex - x) * (ex - x) + (ez - z) * (ez - z) < r * r) hit = true;
    });
    return hit;
  }

  /**
   * Reads the aiming controls once per rendered frame, before any rules step uses them. `cam` is
   * what the camera would have done; while the circle is up, that input moves the circle instead, so
   * the view stays put and you can see where the spell is going. True while a circle is being placed.
   */
  update(cam: { dYaw: number; dPitch: number }, dt: number): boolean {
    const { engine, follow, input } = this.parts;
    const combat = input.pollCombat();
    this.combat = combat;
    for (let i = 0; i < combat.nextTarget; i++) this.cycleTarget(1);
    for (let i = 0; i < combat.prevTarget; i++) this.cycleTarget(-1);
    if (combat.cancel > 0 && this.slot === 0) {
      // Escape with nothing being aimed drops the target instead.
      this.lockOn.clear();
    } else if (combat.cancel > 0) {
      this.cancelWaiting = true;
    }
    this.lockOn.update();

    if (this.slot === 0) {
      follow.stopAiming();
      return false;
    }
    const ability = engine.player.abilities[this.slot - 1] ?? NO_ABILITY;
    const r = groundRange(ability);
    if (r === null) {
      this.slot = 0;
      follow.stopAiming();
      return false;
    }
    this.reticle.radius = abilityRadius(ability, engine.stats);
    if (input.lastDevice === 'gamepad') {
      // Left stick places the circle; the character stays put while you aim.
      this.moveAim(combat.stickX * AIM.stickSpeed * dt, combat.stickY * AIM.stickSpeed * dt, r);
    } else {
      // Mouse, with the pointer captured: the movement that would have turned the camera slides the
      // circle instead. dYaw is negated because turning right moves the view right.
      const s = CAMERA.mouseSensitivity;
      this.moveAim((-cam.dYaw / s) * AIM.mouseSpeed, (-cam.dPitch / s) * AIM.mouseSpeed, r);
    }
    follow.aimAt(this.reticle.x, this.reticle.z);
    return true;
  }

  /**
   * What you pressed, as the rules should see it this step: targeting supplies an aim when it has a
   * mark or a placed circle, aim assist only fills in the gaps it leaves, and the combat stance keeps
   * you facing the fight.
   */
  aim(a: Actions): Actions {
    return this.combatStance(this.aimAssist(this.targeting(this.autoAttack ? this.autoAim(a) : a)));
  }

  // Enemies you could aim at, where they're drawn on this screen: the dummy, other players, bots.
  private forEachEnemy(fn: (x: number, z: number) => void): void {
    const { engine } = this.parts;
    const myTeam = engine.player.team;
    if (!engine.online) for (const a of engine.actors.all()) if (isAlive(a) && a.faction !== 0 && a.faction !== 2) fn(a.x, a.z);
    // The server's monsters (not townsfolk, not other players' things), where they're drawn.
    for (const a of this.parts.netActors()) {
      const f = actorKindAt(a.kind)?.faction ?? 0;
      if (a.deadFrame < 0 && f !== 0 && f !== 2) fn(a.x, a.z);
    }
    for (const p of this.parts.peers()) if (p.team !== myTeam && p.hp > 0) fn(p.x, p.z);
  }

  // Test hook: swing at the nearest enemy you can see within reach (players first, then bots), using
  // the positions drawn on this screen.
  private autoAim(a: Actions): Actions {
    if (this.autoCooldown > 0) {
      this.autoCooldown--;
      return a;
    }
    const { engine } = this.parts;
    const me = engine.player.pos;
    let best: { x: number; z: number } | null = null;
    let bestD = 2.3;
    for (const r of this.parts.peers()) {
      const d = Math.hypot(r.x - me.x, r.z - me.z);
      if (r.team !== engine.player.team && r.hp > 0 && d < bestD) {
        bestD = d;
        best = r;
      }
    }
    if (!best) return a;
    this.autoCooldown = 30;
    const dx = best.x - me.x;
    const dz = best.z - me.z;
    const l = Math.hypot(dx, dz) || 1;
    return { ...a, moveX: dx / l, moveZ: dz / l, attackPressed: true };
  }

  // Combat stance: with an enemy marked, or for a moment after you swing or cast, you keep facing
  // where the camera looks, so the stick strafes and backs off, and dodges and double jumps go any of
  // eight ways. Out of a fight you turn and run the way you push; sprinting always does (the rules
  // see to that). Swimming, gliding and riding ignore it.
  private combatStance(a: Actions): Actions {
    if (a.faceX !== 0 || a.faceZ !== 0) return a; // already given (tests)
    const { engine, follow } = this.parts;
    const p = engine.player;
    if (p.mode === 'attack' || p.mode === 'cast') this.lastFight = engine.frame;
    if (!this.inAFight() || p.mode === 'ride' || p.mode === 'swim' || p.mode === 'glide') return a;
    return { ...a, faceX: Math.sin(follow.yaw), faceZ: Math.cos(follow.yaw) };
  }

  // Aim assist: attacks and Meteor go toward the enemy you most likely mean, the nearest one close
  // to the direction you're pushing (or facing; the bow and Meteor use the camera's direction when you
  // stand still). With nothing to aim at, the bow and Meteor still go where the camera looks. The
  // rules only read the aim when an attack or cast starts, so it's only worked out while one is pending.
  private aimAssist(a: Actions): Actions {
    if (a.aimX !== 0 || a.aimZ !== 0) return a; // already aimed (tests)
    const { engine, follow } = this.parts;
    const p = engine.player;
    const pending = a.abilitySlot || (p.abilityBuffer > 0 ? p.abilityBufferSlot : 0);
    const aiming = pending >= 1 ? (p.abilities[pending - 1] ?? NO_ABILITY) : NO_ABILITY;
    const casting = aiming !== NO_ABILITY && isGroundTargeted(aiming);
    const attacking = a.attackPressed || p.attackBuffer > 0 || p.attackQueued;
    if (!casting && !attacking) return a;
    const bow = p.weapon === 3;
    const ranged = casting || bow;
    const moving = Math.hypot(a.moveX, a.moveZ) > 0.3;
    const dir = moving ? Math.atan2(a.moveX, a.moveZ) : ranged ? follow.yaw : p.facing;
    const swing = comboFor(p.weapon, engine.stats)[0];
    const maxDist = casting ? (groundRange(aiming) ?? 16) : bow ? Math.min(30, swing.projectileRange ?? 30) : swing.reach + 1.6;
    const cone = (casting ? 30 : bow ? 14 : 55) * DEG;
    let best: { x: number; z: number } | null = null;
    let bestScore = Infinity;
    this.forEachEnemy((x, z) => {
      const dx = x - p.pos.x;
      const dz = z - p.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > maxDist || dist < 0.05) return;
      let off = Math.abs(Math.atan2(dx, dz) - dir) % (Math.PI * 2);
      if (off > Math.PI) off = Math.PI * 2 - off;
      if (off > cone) return;
      const score = dist / maxDist + off / cone;
      if (score < bestScore) {
        bestScore = score;
        best = { x, z };
      }
    });
    const target = best as { x: number; z: number } | null;
    if (target) return { ...a, aimX: target.x - p.pos.x, aimZ: target.z - p.pos.z };
    if (!ranged || moving) return a;
    const reach = casting ? (ABILITIES[aiming]?.range ?? 9) : 20;
    return { ...a, aimX: Math.sin(dir) * reach, aimZ: Math.cos(dir) * reach };
  }

  // Turns the raw buttons into the actions the rules see: holding a ground-aimed ability arms it
  // instead of casting, releasing it casts at the circle, and the marked enemy supplies the aim.
  private targeting(a: Actions): Actions {
    const { engine, input } = this.parts;
    // The first step after an Escape takes it, whatever happens next.
    const cancel = this.cancelWaiting;
    this.cancelWaiting = false;
    // An action that already carries an aim was aimed by whoever made it (the test hooks, and
    // autoAim): it casts straight away rather than arming the circle, matching aimAssist().
    if (a.aimX !== 0 || a.aimZ !== 0) return a;
    let out = a;
    if (this.slot === 0 && a.abilitySlot >= 1) {
      const ability = engine.player.abilities[a.abilitySlot - 1] ?? NO_ABILITY;
      if (groundRange(ability) !== null) {
        // Ground-aimed: the press arms the circle instead of casting.
        this.slot = a.abilitySlot;
        out = { ...out, abilitySlot: 0 };
        this.reticle.radius = abilityRadius(ability, engine.stats);
        this.startAiming(groundRange(ability) ?? 16);
      }
    }
    const p = engine.player;
    if (this.slot !== 0) {
      // Escape, or B on a pad (which would otherwise slide), backs out without casting.
      if (cancel || out.slidePressed) {
        this.slot = 0;
        return { ...out, slidePressed: false, abilitySlot: 0 };
      }
      if (this.combat.slotHeld !== this.slot) {
        const slot = this.slot;
        this.slot = 0;
        return { ...out, abilitySlot: slot, aimX: this.reticle.x - p.pos.x, aimZ: this.reticle.z - p.pos.z };
      }
      // On a pad the left stick is placing the circle, so it mustn't also walk you around.
      if (input.lastDevice === 'gamepad') return { ...out, moveX: 0, moveZ: 0, abilitySlot: 0 };
      return { ...out, abilitySlot: 0 };
    }
    const swinging = out.attackPressed || p.attackBuffer > 0 || p.attackQueued;
    const mark = this.lockOn.mark();
    // A blade only turns to the mark when it can reach it: swinging at the slime beside you while
    // one further off is marked hits the one beside you (aimAssist), not the air. The bow shoots at
    // the mark wherever it is.
    const reach = p.weapon === 3 ? Infinity : comboFor(p.weapon, engine.stats)[0].reach + 1.6;
    if (mark && swinging && Math.hypot(mark.x - p.pos.x, mark.z - p.pos.z) <= reach) return { ...out, aimX: mark.x - p.pos.x, aimZ: mark.z - p.pos.z };
    return out;
  }

  // Opening the circle: start it on whoever is marked, so the common case of "drop it on that one"
  // needs no aiming at all. Otherwise put it out in front of the camera.
  private startAiming(maxRange: number): void {
    const { engine, follow } = this.parts;
    const mark = this.lockOn.mark();
    if (mark) {
      this.offset.x = mark.x - engine.player.pos.x;
      this.offset.z = mark.z - engine.player.pos.z;
    } else {
      this.offset.x = Math.sin(follow.yaw) * maxRange * AIM.startRange;
      this.offset.z = Math.cos(follow.yaw) * maxRange * AIM.startRange;
    }
    this.clampAim(maxRange);
  }

  // Pushes the circle, in the directions the camera is facing, and keeps it inside the ability's
  // range rather than refusing to cast (GW2's "lock ground target at maximum range").
  private moveAim(right: number, away: number, maxRange: number): void {
    if (right !== 0 || away !== 0) {
      const fx = Math.sin(this.parts.follow.yaw);
      const fz = Math.cos(this.parts.follow.yaw);
      this.offset.x += fx * away - fz * right;
      this.offset.z += fz * away + fx * right;
    }
    this.clampAim(maxRange);
  }

  private clampAim(maxRange: number): void {
    const { offset, reticle } = this;
    const d = Math.hypot(offset.x, offset.z);
    if (d > maxRange) {
      offset.x = (offset.x / d) * maxRange;
      offset.z = (offset.z / d) * maxRange;
    }
    const pos = this.parts.engine.player.pos;
    reticle.x = pos.x + offset.x;
    reticle.z = pos.z + offset.z;
    reticle.range = maxRange;
  }
}
