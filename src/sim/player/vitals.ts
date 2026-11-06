// Stamina and MP: what dodging and casting spend, and how they come back. Health is in attacks.ts
// (being hit) and labor is the island's (src/sim/life). The server's twin is in
// crates/engine/src/player.rs (regen_vitals, spend_stamina, refill_vitals); tests/conformance/player.test.ts
// checks the two agree frame by frame.

import type { Sim } from '../sim';
import type { Actions, PlayerState } from '../types';
import { HOTBAR_SLOTS, MOVEMENT_SLOTS, MP, NO_ABILITY, NO_MOVEMENT, STAMINA, STEP, abilityMpFor, movementStaminaFor } from '../../tuning';

/** Once a step: stamina refills once a moment has passed since it was last spent; MP always does. */
export function regenVitals(p: PlayerState): void {
  if (p.staminaDelay > 0) p.staminaDelay--;
  else p.stamina = Math.min(STAMINA.max, p.stamina + STAMINA.regenPerSecond * STEP);
  p.mp = Math.min(MP.max, p.mp + MP.regenPerSecond * STEP);
}

/** A dodge starting: pays its stamina, and holds off the refill for a moment. Free moves don't. */
export function spendStamina(p: PlayerState, cost: number): void {
  if (cost <= 0) return;
  p.stamina = Math.max(0, p.stamina - cost);
  p.staminaDelay = STAMINA.regenDelayFrames;
}

/** A cast going off: pays its MP. */
export function spendMp(p: PlayerState, cost: number): void {
  if (cost > 0) p.mp = Math.max(0, p.mp - cost);
}

/** Full stamina and MP: someone new, or back on their feet. */
export function refillVitals(p: PlayerState): void {
  p.stamina = STAMINA.max;
  p.staminaDelay = 0;
  p.mp = MP.max;
}

/**
 * What a slot pressed this frame can't be afforded with, if anything: the movement skill's stamina
 * or the ability's MP. The rules simply don't start it; this is so the screen can say why.
 */
export function shortFor(sim: Sim, a: Actions): 'stamina' | 'mp' | null {
  const p = sim.player;
  const m = a.movementSlot >= 1 && a.movementSlot <= MOVEMENT_SLOTS ? (p.movement[a.movementSlot - 1] ?? NO_MOVEMENT) : NO_MOVEMENT;
  if (m !== NO_MOVEMENT && p.stamina < movementStaminaFor(m, sim.stats)) return 'stamina';
  const ab = a.abilitySlot >= 1 && a.abilitySlot <= HOTBAR_SLOTS ? (p.abilities[a.abilitySlot - 1] ?? NO_ABILITY) : NO_ABILITY;
  if (ab !== NO_ABILITY && p.mp < abilityMpFor(ab, sim.stats)) return 'mp';
  return null;
}
