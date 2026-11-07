# src/engine

The bridge to the rules: the only way to them from the rest of the client
(`tests/unit/boundaries.test.ts` holds it). The rules are the Rust engine's (`crates/engine`),
compiled to WebAssembly (`crates/engine-wasm`): the `Engine` plays the page's game in the engine's
session (`crates/engine/src/session.rs`: you, the creatures, the yard, the island, copies of
dungeons) and, after each step or call, reads back what the page shows. The island grows in the
engine too (`zone_grow`). What the page reads of the rules besides is TypeScript here, read-only:
the shapes of their state (`shapes.ts`), the world's ground, regions, instances and roads (`world/`),
the read helpers of a life (`life/`) and of creatures (`actors/`). None of it steps the rules. The
interface to the engine, export by export and call by call: `docs/engine.md`.

| File | What |
|---|---|
| `engine.ts` | `Engine`: the rules for the page (the island or the yard, you in it, the island's life), stepping them, and every change made to them from outside as a named call: putting you somewhere, your build and levels, the world's regions (`adoptRegion`, `releaseRegion`, `regionsHeld`: what the page's worker grew, held by the rules and the page's ground, `ground`), a dungeon's floors and walls, an island loaded, the server's word on you (`correct`), your island as the server has it (`takeIsland`, `runAhead`, `replayIsland`), what's solid on the server (`addSolidHouse`, `addSolidScarecrow`, `setOthersVehicles`), and the test API's hooks. What's solid is composed from the regions held (as the page has them) and what's been built since. |
| `session.ts` | The engine's session for one Engine: a step, a named call, and the view read back after each (`session_view`: you, your levels, the creatures, the yard's arrows and meteors, the island, what it said, a key that changes with what's solid); the colliders and the cleared cells when that key does. |
| `views.ts` | What a step read back, under the names the page read before: `SimView` (`engine.sim`: you, the frame, your skills' numbers and levels, the creatures, the world, the hit pause, the log), `ActorsView`, `RangeView` (the yard's arrows and meteors). |
| `islandView.ts` | `IslandView` (`engine.life`): the island as the page reads it (its state; your land, the world's market and the weather where you are; the land's clock; prompt, placing, resting, revision, the dungeon you're in, what it said, item counts); its commands go to the Engine. |
| `wasm.ts` | The engine's WebAssembly: loaded once per page, then asked synchronously (text through its memory, big arrays copied out). `growZone` grows a zone from its recipe; `growWhole` a region of the world whole, as the page's worker grows it (`src/app/grower.ts`); `buildingSolids` gives a building plan's colliders; `useContent` gives it content in place of what's built in (a fixture world). |
| `load.ts` | The engine's file for a page (`startEngine()`): every page that reaches the island awaits it first (the game, the bible, the content library). The tests load it from the file (`tests/support/engineSetup.ts`). |
| `rules.ts` | Front door: the rules' common shapes and helpers: the world, you, what you press and what happens. |
| `zone.ts` | Front door: the island's ground and what stands on it: terrain, zones, buildings, colliders, roads, dungeons. |
| `island.ts` | Front door: the island's life systems: trade, farming, housing, the shipyard, vehicles, quests, weather, saves. |
| `creatures.ts` | Front door: creatures: actors, their brains and behaviours, hits and missiles. |
| `shapes.ts`, `math.ts`, `training.ts` | The shapes the engine's session reads back (you, what you press, the world, what happened, the yard's arrows and meteors) and the angles they're read with. |
| `world/` | The ground and what stands on it, read: a region's height grid where it stands (`terrain.ts`, `Heightfield`; the `Ground` every reader takes), the world's ground across the regions held and the open sea between (`worldGround.ts`, the engine's world map's sums), where the regions stand (`layout.ts`), the colliders' index and sampling (`colliders.ts`, `ground.ts`, `frames.ts`), a region's recipe and what the engine grows from it, as the page holds it (`types.ts`, `region.ts`: `RegionData`, the region you start in grown here, the rest arriving from the worker), the dungeons' files (`dungeons.ts`), the roads and short walks for travel by road (`roads.ts`, `localPath.ts`: the page's own, with no Rust twin, on the region you start in). |
| `life/` | A life's state (`state.ts`) and its land (`land.ts`: houses, farms, ships, packs, vehicles, and the world's `Market`), the engine's shapes, and the read helpers of each system: what a pack sells for, a crop's stage, a house's needs, the weather at an hour, the quests an NPC has, the commands the page sends (`life.ts`). |
| `actors/` | Creatures as read back (`actor.ts`), the behaviours' states for drawing (`brains.ts`), and the cone of a swing for the online guess at a blow (`hits.ts`). |
| `minigames.ts` | The mini-games' rules for their boards (`crates/engine-wasm/src/minigames.rs`): how each game's board is laid out, and what a player may do now from what they see (so a board offers just what the server would take), from the same rules module the server plays it by. |

## Rules

- **Outside code comes in by the front doors.** `engine.ts`, `load.ts`, `minigames.ts`, `rules.ts`,
  `zone.ts`, `island.ts` and `creatures.ts`; the rest of the folder is reached only through them
  (`tests/unit/boundaries.test.ts`). The bible reads the engine's Rust as text (`?raw`, for numbers
  the rules don't export).
- **Nothing here steps the rules.** A rule is the engine's and changes there, in one place; what's
  here reads what the engine hands back. A helper that would decide something the engine decides is
  a call to the engine instead.
- **Writes are named calls.** Nothing outside the rules assigns to their state: a change from outside
  is a method on `Engine`, named for what it does, which the engine's session answers (a named
  `session_call`). What the rest reads (`player`, `actors`, the island's state) is for reading, and
  is replaced by what the next step reads back.
- **The facades name only what is used.** `rules.ts`, `zone.ts`, `island.ts` and `creatures.ts` list
  exactly what outside code takes from the rules. A new use adds its name there.
- `engine.sim` and `engine.life` are views (`SimView`, `IslandView`), for the modules that read the
  rules whole (the island's UI and drawing, the test API). The island's helpers they call take the
  read shapes (`IslandRead`, `SimRead`), so they work on the views.

## Tests

`tests/unit/prediction.test.ts` (the server's word on you), `tests/unit/online.test.ts` (an online
Engine against an engine standing in for the server: corrections, commands run ahead, others'
vehicles, plots and players), the integration tier broadly (every spec plays through the bridge),
and `tests/conformance/` (the WebAssembly against the native engine, and the browser's ground
sampling against the engine's).
