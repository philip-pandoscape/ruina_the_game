# Bigworld: the Client in a Big World (R10.23) and the Rest of R10.16

The workstream's running report (`.plans/refactor/finish.md`, slot 2: Postgres 5482, world server 7873,
`PW_PORT=5263`, `TEST_PORT_OFFSET=120`). Branch `refactor/bigworld` from `refactor/first` at 763d6af.
Entries are added as each step lands; the last one is the final report.

## 2026-11-06 20:45: regions grow by need and are dropped (the engine)

- **Landed:** 527020b. A `WorldMap` is now a view of its world (`crates/engine/src/open/map.rs`): it
  holds the regions grown for whoever plays through it, and every view of one world shares what's
  grown through the world's keeping (a region grown once however many views hold it, freed when none
  does). The API: `hold(places)`, `adopt(place, Grown)` (a region grown elsewhere: the browser's
  worker), `release`, `near(x, z, reach)` (the browser: what's near the player, nearest first),
  `around(chunks, band)` (a simulation: its chunks and the regions nearer than `band` to them),
  `chunks()`, `held()`, `unheld()` (regions grown on the spot because ground was asked of a view that
  didn't hold it), `grows(place)` (the tests count growings). `OpenWorld` plays through a view of its
  own: `OpenWorld::playing(map, zone, chunks, SIM_BAND)`, `play`, `hold`, `adopt`, `release`; what's
  solid follows the regions held and keeps what was built since (houses, scarecrows, a copy's floors).
- **Bit for bit:** what's across a border reads only a region's edges as its recipe grew them, two
  vertices deep (`Edges`, a few kilobytes, kept for the world once grown), so a region grown alone,
  beside its neighbours, or again after being dropped is the same to the bit (Rust tests in `map.rs`:
  heights, surfaces, cleared cells and colliders compared). The engine's golden answers are unchanged.
- **The server:** a channel says which chunks it plays (`played` in `crates/server/src/play/mod.rs`:
  every chunk of the world today, through `OpenWorld::playing`). One-line edits elsewhere to keep it
  compiling: `Sim` borrows the world (`teleport`).
- **Small edits in others' files** (to keep them compiling with a map that's owned, not `'static`):
  `life/interact.rs`, `quests.rs`, `trade.rs` read `sim.terrain()` where they read `sim.world.map`;
  four tests in `life/vehicles.rs` clone the view they read heights from; `training.rs`'s `Footing`
  has a lifetime; `session.rs` builds its footing from its ground and the copy it's in.
- **Ran:** `cargo test --release` for the engine (187 and the order test's 5), the server (81), the
  WebAssembly (4); clippy and rustfmt clean. `tests/stress/look.spec.ts` before any change: 4 passed,
  61 screenshots in `scratch/look-before/`.
- **Next:** the three-region fixture world (files the engine and the page both load), the
  WebAssembly's region calls and the worker, then the page drawing regions where the map places them.
- **For others:** combat's heights (`Players.ground`) are still Emberholm's grid, not the world map's:
  a fight in another region measures heights against Emberholm's edge. Borders (R10.19) will want it
  to be the world's; it's a `'static` reference today, so it needs the channel's view handed in.

## 2026-11-06 21:40: the fixture world, the WebAssembly's region calls, the client in a big world

- **Landed:** 3332545 (the fixture world), d0ed37b (farming's climate), 282863c and 0b96334 (the
  WebAssembly's region calls), db6ca72 (the page), f8f3d81 (the sea's plane).
- **The fixture world** (`tests/fixtures/world/`): `world.json` is Emberholm, Saltmere across a chunk
  of open sea to its west (x 1024 to 2048 m), and Thornmarch beside Saltmere across a land border at
  x = 2048 m (one island grown half by each, Thornmarch frost to Saltmere's temperate); `far.json` is
  Emberholm and Farholt, a flat isle 102 km out. Emberholm's own coast never reaches its chunks' edge
  (deep water all round inside them), so a land border can't touch it: the land border is between
  the two new regions, one of them across the sea from Emberholm. Rust: `ruina_engine::open::fixture`
  (`world()`, `far()`, `recipe()`, `bundles()`), built in for the engine's tests and, with the
  engine's `fixture-world` feature, for other crates' (add `features = ["fixture-world"]` to
  `ruina-engine` in a crate's dev-dependencies). Crossed in Rust holding only what's within 600 m of
  the player, nothing grown on the spot: walked across the land border (the same steps as in the world
  grown whole, to the bit), swum from Emberholm to Saltmere, glided across the land border, a cart
  driven across it with a friend riding along (combat's `Players`).
- **Farming's climate:** a farm grows in the climate of the region it stands in (`climate_at`, a read
  of the region's recipe, nothing grown): done here, a small edit in `life/farming.rs`.
- **The page:** regions grow in a Web Worker (`src/app/grower.ts`, `grower.worker.ts`), adopted by the
  page's game (`Engine.adoptRegion`, `session_adopt_region`) and drawn where the world places them
  (`src/render/open/regionView.ts`), built a little each frame; the page's ground across regions
  (`src/engine/world/worldGround.ts`); the floating origin (`src/render/origin.ts`); the maps show the
  world's regions. Seen in a browser: Saltmere drawn across the strait from the sea off Emberholm,
  Farholt drawn cleanly 102 km out with the origin moved (the camera 290 m from the scene's origin, the
  shadow camera 247 m).
- **Numbers so far** (this machine, Edge headless with the GPU): Saltmere (512 x 512 cells) grows in
  the worker in 190-200 ms the first time (WebAssembly), its depths and map painted in another 100 ms;
  the page takes it in 5 ms for the rules (adoption) and 4-10 ms a frame building its drawing (it took
  232 ms all at once before it was built a little each frame); Farholt (256 x 256) 30-40 ms.
- **Next:** unit tests (the worker's protocol, the origin's arithmetic, the page's world ground against
  the engine's), the integration specs (crossing the fixture world with frame times, precision far
  out), the look test after, docs.

## 2026-11-06 23:20: done (the final report)

**Landed** (on `refactor/bigworld`, `refactor/first` merged in at bf9197f, no conflicts):
527020b the engine grows and drops regions by need (`open/map.rs` views sharing what's grown, `Edges`,
`OpenWorld::playing`/`play`/`hold`/`adopt`/`release`/`alone`, the server's channels play their
chunks); 3332545 the fixture world and its Rust crossings; d0ed37b a farm's climate is its region's;
282863c, 0b96334 the WebAssembly's region calls; db6ca72, f8f3d81 the client in a big world (the
worker, the regions round you, drawing where placed, the page's ground, the floating origin, the
maps); f34d8de `tests/integration/bigworld.spec.ts`; a72d590 unit and conformance tests; d26b8ee
assets by region; d87f4b9 the guides; 5b4dd9a, 9f73c8a no worker for a one-region world, the HUD knows
your region.

**Numbers:** a region grows in the worker in 155-285 ms (Saltmere 512 x 512 cells; the first of a land
pair also grows its neighbour's edges once), plus about 100 ms for its sea depths and map; the page
takes it in in 5 ms (rules) and builds its drawing within 3 ms a frame. Every frame at the crossings
(foot, swimming, cart, glider) 17-18 ms, the screen's own; nothing grown on the page's thread. At
102 km the camera stays within 300 m of the scene's origin; the same picture from another origin
(0.8% of pixels), 32% different with the origin left at the world's. Edges kept for the world: 16-24
KB a region; a region held 1.6-3.5 MB of grids (page and WebAssembly each), 18-40 MB of ground on the
graphics card, freed when dropped. The look test before (`scratch/look-before/`) and after
(`scratch/look-after/`, `look-after2/`): every shot within 0.4% of pixels, the same as two runs after
each other.

**Ran:** `npm run check`'s steps on the final code: typecheck, biome, knip, rustfmt and clippy, the
TypeScript unit tier (272), `cargo test --workspace` (engine 194, order 5, WebAssembly 4, server 81).
The conformance tier (4 files, 5 tests, the fixture world's ground to the bit). `bigworld.spec.ts`
7/7. The whole integration tier against slot 2's rig: every side-by-side spec passed but
`yard.spec.ts:67` (its count, fixed on `refactor/first`, now merged); the one-at-a-time part was
stopped after 5 (one, rowing at 144 fps, lost its page to a reload my merge caused mid-run) when the
plan went lean: the end pass runs it. (A first run reused a Vite of mine without `RUINA_SERVER`, whose
proxy to 7777 was refused: nothing reached the user's server.)

**Left for the end:** the one-at-a-time integration specs; combat's heights (`Players.ground`) are
still Emberholm's grid (borders must hand the channel's view in); other regions' villages are drawn
but the camera's rooms and players' cottages are the first region's; travel by road is the first
region's roads; the first region of a land pair grows its neighbour's edges with a whole generate
(a terrain-only pass would halve it); instanced foliage keeps world positions in 32-bit floats
(millimetres at 100 km).

**For borders and the multi-server version:** the fixture is `ruina_engine::open::fixture::{world(),
far(), recipe(), bundles()}` with `LAND_BORDER` (x = 2048) and `SEA_BORDER` (x = 1024); another
crate's tests take the engine with `features = ["fixture-world"]`. A simulation plays through
`OpenWorld::playing(map, zone, chunks, SIM_BAND)` and `play(chunks, band)` (`WorldMap::around`);
`hold`, `adopt`, `release`, `view()`; assert `unheld() == 0` (ground asked outside what it holds is
grown on the spot and counted). Views are `Send + Sync`; growing locks the world, reads lock nothing;
`world_map()` keeps whatever it's asked about, so use views. Small edits in others' files:
`crates/server/src/play/mod.rs` (`played()`, `teleport`'s borrow), `session.rs` (the world held alone,
the region calls, the footing), `training.rs` (`Footing<'a>`), `life/` (`sim.terrain()`, a farm's
climate, four vehicle tests), `src/app/options.ts` (`?fixture=`).
