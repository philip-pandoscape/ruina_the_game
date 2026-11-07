//! What a test can do to a link: cut it, write its messages twice, lose its acknowledgements. The
//! proof that nothing is lost or delivered twice (`tests/link.rs`, and the processes' harness in
//! `crates/server/tests/cluster.rs`, which does the same from outside with `proxy`).

use std::sync::Arc;

use tokio::sync::watch;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct FaultState {
    /// How many times the link has been cut: a connection made before the latest cut is dropped,
    /// however soon the link was restored.
    pub cuts: u64,
    /// Cut and not yet restored: no connection is made.
    pub held: bool,
    /// Every message is written twice.
    pub duplicate: bool,
    /// Acknowledgements are ignored, the handshake's too: everything since is sent again on the
    /// next connection, as if they had been lost on the way.
    pub lose_acks: bool,
}

/// A link's faults, for tests.
#[derive(Clone)]
pub struct Fault(pub(crate) Arc<watch::Sender<FaultState>>);

impl Fault {
    /// Drops the link's connection now; it isn't dialled again until `restore`.
    pub fn cut(&self) {
        self.0.send_modify(|f| {
            f.cuts += 1;
            f.held = true;
        });
    }

    pub fn restore(&self) {
        self.0.send_modify(|f| f.held = false);
    }

    /// Writes every message twice (the receiver must take each once).
    pub fn duplicate(&self, on: bool) {
        self.0.send_modify(|f| f.duplicate = on);
    }

    /// Ignores acknowledgements, so whatever is in flight is sent again after the next cut.
    pub fn lose_acks(&self, on: bool) {
        self.0.send_modify(|f| f.lose_acks = on);
    }
}
