# content/

The game's content: everything the game is made of that isn't code. A folder per kind, a file per
thing. `tools/content/contentc.mjs` (`npm run content`, and the dev server whenever a file here
changes) builds it into the bundles the game reads, `shared/*.json`: the browser imports them and
the server builds them into itself. **Edit here, never `shared/`**: a bundle is overwritten from
here, and the unit tier fails while one is behind (`tests/unit/content.test.ts`).

## The Layout

- **A template per bundle**, at the bundle's path: `content/items.json` for `shared/items.json`,
  `content/zones/emberholm.json`, `content/creatures/goblin.json`, `content/dungeons/<id>.json`.
  It holds the bundle's settings as they are, and markers where its things go:
  - `{"$things": "items"}`: every thing in `content/items/`, in the order `content/items/_order.json`
    lists them. Each names itself by `id` (or by the field the marker says:
    `{"$things": "vendors", "id": "npc"}`), and its file is named after it.
  - `{"$things": "furniture", "as": "map"}`: the same as an object keyed by the files' names.
  - `{"$file": "zones/emberholm/npcs.json"}`: a part of a thing in a file of its own.
- **A folder per kind**: `items/`, `vendors/`, `recipes/`, `quests/`, `crops/`, `animals/`,
  `climates/`, `gathering/`, `packs/`, `markets/`, `weapons/`, `abilities/`, `stats/`,
  `movement-skills/`, `vehicles/`, `mounts/`, `gliders/`, `structures/`, `props/`, `buildings/`,
  `furniture/`, `blueprints/`, `ship-designs/`, `actors/`, `ladders/`, `behaviours/`, `minigames/`.
- **A thing in several files**: a creature (`creatures/goblin/`: its kind, its attacks, its brain)
  and the island (`zones/emberholm/`: its places, people, buildings and the rest, round its recipe).
- **`_schemas/`**: each kind's JSON Schema (`npm run content:schemas` writes them from the things
  there). contentc holds every thing to its kind's: no field the kind doesn't have, none every one
  of them has left out, the right types. Point an editor at them (VS Code: `json.schemas`, mapping
  `content/items/*.json` to `content/_schemas/items.schema.json`) to have them checked as you type.

contentc also checks every reference (an item a vendor sells, a quest's giver, a recipe's
workbench, a creature's brain: `REFS` in contentc.mjs says which keys name which kinds).

## Adding Content

- **Another thing of a kind there is** (an item, a quest, a crop): its file in the kind's folder,
  named after its id, and its id in the folder's `_order.json` where it belongs in the list. Then
  `npm run content`. A thing still needs code where the game draws it today (a model for a new
  vehicle, an icon: `npm run icons`); the refactor's Phase 9 takes those steps away.
- **A field a kind didn't have**: add it to the things, `npm run content:schemas`, and check the
  schema's change in the diff: it's what every later thing of the kind is held to.
- **A new kind**: a folder, a `{"$things": ...}` marker in the template of the bundle it belongs to,
  the code that reads it (the browser's `src/content/`, the engine's `crates/engine/src/`), and
  `npm run content:schemas`. A reference to it: a line in `REFS`.
- **A new bundle**: its template here at its path under `shared/`, its import in `src/content/` and
  its `include_str!` in the engine.

## Tests

`tests/unit/content.test.ts`: the content builds, `shared/` is what it builds, and an unknown field,
a missing one, a wrong type, a broken reference and a thing left out of its order each fail.
