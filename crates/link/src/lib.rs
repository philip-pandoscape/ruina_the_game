//! Links between Ruina's server processes. When the world runs on several processes (a gate, sims,
//! the shared services: `docs/architecture.md`), they send each other the same serde messages their
//! tiers pass in one process, over TCP.
//!
//! - A **node** is one process's end of all its links (`Node::start`): it listens for links in,
//!   dials links out, and hands what arrives to its inbox (`Inbox`).
//! - A **link** is the way to one peer (`Node::link`). What's sent on it arrives once and in the
//!   order it was sent, across lost connections: each message is numbered, the sender keeps what
//!   the peer hasn't acknowledged and writes it again on the next connection, and the peer drops
//!   whatever it delivered already. On the wire that's at least once; to the inbox, once.
//! - A **restarted peer** (a new incarnation) is sent what it never acknowledged: at least once
//!   across a crash. Every message has an id (`MsgId`: the sender's incarnation and its number),
//!   the same each time, for what must stay idempotent across the receiver's own restart (the
//!   store's writes carry epochs and keys for that).
//! - **Back-pressure.** A link holds at most `window` messages unacknowledged: `send` waits for
//!   room, `try_send` says it's full. `push` never waits (world-api's `Transport`), up to `limit`.
//!   A full inbox stops its links being read, which fills their senders' windows.
//! - **Requests**: `Link::request` sends a message and waits for its answer (`Node::reply`).
//! - **Faults**, for tests: a link can be cut and restored, its messages written twice, its
//!   acknowledgements lost (`Fault`). `proxy::Proxy` does the same from outside, between processes.
//! - **The world's post** (`post`): world-api's `Transport` over links, each address at the node
//!   the directory says takes it.
//!
//! The frames are in `frame.rs`; how bodies are written (MessagePack with field names, measured
//! against JSON) in `codec.rs`. The numbers: `tests/numbers.rs`.

mod codec;
mod fault;
mod frame;
mod inbound;
mod node;
mod out;
pub mod post;
pub mod proxy;

use std::time::Duration;

pub use codec::{CodecError, Encoding};
pub use fault::Fault;
pub use node::{Envelope, Event, Inbox, Message, MsgId, Node, NodeStats};
pub use out::{Link, LinkStats, SendError};

/// How a node's links behave. The defaults suit the world's processes on one network.
#[derive(Clone, Debug)]
pub struct Config {
    /// What the node's messages are, and their version: a peer speaking another protocol (or the
    /// same in another encoding) is refused, so processes built from different messages never
    /// misread each other. World-api's post speaks `post::PROTOCOL`.
    pub protocol: String,
    /// How bodies are written.
    pub encoding: Encoding,
    /// Where other nodes dial this one, if not the address it listens on (behind a proxy, or by a
    /// name on a private network).
    pub advertise: Option<String>,
    /// Messages a link holds unacknowledged before `send` waits and `try_send` refuses.
    pub window: usize,
    /// Messages a link holds unacknowledged before `push`, which never waits, refuses: a peer this
    /// far behind is as good as gone.
    pub limit: usize,
    /// Messages the inbox holds before links stop being read.
    pub inbox: usize,
    /// The biggest frame, either way.
    pub max_frame: usize,
    /// A link with nothing to write pings this often (and is answered), so a dead connection is
    /// noticed even when quiet.
    pub heartbeat: Duration,
    /// A connection that has heard nothing for this long is given up on and dialled again.
    pub dead_after: Duration,
    /// How long a dial and its handshake may take.
    pub handshake: Duration,
    /// The wait before dialling again after a failure: the first, doubling to the longest.
    pub backoff: (Duration, Duration),
    /// A receiver acknowledges at least every this many messages, and whenever it has taken
    /// everything that has arrived.
    pub ack_every: u64,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            protocol: "ruina".into(),
            encoding: Encoding::default(),
            advertise: None,
            window: 4096,
            limit: 65536,
            inbox: 4096,
            max_frame: 16 << 20,
            heartbeat: Duration::from_secs(1),
            dead_after: Duration::from_secs(10),
            handshake: Duration::from_secs(5),
            backoff: (Duration::from_millis(50), Duration::from_secs(2)),
            ack_every: 256,
        }
    }
}

impl Config {
    /// The defaults, speaking `protocol`.
    pub fn speaking(protocol: &str) -> Config {
        Config { protocol: protocol.into(), ..Config::default() }
    }
}

/// Resolves once what `rx` watches satisfies `f` (or its sender is gone). Unlike `wait_for`, it
/// holds no lock on the value when it resolves, so a `select!` over it can be sent between threads.
pub(crate) async fn until<T>(rx: &mut tokio::sync::watch::Receiver<T>, f: impl FnMut(&T) -> bool) {
    let _ = rx.wait_for(f).await;
}
