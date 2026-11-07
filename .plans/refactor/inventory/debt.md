# Inventory: dead code and tech debt (2026-11-05, beta d49c3b8)

Audited read-only. TypeScript: an import graph over static and dynamic imports, `import.meta.glob`,
the tests' path-string imports, the 9 HTML pages, configs, tests and tools; each export traced to its
users through re-exports, each "unused" grepped again across the repo, name collisions (`turn`,
`menuOpen`, `V`) checked by hand. Rust: every `pub` item grepped by word, split by library /
`main.rs` / bins / `#[cfg(test)]`. `cargo check --all-targets` gives 0 warnings, but every module is
`pub mod`, so rustc can't see dead code. Clippy is installed on this machine
(`~/.cargo/bin/cargo-clippy.exe`) but not in CI.

## 1. Unused or orphaned code

knip, run raw without `node_modules` in that worktree, couldn't load the vite or playwright configs or
see the HTML pages: 77 "unused files" (76 wrong: dev-page modules, `design/*.ts`, tests, tools), 175
unused exports, 60 unused types, 0 unused dependencies. R2.1 reruns it properly configured. What holds
up after checking by hand:

- **Imported by nothing:** `src/species/index.ts` (a 6-line barrel).
- **Never loaded by the game (dev pages and tests only):** `src/content/creatures/index.ts`,
  `src/ui/theme/text.ts` (tests), the `hero` species (`builtin/hero.ts` + `fromRig.ts`, 137 lines) and
  the `quadruped` species (86); no actor kind uses either species.
- **42 exports used nowhere, not even in their own file:**
  - `build.ts`: `resolve`:41, `planTo`:58, `cycleSlot`:177, `abilityName`:186, `learnedSkillIds`:251,
    `cycleMovement`:269
  - `skills.ts`: `nodeAt`:76, `abilityTags`:399, `abilityId`:407
  - `tuning.ts`: `SLIDE`:48, `actionFrames`:168, `COMBO_VARIANTS`:243
  - `species/`: `authoring.turn`, `fighter.FIGHTER_CLIP`, `pose.bakeImported`/`restClip`,
    `registry.registerSpecies`, `types.MAT_COUNT`/`jointCount`
  - `render/`: `assets.assetFailures`/`resetAssetFailures`, `detail/body.V`,
    `detail/mocap.playCycle`/`cycleLift`, `look.PALETTES`, `models/data.CELL`, `models/kit.bands`,
    `open/falls.curtainAt`, `village/batch.standInGeometry`
  - `sim/`: `combat/hit.isPlayer`, `life/livestock.isAnimal`, `life/weather.daylight`,
    `terrain.SurfaceKind`/`SURFACE_NAMES`, `zone/dungeon.inDungeon`
  - `content/`: `attacks.attackAt`, `items.hasItemDef`, `structures.propIds`
  - `ui/`: `icons.SKILL_ICONS`/`TREE_COLORS`, `theme/contextMenu.menuOpen`
  - `library/pose.cloneSnapshot`
- **Only for tests:** `actorKindIndex`, `structureIds`, `skillsFrom`, `isTitleCase`; 18 more exported
  only so tests can use them; 93 value and 149 type exports used only inside their own file.
- `render/models/index.ts` is loaded only through `import.meta.glob` as `Partial<ModelKit>`; its
  re-exports (`PACK_IDS`, `PACK_SIZE`, `ANIMAL_IDS`, `VILLAGER_IDS`, `cropStages`, `buildCrop`,
  `propGlowGeometry`, kit helpers) are never used through it.
- **Icons** `gong`, `lens`, `waterfall` are baked but unreferenced (painted for the dungeon's next
  rooms: keep).
- **Dead data:** `shared/tuning.json` `slide.frames` is read by neither side (`SLIDE` is a dead export;
  Rust deserialises it and never reads it, while `tuning.rs:83` claims the browser does).
- `CAST_HEAL`/`CAST_METEOR` appear once each. Behaviours `skittish-hopper` and `prowler` are used by
  nothing in the game, but `ai-conformance.spec:59` loops over every behaviour, so tests exercise them.
- **npm:** all 6 dependencies used. `tools/models/*.mjs` need packages that aren't declared
  (`@gltf-transform/{core,functions,extensions}`, `meshoptimizer`, `sharp`).
- **Rust:** `server/src/terrain.rs` (32 lines) entirely unused. Unused `pub` items: `actor.rs:7-10`
  FACTION_PLAYER/NEUTRAL/PROP; `actors.rs:191 new_band`; `game.rs:1083 live_positions`;
  `life/content.rs` `recipes_at`:139, `has_crop_def`:447, `has_rideable`:663, `has_glider`:688;
  `life/mod.rs` `slots_used`:362, `cell_size`:459; `life/weather.rs:95 hour_of_day`;
  `open/colliders.rs` `remove_box`:104, `remove_obstacle`:110; `open/zone.rs:17 surface::ROCK`.
  Test-only: `has_item_def`, `has_pack_def`, `skills_from`, `dependents`, `path_to`, `max_level`. Used
  only by the `aicheck` bin: `spawn_in_band`, `step_brain`. The `loadtest` bin is run only by hand and
  is the only user of `tokio-tungstenite`, a normal dependency compiled into every build; `rayon` is
  used only by the battlefield loop in `main.rs`.

## 2. Superseded or doubled systems

| System | What it is, who reaches it | Size | What depends on it |
|---|---|---|---|
| **The classic toon look** | `?look=classic`, and chosen automatically when WebGL runs in software (`look.ts:30-36`): real players on SwiftShader or llvmpipe get it | the CLASSIC palette; **75 `NEW_LOOK` branches in 16 files** (sky 20, foliage 19, open/stage 14, water 9, terrain 9); `OUTLINES` 7 sites; a 3-tone toon ramp | **CI draws in SwiftShader, so every non-@gpu test in CI runs the classic look and the box hero, while this machine runs the new look and the made hero: the same tests, different code.** Also look.spec, species.spec, the library's thumbnail cache key |
| Box hero vs made hero | the box hero shows in the classic look or when `hero.glb` fails; `?heroGait=box`/`?heroWeapons=box` mix the two | made hero 1,548 lines (madeHero 93, fit 636, madeWeapons 183, mocap 168, retarget 430, moves 38) + 1.95 MB GLBs; box-only walk `gait.ts` 230 | `HERO_RIG` (`content/creatures/hero.ts`, 231) is shared: the made hero is fitted to it; creatures.spec checks it |
| Keyed swings vs library clips | sword and club play Quaternius clips; staff, bow, whirlwind and jump attacks stay keyed; the Meshy sword set only via `?swordMoves=meshy`, retarget.html, retarget.spec | `swings.ts` 249 | the classic look plays every move keyed; `character.ts:595` cites the removed `takes.ts`. (Animation is another session's area: move, don't change) |
| species / creatures / content/creatures / crowd | `species` = instanced crowd bodies; `creatures/` = the goblin body; `content/creatures/` = close-up rigs (hero only); `content/creatures.ts` = the rules' JSON loader, with the same import stem as the folder beside it; `crowd/` = the `?raid` sim and CrowdView | species 2,010 (`registerSpecies`/`bakeImported`/`restClip` are an imported-species path never built); creatures 245; content/creatures 261; crowd 504 | |
| `?raid` sim vs battle server | `server/src/sim.rs`: "the same rules as the browser's crowdSim.ts, ported to Rust"; 10 constants copied by hand; no conformance test | 312 + 405 | raid.spec |
| 10k-bot battlefield vs Emberholm | production (`Dockerfile:40`), `npm run up` and CI run `--battle off`: players can't reach it; developers use `?server=` | server-only ~1,560 (main.rs `run` 229, interest 169, net 171, protocol 385, sim 405, world 75, loadtest 124) + ~350 in game.rs; client: crowd/ 504, ~450 of netCrowd.ts's 666, RemotePlayers ~100, makeBattlefield 46 | **tangled into the live game:** `world_game.rs:183-206` reuses `game::Players` with `Battle::new(0)` and a fake `World`; `NetCrowd.detached` + `applyWorld` reuse the battle client for Emberholm; conformance.spec + simcheck and skilltree.spec + balance run on the battlefield world; net/pvp/net-actors/combat/skills specs (ports 7791-7795; ~14 of those tests @gpu, skipped in CI) |
| The training yard | `?yard`, and `?test` without `&world` | makeWorld 70, `render/scene.ts` 316 (shared with the battlefield), dummy 66, training.ts 98 | 22 page loads in 9 specs; `build.ts:188` calls the yard and battlefield "developer tools" |
| Developer pages overlap | animations.html (animations + scenarios, 1,339 lines), species.html 335, models.html 597, creatures.html 93: largely covered by library.html (5,339) | | each has its own spec and `window.__x` API |

## 3. URL options

All in `src/main.ts` unless named. None is a normal player setting: look, quality and the bug reporter
are chosen automatically.

| Option | Where | What | Used by |
|---|---|---|---|
| `test` | main.ts:109; index.html:15 | starts paused, frame-stepped; the yard unless `&world` | 16 specs |
| `world` | :113 | with `test`: Emberholm offline | 11 specs |
| `yard` | :113 | the training yard, live | 8 specs, README |
| `goblins=N` | :135 | a goblin band in the yard | no test (AGENTS, design/goblins.md) |
| `raid=N`, `outline=0` | :111, :654 | offline crowd battle; without outlines | raid.spec |
| `server=ws://` | :110 | the battlefield client | 5 specs, README |
| `team`, `play=0` | :115, :663 | pick a side; watch | pvp, net, skills, combat, net-actors |
| `lag=ms` | :116, :487 | **two implementations**: a server-side delay on the battlefield, a client `setTimeout` online (`worldLink.ts:314`) | pvp, online specs |
| `softlock=0` | :856 | no automatic target pick | nothing; only a main.ts comment |
| `as=name`, `fresh` | online.ts:32; :484 (stripped in resume.ts:56) | dev sign-in; start the island over | online specs, README |
| `load` | :489 | offline: load the island saved in this browser | world.spec, fix-bugs skill |
| `bugs`, `bugspeech=0`, `buglang` | :2259-2268 | the bug reporter (on by default), transcription, language | 7 specs; bugspeech only in README |
| `look`, `quality`, `lookdebug=ao` | look.ts:35/42/45 | chosen automatically for players | look, species, retarget specs |
| `heroModel`, `heroHeight`, `heroGait=box` | madeHero.ts:24/58/67 | another body; the box gait | none |
| `{sword,club,staff,bow}Moves` | madeHero.ts:32; parsed again in library/subjects/hero.ts:413 | move sets | retarget-animation skill |
| `heroWeapons=box`, `sword=url,tip,grip` (etc.) | madeWeapons.ts:62/68 | box weapons; try a weapon model | none |
| library.html | store.ts:56 `test`; hash `#/subject/anim?opts&f&r` | | library specs |
| animations.html | `anim`:820, `speed`:220, `view`:222 | | only `anim` tested |
| retarget.html | `file`/`url`:26, `clip`:28, `mesh`:48, `view`:142, `half`:144, `draw`:163 | | file/clip/draw tested |
| models.html | `cat`:49, `only`:48, `anchors`:51, `label`:281, `yaw`:316 | | cat/only tested |
| buildings.html | viewer.ts:19-89: `plan`, `night`, `mirror`, `colliders`, `cam`, `at`, `cut` | | none tested |

## 4. Hygiene

- No TODO/FIXME/HACK/XXX, no commented-out code, no `console.log` in src (8 `console.warn`, 1
  `console.info`). Rust: 17 `println!`/`eprintln!` in library code; no `log`/`tracing`.
- `as any`: 0 in src, **586 in 30 test files**, nearly all `(window as any).__game` (untyped: 26 specs,
  397 calls, 73 members).
- `as unknown as`: 63 in src; 37 are JSON typing (skills 6, models/data 4, tuning 3,
  content/{vehicles,items,farming} 3 each), 11 window/browser globals. Workarounds: `main.ts:505` (the
  TS command type has no `teleport`, Rust's `Command::Teleport` does); `net/worldPeers.ts:258` builds a
  fake `Sim`; `library/subjects/hero.ts:32` and `animations.ts:650` reach into the hero's private
  fields; `post.ts:269/279` pass `null` as a render target; `fit.ts:594`.
- **Longest functions:** `generateZone` generate.ts:49-609 (561); `find_focus` life/interact.rs:128-460
  (333) and its twin `findFocus` sim/life/interact.ts:103-361 (259); `cutSheet` tools/icons/bake.mjs:91-348
  (258); `run` main.rs:150-378 (229); `LifeView.update` open/life.ts:664-854 (191); `createTargeting`
  targeting.ts:34-212 (179); `build` dungeonView.ts:107-283 (177); `bake` retarget.ts:158-326 (169);
  `interact` sim/life/interact.ts:539-707 (169); `Actors::step` actors.rs:242-409 (168); `NetCrowd.receive`
  netCrowd.ts:467-633 (167); `cog` models/vehicles.ts:1136-1295 (160); `interact` life/interact.rs:686-843
  (158); `locomotion` humanoid.ts:225-380 (156). The `window.__game` object is one 577-line literal
  (`main.ts:1615-2191`).
- **Files over 1,000 lines:** client main.ts 2,451, lifeUI.ts 2,050, library/app.ts 1,912, humanoid.ts
  1,532, models/structures.ts 1,491, models/vehicles.ts 1,372; server life/vehicles.rs 1,809,
  world_game.rs 1,523, game.rs 1,312, player.rs 1,243, life/interact.rs 1,136, life/content.rs 1,063;
  tests world.spec 1,408; data design/status.json 1,607, shared/zones/emberholm.json 1,397.

## 5. Scripts and tools

| Script / tool | State |
|---|---|
| `server`, `server:stress`, `loadtest` | battlefield only; `npm run server` takes port 7777, the same as `npm run up` (README:76 says to connect there) |
| `balance` | the root `balance.json` is used only by this script; the `balance` bin itself is needed (skilltree.spec runs it with its own scenario, on the battlefield world) |
| `icons` | repeatable (bake.mjs writes the WebP icons and `icons.gen.ts`); `paint.mjs` (Gemini) run by hand |
| `image` | the general Gemini image tool |
| `skilltree` | a one-off layout; its header warns that re-running it moves saved builds; its fallback reads `tuning.skills.nodes`, which no longer exists |
| `tools/models/{clips,village,weaponprep}.mjs` | one-off asset prep, dependencies not declared |
| `tools/bugs.mjs`; `tools/{bugReports,animReviews}.ts` | the fix-bugs skill; Vite dev-server plugins |
| bins simcheck/aicheck/worldcheck/lifecheck/terraincheck | reference runners for the conformance and terrain specs (CI uploads them) |
| `.github/scripts/railway-wait.mjs` | the deploy job |

## 6. Size in git

- Largest tracked files (KB): `server/data/emberholm.zone` 3,551 (generated); `village/kit.glb` 2,113;
  `village/props.glb` 1,616; `hero.glb` 683; 16 icon sheets in `tools/icons/sheets` 402-561 each; ground
  textures grass 321, forest 310, sand 264, plaza 248, road 230; `weapon_staff.glb` 311;
  `hero_swings.glb` 309; `design/goblins/` camp 246, night-raid 239, ambush 236.
- Totals: everything 31.1 MB in 641 files; `src/render/assets` 11.1 MB in 60 (models 4.7, village 3.7,
  ground 2.4); `src/ui/theme/icons` 1.0 MB in 143; `tools/icons/sheets` 7.8 MB in 16; `design/` 1.4 MB;
  `.plans/` 2.0 MB (concept art).
- History: 202 commits, 73 MB of distinct contents. `emberholm.zone` 4 versions = 13.8 MB; `main.ts` 71
  versions 5.4 MB; `lifeUI.ts` 32 versions 2.9 MB; the deleted `server/data/emberholm.terrain` 2.3 MB;
  `design/status.json` 33 versions 2.1 MB; `design/index.html` 11 versions 1.1 MB (it once embedded
  data). GLBs and icon sheets: 1 version each.
- Generated and committed: `emberholm.zone` (needed by the Docker build through `include_bytes!`);
  `icons.gen.ts` and the 143 icons; `village/*.glb`.
- `.dockerignore` keeps neither the icon sheets nor the concept art out of the Docker build context.

## 7. Inconsistencies to fix

- **yggdrasil vs ruina:** the crate, binary and `yggdrasil_server::` imports (Cargo.toml,
  Dockerfile:26-40, CI:64/117, package.json, all 7 bins). localStorage keys are mixed:
  `yggdrasil.build` (build.ts:190), `yggdrasil.skillxp` (main.ts:557), `yggdrasil.untracked.*`
  (lifeUI.ts:957) beside `ruina.*`; renaming them needs a migration or players lose their builds.
- **Copies:** `render/models/data.ts` re-reads structures/farming/trade JSON with its own types
  (duplicating `content/{structures,farming,trade}.ts`); `ui/icons.ts` holds the old emoji icons, its
  `ABILITY_ICONS` copies `tuning.json` `abilities[].icon`, and `WEAPON_NAMES` is copied again in
  `library/subjects/hero.ts:22`. Small helpers redefined: `esc` x10 (identical), `TAU` x20 (`sim/math.ts`
  exports one no other file imports), `clamp` x10, `lerp` x7, `angleDiff` x2 (`combat/hit.ts:20`).
- **Kept in step by hand, outside the shared JSON:** `WORLD_PROTOCOL` = 7 (worldLink.ts:189 /
  world_socket.rs:75); `FOE_HEIGHT` = 1.8; the battle protocol's byte sizes and mode order ("must match"
  in netCrowd.ts:26-37); the crowd constants; the command list (TypeScript lacks `teleport`).
- **Optional loading that guards nothing:** `open/models.ts:37` treats the models folder as possibly
  missing, with 15 `tryBuild(...) ?? standIn` fallbacks, but `render/open/*` and `humanoid.ts` import
  `models/kit`, `glb` and `gliders` directly, so it is always there.
- **Stale comments:** `character.ts:595` (takes.ts); `sim/types.ts:128` (says the server doesn't mirror
  traversal; `player.rs:137-145` does); `shared/zones/emberholm.json:2` (points at the removed
  `src/render/zone.ts`); `tuning.rs:83`; the README's ports.
- **Untested flags:** `softlock`, the `hero*` flags, `?goblins`, the Meshy sword set,
  `--virtual-clients`. Undocumented environment variables: `BALANCE_TRACE`, `LIFE_SUMMARY`.
- **Tests that break when files move** (the moves script must handle them): path strings for dynamic
  imports (`models.spec:192-193`, `village.spec:100-102`); `update.spec:209` rewrites `/src/main.ts`;
  `library.spec:117` checks for `src/render/detail/humanoid.ts` in prompt text, and the library's
  subject files embed 41 source paths; 111 imports of 43 src modules from 28 specs; 7 specs, the CI
  artifact list and the Dockerfile name `server/target/release/<bin>`; 18 Rust `include_str!` paths
  point at `shared/`; `vite.config.ts` hard-codes `src/app/bugs/logs.ts` in a regex.
- **Test tooling:** no shared helper (18 specs write their own boot helper; the "game ready" wait is
  copied 38 times).
- **No lint or format setup at all:** no ESLint, Prettier or rustfmt config; no clippy in CI.
- **Duplicate file names:** 5x `index.ts`, 4x `types.ts`, 3x `pose.ts`/`hero.ts`/`harness.ts`;
  `sim/world.ts` vs `sim/zone/world.ts`; `content.rs` vs `life/content.rs`.
