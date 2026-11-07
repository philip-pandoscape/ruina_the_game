// The island's life systems: trade, farming, housing, the shipyard, vehicles, quests, weather, progress, saves.
//
// What outside the rules uses of them: the bridge's front door for them, naming exactly what is used
// (tests/unit/boundaries.test.ts). The rules are the engine's; what's read here is the shapes of what
// it hands back and the helpers that read them.

export { cellCentre, scarecrowPost, stageOf } from './life/farming';
export { DAY, HOUSE_SETBACK, housePose, isComplete, stageReady, stillNeeds } from './life/housing';
export { nodeReady, shortTime } from './life/interact';
export type { FocusAction, Placement } from './life/interact';
export { islandData } from './life/save';
export type { Saved } from './life/save';
export { IslandView } from './islandView';
export type { Command, IslandRead, LifeEvent, OthersVehicle } from './life/life';
export { skillBudget } from './life/progress';
export { isReady, questsAt } from './life/quests';
export { shipFinished, shipNeeds, shipOn, shipStageReady } from './life/shipyard';
export { newLand } from './life/land';
export type { House, Land, Market, Pack, Scarecrow, ShipBuild, Vehicle } from './life/land';
export { initialWeather, newLifeState } from './life/state';
export type { LifeState, Weather } from './life/state';
export { BUYBACK_RANGE, carried, demandAt, freshness, quote } from './life/trade';
export { ridden, sailEfficiency, vehicleBodies } from './life/vehicles';
export { hourAt, hourOfDay, rainAt, raining, stormAt } from './life/weather';
