// Everything in the world that is not the player: monsters, NPCs, props. One flat record rather
// than a type per creature, because the rules walk this list every frame and the Rust side keeps
// the same shape. A few fields only some kinds use (a prop's lean, a brain's scratch) cost four
// numbers each and save a hierarchy nobody wants to mirror twice.

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
}

export interface ActorSpawn {
  kind: string;
  x: number;
  z: number;
  facing?: number;
  seed?: number;
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
}

export const isAlive = (a: Actor): boolean => a.deadFrame < 0;

/** The world's actors. Dead ones stay in place so they can respawn where they fell. */
export class Actors {
  private list: Actor[] = [];
  private byId = new Map<ActorId, Actor>();
  private nextId: ActorId = 1;

  constructor(private kinds: (id: string) => ActorKind) {}

  clear(): void {
    this.list = [];
    this.byId.clear();
    this.nextId = 1;
  }

  spawn(s: ActorSpawn): Actor {
    const k = this.kinds(s.kind);
    const id = this.nextId++;
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

  /** Puts a dead actor back on its feet where it was spawned. */
  revive(a: Actor): void {
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
  }
}
