// The island's life systems: trade, farming, housing, the shipyard, vehicles, quests, weather, progress, saves.
//
// What outside the rules uses of them, through the bridge (.plans/refactor R6.4): nothing else
// imports src/sim/ (tests/unit/boundaries.test.ts). Phase 8 answers these from the engine.

export { cellCentre, scarecrowPost, stageOf } from '../sim/life/farming';
export { DAY, HOUSE_SETBACK, housePose, isComplete, stageReady, stillNeeds } from '../sim/life/housing';
export { nodeReady, shortTime } from '../sim/life/interact';
export type { FocusAction, Placement } from '../sim/life/interact';
export { islandData } from '../sim/life/island';
export type { Saved } from '../sim/life/island';
export { IslandView } from './islandView';
export type { Command, IslandRead, LifeEvent, OthersVehicle } from '../sim/life/life';
export { skillBudget, trainedBy } from '../sim/life/progress';
export { isReady, questsAt } from '../sim/life/quests';
export { shipFinished, shipNeeds, shipOn, shipStageReady } from '../sim/life/shipyard';
export { newLifeState } from '../sim/life/state';
export type { House, LifeState, Pack, Scarecrow, ShipBuild, Vehicle, Weather } from '../sim/life/state';
export { BUYBACK_RANGE, carried, demandAt, freshness, quote } from '../sim/life/trade';
export { ridden, sailEfficiency, vehicleBodies } from '../sim/life/vehicles';
export { hourAt, hourOfDay, rainAt, raining, stormAt } from '../sim/life/weather';
