import type { Sim } from '../sim';
import type { Actor } from '../actor';
import type { PlayerState } from '../types';
import { comboFor, MOVEMENT_SKILLS, COMBAT, type AttackStep } from '../../tuning';
import { incomingScale } from '../player/abilities';
import { heightAboveGround } from '../player/traverse';
import { len } from '../math';
import type { Sighting } from './brain';

// What a creature can tell about the players around it. Each player is a foe: where they are and
// how fast they are going, which way they face, how hurt they are, what their weapon reaches and
// what they are doing with it. Brains and packs decide from this alone, so the server builds the
// same record for every player in a channel (crates/server/src/combat.rs Players::foes) and a creature
// can't tell the training yard from a live island.

/** What a foe is doing, as far as a creature can tell. */
export const FOE_ACT = { free: 0, swing: 1, recover: 2, cast: 3, guard: 4, dodge: 5, stunned: 6 } as const;

export interface Foe {
  /** 1 and up; a creature's target is a foe id, 0 for none. */
  id: number;
  x: number;
  /** Feet height, in world terms (an island's ground is not at 0). */
  y: number;
  z: number;
  /** m/s along the ground, for leading a throw. */
  vx: number;
  vz: number;
  facing: number;
  /** Health left, 0..1. */
  hp: number;
  /** How far its weapon's swings reach; 0 for a bow. */
  reach: number;
  /** It shoots. */
  ranged: boolean;
  act: number;
  /** In a dodge's untouchable frames: blows and missiles pass through. */
  invuln: boolean;
  /** Feet above the ground under them (a jump clears a low strike). */
  air: number;
}

/** What a weapon's swings reach, and whether it shoots instead. */
export function weaponReach(combo: readonly AttackStep[]): { reach: number; ranged: boolean } {
  let reach = 0;
  let ranged = false;
  for (const s of combo) {
    if (s.projectileSpeed) ranged = true;
    else reach = Math.max(reach, s.reach);
  }
  return { reach, ranged };
}

/** What a player is doing, as a creature reads it (crates/engine/src/player.rs Player::foe_act). */
export function foeAct(p: PlayerState, combo: readonly AttackStep[]): number {
  if (p.stun > 0) return FOE_ACT.stunned;
  if (p.mode === 'attack') {
    const s = combo[p.attackIndex];
    return s && p.attackFrame <= s.startup + s.active ? FOE_ACT.swing : FOE_ACT.recover;
  }
  if (p.mode === 'cast') return FOE_ACT.cast;
  if (p.mode === 'action') {
    const act = MOVEMENT_SKILLS[p.actionId]?.action;
    if (act?.hold) return FOE_ACT.guard;
    if (act?.invulnFrom !== undefined) return FOE_ACT.dodge;
  }
  return FOE_ACT.free;
}

/** The training yard's one player as a foe, or none while they are knocked down. */
export function foesOf(sim: Sim): Foe[] {
  const p = sim.player;
  if (p.downFrame >= 0) return [];
  const combo = comboFor(p.weapon, sim.stats);
  const { reach, ranged } = weaponReach(combo);
  return [
    {
      id: 1,
      x: p.pos.x,
      y: p.pos.y,
      z: p.pos.z,
      vx: p.vel.x,
      vz: p.vel.z,
      facing: p.facing,
      hp: p.hp / COMBAT.maxHp,
      reach,
      ranged,
      act: foeAct(p, combo),
      invuln: incomingScale(sim) <= 0,
      air: heightAboveGround(sim),
    },
  ];
}

/** A brain's view of one foe. */
export const sightingOf = (f: Foe): Sighting => ({
  x: f.x,
  z: f.z,
  present: true,
  id: f.id,
  facing: f.facing,
  hp: f.hp,
  reach: f.reach,
  ranged: f.ranged,
  act: f.act,
});

/**
 * Which foe an actor pays attention to: the nearest, or, for one that holds on to its target
 * (`sticky` metres), the one it was already after unless another is that much closer.
 */
export function pickFoe(a: Actor, foes: readonly Foe[], sticky: number): Foe | undefined {
  let best: Foe | undefined;
  let bestDist = Infinity;
  let kept: Foe | undefined;
  let keptDist = Infinity;
  for (const f of foes) {
    const d = len(f.x - a.x, f.z - a.z);
    if (d < bestDist) {
      best = f;
      bestDist = d;
    }
    if (f.id === a.target) {
      kept = f;
      keptDist = d;
    }
  }
  if (sticky > 0 && kept && keptDist <= bestDist + sticky) return kept;
  return best;
}
