// The rules' common shapes and helpers: the world, you, what you press and what happens, angles.
//
// What outside the rules uses of them, through the bridge (.plans/refactor R6.4): nothing else
// imports src/sim/ (tests/unit/boundaries.test.ts). Phase 8 answers these from the engine.

export { angleDiff } from '../sim/math';
export { heightAboveGround } from '../sim/player/traverse';
export type { SimView } from './views';
export { NO_ACTIONS, ON_FOOT } from '../sim/types';
export type { Actions, GameEvent, Mover, Obstacle, PlayerState, SimRead, World } from '../sim/types';
