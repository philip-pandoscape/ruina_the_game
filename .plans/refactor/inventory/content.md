# Inventory: content and data (2026-11-05, beta d49c3b8)

Surveyed read-only before the refactor. Paths are from the repo root; `rs/` means `server/src/`;
other code paths are under `src/` unless they say otherwise.

**Bottom line:** content is about half data. Everything is in `shared/*.json`, and every
cross-reference between files resolves today, though nothing enforces it. But spawning, NPC
dialogue and looks, dungeon art, mini-game clients, new weapons and abilities, and every 3D model are
still code, and many lists must stay in the same order in TS and Rust, or in saved builds. Rust reads
every file with `include_str!` at compile time; TS with static `import ... with {type:'json'}`;
`tools/icons/bake.mjs` walks every shared file for `icon` emoji.

## 1. The files in shared/

| File | Lines | Top level | Entities | TS reader | Rust reader (serde struct) |
|---|---|---|---|---|---|
| actors.json | 262 | kinds[], ladders[] | 9 kinds (dummy, 4 slime sizes, 4 npc-*), 1 ladder | content/actors.ts | rs/content.rs `File{kinds,ladders}` |
| behaviours.json | 221 | behaviours[] | 4 (skittish-hopper and prowler used by nothing) | sim/ai/brain.ts | rs/ai.rs `File{behaviours}` |
| buildings.json | 697 | furniture{}, plans[] | 10 plans, 63 furniture | content/buildings.ts | none: reaches the server only through the bake |
| creatures/goblin.json | 189 | kinds[1], attacks[2], behaviours[1] (13 states) | 1 creature | content/creatures.ts | rs/creatures.rs `FILES`, parsed by rs/content.rs `CreatureFile` and rs/ai.rs `File` |
| dungeons/goblinsDread.json | 27 | id, origin, arrive, exit, fall, boxes[12], decks[1] | 1 | sim/zone/dungeon.ts; tests/party.spec.ts | rs/open/dungeon.rs `DungeonDef` |
| farming.json | 285 | settings, climates{4}, crops[6], gathering{4}, animals[3] | 6 crops, 3 animals, 4 node yields | content/farming.ts, render/models/data.ts | rs/life/content.rs `FarmingFile` (climates not read) |
| housing.json | 20 | blueprints[1] | cottage | content/housing.ts | `HousingFile` |
| items.json | 691 | bagSlots, items[], vendors[], recipes[] | 36 items, 7 vendors, 16 recipes | content/items.ts | `ItemsFile` |
| minigames.json | 39 | challenge, table, colors, games[1] | beacons | content/minigames.ts | rs/minigames/mod.rs `File`/`GameDef`; beacons.rs `Def` |
| quests.json | 825 | quests[23] | 15 quests, 8 milestones | content/quests.ts; tests/design.spec.ts | `QuestsFile` |
| shipyard.json | 52 | designs[1] | cog | content/shipyard.ts | `ShipyardFile` |
| skilltree.json | 519 | radii, nodes[226], links[285] | 15 skills, 182 small, 21 notable, 8 keystone | skills.ts (written by tools/skilltree/gen.mjs) | rs/tuning.rs `SkillTreeFile` |
| structures.json | 65 | structures[], props[] | 25 structures, 8 props | content/structures.ts, render/models/data.ts | `StructuresFile` (props not read) |
| trade.json | 268 | clock, labor, carry, demand, freshness, packs[10], places[5], routes[2], contracts | 10 packs | content/trade.ts, render/models/data.ts | `TradeFile` |
| traversal.json | 56 | ground, swim, glide, camera, storm | settings only | content/traversal.ts | `TraversalFile` (camera not read) |
| tuning.json | 455 | movement, jump, combat..., weapons[4], abilities[2], stats[12], movementSkills[4], skills | 4 weapons, 2 abilities, 4 movement skills | tuning.ts, skills.ts, gen.mjs | rs/tuning.rs `Tuning` |
| vehicles.json | 676 | vehicles[6], mounts[2], gliders[2] | 10 | content/vehicles.ts | `VehiclesFile` (RideableDef, GliderDef) |
| zones/emberholm.json | 1397 | terrain{18}, places[11], structures[41], props[23], npcs[12], workbenches[3], outposts[2], housePlots[8], nodes[16], dungeons[1], shipyards[1], slimes, dummy, sky... | 1 zone | sim/zone/world.ts, library/subjects/models.ts, render/models/harness.ts, tools/bugs.mjs, 4 tests | rs/open/zone.rs `Recipe` (only the rules' fields) plus `include_bytes!` of the bake |

## 2. Content that lives in code

- **Spawns:** the island always spawns `"slime"` and `"dummy"`, driven by the creature-specific
  recipe keys `slimes` and `dummy`: sim/zone/world.ts:26-32, rs/world_game.rs:187-195, rs/main.rs:163,
  sim/world.ts:78-83; types in sim/zone/types.ts:78,83 and rs/open/zone.rs:275,310. Dungeon files list
  no monsters and copies spawn none; goblins appear only through `?goblins=` (main.ts:136).
- **Creature looks:** slime name plates are a table in main.ts:629-638 (the goblin's name comes from
  its file); per-kind jelly looks in species/jelly.ts:21-26; the new look picks jelly for slimes in
  render/actors.ts:82. Bodies are code: species/builtin/*.ts, creatures/goblin/body.ts,
  species/registry.ts:14-20, content/creatures/index.ts:7. The brain's acts and condition names are
  an engine vocabulary (brain.ts:309-605 and rs/ai.rs). Missiles have only the "stone" look
  (render/missiles.ts).
- **Skills:** abilities are data built from 2 effect kinds, dispatched in rs/game.rs:602-605 and
  sim/training.ts:57. The wire hard-codes the two abilities (`CAUSE_METEOR=5`, `CAUSE_HEAL=6`,
  rs/protocol.rs:107-111, read in main.ts:704-711); ability icons go by index (ui/icons.ts:5);
  `CAST_HEAL`/`CAST_METEOR` (rs/tuning.rs:437) are unused. The 4 weapons are listed in code in
  ui/icons.ts:3-4, content/creatures/hero.ts:195, render/detail/humanoid.ts:397,
  madeWeapons.ts:14,65, moves.ts:38, library/subjects/hero.ts:22; `CAUSE_WEAPON + index` (1..4)
  would collide with meteor at a 5th weapon. Passive nodes are data, but tools/skilltree/gen.mjs:31-46
  and its `DISCIPLINES` table hard-code the tree's layout; `SKILL_ICONS` (ui/icons.ts:7-20) duplicates
  the node icons. The default build is "sword" (tuning.ts:325, rs/player.rs:188) and a "slide"
  movement skill is required (tuning.ts:166, rs/tuning.rs:418). Browser-only `SLIME` and `DUMMY`
  numbers sit in tuning.ts:333-367.
- **Quests:** no quest id appears in production code (only tests). Objective types are a closed set
  of 20, emitted by the systems through `life.notify`; `alreadyDone` in sim/life/quests.ts:62-92 has a
  Rust twin. The UI's goal markers (ui/life/lifeUI.ts:823-866) hard-code places: 'westwatch' (841),
  'docks' (850), 'hearthside' (863), 'lanternwick' (865), the label "Barleybrook Fields" (837),
  `workbenches[0]`, `shipyards[0]`. farming.ts:240 hard-codes the gather kind 'timber'.
- **Vehicles:** the rules switch on `class` only (sim/life/vehicles.ts:370-385 / rs vehicles.rs:496-528),
  never on id. Models go by id with a generic fallback (render/models/vehicles.ts:1355-1369;
  mounts.ts:345 donkey else horse; gliders.ts:222 swiftwing else wayfarer; render/open/life.ts:80,85
  colours by id). Toasts name "donkey", "horse" and "Sela" (sim/life/vehicles.ts:203,329,336 /
  rs vehicles.rs:295,437,442).
- **Villagers:** id, name, title, position and kind are data (zone `npcs`). Dialogue, portrait emoji
  and the workbench each stands at are code (`FACES`, `GREETINGS`, `BENCH_OF` in lifeUI.ts:67-86).
  Looks are one builder per NPC (render/models/villagers.ts, `VILLAGER_IDS` :21, `BUILD` :635,
  generic fallback).
- **Zone generation:** sim/zone/generate.ts special-cases ids: 'fields' (:252), farmPlot and scarecrow
  get no pad (:270), the dock sits at water level (:394), farmPlot gets soil and a smaller margin
  (:406,408). Waterfalls carry the goblins' `landing` and `totem` (types.ts:127-130,
  generate.ts:567-580); every waterfall gets goblin dressing (render/open/stage.ts:112, grotto.ts).
  Only Emberholm is wired: sim/zone/world.ts:10, rs/open/zone.rs:396-401, tests/terrain.spec.ts.
- **Dungeons:** listed twice in code (sim/zone/dungeon.ts:39-41, rs/open/dungeon.rs:94-98). The
  interior art is Goblin's Dread only: render/open/dungeonView.ts:83-105 reads box ids (westWall,
  curtain, tunnel*...), torches at :110-119, props by box id at :205-235.
- **Mini-games:** the server picks rules in `new_game` (rs/minigames/mod.rs:92-97); the client is
  wired to Beacons (content/minigames.ts:48-63, ui/minigames/minigames.ts:10,74,97,
  render/open/gameTables.ts:2,47-57).
- **Item ids matched by string:** placeables 'scarecrow', 'cog' and house plots (sim/life/interact.ts:511-515
  / rs interact.rs:654-660); a 6% `thunderLog` drop on any felled planted tree (farming.ts:231 /
  rs farming.rs:383; gathering nodes use the data's `rare` instead); 'lanternwick' the default craft
  place (trade.ts:133 / rs trade.rs:165); a labor cap of 1000 written out instead of `LABOR.max`
  (interact.ts:487,530 / rs interact.rs:592,678). Item categories are code (`ItemCat`
  content/items.ts:5, `CAT` labels lifeUI.ts:88, the `useItem` switch on both sides). The developer
  panel's grant lists name items (lifeUI.ts:1917-1922).
- **Models and icons:** builders by id: structures.ts:1420-1444 (stall :1474, lighthouse :1477),
  props.ts:45-70, packs.ts:277-300, crops.ts:274, animals.ts:10-11,352-363 (falls back to sheep);
  render/open/life.ts:358 sizes and colours animals by id; glb.ts:34-81 the `MADE_*` maps. The JSON
  `look` fields are prose no code reads. Icons map emoji to pictures in tools/icons/catalog.mjs
  (generating ui/theme/icons.gen.ts). House collider stages are code (housing.ts:132,136), and so is
  the cottage's five-stage builder (structures.ts:320).

## 3. What adding one of each takes today

| Type | Data | Code | Other |
|---|---|---|---|
| Creature | creatures/<x>.json | content/creatures.ts and rs/creatures.rs (append, same order); body creatures/<x>/body.ts and creatures/index.ts (unless it reuses a species); spawning in world.ts and rs/world_game.rs | |
| NPC | zone npcs; optionally vendors, quest giver, outposts, recipe bench | lifeUI.ts `FACES`/`GREETINGS`/`BENCH_OF`; villagers.ts (else a generic look) | rebake (generate.ts:418 clears NPC spots) |
| Place in Emberholm | zone places and terrain; trade places if a market | none | rebake |
| New zone | zones/<z>.json | world.ts, rs/open/zone.rs, terrain.spec.ts, rs/world_game.rs, lifeUI.ts | a new bake file |
| Passive skill node | skilltree.json, appended at the end | gen.mjs if it does the layout | |
| Ability / weapon / movement skill | tuning.json and skilltree.json | ability: icons, `CAUSE_*`, spells/vfx; weapon: ~8 files plus the protocol; movement: a pose in humanoid.ts:997 | icon |
| Item | items.json | none for an existing category and use; a new emoji needs catalog.mjs | paint, `npm run icons` |
| Vehicle, mount, glider | vehicles.json and a deed, whistle or glider item | optional: vehicles.ts, mounts.ts, gliders.ts | icon |
| Quest | quests.json | none if it uses existing objective types | |
| Walk-in building | buildings.json plan, structures.json (`building`), zone placement | none (a new kit piece needs tools/models/village.mjs) | rebake |
| Crop | farming.json crop, items seed/produce | crops.ts (has a fallback) | icon |
| Farm animal | farming.json animal, items | animals.ts, render/open/life.ts:358 | icon |
| Dungeon | dungeons/<d>.json and a zone door | dungeon.ts, rs/open/dungeon.rs, dungeonView.ts, spawning | |
| Mini-game | a minigames.json entry | rules in Rust, `new_game`, client panel and board | |
| Structure or prop | structures.json, zone placement | structures.ts or props.ts (fallbacks exist) | rebake |

## 4. Lists that must agree (order or numbers)

1. Creature file order: content/creatures.ts:14 / rs/creatures.rs:6. A kind is its index on the wire
   (actors.json kinds, then each creature's; rs/actor.rs `kind_index` u8). Missiles name their attack
   by index in the creatures' attack list.
2. Brain state index goes on the wire as a u8 (`ACTOR_ENTRY`).
3. tuning.json weapons, abilities and movementSkills order = the indices in saved builds (Postgres
   `build` jsonb: weapon, hotbar, movement; rs/characters.rs:42), the skill book order (skills.ts:331 /
   rs/skills.rs), the skill tree's `grants{weapon|ability|movement:N}` and `mods.weapon`.
4. skilltree.json node order is the bit order of saved builds (`SKILL_WORDS`=8, maxNodes 256, asserted
   in rs/tuning.rs:158,174).
5. Constants on both sides: `HOTBAR_SLOTS`, `MOVEMENT_SLOTS`, `MOVEMENT_SKILL_CAP`=16, 255 for "none",
   at most 8 combo variants (tuning.ts:242).
6. Wire codes: `EVENT_*` rs/protocol.rs:97 / net/netSpells.ts:13; `CAUSE_*` rs/protocol.rs:107 /
   main.ts:704 and netMonsters.ts:30.
7. `FOE_ACT` sim/ai/senses.ts:17 / rs/ai.rs:199.
8. Surface codes: sim/terrain.ts:8-19 / rs/open/zone.rs:13-21 / render/open/ground.ts:11. Obstacle
   kinds: tests/terrain.spec.ts:24 / zone.rs:376.
9. server/data/emberholm.zone is baked from the TS generator out of the zone, structures and buildings
   files (staleness check: terrain.spec.ts:57).
10. The dungeon lists (above) and the Beacons hex numbering (content/minigames.ts:58 / beacons.rs).
11. Persisted string ids for items, quests and crops in island saves; `LIFE_VERSION`=3 (state.ts:172 /
    state.rs:266). Toast texts duplicated in TS and Rust (the conformance tests compare them).
12. Duplicated data: zone `places` vs trade `places`; slime numbers in actors.json and tuning.ts `SLIME`.

## 5. Validation

- **No schema checking.** No JSON Schema, no `deny_unknown_fields`. rs/life/content.rs puts
  `#[serde(default)]` on every struct, so a missing or misspelled field silently becomes zero or empty;
  unknown ids return placeholders there (:6, :120). The structs in rs/content.rs, ai.rs, tuning.rs,
  dungeon.rs and zone.rs require their fields but ignore unknown keys.
- **TS doesn't type-check content either:** it casts JSON `as unknown as XDef[]` (items.ts:45,
  quests.ts:57...), so the compiler checks nothing (exceptions: minigames.ts:30-35, traversal.ts). TS
  lookups throw only when an unknown id is used.
- **Load-time asserts:** rs/tuning.rs:157-160,174,419; rs/skills.rs:58-69,360; skills.ts:68,342;
  tuning.ts:162-167; species `validateSpecies` (registry.ts:34).
- **Existing checks:** every dungeon has a door (rs/open/dungeon.rs:148); building plans fit their
  structures and use kit pieces (tests/village.spec.ts:16,97); every content emoji has an icon
  (bake.mjs:34-43); the bake is current (terrain.spec.ts:57); models build and their anchors match the
  data (models.spec.ts); creatures are registered (creatures.spec.ts:38); Rust smoke test
  (rs/life/content.rs:1030).
- **Unchecked:** references from quests, vendors, recipes, packs, crops, brains and species. An unknown
  behaviour state silently becomes state 0 (brain.ts:231, rs/ai.rs:335); an unknown condition never
  holds. A one-off script found every reference resolving today; the only empty values are the 8
  milestones' giver "".
