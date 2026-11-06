# src/engine

The bridge to the rules: the only way to them from the rest of the client
(`tests/unit/boundaries.test.ts` holds it). Today it stands in front of the TypeScript rules
(`src/sim/`); Phase 8 of the refactor (`.plans/refactor/`) answers the same calls from the Rust engine
compiled to WebAssembly (`crates/engine-wasm`), and nothing that uses the bridge should notice.

| File | What |
|---|---|
| `engine.ts` | `Engine`: the rules for the page (the island or the yard, you in it, the island's life), stepping them, and every change made to them from outside as a named call: putting you somewhere, your build and levels, a dungeon's floors and walls, an island loaded, the server's word on you (`correct`), your island as the server has it (`takeIsland`, `runAhead`, `replayIsland`), what's solid on the server (`addSolidHouse`, `addSolidScarecrow`, `setOthersVehicles`), and the test API's hooks. |
| `rules.ts` | The rules' common shapes and helpers: the world, you, what you press and what happens. |
| `zone.ts` | The island's ground and what stands on it: terrain, zones, buildings, colliders, roads, dungeons. |
| `island.ts` | The island's life systems: trade, farming, housing, the shipyard, vehicles, quests, weather, saves. |
| `creatures.ts` | Creatures: actors, their brains and behaviours, hits and missiles. |

## Rules

- **Only the bridge imports `src/sim/`.** Everything else imports from here. The bible may read the
  rules' source as text (`?raw`, for numbers they don't export).
- **Writes are named calls.** Nothing outside the rules assigns to their state: a change from outside
  is a method on `Engine`, named for what it does, which the WebAssembly engine will answer the same
  way. What the rest reads (`player`, `actors`, the island's state) is for reading.
- **The facades name only what is used.** `rules.ts`, `zone.ts`, `island.ts` and `creatures.ts` list
  exactly what outside code takes from the rules, so they are the list Phase 8 has to answer (R8.3).
  A new use adds its name there.
- `engine.sim` and `engine.life` are still public, for the modules that take the rules whole (the
  island's UI and drawing, the test API), until Phase 8 hands them snapshots instead (R8.7).

## Tests

`tests/unit/prediction.test.ts` (the server's word on you), the integration tier broadly (every spec
plays through the bridge), and `tests/conformance/` (the TypeScript rules against the Rust ones, until
Phase 8 deletes them).
