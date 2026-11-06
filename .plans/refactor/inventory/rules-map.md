# Inventory: the rules in TypeScript and Rust (2026-11-05, beta d49c3b8)

Surveyed read-only before the refactor. Rust line counts are code only (no `#[cfg(test)]`).

**"Bit-identical" isn't quite true today.** The conformance specs compare discrete fields exactly but
continuous ones within a tolerance: 1e-6 for conformance, world and life; 1e-9 for ai, terrain and
the battlefield layout. `tests/world-conformance.spec.ts:38-41` says the remaining differences are
the last bits of sin, cos, atan2, exp and hypot. One engine for both sides makes prediction exact.

## 1. Module map

| TS (lines) | Rust (lines) | What | Status |
|---|---|---|---|
| sim/sim.ts 350 | player.rs 1146 + open/mod.rs 166 (step_player) | the 60 Hz step | partial: the networked branch only; the training branch (hitstop, dummy, auto-aim, actor steps, pushing against actors) is TS-only |
| player/{locomotion 229, abilities 230, attacks 203, vitals 47} | player.rs | move, jump, dodge, cast, swing, vitals | 1:1 (conformance); checkHit/checkShot are training-only (the server's equivalent is in game.rs) |
| player/traverse 434 | open/traverse.rs 504 | slopes, swimming, gliding | 1:1 minus screen events |
| types 264, math 23 | player.rs, world.rs, open/mod.rs, open/zone.rs; `len` copied in 6 files | types, angles | split |
| actor 413 | actor.rs 274 | the actor record | 1:1, field for field |
| actors/step 464 | actors.rs 783 | an actor's frame, packs | 1:1 (ai-conformance) |
| ai/brain 747, ai/pack 112 | ai.rs 880, pack.rs 137 | the behaviour interpreter | 1:1 |
| ai/senses 130 | ai.rs Foe, actors.rs pick_foe, game.rs Players::foes, player.rs foe() | foe records | split |
| combat/hit 113 | actors.rs cone/circle/point_hit | hit queries | 1:1 logic, but TS uses Math.hypot where Rust uses sqrt `len` |
| combat/deal 75 | actors.rs + game.rs | damage | partial |
| combat/missiles 98 | missiles.rs 117 | thrown stones | 1:1 |
| training 98 | game.rs | offline arrows, meteors, heal | different code, same numbers |
| world 133 | world.rs 75 | layouts | makeBattlefield 1:1; makeWorld and bandAround TS-only |
| terrain 185 | open/zone.rs Heightfield (of 403); terrain.rs 32 (no callers) | ground queries | queries 1:1; noise and hash TS-only |
| zone/colliders 182, zone/dungeon 92 | open/colliders.rs 208, open/dungeon.rs 122 | solids | 1:1 |
| zone/world 50, zone/types 217 | zone.rs emberholm()/Recipe; world_game.rs slime spawns | zone to World | partial (Rust spawns no townsfolk) |
| zone/generate 710, zone/buildings 207 | none; their output is baked into server/data/emberholm.zone (3.6 MB); zone.rs ports rect/toLocal/toWorld | the island generator | TS-only |
| zone/roads 503, zone/localPath 295 | none | auto-walk routing | TS-only |
| life/life 388 | life/mod.rs 463 | the island container | 1:1 (TS also has client hooks) |
| life/{contracts 94, farming 242, housing 183, interact 714, livestock 67, progress 82, quests 241, shipyard 82, state 207, trade 313, vehicles 792, weather 103} | life/ same names: 93, 397, 245, 890, 111, 114, 331, 134, 303, 400, 1050, 110 | the open-world systems | 1:1 (life-conformance) |
| skills 407 | skills.rs 543 | tree, levels, resolve | 1:1 |
| tuning 409 | tuning.rs 534 | tuning.json | 1:1 for the JSON; DUMMY/SLIME/CAMERA/AIM/GAMEPAD/WORLD TS-only; LEAN hard-coded in actors.rs |
| build 275 | skills.rs valid_build | build checks | partial; editing and localStorage TS-only |
| rng 15 | sim.rs Rng, Life::rand, ai.rs draw, beacons.rs Rng | mulberry32 | 1:1, **4 Rust copies** |
| content/{actors 65, attacks 48, creatures 14} | content.rs 205, creatures.rs 6 | kinds, attacks | 1:1 loaders |
| content/{farming, housing, items, quests, shipyard, structures, trade, traversal, vehicles} (551) | life/content.rs 1024 | content and js_* helpers | 1:1 (Rust returns placeholders where TS throws) |
| content/minigames 71 | minigames/mod.rs | content | TS only displays |
| content/{buildings, pose, rig, creatures/*}, src/creatures/** | none | generator and rendering | no rules |
| crowd/crowdSim 312 | sim.rs 405 | the raid's bots | a port; Rust uses f32; untested; the client runs it offline only |
| net/netPlayer quantize | protocol.rs input_axis/aim_axis/face_axis | input quantizing | 1:1 |
| app/save.ts 122 | world_game.rs load_island/island_of | offline catch-up | 1:1 |
| none | game.rs 1312; minigames mod 441 + beacons 433; world_game.rs ride_along/seat_passengers/gather_movers/make_solid | PvP and lag compensation, table games, riding along | Rust-only |

**Rust files by kind**
- **Server-only:** accounts, characters, db, http, net, world_socket, main (rayon), interest, channels,
  parties (Instant), spaces (Instant, tokio mpsc), world_game (Instant, SystemTime, mpsc),
  world_game/tables (SystemTime seed at :68). protocol.rs is a pure wire codec.
- **Pure rules:** actor, actors, ai, pack, missiles, content, creatures, tuning, skills, jsmath, player,
  world, sim, open/\*, life/\*, minigames/\*. None imports tokio, sqlx, axum, std::time or rand (not a
  dependency); their only crates are serde, serde_json and libm, with OnceLock globals. open/zone.rs
  `include_bytes!`s the 3.6 MB bake.
- **Server inputs enter as values:** world_game.rs:817 SystemTime -> `Life.world_clock`; mini-games take
  `now: f64`; `Life.plot_owners` is filled by world_game.
- **Couplings to cut when the engine crate forms:** game.rs depends on protocol encoders, `sim::Battle`
  and client slots; world.rs uses sim.rs only for `Rng`; the lifecheck binary imports
  `world_game::{load_island, player_state_json}`; player.rs -> ai (`Foe`, `ACT_*`) and life::content
  (`carry`); open/colliders and open/traverse -> life::content (`js_hypot`, `js_round`, `carry`,
  glide/swim); **open and life depend on each other; skills and tuning depend on each other.**

## 2. Determinism devices

- **jsmath.rs:** js_sin/cos/atan2/exp via libm (fdlibm, as V8 for exp and atan2; sin/cos about 1% last-bit
  off), with a special case for exp(1).
- **life/content.rs:** js_hypot (V8's compensated sum), js_round = floor(x+0.5), js_sign, NaN-aware
  js_min/js_max, and `indexmap_like::Ordered` (keeps file key order like Object.entries).
- **TS side:** math.ts and brain.ts:277 use sqrt instead of hypot "so Rust agrees"; terrain hash2 uses
  Math.imul.
- **Seeded RNG:** mulberry32 everywhere: per-actor `seed`, `life.state.rng` saved with the island, a
  battle Rng, a beacons Rng. Math.imul/`>>>0` map to wrapping_mul/u32.
- **Number types:** f64 everywhere; f32 only for Heightfield height storage (Float32Array / `Vec<f32>`
  from the bake) and in sim.rs Battle arithmetic. Math.fround never used.
- **Fixed step and integers:** 60 Hz from tuning.json, integer frame counters, ids wrap at 65535 /
  0x7fffffff on both sides, inputs quantized the same way.
- **Parsing:** serde_json `float_roundtrip`.
- **Iteration order:** quests.rs `active_ids` reproduces JS array-walk semantics; collider buckets are
  visited in the same order on both sides.

**std transcendental calls in Rust production code** (they call the platform's maths library, so
Windows, Linux and WebAssembly may differ in the last bit; the engine must use `libm` instead):

| File | Lines |
|---|---|
| actors.rs | 554-555 sin/cos; 696 atan2 |
| ai.rs | 390-391 sin/cos; 429, 439, 533 atan2; 794 sin |
| game.rs | 712 atan2; 716, 772, 958, 1041 sin/cos |
| life/interact.rs | `.hypot` x11: 116, 174, 224, 237, 350, 368, 410, 444, 466, 538, 883 |
| life/farming.rs | 222, 227 hypot |
| life/vehicles.rs | 941 powf(0.6) |
| minigames/mod.rs | 152 sin/cos |
| world.rs | 44, 59 cos/sin |
| sim.rs | 325, 388 f32 atan2 |
| world_game.rs | 193 sin/cos (slime spawns); 627 hypot |
| world_game/tables.rs | 122, 340, 566 hypot; 313 atan2 |

Safe everywhere (exact or correctly rounded): sqrt, powi(2) (dungeon.rs:84, zone.rs:188), to_radians,
rem_euclid, `%`.

**HashMap/HashSet in rules code:** lookup-only, so order doesn't matter: collider buckets (Vec in
insertion order, HashSet for dedup), open/mod `added`, life `plot_owners`, interact.rs:620, skills
`combos`, beacons `index`, minigames `sent`/`declined`, game.rs `by_client`. **The one exception, a
real nondeterminism bug: world_game.rs:754 `rebuild_world` walks the estates HashMap (RandomState),
which sets the order colliders are inserted.** Island state maps are BTreeMap in Rust and object order
in TS; every walk over them updates each key independently.

**Other drift:** TS reads `worldClock()` (a performance.now estimate) on every step, replays included;
Rust sets it once per 50 ms tick.

## 3. Where the client calls the rules at runtime

| Module | Calls | Rate |
|---|---|---|
| main.ts | `prediction.step`/`sim.step`, drainEvents, `range.step` (offline), aimAssist/targeting reading `sim.player` + `sim.stats` | 0-5 steps per frame (60 Hz accumulator) |
| | `syncNet` -> reconcile | when a snapshot arrives (20 Hz) |
| | drawing reads the player, actors (offline), `life.state.vehicles`; groundAt for the shadow | every frame |
| net/netPlayer.ts | prediction | below |
| net/worldPeers.ts | writes `sim.world.movers`; vehicleBodies; add*Colliders; one Life per peer | every frame / on estate change |
| net/netMonsters.ts | coneHits, behaviour() | every step online |
| app/autoWalk.ts | steer, ridden(); RoadNetwork/route* | every step |
| app/save, dungeonVisit | load, growFor, recoverDemand, setDungeonSolid, respawnAt | on events |
| render/character.ts | ~27 PlayerState fields | every frame |
| render/actors.ts | ~10 fields per actor + stateName/stateProgress/fuseGlow | every frame, offline |
| render/open/life.ts | revision, clock, weather, placing; vehicles (~12 fields each), packs (~9), animals (~4); rebuilds when the revision changes | every frame |
| ui/life/lifeUI.ts | focus, labor, coins, weather, quests, ride; a ~20-field signature while a window is open; ~30 `life.command` call sites | every frame |
| ui/skills/*, travelUI, input.ts | skills/build; routeFrom; crouchKeySlides | on use / every frame |

**Prediction (net/netPlayer.ts).** `step()` quantizes the input, queues it (cap 600), sends it and runs
one `sim.step`. `reconcile(ack)` replaces `sim.player` with a shallow clone of the server's state
(pos/prevPos/vel copied, arrays shared), runs `beforeReplay`, rewinds `sim.frame` by the pending count,
re-runs every unacknowledged input and throws away the events: about RTT x 60 + 3 steps per snapshot
at 20 Hz (at 100 ms, ~9 steps every third frame). On the island `beforeReplay` puts back clock, labor,
weather, vehicles, resting and placing; while any of up to 8 predicted quick commands are pending it
restores the whole `life.state` from `base` (structuredClone) and re-runs them. Not restored:
`world.index`, movers, actors (`training:false`: no actors online), levels. Life steps in remote mode
during prediction (syncLevels, clock, labor, weather, stepVehicles, findFocus = all of interact). The
battlefield has no life.

**The size of a WebAssembly boundary.** ~17 action fields in per step. Out per frame: ~100 distinct
field names and a few hundred reads, growing with vehicles, packs and actors; `sim.stats`
(ResolvedSkills) read ~10 times a frame.
- **The rules call back into JS:** worldClock (every step, in weather); othersVehicles and othersAround
  (every step, from findFocus); plotOwner; remote (sends commands).
- **JS writes into the rules' state:** `sim.player` at each reconcile; `life.state`, placing and resting
  from server ticks; movers every frame; colliders, respawnAt, `life.dungeon`, `sim.levels`.
- render/\* and ui/\* never write rules state directly; ui changes it only through `life.command`.

## 4. How pure src/sim is

- Imports nothing from render, ui, net, app, three or the DOM; no window, performance.now,
  Math.random, Date, localStorage or console.
- From outside src/sim: tuning, skills, rng, 14 content modules, and shared JSON directly (brain.ts:1,
  dungeon.ts:1, zone/world.ts:1). content/actors.ts has a type-only cycle back to sim/actor.
- Impurities injected from main.ts: `Life.worldClock` (weather.ts:15), `othersVehicles`
  (interact.ts:204), `othersAround` (interact.ts:354), `plotOwner` (housing.ts:49), `World.movers`
  (written by worldPeers.ts:264, read by vehicles.ts:397).
- Module-level mutable state: the zone/world.ts:18 cache (one World and ColliderIndex per page) and
  housing.ts:104's `added` WeakMap.
- Outside src/sim: build.ts uses localStorage; save.ts defaults to `Date.now()`.

## 5. Dependencies between the rules, and the order they imply

**TS value edges:** terrain -> none; colliders -> terrain; dungeon -> colliders, generate.rect;
locomotion <-> attacks <-> abilities (cycle); player -> traverse, content/trade CARRY (training branch ->
actor, combat/deal, combat/hit); traverse -> colliders, content (traversal, glider, CARRY);
combat/deal -> actors/step (provoke), brain (flinch); senses -> abilities (incomingScale), traverse
(heightAboveGround); pack -> brain, senses; actors/step -> brain, pack, senses, missiles; the life
chain: weather -> livestock -> farming (terrain, generate) -> trade (colliders) -> housing/shipyard ->
vehicles (colliders, terrain, weather) -> quests/progress (skills) -> interact (all of life, plus
traverse's glider functions and dungeon); sim.ts -> everything (Life only through the LifeHooks
interface).

**Rust edges:** player -> ai types, life::content, world -> sim; open::traverse -> player; life <-> open;
game -> actors, life, open, player, protocol, Battle.

**Order these imply (callees before callers):** 1) rng, jsmath/math, tuning and skills, content loaders
(including life::content); 2) terrain -> colliders -> dungeon; 3) player core (needs the Foe types and
carry first); 4) traverse; 5) life: every online prediction step runs it in remote mode, so it sits on
the prediction path with player and traverse; 6) hit/missiles -> brain/pack/senses -> actors/step ->
deal (offline-only on the client); 7) the sim.ts training branch.

**Only one copy today (nothing to merge, only to port or keep):** TS-only: generate/buildings (the
bake), roads/localPath, training.ts, crowdSim (an untested Rust port exists in sim.rs). Rust-only:
mini-games, game.rs PvP, world_game's riding along.
