//! What a process of each role runs, as scaffolding until the tiers run apart (the second half of
//! the multi-server version, once `crates/world-api`'s messages cross the links):
//!
//! - **every role** starts its links (`crates/link`), writes itself into the directory (`nodes`)
//!   and beats there every 2 s, answers `Status` and counts numbered messages, and serves
//!   `/api/health` and `/api/cluster` (the directory as it sees it) on its port;
//! - **a sim** stands for the spaces it's given (`--spaces`): it asks for each one's lease, plays
//!   it while it holds it (a stand-in for its simulation: the world's ticks counted, a snapshot
//!   written under its fence every second, carried on from whoever played it before), stops the
//!   moment its keeper says, and stands by to take it again;
//! - **a gate** keeps a link to every sim the directory knows, and asks each how it is every second;
//! - **the services** forget processes long gone.
//!
//! Stopped (Ctrl-C, SIGTERM), a sim lets its leases go, so another takes its spaces at once, and
//! every role leaves the directory.

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use ruina_link::{Config, Inbox, Node};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::watch;

use crate::cluster::keeper::{Keeper, Timing};
use crate::cluster::leases::{self, Granted, Holder, Leased};
use crate::cluster::nodes::{self, GONE_AFTER};
use crate::cluster::{Msg, PROTOCOL, Playing, Role, Status};
use crate::http::Listeners;
use crate::sim::clock::world_tick;

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
    /// The spaces a sim stands for, as world-api writes them (`channel:emberholm:1`).
    pub spaces: Vec<String>,
    pub lease: Timing,
    /// Its HTTP port (health and status), and whether at every address.
    pub port: u16,
    pub everywhere: bool,
}

/// What a gate has heard from a sim.
#[derive(Clone, Debug)]
struct Seen {
    address: String,
    status: Option<Status>,
    /// How long its last answer took, and how long ago it came.
    answer: Option<(Duration, Instant)>,
}

#[derive(Clone, Copy, Debug, Default)]
struct Count {
    received: u64,
    last: u64,
    in_order: bool,
}

struct Process {
    options: Options,
    db: PgPool,
    node: Node<Msg>,
    playing: Mutex<BTreeMap<Leased, Playing>>,
    sims: Mutex<HashMap<String, Seen>>,
    counts: Mutex<HashMap<(String, u64), Count>>,
    stopping: watch::Sender<bool>,
}

impl Process {
    fn status(&self) -> Status {
        let stats = self.node.stats();
        Status {
            node: self.options.node.clone(),
            role: self.options.role,
            incarnation: self.node.incarnation(),
            spaces: self.playing.lock().unwrap().values().cloned().collect(),
            delivered: stats.delivered,
            duplicates: stats.duplicates,
        }
    }

    fn say(&self, what: &str) {
        println!("{} {}: {what}", self.options.role, self.options.node);
    }

    fn playing(&self, leased: &Leased, f: impl FnOnce(&mut Playing)) {
        if let Some(p) = self.playing.lock().unwrap().get_mut(leased) {
            f(p);
        }
    }
}

fn wall_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

/// Runs a process of one role (not `All`) until it's stopped.
pub async fn run(options: Options, db: PgPool) -> std::io::Result<()> {
    let config = Config { advertise: options.advertise.clone(), ..Config::speaking(PROTOCOL) };
    let (node, inbox) = Node::<Msg>::start(options.node.clone(), options.link, config).await?;
    // The database keeps it as a BIGINT: the same 64 bits.
    let incarnation = node.incarnation() as i64;
    nodes::register(&db, &options.node, options.role.name(), node.advertised(), incarnation).await.map_err(std::io::Error::other)?;
    let beat = nodes::spawn_heartbeat(db.clone(), options.node.clone(), incarnation);
    let p = Arc::new(Process {
        options: options.clone(),
        db,
        node,
        playing: Mutex::default(),
        sims: Mutex::default(),
        counts: Mutex::default(),
        stopping: watch::channel(false).0,
    });
    p.say(&format!("links on {} (dialled at {}), in the directory", p.node.local_addr(), p.node.advertised()));
    tokio::spawn(answer(p.clone(), inbox));
    let mut stands = Vec::new();
    match options.role {
        Role::Sim => {
            for space in &options.spaces {
                stands.push(tokio::spawn(stand(p.clone(), Leased::space(space.clone()))));
            }
        }
        Role::Gate => drop(tokio::spawn(watch_sims(p.clone()))),
        Role::Services => drop(tokio::spawn(sweep(p.clone()))),
        Role::All => unreachable!("one process playing everything runs the server as it always has"),
    }
    let router = Router::new().route("/api/health", get(health)).route("/api/cluster", get(page)).with_state(p.clone());
    let listener = Listeners::open(options.port, options.everywhere)?;
    p.say(&format!("status on http://localhost:{}/api/cluster", options.port));
    axum::serve(listener, router).with_graceful_shutdown(stopped()).await?;
    // Stopping: the sims let their leases go, and everyone leaves the directory.
    p.say("stopping");
    p.stopping.send_replace(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), futures_util::future::join_all(stands)).await;
    beat.abort();
    let _ = nodes::leave(&p.db, &options.node, incarnation).await;
    p.node.stop();
    p.say("stopped");
    Ok(())
}

/// Resolves when the process is asked to stop (Ctrl-C, or SIGTERM from Docker and Railway).
async fn stopped() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
}

async fn until_stopping(stopping: &mut watch::Receiver<bool>) {
    let _ = stopping.wait_for(|s| *s).await;
}

/// Answers what the process is asked on its links, and counts numbered messages.
async fn answer(p: Arc<Process>, mut inbox: Inbox<Msg>) {
    while let Some(e) = inbox.recv().await {
        match &e.msg {
            Msg::Status => {
                let _ = p.node.reply(&e, &Msg::Here(p.status()));
            }
            Msg::Count { stream, n } => {
                let mut counts = p.counts.lock().unwrap();
                let c = counts.entry((e.from.clone(), *stream)).or_insert(Count { in_order: true, ..Count::default() });
                c.in_order &= *n == c.last + 1;
                c.received += 1;
                c.last = *n;
            }
            Msg::Tally { stream } => {
                let c = p.counts.lock().unwrap().get(&(e.from.clone(), *stream)).copied().unwrap_or(Count { in_order: true, ..Count::default() });
                let _ = p.node.reply(&e, &Msg::Counted { stream: *stream, received: c.received, in_order: c.in_order, last: c.last });
            }
            Msg::Here(_) | Msg::Counted { .. } => {}
        }
    }
}

/// A sim stands for a space: asks for its lease until granted, plays it while it holds it, and
/// stands by again once it doesn't.
async fn stand(p: Arc<Process>, leased: Leased) {
    let timing = p.options.lease;
    let mut stopping = p.stopping.subscribe();
    loop {
        if *stopping.borrow() {
            return;
        }
        // A new simulation each time it plays the space: it starts over from the snapshot.
        let sim = match leases::new_sim(&p.db).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("{} {}: couldn't reach the directory ({e})", p.options.role, p.options.node);
                tokio::select! {
                    _ = tokio::time::sleep(timing.renew_every) => continue,
                    _ = until_stopping(&mut stopping) => return,
                }
            }
        };
        let holder = Holder { sim, node: p.options.node.clone(), address: p.node.advertised().to_string() };
        let (lease, asked) = loop {
            let asked = Instant::now();
            match leases::acquire(&p.db, &leased, &holder, &[], timing.ttl).await {
                Ok(Granted::Yes(lease)) => break (lease, asked),
                Ok(Granted::Held(_)) => {}
                Err(e) => eprintln!("{} {}: couldn't ask for {leased} ({e})", p.options.role, p.options.node),
            }
            tokio::select! {
                _ = tokio::time::sleep(timing.renew_every) => {}
                _ = until_stopping(&mut stopping) => return,
            }
        };
        p.say(&format!("plays {leased} as sim {sim} under epoch {}", lease.epoch));
        let keeper = Keeper::start(p.db.clone(), lease, timing, asked);
        let why = play(&p, &keeper, &mut stopping).await;
        p.playing(&leased, |pl| {
            pl.holding = false;
            pl.stopped_at = Some(wall_ms());
            pl.why = Some(why.clone());
        });
        p.say(&format!("stopped playing {leased} ({why})"));
        if *stopping.borrow() {
            let _ = keeper.release().await;
            return;
        }
    }
}

/// The stand-in for a space's simulation while the tiers' sims can't yet run apart: from the
/// space's last snapshot, it plays the world's ticks 20 a second, and writes a snapshot under its
/// fence every second, until its keeper says stop (the lease lost, or its deadline come) or a
/// write is refused as stale. Why it stopped.
async fn play(p: &Process, keeper: &Keeper, stopping: &mut watch::Receiver<bool>) -> String {
    let lease = keeper.lease().clone();
    let fence = lease.fence();
    let from = leases::read_snapshot(&p.db, &lease.leased).await.ok().flatten();
    p.playing.lock().unwrap().insert(
        lease.leased.clone(),
        Playing {
            space: lease.leased.space.clone(),
            part: lease.leased.part,
            sim: lease.sim,
            epoch: lease.epoch,
            tick: world_tick(SystemTime::now()) as i64,
            holding: true,
            resumed: from.as_ref().map(|s| (s.epoch, s.tick)),
            stopped_at: None,
            why: None,
        },
    );
    let mut every = tokio::time::interval(Duration::from_millis(50));
    let mut written = Instant::now();
    loop {
        tokio::select! {
            _ = every.tick() => {}
            why = keeper.lost() => return format!("its lease was lost: {why:?}"),
            _ = until_stopping(stopping) => return "the process is stopping".into(),
        }
        if !keeper.holding() {
            return "its lease's deadline came before a renewal did".into();
        }
        let tick = world_tick(SystemTime::now()) as i64;
        p.playing(&lease.leased, |pl| pl.tick = tick);
        if written.elapsed() >= Duration::from_secs(1) {
            written = Instant::now();
            let data = tick.to_le_bytes();
            let write = leases::write_snapshot(&p.db, &fence, tick, &data);
            // A database that doesn't answer mustn't keep the sim past its deadline.
            tokio::select! {
                r = write => match r {
                    Ok(Ok(())) => {}
                    Ok(Err(stale)) => return stale.to_string(),
                    Err(e) => eprintln!("{} {}: couldn't write {}'s snapshot ({e})", p.options.role, p.options.node, lease.leased),
                },
                why = keeper.lost() => return format!("its lease was lost: {why:?}"),
                _ = tokio::time::sleep_until(keeper.deadline().into()) => return "its lease's deadline came before a renewal did".into(),
            }
        }
    }
}

/// A gate keeps a link to every sim in the directory and asks each how it is every second.
async fn watch_sims(p: Arc<Process>) {
    let mut every = tokio::time::interval(Duration::from_secs(1));
    loop {
        every.tick().await;
        let sims = match nodes::alive(&p.db, Some(Role::Sim.name()), GONE_AFTER).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("{} {}: couldn't read the directory ({e})", p.options.role, p.options.node);
                continue;
            }
        };
        {
            let mut seen = p.sims.lock().unwrap();
            seen.retain(|id, _| sims.iter().any(|s| &s.id == id));
            for s in &sims {
                seen.entry(s.id.clone()).or_insert(Seen { address: s.address.clone(), status: None, answer: None }).address = s.address.clone();
            }
        }
        for s in sims {
            let link = p.node.link(&s.id, &s.address);
            let p = p.clone();
            tokio::spawn(async move {
                let asked = Instant::now();
                if let Ok(Msg::Here(status)) = link.request(&Msg::Status, Duration::from_secs(1)).await
                    && let Some(seen) = p.sims.lock().unwrap().get_mut(&s.id)
                {
                    seen.status = Some(status);
                    seen.answer = Some((asked.elapsed(), Instant::now()));
                }
            });
        }
    }
}

/// The services forget processes long gone.
async fn sweep(p: Arc<Process>) {
    let mut every = tokio::time::interval(Duration::from_secs(5));
    loop {
        every.tick().await;
        match nodes::sweep(&p.db, GONE_AFTER * 3).await {
            Ok(0) => {}
            Ok(n) => p.say(&format!("forgot {n} processes long gone")),
            Err(e) => eprintln!("{} {}: couldn't sweep the directory ({e})", p.options.role, p.options.node),
        }
    }
}

async fn health(State(p): State<Arc<Process>>) -> Json<Value> {
    Json(json!({ "ok": true, "role": p.options.role, "node": p.options.node }))
}

/// The directory as this process sees it: itself, the processes alive, the spaces held and by whom,
/// and (a gate) what each sim last said.
async fn page(State(p): State<Arc<Process>>) -> Json<Value> {
    let nodes = nodes::alive(&p.db, None, GONE_AFTER).await.unwrap_or_default();
    let held = leases::owners(&p.db).await.unwrap_or_default();
    let sims: Vec<Value> = {
        let seen = p.sims.lock().unwrap();
        let mut ids: Vec<&String> = seen.keys().collect();
        ids.sort();
        ids.into_iter()
            .map(|id| {
                let s = &seen[id];
                json!({
                    "id": id,
                    "address": s.address,
                    "status": s.status,
                    "answerUs": s.answer.map(|(took, _)| took.as_micros() as u64),
                    "heardMsAgo": s.answer.map(|(_, at)| at.elapsed().as_millis() as u64),
                })
            })
            .collect()
    };
    Json(json!({
        "you": p.status(),
        "nodes": nodes.iter().map(|n| json!({ "id": n.id, "role": n.role, "address": n.address, "quietMs": n.quiet.as_millis() as u64 })).collect::<Vec<_>>(),
        "leases": held.iter().map(|(l, o)| json!({ "space": l.space, "part": l.part, "sim": o.sim, "node": o.node, "address": o.address, "epoch": o.epoch, "leftMs": o.left.as_millis() as u64 })).collect::<Vec<_>>(),
        "sims": sims,
    }))
}
