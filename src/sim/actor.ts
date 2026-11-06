// Everything in the world that is not the player: monsters, NPCs, props. One flat record rather
// than a type per creature, because the rules walk this list every frame and the Rust side keeps
// the same shape. A few fields only some kinds use (a prop's lean, a brain's scratch) cost four
// numbers each and save a hierarchy nobody wants to mirror twice.

import { findKind, ladderOf } from '../content/actors';

export type ActorId = number;

/** The player is a target like any other, but it is not an Actor; this stands in for it. */
export const PLAYER_ID: ActorId = 0;

export const FACTION = { player: 0, hostile: 1, neutral: 2, prop: 3 } as const;

export interface Actor {
  id: ActorId;
  /** Content key: which ActorKind this was spawned from. */
  kind: string;
  faction: number;

  x: number;
  y: number; // visual height off the ground - a hop, a hover
  z: number;
  facing: number;

  radius: number;
  /** Where a damage number pops, above the actor's feet. */
  hitHeight: number;
  /** A projectile flying higher than this passes over. */
  hitCeiling: number;
  /** Whether the player bumps into it. */
  solid: boolean;

  hp: number;
  maxHp: number;
  /** Frames since the last hit, for the white flash. */
  flashFrame: number;
  /** -1 while alive, otherwise frames since it died. */
  deadFrame: number;

  /** Behaviour: which brain drives it, and where that brain has got to. */
  brain: string | null;
  state: number;
  stateFrame: number;
  wait: number;
  /** The direction the brain has chosen, and the spot it drifts back to. */
  moveX: number;
  moveZ: number;
  homeX: number;
  homeZ: number;
  /** Its own random stream, so behaviour is repeatable and independent of spawn order. */
  seed: number;

  /** Props lean when hit; most kinds leave these at zero. */
  leanX: number;
  leanZ: number;
  leanVX: number;
  leanVZ: number;

  // ---- creatures that come in sizes (shared/actors.json ladders) ----
  /** How much of it there is. Gathering adds the mass of what it takes in. */
  mass: number;
  /** Which ladder its kind is on, or -1. */
  ladder: number;
  /** Made during a fight (a burst piece, a reformed one): cleared away when it dies, never respawns. */
  transient: boolean;
  /** The kind it was spawned as, which it comes back as. */
  homeKind: string;
  /** Taken out of the world without dying (absorbed, merged): not drawn, waiting to respawn. */
  gone: boolean;

  // ---- what its brain is up to with the others ----
  /** Frames it stays angry at you. */
  angry: number;
  slamCd: number;
  gatherCd: number;
  /** The caller it is rallying to, or 0. */
  rallyTo: ActorId;
  /** Frames since it started calling the pack, or -1 when it isn't. */
  calling: number;
  /** Damage taken since its current cast began, for breaking it. */
  taken: number;
  /** Frames left on its burst group's fuse (or, alone, before it dissolves); -1 for none. */
  fuse: number;
  /** The burst group it belongs to, or 0. */
  group: number;
  /** What its group becomes if it survives the fuse; '' to dissolve instead. */
  reform: string;
  /** Frames it stays held by someone's pull; its brain waits meanwhile. */
  pulled: number;
  /** Metres the current move covers. */
  stride: number;
  /** Where a slam it is winding up will land. */
  targetX: number;
  targetZ: number;

  // ---- creatures that fight as a pack (src/sim/ai/pack.ts) ----
  /** The foe it is after (a player, by foe id), or 0. */
  target: number;
  /** The war-band it fights with, or 0 on its own. */
  band: number;
  /** The pack lets it strike its foe now. */
  token: boolean;
  /** It was let in because the foe left an opening (back turned, recovering, casting, stunned). */
  opening: boolean;
  /** Its courage has run out: it wants to get away, to its friends or home. */
  afraid: boolean;
  /** Where on the ring around its foe it should stand while it waits. */
  slotX: number;
  slotZ: number;
  /** Where it runs to when afraid: the biggest group of its band, or home. */
  rallyX: number;
  rallyZ: number;
  /** Where a wander is heading. */
  destX: number;
  destZ: number;
  /** Heals it carries (a goblin's stolen potion). */
  charges: number;
  /** Frames before each of its brain's attacks can be used again, in the brain's order. */
  cds: number[];
  /** The current state's blow or throw has gone. */
  struck: boolean;
}

/** How many attacks a brain can list, each with its own cooldown. */
export const ATTACK_SLOTS = 4;

/** Something thrown or shot by a creature, in flight (src/sim/combat/missiles.ts). */
export interface Missile {
  id: number;
  /** The actor that threw it, and the attack (an index into ATTACKS) it came from. */
  owner: ActorId;
  attack: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  radius: number;
  damage: number;
  knock: number;
  /** Frames since it was thrown. */
  age: number;
}

export interface ActorSpawn {
  kind: string;
  x: number;
  z: number;
  facing?: number;
  seed?: number;
}

/** A slam: where it lands and what it does to whoever is standing there. */
export interface SlamDef {
  /** It winds up when you are this close. */
  range: number;
  /** The furthest it jumps. */
  leap: number;
  radius: number;
  damage: number;
  knock: number;
}

/** What a kind of actor is, before one exists. Content, not state. */
export interface ActorKind {
  id: string;
  faction: number;
  maxHp: number;
  radius: number;
  hitHeight: number;
  hitCeiling: number;
  solid: boolean;
  /** Behaviour id, or null for something that just stands there. */
  brain: string | null;
  /** Frames face-down before it comes back; -1 never respawns. */
  respawnFrames: number;
  /** Which species the renderers draw it as, or null for a bespoke renderer. */
  species: string | null;
  /** Behaviour state name (or 'dead') to clip name, for whichever species it uses. */
  clips: Record<string, string>;
  /** Recolours the species' team slot, so one body can serve several creatures. */
  palette?: { teamA: number; teamB: number };
  /** How big the species is drawn. Drawing only. */
  scale?: number;
  /** For a kind on a ladder: how much of the creature it is. */
  mass?: number;
  /** Dies into this many of another kind. */
  burst?: { into: string; count: number };
  slam?: SlamDef;
  /** Whether it can call the pack and gather them in. */
  gathers?: boolean;
  /** A blow dealing at least this much knocks it out of what it was doing (its brain's flinch). */
  poise?: number;
  /** What its target plate calls it. Drawing only. */
  name?: string;
  /** Clips that play by distance walked, not by state: metres one cycle covers. Drawing only. */
  cycles?: Record<string, number>;
}

export const isAlive = (a: Actor): boolean => a.deadFrame < 0;

const MAX_ID = 65535; // ids go out on the wire as 16 bits

/** The world's actors. Dead ones stay in place so they can respawn where they fell. */
export class Actors {
  private list: Actor[] = [];
  private byId = new Map<ActorId, Actor>();
  private nextId: ActorId = 1;
  private nextGroup = 1;
  private nextBand = 1;
  private nextMissile = 1;
  /** What creatures have thrown, still in the air. */
  missiles: Missile[] = [];
  /** Testing: nothing gets angry, so a test that hits a monster isn't hit back. */
  calm = false;

  constructor(private kinds: (id: string) => ActorKind) {}

  clear(): void {
    this.list = [];
    this.byId.clear();
    this.nextId = 1;
    this.nextGroup = 1;
    this.nextBand = 1;
    this.nextMissile = 1;
    this.missiles = [];
  }

  /** A fresh id for a war-band. */
  newBand(): number {
    const b = this.nextBand;
    this.nextBand = b >= 0x7fffffff ? 1 : b + 1;
    return b;
  }

  /** A fresh id for a missile. */
  missileId(): number {
    const m = this.nextMissile;
    this.nextMissile = m >= 0x7fffffff ? 1 : m + 1;
    return m;
  }

  // Counts up and wraps, skipping ids still in use, so a long fight never runs out and an id is
  // not handed straight back out to something new the moment the old one goes.
  private allocate(): ActorId {
    for (;;) {
      const id = this.nextId;
      this.nextId = id >= MAX_ID ? 1 : id + 1;
      if (!this.byId.has(id)) return id;
    }
  }

  /** A fresh id for a burst group. */
  newGroup(): number {
    const g = this.nextGroup;
    this.nextGroup = g >= 0x7fffffff ? 1 : g + 1;
    return g;
  }

  spawn(s: ActorSpawn): Actor {
    const k = this.kinds(s.kind);
    const id = this.allocate();
    const a: Actor = {
      id,
      kind: k.id,
      faction: k.faction,
      x: s.x,
      y: 0,
      z: s.z,
      facing: s.facing ?? 0,
      radius: k.radius,
      hitHeight: k.hitHeight,
      hitCeiling: k.hitCeiling,
      solid: k.solid,
      hp: k.maxHp,
      maxHp: k.maxHp,
      flashFrame: 999,
      deadFrame: -1,
      brain: k.brain,
      state: 0,
      stateFrame: 0,
      wait: 0,
      moveX: 0,
      moveZ: 1,
      homeX: s.x,
      homeZ: s.z,
      seed: s.seed ?? id * 0x9e3779b1,
      leanX: 0,
      leanZ: 0,
      leanVX: 0,
      leanVZ: 0,
      mass: k.mass ?? 0,
      ladder: ladderOf(k.id),
      transient: false,
      homeKind: k.id,
      gone: false,
      angry: 0,
      slamCd: 0,
      gatherCd: 0,
      rallyTo: 0,
      calling: -1,
      taken: 0,
      fuse: -1,
      group: 0,
      reform: '',
      pulled: 0,
      stride: 0,
      targetX: s.x,
      targetZ: s.z,
      target: 0,
      band: 0,
      token: false,
      opening: false,
      afraid: false,
      slotX: s.x,
      slotZ: s.z,
      rallyX: s.x,
      rallyZ: s.z,
      destX: s.x,
      destZ: s.z,
      charges: 0,
      cds: new Array<number>(ATTACK_SLOTS).fill(0),
      struck: false,
    };
    this.list.push(a);
    this.byId.set(id, a);
    return a;
  }

  get(id: ActorId): Actor | undefined {
    return this.byId.get(id);
  }

  all(): readonly Actor[] {
    return this.list;
  }

  /** Takes out every actor `drop` picks, keeping the rest in order. */
  removeWhere(drop: (a: Actor) => boolean): void {
    let kept = 0;
    for (const a of this.list) {
      if (drop(a)) this.byId.delete(a.id);
      else this.list[kept++] = a;
    }
    this.list.length = kept;
  }

  /** Puts a dead actor back on its feet where it was spawned, as what it was spawned as. */
  revive(a: Actor): void {
    if (a.kind !== a.homeKind) becomeKind(a, this.kinds(a.homeKind));
    a.mass = this.kinds(a.homeKind).mass ?? 0;
    a.hp = a.maxHp;
    a.deadFrame = -1;
    a.flashFrame = 999;
    a.state = 0;
    a.stateFrame = 0;
    a.wait = 0;
    a.y = 0;
    a.x = a.homeX;
    a.z = a.homeZ;
    a.leanX = a.leanZ = a.leanVX = a.leanVZ = 0;
    a.gone = false;
    a.angry = 0;
    a.slamCd = 0;
    a.gatherCd = 0;
    a.rallyTo = 0;
    a.calling = -1;
    a.taken = 0;
    a.fuse = -1;
    a.group = 0;
    a.reform = '';
    a.pulled = 0;
    a.stride = 0;
    a.target = 0;
    a.token = false;
    a.opening = false;
    a.afraid = false;
    a.slotX = a.rallyX = a.destX = a.x;
    a.slotZ = a.rallyZ = a.destZ = a.z;
    a.cds.fill(0);
    a.struck = false;
  }
}

/**
 * Turns an actor into another kind where it stands: a slime growing a size. Its health is left
 * for the caller to decide; its mass is never shrunk.
 */
export function becomeKind(a: Actor, k: ActorKind): void {
  const brainChanged = a.brain !== k.brain;
  a.kind = k.id;
  a.faction = k.faction;
  a.radius = k.radius;
  a.hitHeight = k.hitHeight;
  a.hitCeiling = k.hitCeiling;
  a.solid = k.solid;
  a.maxHp = k.maxHp;
  a.hp = Math.min(a.hp, a.maxHp);
  a.brain = k.brain;
  a.ladder = ladderOf(k.id);
  a.mass = Math.max(a.mass, k.mass ?? 0);
  if (brainChanged) {
    a.state = 0;
    a.stateFrame = 0;
    a.wait = 0;
  }
}

/** Size information for a kind that may not be in the file, for brains run by tests. */
export const kindOf = (a: Actor): ActorKind | undefined => findKind(a.kind);
