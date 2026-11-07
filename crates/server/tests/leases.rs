//! The directory's leases against a real Postgres (migration 0030): of several sims asking at once
//! one is granted; a grant bumps the epoch and only its holder renews; a lease not renewed runs out
//! and another sim takes the space; a write under an old epoch is refused, and a grant waits for a
//! write under the old one to commit; a keeper renews, and one cut off from the database stops
//! before its lease runs out, its late write refused; the processes' heartbeats and their sweep.
//!
//! They need a database: `RUINA_DATABASE_URL=postgres://ruina:ruina@127.0.0.1:5478/ruina cargo test
//! -p ruina-server --test leases -- --ignored` (`npm run test:cluster` runs these and the processes'
//! harness). Every test works on spaces and processes of its own, so they share a database with
//! anything else.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ruina_link::proxy::Proxy;
use ruina_server::cluster::keeper::{Keeper, Kept, Lost, Timing};
use ruina_server::cluster::leases::{self, Granted, Holder, Lease, Leased};
use ruina_server::cluster::nodes;
use ruina_server::store::db;
use sqlx::PgPool;

fn url() -> String {
    std::env::var("RUINA_DATABASE_URL").expect("RUINA_DATABASE_URL: these tests need Postgres, e.g. postgres://ruina:ruina@127.0.0.1:5478/ruina")
}

async fn database() -> PgPool {
    db::connect(&url()).await.expect("the database")
}

/// The database's host and port in its URL, for a proxy to stand in front of.
fn host_port(url: &str) -> (String, String) {
    let after = url.split_once('@').map_or(url, |(_, rest)| rest);
    let hp = after.split('/').next().unwrap().to_string();
    (hp.clone(), url.replacen(&hp, "{}", 1))
}

/// The database reached through a proxy a test can cut.
async fn database_through_proxy() -> (PgPool, Proxy) {
    let (upstream, template) = host_port(&url());
    let proxy = Proxy::start("127.0.0.1:0".parse().unwrap(), &upstream, false).await.unwrap();
    let db = db::connect(&template.replace("{}", &proxy.addr().to_string())).await.expect("the database, through the proxy");
    (db, proxy)
}

fn unique(what: &str) -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    format!("{what}-{t:x}-{}", N.fetch_add(1, Ordering::Relaxed))
}

fn space(what: &str) -> Leased {
    Leased::space(format!("copy:{}:1", unique(what)))
}

async fn holder(db: &PgPool, node: &str) -> Holder {
    Holder { sim: leases::new_sim(db).await.unwrap(), node: node.into(), address: format!("{node}.local:9000") }
}

async fn granted(db: &PgPool, leased: &Leased, h: &Holder, ttl: Duration) -> Lease {
    match leases::acquire(db, leased, h, &[], ttl).await.unwrap() {
        Granted::Yes(l) => l,
        Granted::Held(o) => panic!("{leased} held by {o:?}"),
    }
}

/// Asks for the lease every 20 ms until granted; when.
async fn take_over(db: &PgPool, leased: &Leased, h: &Holder, ttl: Duration) -> (Lease, Instant) {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Granted::Yes(l) = leases::acquire(db, leased, h, &[], ttl).await.unwrap() {
                return (l, Instant::now());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("taken over in time")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn of_several_asking_at_once_one_is_granted() {
    let db = database().await;
    for _ in 0..5 {
        let leased = space("race");
        let mut asks = Vec::new();
        for k in 0..16 {
            let (db, leased) = (db.clone(), leased.clone());
            asks.push(tokio::spawn(async move {
                let h = holder(&db, &format!("sim-{k}")).await;
                (h.sim, leases::acquire(&db, &leased, &h, &[], Duration::from_secs(10)).await.unwrap())
            }));
        }
        let mut winners = Vec::new();
        let mut held = Vec::new();
        for a in asks {
            match a.await.unwrap() {
                (sim, Granted::Yes(l)) => winners.push((sim, l)),
                (_, Granted::Held(o)) => held.push(o),
            }
        }
        assert_eq!(winners.len(), 1, "one granted of sixteen: {winners:?}");
        let (sim, lease) = &winners[0];
        assert_eq!(lease.epoch, 1);
        assert!(held.iter().all(|o| o.sim == *sim && o.epoch == 1), "the rest told who holds it");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn a_grant_bumps_the_epoch_and_only_its_holder_renews() {
    let db = database().await;
    let leased = space("epochs");
    let (a, b) = (holder(&db, "sim-a").await, holder(&db, "sim-b").await);
    let ttl = Duration::from_secs(10);
    let la = granted(&db, &leased, &a, ttl).await;
    assert_eq!(la.epoch, 1);
    assert!(leases::renew(&db, &la, ttl).await.unwrap());
    match leases::acquire(&db, &leased, &b, &[], ttl).await.unwrap() {
        Granted::Held(o) => {
            assert_eq!((o.sim, o.node.as_str(), o.address.as_str(), o.epoch), (a.sim, "sim-a", "sim-a.local:9000", 1));
            assert!(o.left > Duration::from_secs(8) && o.left <= ttl, "{:?}", o.left);
        }
        g => panic!("{g:?}"),
    }
    // Let go: the next to ask takes it at once, under the next epoch, and the old holder can't renew.
    assert!(leases::release(&db, &la).await.unwrap());
    assert!(!leases::renew(&db, &la, ttl).await.unwrap());
    let lb = granted(&db, &leased, &b, ttl).await;
    assert_eq!(lb.epoch, 2);
    assert!(!leases::renew(&db, &la, ttl).await.unwrap());
    assert!(!leases::release(&db, &la).await.unwrap(), "not its own to let go");
    assert!(leases::renew(&db, &lb, ttl).await.unwrap());
    let owner = leases::owner(&db, &leased).await.unwrap().unwrap();
    assert_eq!((owner.sim, owner.epoch), (b.sim, 2));
    assert!(leases::owners(&db).await.unwrap().iter().any(|(l, o)| l == &leased && o.sim == b.sim));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn a_lease_not_renewed_runs_out_and_another_takes_the_space() {
    let db = database().await;
    let leased = space("runs-out");
    let (a, b) = (holder(&db, "sim-a").await, holder(&db, "sim-b").await);
    let ttl = Duration::from_millis(400);
    let asked = Instant::now();
    let la = granted(&db, &leased, &a, ttl).await;
    let (lb, at) = take_over(&db, &leased, &b, Duration::from_secs(10)).await;
    assert_eq!(lb.epoch, la.epoch + 1);
    // Not before the lease ran out (the database's clock; a little leeway for its granularity).
    assert!(at - asked >= ttl - Duration::from_millis(50), "taken over after {:?}", at - asked);
    assert!(!leases::renew(&db, &la, ttl).await.unwrap(), "run out: not renewed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn a_write_under_an_old_epoch_is_refused() {
    let db = database().await;
    let leased = space("stale");
    let (a, b) = (holder(&db, "sim-a").await, holder(&db, "sim-b").await);
    let la = granted(&db, &leased, &a, Duration::from_millis(300)).await;
    assert_eq!(leases::write_snapshot(&db, &la.fence(), 10, b"a").await.unwrap(), Ok(()));
    let (lb, _) = take_over(&db, &leased, &b, Duration::from_secs(10)).await;
    // A paused sim wakes and writes: refused, nothing written.
    let stale = leases::write_snapshot(&db, &la.fence(), 11, b"a, late").await.unwrap().unwrap_err();
    assert_eq!(stale.now, Some(lb.epoch));
    assert_eq!(leases::write_snapshot(&db, &lb.fence(), 12, b"b").await.unwrap(), Ok(()));
    let s = leases::read_snapshot(&db, &leased).await.unwrap().unwrap();
    assert_eq!((s.epoch, s.tick, s.data.as_slice()), (lb.epoch, 12, &b"b"[..]));
    // The check alone, in a write's transaction.
    let mut tx = db.begin().await.unwrap();
    assert!(leases::check(&mut tx, &la.fence()).await.unwrap().is_err());
    assert!(leases::check(&mut tx, &lb.fence()).await.unwrap().is_ok());
    tx.rollback().await.unwrap();
    // A lease let go fences everything under it.
    assert!(leases::release(&db, &lb).await.unwrap());
    let stale = leases::write_snapshot(&db, &lb.fence(), 13, b"b, after").await.unwrap().unwrap_err();
    assert_eq!(stale.now, Some(lb.epoch), "the same epoch, but nobody holds it");
    // And a space never leased has no fence to pass.
    let never = leases::Fence { leased: space("never"), epoch: 1 };
    assert_eq!(leases::write_snapshot(&db, &never, 1, b"x").await.unwrap().unwrap_err().now, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn a_grant_waits_for_a_write_under_the_old_epoch_to_commit() {
    let db = database().await;
    let leased = space("ordered");
    let (a, b) = (holder(&db, "sim-a").await, holder(&db, "sim-b").await);
    let la = granted(&db, &leased, &a, Duration::from_millis(200)).await;
    // Run out, and nobody has taken it yet: A's write still passes, holding the lease's row...
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut tx = db.begin().await.unwrap();
    assert!(leases::check(&mut tx, &la.fence()).await.unwrap().is_ok());
    // ...so B's grant waits for it.
    let grant = {
        let (db, leased, b) = (db.clone(), leased.clone(), b.clone());
        tokio::spawn(async move { leases::acquire(&db, &leased, &b, &[], Duration::from_secs(10)).await.unwrap() })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!grant.is_finished(), "the grant waits for the write under the old epoch");
    sqlx::query("INSERT INTO space_snapshots (space, part, epoch, tick, data) VALUES ($1, $2, $3, 7, 'a')")
        .bind(&leased.space)
        .bind(leased.part)
        .bind(la.epoch)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let Granted::Yes(lb) = grant.await.unwrap() else { panic!("granted once the write committed") };
    assert_eq!(lb.epoch, la.epoch + 1);
    // Whoever takes the space over reads what was written before.
    assert_eq!(leases::read_snapshot(&db, &leased).await.unwrap().unwrap().tick, 7);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn a_keeper_renews_and_one_cut_off_from_the_database_stops_before_its_lease_runs_out() {
    let db = database().await;
    let (cut_db, proxy) = database_through_proxy().await;
    let leased = space("cut-off");
    let (a, b) = (holder(&db, "sim-a").await, holder(&db, "sim-b").await);
    let timing = Timing::of(Duration::from_millis(2000));
    let asked = Instant::now();
    let la = granted(&cut_db, &leased, &a, timing.ttl).await;
    let keeper = Keeper::start(cut_db.clone(), la.clone(), timing, asked);
    // It renews: twice, and the deadline moves on.
    let first = keeper.deadline();
    tokio::time::timeout(Duration::from_secs(10), async {
        while keeper.deadline() < first + timing.renew_every * 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("renewed");
    assert!(keeper.holding());
    assert!(matches!(*keeper.notes().borrow(), Kept::Holding { epoch: 1, .. }));
    // Cut off from the database, while B stands by.
    proxy.cut();
    let cut = Instant::now();
    let standing = {
        let (db, leased, b) = (db.clone(), leased.clone(), b.clone());
        tokio::spawn(async move { take_over(&db, &leased, &b, Duration::from_secs(10)).await })
    };
    let why = tokio::time::timeout(Duration::from_secs(10), keeper.lost()).await.expect("the keeper gives up");
    let stopped = Instant::now();
    assert_eq!(why, Lost::Unreachable);
    assert!(!keeper.holding());
    let (lb, taken) = standing.await.unwrap();
    assert_eq!(lb.epoch, la.epoch + 1);
    assert!(stopped < taken, "stopped before the space was taken over");
    // It stopped with most of its margin to spare, and within a lease of being cut off.
    assert!(taken - stopped >= timing.margin / 2, "stopped {:?} before the takeover", taken - stopped);
    assert!(stopped - cut <= timing.ttl, "stopped {:?} after the cut", stopped - cut);
    println!("cut off: stopped {:?} after the cut, {:?} before the takeover", stopped - cut, taken - stopped);
    // Back on the network, its late write is refused.
    proxy.restore();
    let stale = leases::write_snapshot(&cut_db, &la.fence(), 1, b"late").await.unwrap().unwrap_err();
    assert_eq!(stale.now, Some(lb.epoch));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn a_keeper_lets_its_lease_go_and_the_next_takes_it_at_once() {
    let db = database().await;
    let leased = space("let-go");
    let (a, b) = (holder(&db, "sim-a").await, holder(&db, "sim-b").await);
    let asked = Instant::now();
    let la = granted(&db, &leased, &a, Duration::from_secs(10)).await;
    let keeper = Keeper::start(db.clone(), la.clone(), Timing::default(), asked);
    assert!(keeper.holding());
    assert!(keeper.release().await.unwrap());
    let lb = granted(&db, &leased, &b, Duration::from_secs(10)).await;
    assert_eq!(lb.epoch, la.epoch + 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn processes_beat_in_the_directory_and_the_long_gone_are_swept() {
    let db = database().await;
    let (gate, sim) = (unique("gate"), unique("sim"));
    nodes::register(&db, &gate, "gate", "127.0.0.1:9101", 11).await.unwrap();
    nodes::register(&db, &sim, "sim", "127.0.0.1:9102", 22).await.unwrap();
    let alive = nodes::alive(&db, None, Duration::from_secs(10)).await.unwrap();
    let mine: Vec<_> = alive.iter().filter(|n| n.id == gate || n.id == sim).collect();
    assert_eq!(mine.len(), 2);
    let sims = nodes::alive(&db, Some("sim"), Duration::from_secs(10)).await.unwrap();
    assert!(sims.iter().any(|n| n.id == sim && n.address == "127.0.0.1:9102" && n.incarnation == 22));
    assert!(!sims.iter().any(|n| n.id == gate));
    assert!(nodes::heartbeat(&db, &sim, 22).await.unwrap());
    // Another start of the same process takes its row: the old one's beats no longer count.
    nodes::register(&db, &sim, "sim", "127.0.0.1:9103", 23).await.unwrap();
    assert!(!nodes::heartbeat(&db, &sim, 22).await.unwrap());
    assert!(nodes::heartbeat(&db, &sim, 23).await.unwrap());
    // Gone quiet (two hours, so the sweep touches nobody else's): no longer alive, and swept.
    sqlx::query("UPDATE nodes SET seen_at = now() - interval '2 hours' WHERE id = $1").bind(&gate).execute(&db).await.unwrap();
    assert!(!nodes::alive(&db, None, Duration::from_secs(10)).await.unwrap().iter().any(|n| n.id == gate));
    assert!(nodes::sweep(&db, Duration::from_secs(3600)).await.unwrap() >= 1);
    nodes::leave(&db, &sim, 23).await.unwrap();
    let left = nodes::alive(&db, None, Duration::from_secs(100_000)).await.unwrap();
    assert!(!left.iter().any(|n| n.id == gate || n.id == sim), "swept, and left");
}
