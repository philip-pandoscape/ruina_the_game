# Content

Everything the game is made of that isn't code: the island's people and places, items, quests,
crops, vehicles, creatures, buildings and the numbers that tune them. It lives in `content/`, a
folder per kind and a file per thing, and `npm run content` builds it into the bundles both sides
read (`shared/*.json`; the browser imports them and the server builds them into itself). A new thing
of a kind the game already knows is files alone: this page says which, for each kind. A new kind of
behaviour (a new way to use an item, a new objective, a new move) is a new mechanic, and that is
code. How the folders and bundles are built, and what contentc checks: `content/AGENTS.md`.

## Adding a Thing

The steps are the same for every kind; the recipes below say what each kind's files hold.

1. **Copy its template** from `content/_templates/` into its kind's folder, named after its id:
   `content/_templates/npc.json` to `content/npcs/<id>.json`. The templates' ids say what they
   stand for (`newPerson`, `newItem`): change them, and the values.
2. **List it** in the folder's `_order.json`, where it belongs (the order things are listed and
   offered in; the end if it doesn't matter).
3. **Build**: `npm run content`. It says what's wrong and where: a field the kind doesn't have, one
   every thing of the kind has and this one lacks, a wrong type, a reference to something that isn't
   there. A field no thing of its kind had before: `npm run content:schemas`, and look at the schema's
   change before committing.
4. **Explain it for the bible**, if its kind has no description of its own: a `## <id>` and a few
   sentences in `src/bible/notes/<kind>.md` (Markdown, not code; the bible's test says which).
5. **On the island?** Anything placed on it (a person, a structure, a gathering spot, a plot) moves
   the ground round it; the server and the browser both grow the island from the bundles, so
   nothing more is needed.
6. **Online**, build the world server again (`npm run up`). `npm run content` writes the content's
   hash too (`shared/hash.json`), the server says its own when a page connects, and a page built
   from other content reloads once and then stops, as for a new protocol: what goes on the wire as
   a place in a list (a creature's kind, a weapon, a skill, a mini-game) would mean something else
   to each.

Pictures and models are assets, not content: an item's `icon` is an emoji the painted icons stand
for (`tools/icons/catalog.mjs`; a new one is painted and `npm run icons`). Without a model of its
own a thing is drawn with a plain one, until looks are data (the refactor's R9.9).

## People

**A townsperson** is `content/npcs/<id>.json` (template `npc.json`) and its id in
`content/npcs/_order.json`:

| Field | What |
|---|---|
| `name`, `title` | Who they are and what they do |
| `place` | The place they belong to (`content/regions/emberholm/places.json`) |
| `x`, `z`, `facing` | Where they stand on the island, and which way they face |
| `kind` | Their actor kind (`content/actors/`: `npc-elder`, `npc-merchant`, `npc-crafter`, `npc-sailor`): solid, never anyone's target, and how the crowd draws them from afar |
| `look` | The body they are drawn with close up: one of the built townsfolk, by name, or any other name for a plain villager dressed from it |
| `portrait` | Their face as an emoji, until their portrait is taken |
| `greeting` | What they say when you talk to them |
| `bench` | The workbench they stand at, if any: talking to them offers it |

What they do besides talk is other things naming them:

- **Their wares**: `content/vendors/<id>.json` (template `vendor.json`, the file named after
  them), and the id in `content/vendors/_order.json`: what they sell at what price (and seals),
  what they buy, and at what part of an item's worth.
- **Work to order**: recipes with them as the `bench` (below).
- **Quests**: quests naming them as `giver` or `turnIn` (below).
- **A trading post**: an entry in `content/regions/emberholm/outposts.json` naming them as its
  `npc` (template `region/outposts.json`), with a market of the same id (`content/markets/`) and
  routes to it in `content/trade.json`.

Then the bible's note on them (`src/bible/notes/npcs.md`).

## Items

**An item** is `content/items/<id>.json` (template `item.json`) and its id in
`content/items/_order.json`: its `name`, `icon`, `desc`, how many `stack`, its `value` (what the
grocer would pay), and its category (`cat`), which says what using it does:

| `cat` | Using it | Its fields |
|---|---|---|
| `seed` | Picks it for F to plant | `plants` (a crop) or `raises` (an animal) |
| `produce`, `material` | Nothing: it's sold, packed or built with | |
| `consumable` | Uses one up | `use.labor`: labor it restores |
| `placeable` | Places it | `places` (what), `placeOn` (`ground`: anywhere open and level, a farm plot's scarecrow; `plot`: an empty house plot, for a house blueprint; `slipway`: a slipway, for a ship design), `hint` (what using it tells you) |
| `glider` | Equips it | `glider` |
| `deed` | Summons the vehicle | `vehicle` |
| `mount` | Calls the mount | `mount` |

What each category is called (in a tooltip, as a heading, in the bag's menu) is `content/items.json`
`categories`. A new category is a new way to use an item: code.

Where it comes from is other things naming it: a vendor's `sells`, a recipe's `makes`, a crop's
`seed` or `produce`, a tree's `chop` (and its `rare` find), an animal's `produce`, a gathering spot's
`item` or `rare` find, a quest's `rewards` or `startItems`.

**A recipe** is `content/recipes/<id>.json` (template `recipe.json`): its `bench` (a workbench, or
a person who makes it to order), what it takes (`inputs`, `coins`, `labor`) and what it `makes` (an
item and how many, or a `pack`).

## Quests

**A quest** is `content/quests/<id>.json` (template `quest.json`) and its id in
`content/quests/_order.json`:

| Field | What |
|---|---|
| `giver`, `turnIn` | Who offers it, and who takes it back if not them |
| `after` | The quests done before it is offered |
| `auto`, `milestone` | It starts by itself; a milestone also finishes by itself, with nobody to hand it to |
| `intro`, `outro` | What the giver says offering it and taking it back |
| `steps` | Each a `text` and its `objectives`, all done to move on |
| `rewards` | `coins`, `seals`, `labor`, `items`, `skillPoints`, `equipGlider` |
| `startItems` | Handed to you when you take it |

An objective is a `type` and what it counts: `talk` (`npc`), `reach` (`place`, within `r`, at
least `minY` up), `glide` (`seconds`), `gather` (`kind`: timber, stone, ore, herbs), `craftPack`
(`pack`), `deliver` (`outpost`), `contract`, `summon` (`vehicle`), `load`, `placeScarecrow`, `plant`,
`harvest`, `raise` (`crop`), `placeHouse`, `buildStage`, `layKeel`, `shipStage`, `launch`, `defeat`
(`kind`: a creature) and `skillLevel`, each `n` times. The quest marker goes where the objective
names (the person, the place, the trading post, the bench that makes the pack, your plot, house, ship
or vehicle); an objective that names nowhere can say where with a `marker`: a `place`, `outpost`,
`workbench` or `shipyard`, and a `label` if it is to be called something other than its name there.
A new type of objective is a new mechanic: code.

## Farming, Gathering and Trade

- **A crop or tree**: `content/crops/<id>.json` (template `crop.json`), with its seed item
  (`plants` it) and its produce item. A tree's `chop` is what felling it gives, what that counts as
  for a quest (`kind`), and its `rare` find: an `item`, its `chance`, the `toast` that tells you and
  its `effect` (`thunder`: a lightning strike).
- **A farm animal**: `content/animals/<id>.json` (template `animal.json`), with its young as an item
  (`cat: seed`, `raises` it), its feed and its produce.
- **A climate**: `content/climates/<id>.json` (template `climate.json`).
- **A kind of gathering spot**: `content/gathering/<structure>.json` (template `gathering.json`),
  named after the structure it is drawn as (`content/structures/`): what it gives, for what labor,
  how long it rests, what it counts as for a quest, and its `rare` find. The spots themselves are
  entries in `content/regions/emberholm/nodes.json` (template `region/nodes.json`).
- **A trade or material pack**: `content/packs/<id>.json` (template `pack.json`), with a recipe at
  the workbench of its `origin` that makes it.
- **A market**: `content/markets/<id>.json` (template `market.json`); a trading post there is an
  outpost (People, above), and the routes between markets are `content/trade.json`'s.

## Vehicles, Mounts, Gliders, Ships and Houses

- **A vehicle**: `content/vehicles/<id>.json` (template `vehicle.json`): its `class` (`wheeled` or
  `boat`; what it is to drive comes from the class and its numbers), size, speeds, seats, cargo
  slots and wheels or oars. And its deed: an item with `cat: deed` and `vehicle: <id>`, sold, made by
  a recipe, or given by a quest.
- **A mount**: `content/mounts/<id>.json` (template `mount.json`), and its whistle: an item with
  `cat: mount` and `mount: <id>`.
- **A glider**: `content/gliders/<id>.json` (template `glider.json`), and its item: `cat: glider`,
  `glider: <id>`.
- **A ship built on a slipway**: `content/ship-designs/<id>.json` (template `ship-design.json`): its
  stages and the packs each needs, the vehicle it launches as, its design item (`cat: placeable`,
  `placeOn: slipway`) and the deed you get once it's launched.
- **A house**: `content/blueprints/<id>.json` (template `blueprint.json`): its stages, tax and
  perks, and its blueprint item (`cat: placeable`, `places: <id>`, `placeOn: plot`).

## Buildings, Structures and Props

- **A structure** (a building's footprint and collider, a well, a dock): `content/structures/<id>.json`
  (template `structure.json`); placed on the island by an entry in
  `content/regions/emberholm/structures.json` (template `region/structures.json`). How the island sits
  it is its data too: the ground under it is levelled to a pad unless it has a `deck` or
  `pad: false` (a farm plot, a scarecrow); `seaLevel: true` stands it at sea level (a pier);
  `clearMargin` is how far round it trees and rocks are kept off; `surface` is what the ground
  under it becomes (`soil` under a farm plot).
- **A walk-in building**: a plan in `content/buildings/<id>.json` (template `building.json`), on
  the village kit's grid (`src/render/village/`), and a structure with `collider: building`. Its
  furniture, by piece: `content/furniture/<name>.json` (template `furniture.json`).
- **A prop** (a lamp, a barrel, a fence): `content/props/<id>.json` (template `prop.json`); placed by
  an entry in `content/regions/emberholm/props.json` (template `region/props.json`): at a spot, in a ring,
  along a road or on a line.


## Creatures

- **A creature of a kind the engine knows** (a slime's sizes, a training dummy): an actor kind in
  `content/actors/<id>.json` (template `actor.json`), wearing a species there is a body for (`hero`,
  `fighter`, `slime`, `quadruped`, `goblin`), with a brain from `content/behaviours/` (template
  `behaviour.json`); a creature that comes in sizes has a ladder (`content/ladders/`, template
  `ladder.json`). A kind travels on the wire as its place in `content/actors/_order.json`, which
  the server and the page read from the same bundle; on the end of the list keeps the engine's
  golden answers, which name kinds by place, as they are.
- **A creature with its own attacks and brain** (the goblins): `content/creatures/<id>.json` naming
  its parts in `content/creatures/<id>/` (templates `creature.json` and `creature/`): its kinds, its
  attacks (a strike is a cone in front of it; a throw, a lobbed missile) and its brain, a list of
  states built from the engine's acts (wait, walk, strike, throw, heal...) and conditions, with its
  pack's tactics if it fights in a band (`design/goblins.md`). Its id goes on the end of
  `content/creatures/_order.json`. Its kinds wear a species there is a body for, or bring a body of
  their own (`src/render/creatures/<name>/`: code).
- **Where they are**: a dungeon's or a zone's `spawns` (`docs/zones.md`).

A new act or condition for brains is a new engine part: code, never a creature's own.

## Places, Regions and Instances

- **A place** in a region: an entry in its `places.json`, Emberholm's `content/regions/emberholm/places.json` (template
  `region/places.json`): its name, kind and icon on the map, and where it is.
- **A workbench**: an entry in `content/regions/emberholm/workbenches.json` (template
  `region/workbenches.json`), at a place; its recipes name it as their `bench`.
- **A house plot**: an entry in `content/regions/emberholm/housePlots.json` (template
  `region/housePlots.json`).
- **Level ground** (a town square, a quay, the fields): a `flatten` in the recipe's `terrain`
  (`content/regions/emberholm.json`): a circle (`r`) or a rectangle (`w`, `d`) levelled to `h` (or to
  the ground's own height there, `"auto"`) and blended out over `fall`, its `surface` painted. It's
  kept clear of trees, rocks and scarecrows unless it has `keepClear: false` (the fields, farmed).
- **A dungeon or a developer zone**: `content/instances/<id>.json` (template `instance.json`), as
  `docs/zones.md` says; a dungeon's door, an entry named for it in the `doors.json` of the region
  it's entered from. A dungeon's dressing is still code (the refactor's R9.8).
- **A region**: its recipe, `content/regions/<id>.json`, a folder of what it places beside it
  (`content/regions/<id>/`, the lists above), and its chunks in `content/world.json`, whose comment
  says what its grid must be. Every id in it is one thing in the whole world (contentc).

## Mini-Games

A game two players play at a table (Beacons) is its rules and its boards as well as its file: code,
but each a module named after the game and found by that name, with no list of games to add it to.

- **Its file**: `content/minigames/<id>.json`: its name, icon and blurb (the blurb is the bible's
  explanation), how many play, a turn's time and how many turns run out in a row lose; and under
  `rules`, whatever its rules module reads (Beacons': the hand, the Harbour, the deck, the row that
  wins, the goods and the board). Its id goes in `content/minigames/_order.json`: a game goes on
  the wire as its place there, which the server and the page read from the same bundle.
- **Its rules**: `crates/engine/src/minigames/games/<id>.rs`, with a `RULES` (a `RulesModule`):
  `deal` starts a game of it from its file and a seed (a `Rules`: whose turn it is, a move checked
  and played, the server's move for a player out of time, the game as each seat and onlookers may
  see it, how it ended); `layout` gives the board for the browser to draw; and `options` says what a
  player may do now from what they see (the checks their moves meet), for their board to offer. The
  browser asks the last two through the engine's WebAssembly. The engine's build script finds the
  module by its name (`crates/engine/build.rs`), and the server plays it at the tables.
- **Its boards**: in the game window, `src/ui/minigames/boards/<id>.ts` exporting `board` (a
  `MakeBoardView`, `src/ui/minigames/tables.ts`): the board, the hint and what the player picks, sent
  to the server as moves in the game's own terms, offering only what its rules' `options` allow
  (`src/engine/minigames.ts`), never working the rules out itself; and on the table in the world,
  `src/render/open/gameBoards/<id>.ts` exporting `board` (a `TableBoard`,
  `src/render/open/gameTables.ts`): the board and its pieces, for everyone round it.
- **The bible**: its rules on the Mini-Games page (`src/bible/systems/minigames.ts`, a section a
  game; one it has no section for shows its blurb).

`tests/unit/minigames.test.ts` fails on a game missing one of its modules, or a module without its
game; the rules are tested in Rust beside them.

## Not Yet Data

A new one of these needs code today, each named for the refactor's task that makes it data:

- **Weapons, abilities and movement skills** (R9.5): their moves, models, icons and where they are
  put away are code, which knows the weapons by their places in the list.
- **Stats** in the skill tree are numbers the rules read by name; nodes are written by
  `tools/skilltree/gen.mjs`.

## Checks

- `npm run content` (and the unit tier's `tests/unit/content.test.ts`): every file fits its kind,
  every reference is found, and `shared/` is what `content/` builds, its hash with it.
- `tests/unit/templates.test.ts`: every kind added as data has a template, each fits its kind, and
  copied in together they build.
- `tests/unit/newContent.test.ts`: a townsperson with wares and a quest, an item, a vehicle and a
  creature added as files alone (`tests/fixtures/content/`) and played through the engine, given
  the bundles they build in place of its own (`useContent`, `src/engine/wasm.ts`).
- `tests/unit/contentIds.test.ts`: no content id in code, but for the reasons it lists
  (`node tools/content/ids.mjs` lists them).
- `tests/unit/bible.test.ts`: every thing has its entry in the bible, and an explanation.
