//! The server's tiers, started: the post they send their messages through, the services (the store,
//! the social tier and the directory, which starts each simulation on a thread of its own as its
//! space is first needed) and a gate. Each is a task of its own (the simulations threads), and none
//! reaches into another: they only send each other messages (crates/world-api).
//!
//! One process runs them all (`start`, as Railway's beta does). A process playing one part of a
//! world among several picks its part here: the services (`services`), a gate (`gate`), or the
//! simulations the directory places with it (a `Spawner` over the link between processes, the
//! multi-server version's), with the post sending what isn't held here on through
//! `Post::set_remote`.

use std::sync::Arc;
use std::time::Duration;

use ruina_world_api::GateId;

use crate::directory::leases::{Leases, MemoryLeases};
use crate::directory::{COPY_KEPT, Directory, EXPEL_AFTER, Spawner};
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

/// Every tier in this process, on `db` (Postgres, or memory for the tests). Needs a tokio runtime.
pub fn start(db: Db) -> Tiers {
    start_with(db, COPY_KEPT, EXPEL_AFTER)
}

/// The same, keeping copies of instances `copy_kept` once empty and letting whoever doesn't belong
/// in one stay `expel_after` (the tests shorten both).
pub fn start_with(db: Db, copy_kept: Duration, expel_after: Duration) -> Tiers {
    let post = Post::new();
    let sims: Arc<dyn Spawner> = Arc::new(Threads { post: post.clone() });
    services(&post, db, sims, copy_kept, expel_after);
    let gate = gate(&post, GateId(1));
    Tiers { post, gate }
}

/// The services: the store, the social tier and the directory, which starts simulations through
/// `sims` (on threads here, or wherever a world of several processes places them).
pub fn services(post: &Arc<Post>, db: Db, sims: Arc<dyn Spawner>, copy_kept: Duration, expel_after: Duration) {
    services_with(post, db, sims, MemoryLeases::default(), copy_kept, expel_after);
}

/// The same, the leases kept in `leases` (Postgres, where several processes share the world:
/// crates/server/src/cluster).
pub fn services_with<L: Leases>(post: &Arc<Post>, db: Db, sims: Arc<dyn Spawner>, leases: L, copy_kept: Duration, expel_after: Duration) {
    store::spawn(db.clone(), post.clone(), post.open_store());
    Social::new(post.clone()).spawn(post.open_social());
    let mut directory = Directory::new(post.clone(), db, leases, sims);
    directory.copy_kept = copy_kept;
    directory.expel_after = expel_after;
    directory.spawn(post.open_directory());
}

/// A gate, taking its mail here.
pub fn gate(post: &Arc<Post>, id: GateId) -> Arc<Gate> {
    Gate::start(id, post.clone(), post.open_gate(id))
}
