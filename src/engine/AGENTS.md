# src/engine

The bridge to the rules: the only way to them from the rest of the client
(`tests/unit/boundaries.test.ts` holds it). The rules are the Rust engine's (`crates/engine`),
compiled to WebAssembly (`crates/engine-wasm`): the `Engine` plays the page's game in the engine's
session (`crates/engine/src/session.rs`: you, the creatures, the yard, the island, copies of
dungeons) and, after each step or call, reads back what the page shows. The island grows in the
engine too (`zone_grow`). What the page reads of the rules besides (the shapes of their state, the
ground's sampling, the island's read helpers, the roads) is still TypeScript in `src/sim/`, whose
steppers no longer run, until R8.13 of the refactor (`.plans/refactor/`) moves it here.

| File | What |
|---|---|
| `engine.ts` | `Engine`: the rules for the page (the island or the yard, you in it, the island's life), stepping them, and every change made to them from outside as a named call: putting you somewhere, your build and levels, a dungeon's floors and walls, an island loaded, the server's word on you (`correct`), your island as the server has it (`takeIsland`, `runAhead`, `replayIsland`), what's solid on the server (`addSolidHouse`, `addSolidScarecrow`, `setOthersVehicles`), and the test API's hooks. |
| `session.ts` | The engine's session for one Engine: a step, a named call, and the view read back after each (`session_view`: you, your levels, the creatures, the yard's arrows and meteors, the island, what it said, a key that changes with what's solid); the colliders and the cleared cells when that key does. |
| `views.ts` | What a step read back, under the names the page read before: `SimView` (`engine.sim`: you, the frame, your skills' numbers and levels, the creatures, the world, the hit pause, the log), `ActorsView`, `RangeView` (the yard's arrows and meteors). |
| `islandView.ts` | `IslandView` (`engine.life`): the island as the page reads it (its state, prompt, placing, resting, revision, the dungeon you're in, what it said, item counts); its commands go to the Engine. |
| `wasm.ts` | The engine's WebAssembly: loaded once per page, then asked synchronously (text through its memory, big arrays copied out). `growZone` grows a zone from its recipe; `buildingSolids` gives a building plan's colliders. |
| `load.ts` | The engine's file for a page (`startEngine()`): every page that reaches the island awaits it first (the game, the bible, the content library). The tests load it from the file (`tests/support/engineSetup.ts`). |
| `rules.ts` | The rules' common shapes and helpers: the world, you, what you press and what happens. |
| `zone.ts` | The island's ground and what stands on it: terrain, zones, buildings, colliders, roads, dungeons. |
| `island.ts` | The island's life systems: trade, farming, housing, the shipyard, vehicles, quests, weather, saves. |
| `creatures.ts` | Creatures: actors, their brains and behaviours, hits and missiles. |
| `minigames.ts` | The mini-games' rules for their boards (`crates/engine-wasm/src/minigames.rs`): how each game's board is laid out, and what a player may do now from what they see (so a board offers just what the server would take), from the same rules module the server plays it by. |

## Rules

- **Only the bridge imports `src/sim/`.** Everything else imports from here. The bible may read the
  rules' source as text (`?raw`, for numbers they don't export).
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
and `tests/conformance/` (the TypeScript rules against the Rust ones, until R8.13 deletes them).
