// Creatures: actors, their brains and behaviours, hits and missiles.
//
// What outside the rules uses of them, through the bridge (.plans/refactor R6.4): nothing else
// imports src/sim/ (tests/unit/boundaries.test.ts). Phase 8 answers these from the engine.

export { FACTION, isAlive } from '../sim/actor';
export type { Actor } from '../sim/actor';
export { BEHAVIOURS, behaviour, stateName, stateProgress } from '../sim/ai/brain';
export type { Behaviour, BehaviourState, Guard } from '../sim/ai/brain';
export { coneHits } from '../sim/combat/hit';
export type { Target } from '../sim/combat/hit';
export { FOE_HEIGHT } from '../sim/combat/missiles';
