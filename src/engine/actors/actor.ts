// Everything in the world that is not the player, as the page reads it: monsters, NPCs, props. One
// flat record rather than a type per creature, the shape of the engine's (crates/engine/src/actor.rs),
// read back after each step. A few fields only some kinds use (a prop's lean, a brain's scratch)
// cost four numbers each and save a hierarchy.

export type ActorId = number;

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

  // ---- creatures that fight as a pack ----
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

/** Something thrown or shot by a creature, in flight (src/engine/actors/missiles.ts). */
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

export const isAlive = (a: Actor): boolean => a.deadFrame < 0;
// ids go out on the wire as 16 bits
