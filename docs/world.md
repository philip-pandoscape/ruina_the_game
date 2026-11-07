# The World

Ruina's main world is one seamless open world of regions, set on a grid of chunks with the sea
between them. The instances stand beside it: dungeons and developer zones, each a space of its own.
Emberholm, the starter isle, is the first region and today the only one. This page covers how the
world is laid out, how the rules read its ground, and how it is played. Instances, copies and bots
are covered in [zones.md](zones.md). The plans for the rest are in `.plans/world/` and the refactor's
Phase 10 (`.plans/refactor/tracker.md`, R10.17 to R10.24):

- regions split between simulations, their borders crossed seamlessly;
- land that every channel shares;
- channels that open and merge with the crowd.

## The Words

| Word | What |
|---|---|
| World | The one open world. |
| Region | A part of the world grown from one recipe, standing on whole chunks: Emberholm. |
| Instance | A closed place in a space of its own: a dungeon or a developer zone (`content/instances/`). |
| Channel | A copy of a region, for crowds. Today a channel plays the whole world, which is Emberholm. |
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
- **Saves:** one made in a copy keeps the spot outside its door.

Instances, copies and how to add one are in [zones.md](zones.md).

## Channels

The world is played in channels (`crates/server/src/play/spaces.rs`, `channels.rs`). A channel is a
game of its own, with its players, creatures and bots, stepped 20 times a second by the world thread.

- **Residents.** Each channel is home to at most 24 characters (`CHANNEL_CAP`).
- **Estates.** A resident's houses, farms and ships on the slipway stand in their channel while
  they're away.
- **Plots.** A house plot goes to whoever built on it first in that channel.

Where this is going:

- **R10.21:** land shared by every channel of a region, each plot claimed once in the world and
  contested.
- **R10.22:** channels that open past a region's soft cap and merge when quiet, placing players by
  party, friends and guild.
- **R10.19, R10.20:** regions split between simulations, their borders crossed as if they weren't
  there.

## Adding a Region

1. **Its recipe and folder.** The recipe is `content/regions/<id>.json`, and its folder beside it,
   `content/regions/<id>/`, holds what it places, in the world's coordinates:
   - places, workbenches, house plots and gathering spots;
   - structures, props and outposts;
   - the doors into its dungeons.

   The templates are in `content/_templates/region/`. Its people are `content/npcs/`. The creatures
   it brings to life are its recipe's `spawns`, as an instance's are ([zones.md](zones.md)): the
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
