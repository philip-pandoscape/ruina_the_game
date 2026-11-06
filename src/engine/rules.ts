// The rules' common shapes and helpers: the world, you, what you press and what happens, angles.
//
// What outside the rules uses of them: the bridge's front door for them, naming exactly what is used
// (tests/unit/boundaries.test.ts). The rules are the engine's; what's read here is the shapes of what
// it hands back and the helpers that read them.

export { angleDiff } from './math';
export { heightAboveGround } from './world/ground';
export type { SimView } from './views';
export { NO_ACTIONS, ON_FOOT } from './shapes';
export type { Actions, GameEvent, Mover, Obstacle, PlayerState, SimRead, World } from './shapes';
