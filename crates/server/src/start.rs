//! The server's tiers, started in one process: the post they send their messages through, the
//! store, the social tier, the directory (which starts each simulation on a thread of its own as
//! its space is first needed) and a gate. Each is a task of its own (the simulations threads), and
//! none reaches into another: they only send each other messages (crates/world-api).

use std::sync::Arc;
use std::time::Duration;

use ruina_world_api::GateId;

use crate::directory::leases::MemoryLeases;
use crate::directory::{COPY_KEPT, Directory, EXPEL_AFTER};
use crate::gate::Gate;
use crate::post::Post;
use crate::sim::Threads;
use crate::social::Social;
use crate::store::{self, Db};

/// The tiers of a running server.
pub struct Tiers {
    pub post: Arc<Post>,
    pub gate: Arc<Gate>,
}

/// Starts every tier, on `db` (Postgres, or memory for the tests). Needs a tokio runtime.
pub fn start(db: Db) -> Tiers {
    start_with(db, COPY_KEPT, EXPEL_AFTER)
}

/// The same, keeping copies of instances `copy_kept` once empty and letting whoever doesn't belong
/// in one stay `expel_after` (the tests shorten both).
pub fn start_with(db: Db, copy_kept: Duration, expel_after: Duration) -> Tiers {
    let post = Post::new();
    store::spawn(db.clone(), post.clone(), post.open_store());
    Social::new(post.clone()).spawn(post.open_social());
    let mut directory = Directory::new(post.clone(), db, MemoryLeases::default(), Arc::new(Threads { post: post.clone() }));
    directory.copy_kept = copy_kept;
    directory.expel_after = expel_after;
    directory.spawn(post.open_directory());
    let gate = Gate::start(GateId(1), post.clone(), post.open_gate(GateId(1)));
    Tiers { post, gate }
}
