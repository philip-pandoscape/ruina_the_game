# The Engine

The game's rules are one copy, in Rust: `crates/engine`. The game server runs them natively to
decide everything; the browser runs the same code compiled to WebAssembly (`crates/engine-wasm`) to
predict your own moves online and to play everything offline. A rule changes in one place, and both
sides have it from the next build. What the engine's modules are is `crates/engine/AGENTS.md`; this
page is how the two sides reach it, and how to add to what crosses between the page and the engine.

## What Holds It to One Copy

- **The same answer everywhere.** No platform maths whose last bits vary (`JsMath`, `js_hypot`,
  `len`), no clocks (time is an input), no hash maps (B-trees), no threads, no I/O; serde,
  serde_json and libm only. `clippy.toml` refuses the rest.
- **Golden tests** (`crates/engine/tests/golden/`): every creature, player and open-world scenario in
  `checks/` held to a hash of its answer, so a rule can't change unnoticed. A change made on purpose
  keeps the new answers: `RUINA_GOLDEN=1 cargo test --release -p ruina-engine golden`.
- **Conformance** (`npm run test:conformance`): the WebAssembly held to the native engine bit for bit
  over the same probes (`tests/conformance/engine.test.ts`, the `engineprobe` program), the
  browser's ground sampling to the engine's (`terrain.test.ts`, `terraincheck`), and the balance
  harness (`balance.test.ts`).
- **Content is data.** The engine reads the bundles built from `content/` (`shared/*.json`), built
  into it as it compiles. A test can hand it others before it reads any (`content_use`; in
  TypeScript `useContent`): `tests/unit/newContent.test.ts` plays content added as files alone.

## The Server

The server links the engine as a crate and steps it in each game it hosts (a channel of the world,
or a copy of an instance, each a simulation of its own: `crates/server/src/sim/`). Each tick, 20 a second, a game steps every
player through the inputs their browser has sent since the last, 60 a second
(`ruina_engine::open::step_player`, the island's systems riding along), and the creatures and the
bots, then lands the fights and sends each player what changed.
Commands (buying, building, entering a dungeon) are the engine's `life::Command`, run where the
browser asked for them. Nothing a browser says about its own state is believed.

## The Browser

The page reaches the rules only through `src/engine/` (its `AGENTS.md`; `tests/unit/boundaries.test.ts`
holds it). There, the `Engine` (`engine.ts`) plays the page's game in one engine **session**
(`crates/engine/src/session.rs`): you, the creatures, the yard, the island's life, and a copy of a
dungeon while you're in one. The WebAssembly is loaded once a page (`load.ts`, `wasm.ts`) and asked
synchronously; text crosses through its memory (`alloc` for room to write into, `out_ptr` for what it
answered) as JSON, and big arrays are copied out of it.

### A Session

| Export | What |
|---|---|
| `session_new(options)` | A session: the open world or the yard, online or not, your build. Returns its handle. |
| `session_step(h, ...)` | One fixed step, 60 a second, with what was pressed: the stick and aim as numbers, the buttons as bits (`src/engine/shapes.ts` `Actions`). Returns how many events are waiting. |
| `session_view(h, events)` | What the page reads after a step or a call, as one JSON text (`SessionView` in `src/engine/session.ts`): the frame, you, your levels, the creatures and missiles, the yard's arrows and meteors, the island (its state, prompt, placing, resting, revision), what happened, and a key that changes with what's solid. |
| `session_solid_key`, `session_colliders`, `session_clear_*` | What's solid and which cells are kept clear, read again only when the key changes. |
| `session_world_clock(h, t)` | Online, the world's clock the rain and wind run on, for the next step. |
| `session_call(h, {call, ...})` | Every other write from outside the rules, by name (below). |
| `session_free(h)` | Done with it. |

The page reads the view back after every step and every call, under the names it always read
(`engine.sim`, `engine.life`: `src/engine/views.ts`, `islandView.ts`). The view is written straight
from the session's values: about 18 KB, 0.04 ms to write and 0.04 ms to parse (R8.14), so typed
arrays over the engine's memory weren't worth their cost.

### Named Calls

Nothing outside the rules assigns to their state: a change from outside is a call, named for what
it does, which the session answers (`crates/engine-wasm/src/session.rs` `call`), each an `Engine`
method in `engine.ts`.

| Calls | For |
|---|---|
| `place`, `reset`, `setBuild`, `setLevels`, `setVitals`, `calm` | Putting you somewhere; your build, levels and vitals; the yard's creatures held still. |
| `command`, `lifeEvents` | A command to the island's systems (`life::Command`), and what they said. |
| `enterDungeon`, `leaveDungeon`, `inside`, `floorAt`, `floorHere`, `solidity`, `spaceGround` | Into a copy of an instance, a space of its own played in place of the world, and out; its floors; what's solid; the ground of the space you're in. |
| `groundY`, `standingAt`, `world` | The ground and what you'd stand on at a point; the world's colliders and grid. |
| `regionsHeld`, `releaseRegion`, `regionSolids` | The regions the world holds and how many the rules grew on the spot; letting one go (`Engine.releaseRegion`); what's solid on one held (for one the rules grew themselves). |
| `loadIsland` | An island loaded from a save. |
| `takePlayer`, `replay`, `runAhead`, `replayIsland` | Online: the server's word on you taken, your unanswered inputs run again on top; a command run here at once, ahead of the server; your island as the server has it, with what's still ahead run again. |
| `addSolidHouse`, `addSolidScarecrow`, `movers`, `others` | Online: what the server makes solid, others' vehicles, the players around you and their plots. |
| `placeActor`, `setActor`, `spawnActor`, `spawnBand`, `hurtActor`, `takeHit`, `frame`, `placed` | The test API's moments set up directly (`window.__game`). |

### Besides the Session

| Export | What |
|---|---|
| `zone_grow(recipe)` | A region grown from its recipe, its borders blended where the world places it (`WorldMap::generate`): the heights, surfaces and cleared cells as arrays (`zone_heights_ptr` and its kin), the rest as JSON (`zone_json`). In TypeScript `growZone`. |
| `world_layout()` | Where the world's regions stand: the chunk, the blend, the sea, the edge of the world, each region's id, name, climate, chunks and grid. In TypeScript `worldLayout` (`src/engine/world/layout.ts`). |
| `region_grow(place)`, `zone_edges_*`, `region_recipe(place)` | A region grown whole as the page's worker grows it to hand over (`WorldMap::grow_whole`): read through the `zone_*` calls, with its edges as its recipe grew them and its recipe's text. In TypeScript `growWhole`. |
| `session_adopt_region(h, place, ...)` | The page's game takes a region its worker grew: its heights, surfaces, cleared cells, edges and what's solid on it (checked to be that region as the world places it). `Engine.adoptRegion`. |
| `building_colliders(plan, ...)` | Everything solid about a building plan placed somewhere (`buildingSolids`). |
| `minigame_layout`, `minigame_options`, `minigame_deal` | A mini-game's board, what a player may do now, a deal for development (`src/engine/minigames.ts`). |
| `content_use(bundles)` | Bundles read in place of the ones built in, before anything has asked. |
| `ground_height`, `ground_at_point`, `surface_at`, `probe` | The conformance tier's questions. |

## Adding to the Interface

- **A new write from outside the rules:** the session's method in `crates/engine/src/session.rs`,
  an arm for it in `crates/engine-wasm/src/session.rs` `call`, and an `Engine` method naming it in
  `src/engine/engine.ts` that rereads the view after. If outside code needs it, it goes through the
  front door that names what outside code uses (`rules.ts`, `zone.ts`, `island.ts`, `creatures.ts`).
- **Something new to read:** a field in the session's view (`view_json`) and in `SessionView`; what
  changes rarely belongs in a call the page makes when it needs it.
- **A new system:** its module in the engine, reading its data from a bundle, with unit tests beside
  it and, if it's stepped with the world, a scenario in `checks/` so the golden tests hold it
  (`crates/engine/AGENTS.md`, Adding a System). What the browser needs of it goes through the session.
- After a change to the engine, `npm run engine` builds the WebAssembly again (`npm run dev` does
  first), and `npm run test:conformance` holds the two to each other.
