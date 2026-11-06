// Creatures: actors, their brains and behaviours, hits and missiles.
//
// What outside the rules uses of them: the bridge's front door for them, naming exactly what is used
// (tests/unit/boundaries.test.ts). The rules are the engine's; what's read here is the shapes of what
// it hands back and the helpers that read them.

export { FACTION, isAlive } from './actors/actor';
export type { Actor } from './actors/actor';
export { BEHAVIOURS, behaviour, stateName, stateProgress } from './actors/brains';
export type { Behaviour, BehaviourState, Guard } from './actors/brains';
export { coneHits } from './actors/hits';
export type { Target } from './actors/hits';
export { FOE_HEIGHT } from './actors/missiles';
