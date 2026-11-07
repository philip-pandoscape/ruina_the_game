# A Seamless, Horizontally Scaled World for Ruina

*Research report, 6 November 2026, written against branch `refactor/first` (31657d3). Research only: nothing in
the repository was changed.*

**How the sourcing is marked.** Claims about a game or product link their source inline. *(secondary)* marks
press or wiki coverage; *(forum)* marks forum or Reddit posts, used only where nothing better was found.
**Inference** marks my own reasoning or estimates rather than something I read. Claims about Ruina cite files
in the repository. Dates are given where a source's age matters (Star Citizen and SpatialOS especially).

---

## Summary

1. **Nobody surveyed runs 100,000 players in one undivided real-time space.** The games that put tens of
   thousands on one world split it twice. They split space into pieces, each owned by one process: EVE's solar
   systems on nodes, New World's grid cells on "hubs", Albion's clusters, Star Citizen's static mesh. And they
   split density into copies: WoW's layers and shards, Guild Wars 2's megaserver maps, Black Desert's
   channels, instances. EVE alone slows the clock instead, down to 10% of real time.
2. **Dynamic splitting by load has a mixed record.** Asheron's Call (1999) and the BigWorld middleware
   shipped it. The big recent attempts have not delivered it at scale. As of August 2026 Star Citizen's
   persistent universe still runs a fixed number of servers per shard, with dynamic servers used only for
   instancing. Improbable's SpatialOS games closed and the company left games. Dual Universe's official
   servers shut in August 2025, and Ashes of Creation's studio collapsed in February 2026.
3. **Recommendation: static regions, seamless borders, density in layers.** Regions are defined by data, and
   each is simulated by one process (several small regions may share one). Borders are made seamless by:
   - ghost copies of entities in a band along the border;
   - authority handoff, with hysteresis and an ownership epoch;
   - gateway servers that keep the player's connection while the server behind it changes.

   Each region handles density with layers (copies), keeping parties and friends together. Dungeons,
   developer zones and housing neighbourhoods stay instances. Automatic splitting comes later, and only for
   content that cannot be layered (sieges, world bosses), and only once measurements show CPU is the limit.
4. **Ruina starts from a good place.** Its rules give the same result on any machine, and positions are
   64-bit floats. Players already move between games mid-connection (`Spaces::move_to`). Vehicles are read
   from a start-of-tick snapshot (`gather_movers`), player hits are collected and applied after everyone has
   moved, and saves are fenced by `live_session`.

   **What stands in the way:**
   - one zone is wired in (`emberholm()`), and dungeons are stacked in Emberholm's sky;
   - one thread ticks every game;
   - each JSON update carries every peer in the channel (42.9 KB per update with 64 bots);
   - placed things live inside each character's document, and plot claims are per channel;
   - parties live in memory.
5. **Capacity.** Measured on an Apple M4, 64 bots cost 2.43 ms per 20 Hz tick: about 38 µs per bot per tick,
   or 0.76 ms of CPU per player-second. The rule step alone is 2-3 µs.
   - Plan regions for about 1,000 concurrent players (soft cap) and confirm it with bots.
   - 100,000 concurrent players needs about 70-140 region processes, a pool of instance servers and 10-20
     gateways: roughly 400-800 cores.
6. **Bandwidth is the cost that runs away.** After interest management a player costs about 20 KB/s on
   average. At 100,000 players that is about 2 GB/s at peak and about 2.6 PB a month. At $0.05/GB (Railway,
   AWS's top tier) that is about $130,000 a month; on unmetered bare metal it adds close to nothing. The
   first thing to build is a binary, interest-managed, delta-compressed protocol, about 40 times smaller than
   today's JSON.
7. **Build now, in one process:**
   - a world frame, with instances in frames of their own;
   - regions placed by data on a 256 m chunk grid, with a 32 m interest grid;
   - global 64-bit entity ids, with short per-connection handles on the wire;
   - an owner and an epoch on every entity and every write;
   - a tick in which entities read only the start-of-tick snapshot of others and affect others only through
     events;
   - messages between connection, simulation and storage (in-process channels for now);
   - tables of their own for placed things, plot claims and transfers;
   - a world tick clock, and a thread per game.

---

## 1. Ruina Today, as Far as Scaling Goes

| What | Where | Why it matters |
|---|---|---|
| One OS thread ticks every channel and dungeon copy at 20 Hz, under one lock | `crates/server/src/gate/socket.rs` `spawn_world`, `Hub::with_spaces` | One core for the whole process; a slow game delays all of them |
| A tick runs each player's queued 60 Hz inputs (budget `elapsed × 61`, at most 12) and steps creatures three times at 1/60 s | `play/mod.rs` `play_tick`; `combat.rs` `step_in`, `MAX_INPUTS_PER_TICK` | The simulation is 60 Hz, run in 20 Hz batches |
| Vehicles are read from a snapshot taken at the start of the tick. Hits and heals on players are collected and applied after every player has moved. Swings check positions from history (ticks already ended) | `gather_movers`, `OpenWorld.movers`; `player_hits`, `heals` in `step_in` | Already the shape a partitioned tick needs (section 3.2) |
| Every member gets JSON naming every other player in the game; creatures within 70 m (at most 48); effects within 90 m | `send_tick`, `presence_json`, `actors_json`; `combat.rs` `EFFECT_RADIUS` | About 670 B per peer per update; players get no interest management |
| Measured: 1 player + 32 bots costs 1.09 ms per tick and 22.3 KB per update; with 64 bots, 2.43 ms and 42.9 KB, at 58 fps on an Apple M4 | `scratch/stress-battlefield-before.json` (R10.8's baseline) | Baseline for section 4 |
| Channels are whole copies of Emberholm, each home to at most 24 characters with 8 house plots | `play/channels.rs` `CHANNEL_CAP`; `content/zones/emberholm/housePlots.json` | Density and housing are both handled by copying the world |
| Dungeons and developer zones are floors high above Emberholm's sea, in its coordinates, within 760 m of its middle | `docs/zones.md`; `crates/engine/src/open/dungeon.rs` | Instances share the overworld's coordinate frame |
| Emberholm is 768 cells of 2 m, a 1,536 m square centred on the origin. It grows in 90-145 ms in WebAssembly | `shared/zones/emberholm.json`; `open/zone.rs`; `.plans/refactor/tracker.md` (R8.6) | Both sides can grow a region from its recipe on demand |
| `emberholm()` is called in about 30 places. The production ones are in `spaces.rs`, `play/mod.rs`, `bots.rs`, `session.rs` and `crates/engine-wasm` | grep | One zone is wired in, though `Life::new` already takes a zone as a parameter |
| A character's island (life state and position) is one JSONB document. It is written every 5 s by an `UPDATE` that checks `live_session`, and a pot's two islands are written in one transaction | `migrations/0001_*.sql`; `socket.rs` `write_island`, `write_islands` | Placed things have no location key: their owner carries them |
| Estates (houses, scarecrows, ships) of a channel's residents are shown in that channel, and a plot goes to the earliest character id | `channels.rs` `recount_claims` | Plot ownership is decided per copy, in memory |
| Characters are a `BIGSERIAL` sent on the wire as `character as u32`. Placed things are numbered per island (`next_id`), creatures per game (`u32`), and gathering-node cooldowns are keyed by the node's index in the zone | `play/mod.rs` `client`; `life/state.rs`; `actors.rs`; `life/interact.rs` | Ids are local to an owner or a game |
| Parties live in the server's memory ("a restart ends parties") | `play/parties.rs`; `design/status.json` | Lost on restart; cannot span processes |
| Lag compensation keeps 40 ticks of (tick, x, y, z) per player and rewinds up to 16 | `combat.rs` `HISTORY`, `MAX_REWIND_TICKS` | Ghosts will need the same history |
| Top speeds: sprint 10.5 m/s, fastest vehicle 23 m/s (boost 29), glider dive 27 m/s | `shared/tuning.json`, `shared/vehicles.json` | These size the border band and the hysteresis |
| Ground and water shaders work in world-space positions | `src/render/open/ground.ts`, `water.ts` | 32-bit float precision on the GPU degrades far from the origin |

---

## 2. Survey

### 2.1 At a Glance

| Game (years) | How the world is split | Numbers | Borders | Went well | Went badly |
|---|---|---|---|---|---|
| **EVE Online** (2003-) | One shard. Solar systems are mapped to SOL nodes at daily downtime; PROXY nodes in front | 195 active + 39 spare nodes (2023); 6,739 pilots in one system (2021); 65,303 concurrent players (2013) | Jump gates: hard borders, never seamless | One economy for everyone; time dilation degrades gracefully | Fights must be booked ahead; dilation slows every system on the node; 10% speed is barely playable |
| **World of Warcraft** (2004-) | Realms. Continents and instances on separate servers *(secondary)*; cross-realm zones (2012); sharding (2016-); Classic layering (2019); instanced housing neighbourhoods (2025-26) | More than three layers per realm was rare after Classic's first week | Seamless within a continent; loading between continents and into instances | Layers absorbed launch crowds, then collapsed | Layer hopping; friends split apart; roleplay events broken by shards |
| **Guild Wars 2** megaserver (2014-) | Every open-world map is instanced; a weighted load balancer places players by affinity | No published cap per map copy | Loading screens between maps | No overflow maps; fuller maps (+225% average population in tests) | Communities fragmented; a queue for full copies was added in 2023 |
| **New World** (2021-) | A grid of cells over seven c5.9xlarge machines per world; four gateway machines; DynamoDB | 2,500 players and 7,000+ AI per world; 30 Hz; 800,000 writes per 30 s | Seamless: state is handed hub to hub | A seamless continent at 2,500 a world | A 2,000 cap at launch meant 15,000-25,000 queues; duplication exploits turned the economy off |
| **ArcheAge** (2013/2014-) | One world per server, its land in the open world | Queues of thousands at launch *(secondary)* | Seamless continents joined by sea *(secondary)* | Sea trade, contested land | Land rush; capacity bought up front ("multiple millions"); later server merges |
| **Black Desert** (2014-) | Seamless world; each server runs channels, copies of the world | Up to 9 channels per region (2016) *(secondary)* | Seamless; switching channels moves you to another copy | n/a | n/a |
| **Albion Online** (2017-) | About 600 clusters of about 1 km², spread over game servers; a world server for global features; Cassandra and Postgres | Up to 300 players per cluster; 15,000 concurrent planned on 8 × 10-core machines (2016) | Loading between clusters; handoff goes through the database | Simple single-threaded logic per cluster | Cassandra lost buildings in an alpha; two datacentres were "a bad idea" |
| **PlanetSide 2** (2012-) | Each server has several continents, each a battlefield | About 2,000 per continent (2012); a record 1,158 in one battle (2015) | Continents are separate | Huge fights | Caps were later cut for performance *(forum)* |
| **Asheron's Call** (1999) | Dynamic load balancing: servers divide the world by processor load | 3,000 concurrent per server | Seamless | Did not crash for the first weeks | Unproven at the time; schedule slips |
| **Star Citizen** | A replication layer (Replicant, Gateway) and a graph database of every entity. Static meshing since Dec 2024; quasi-dynamic instancing since Aug 2026 | 500 per shard (4.0); tests of 800-2,000; 50 per server at the time of the Q&A | One server owns each entity; others hold client views | Clients stay connected while a crashed server is replaced | A decade of work; dynamic meshing still not in the persistent universe; universe resets over duplication |
| **SpatialOS** / Worlds Adrift (2015-2019) | Entities made of components; one worker owns each component; interest queries; hosted by Improbable | n/a | Authority moves between workers | Small teams could attempt big worlds | The games couldn't be hosted elsewhere; Worlds Adrift closed in 2019; Improbable left games |
| **Improbable Morpheus / MSquared** (2022-) | Dense, single-space live events | Claims 10,000+ in one space | n/a | n/a | Marketing claims only; a metaverse pivot |
| **Dual Universe** (2020-2025) | One continuous shard; dynamic cubes split by player density | 30,000 simulated players on about 112 VMs at 10 Gb/s (2019) | Seamless | The technology held its test | No regional servers by design; official servers shut on 27 Aug 2025 |
| **BitCraft** on SpacetimeDB (2025-) | Regions as spatially partitioned servers; one root database and many region databases | About 300k transactions/s per database (benchmark), each database single-threaded | Regions | One Rust module holds both persistence and logic | Cross-region work is asynchronous until two-phase commit ships |
| **Ashes of Creation** (2024-2026) | Server meshing: a bounded area per server, proxies across servers (2024 stream) | Not published | Claimed seamless | n/a | Studio collapsed in Feb 2026, two months into early access |
| **Hadean** Aether Engine (2019) | A distributed simulation engine | 3,852 players and 14,274 ships in one demo (GDC 2019) | n/a | An hour-long demo held | A tech demo, never a shipped MMO |
| **BigWorld** (middleware) | Cells with moving boundaries, ghosts, BaseApp proxies, entity backups | Offload check about once a second; about 10 m hysteresis | Seamless | The best-documented reference design | n/a |
| **Second Life** (2003-) | One simulator per region | n/a | Seamless by handoff | n/a | Vehicles crossing regions lose passengers and jump |
| **Old School RuneScape** | Each world simulates the whole map | 2,000 players and tens of thousands of NPCs per world, 0.6 s tick (2025) | Worlds are copies | n/a | Needed more capacity per world in 2025 |

### 2.2 Notes

**EVE Online (CCP).**
- **Architecture.** One shard, Tranquility. Clients reach SOL nodes, which run solar systems and services,
  through PROXY nodes, with Microsoft SQL Server behind.
  - In 2023 there were 195 active and 39 spare nodes, run 13 to a 16-core machine.
  - Jita runs alone on its own node.
  - The database is a primary/standby pair with 4 TB of memory each.

  ([CCP, *Tranquility Tech IV*, 2023-03-08](https://www.eveonline.com/news/view/tranquility-tech-iv)).
- **Borders.** Systems are joined by gates, a hard border, never a seamless one. Systems are mapped to nodes
  at downtime. An alliance planning a big fight files a notification so the system is moved to a reinforced
  node at the next downtime ([CCP, *Fleet Fight Notification
  Tool*](https://www.eveonline.com/news/view/fleet-fight-notification-tool)).
- **Density.** Time Dilation slows the game clock when a node is overloaded, because "a large majority of the
  load in large engagements is tied to the clock" ([CCP Veritas,
  2011-04-22](https://eveonline.com/article/introducing-time-dilation-tidi)).
  - Its floor is 10% of normal speed ([EVE University wiki](https://wiki.eveuniversity.org/Time_Dilation),
    *secondary*).
  - It applies to the whole node, so systems far from a fight slow down too. CCP's first report counted over
    1,300 pilots on a reinforced node of 4 systems and over 1,350 on a normal node of 83 ([CCP Veritas,
    2012-02-10](https://www.eveonline.com/news/view/time-dilation-hows-that-going)).
- **Numbers.** M2-XFE peaked at 6,739 pilots in one system in January 2021 ([CCP, *The Second Timer in
  M2-XFE*](https://www.eveonline.com/news/view/the-second-timer-in-m2-xfe)). The all-time record is 65,303
  concurrent players, in May 2013 ([EVE forums](https://forums-archive.eveonline.com/topic/210628/),
  *forum*).
- **Lesson.** Hard borders let a single shard scale. Density is the unsolved part, and CCP's answer is to slow
  time, which is unacceptable for 60 Hz action combat (**inference**).

**World of Warcraft (Blizzard).**
- **Servers.** Each realm's continents and its instances are said to run on separate servers
  ([HowStuffWorks](https://electronics.howstuffworks.com/world-of-warcraft5.htm), *secondary*: Blizzard hasn't
  published its architecture). Zones within a continent are seamless; continents and instances load.
- **Cross-realm zones (2012).** These mix players from several realms in low-population zones ([Engadget,
  2012-05-10](https://www.engadget.com/2012-05-10-world-of-warcraft-unveils-cross-realm-zones.html);
  [2012-09-24](https://www.engadget.com/2012/09/24/blizzard-clarifies-cross-realm-zones/), *secondary*).
- **Sharding** (from Legion) copies a zone dynamically by population. It was turned almost entirely off on
  roleplay realms because their events suffered ([Mein-MMO](https://mein-mmo.de/en/sharding-auf-rp-realms-in-wow-deaktiviert,169943),
  *secondary*).
- **Classic's layering (2019).** Each layer is a copy of the whole outdoor world, with its own creatures and
  gathering nodes. You change layers by joining a party led from another one, and "layer hopping" became a
  common move ([Warcraft Wiki](https://warcraft.wiki.gg/wiki/Layering), *secondary*). Blizzard's update
  ([Kaivax, 2019-10-03](https://eu.forums.blizzard.com/en/wow/t/92241/1)) said:
  - Blizzard had raised the number of players a layer holds;
  - "the last time a server in this region had more than three layers was the first week of September";
  - every realm would be on a single layer before world bosses.
- **Housing (Midnight, 2025-26).** Neighbourhoods are "instanced but crucially also persistent". Public ones
  are created by the servers as needed ([Blizzard,
  2025-02-05](https://news.blizzard.com/en-us/article/24176592/building-in-azeroth-a-first-look-at-housing)),
  each with about 50 plots ([Icy
  Veins](https://www.icy-veins.com/wow/news/player-housing-neighborhoods-explained/), *secondary*).
- **Lesson.** Copies solve crowding, but they leak: through hopping, through separating friends, and through
  breaking player-run events. A ten-year-old MMO moved housing into persistent instances rather than the open
  world.

**Guild Wars 2 megaserver (ArenaNet, 2014).**
- **How it places players.** It is "a weighted load balancer for players". It scores every copy of a map by
  your party, guild, language, home world and usual companions, then places you in the copy with the most
  affinity. "there are as many copies of a map as are needed" ([Johanson and Loretan,
  2014-04-02](https://www.guildwars2.com/en/news/introducing-the-megaserver-system/)).
- **Joining friends.** You can join a friend's copy by right-clicking them, and since April 2023 you can queue
  for a full copy ([GW2 wiki](https://wiki.guildwars2.com/wiki/Megaserver)).
- No cap per copy is published.
- **Lesson.** Affinity scoring is the cheap, proven way to make copies feel like one world.

**New World (Amazon Games, 2021).** AWS's account ([AWS,
2022-04-06](https://aws.amazon.com/blogs/gametech/the-unique-architecture-behind-amazon-games-seamless-mmo-new-world)):
- Each world sits behind four "remote entry points" (c5.2xlarge, the only public addresses).
- Seven c5.9xlarge "computational processing units" form the "hub", and "each hub corresponds to two
  nonconsecutive subdivisions of a grid" (the wording leaves unclear whether a hub is one machine or all
  seven).
- Player state is handed from hub to hub as players move, and session-based content runs on a shared pool.
- Each world holds 2,500 players, 7,000+ AI and "hundreds of thousands of objects", updated 30 times a
  second.
- DynamoDB takes about 800,000 writes every 30 seconds.

At launch the cap was 2,000 per world, with queues of 15,000-25,000 ([PC
Gamer](https://www.pcgamer.com/new-world-server-queue/)). Gold duplication exploits made Amazon turn off all
wealth transfers in November 2021 ([PC
Gamer](https://www.pcgamer.com/amazon-disables-new-world-wealth-transfers-to-fight-gold-dupe-exploit)).
**Inference:** giving each machine two non-adjacent cells means one hotspot never lands on a single machine
alone.

**ArcheAge (XLGames; Trion in the West, 2014).** Its continents are seamless and joined by sea ([Scan, *a new
kind of MMO*](https://www.scan.co.uk/info/guide/archeage-new-mmo), *secondary*). I found no public account of
its server architecture. Trion's Scott Hartsman said ([Massively, 2014-09-22](https://www.engadget.com/2014-09-22-massively-interviews-trions-scott-hartsman-on-archeages-rocky.html)):
- overflow hardware went into service "the instant we saw what was happening";
- launch hardware purchases are "multiple millions of dollars";
- "cloud services really aren't there yet for MMOs";
- "competition for, and trade of, contested land is a core part of this game".

A land rush followed when Auroria opened ([Engadget,
2014-11-07](https://www.engadget.com/2014-11-07-lost-continent-its-getting-harder-to-like-archeage.html),
*secondary*). **Inference:** with plots in a shared open world, land is scarce by design, and capacity
cannot grow without diluting it.

**Black Desert (Pearl Abyss).** A seamless world. Each server's regions run up to nine channels, copies of
the same world, to spread players out ([Mein-MMO,
2016-02-26](https://mein-mmo.de/en/black-desert-serverstruktur,68103/), *secondary*).

**Albion Online (Sandbox Interactive).** David Salz described its servers in 2016 ([Quo Vadis
2016](https://www.slideshare.net/slideshow/albion-online-software-architecture-of-an-mmo-talk-at-quo-vadis-2016-berlin/62724504)):
- **Servers.** Game servers; a world server for everything "global" (guilds, parties); login, market and
  chat servers. Game data is in Cassandra, accounts and market in Postgres.
- **The world.** About 600 clusters of about 1 km², "distributed among game servers". Logic is
  single-threaded per cluster and event-driven, with no game loop.
- **Targets per cluster.** About 500 mobs, more than 10,000 interactive objects, up to 300 players.
- **Interest.** An area on a 10 × 10 m grid, subscribed at an inner radius and dropped at an outer one.
- **Handoff.** A player moving to another server is handed over through the database, even when both
  clusters are on the same server.
- **Hosting.** 8 machines (10 cores, 32 GB) for about 15,000 concurrent players. Running two datacentres
  "Worked, but bad idea!"; Cassandra once lost buildings in an alpha.

The game later ran one world per region: the Americas, then Asia, then Europe ([Unity,
2026-05-12](https://unity.com/blog/albion-online-cross-platform-pvp-mmo-architecture)).

**PlanetSide 2 (SOE, then Daybreak).** "Every continent supports around 2,000 players" ([Engadget,
2012-10-04](https://www.engadget.com/2012-10-04-soe-announces-esamir-planetside-2s-new-cold-continent.html),
*secondary*). Guinness recorded 1,158 players in one battle in 2015 ([Guinness World
Records](https://www.guinnessworldrecords.com/news/2015/1/planetside-2-gamers-aiming-for-fps-battle-world-record-this-weekend-370414)).
The caps were later cut for performance, to 400 per faction and then 300; a 2022 developer statement relayed
on Reddit announced 250 ([AnandTech
forums](https://forums.anandtech.com/threads/planetside-2-set-to-break-world-fps-record-tonight-24-01-15.2418146/post-37109211);
[Reddit](https://lr.in.psf.lt/r/Planetside/comments/z1zypt/server_latency_issues/ixeadgb/?context=3), *forum*).
**Inference:** caps per space fall over a game's life as its content gets heavier.

**Asheron's Call (Turbine, 1999).** From the postmortem ([Ragaini, *Game Developer*, April
2000](https://www.gamedeveloper.com/design/classic-postmortem-i-asheron-s-call-i-)):
- "the individual servers can divide up the game world based on the relative processor load of each
  server", rather than each having a fixed area;
- the outdoor world was continuous, with no level loading;
- each server had to perform with 3,000 concurrent players;
- "for the first several weeks, the server software did not crash once";
- the game was first designed for 200 players.

**Star Citizen (CIG).**
- **The plan.** This is a Q&A published after CitizenCon 2951, around late 2021 ([RSI comm-link
  18397](https://robertsspaceindustries.com/comm-link/transmission/18397-Server-Meshing-And-Persistent-Streaming-Q-A),
  read via a [mirror](https://api.star-citizen.wiki/comm-links/18397)):
  - Replication and entity streaming move out of the game server into a "Replication layer" of
    microservices (Replicant, Gateway, Atlas, Scribe), shipped first as a single "Hybrid".
  - A graph database, EntityGraph, "stores the state of every single network replicated entity".
  - Static meshing (node counts and assignments fixed in advance) comes first, dynamic later.
  - One server node controls an entity, and other nodes see "a client view" of it.
  - A crashed Replicant is replaced and restored from EntityGraph in "less than a minute". The Gateway holds
    no state. A crash of the Hybrid sends clients back to the menu.
- **What shipped.**
  - Tests ran with 800 players (March 2024), then 1,000 and 2,000 (October 2024). Static meshing went live
    in Alpha 4.0 (December 2024) at 500 players per shard ([Star Citizen
    Tools](https://starcitizen.tools/Server_meshing), *secondary*).
  - The client stays connected to the replication layer while a crashed game server is replaced ([Star
    Citizen Tools](https://starcitizen.tools/Replication_layer), *secondary*).
- **August 2026** ([Letter from the Chairman,
  2026-08-27](https://starcitizen.tools/Comm-Link:Letter_from_the_Chairman_-_2026-08-27), mirror):
  - "Up until now each universe shard has a set number of servers", and an overloaded territory's server
    "starts to run slower and slower".
  - Alpha 4.10's instancing is "the first use case of dynamic server meshing", but "we are not yet
    subdividing territories in the persistent universe".
  - Peak concurrency in 2026 was 35,890.
- A universe reset came with promises to crack down on duplication ([PC
  Gamer](https://pcgamer.com/games/sim/star-citizens-latest-alpha-update-brings-a-full-reset-to-its-universe-as-cloud-imperium-games-promises-to-crack-down-on-player-exploits-and-duplication-issues)).
- **Lesson.** Separating replication from simulation buys crash recovery without disconnects, but a decade
  of work produced static meshing and dynamic instances, not dynamic territories.

**SpatialOS and Worlds Adrift (Improbable; Bossa, 2015-2019).**
- **The model.** Everything is an entity made of schema-defined components. At most one worker is
  authoritative over an entity's component at a time, and interest queries are mostly spatial. Load
  balancing could be static or dynamic ([SpatialOS docs
  13.x](https://docs.improbable.io/reference/13.6/shared/design/understanding-access), now offline; read via
  search excerpts). A patent describes moving entity authority between workers by load
  ([US10303821](https://patentimages.storage.googleapis.com/c8/38/c9/ca74f4265696f4/US10303821.pdf)).
- **Worlds Adrift** closed in July 2019 as not commercially viable. It "does not run without SpatialOS" and
  could not be hosted anywhere else ([PCGamesInsider](https://www.pcgamesinsider.biz/news/69078/bossas-ambitious-spatialos-powered-worlds-adrift-is-shutting-down-in-july/)),
  though Bossa did not blame the technology
  ([PCGamesInsider](https://www.pcgamesinsider.biz/news/69671/bossa-doesnt-blame-improbable-for-worlds-adrifts-cancellation/)).
- **Unity's licence change** in January 2019 briefly cut off SpatialOS games built with Unity
  ([MCV](https://mcvuk.com/development/unity-blocks-improbables-spatial-os-all-live-and-in-development-games-affected)).
  Improbable later sold its studios, launched MSquared (2022) and sold its defence arm (2023)
  ([Wikipedia](https://en.wikipedia.org/wiki/Improbable_(company)), *secondary*).
- **Lesson.** A world that runs only on someone else's platform lives and dies by that platform and its
  bill.

**Improbable Morpheus / MSquared (2022-).** Improbable claims "over 10,000 players" interacting "in dense
virtual spaces", tested in an experimental mode of its game Scavengers ([Crowdfund Insider,
2022-04](https://www.crowdfundinsider.com/2022/04/189592-improbable-secures-150m-to-launch-m%C2%B2-msquared-a-metaverse-network-ecosystem-supported-by-its-morpheus-tech/),
*secondary*). It is aimed at events rather than a persistent world, and I found no technical paper.

**Dual Universe (Novaquark, 2020-2025).**
- The server "dynamically splits clusters of players into cube-shaped shards based on location". Players
  within 100 m move smoothly; players about 700 m away "blink", because they are updated less often
  ([MMOs.com, 2016-08-16](https://mmos.com/news/novaquark-explains-how-dual-universes-server-works),
  *secondary*).
- A 2019 test ran 30,000 simulated players on about 112 VMs for the cluster, plus 150 for the bots, at
  10 Gb/s in all. There are no regional servers, by design ([Baillie,
  2019](https://medium.com/@jcbaillie/dual-universe-redefines-the-meaning-of-massively-multiplayer-with-over-30-000-a04c0e8b4106),
  read via search excerpts).
- The official servers shut on 27 August 2025; a self-hosted version, myDU, continues
  ([Wikipedia](https://en.wikipedia.org/wiki/Dual_Universe), *secondary*).
- **Lesson.** The technology held 30,000 bots; the game never drew the players to need it.

**BitCraft on SpacetimeDB (Clockwork Labs, 2025-).**
- **The database.** SpacetimeDB is "a database that is also a server". Game logic runs as reducers inside
  it, clients subscribe to queries, and state is held in memory with a commit log ([SpacetimeDB
  docs](https://spacetimedb.com/docs/intro/what-is-spacetimedb)). BitCraft's server is one SpacetimeDB module
  ([BitCraftPublic](https://github.com/clockworklabs/BitCraftPublic)).
- **Regions.** Since May 2025 BitCraft "supports multiple world regions (spatially partitioned servers)"
  ([BitCraft patch notes, 2025-05-06](https://bitcraftonline.com/news/patch-notes-alpha-3-to-steam-early-access-release)).
- **Scaling** ([Cloutier, 2026-09-03](https://spacetimedb.com/blog/how-does-spacetime-scale)):
  - each database is "a single-threaded actor";
  - "a single root database maintains global data", while "region databases handle different parts of the
    world and different groups of players";
  - a database manages about 300k transactions/s on their benchmark;
  - asynchronous calls between databases ship on 31 October 2026, and transactions across databases (by
    two-phase commit) are planned.
- **Lesson.** A root database for global state plus region databases is the decomposition recommended here.
  **Inference:** adopting SpacetimeDB itself would mean rewriting Ruina's 60 Hz server around reducers.

**Ashes of Creation (Intrepid).** A stream on 3 July 2024 showed its server meshing ([Mein-MMO,
2024-07-08](https://mein-mmo.de/en/a-new-mmorpg-claims-it-has-achieved-the-breakthrough-that-star-citizen-dreams-of-will-change-mmos-forever,1147602/),
*secondary*):
- each server is responsible for a bounded part of the world;
- players are handed over without noticing;
- across servers, interaction goes through a "reduced copy" (a proxy) of the player.

Its history ([Wikipedia](https://en.wikipedia.org/wiki/Ashes_of_Creation), *secondary*):
- Early access opened on 11 December 2025.
- On 31 January 2026 its creative director resigned, and a WARN notice announced permanent closure,
  affecting 123 employees.
- The game left Steam on 2 February.

Nothing public says how the meshing held up.

**Hadean (Aether Engine).** EVE: Aether Wars at GDC 2019 ran 3,852 players plus AI clients: 14,274 ships in
all, with a peak of 10,412 concurrent combatants, on Azure, for an hour ([CCP press release,
2019-03-21](https://fenris.com/news/2019/eve-aether-wars-successfully-achieves-groundbreaking-14-000-ship-battle)).
It was a demo, not a shipped game.

**Also relevant.**
- **BigWorld** (middleware) ([Server Overview ch. 4](https://howarduong.github.io/github.io/doc/html/server_overview/ch04.html),
  [ch. 5](https://howarduong.github.io/github.io/doc/html/server_overview/ch05.html), an unofficial mirror of
  BigWorld 2.1's documentation). The best-documented reference design for seamless borders:
  - A space is split into cells whose areas the CellAppMgr varies with load.
  - An entity within the area-of-interest ("ghost") distance of a cell boundary gets a ghost on the
    neighbouring cell, readable but not authoritative.
  - An entity crossing a boundary moves to the next cell and tells its base where it is. BaseApps hold each
    client's proxy, shielding clients "from entities transferring between CellApps".
  - Cells check "approximately once a second" whether to offload entities, with the boundary widened by
    "about 10 metres" against oscillation. A new cell's area grows slowly, so entities migrate "at a
    controlled rate".
  - Cell entities are backed up to their base entities and restored to another cell when a CellApp dies.
- **Second Life** ([Nagle, *Region crossings in Second Life*,
  2018](https://github.com/John-Nagle/lslutils/blob/master/regioncrossing.md)). Each region is its own
  simulator. Ruina's carts and boats with passengers are exactly this case:
  - Vehicles crossing regions are moved without their seated avatars, which follow separately.
  - A normal crossing takes "a second or two", and failures ("half-unsit") grow with passengers.
  - State freezes for 0.5 s, and up to 10 s, while the viewer extrapolates, so vehicles "roll over, go into
    the ground".
  - Roads have to extend past a region's edge.
- **Old School RuneScape.** Each world simulates the whole map, "up to 2,000 players" and
  "tens-of-thousands of NPCs", on a 0.6 s tick, on VMs with 4 GHz CPUs ([Jagex,
  2025-08-07](https://oldschool.runescape.wiki/w/Update:More_Worlds,_More_Power:_The_Road_To_Greater_Capacity)).
- **Dune: Awakening (Funcom, 2025).** A "World" is about 20 servers. Each server's Hagga Basin, where bases
  are built, is its own, while the Deep Desert is shared across the World
  ([PCGamesN](https://www.pcgamesn.com/dune-awakening/server-queues), *secondary*).
- **Unreal's Multi-Server Replication.** A proxy looks like a server to clients and like a
  client to game servers, and each client has one primary game server that owns its pawn ([Epic API
  docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Plugins/MultiServerReplication)).
- **Photon's MMO backend prototype (2026)** ([Photon blog,
  2026-07-14](https://blog.photonengine.com/building-a-seamless-mmo-backend-across-machines/), a vendor):
  - dynamic partitioning, with overlap zones where "each node predicts and reconciles the entities it does
    not own";
  - every operation "executed exactly once";
  - gateways that own the session and filter by area of interest at 30 Hz;
  - simulation nodes that never write to the database directly.

---

## 3. Techniques and Their Trade-Offs

### 3.1 Static Versus Dynamic Partitioning

| Scheme | Used by | Gains | Costs |
|---|---|---|---|
| Fixed regions or grid, assigned at start | EVE (systems on nodes), Albion (clusters), New World (grid on hubs), Second Life, Star Citizen (territories), BitCraft (regions) | Simple, testable, predictable cost; content can keep towns away from borders | A hotspot overloads one server while others idle. This is what Asheron's Call set out to avoid, and the slowing microTech server in CIG's 2026 letter |
| Static, with interleaving | New World (two non-adjacent cells per hub) | Spreads a hotspot across machines (**inference**) | More borders per machine |
| Quadtree or k-d tree split and merge | Dual Universe (cubes); Matrix ([Balan et al., 2005](https://doi.org/10.1007/11587552_20): adds and removes servers for transient hotspots, alone or beside static partitions) | Adapts to load | A split hands off a whole area at once; needs warm spare processes; hard to test; oscillation |
| Moving boundaries (tessellation) | BigWorld, Asheron's Call | Smoothest balance | The most complex; needs gradual migration and hysteresis |

What dynamic partitioning doesn't fix (**inference**): the client side. A thousand players in one plaza is
still a thousand players in each of their views, however many servers simulate them, which is where
bandwidth and drawing run out (section 4).

**For Ruina:** make the 256 m chunk the unit of authority. A region is a set of chunks, assigned statically
at first; later, a k-d tree over chunks splits a hot region.

### 3.2 Borders

- **Ghosts (proxies).** The neighbour holds a read-only copy of every entity within a band along the
  border. That is BigWorld's ghosts, Star Citizen's "client view", Ashes' "reduced copy" and Photon's
  overlap zone. The band must be at least as wide as the larger of two distances:
  - the full-detail visibility radius;
  - the longest interaction range.

  Ruina sends effects within 90 m and creatures within 70 m today, so a band of about 100-120 m.
- **Authority handoff.** An entity changes owner when it is past the border by a hysteresis margin. BigWorld
  uses about 10 m and checks about once a second. With Ruina's top speeds (27-29 m/s), use about 24-32 m,
  checked every tick (**inference**). A two-phase handoff with epochs (**inference**):
  1. The owner A freezes the entity at the end of tick T and sends its state with `epoch + 1`.
  2. B adopts it at T+1 and acknowledges.
  3. A turns its copy into a ghost and forwards any stray messages to B.
  4. The directory, and every later write, carries the new epoch, so anything A still says is refused.

  Inputs keep their sequence numbers, so the gateway re-routes the stream from a given sequence number on.
- **Combat across a border, with lag compensation.** The attacker's server checks the swing against the
  ghost's position history, rewound to what the attacker saw, exactly as `combat.rs` does for local players.
  It then sends the owner a hit event, and the owner applies it, guard and dodge included, on its next tick:
  one tick of extra delay (**inference**). Ghosts therefore need the same 40-tick (tick, x, y, z) history
  that `combat.rs` keeps per player. Projectiles and area effects belong to their caster's server, which
  sends events for targets it doesn't own.
- **AI near borders.** Creatures are leashed inside their home region and spawn well away from borders. They
  see and attack ghosts, but never cross. A creature that cannot respond to a player across the border is an
  exploit; one that chases across adds handoff traffic (**inference**).
- **Physics.** Ruina has no rigid-body physics: static colliders, plus vehicles read from a start-of-tick
  snapshot (`OpenWorld.movers`). A ghost vehicle is one more snapshot entry, so border physics is cheap here
  (**inference**).
- **Vehicles.** Hand off a vehicle, its seated passengers and its cargo as one unit, in one message.
  `seat_passengers` already ties a passenger to their host's vehicle, so they must share an owner. Keep
  borders away from roads, piers and docks, and clip the client's extrapolation at a handoff (Second Life's
  lessons).
- **The invisible border** (**inference**, and the strongest property Ruina has). Suppose, within a tick,
  every entity reads only the start-of-tick snapshot of others and changes others only through events applied
  next tick. Then the order entities are stepped in stops mattering. And if neighbours exchange ghost
  snapshots at each tick boundary, a world split across servers gives bit-for-bit the same result as one
  server. Ruina's golden tests can then hold a partitioned run to an unpartitioned one.

### 3.3 Interest Management

- **Grids with hysteresis.** Albion subscribes at an inner radius on a 10 m grid and unsubscribes at an outer
  one (Salz 2016). BigWorld's area of interest feeds its ghost distance. Ruina's old battle server
  (`git show 04da4b6:crates/server/src/battle/interest.rs`) had three tiers on a 4 m grid:
  - near, within 30 m, every tick, at most 256;
  - mid, within 90 m, every 4th tick, at most 2,000;
  - far, a shared message of 4 bytes per fighter.

  Each fighter's record was packed once per tick and copied into every update.
- **Rates by distance.** Dual Universe updates far players less often and interpolates them (MMOs.com
  2016). A cheap tile-based scheme comes close to ideal visibility-based interest management ([Boulanger,
  Kienzle and Verbrugge, NetGames 2006](https://www.sable.mcgill.ca/~clump/papers/boulanger-06-comparing.pdf)).
  Attention-based interest sets let simulations of 900-player battles fit residential bandwidth ([Bharambe et
  al., SIGCOMM 2008](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/donnybrook.pdf)).
- **Fitting a byte budget.** Priority accumulators: each object's priority is added to its accumulator every
  frame, and the top ones that fit the budget are sent and reset ([Fiedler, *State Synchronization*,
  2015](https://gafferongames.com/post/state_synchronization/)). Delta compression against the last
  acknowledged snapshot took a 901-cube scene from 17.37 Mbit/s to about 15 kbit/s at rest ([Fiedler,
  *Snapshot Compression*, 2015](https://gafferongames.com/post/snapshot_compression/)).

### 3.4 Gateways (Connection Servers)

- **Who uses them.**
  - New World's four remote entry points are each world's only public addresses (AWS 2022).
  - EVE has PROXY nodes (CCP 2023).
  - BigWorld's BaseApps hold each client's proxy and hide cell transfers from it.
  - Star Citizen's Gateway "is just there to direct packets" and holds no state (CIG Q&A).
  - Photon's gateway owns the session and does per-player interest filtering.
  - Unreal's proxy gives each client one primary server and replicates from the others.
- **Why.** The client keeps one connection while the simulation behind it changes. TLS, WebSocket framing
  and fan-out move off the simulation's cores. Simulation servers stay private. And a later transport (UDP
  for the desktop app, or WebTransport) changes one tier only.
- **Choice: who builds each client's view.**
  - The simulation can build each client's view, which uses simulation CPU.
  - Or the simulation publishes entity records per cell, and the gateway subscribes to the cells around each
    client and selects within its byte budget. This uses datacentre bandwidth, which is free.

  The second scales better and keeps the simulation lean (**inference**; it is Photon's pattern).

### 3.5 Entity Ids and Authority

- BigWorld's CellAppMgr is "a global entity ID broker". SpatialOS gives at most one worker authority per
  component. In Star Citizen, one server node controls each entity.
- **Ownership needs fencing.** A paused or partitioned owner can wake up and write after its lease is gone.
  The fix is a number that increases with each grant of ownership, checked by whatever accepts the write
  ([Kleppmann, *How to do distributed locking*,
  2016](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)). Ruina's `live_session`
  check in `write_island` is already this pattern, for one writer per character.
- **Wire ids.** Keep a global 64-bit id inside the server and give each connection short handles (u16)
  mapped on first sight, as the old battle protocol's u16 ids did (**inference**).

### 3.6 Persistence of Placed World State

| System | How | Note |
|---|---|---|
| EVE | One SQL Server database, a primary/standby pair with 4 TB of memory each | Scales up, not out |
| New World | DynamoDB, about 800,000 writes per 30 s | Writes from many hubs |
| Albion | Cassandra for game data, Postgres for accounts and market; handoff through the database | Cassandra lost buildings once; timestamps need NTP |
| Star Citizen | EntityGraph: every replicated entity in a graph database | Replicants restore from it |
| SpacetimeDB | State in memory, a commit log for recovery | Root and region databases |
| BigWorld | Cell entities backed up to base entities | Restored to another cell |
| Photon (prototype) | A persistence service caches live entities and flushes on a schedule | Simulations never write directly |

**Patterns** (**inference**):
- **Owner-keyed documents.** Ruina today: placed things live inside each character's island. A region
  server would have to load every resident's whole island to learn what stands in its chunks.
- **Location-keyed rows.** Placed things keyed by region and chunk. A server loads what is in its chunks,
  and the database enforces uniqueness (one claim per plot).
- **A ledger for transfers.** Coins and items moving between characters are written as one idempotent
  transaction in the store, never as two independent saves. Helland argues for atomic updates within one
  entity and idempotent messages between entities ([Helland, *Life beyond Distributed Transactions*, CIDR
  2007](https://www.cidrdb.org/cidr2007/papers/cidr07p15.pdf)). Ruina's pots already take this shape
  (`write_islands`).

### 3.7 Density

| Tool | Used by | What it costs |
|---|---|---|
| Layers: copies of the whole world or region | WoW Classic; Black Desert channels; Ruina's channels | Friends apart; hopping; events split |
| Shards: copies of a zone | WoW retail | The same, zone by zone; turned off on roleplay realms |
| Instanced maps with affinity | Guild Wars 2 megaserver | Loading screens; communities blur |
| Cross-realm zones | WoW | Need a pool of realms to merge |
| Caps and queues | New World, ArcheAge, PlanetSide 2 continent caps | Waiting; at a region border a queue breaks seamlessness |
| Slowing time | EVE | Real-time combat stops being real-time |
| Instancing | Dungeons; Star Citizen's 4.10 instances | Not the open world |

**Copies against persistent placed things.**
- **ArcheAge** keeps one world with contested land, where scarcity is the design.
- **WoW** puts housing in persistent instanced neighbourhoods of about 50 plots, made as needed.
- **Dune: Awakening** builds bases on per-server maps.

Ruina's channels (24 residents, 8 plots) are already neighbourhoods in that sense. **Inference:**
- A built thing that doesn't move (a house, a field) can show in every layer of its region, as long as the
  claim on its plot is global and anything that changes it (storage, harvest) goes to one owner.
- What moves (vehicles, packs, creatures, gathering nodes) belongs to one layer.

**Parties and friends.** Guild Wars 2 places players by affinity and lets them join a friend's copy. In WoW
Classic, accepting an invitation moves you to the inviter's layer. **Inference:** Ruina should forbid
changing layer while carrying a trade pack, in combat, or more than once in a few minutes. Otherwise a pack
carrier hops away from thieves, and gatherers re-roll nodes.

### 3.8 Keeping Ticks in Step Across Servers

- **Clocks.** Servers' clocks can agree to microseconds. AWS's time service has offered "microsecond-accurate
  time" on EC2 since November 2023 (at first on some instance types in one region), at "no additional charge" ([AWS,
  2023-11-16](https://aws.amazon.com/about-aws/whats-new/2023/11/amazon-time-sync-service-microsecond-accurate-time)).
  New World runs one world's machines at 30 Hz together (AWS 2022). Photon moves objects in flight between
  nodes "with their current time on a shared clock" (Photon 2026).
- **Tick numbers** (**inference**). Number ticks from a world epoch:
  `tick = floor((now_ms - epoch_ms) × 60 / 1000)`. Every server steps the same tick numbers, and every message
  carries its tick. Neighbours exchange ghost snapshots at tick boundaries (or a tick late, losing
  bit-exactness but not correctness). The engine stays clock-free: the tick is an input, as the world clock
  already is.
- **Avoid per-region slowdown.** EVE's time dilation is node-wide and drags unrelated systems. Dilating one
  region beside an undilated neighbour breaks the shared tick. Cap instead (**inference**).

### 3.9 Failure, Recovery, Orchestration and Cost

- **Recovery.**
  - BigWorld restarts failed processes (its Reviver) and restores lost cell entities from their bases.
  - Star Citizen keeps clients connected while a Replicant is rebuilt from EntityGraph "in less than a
    minute".
  - EVE takes daily downtime; an automatic reboot takes about two minutes (CCP 2023).
  - **Inference for Ruina:** snapshot each region's dynamic state every few seconds, and make
    economy-critical changes durable at once through the store. A crashed region then loses only a few
    seconds of movement and combat, never a trade.
- **Orchestration.** Agones runs fleets of dedicated game servers on Kubernetes
  ([Agones](https://github.com/googleforgames/agones)). Trion bought launch hardware outright, at "multiple
  millions" (2014). New World runs on AWS.
- **Cost.**
  - Railway charges $20 per vCPU-month, $10 per GB-month of RAM and $0.05 per GB of egress ([Railway
    pricing](https://docs.railway.com/reference/pricing)).
  - AWS internet egress steps from $0.09/GB down to $0.05/GB above 150 TB a month ([CloudZero summary of AWS
    list prices](https://www.cloudzero.com/blog/aws-egress-costs), *secondary*).
  - A Hetzner AX102 (16-core Ryzen 9 7950X3D, 128 GB) is €259 a month with unlimited traffic on a 1 Gbit/s
    port; the 10G option includes 20 TB, then €1/TB ([Hetzner](https://www.hetzner.com/dedicated-rootserver/ax102)).
  - OVHcloud's game servers include unmetered traffic outside Asia-Pacific ([OVHcloud](https://www.ovhcloud.com/en/lp/baremetal-game)).
  - Worlds Adrift shows the other cost: being unable to leave a platform.

---

## 4. Capacity Math

All figures here are **inference** from the numbers cited, unless marked measured. They are meant for
sizing, within about a factor of two, and should be checked with bots (R10.8).

### 4.1 One Simulation Process at 60 Hz with Action Combat

**Measured** (`scratch/stress-battlefield-before.json`, `scratch/bench.txt`, Apple M4):

| Load | Tick (20 Hz) | Per bot per tick | Per player-second | Per 60 Hz step |
|---|---|---|---|---|
| 1 player + 32 bots | 1.09 ms | 34 µs | 0.68 ms | 11 µs |
| 1 player + 64 bots | 2.43 ms | 38 µs | 0.76 ms | 13 µs |
| One player's rule step on the island (WebAssembly session) | n/a | n/a | n/a | 2-3 µs |

The rule step is cheap. The rest is bot brains, combat checks against everyone, building JSON, and the
quadratic parts: per-bot cost rose 12% when the bots doubled.

**Players per region process.** The limit is the 50 ms tick: plan to use half of it.

| Setup | Cost per player per tick | Players at 25 ms per tick |
|---|---|---|
| Today's code, one thread | 38 µs (measured) | about 650 |
| An interest grid instead of all-against-all, binary records packed once per tick | about 20 µs (estimate) | about 1,250 |
| The same, players stepped in parallel by cell on 8 cores at 70% efficiency | about 20 µs | about 7,000 of CPU, but bandwidth and clients run out first (4.2) |

**Anchors from shipped games:**

| Game | Players per unit of simulation | Tick | Source |
|---|---|---|---|
| EVE | Over 1,300 per node before dilation bites | about 1 Hz *(forum)* | CCP 2012 |
| New World | 2,500 players + 7,000 AI per world, on 7 × 36 vCPU | 30 Hz | AWS 2022 |
| Old School RuneScape | 2,000 + tens of thousands of NPCs per world | 0.6 s | Jagex 2025 |
| Albion | Up to 300 per cluster, single-threaded; about 190 concurrent players per core overall (15,000 over 80 cores) | event-driven | Salz 2016 |
| Star Citizen | 50 per game server (c. 2021); 500 per shard (4.0) | n/a | CIG Q&A; Star Citizen Tools |
| PlanetSide 2 | About 2,000 per continent (2012), later less | n/a | Engadget 2012 |
| Asheron's Call | 3,000 per server | n/a | Postmortem |

Ruina's rules are light: no rigid-body physics, simple colliders, a 2-3 µs step. So about **1,000 players
per region process** is a reasonable design target once R10.8 lands, and about 500 before it (**inference**).
Combat-heavy spikes (area effects over 50 targets, war-bands) can cost two to five times more per player, so
the soft cap needs headroom.

### 4.2 Bandwidth Per Client and What a Client Can Draw

**Today.** About 670 B of JSON per peer per update, 20 times a second, is 13 KB/s per visible peer.
- A channel of 24 players costs each client about 320 KB/s (2.6 Mbit/s).
- 64 bots cost **858 KB/s (6.9 Mbit/s)** (measured: 42.9 KB per update).

**Binary records** (**inference**, sized like the old battle protocol's 10 B near entries plus height and
state):

| Record | Size | Rate |
|---|---|---|
| Player, near (≤ 40 m), delta against last acknowledged | about 16 B (60 B on first sight) | 20 Hz |
| Creature, near | about 12 B | 20 Hz |
| Mid (40-120 m) | about 10 B | 5 Hz |
| Far (120-250 m), position only | about 6 B | 1 Hz |
| Packet overhead (WebSocket, TLS, TCP/IP) | about 70 B per message | 20 Hz, about 1.4 KB/s |

**Per client, downstream:**

| Scenario | Near | Mid | Far | KB/s |
|---|---|---|---|---|
| Wilderness | 10 players + 20 creatures | 20 | 30 | about 12 |
| Busy town | 80 | 300 | 600 | about 46 |
| World boss: 500 players within 50 m | 120 (capped) | 380 | none | about 62 (with combat events) |
| Siege: 1,000 players over 300 m, at the walls | 120 (capped) | 500 (capped) | 380 | about 70 |

A per-client budget of 64 KB/s (512 kbit/s) with priority accumulators covers every case, slowing the mid and
far tiers in the worst. **Upstream:** 60 inputs of 18 B a second, plus framing, is about 2.6 KB/s per player.

**Drawing.**
- **Measured.** 64 detailed peers ran at 58 fps on the M4 (95th-percentile frame 16.8 ms). The crowd renderer
  draws any number of one species in the same two draw calls (`tests/integration/species.spec.ts`).
- **Other games** cap the characters they draw: Final Fantasy XIV's "Character and Object Quantity" setting
  limits how many characters (and objects) are shown on screen ([Square Enix UI
  guide](https://na.finalfantasyxiv.com/uiguide/faq/faq-other/setting_ch_quantity.html)).
- **Budgets for Ruina** (**inference**):
  - 60-120 detailed characters (the made hero with IK), which is what the server's near cap feeds;
  - 1,000-2,000 crowd bodies;
  - dots or nothing beyond.

### 4.3 What 100,000 Players on One World Looks Like

**Spread** (**inference**):

| | Value |
|---|---|
| Peak concurrency | 100,000 |
| In instances (dungeons, housing neighbourhoods, tables, developer zones) | about 30%, 30,000 |
| In the open world | about 70%, 70,000 |
| Regions (Emberholm-sized: 2.36 km²) | 100, about 236 km² of land and sea (an archipelago about 15 km across) |
| Average per region | 700 (about 300 per km²) |
| Hub regions at peak | 3,000-5,000, so 3-5 layers of about 1,000 each, or more hubs |

**Peak density per region:**
- **A crowded town.** 30% of a 1,000-player region in a 0.1 km² town is 1 player per 330 m²: about 15
  players within 40 m and about 135 within 120 m.
- **A world boss.** 500 players within 50 m is 1 per 16 m², all of them near. Send each client the nearest
  120 at full rate, and aggregate damage numbers.
- **A siege.** 500 against 500 over 300 m is 1 per 90 m²: about 56 within 40 m and about 500 within 120 m.
  Those are averages; at the walls and gates it is denser. This is the one case that can need more than a region process: dynamic splitting, or a siege instance with
  a cap.

**Servers.**

| Tier | Count | Cores |
|---|---|---|
| Region processes (100 regions + about 40 extra layers at peak) | about 140 at about 2 cores | about 280 |
| Instance servers (about 6,000 dungeon copies of 5 players and their creatures, plus neighbourhoods) | pooled | about 100-200 |
| Gateways (about 10,000 connections each at about 25 KB/s) | 10-20 | about 80-160 |
| Directory, social services, store (Postgres, sharded by character later) | several | tens |
| **Total** | | **about 400-800 cores** |

**Database writes.** Today each island is saved every 5 s. At 100,000 that is 20,000 writes a second of
1-20 KB JSONB documents (a new island is 1.2 KB: `test-results/bug-reports/closed/*/save.json`), or 20-400
MB/s. Saving every 30-60 s and on events (trade, logout, handoff), only when changed, brings it to about
2,000-3,000 writes a second. Then shard by character id.

**Money** (rough; peak 100,000, monthly average taken as half of peak):

| Item | Railway list prices | AWS | Bare metal (Hetzner) |
|---|---|---|---|
| Egress: about 20 KB/s per player is 2 GB/s at peak (16 Gbit/s), about 2.6 PB a month | about $130,000 a month | about $134,000 a month (tiers above) | unmetered 1 Gbit/s ports: €0 extra; 10G option: about €2,600 |
| CPU and RAM, about 600 cores | about $25,000-50,000 a month (vCPUs and RAM at list price) | similar | about 38 × AX102 ≈ €10,000-12,000 a month |

On metered clouds the bill is mostly bandwidth. Everything that shrinks bytes per player (binary, deltas,
tiers, budgets) is worth more than any CPU saving, and the game servers belong where traffic is unmetered.

---

## 5. Staged Recommendation

### 5a. Build Now, During the Refactor (One Process)

The point is that every boundary a multi-process world needs exists in code now, crossed by in-process calls
and channels. Going multi-process then changes transports, not designs.

1. **Spaces and a world frame.**
   - Add a space to every position the server keeps: the overworld, or an instance. A saved position becomes
     `{space, x, y, z}`.
   - Give each dungeon and developer zone a frame of its own instead of a place in Emberholm's sky. A copy
     builds its own world from the zone file rather than adding pieces to the island's (`open/dungeon.rs`,
     `OpenWorld::make_dungeon`, `play/mod.rs` `ChannelGame::copy`, `src/engine/world/dungeons.ts`).
   - This retires the "within 760 m, apart from the others" rule in `docs/zones.md` and its engine checks.
   - The overworld frame is metres in f64, y up, origin at Emberholm's centre, so nothing on the island moves.
2. **Regions placed by data on a chunk grid.**
   - Each `content/zones/<id>.json` gains a placement in 256 m chunks. Emberholm is 6 × 6 chunks
     (-768 to +768 m).
   - A world map type holds the regions and a chunk → region table. `height`, `surface_at` and collider
     queries route through it, with open sea wherever no region stands.
   - `Life` takes the world map instead of one zone (`life/mod.rs` `Life::new`).
   - Content references gain ids that are unique across the world: gathering nodes by a stable id, not
     their index (`life/interact.rs`), and plot ids unique per world, checked by `contentc`.
   - Replace the production `emberholm()` calls (`spaces.rs`, `play/mod.rs`, `bots.rs`,
     `crates/engine/src/session.rs`, `crates/engine-wasm/src/lib.rs`). Tests may keep using Emberholm.
   - This is R10.1 (a zone as a content folder) and R10.2 (the server hosts any zone) in
     `.plans/refactor/tracker.md`, with placement added: build them with a world map in mind rather than
     one zone at a time.
3. **Two grids.**
   - 32 m interest cells, rebuilt each tick like the old `InterestGrid`.
   - 256 m authority chunks, with an ownership table (chunk → simulation) that has one entry today.
4. **Global ids.**
   - `EntityId(u64)`: a kind tag plus an id.
     - Characters keep their database id.
     - Placed things get ids from a database sequence when created; the island's `next_id` survives as a
       local alias.
     - Creatures get the content's spawn id plus a generation, or the simulation's id plus a counter.
   - On the wire, give each connection u16 handles, sent with the entity on first sight.
   - Retire `client(character) = character as u32`.
5. **Owner and epoch.**
   - Every simulated entity carries the simulation that owns it and an epoch.
   - Add a `region_leases` table (region, simulation, epoch, lease expiry), even with one simulation.
   - Generalise `characters.live_session` into an owner and epoch that every write checks, as
     `write_island` already does with `live_session`.
6. **The snapshot-and-events tick.** Make the rule explicit, test it, and extend it:
   - **The rule.** Within a tick, an entity reads only others' start-of-tick state, and changes others only
     through events applied at the start of the next tick.
   - **Already true for:** vehicles (`gather_movers`); player hits and heals (`player_hits`, `heals`); swings
     checked against history.
   - **Extend to:** hits on creatures (`swing_actors` applies at once today), slams, ride-alongs
     (`seat_passengers`) and the island's interactions between players.
   - **Payoffs:**
     - stepping order stops mattering, so players can be stepped in parallel (R10.8 plans `rayon`), with the
       same result as stepping them one by one;
     - a ghost is just a snapshot from elsewhere;
     - a test can run Emberholm as two simulations split at x = 0, in one process, and hold the result to the
       one-simulation run, bit for bit.
7. **Messages between the tiers.** A new crate (say `crates/world-api`, no I/O) holds the message types:
   - client in and out;
   - simulation in: inputs with sequence numbers, commands, ghost updates, remote events, handoff;
   - simulation out: entity records per cell, private state per player, saves;
   - store operations: fenced writes, ledger transfers.

   Then split `play/mod.rs` from `play/socket.rs` along those lines. Today `ChannelGame::send_tick` writes JSON
   straight into each member's `mpsc::Sender<String>`. Instead, a game publishes records per cell plus
   private state, and the connection layer builds each client's update. In one process these are tokio
   channels; later, the same enums cross the network.
8. **Binary snapshots with interest management** (this is R10.8, and the biggest single win).
   - Bring back the battle server's design from history (`git show 04da4b6:crates/server/src/battle/interest.rs`
     and `protocol.rs`): near, mid and far tiers; each record packed once per tick; `select_nth_unstable_by`
     caps.
   - Add deltas against the last acknowledged state, priority accumulators and a byte budget per client.
   - Positions go relative to a cell (i16 cm) or as i32 cm. The old i16 cm absolute positions covered only
     ±327 m.
9. **Placed things out of the island.**
   - `placed_objects`: world, space, chunk, kind, owner, epoch, data. It holds houses, fields, ships on
     slips, packs on the ground and parked vehicles.
   - `plots`: (world, plot) primary key → holder. The database enforces first come, instead of
     `Channel::recount_claims`.
   - `ledger`: idempotent transfers of coins and items between characters, generalising the joint writes for
     pots in `write_islands`.
   - The island document keeps what is private: bag, coins, quests, skills.
   - Save less often, and only when changed.
10. **A world clock.** Number ticks from a world epoch at 60 Hz, replacing each channel's counter from zero.
    The `view` the inputs carry becomes a world tick, and the engine still takes time as an input.
11. **A thread per game.** Replace the single `world` thread in `spawn_world` with one thread or task per
    game (channel, copy, later region), and take the `Spaces` lock only to move players. Cheap, and it frees
    the cores a process already has.
12. **Social state out of the game.** Move `Parties` (`play/parties.rs`) into a social module with its own
    state, keyed by character. Friends and chat go there later. Games ask it for affinity.
13. **On the client.**
    - Grow neighbouring regions in a Web Worker as the player nears a border (90-145 ms each).
    - Re-base the scene's origin per region, giving the world-space shaders (`ground.ts`, `water.ts`)
      region-relative positions.
    - Prefetch the next region's assets: the loader already loads by zone and nearest-first
      (`src/assets/catalog.ts`).
    - Unreal moved to 64-bit coordinates because 32-bit floats limited UE4 worlds to about 21 km ([Epic,
      Large World
      Coordinates](https://dev.epicgames.com/documentation/en-us/unreal-engine/large-world-coordinates-in-unreal-engine-5)).
      Ruina's rules are already f64; only the GPU side needs re-basing.

**What the single-process version looks like** (**inference**):

```
crates/engine       rules: the world map of regions, the snapshot-and-events tick, events (clock-free, f64)
crates/world-api    message types, ids, ticks, epochs (new; no I/O)
crates/server
  gate/       from play/socket.rs: connections, sign-in, wire handles, interest and budgets, binary encoding
  sim/        from play/mod.rs and spaces.rs: region and instance games, ghosts, handoff, ownership
  store/      from db.rs and the save queue: fenced writes, placed objects, plots, ledger
  social/     from play/parties.rs: parties, later friends and chat
  directory/  region → simulation leases (a table)
main.rs       starts all of them in one process, joined by tokio channels; later each is a role or binary
```

### 5b. The First Multi-Server Version

```
browser ─WS─▶ gateway ×N ──inputs──▶ region sim A ◀─ghosts, handoff, events─▶ region sim B
                 ▲    └──────────────▶ instance pool (dungeons, neighbourhoods, developer zones)
                 └──views (cell records)── sims          directory (leases, epochs) · store (Postgres) · social
```

1. **The world: an archipelago first** (**inference**). Regions are islands on one sea, with borders in open
   water. Emberholm already ends at sea, so no terrain stitching is needed. Borders are crossed by boats and
   gliders, rarely by crowds, and sea trade between islands suits Ruina's ArcheAge-style packs. Land borders
   (terrain matched along the edge) come later.
2. **The directory.** A coordinator assigns regions to simulation processes through `region_leases` (lease
   about 10 s, renewed about every 2 s, epoch bumped on every grant). A simulation that cannot renew stops
   simulating before its lease runs out.
3. **Gateways** terminate WebSocket and TLS and sign players in (`sessions`). They:
   - look up where the character is;
   - forward inputs with their sequence numbers to the owner, buffering during a handoff;
   - subscribe to the cells around each client, from both sides near a border;
   - map handles and apply byte budgets.
4. **Region simulations** own their chunks. They:
   - exchange ghosts within about 120 m of a border every tick;
   - hand off at 24-32 m past it;
   - move a vehicle with its passengers and cargo as one unit;
   - leash creatures inside the region;
   - send hit and heal events across borders, against ghost history for lag compensation.
5. **Instances** run in a pool of processes, entered by portal as today (`Spaces::enter_dungeon`), with
   players carried over through the gateway.
6. **The store.** Regions write their chunks' placed things and their players' private state, with epochs.
   Trades, purchases, payouts and pots go through the ledger.
7. **Density.** Each region has a soft cap of about 1,000. Above it, a layer (a copy of the region) opens,
   with players placed by party, guild and friends, Guild Wars 2 style. Placed things show in every layer of
   the region.
8. **Proving it.**
   - Bots (the engine's `bots.rs`, players without sockets) cross borders, fight across them and ride across
     them by the thousand.
   - The two-simulations-in-one-process test runs the same scenarios through real sockets.
   - Kill a simulation mid-handoff, replay a duplicated message, and partition a simulation from the
     directory, and check that nothing is duplicated or lost.
9. **Where it runs.** Two to four processes will fit Railway for a beta (a service per role). Plan bare metal
   with unmetered traffic, or Agones on Kubernetes over such machines, before player counts make egress the
   bill.

### 5c. Automatic Sharding and Density Copies: When Each Is Worth It

- **Layers per region: build them first** (proven, cheap, in the plan above). Triggers:
  - a region's peak regularly passes its soft cap;
  - or a launch is coming.

  Rules:
  - player-placed things are the same in every layer, and plot claims are global;
  - moving things belong to one layer;
  - layers merge when quiet, and on a merge a closing layer's packs and parked vehicles move across;
  - no layer change while carrying a pack, in combat, or more than once every few minutes.
- **Dynamic splitting of a region (pockets): build it only when all three hold.**
  1. There is content that cannot be layered, needs more than one process's worth of players in one space,
     and matters to the game: sieges, world bosses, contested land.
  2. Static borders and handoff have run in production for months, with their bugs found.
  3. Measurements show the region process's CPU is the limit, not each client's bandwidth or drawing.

  Then follow BigWorld:
  - a k-d tree over 256 m chunks inside a region;
  - boundaries that move gradually, with 10-30 m of hysteresis, checked about once a second;
  - spare processes kept warm;
  - never splitting below one or two chunks, and limiting handoffs per second.

  A capped siege instance is a cheaper alternative that may be enough (**inference**).
- **Never** (**inference**): slowing time per region, queues at region borders, or a platform you cannot
  self-host.

### 5d. Pitfalls

| Pitfall | How it bites | Guard |
|---|---|---|
| Duplication at handoff | The old owner keeps simulating, or saves, after giving an entity away; a crash between "sent" and "acknowledged" leaves two copies | Two-phase handoff with epochs; the store refuses stale epochs; items live only inside their entity's state and travel with it; tests that kill a process mid-handoff. New World's dupes and Star Citizen's universe resets show the cost |
| Transactions across servers | Two players on two servers trade; one side saves, the other crashes | No two-phase commit between simulations: transfers go through the store's ledger in one Postgres transaction with an idempotency key, as pots do today (Helland's entity-and-message model) |
| Split brain | A simulation cut off from the directory keeps going while its replacement starts | Leases plus fencing tokens (Kleppmann); a simulation that cannot renew stops; gateways accept views only from the current epoch's owner |
| Runaway cost | Egress at cloud prices; JSON; sending every peer; empty regions ticking; dynamic meshing's research | A binary, delta, interest-managed protocol with budgets; unmetered hosting; park empty regions (the world thread already skips games with no players and no tables); defer dynamic splitting |
| Vehicles at borders | Passengers left behind; jumps from extrapolation | Hand off the unit atomically; borders away from roads and docks; clip client extrapolation (Second Life) |
| Seams in terrain | Mismatched heights along a land border | Archipelago first; later, edge constraints shared between neighbouring recipes |
| Ids that collide | Per-island `next_id`, per-game creature ids and `as u32` all collide across servers | Global 64-bit ids, handles per connection |
| State that lives in one process | Parties, the `live` map of which connection plays whom, challenges and tables | Social services and the directory hold them |
| Database write load | 20,000 whole-document saves a second at 100,000 players | Event-driven, change-only saves; split private from placed; shard by character |
| GPU float precision | Shimmering ground far from the origin | Re-base the origin per region |

---

## 6. Decisions for You

1. **Archipelago or land borders first?** I recommend islands on one sea first (5b.1).
2. **Where houses and fields go:**
   - instanced neighbourhoods (WoW's way; Ruina's channels are already this shape);
   - plots in the shared open world (ArcheAge's way: scarce, so needing upkeep and turnover);
   - or both.

   At 100,000 players, open-world plots for everyone would need hundreds of square kilometres (**inference**).
3. **Crowded places:** layers (copies), more hubs, or caps? Copies are the proven answer; caps with queues at
   region borders break seamlessness.
4. **Where it runs at scale:** Railway is simple, but bandwidth at $0.05/GB dominates. Bare metal with
   unmetered traffic is far cheaper, but it is hardware to run yourselves.
5. **PvP across borders and in layers:** whether to allow it changes how strict handoff and layer-hopping
   rules must be.

---

## Sources

**Games and products**
- CCP: [Tranquility Tech IV (2023)](https://www.eveonline.com/news/view/tranquility-tech-iv); [Introducing Time Dilation (2011)](https://eveonline.com/article/introducing-time-dilation-tidi); [Time Dilation, How's That Going? (2012)](https://www.eveonline.com/news/view/time-dilation-hows-that-going); [Fleet Fight Notification Tool](https://www.eveonline.com/news/view/fleet-fight-notification-tool); [The Second Timer in M2-XFE (2021)](https://www.eveonline.com/news/view/the-second-timer-in-m2-xfe); [EVE University: Time Dilation](https://wiki.eveuniversity.org/Time_Dilation); [65,303 record thread](https://forums-archive.eveonline.com/topic/210628/) *(forum)*
- Blizzard: [Realm Layering Update (Kaivax, 2019)](https://eu.forums.blizzard.com/en/wow/t/92241/1); [Building in Azeroth: A First Look at Housing (2025)](https://news.blizzard.com/en-us/article/24176592/building-in-azeroth-a-first-look-at-housing); [Warcraft Wiki: Layering](https://warcraft.wiki.gg/wiki/Layering); [Warcraft Wiki: Housing](https://warcraft.wiki.gg/wiki/Housing); [Icy Veins: Neighborhoods](https://www.icy-veins.com/wow/news/player-housing-neighborhoods-explained/); [Engadget: CRZ (2012)](https://www.engadget.com/2012-05-10-world-of-warcraft-unveils-cross-realm-zones.html); [Engadget: CRZ clarified (2012)](https://www.engadget.com/2012/09/24/blizzard-clarifies-cross-realm-zones/); [Mein-MMO: sharding on RP realms](https://mein-mmo.de/en/sharding-auf-rp-realms-in-wow-deaktiviert,169943); [HowStuffWorks: WoW servers](https://electronics.howstuffworks.com/world-of-warcraft5.htm)
- ArenaNet: [Introducing the Megaserver System (2014)](https://www.guildwars2.com/en/news/introducing-the-megaserver-system/); [GW2 wiki: Megaserver](https://wiki.guildwars2.com/wiki/Megaserver)
- Amazon: [AWS, The Unique Architecture behind New World (2022)](https://aws.amazon.com/blogs/gametech/the-unique-architecture-behind-amazon-games-seamless-mmo-new-world); [PC Gamer: queues (2021)](https://www.pcgamer.com/new-world-server-queue/); [PC Gamer: wealth transfers off (2021)](https://www.pcgamer.com/amazon-disables-new-world-wealth-transfers-to-fight-gold-dupe-exploit)
- ArcheAge: [Massively interview with Scott Hartsman (2014)](https://www.engadget.com/2014-09-22-massively-interviews-trions-scott-hartsman-on-archeages-rocky.html); [Engadget: Auroria (2014)](https://www.engadget.com/2014-11-07-lost-continent-its-getting-harder-to-like-archeage.html); [Scan: a new kind of MMO](https://www.scan.co.uk/info/guide/archeage-new-mmo)
- Black Desert: [Mein-MMO: server structure (2016)](https://mein-mmo.de/en/black-desert-serverstruktur,68103/)
- Albion: [Salz, Software Architecture of an MMO (Quo Vadis 2016)](https://www.slideshare.net/slideshow/albion-online-software-architecture-of-an-mmo-talk-at-quo-vadis-2016-berlin/62724504); [Unity: Architecting Albion Online (2026)](https://unity.com/blog/albion-online-cross-platform-pvp-mmo-architecture)
- PlanetSide 2: [Engadget: Esamir (2012)](https://www.engadget.com/2012-10-04-soe-announces-esamir-planetside-2s-new-cold-continent.html); [Guinness World Records (2015)](https://www.guinnessworldrecords.com/news/2015/1/planetside-2-gamers-aiming-for-fps-battle-world-record-this-weekend-370414); [AnandTech forums](https://forums.anandtech.com/threads/planetside-2-set-to-break-world-fps-record-tonight-24-01-15.2418146/post-37109211) *(forum)*; [Reddit, 2022](https://lr.in.psf.lt/r/Planetside/comments/z1zypt/server_latency_issues/ixeadgb/?context=3) *(forum)*
- Asheron's Call: [Classic Postmortem (Game Developer, April 2000)](https://www.gamedeveloper.com/design/classic-postmortem-i-asheron-s-call-i-)
- Star Citizen: [Server Meshing and Persistent Streaming Q&A (c. 2021)](https://robertsspaceindustries.com/comm-link/transmission/18397-Server-Meshing-And-Persistent-Streaming-Q-A) ([mirror](https://api.star-citizen.wiki/comm-links/18397)); [Letter from the Chairman (2026-08-27)](https://starcitizen.tools/Comm-Link:Letter_from_the_Chairman_-_2026-08-27); [Star Citizen Tools: Server meshing](https://starcitizen.tools/Server_meshing); [Star Citizen Tools: Replication layer](https://starcitizen.tools/Replication_layer); [PC Gamer: reset over duplication](https://pcgamer.com/games/sim/star-citizens-latest-alpha-update-brings-a-full-reset-to-its-universe-as-cloud-imperium-games-promises-to-crack-down-on-player-exploits-and-duplication-issues)
- SpatialOS and Improbable: [SpatialOS docs 13.6, authority (offline)](https://docs.improbable.io/reference/13.6/shared/design/understanding-access); [Patent US10303821](https://patentimages.storage.googleapis.com/c8/38/c9/ca74f4265696f4/US10303821.pdf); [Worlds Adrift closing (2019)](https://www.pcgamesinsider.biz/news/69078/bossas-ambitious-spatialos-powered-worlds-adrift-is-shutting-down-in-july/); [Bossa doesn't blame Improbable](https://www.pcgamesinsider.biz/news/69671/bossa-doesnt-blame-improbable-for-worlds-adrifts-cancellation/); [MCV: Unity blocks SpatialOS (2019)](https://mcvuk.com/development/unity-blocks-improbables-spatial-os-all-live-and-in-development-games-affected); [Wikipedia: Improbable](https://en.wikipedia.org/wiki/Improbable_(company)); [Crowdfund Insider: MSquared and Morpheus (2022)](https://www.crowdfundinsider.com/2022/04/189592-improbable-secures-150m-to-launch-m%C2%B2-msquared-a-metaverse-network-ecosystem-supported-by-its-morpheus-tech/)
- Dual Universe: [MMOs.com (2016)](https://mmos.com/news/novaquark-explains-how-dual-universes-server-works); [Baillie (2019)](https://medium.com/@jcbaillie/dual-universe-redefines-the-meaning-of-massively-multiplayer-with-over-30-000-a04c0e8b4106); [Wikipedia](https://en.wikipedia.org/wiki/Dual_Universe)
- BitCraft and SpacetimeDB: [Ok, but does it scale? (Cloutier, 2026)](https://spacetimedb.com/blog/how-does-spacetime-scale); [What is SpacetimeDB](https://spacetimedb.com/docs/intro/what-is-spacetimedb); [BitCraft patch notes (2025)](https://bitcraftonline.com/news/patch-notes-alpha-3-to-steam-early-access-release); [BitCraftPublic](https://github.com/clockworklabs/BitCraftPublic)
- Ashes of Creation: [Mein-MMO on the 2024 stream](https://mein-mmo.de/en/a-new-mmorpg-claims-it-has-achieved-the-breakthrough-that-star-citizen-dreams-of-will-change-mmos-forever,1147602/); [Wikipedia](https://en.wikipedia.org/wiki/Ashes_of_Creation)
- Hadean: [CCP: EVE Aether Wars (2019)](https://fenris.com/news/2019/eve-aether-wars-successfully-achieves-groundbreaking-14-000-ship-battle)
- Others: [BigWorld Server Overview ch. 4](https://howarduong.github.io/github.io/doc/html/server_overview/ch04.html) and [ch. 5](https://howarduong.github.io/github.io/doc/html/server_overview/ch05.html); [Nagle, Region crossings in Second Life (2018)](https://github.com/John-Nagle/lslutils/blob/master/regioncrossing.md); [Jagex, More Worlds, More Power (2025)](https://oldschool.runescape.wiki/w/Update:More_Worlds,_More_Power:_The_Road_To_Greater_Capacity); [PCGamesN: Dune: Awakening servers](https://www.pcgamesn.com/dune-awakening/server-queues); [Epic: Multi-Server Replication](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Plugins/MultiServerReplication); [Epic: Large World Coordinates](https://dev.epicgames.com/documentation/en-us/unreal-engine/large-world-coordinates-in-unreal-engine-5); [Photon MMO backend (2026)](https://blog.photonengine.com/building-a-seamless-mmo-backend-across-machines/); [Square Enix: character quantity setting](https://na.finalfantasyxiv.com/uiguide/faq/faq-other/setting_ch_quantity.html)

**Techniques**
- [Balan et al., Matrix (Middleware 2005)](https://doi.org/10.1007/11587552_20); [Boulanger, Kienzle and Verbrugge, interest management (NetGames 2006)](https://www.sable.mcgill.ca/~clump/papers/boulanger-06-comparing.pdf); [Bharambe et al., Donnybrook (SIGCOMM 2008)](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/donnybrook.pdf); [Fiedler, State Synchronization (2015)](https://gafferongames.com/post/state_synchronization/); [Fiedler, Snapshot Compression (2015)](https://gafferongames.com/post/snapshot_compression/); [Kleppmann, How to do distributed locking (2016)](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html); [Helland, Life beyond Distributed Transactions (CIDR 2007)](https://www.cidrdb.org/cidr2007/papers/cidr07p15.pdf)

**Hosting and cost**
- [AWS Time Sync, microsecond accuracy (2023)](https://aws.amazon.com/about-aws/whats-new/2023/11/amazon-time-sync-service-microsecond-accurate-time); [Agones](https://github.com/googleforgames/agones); [Railway pricing](https://docs.railway.com/reference/pricing); [CloudZero: AWS egress](https://www.cloudzero.com/blog/aws-egress-costs); [Hetzner AX102](https://www.hetzner.com/dedicated-rootserver/ax102); [OVHcloud game servers](https://www.ovhcloud.com/en/lp/baremetal-game)

**Ruina** (this repository)
- `crates/server/src/play/{mod,socket,spaces,channels,parties,bots}.rs`, `crates/server/src/gate/encode.rs`, `crates/server/migrations/`, `crates/engine/src/open/{zone,mod,dungeon}.rs`, `crates/engine/src/life/{mod,state,interact}.rs`, `crates/engine/src/actors.rs`, `docs/zones.md`, `.plans/refactor/tracker.md` (R8.6, R10.8), `scratch/stress-battlefield-before.json`, `scratch/bench.txt`, `shared/tuning.json`, `shared/vehicles.json`, git history `04da4b6` (the old battle server's interest grid and protocol).
