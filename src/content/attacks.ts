import { CREATURES } from './creatures';

// What a creature can do to a player, from the creatures' files (shared/creatures/). A brain state
// names one (act strike or throw); src/sim/actors/step.ts lands it, and server/src/content.rs reads
// the same entries.

export interface AttackDef {
  id: string;
  /** strike: a cone in front of it, on the frame its wind-up ends. throw: a lobbed missile then. */
  kind: 'strike' | 'throw';
  /** Frames from the start of the state to the blow or the release. */
  windup: number;
  /** Frames it keeps turning to face you during the wind-up; after that you can step aside. */
  track: number;
  damage: number;
  knock: number;
  /** [min, max] frames before it can do this again, drawn when it does. */
  cooldown: [number, number];
  // ---- strike ----
  /** Frames of the lunge after the blow. */
  active?: number;
  reach?: number;
  arc?: number;
  /** A foe whose feet are higher than this above the ground (jumping) is missed. */
  lift?: number;
  /** Metres it lunges over the active frames. */
  lunge?: number;
  // ---- throw ----
  /** m/s along the ground. */
  speed?: number;
  /** m/s² pulling the missile down. */
  gravity?: number;
  /** 0..1: how much of your movement it leads you by. */
  lead?: number;
  /** The furthest it throws, in metres. */
  range?: number;
  /** The missile's own radius. */
  radius?: number;
  /** How the browser draws the missile. */
  look?: string;
}

export const ATTACKS: readonly AttackDef[] = CREATURES.flatMap((c) => (c.attacks ?? []) as AttackDef[]);
const BY_ID = new Map(ATTACKS.map((a) => [a.id, a]));

export const attackDef = (id: string): AttackDef | undefined => BY_ID.get(id);
export const attackIndex = (id: string): number => ATTACKS.findIndex((a) => a.id === id);
