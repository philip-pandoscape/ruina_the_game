# crates/world-api

The messages between the server's tiers (`crates/server`: gate, sim, store, social, directory),
and the ids, ticks and epochs they carry. Types and pure functions only: no clocks, threads,
sockets or databases. The plan behind it is `.plans/world/research.md` (3.2 to 3.5, 5a, 5b) and
`.plans/refactor/finish.md`; how the server uses it, `crates/server/AGENTS.md`.

| Module | What |
|---|---|
| `ids.rs` | `EntityId` (the engine's: a kind and a number), `CharacterId`, `SessionId`, `SimId`, `GateId`, `PartyId`, `Epoch`, `Millis`, `Conn` (gate, character, session), `SpaceId` (`channel:<region>:<n>`, `copy:<instance>:<n>`), `Owner` (a copy's: a party, someone alone, everyone) |
| `post.rs` | `Address` (a sim, a gate, the store, social, the directory), `Message` (any tier's), `Envelope`, `Reply` and `Answer` (questions one tier asks another), and the `Transport` every tier sends through: `send` hands a message back when nothing is there to take it (`transfer` gives back the player it carried), with typed helpers (`sim`, `gate`, `conn`, `store`, `social`, `directory`, `answer`) |
| `input.rs` | What a browser's input bytes mean (`Input`, `actions_from`, `open_actions_from`) |
| `records.rs` | A simulation's tick as data for the gates: `TickOut` (its simulation, its lease's epoch, its space and tick), records by 32 m `Cell` (players' presence, creatures, arrows, meteors, effects, tables: the JSON path's, which the wire's packed cells replace) and `Private` state per player (`You`, `PlayerState`, `LifeView`, life events, effects about them), `Stats` |
| `sim.rs` | `ToSim`: arrivals, departures, inputs and what a player asks (`Ask`) from a connection, the directory's routes, transfers between simulations (`Moving`, `Carried`: a player and their life, serializable as their state), parties and a copy's owner in one message, residents, saving everyone, leases |
| `gate.rs` | `ToGate` (for a connection, a tick, an answer) and `ToConn` (the way in, where inputs go now, and everything a browser is told); `SpaceView`, `Estates`, `Claimed` |
| `store.rs` | `ToStore`: lives read and written (`LifeWrite`: fenced by its character's `Epoch`, naming its `Writer`'s lease; several in one transaction), builds, a channel's residents |
| `social.rs` | `ToSocial`: parties from connections, who's online and where from the directory; the party and invitation views |
| `directory.rs` | `ToDirectory`: claims and releases, routes between spaces (`Destination`, `Grant`), occupancy, parties and the copies they own, saving everyone; `Lease` (a space, its simulation, its epoch, until when, its chunks) |

## Rules

- **Every message is `Serialize + Deserialize`** and addressed. In one process the server's tiers
  pass the values themselves over channels (`crates/server/src/post.rs`, which implements
  `Transport`); a transport between processes carries `Envelope`s. A message that holds a live
  value (`Carried`: a player and their life) serializes as its state and is made again on arrival.
  Its JSON is self-describing (`serde_json::Value` inside some), so a codec between processes is a
  self-describing one (JSON, MessagePack with names).
- **No `Instant`s**: a time that crosses tiers is `Millis` (wall clock, ms since 1970) or a `Tick`.
- **Ids, not places in lists**, except where the wire to the browser already uses them (a creature's
  kind, a weapon, a skill: the bundle's order, checked by the content's hash).
- **Shapes stay stable**: other workstreams build on them (borders, channels, land, the wire, the
  multi-server version). Add variants and fields; change existing ones only with a note in the
  report (`.plans/refactor/reports/tiers.md`).
- **Field names that reach the browser are its own** (camelCase): the JSON a gate sends is the
  records' serialization, so a record and what the browser reads can't drift apart.

## Tests

`cargo test -p ruina-world-api`: spaces written and read as keys, envelopes through text and back,
input bytes read as the browser packs them, a player and their life carried through text whole,
a space as the browser reads it.
