# crates/wire

The wire for crowds (R10.8): what a browser hears of the world around it, and how. A sim packs each
entity's record once a tick into the 32 m cell it stands in; the gate keeps a `Viewer` for each
connection and writes that connection's update from the cells around its player, nearest and most
overdue first, as deltas against what the browser acknowledged, within a byte budget; the browser
applies the updates in order and acknowledges each. No I/O, clocks or threads: the gate sends the
bytes. The browser's side is `src/net/wire/` (TypeScript), held to this crate by golden fixtures.

| File | What |
|---|---|
| `schema.rs` | Each kind's fields in wire order, the tier that still refreshes each, how each runs on by itself (`Run`) |
| `record.rs` | A `Record` (key, owner, introduction, fields, what it names), an `Event`, a cell's `CellRecords` (packed into bytes to cross between processes) and a tick's `Frame` of them |
| `pack.rs` | The engine's players, creatures, vehicles, packs on the ground, arrows, meteors and effects as records (the default `engine` feature: a gate needs nothing of the engine's) |
| `interest.rs` | The tiers by distance, their rates and caps (`Tiers`, worked out with lists kept between ticks) |
| `viewer.rs` | A connection's side: handles, baselines, updates in flight, priorities, budget; `Viewer::update` writes an update, `Viewer::ack` takes an acknowledgement, `Viewer::lost` an update the gate couldn't send |
| `ack.rs` | The acknowledgement, both ways |
| `decode.rs`, `heard.rs` | Reading an update, and the browser's side in Rust (the tests and benches talk to a `Viewer` through it) |
| `bytes.rs`, `fast.rs` | Varints and zigzags; a quick hash for the server's own keys |

## Where Each Piece Runs

- **A sim**, once a tick: `pack::*` for each entity into a `Frame` (`Frame::push`, `Frame::event`),
  handed to the gates as its cells (`Frame::into_cells`; world-api's tick out carries them).
- **A gate**, once a tick for each connection: `Frame::from_cells` (and `add_cells` for another
  sim's, across a border), then `viewer.update(&frame, View { x, z }, &told)`: the bytes to send,
  where `told` is what happened to the connection's own player (its hits, hurts and heals). Each
  acknowledgement the browser sends goes to `viewer.ack(&Ack::read(bytes)?)`; an update the gate's
  queue dropped goes to `viewer.lost(seq)`. Going into another space: `viewer.reset()` after the
  JSON `space` message, as the browser forgets what it heard when it reads that message.
- **The browser**: `src/net/wire/feed.ts` (`WireFeed`) hears each update, acknowledges it, and turns
  what it heard into the feed's ticks (`src/net/feedTick.ts`).

Each connection's `Viewer` is independent and the `Frame` is shared read-only, so a gate can write
its connections' updates on as many threads as it has.

## The Protocol, Byte by Byte

Little-endian fixed widths; varints are LEB128 (seven bits a byte, the high bit set while more
follow); signed numbers are zigzagged first (0, -1, 1, -2 ... as 0, 1, 2, 3 ...): ids as 64-bit, a
field's change as 32-bit.

**An update** (server to browser, one binary WebSocket message a tick):

```text
u8   1                       an update
u32  seq                     the connection's update number, from 1
u32  tick                    the world's tick (crates/server's clock), its low 32 bits
varint n, then n × u16       handles gone (said in every update until one saying so is acknowledged)
varint n, then n × intro     handles new: u16 handle, u8 kind, the kind's own:
                               player    zigzag character id (a bot's is negative), u8 flags (1 a bot),
                                         varint length, the name's UTF-8 (255 bytes at most)
                               creature  zigzag creature id
                               vehicle   zigzag owner (character), zigzag id on their life,
                                         varint place in the vehicles then the mounts
                               item      zigzag owner, zigzag pack id, varint place in the packs
                               arrow     zigzag arrow id
                               meteor    zigzag meteor id
varint n, then n × record    u16 handle
                             u8  base: tier << 6 | back (0: whole, against zeros; 1..63: against
                                 the entity's state in update seq - back)
                             varint mask of the fields that changed (bit i: field i)
                             a zigzag varint per field in the mask: the change
varint n, then n × effect    varint mask, a zigzag varint per field in it (against zeros)
```

**An acknowledgement** (browser to server, after each update applied): `u8 8, u32 seq, u32 bits`:
the newest update applied, and bit i set if update seq - 1 - i was applied too. Inputs are 7.

**Kinds** (their byte), and their fields in order (`schema.rs` has the units and tiers):

| Kind | Fields |
|---|---|
| player (1) | x, z, y, facing, run, vx, vz, vy, mode, flags, attackIndex, attackFrame, castAbility, castFrame, actionId, actionFrame, flipFrame, landFrame, landImpact, takeoffFrame, stun, downFrame, hp, team, weapon, comboVariants, bank, crouchFrame, airspeed, glider, pack, vehicle, seat, host |
| creature (2) | x, z, y, facing, state, stateFrame, wait, hp, deadFrame, targetX, targetZ, kind |
| vehicle (3) | x, z, y, heading, pitch, roll, speed, steer, throttle, sail, flags, cargo0 .. cargo15 |
| item (4) | x, z, y, rot |
| arrow (5) | x, z, y, vx, vz, team, owner |
| meteor (6) | x, z, ticksLeft, fallTicks, team, radius |
| effect | x, z, y, kind (the engine's effect kind, its cause above the low four bits), size |

Every field is an i32: positions in centimetres (a creature's height above its own ground), turns
in 65536ths of a turn, speeds in centimetres a second, health in hundredths (a creature's in
ten-thousandths of its most), a place in one of the content's lists as its index (plus one where 0
means none: a glider, a carried pack, a cargo slot), a player's mode in the engine's order
(`MODES`). A field naming another entity (a player's host, an arrow's owner) is that entity's
handle on this connection as the update began: 0 nobody, 1 you.

**Reading a record:** for a field the record's tier refreshes, the value is its baseline's run on
by the ticks between (`Run::guess`: a frame counter counts on, three a tick, while it isn't -1) plus
its change (0 if it isn't in the mask); a field the tier doesn't refresh keeps its baseline's value.
A whole record (back 0) is every field, against zeros, whatever its tier.

## Why It's This Way

- **Interest by cells, tiers as rates.** Near (40 m) every tick, the nearest 120; mid (120 m) every
  fourth, 400; far (250 m) about once a second, 1000 (`interest.rs`). Each entity in sight adds its
  tier's rate to an accumulator every tick and is due at 1; due ones go nearest tier first, then
  most overdue, while the budget lasts, so a budget that runs short slows the furthest first and
  starves nobody (Fiedler's priority accumulators). The old battle server's three tiers on a 4 m
  grid (`git show 04da4b6:crates/server/src/battle/interest.rs`) were the start. Something in sight
  stays in sight 10 m past its kind's reach, and those over a cap are judged 5 m nearer than
  newcomers, so nothing flickers at an edge. Items, arrows and meteors only reach the middle
  distance; arrows and meteors always go at the near rate.
- **A tier refreshes some fields.** The far tier refreshes where something is, which way it faces,
  its side, its health and whether it's down; the middle one what a crowd body is drawn from; the
  near one everything. Beyond 40 m the browser draws players as crowd bodies
  (`src/render/open/peersView.ts`), which need nothing more.
- **Deltas against what was acknowledged, per entity.** A record is measured against the entity's
  state in the newest acknowledged update that held it, never against something on its way that
  might not arrive, so a lost update costs nothing but its own bytes (Fiedler's snapshot
  compression; Quake 3 measures a whole snapshot against one). Each record names its own baseline
  because, with priorities, an entity isn't in every update. The server keeps each update's records
  until acknowledged (`Flight`), about six at a 300 ms round trip; the browser keeps an entity's
  states from the oldest baseline the server could still use (the newest it has used: baselines
  only move on) to the newest, at most `WINDOW` (63) updates back.
- **Counters cost nothing while they run.** A swing's, a cast's, a fall's frame counter is measured
  against where it would have run to, so it's only in the mask when it starts, stops or skips. An
  entity whose fields only ran on as guessed, with nothing newer on its way, isn't written at all;
  the browser runs it on itself (`src/net/wire/feed.ts` runOn).
- **Handles.** A u16 per connection, given with an introduction (sent in every record until an
  update holding it is acknowledged); given to something else only once an update saying it's gone
  has been acknowledged, the freed longest ago first, with a generation so nothing still on its way
  for the old entity lands on the new one. Ids cross the wire only in introductions, never in records:
  `character as u32` is gone from here.
- **The budget.** 64 KB/s, at most two ticks' worth in hand: about what a busy town needs
  (research 4.2). Removals and effects always go; records share what's left; after 32 due records in a
  row that don't fit, the rest wait unwritten.
- **Applied whole and in order.** An update older than the newest applied is dropped and never
  acknowledged (it may name handles since given up), so the server counts it lost; one naming a
  baseline the browser doesn't have is broken and dropped the same way (`errors`, always 0 when both
  sides keep to the protocol). Over a WebSocket nothing arrives out of order, but an update the
  gate couldn't queue is lost, and a datagram transport later will lose and shuffle them.
- **What stays JSON**, in the tick message beside the updates: your own player (exact, to correct the
  prediction from; private), your life (rare, rich and private), mini-game tables (rare), notices,
  estates and claims, and the admins' numbers. The updates carry what's shared by many and changes
  every tick.
- **Cells between processes.** A cell serializes as one run of bytes (`CellRecords::pack`: keys and
  introductions as varints, fields whole), so MessagePack writes it as one blob; a creature alone in a
  cell is 14 bytes.

An alternative kept in mind: absolute values with change masks, resent when an update is lost
(Tribes, Unreal), which keeps nothing on the server per update; worth it if a gate's memory for
updates in flight grows too big.

## Measured

`cargo test --release -p ruina-wire --test bench -- --ignored --nocapture` (the engine's players
moved by a script; today's JSON beside it, field for field):

| In reach | JSON an update | The wire | Writing it |
|---|---|---|---|
| 33 players, 8 creatures, 80 m | 22.9 KB | 424 B | about 30 µs |
| 65, 8, 80 m | 44.0 KB | 780 B | about 50 µs |
| 1,025, 128, 300 m | 682 KB | 2.6 KB (the budget's) | about 120-160 µs |

One gate core writing every connection's update 20 times a second carries about 1,650-2,150
connections in a wilderness (6.8 KB/s each), 300 in a busy town (45.7 KB/s), 260-400 at a world boss
(61.8 KB/s).

## Changing the Protocol

A change to what's sent is made here and in `src/net/wire/` together: the schema in both
(`tests/unit/wire.test.ts` checks them field for field), then the fixtures written again
(`RUINA_GOLDEN=1 cargo test -p ruina-wire --test golden`, kept in `tests/fixtures/wire/`), which the
browser's side must then hear to the same states. Raise `WORLD_PROTOCOL` on both sides.

## Tests

- `cargo test -p ruina-wire`: the codec, tiers and caps, the cells' packing; `tests/protocol.rs`, a
  Viewer and a Heard over a road that loses, holds back and shuffles updates and acknowledgements,
  every state heard checked against the world that tick and everything near settling to it exactly
  (a crowd of 4000, the budget held with 2000 in reach, handles given again as everything leaves
  sight and comes back); `tests/golden.rs`, the fixtures.
- `tests/unit/wire.test.ts`, `tests/unit/wireFeed.test.ts`: the browser's side against the fixtures.
