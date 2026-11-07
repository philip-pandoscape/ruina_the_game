//! Each role started, as a process among several (`crates/server/src/cluster`):
//!
//! - **services**: the store, social and the directory, the leases in Postgres (`pg.rs`), each new
//!   simulation placed on the sim process with the least to play, every life written fenced by its
//!   writer's lease too; and the processes long gone forgotten.
//! - **gate**: a gate with an id drawn from the database, and the server's one port as one process
//!   serves it (the account API, the game's files, `/ws/world`).
//! - **sim**: the simulations the directory starts here.
//!
//! The services and the sims serve `/api/health` and `/api/cluster` (the directory as they see it)
//! on their port; a gate serves the whole API there. Stopped (Ctrl-C, SIGTERM), a sim's simulations
//! write their players' lives and let their spaces go, a gate rides it out as a deploy (`stop_world`),
//! and every process leaves the directory.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Value, json};
use sqlx::PgPool;

use crate::cluster::Role;
use crate::cluster::keeper::Timing;
use crate::cluster::leases;
use crate::cluster::nodes::{self, GONE_AFTER};
use crate::cluster::pg::{PgLeases, Placement, RemoteSims};
use crate::cluster::process::Process;
use crate::directory::{COPY_KEPT, EXPEL_AFTER};
use crate::http::{self, AppState, Listeners};
use crate::start;
use crate::store::{self, Db};

/// How a process of one role starts.
#[derive(Clone, Debug)]
pub struct Options {
    pub role: Role,
    /// Its id in the directory: unique among the processes on one database.
    pub node: String,
    /// Where its links listen (port 0: any free port).
    pub link: SocketAddr,
    /// Where other processes dial it, if not where it listens (a name on a private network).
    pub advertise: Option<String>,
    pub lease: Timing,
    /// Its HTTP port, and whether at every address.
    pub port: u16,
    pub everywhere: bool,
    /// A gate's: the account API's settings and the game's files.
    pub dev_login: bool,
    pub admin_users: HashSet<String>,
    pub secure_cookies: bool,
    pub static_dir: Option<PathBuf>,
}

/// Runs a process of one role (not `All`) until it's stopped.
pub async fn run(o: Options, db: PgPool) -> std::io::Result<()> {
    match o.role {
        Role::Services => {
            // Leases are Postgres's: lives are fenced by their writer's lease as well.
            store::fence_by_leases();
            let p = Process::start(o.role, &o.node, db.clone(), o.link, o.advertise.clone(), o.lease, None).await?;
            let place = Placement::new(db.clone());
            let leases = PgLeases::new(db.clone(), place.clone(), o.lease.ttl);
            let sims = Arc::new(RemoteSims::new(p.node().clone(), place));
            start::services_with(&p.post, Db::Pg(db.clone()), sims, leases, COPY_KEPT, EXPEL_AFTER);
            tokio::spawn(sweep(db.clone(), o.node.clone()));
            status_page(&p, o.port, o.everywhere).await?;
            p.stop().await;
        }
        Role::Sim => {
            let p = Process::start(o.role, &o.node, db.clone(), o.link, o.advertise.clone(), o.lease, None).await?;
            status_page(&p, o.port, o.everywhere).await?;
            p.stop().await;
        }
        Role::Gate => {
            let id = nodes::new_gate(&db).await.map_err(std::io::Error::other)?;
            let gate_id = ruina_world_api::GateId(id as u32);
            let p = Process::start(o.role, &o.node, db.clone(), o.link, o.advertise.clone(), o.lease, Some(gate_id)).await?;
            let gate = start::gate(&p.post, gate_id);
            println!("gate {}: gate {id}", o.node);
            let state = AppState {
                db: Some(db),
                gate,
                dev_login: o.dev_login,
                admin_users: o.admin_users,
                secure_cookies: o.secure_cookies,
                failed_logins: Mutex::new(HashMap::new()),
            };
            http::serve(o.port, o.everywhere, state, o.static_dir).await?;
            p.stop().await;
        }
        Role::All => unreachable!("one process playing everything runs the server as it always has"),
    }
    println!("{} {}: stopped", o.role, o.node);
    Ok(())
}

/// The services forget processes long gone.
async fn sweep(db: PgPool, node: String) {
    let mut every = tokio::time::interval(Duration::from_secs(5));
    loop {
        every.tick().await;
        match nodes::sweep(&db, GONE_AFTER * 3).await {
            Ok(0) => {}
            Ok(n) => println!("services {node}: forgot {n} processes long gone"),
            Err(e) => eprintln!("services {node}: couldn't sweep the directory ({e})"),
        }
    }
}

/// Serves `/api/health` and `/api/cluster` until the process is asked to stop.
async fn status_page(p: &Arc<Process>, port: u16, everywhere: bool) -> std::io::Result<()> {
    let router = Router::new().route("/api/health", get(health)).route("/api/cluster", get(page)).with_state(p.clone());
    let listener = Listeners::open(port, everywhere)?;
    println!("{} {}: status on http://localhost:{port}/api/cluster", p.role, p.id);
    axum::serve(listener, router).with_graceful_shutdown(http::stopped()).await
}

async fn health(State(p): State<Arc<Process>>) -> Json<Value> {
    Json(json!({ "ok": true, "role": p.role, "node": p.id }))
}

/// The directory as this process sees it: itself, the processes alive, and the spaces held and by
/// whom.
async fn page(State(p): State<Arc<Process>>) -> Json<Value> {
    let nodes = nodes::alive(&p.db, None, GONE_AFTER).await.unwrap_or_default();
    let held = leases::owners(&p.db).await.unwrap_or_default();
    Json(json!({
        "you": p.status(),
        "nodes": nodes.iter().map(|n| json!({ "id": n.id, "role": n.role, "address": n.address, "quietMs": n.quiet.as_millis() as u64 })).collect::<Vec<_>>(),
        "leases": held.iter().map(|(l, o)| json!({ "space": l.space, "part": l.part, "sim": o.sim, "node": o.node, "address": o.address, "epoch": o.epoch, "leftMs": o.left.as_millis() as u64 })).collect::<Vec<_>>(),
    }))
}
