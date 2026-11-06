import {
  ATTACK,
  COMBAT,
  DEFAULT_BUILD,
  HOTBAR_SLOTS,
  JUMP,
  MOVE,
  SLIDE_SKILL,
  MOVEMENT_SKILLS,
  MP,
  NO_MOVEMENT,
  NO_ABILITY,
  variantBits,
  SPECIAL,
  STAMINA,
  type Build,
} from '../tuning';
import { BOOK, emptySkills, resolveSkills, sameLevels, type Levels, type ResolvedSkills, type SkillSet } from '../skills';
import { Actors, type Actor } from './actor';
import { actorKind } from '../content/actors';
import { sightingAt, startBrain, type Sighting } from './ai/brain';
import { foesOf, sightingOf } from './ai/senses';
import { bandAround } from './world';
import { liveTargets, type Target } from './combat/hit';
import { ON_FOOT, type Actions, type GameEvent, type PlayerState, type Spawn, type World } from './types';
import { integrate, updateNormal, accelerateToward, airControl } from './player/locomotion';
import { bufferAction, updateAction, updateCast } from './player/abilities';
import { updateAttack, checkShot, takeHit, respawn } from './player/attacks';
import { damage, damageFrom, damageCircle } from './combat/deal';
import { updateActors } from './actors/step';
import { openGlider, updateGlide, updateSwim } from './player/traverse';
import { regenVitals, shortFor } from './player/vitals';

/** The open-world systems (vehicles, trade, farming, housing...) a Sim can carry. src/sim/life. */
export interface LifeHooks {
  /** Steps the vehicle you are riding, with your controls. */
  ride(sim: Sim, a: Actions): void;
  /** Everything else in the world, once per step, after you have moved. */
  step(sim: Sim, a: Actions): void;
  /** Something you did (a hit landed, a cast, a roll): the skill behind it gains experience. */
  observe(e: GameEvent): void;
}

export interface SimOptions {
  // Training: the dummy is a target, hits pause the action briefly, and attacks auto-aim.
  // Networked play turns these off, because the server decides what gets hit.
  // crates/engine/src/player.rs must follow the same rules (tests/conformance/player.test.ts checks it).
  training: boolean;
}

// Fixed-step game rules: 60 steps per second, same result every time for the same inputs.
export class Sim {
  frame = 0;
  hitstop = 0;
  player!: PlayerState;
  /** Everything in the world that is not the player. */
  readonly actors = new Actors(actorKind);
  private pending: GameEvent[] = [];
  readonly log: GameEvent[] = [];
  /** Open-world systems, when this world has them (null on the training grounds). */
  life: LifeHooks | null = null;

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
      actionBuffer: 0,
      actionBufferId: NO_MOVEMENT,
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
      stamina: STAMINA.max,
      staminaDelay: 0,
      mp: MP.max,
      stun: 0,
      downFrame: -1,
      team,
      weapon: build.weapon,
      skills: [...build.skills],
      comboVariants: variantBits(resolveSkills(build.skills)),
      abilities: [...build.abilities],
      cooldowns: new Array<number>(HOTBAR_SLOTS).fill(0),
      movement: [...build.movement],
      movementCooldowns: new Array<number>(MOVEMENT_SKILLS.length).fill(0),
      actionId: NO_MOVEMENT,
      actionFrame: 0,
      actionDirX: 0,
      actionDirZ: 1,
      actionSlot: 0,
      abilityBuffer: 0,
      abilityBufferSlot: 0,
      sprinting: false,
      crouching: false,
      crouchFrame: 0,
      castSlot: 0,
      castAbility: NO_ABILITY,
      castFrame: 0,
      castTargetX: 0,
      castTargetZ: 0,
      firedAbility: NO_ABILITY,
      ...ON_FOOT,
    };
    this.actors.clear();
    if (this.opts.training) {
      // Spawn points that share a band number fight together, each band with an id of its own.
      const bands = new Map<number, number>();
      for (const point of this.world.spawns) {
        const a = this.actors.spawn(point);
        if (point.band) {
          if (!bands.has(point.band)) bands.set(point.band, this.actors.newBand());
          a.band = bands.get(point.band)!;
        }
        startBrain(a, this.sighting());
      }
    }
  }

  /** What a brain can see of the player this frame. Someone knocked down is nobody's target. */
  sighting(): Sighting {
    const f = foesOf(this)[0];
    return f ? sightingOf(f) : sightingAt(this.player.pos.x, this.player.pos.z, false);
  }

  /**
   * A war-band of `count` of a kind in a ring round (x, z), fighting together (src/sim/ai/pack.ts).
   * They are home actors: they come back where they stood. Returns their ids.
   */
  spawnBand(kind: string, count: number, x: number, z: number, seed = 0x9b1d): number[] {
    const band = this.actors.newBand();
    return bandAround(kind, count, x, z, band, seed).map((point) => {
      const a = this.actors.spawn(point);
      a.band = band;
      startBrain(a, this.sighting());
      return a.id;
    });
  }

  /** The first actor of a kind, for the few callers that want a specific one by name. */
  actorOfKind(kind: string): Actor | undefined {
    return this.actors.all().find((a) => a.kind === kind);
  }

  /** Everything an attack could land on right now. */
  targets(): Target[] {
    const list = liveTargets(this.actors.all());
    // On hills an actor's own heights are off its patch of ground; projectiles fly in world height.
    const hf = this.world.terrain;
    if (hf) {
      for (const t of list) {
        const g = hf.height(t.x, t.z);
        t.y += g;
        t.hitHeight += g;
        t.hitCeiling += g;
      }
    }
    return list;
  }

  // Switches skills and loadout, the way the server does (crates/engine/src/player.rs apply_build): any
  // attack or cast in progress is dropped.
  setBuild(b: Build): void {
    const p = this.player;
    p.weapon = b.weapon;
    p.skills = [...b.skills];
    p.comboVariants = variantBits(resolveSkills(b.skills));
    p.abilities = [...b.abilities];
    p.movement = [...b.movement];
    if (p.mode === 'action') p.mode = 'normal';
    p.actionId = NO_MOVEMENT;
    p.actionFrame = 0;
    if (p.mode === 'attack' || p.mode === 'cast') p.mode = 'normal';
    p.attackIndex = 0;
    p.attackFrame = 0;
    p.attackQueued = false;
    p.castAbility = NO_ABILITY;
    p.castSlot = 0;
    p.castFrame = 0;
  }

  // Events since the last call (the renderer uses these for effects).
  drainEvents(): GameEvent[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  emit(e: GameEvent): void {
    this.pending.push(e);
    this.log.push(e);
    if (this.log.length > 500) this.log.shift();
    this.life?.observe(e);
  }

  step(a: Actions): void {
    this.frame++;
    const p = this.player;
    p.prevPos = { ...p.pos };
    p.prevFacing = p.facing;
    p.firedAbility = NO_ABILITY;

    // Presses are remembered for a few frames so slightly early inputs still count.
    if (a.jumpPressed) p.jumpBuffer = JUMP.bufferFrames;
    if (a.attackPressed) p.attackBuffer = ATTACK.bufferFrames;
    if (a.slidePressed) bufferAction(this, SLIDE_SKILL);
    if (a.abilitySlot >= 1 && a.abilitySlot <= HOTBAR_SLOTS) {
      p.abilityBuffer = SPECIAL.bufferFrames;
      p.abilityBufferSlot = a.abilitySlot;
    }

    // Hit pause (training only): everything freezes briefly when a hit lands. Buffered presses are kept.
    if (this.opts.training && this.hitstop > 0) {
      this.hitstop--;
      return;
    }

    p.landFrame = Math.min(p.landFrame + 1, 999);
    p.takeoffFrame = Math.min(p.takeoffFrame + 1, 999);
    if (p.flipFrame >= 0) p.flipFrame = p.flipFrame + 1 > JUMP.flipFrames ? -1 : p.flipFrame + 1;
    for (let i = 0; i < HOTBAR_SLOTS; i++) if (p.cooldowns[i] > 0) p.cooldowns[i]--;
    for (let i = 0; i < p.movementCooldowns.length; i++) if (p.movementCooldowns[i] > 0) p.movementCooldowns[i]--;
    regenVitals(p);
    // A dodge or a cast asked for without the stamina or MP it costs doesn't start; say why.
    const short = shortFor(this, a);
    if (short) this.emit({ type: 'short', frame: this.frame, what: short });
    p.coyote = p.grounded ? JUMP.coyoteFrames : Math.max(0, p.coyote - 1);

    // Releasing jump early gives a short hop.
    if (!a.jumpHeld && !p.jumpCutDone && p.vel.y > 0 && p.jumpsUsed === 1) {
      p.vel.y *= JUMP.shortHopCut;
      p.jumpCutDone = true;
    }

    // Sprinting and crouching only happen while you have normal control; every other mode
    // (stunned, sliding, attacking, casting, knocked down) drops them.
    p.sprinting = false;
    p.crouching = false;

    if (p.downFrame >= 0) {
      // Knocked down: lie still, then get back up at the team's spawn point.
      p.mode = 'normal';
      p.downFrame++;
      if (p.grounded) accelerateToward(this, 0, 0, MOVE.groundDecel);
      if (p.downFrame >= COMBAT.downFrames) respawn(this);
    } else if (p.stun > 0) {
      // Stunned after a hit: no control until it wears off.
      p.stun--;
      p.mode = 'normal';
      if (p.grounded) accelerateToward(this, 0, 0, MOVE.groundDecel);
      else airControl(this, 0, 0, 0);
    } else if (p.mode === 'action') updateAction(this, a);
    else if (p.mode === 'cast') updateCast(this, a);
    else if (p.mode === 'attack') updateAttack(this, a);
    else if (p.mode === 'swim') updateSwim(this, a);
    else if (p.mode === 'glide') updateGlide(this, a);
    else if (p.mode === 'ride') this.life?.ride(this, a);
    else {
      // In the air with both jumps spent, jump again to open your glider.
      if (this.world.terrain && !p.grounded && p.jumpBuffer > 0 && p.jumpsUsed >= 2 && openGlider(this)) updateGlide(this, a);
      else updateNormal(this, a);
    }

    p.crouchFrame = p.crouching ? Math.min(MOVE.crouchEnterFrames, p.crouchFrame + 1) : Math.max(0, p.crouchFrame - 1);

    integrate(this);
    if (p.mode === 'attack') checkShot(this);
    if (this.opts.training) updateActors(this);
    this.life?.step(this, a);

    if (p.jumpBuffer > 0) p.jumpBuffer--;
    if (p.attackBuffer > 0) p.attackBuffer--;
    if (p.actionBuffer > 0 && --p.actionBuffer === 0) p.actionBufferId = NO_MOVEMENT;
    if (p.abilityBuffer > 0 && --p.abilityBuffer === 0) p.abilityBufferSlot = 0;
  }

  /**
   * The level of each skill in the skill book (src/skills.ts BOOK), which adds to what it does.
   * The island keeps the experience behind them and sets this; the training yard keeps its own.
   */
  levels: Levels = BOOK.map(() => 1);

  // The build's resolved modifiers. Recomputed only when the learned set or a level actually
  // changes, so a frame costs a handful of integer comparisons rather than a walk of the tree.
  private resolvedFor: SkillSet = [];
  private resolvedLevels: Levels = BOOK.map(() => 1);
  private resolved: ResolvedSkills = resolveSkills(emptySkills());

  get stats(): ResolvedSkills {
    const s = this.player.skills;
    let same = this.resolvedFor.length === s.length && sameLevels(this.resolvedLevels, this.levels);
    for (let i = 0; same && i < s.length; i++) same = this.resolvedFor[i] === s[i];
    if (!same) {
      this.resolvedFor = [...s];
      this.resolvedLevels = [...this.levels];
      this.resolved = resolveSkills(s, this.levels);
    }
    return this.resolved;
  }

  addEvent(e: GameEvent): void {
    this.emit(e);
  }

  // A bow looses its arrow on the first active frame, from where the server fires it (game.rs).

  // ---- what the rest of the game calls -------------------------------------
  // The rules themselves live in ./player and ./combat; these keep the old surface so callers
  // do not have to know which file a system moved into.
  takeHit(damageAmount: number, dirX: number, dirZ: number, knock: number): void {
    takeHit(this, damageAmount, dirX, dirZ, knock);
  }
  damage(t: Target, amount: number, knock = 0, index = 0, weapon?: number): void {
    damage(this, t, amount, knock, index, weapon);
  }
  damageFrom(t: Target, amount: number, nx: number, nz: number, knock = 0, index = 0, weapon?: number): void {
    damageFrom(this, t, amount, nx, nz, knock, index, weapon);
  }
  damageCircle(x: number, z: number, radius: number, amount: number, knock = 0, index = 0): void {
    damageCircle(this, x, z, radius, amount, knock, index);
  }

}
