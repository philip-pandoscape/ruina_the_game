# crates/link

Links between the server's processes, for when the world runs on several (a gate, sims, the shared
services: `docs/architecture.md`, Where It's Going). Serde messages over TCP: each arrives once, in
the order it was sent, across lost connections; a restarted peer is sent what it never
acknowledged. World-api's `Transport` is carried over it (`post.rs`). In one process the tiers pass
messages over tokio channels and this crate isn't used.

| Module | What |
|---|---|
| `node.rs` | A node: one process's end of every link. Listens, dials, hands what arrives to its `Inbox`; answers requests (`reply`); `Event`s for links coming up, going down, peers restarting, refusals |
| `out.rs` | A link out (`Link`): messages numbered and kept until acknowledged, the connection dialled and dialled again with backoff, everything unacknowledged written again on each new one. `send` waits for room in the window, `try_send` refuses, `push` never waits (up to `limit`); `request` waits for an answer |
| `inbound.rs` | A link in: the handshake, then each message delivered if it's next in turn, dropped if delivered already; acknowledgements in batches |
| `frame.rs` | The frames on the wire (hello, welcome, message, ack, ping, refuse), and reading them off a stream into one buffer |
| `codec.rs` | A body's encoding: MessagePack with field names (the default) or JSON, both self-describing, as world-api's messages need |
| `fault.rs` | Cutting a link, writing its messages twice, losing its acknowledgements: for tests |
| `proxy.rs` | A TCP proxy for tests between processes: cut, restore, and every n-th message written twice |
| `post.rs` | World-api's `Transport` over links (`LinkPost`): each address at the node the directory says (`Book`), and `deliver`, handing what arrives to the process's own post |

## Rules

- **Once and in order, per link.** Messages are numbered per link (from 1, per start of the
  sender). The receiver keeps, per peer, which start of it and the last number delivered, and the
  sender writes again from there on every new connection. Two connections from one peer (an old
  one not yet noticed dead, and its replacement) deliver under one lock, so never out of turn.
- **At least once across restarts.** A receiver's new start is sent everything the old never
  acknowledged. Whatever must happen once across that (a ledger transfer, a write) is keyed by the
  message's `MsgId` or carries its own key and epoch; the store's writes are fenced by epochs.
- **Self-describing bodies.** World-api's messages hold `serde_json::Value`s, internally tagged
  enums and fields skipped when empty, which a format without field names (postcard, bincode)
  misreads. Keep bodies MessagePack (named) or JSON; `Encoding::round_trip` holds a message type
  to crossing whole.
- **Both ends agree.** The handshake carries the protocol and encoding (`Config::protocol`,
  `post::PROTOCOL`); a peer speaking another is refused. Raise `post::PROTOCOL` when world-api's
  messages change in a way an older process can't read.
- **Nothing blocks a tick.** A simulation's thread sends with `push` (world-api's
  `Transport::send`), which never waits; `backlog` says when a peer is behind.

## Tests

`cargo test -p ruina-link`: frames, the codecs (values, tags, skipped fields, infinities), and over
real sockets on this machine (`crates/link/tests/link.rs`): thousands of messages once and in
order; a thread outside tokio making links and sending; requests both ways; ten cuts mid-stream
with nothing lost or repeated; every message written twice and taken once; lost acknowledgements
sent again and dropped; a full window holding the sender back; a restarted receiver sent what it
never acknowledged; a restarted sender numbering afresh; refusals; world-api's messages through
`LinkPost`. The numbers (codecs on world-api's messages, throughput, latency): `cargo test
--release -p ruina-link --test numbers -- --ignored --nocapture --test-threads=1`. Between
processes: `crates/server/tests/cluster.rs`.
