# Zones

Where the game is played: one open world of regions (`content/world.json` places each on its
chunks; today Emberholm, the starter isle, is the only one), and the instances beside it that a party
plays in a copy of its own: the dungeons, and the developer zones admins use to try things out. Each
of those is files; nothing in code lists them. The world itself, its regions, ground and channels:
[world.md](world.md).

| What | Where | Played in |
|---|---|---|
| A region | `content/regions/<id>.json` (its recipe) and `content/regions/<id>/` (its places, buildings, gathering spots, doors and the rest; its people are `content/npcs/`) | Channels: everyone in the world, a channel each so none gets crowded (`crates/server/src/play/spaces.rs`) |
| A dungeon | `content/instances/<id>.json`, its door in the region it's entered from (`content/regions/<region>/doors.json`) | A copy for each party, entered through its portal in the world |
| A developer zone | `content/instances/<id>.json` with `developer: true` | A copy for each party (or one for everyone: `shared`), entered from the Admin menu ([admin.md](admin.md)) |

## How a Copy Works

A dungeon or developer zone is an instance: a space of its own, its floors and walls round its own
origin, over nothing. A copy of it plays that space alone (`crates/engine/src/open/dungeon.rs`,
`OpenWorld::instance`: no region in its map, no sea, a long fall under its floors), the server's and
the browser's while you're in one (`src/engine/world/dungeons.ts`, `src/app/dungeonVisit.ts`: the
world set aside until you come back out), so nothing of the world is near you in it, and nothing of
it in the world.

- **Going in** moves you between games on the server mid-connection, island and all
  (`Spaces::move_to`); the browser hears where it is (`onSpace`) and draws the place: a cave
  (`src/render/open/dungeonView.ts`, the island put away) or an open arena (`arenaView.ts`, under the
  sky).
- **A copy is kept** 30 minutes after the last player leaves, as World of Warcraft keeps an instance;
  whoever is in it but no longer in its party is put out after a minute.
- **Saving**: an island in a copy is saved as standing outside its door, so a restart puts you there.
- **Falling** below `fall`, or being knocked down, gets you up where you came in.
- **Creatures** a copy brings (`spawns`) stand on its floor: their heights, and every height in a fight,
  are measured from the copy's floor where it has one (`DungeonDef::floor_at`, the highest piece no
  more than 0.6 m tall under a point; `floorAt` in the browser).

## An Instance's File

Everything round its own origin, heights (`top`) above it: an instance's space is its own, so where
one stands says nothing about where another does. `content/_schemas/instances.schema.json` holds the
fields.

| Field | What |
|---|---|
| `id`, `name` | Its id (the file's name) and what it's called |
| `about` | A developer zone's line in the Admin menu |
| `maxPlayers` | How many a copy holds |
| `arrive`, `exit`, `fall` | Where you come in and which way you face; the way out (F within `r` of it); how far below the floor you can fall |
| `boxes`, `decks` | Its pieces: `x`, `z`, half-sizes `hw`, `hd`, a turn `rot` and a `top`. A box is solid to its top; a deck is a floor you can walk under |
| `style` | `"cave"` (the default, drawn from its `dressing`) or `"arena"` (open sky) |
| `dressing` | What a cave looks like inside (Dressing a Cave, below) |
| `developer` | Admins only, in from the Admin menu |
| `shared` | One copy for everyone allowed in, instead of one a party (the battlefield) |
| `door` | A developer zone's way out into the world (`outside`, in the world); a dungeon's is in its region's `doors.json` |
| `spawns` | Creatures a copy brings, as a region's recipe has them ([world.md](world.md)): a `kind` (`shared/actors.json`, or a creature's kinds) at `x`, `z`; `count` of them spread round the spot out to `r` metres (in a ring without `r`); with `band: true`, a war-band of `count` in a ring round the spot, fighting as a pack |
| `bots` | Bots in it while anyone is: `count` of a `brain` on a `team`, round `x`, `z` |

## Adding One

**A developer zone** is its file alone:

1. Copy `content/instances/yard.json` to `content/instances/<id>.json`; give it an `id`, `name` and
   `about`; lay out its pieces, spawns and bots round its origin.
2. Its id in `content/instances/_order.json`, then `npm run content`.
3. `cargo test --release --workspace` checks it has a floor where you come in, its pieces within its
   edge, and a way out; the Admin menu lists it from then on.

**A dungeon** is its file, dressed, and a door in the world:

1. Copy `content/_templates/dungeon.json`, a cave, to `content/instances/<id>.json`; give it an `id`
   and `name`, lay out its pieces round its origin and dress it (below); its id in `_order.json`,
   as above.
2. Its door in the region it's entered from, `content/regions/<region>/doors.json`, named for the
   dungeon (`id`): the portal (`portal`, with a radius `r`) and where you come out (`outside`), in the
   world's coordinates. contentc holds a door to a dungeon of its name.

## Dressing a Cave

An instance drawn as a cave (`style` left out, or `"cave"`) is drawn from its `dressing`, round its
origin like the rest of its file (`src/render/open/dungeonView.ts`; the shape is `CaveDressing` in
`src/content/looks.ts`). It is drawing only: the rules never read it, and none of it is solid; its
boxes and decks are. Goblin's Dread's is the one to read.

| Field | What |
|---|---|
| `hall` | The boxes that are the hall's walls (`west`, `east`, `south`, `north`, by id): their faces toward the hall bound it, and its rock is drawn along them. How high its `ceiling` is |
| `tunnel` | A tunnel north out of the hall: the boxes that are its walls (`west`, `east`) and the one that ends it (`end`), and its `ceiling`. The hall's north wall is drawn either side of its mouth |
| `falls` | The back of a waterfall across the hall's south end in place of rock, with the way out through it, and how many `lights` the daylight through it makes. Without falls the way out stands at `exit`, in a rock arch |
| `stalactites`, `rubble` | How many stalactites hang from the hall's ceiling, and how many rocks lie at the foot of the walls |
| `torches` | Torches on the walls: where each stands (`at`: x, y, z) and its `turn` (radians) |
| `props` | What stands on its pieces: a `body` (`stage`, a landing stage filling a deck; `lookout` and `totem`, as tall as their box; `barricade`, across its box), `on` the box or deck by id, a `seed`, and a `turn` from the piece's own |
| `nets` | Catch nets: `at`, `turn` and `size` (width, height) |
| `loot` | Piles of stolen goods, `barrels`, `boxes` or `bales` (`pile`): `count` of them from a corner `at` (x, z) |
| `drawings` | Pictures daubed on the walls: `at`, `turn`, `size` and `seed` |
| `light` | The light its colours are baked from: a `fill` everywhere (red, green and blue, 0 to 1), and a lamp (`colour`, `power`, `reach`) for the way out (`exit`), for each torch (`torch`) and for the falls (`falls`) |

A new cave is data alone. A new kind of prop or pile is code (`PROPS` and `PILES` in
`dungeonView.ts`), as is a cave of another shape than a hall with a tunnel off it. contentc holds a
dressing to its instance: a cave has one and an arena hasn't, the walls it names are its own boxes,
its props stand on its own pieces, and its torches and falls have their light.

## Bots

A bot is a player without a socket whose inputs a brain fills each tick (`crates/engine/src/bots.rs`:
a skirmisher finds a foe, fights and falls back when hurt; a wanderer walks about). The server steps
them like players (`crates/server/src/play/bots.rs`), and browsers see them as other players marked
`bot`. Each brain sees everyone as the tick begins and decides for its bot alone, so the order they
think in changes nothing, and a server started with `--parallel on` has them think all at once, as
it steps the players (`play/stepping.rs`). A zone's bots come in with its first player and go with the last, so an empty battlefield costs
nothing; an admin can add more anywhere with the `bots` command (`n`, `brain`, `team`; `n: 0` sends
them away). A new kind of bot is a brain in `bots.rs` and its name in `Brain::named`.

## Testing

- `crates/engine/src/open/dungeon.rs`: every instance loads, has a floor where you come in and its
  pieces within its edge, and every dungeon a door in the world and a way out.
- `crates/server/src/play/spaces.rs`: copies made, kept and let go; admins in, players kept out; the
  yard's creatures on its floor; the goblin camp's war-band.
- `tests/integration/admin.spec.ts`: an admin goes into the battlefield (its bots, the arena, out at
  its door) and into the yard from character select (its dummy and slimes on the floor, blows landing);
  a player is kept out.
- `tests/unit/caves.test.ts`: a cave drawn from its dressing (Goblin's Dread's and the template's),
  and every prop and pile a dressing names one the cave can draw; `tests/unit/content.test.ts`: a
  dressing held to its instance.
- `tests/integration/dungeon-way-in.spec.ts`, `tests/integration/party.spec.ts`: Goblin's Dread's way in,
  parties into one copy.
