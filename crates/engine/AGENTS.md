# crates/engine

The game's rules in Rust: what the server runs to decide everything, and (through
`crates/engine-wasm`) what the browser will run in place of its TypeScript copy, `src/sim/` (the
refactor's Phase 8). Until then the two copies are held to each other by the conformance tier.

| Module | What |
|---|---|
| `player.rs`, `skills.rs`, `tuning.rs` | A player's step: movement, combos, abilities, vitals; the skill tree and builds; the numbers from `shared/tuning.json`. |
| `open/` | The island: its ground and surfaces (`zone.rs`, grown from the zone's recipe by `generate.rs` the first time anything asks), colliders (`colliders.rs`), traversal (`traverse.rs`: climbing, gliding, swimming), dungeons and developer zones (`dungeon.rs`, from `shared/dungeons.json`). |
| `actor.rs`, `actors.rs`, `ai.rs`, `pack.rs`, `missiles.rs`, `content.rs`, `creatures.rs` | Creatures: their kinds (`shared/actors.json`, `shared/creatures.json`), brains (`shared/behaviours.json` and each creature's), packs, missiles, hits. |
| `bots.rs` | Bots: brains that fill a player's inputs (`docs/zones.md`). |
| `life/` | The island's life systems: state, trade, farming, livestock, housing, the shipyard, vehicles, contracts, quests, progress, weather; commands in (`life::Command`), events out. |
| `minigames/` | The table games' rules (Beacons first). |
| `world.rs` | A flat arena with obstacles (the old battlefield's layout), where the player conformance check and the balance harness step players. |
| `rng.rs`, `jsmath.rs` | The browser's random numbers (mulberry32) and maths (fdlibm through `libm`), to the bit. |
| `checks/` | The conformance checks' scenarios run through the rules (creatures, a player, a player on the island), which the check programs print and the golden tests hold to the answers the TypeScript agreed with. |

## Rules

- **The same results everywhere.** No platform maths whose last bits vary (use `JsMath`, `js_hypot`,
  `len`), no clocks (the time is an input), no hash maps (B-trees), no threads, no I/O. `clippy.toml`
  enforces the first three; `cargo clippy --workspace -- -D warnings` runs in `npm run check` and CI.
- **Both copies change together** until Phase 8 retires the TypeScript: a rule changed here is changed
  in `src/sim/` too, and the conformance tier compares them (below).
- **Content is data.** A kind, a creature, an item or a dungeon is read from `shared/*.json` (built
  from `content/`, `content/AGENTS.md`); the engine reads the bundle, never a list of ids in code.
- **Only serde, serde_json and libm.** The engine builds for the server and for WebAssembly alike.

## Adding a System

1. Its module here, reading its data from a bundle; its twin in `src/sim/` while the TypeScript runs
   the rules in the browser.
2. A check program in `crates/tools/src/bin/` that runs a scripted scenario through it and prints
   each step as JSON, and a spec in `tests/conformance/` running the same scenario through the
   TypeScript and comparing (the others show how: `simcheck`, `aicheck`, `worldcheck`, `lifecheck`).
3. Unit tests beside the code (`#[cfg(test)]`), as the rest has.

## Tests

- `cargo test --release --workspace`: the engine's own tests and the server's. Among them the golden
  tests (`checks/mod.rs`): every creature, player and island scenario the conformance tier proves,
  held to a hash of its answer (`crates/engine/tests/golden/`), so a rule can't change unnoticed once the
  TypeScript copy is gone. A change made on both sides on purpose writes new answers with
  `RUINA_GOLDEN=1 npm run test:conformance`.
- `npm run test:conformance`: builds the engine and its WebAssembly, then compares the two copies
  (player, creatures, the island, life systems, ground) and holds the WebAssembly to the native
  engine bit for bit (`tests/conformance/engine.test.ts`).
- The island grows from its recipe here and in the browser alike (`open/generate.rs`,
  `src/sim/zone/generate.ts`, until the browser runs this one): a change to how it grows is made on
  both sides, and `tests/conformance/terrain.test.ts` compares all of what they grow.
