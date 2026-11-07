# crates/world-api

The messages between the server's tiers (`crates/server`: gate, sim, store, social, directory),
and the ids, ticks and epochs they carry. Types and pure functions only: no clocks, threads,
sockets or databases. The plan behind it is `.plans/world/research.md` (3.2 to 3.5, 5a, 5b) and
`.plans/refactor/finish.md`.

| Module | What |
|---|---|
| `ids.rs` | `EntityId` (the engine's: a kind and a number), `CharacterId`, `SessionId`, `SimId`, `GateId`, `PartyId`, `Epoch`, `Conn` (gate, character, session), `SpaceId` (`channel:<region>:<n>`, `copy:<instance>:<n>`), `Owner` (a copy's: a party, someone alone, everyone) |
| `post.rs` | `Address` (a sim, a gate, the store, social, the directory), `Message` (any tier's), `Envelope`, `Reply` and `Answer` (questions one tier asks another), and the `Transport` trait every tier sends through |
| `input.rs` | What a browser's input bytes mean (`Input`, `actions_from`, `open_actions_from`) |
| `records.rs` | A simulation's tick as data for the gates: `TickOut`, records by 32 m `Cell` (players' presence, creatures, arrows, meteors, effects, tables) and `Private` state per player (`You`, `PlayerState`, `LifeView`, life events, effects about them), `Stats` |
| `sim.rs` | `ToSim`: arrivals, departures, inputs, what a player asks (`Ask`), the directory's routes, transfers between simulations (`Moving`, `Carried`: a player and their life, serializable), parties, owners, residents, saving everyone, leases |
| `gate.rs` | `ToGate` (for a connection, a tick, an answer) and `ToConn` (the way in, where inputs go now, and everything a browser is told); `SpaceView`, `Estates`, `Claimed` |
| `store.rs` | `ToStore`: lives read and written (`LifeWrite`, fenced by its `Epoch`; several in one transaction), builds, a channel's residents |
| `social.rs` | `ToSocial`: parties from connections, who's online and where from the directory; the party and invitation views |
| `directory.rs` | `ToDirectory`: claims and releases, routes between spaces (`Destination`, `Grant`), occupancy, parties' copies, leases (`Lease`), saving everyone |

## Rules

- **Every message is `Serialize + Deserialize`** and addressed. In one process the server's tiers
  pass the values themselves over tokio channels (`crates/server/src/post.rs`, which implements
  `Transport`); a transport between processes carries `Envelope`s. A message that holds a live
  value (`Carried`: a player and their life) serializes as its state and is made again on arrival.
- **No `Instant`s**: a time that crosses tiers is `Millis` (wall clock, ms since 1970) or a `Tick`.
- **Ids, not places in lists**, except where the wire to the browser already uses them (a creature's
  kind, a weapon, a skill: the bundle's order, checked by the content's hash).
- **Shapes stay stable**: other workstreams build on them (borders, channels, the multi-server
  version). Add variants and fields; change existing ones only with a note in the report
  (`.plans/refactor/reports/tiers.md`).
- **Field names that reach the browser are its own** (camelCase): the JSON a gate sends is the
  records' serialization, so a record and what the browser reads can't drift apart.

## Tests

`cargo test -p ruina-world-api`: spaces written and read as keys, envelopes through text and back,
input bytes read as the browser packs them, a player and their life carried through text whole.
