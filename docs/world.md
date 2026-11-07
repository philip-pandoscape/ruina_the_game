# The World

Ruina's main world is one seamless open world of regions, set on a grid of chunks with the sea
between them. The instances stand beside it: dungeons and developer zones, each a space of its own
that a party plays in a copy of its own. Emberholm, the starter isle, is the first region and today
the only one. Each region and instance is files; nothing in code lists them. This page covers how the
world is laid out, how the rules read its ground, how it and its instances are played, and how to
add a region or an instance. The plans for the rest are in `.plans/world/` and the refactor's Phase
10 (`.plans/refactor/tracker.md`, R10.17 to R10.24):

- regions split between simulations, their borders crossed seamlessly;
- land that every channel shares;
- channels that open and merge with the crowd.

| What | Where | Played in |
|---|---|---|
| A region | `content/regions/<id>.json` (its recipe) and `content/regions/<id>/` (its places, buildings, gathering spots, doors and the rest; its people are `content/npcs/`) | Channels: everyone in the world, a channel each so none gets crowded (`crates/server/src/play/spaces.rs`) |
| A dungeon | `content/instances/<id>.json`, its door in the region it's entered from (`content/regions/<region>/doors.json`) | A copy for each party, entered through its portal in the world |
| A developer zone | `content/instances/<id>.json` with `developer: true` | A copy for each party (or one for everyone: `shared`), entered from the Admin menu ([admin.md](admin.md)) |

## The Words

| Word | What |
|---|---|
| World | The one open world. |
| Region | A part of the world grown from one recipe, standing on whole chunks: Emberholm. |
| Instance | A closed place in a space of its own: a dungeon or a developer zone (`content/instances/`). |
| Channel | A copy of a region, for crowds: another opens past a soft cap, and a quiet one merges (Channels, below). Today a channel plays the whole world, which is Emberholm. |
| Copy | A copy of an instance, for a party. |
| Space | Where a position is: the world, or one copy of an instance. |
| Chunk | 256 m on a side: where regions stand, and the unit a simulation will own. |
| Cell | 32 m: the unit of what a player is sent (R10.8, to come). |
| Land | What's built and planted in the world, shared by a region's channels (R10.21, to come; today each channel keeps its residents' estates). |
| Life | A character's own state: bag, coins, quests, skills, labour. |

"Island" is the old word for a character's life and for Emberholm. It leaves the code, the wire and
the saves' column (`characters.island`) as each area is touched (R10.14).

## Where the Regions Stand

`content/world.json` places each region on its chunks:

| Field | What |
|---|---|
| `chunk` | Metres a chunk is on a side (256). |
| `blend` | Metres either side of a border over which the ground is shared with what's across it (64; at most half a chunk). |
| `sea` | Sea level (`level`), the same everywhere, and how deep the open sea is (`depth`) wherever no region stands. |
| `regions` | Each region's `id` and its `chunks`: the first chunk (`x`, `z`) and how many along x (`w`) and z (`d`). |

Emberholm is 6 × 6 chunks round the world's origin, 768 m to either side. The edge of the world is
the edge of every region's chunks together.

The world has one frame of coordinates, its origin in the middle of Emberholm. A region's recipe, and
everything in its folder, is written in the world's coordinates. Its grid covers exactly its chunks,
with its terrain's origin at their middle. So a region is placed by where it stands and never moved
there. Each instance has a frame of its own (Spaces, below).

## The Ground

The engine's world map (`crates/engine/src/open/map.rs`: `WorldMap`, `world_map()`) answers the
rules' questions about the ground anywhere:

- how high it is (`height`) and how steep (`gradient`, `slope`);
- what it's made of (`surface_at`);
- how deep the water is over it (`depth`);
- which region a point is in (`region_at`, `zone_at`);
- where the edge of the world is (`inside`, `keep_inside`).

The rules ask through the map, so they work the same in any region and across borders.

- **Growing.** A region grows from its recipe the first time anything asks: its terrain, surfaces,
  trees, rocks and buildings' colliders (`open/generate.rs`, `open/buildings.rs`).
  - The server grows it natively.
  - The browser grows it through the WebAssembly (`zone_grow`; `growZone` in
    `src/engine/world/region.ts`), and gets the same ground to the bit
    (`tests/conformance/terrain.test.ts`).
- **Borders without a seam.** Near a chunk's edge, the ground is shared with what's across it.
  - The weights step smoothly over `blend` metres either side of the edge, and always sum to one.
  - Every region's cell is the same size, a whole number to a chunk, so both sides of a border read
    the same heights.
  - A region bakes the blend into its grid as it grows, so what's drawn is what's walked on.
  - The open sea slopes up to meet a region the same way.
- **What's solid** in the world is every region's colliders together.

Today the whole world grows the first time it's asked, and the browser draws Emberholm alone
(`makeZoneWorld`). Two parts are next: growing what's near and dropping what's behind (R10.16), and
the browser doing that in a worker as you travel (R10.23). In R10.16, the server grows its own chunks
and a band round them.

## Spaces

Every position the server, the browser or a save keeps is in a space: the world, or one copy of an
instance.

- **An instance is a space of its own.** Its floors and walls stand round its own origin, over
  nothing (`OpenWorld::instance`; its map is `WorldMap::void`, with no region, no sea and a long fall
  below). Nothing of the world is near you inside it, and nothing of it is in the world.
- **Each server game plays one space.** Going through a portal moves you to another game
  mid-connection (`Spaces::move_to`).
- **Saves:** one made in a copy keeps the spot outside its door, so a restart puts you there.

## Channels

The world is played in channels: each region in copies of itself, so that no crowd grows too big to
play in (D17). A channel is a game of its own, with its players, creatures and bots, stepped 20
times a second by the world thread. The land is the same in every channel of a region (R10.21).

Today the server fills channels by residents (`crates/server/src/play/spaces.rs`, `channels.rs`):

- **Residents.** Each channel is home to at most 24 characters (`CHANNEL_CAP`).
- **Estates.** A resident's houses, farms and ships on the slipway stand in their channel while
  they're away.
- **Plots.** A house plot goes to whoever built on it first in that channel.

The policy that replaces them is built (`crates/channels`, R10.22), and goes into the server's
directory once the server is in tiers (R10.20) and land is the world's (R10.21).

### The Policy

`crates/channels` is the policy alone: pure, with no clock (whoever asks hands in the time) and no
maps that iterate in an order of their own. It speaks the server tiers' words: a channel is a
region's number `n`, times are `Millis`, players character ids. Whoever keeps who plays where holds
a `Region` for each region, tells it what happens, and carries out the `Action`s it answers with
(open a channel, move someone, close a channel).

- **Placing** (`Region::arrive`). Someone coming into the world goes to the first of:
  - the channel they left, if they left it less than `rejoinWithin` ago (a dropped connection, or
    signing out and back in, doesn't move anyone; a channel merged meanwhile, where it went);
  - their party's channel: its leader's, else where most of it plays;
  - the channel with the most of their friends, then of their guild, then the biggest share
    speaking their language, then the fullest, of those below the soft cap;
  - a new channel.

  Coming back and joining a party may pass the soft cap, never the hard cap. Friends, guilds and
  languages are hooks (`Ties`): the social tier keeps only parties today, and they answer nothing
  until it learns them.
- **Opening** (`Region::review`, once a second). Another channel opens when the room left below the
  soft cap in all of them together falls under `openAhead`, so a crowd still coming finds it there.
- **Merging.** A channel with fewer than `quiet` players for `quietFor` merges into the fullest
  other that can take them and stay at most `mergeFill`: the newest quiet channel first, one merge
  at a time, everyone into one channel. Its players are told (`Merging`), nobody new goes in, and
  from `mergeNotice` on each is moved (`Move`) to the same spot in the other channel, with their pack
  and whatever they ride, once out of combat, on the ground and off a game's table; whoever is left
  after `mergeWait` more is moved anyway. Then it closes (`Close`). An empty one closes at once.
- **Changing channel** (`Region::change`, `Region::joined_party`). A player's choice, or accepting an
  invitation into a party in another channel. Never with a pack, in combat (a blow struck or taken
  within `calmAfter`, or down), riding, in the air or at a table, nor within `changeEvery` of the last
  change. A choice goes only to a channel below the soft cap and not closing; joining a party, up to
  the hard cap. An invitation the rules refuse for now goes through as soon as they allow.
- **What a player sees** (`Region::view`): each channel's load (quiet, lively, busy, full), whether
  it's closing, their party and friends in it, their merge's countdown, their cooldown, and what
  stops them changing.

The hysteresis: a merge never leaves a channel past `mergeFill`, and a channel opens ahead only once
the room left is under `openAhead`; contentc holds `openAhead` below `softCap - mergeFill`, so a merge
never opens a channel again at once.

### Its Numbers

`content/channels.json` (built to `shared/channels.json`; contentc and `Tuning::check` hold them in
order). Counts are players in a channel, times seconds.

| Field | What | Now |
|---|---|---|
| `softCap` | Placed by affinity up to this; past it another channel opens | 1,000 |
| `hardCap` | Nobody is placed past this, with their party or coming back | 1,200 |
| `openAhead` | Another opens when the room left below the soft cap is less than this | 50 |
| `quiet`, `quietFor` | Fewer than this many for this long, and a channel merges | 250, 300 |
| `mergeFill` | A merge leaves the channel it merges into at most this full | 750 |
| `mergeNotice`, `mergeWait` | Warning before a merge moves anyone; then how long it waits for fights and tables | 60, 60 |
| `changeEvery` | Between changes of channel | 300 |
| `calmAfter` | Out of combat after the last blow | 10 |
| `rejoinWithin` | Back where you were if you return within this | 300 |

### The Browser

The Channels window (`src/ui/channels/`, its button beside the Party's) lists your region's
channels and asks to change; a notice at the top of the screen counts down while your channel
closes and says where a move took you. On the wire (`src/net/worldLink.ts`):
`channels {channels}` (a `ChannelsView`) and `channelMoved {from, to, why}` in; `channels` and
`channel {to}` or `channel {party: true}` out. The server's side of these comes with the directory.

### Bots in a Crowd

`crates/channels/src/crowd.rs` plays a seeded crowd of bots against an `Arena`: they come and go on
a curve, in parties formed before they come or by invitation, with friends, guilds and languages,
picking up packs, fighting, sitting at tables, dropping their connections and changing channel. The
policy in memory is one arena (`Here`); the server's directory with bots for players will be
another. After every second it checks that no channel is past the hard cap, nobody past the soft cap
but by their party or coming back, every merge done by its deadline, every refusal with its reason,
and it counts the rest (`Tally`): `cargo test --release -p ruina-channels crowds_measured --
--ignored --nocapture` prints them.

### The World's Clock

Every game numbers its ticks by the world's clock (`crates/server/src/play/clock.rs`): frames at 60
a second from the world's epoch (2026-01-01 UTC), and a server tick every third frame, 20 a second.
- **The same moment everywhere.** A tick is the same moment in every channel and copy, so a browser's
  timelines run on across moves between them, and across a server's restart. A tick that runs late
  takes the number of its moment.
- **The engine reads no clock.** The tick is handed to it, as the time of day is.
- **Lag compensation.** A browser sends the tick it drew everyone else at, in sixteenths of a tick.
  The wire carries only its low 32 bits, and the server reads it back in full against its own tick.

Where this is going:

- **R10.21:** land shared by every channel of a region, each plot claimed once in the world and
  contested.
- **R10.22's second half:** the directory opening and closing channels' simulations by the policy,
  placing and moving players through the tiers' messages, residents gone.
- **R10.19, R10.20:** regions split between simulations, their borders crossed as if they weren't
  there.

## Instances

A dungeon or a developer zone is an instance. A copy of it plays its space alone
(`crates/engine/src/open/dungeon.rs`): on the server, and in the browser while you're in one
(`src/engine/world/dungeons.ts`, `src/app/dungeonVisit.ts`: the world set aside until you come back
out).

- **Going in** moves you between games on the server mid-connection, your life and all
  (`Spaces::move_to`). The browser hears where it is (`onSpace`) and draws the place: a cave
  (`src/render/open/dungeonView.ts`, Emberholm put away) or an open arena (`arenaView.ts`, under the
  sky).
- **A copy is kept** 30 minutes after the last player leaves, as World of Warcraft keeps an instance.
  Whoever is in it but no longer in its party is put out after a minute.
- **Falling** below `fall`, or being knocked down, gets you up where you came in.
- **Creatures** a copy brings (`spawns`) stand on its floor. Their heights, and every height in a
  fight, are measured from the copy's floor where it has one (`DungeonDef::floor_at`, the highest
  piece no more than 0.6 m tall under a point; `floorAt` in the browser).
- **Offline** the browser plays a copy itself (`crates/engine/src/session.rs`, `enter_dungeon`):
  through a dungeon's portal, or from the start with `?test=<instance>` (paused, for tests) or
  `?offline=<instance>`. The copy brings its creatures, numbered on from the world's, which wait
  outside until you come back out. Its bots are the server's alone.

### An Instance's File

Everything is round its own origin, with heights (`top`) above it: an instance's space is its own, so
where one stands says nothing about where another does. `content/_schemas/instances.schema.json`
holds the fields.

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
| `spawns` | Creatures a copy brings, as a region's recipe has them: a `kind` (`shared/actors.json`, or a creature's kinds) at `x`, `z`; `count` of them spread round the spot out to `r` metres (in a ring without `r`); with `band: true`, a war-band of `count` in a ring round the spot, fighting as a pack (`crates/engine/src/open/spawns.rs`) |
| `bots` | Bots in it while anyone is: `count` of a `brain` on a `team`, round `x`, `z` |

### Dressing a Cave

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
it steps the players (`play/stepping.rs`).

An instance's bots come in with its first player and go with the last, so an empty battlefield costs
nothing. An admin can add more anywhere with the `bots` command (`n`, `brain`, `team`; `n: 0` sends
them away). A new kind of bot is a brain in `bots.rs` and its name in `Brain::named`.

## Adding a Region

1. **Its recipe and folder.** The recipe is `content/regions/<id>.json`, and its folder beside it,
   `content/regions/<id>/`, holds what it places, in the world's coordinates:
   - places, workbenches, house plots and gathering spots;
   - structures, props and outposts;
   - the doors into its dungeons.

   The templates are in `content/_templates/region/`. Its people are `content/npcs/`. The creatures
   it brings to life are its recipe's `spawns`, as an instance's are (An Instance's File, above): the
   server spawns them in each channel, and the browser's island does offline
   (`crates/engine/src/open/spawns.rs`).
2. **Its chunks** go in `content/world.json`, a square of them that no other region has. Its recipe's
   grid covers exactly them (`cells` × `cell`), with the same cell as every other region, and its
   terrain's origin at their middle.
3. **Its words** go in `src/bible/notes/regions.md`, under `## <id>`.
4. **The checks.** `npm run content` checks its grid, its sea level and that every id in it is one
   thing in the whole world. `npm run check` checks the borders (`map.rs`'s tests) and the bible.

The server's rules see the new region from then on. The browser draws only Emberholm until it grows
what's near the player (R10.16, R10.23).

## Adding an Instance

**A developer zone** is its file alone:

1. Copy `content/instances/yard.json` to `content/instances/<id>.json`. Give it an `id`, `name` and
   `about`, and lay out its pieces, spawns and bots round its origin.
2. Put its id in `content/instances/_order.json`, then run `npm run content`.
3. `cargo test --release --workspace` checks it has a floor where you come in, its pieces within its
   edge, and a way out. The Admin menu lists it from then on.

**A dungeon** is its file, dressed, and a door in the world:

1. Copy `content/_templates/dungeon.json`, a cave, to `content/instances/<id>.json`. Give it an `id`
   and `name`, lay out its pieces round its origin and dress it (Dressing a Cave, above). Put its id
   in `_order.json`, as above.
2. Put its door in the region it's entered from, `content/regions/<region>/doors.json`, named for the
   dungeon (`id`): the portal (`portal`, with a radius `r`) and where you come out (`outside`), in the
   world's coordinates. contentc holds a door to a dungeon of its name.

## Testing

- `crates/engine/src/open/map.rs` checks Emberholm and two fixture worlds (an archipelago, and a
  mainland split between regions):
  - Emberholm stands round the origin, with open sea past it to the edge of the world.
  - Borders meet with no seam, across land and with the open sea.
  - You can walk from one region into the next, and swim from one to the next.
  - A region's ground is its own, except within the blend of its edge.
  - No two regions share a chunk.
  - A world is solid with all its regions' colliders.
- `tests/conformance/terrain.test.ts`: the WebAssembly's region against the native one, all of it.
- `tests/integration/world.spec.ts`: the open world in a page, and played on that ground (swimming,
  gliding, farming, vehicles, boats).
- `crates/engine/src/open/dungeon.rs`: every instance loads, has a floor where you come in and its
  pieces within its edge, and every dungeon has a door in the world and a way out.
- `crates/server/src/play/spaces.rs`: copies made, kept and let go; admins in, players kept out; the
  yard's creatures on its floor; the goblin camp's war-band.
- `crates/engine/src/session.rs` and `tests/unit/rules/instances.test.ts`: offline, a copy of the yard
  with its own creatures on its floor (the world's back as they were when you come out), where it's
  entered, and blows landing on its dummy.
- `tests/integration/admin.spec.ts`: an admin goes into the battlefield (its bots, the arena, out at
  its door) and into the yard from character select (its dummy and slimes on the floor, blows
  landing); a player is kept out.
- `tests/unit/caves.test.ts`: a cave drawn from its dressing (Goblin's Dread's and the template's),
  and every prop and pile a dressing names one the cave can draw. `tests/unit/content.test.ts`: a
  dressing held to its instance.
- `tests/integration/dungeon-way-in.spec.ts`, `tests/integration/party.spec.ts`: Goblin's Dread's way
  in, and parties into one copy.
- `crates/channels`: placing (back, party, friends, guild, language, the fullest, a new channel),
  the soft and hard caps, the rules for changing channel and following a party, merges (who waits,
  the deadline, an empty channel, one at a time, newest first), opening ahead, and what a player
  sees; and crowds of bots (`crowd.rs`), from 150 in small channels to 6,000 by the game's numbers,
  checked every second. `tests/unit/content.test.ts`: the channels' numbers held in order.
- `tests/unit/channels.test.ts` and `tests/integration/uiGallery.spec.ts` (`#/ui/channels/...`): the
  Channels window's words and reasons, and the window and notice drawn in Title Case.
