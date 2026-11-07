# The Words Workstream: "Island" Out

The `words` workstream of the finishing push ([finish.md](../finish.md)): R10.14. Branch
`refactor/words`, worktree `C:\GitHub\games\ruina-wt-words`, slot 9 (Postgres `ruina-wt-words-db` on
5489). Started from `refactor/first` at cddb69b, with every other workstream merged.

The goal: "island", the old word for a character's own state (now a **life**; what's built and
planted is **land**) and for Emberholm or the world (now a **region** or the **world**), out of the
code, the wire, the docs and the saves' column.

## 2026-11-07: Done

### What landed

| Commit | What |
|---|---|
| 4a75436 | The moves (moves.tsv, `tools/refactor/moves.mjs`): `src/engine/island.ts` → `src/engine/life.ts`, `src/engine/islandView.ts` → `src/engine/lifeView.ts`, `src/render/open/life.ts` → `src/render/open/land.ts` |
| 9130fd8 | The names: every identifier, call and column; migration 0040; the recipe's `landmass`; the golden answers kept anew; the server's own words |
| 9c8a346 | The engine's and the tools' crates: comments, the checks' messages, the rules' tests |
| ef7dea0 | The browser (`src/`): comments and what players read |
| 3cb55f5 | The tests, the tools, `index.html`, `dev/ui.html`, the content's comments |
| 26497a9 | The docs, the AGENTS.md files, the bible, the design pages |
| f9f6777 | The render's "life view" in comments is the land view; two comments plainer |
| e5cbd74 | `refactor/first` merged in (87881b7: `.plans` only, no conflicts) |

### Renames of note

| Old | New | Why |
|---|---|---|
| `IslandView` (`engine.life`) | `LifeView` | the page's view of a life, beside `SimView` (and world-api's `LifeView`, the life as sent) |
| render's `LifeView`, `lifeView` (`src/render/open/life.ts`) | `LandView`, `landView` (`land.ts`) | made room for the engine's view; it draws land (houses, farms, ships, packs, vehicles) |
| `IslandRead` | `LifeRead` | what the life's read helpers take |
| `IslandUI` (`src/ui/life/context.ts`) | `LifeContext` | as `SkillsContext` |
| `islandTip` | `lifeTip` | |
| `Island`, `Saved`, `islandData` (`src/engine/life/save.ts`) | `LifeSave`, `SavedLife`, `lifeSave` | a save of a life, and one with its time |
| `savedIsland`, `loadIsland`, `takeIsland`, `replayIsland` | `savedLife`, `loadLife`, `takeLife`, `replayLife` | the Engine's calls, and the session's `loadLife`/`replayLife` call names |
| `session_take_island` | `session_take_life` | the WebAssembly's export |
| `islandCommand` (the game object) | `lifeCommand` | |
| `islandMaterial` (glb.ts, village kit) | `gameMaterial` | the game's look for a made model |
| `Island`, `growIsland`, `drawIsland` (`src/bible/map.ts`) | `RegionMap`, `growRegion`, `drawRegion` | the bible's map of a region |
| `Session::take_island`, `replay_island`, `load_island` | `take_life`, `replay_life`, `load_life` | |
| `sim::load_island`, `sim::island_of`, `island_of_ref` | `sim::load_life`, `sim::life_save`, `life_save_ref` | `life_of` and `save_of` were taken |
| `island_spawns` | `offline_spawns` | who stands about a region played offline (with the townsfolk); `region_spawns` already named the channel's |
| engine-wasm `island()` | `emberholm_world()` | |
| checks' `islands()` and their answers' `"islands"` | `lives()`, `"lives"` | |
| the rules' tests' `island(coins)`, `island()`, `struct Island` | `new_life(coins)`, `quiet_life()`, `OnePlayer` | |
| a region's recipe's `terrain.island` (`Island`) | `terrain.landmass` (`Landmass`) | the shape of its land rising from the sea; content built again |
| `characters.island` | `characters.life` | migration 0040 |
| the UI gallery's `map/island` (The Island) | `map/region` (The Region) | |
| the Developer Tools' "Island Time" | "Time" | |

Test titles with "island" were renamed with them (in `online.spec.ts`, `skills.spec.ts` (`world:`),
`online-combat.spec.ts`, `bible.spec.ts`, `world.spec.ts`, `uiGallery.spec.ts`, and the unit tier's).

### The wire

No message field was named for the island: the tick's `life`, `lifeEvents` and the rest already said
life, and no message, command or value said island. So **`WORLD_PROTOCOL` stays 13**. The content's
hash changed (the recipe's `landmass` and a content comment), which a page built from other content
already treats as another protocol (it reloads into the new build). The calls renamed between the
page and its own WebAssembly (`session_take_life`, `loadLife`, `replayLife`) are one build's, not the
wire.

Players read "life" where they read "island": the title screen raises and wakes the world, a new
character gets a life of their own, deleting one deletes everything they own, your life is saved
and safe on the server (the sign-in badge, a lost connection, another window), the Developer Tools'
Time skips ahead and starts your life over, and the server's toasts say your life couldn't be loaded
or can't be saved just now. The sign-in screen already said "start your life on Emberholm".

### The saves' column

`crates/server/migrations/0040_characters_life.sql`: `ALTER TABLE characters RENAME COLUMN island TO
life`. Renamed, not rewritten: every save reads as it did. Every query that reads or writes it
changed with it (the character list's quests and coins, the store's load and write, land's migration
of old saves, the tests' queries). The fixture of beta's saves (`saves-763d6af.json`) names its
rows' column `life` as the table does now. The JSON inside a save never had an `island` key, so no
reader keeps an old key.

Tried on slot 9's Postgres: the store's land tests (7) through every migration, 0040 included (the
column is `life`, `_sqlx_migrations` ends at 40, and beta's 11 fixture saves are read, moved into
land rows and written back as version 4 in `life`); and by hand, migrations 0001-0031 on an empty
database, a save written to `island`, then 0040: the save reads as it was under `life`.

### The golden answers

The crowd's and the border's checks hash `{ticks, lives}` (was `islands`): their answers were kept
anew on purpose (`RUINA_GOLDEN=1`, in 9130fd8); only the hashes changed, the scenarios byte for byte
the same. The player's, the creatures' and the world's answers didn't move.

### What stays, and why

- `.plans/` (the refactor's history; the moves tool keeps it too) and `design/status.json` (the
  orchestrator's; only the moves tool's path rewrites touched it).
- `crates/server/migrations/0001`-`0003`: applied migrations; sqlx checksums them, so a changed
  comment would stop every server with a database that ran them. And 0040, which must name the old
  column to rename it.
- The place itself, where it is an island: the bible's lore (`src/bible/about.ts`: "an online world
  on islands under a vast tree"; `src/bible/notes/regions.md`: "The starter isle, a green island at
  the foot of the world tree"), the design page's description of Emberholm (`design/index.html`: "A
  green island about a kilometre across"), the wayfarer quest's outro (`content/quests/wayfarer.json`
  and its bundle `shared/quests.json`: "no corner of the island you have not walked"), and the fixture
  Thornmarch's subtitle ("The cold side of the island", a landmass it shares with Saltmere).
- `src/bible/systems/world.ts`: the search keyword `'island'`, so a search for the old word still
  finds the world's page.
- `tools/icons/catalog.mjs`: the map icon's painting prompt ("a small island coast").
- `design/research/*.md`: research on ArcheAge, whose islands (Freedich Island) are islands.
- `docs/world.md`'s words: one sentence saying "Island" was the old word and where it went.

### Ran

- `npm run check` (typecheck, biome, knip, rustfmt and clippy, the TypeScript unit tier and
  `cargo test --workspace`), with `RUINA_TEST_DATABASE_URL` on slot 9's Postgres so the store's land
  tests ran against a real database through migration 0040: passes before and after the merge (291
  TypeScript tests; 456 Rust: engine 222, server 131, land 7 against Postgres, and the rest).
- `npm run test:conformance` (the release build, the WebAssembly against the native engine): passes
  (5 tests).
- The engine's golden tests after keeping the new answers: all 9 pass.
- No Playwright, as the lean rule says: the integration specs are the end pass's (below).

### For the end pass: the integration tests to run

Nothing here needs new tests; the integration specs that touch what was renamed:

- **Saves:** `online.spec.ts` (a new player's life kept between visits; starting over; several
  characters, each with a life of its own; a second window taking a character over, `:174`),
  `update.spec.ts` (a restart saves every life and takes it up again, inside a dungeon too), and
  migration 0040 on the copy of beta's database (renaming the column under the rows land's
  migration moved; the select screen's quests and coins read from `life`).
- **The welcome:** `online.spec.ts` and anything that reloads into a new build (the content's hash
  changed, `WORLD_PROTOCOL` did not).
- **Moving between spaces:** `dungeon-way-in.spec.ts`, `party.spec.ts`, `admin.spec.ts` (a life saved
  standing outside a copy's door; `loadLife`/`takeLife`/`replayLife` across a move).
- **The page's own life:** `bugreport.spec.ts` (a save loaded with `?test&load`), `uiGallery.spec.ts`
  (the gallery's `map/region`), `world.spec.ts`, `skills.spec.ts`, `bible.spec.ts`, `design.spec.ts`.

### What others must know

- The engine's front door for the life systems is `src/engine/life.ts` (beside the folder
  `src/engine/life/`); `tests/unit/boundaries.test.ts`'s front doors say `life`.
- The render's `LifeView` is `LandView` (`src/render/open/land.ts`), and the game object's
  `lifeView` is `landView`; `engine.life` is a `LifeView`.
- A region's recipe says `landmass` where it said `island` (content, the fixtures, `map.rs`'s test
  regions).
