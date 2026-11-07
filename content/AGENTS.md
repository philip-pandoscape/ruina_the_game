# content/

The game's content: everything the game is made of that isn't code. A folder per kind, a file per
thing. `tools/content/contentc.mjs` (`npm run content`, and the dev server whenever a file here
changes) builds it into the bundles the game reads, `shared/*.json`: the browser imports them and
the server builds them into itself. **Edit here, never `shared/`**: a bundle is overwritten from
here, and the unit tier fails while one is behind (`tests/unit/content.test.ts`).

How to add each kind of thing, as files alone: `docs/content.md`.

## The Layout

- **A template per bundle**, at the bundle's path: `content/items.json` for `shared/items.json`,
  `content/regions/emberholm.json`, `content/creatures.json`, `content/instances.json`. It holds the
  bundle's settings as they are, and markers where its things go:
  - `{"$things": "items"}`: every thing in `content/items/`, in the order `content/items/_order.json`
    lists them. Each names itself by `id` (or by the field the marker says:
    `{"$things": "vendors", "id": "npc"}`), and its file is named after it.
  - `{"$things": "furniture", "as": "map"}`: the same as an object keyed by the files' names.
  - `{"$file": "regions/emberholm/places.json"}`: a part of a thing in a file of its own.
- **A folder per kind**: `npcs/`, `items/`, `vendors/`, `recipes/`, `quests/`, `crops/`, `animals/`,
  `climates/`, `gathering/`, `packs/`, `markets/`, `weapons/`, `abilities/`, `stats/`,
  `movement-skills/`, `vehicles/`, `mounts/`, `gliders/`, `structures/`, `props/`, `buildings/`,
  `furniture/`, `blueprints/`, `ship-designs/`, `actors/`, `ladders/`, `behaviours/`, `creatures/`,
  `instances/`, `minigames/`.
- **A thing in several files**: a creature (`creatures/goblin.json` naming its parts in
  `creatures/goblin/`: its kinds, its attacks, its brain) and a region (`regions/emberholm.json`, its
  recipe, and `regions/emberholm/`: its places, buildings, gathering spots, the doors into its
  dungeons and the rest; its people are `npcs/`). `world.json` places each region on its chunks
  (`docs/world.md`).
- **`_templates/`**: a thing of each kind to copy for a new one (`docs/content.md` says where each
  goes); no bundle takes them. `tests/unit/templates.test.ts` keeps them fitting their kinds.
- **`_schemas/`**: each kind's JSON Schema (`npm run content:schemas` writes them from the things
  there). contentc holds every thing to its kind's: no field the kind doesn't have, none every one
  of them has left out, the right types; and a thing's look the same, field by field (a look is
  never required: without one a thing is drawn plain). Point an editor at them (VS Code:
  `json.schemas`, mapping `content/items/*.json` to `content/_schemas/items.schema.json`) to have
  them checked as you type.

contentc also checks every reference (an item a vendor sells, a quest's giver and the places its
markers point at, a recipe's workbench, a person's place and bench, an item's category, a
creature's brain, what marks out an empty house plot: `REFS` in contentc.mjs says which keys name
which kinds), that every made model a look names has its files in `src/render/assets/models/`, and
that a cave's dressing names its own walls and pieces (`docs/world.md`, Dressing a Cave).

## Order, the Wire and Saves

- **What goes on the wire as a place in a list** (a creature's kind, a weapon, an ability, a
  movement skill, a skill node, a mini-game, an item in a trade) takes that place from the bundle,
  which the server and the browser read alike. contentc writes a hash of all of `shared/`
  (`shared/hash.json`); the server says its own when a page connects, and a page built from other
  content reloads into the new build, as for a new protocol (`crates/server/src/play/socket.rs`,
  `src/net/worldLink.ts`). So an order can change, as long as the server is built again with it
  (`npm run up`). What names a weapon, an ability or a movement skill in content does so by id: the
  skill tree's grants and modifiers (`shared/skilltree.json`) and what a level adds
  (`content/tuning.json`), whose places the engine and the page find as they read them. So their
  orders can change freely: nothing changes but the order they're listed in
  (`tests/unit/weaponOrder.test.ts`), though the engine's golden player and crowd scenarios, which
  hold builds by place as the wire does, need their answers kept anew (`crates/engine/AGENTS.md`).
- **What's kept names things by id**: a character's build (the server's `characters.build`) and the
  browser's own (`crates/engine/src/skills.rs` and `src/content/build.ts`: weapon, skill nodes,
  hotbar and movement slots), and the island, so a kept thing means the same in any order. Builds kept
  by index before that are read in the order they were kept in, frozen in `shared/buildsByIndex.json`
  (not built from here, never edited).

## Adding Content

- **Another thing of a kind there is** (a person, an item, a quest, a creature): its template
  copied into the kind's folder, named after its id, and its id in the folder's `_order.json` where
  it belongs in the list. Then `npm run content`. `docs/content.md` has a recipe for each kind.
- **A field a kind didn't have**: add it to the things, `npm run content:schemas`, and check the
  schema's change in the diff: it's what every later thing of the kind is held to.
- **A new kind**: a folder, a `{"$things": ...}` marker in the template of the bundle it belongs to,
  the code that reads it (the browser's `src/content/`, the engine's `crates/engine/src/`), its
  template in `_templates/`, and `npm run content:schemas`. A reference to it: a line in `REFS`.
- **A new bundle**: its template here at its path under `shared/`, its import in `src/content/` and
  its `include_str!` in the engine.
- **A new mini-game** is its file in `minigames/` (its own settings under `rules`) and code: its
  rules module in the engine and its board views, each named after it (`docs/content.md`).

The code names kinds of thing and what they do, never one thing by its id: the unit tier fails on
a content id in code (`tests/unit/contentIds.test.ts`; `node tools/content/ids.mjs` lists them)
but for the reasons it allows.

## Tests

- `tests/unit/content.test.ts`: the content builds, `shared/` is what it builds, and an unknown
  field, a missing one, a wrong type, a broken reference and a thing left out of its order each fail.
- `tests/unit/templates.test.ts`: the templates fit their kinds and build together.
- `tests/unit/newContent.test.ts`: a person, an item, a quest, a vehicle and a creature added as
  files alone (`tests/fixtures/content/`) and played.
- `tests/unit/contentIds.test.ts`: no content id in code, but for the reasons allowed.
