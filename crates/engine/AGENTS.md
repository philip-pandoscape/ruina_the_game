# crates/engine

The game's rules in Rust, one copy: what the server runs to decide everything, and (through
`crates/engine-wasm`) what the browser runs to predict your moves and to play offline. The browser's
game is `session.rs`: you, the creatures, the yard, the life systems and copies of dungeons, stepped
for one page, with every change from outside as a named call. How the server and the browser reach
the engine, and how to add to the browser's interface: `docs/engine.md`.

| Module | What |
|---|---|
| `player.rs`, `skills.rs`, `tuning.rs` | A player's step: movement, combos, abilities, vitals; the skill tree and builds, kept by id (`saved_build`, `build_from_saved`; those kept by index before read through `shared/buildsByIndex.json`); the numbers from `shared/tuning.json`. |
| `open/` | The world: its map of regions on chunks (`map.rs`, from `shared/world.json`), each region's ground and surfaces (`zone.rs`, grown from its recipe, `shared/regions/<id>.json`, by `generate.rs` the first time anything asks), colliders (`colliders.rs`), traversal (`traverse.rs`: climbing, gliding, swimming), and the instances, dungeons and developer zones, each a space of its own (`dungeon.rs`, from `shared/instances.json`). |
| `actor.rs`, `actors.rs`, `ai.rs`, `pack.rs`, `missiles.rs`, `content.rs`, `creatures.rs` | Creatures: their kinds (`shared/actors.json`, `shared/creatures.json`), brains (`shared/behaviours.json` and each creature's), packs, missiles, hits. `content.rs` also has the content's hash (`shared/hash.json`), which the server sends in its welcome. |
| `combat.rs` | Players together, as the server plays them: joining and leaving, their inputs, and everything that hurts or heals (swings, arrows, meteors, heals, creatures' slams and blows), with lag compensation against players and creatures alike; passengers riding along in someone else's vehicle. A tick in phases, each in any order (below). |
| `bots.rs` | Bots: brains that fill a player's inputs (`docs/world.md`). |
| `life/` | The island's life systems: state, trade, farming, livestock, housing, the shipyard, vehicles, contracts, quests, progress, weather; commands in (`life::Command`), events out. |
| `minigames/` | The table games: what every game shares (`mod.rs`: the content, challenges, tables, turn clocks and forfeits), and each game's rules, a module in `games/` named after it (Beacons first) that the crate's build script (`build.rs`) finds by name. A game is its place in `shared/minigames.json` on the wire; adding one: `docs/content.md`, Mini-Games. |
| `world.rs` | A flat arena with obstacles (the old battlefield's layout), where the golden player scenarios and the balance harness step players. |
| `rng.rs`, `jsmath.rs` | The browser's random numbers (mulberry32) and maths (fdlibm through `libm`), to the bit. |
| `checks/` | Scenarios run through the rules (creatures, a player, a player on Emberholm, a channel's crowd), whose answers the golden tests hold by a hash of each (`crates/engine/tests/golden/`), kept from when the TypeScript copy agreed with them; the creatures' and the crowd's also stepped in shuffled orders. |
| `session.rs`, `training.rs`, `yard.rs`, `event.rs` | The browser's game for one page (`session.rs`), the training yard's stand-in for the server (`training.rs`: a swing's blow with its hit pause and auto-aim, the yard's arrows, meteors and heals) and its layout (`yard.rs`), and what a step shows (`event.rs`). |

## Rules

- **The same results everywhere.** No platform maths whose last bits vary (use `JsMath`, `js_hypot`,
  `len`), no clocks (the time is an input), no hash maps (B-trees), no threads, no I/O. `clippy.toml`
  enforces the first three; `cargo clippy --workspace -- -D warnings` runs in `npm run check` and CI.
- **One copy.** A rule changes here alone: the server runs it natively and the browser through the
  WebAssembly. A change that alters a golden scenario's answer on purpose keeps the new answers
  (below).
- **Content is data.** A kind, a creature, an item or a dungeon is read from `shared/*.json` (built
  from `content/`, `content/AGENTS.md`); the engine reads the bundle, never a list of ids in code.
  What goes on the wire as a place in a list takes it from the bundle; what's kept names it by id.
- **Only serde, serde_json and libm.** The engine builds for the server and for WebAssembly alike.
- **The order things are stepped in changes nothing.** A tick goes in phases (`combat.rs`: vehicles
  made solid as they stand, the players' inputs, passengers seated, arrows and meteors, the
  creatures, where everything stood). Within a phase each player, creature, arrow or meteor reads
  the others only as they stood when the phase began, and changes nothing but itself: what it does
  to anyone else is handed back and applied once all of them have gone, in the order of whom it
  lands on (a creature by its id, a player by their slot), then of whom it came from. So a phase
  comes out the same stepped in any order, or all at once: `Players::step_by` hands each player's
  step to the caller as a `Job` (the server runs them on its threads; the engine has none), and
  `Actors::step` takes its creatures in any order. What a step builds changes only the island (its
  `revision`), and is made solid once the step is over (`Life::make_solid`), so the world is the
  same for everyone stepping in it. Anything new that reaches across players or creatures goes the
  same way; the crowd's and the creatures' golden scenarios are run shuffled to hold it.

## Adding a System

1. Its module here, reading its data from a bundle.
2. Unit tests beside the code (`#[cfg(test)]`), as the rest has. A system stepped with the world adds
   a scenario to `checks/`, so the golden tests hold its answers.
3. What the browser needs of it goes through the session (`session.rs`,
   `crates/engine-wasm/src/session.rs`) and the bridge (`src/engine/`).

## Tests

- `cargo test --release --workspace`: the engine's own tests and the server's. Among them the golden
  tests (`checks/mod.rs`): every creature, player and open-world scenario held to a hash of its answer
  (`crates/engine/tests/golden/`), so a rule can't change unnoticed. A change made on purpose keeps
  the new answers with `RUINA_GOLDEN=1 cargo test --release -p ruina-engine golden`.
- `npm run test:conformance`: builds the engine and its WebAssembly, then holds the WebAssembly to the
  native engine bit for bit (`tests/conformance/engine.test.ts`) and the browser's ground sampling to
  the engine's (`terrain.test.ts`), and runs the balance harness (`balance.test.ts`).
- The island grows from its recipe here alone (`open/generate.rs`, `open/buildings.rs`): the
  browser grows it through `crates/engine-wasm` (`zone_grow`), and `tests/conformance/terrain.test.ts`
  holds the WebAssembly's island to the native one, all of it.
