//! The world on several processes, on this machine: `ruina-server` started several times in its
//! roles (`--role gate|sim|services`), finding each other through the directory in Postgres and
//! talking over links; and the failures the multi-server version must ride out: a sim killed (its
//! space taken over under the next epoch, carried on from its snapshot), a link between processes
//! cut and restored and its messages written twice (each taken once, in order), and a sim cut off
//! from the directory (it stops before its lease runs out, and only then is its space taken over).
//!
//! The test is a process on the links too (`ruina_link::Node`), and puts a proxy (`ruina_link::proxy`)
//! between processes where it cuts or doubles what passes. It needs a database:
//! `RUINA_DATABASE_URL=postgres://ruina:ruina@127.0.0.1:5478/ruina cargo test -p ruina-server --test
//! cluster -- --ignored` (`npm run test:cluster`). The processes take ports from 9100 to 9199.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ruina_link::proxy::Proxy;
use ruina_link::{Config, Link, Node};
use ruina_server::cluster::leases::{self, Leased};
use ruina_server::cluster::{Msg, PROTOCOL, Playing, Status};
use ruina_server::store::db;
use serde_json::Value;
use sqlx::PgPool;

const BIN: &str = env!("CARGO_BIN_EXE_ruina-server");
/// The lease the processes play under here: 2 s, renewed every 0.4 s, a sim stopping 0.4 s before
/// it runs out.
const LEASE_MS: u64 = 2000;
const PATIENCE: Duration = Duration::from_secs(30);

fn url() -> String {
    std::env::var("RUINA_DATABASE_URL").expect("RUINA_DATABASE_URL: these tests need Postgres, e.g. postgres://ruina:ruina@127.0.0.1:5478/ruina")
}

fn unique(what: &str) -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() % 100_000_000;
    format!("{what}-{t}-{}", N.fetch_add(1, Ordering::Relaxed))
}

/// A free port from this workstream's 9100-9199 (a process left over from an earlier run keeps its).
fn port() -> u16 {
    static NEXT: AtomicU16 = AtomicU16::new(9100);
    loop {
        let p = NEXT.fetch_add(1, Ordering::Relaxed);
        assert!(p < 9200, "out of ports in 9100-9199");
        if TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return p;
        }
    }
}

/// A `ruina-server` started by a test, what it says kept; killed when dropped.
struct Proc {
    name: String,
    port: u16,
    child: Child,
    said: Arc<Mutex<String>>,
}

impl Proc {
    /// Starts a process of `role`, as node `name`, its status on a port of its own.
    fn start(role: &str, name: &str, database: &str, extra: &[&str]) -> Proc {
        let port = port();
        let lease = LEASE_MS.to_string();
        let port_s = port.to_string();
        let mut args = vec!["--role", role, "--node", name, "--port", port_s.as_str(), "--lease-ms", lease.as_str()];
        args.extend_from_slice(extra);
        let mut child = Command::new(BIN)
            .args(&args)
            .env("DATABASE_URL", database)
            .env_remove("ROLE")
            .env_remove("SPACES")
            .env_remove("LINK_LISTEN")
            .env_remove("LINK_ADVERTISE")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start ruina-server");
        let said = Arc::new(Mutex::new(String::new()));
        for out in [Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>, Box::new(child.stderr.take().unwrap())] {
            let said = said.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    let mut s = said.lock().unwrap();
                    s.push_str(&line);
                    s.push('\n');
                }
            });
        }
        let p = Proc { name: name.to_string(), port, child, said };
        p.wait_for("status on", "started");
        p
    }

    fn said(&self) -> String {
        self.said.lock().unwrap().clone()
    }

    /// Waits until the process has said `needle`.
    fn wait_for(&self, needle: &str, what: &str) {
        let until = Instant::now() + PATIENCE;
        while !self.said().contains(needle) {
            if Instant::now() > until {
                panic!("{} never {what} ({needle:?}); it said:\n{}", self.name, self.said());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Its status page, `/api/cluster`.
    fn page(&self) -> Value {
        let mut s = TcpStream::connect(("127.0.0.1", self.port)).expect("its port");
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        write!(s, "GET /api/cluster HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();
        let mut answer = String::new();
        s.read_to_string(&mut answer).unwrap();
        let body = answer.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or_default();
        serde_json::from_str(body).unwrap_or_else(|e| panic!("{}'s page ({e}): {answer}", self.name))
    }

    /// Killed outright, as a crash or a lost machine would.
    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        self.kill();
        if std::thread::panicking() {
            eprintln!("---- {} said:\n{}", self.name, self.said());
        }
    }
}

async fn database() -> PgPool {
    db::connect(&url()).await.expect("the database")
}

/// The test on the links, as a process of its own.
async fn tester() -> Node<Msg> {
    Node::<Msg>::start(unique("tester"), "127.0.0.1:0", Config::speaking(PROTOCOL)).await.unwrap().0
}

/// Waits until `f` gives something, asking every 20 ms.
async fn until<T>(what: &str, mut f: impl AsyncFnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if let Some(t) = f().await {
            return t;
        }
        assert!(Instant::now() < deadline, "{what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A node's link address, as the directory has it.
async fn address_of(db: &PgPool, node: &str) -> String {
    until(&format!("{node} in the directory"), async || {
        sqlx::query_scalar::<_, String>("SELECT address FROM nodes WHERE id = $1").bind(node).fetch_optional(db).await.unwrap()
    })
    .await
}

async fn status(link: &Link<Msg>) -> Status {
    match link.request(&Msg::Status, Duration::from_secs(5)).await.expect("an answer") {
        Msg::Here(s) => s,
        other => panic!("{other:?}"),
    }
}

fn playing(s: &Status, space: &str) -> Option<Playing> {
    s.spaces.iter().find(|p| p.space == space).cloned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn processes_find_each_other_through_the_directory() {
    let db = database().await;
    let url = url();
    let names = [unique("services"), unique("sim-a"), unique("sim-b"), unique("gate")];
    let services = Proc::start("services", &names[0], &url, &[]);
    let _a = Proc::start("sim", &names[1], &url, &[]);
    let _b = Proc::start("sim", &names[2], &url, &[]);
    let gate = Proc::start("gate", &names[3], &url, &[]);
    // The gate found both sims in the directory, linked to them, and heard from each.
    until("the gate hearing from both sims", async || {
        let page = gate.page();
        let sims = page["sims"].as_array()?;
        let heard: Vec<&str> = sims.iter().filter(|s| s["status"]["role"] == "sim").filter_map(|s| s["id"].as_str()).collect();
        (heard.contains(&names[1].as_str()) && heard.contains(&names[2].as_str())).then_some(())
    })
    .await;
    // Every process is in the directory, as the services see it.
    let page = services.page();
    for n in &names {
        assert!(page["nodes"].as_array().unwrap().iter().any(|row| row["id"] == n.as_str()), "{n} in {page}");
    }
    // And the test reaches each sim where the directory says.
    let me = tester().await;
    for sim in &names[1..3] {
        let link = me.link(sim, &address_of(&db, sim).await);
        let s = status(&link).await;
        assert_eq!((s.node.as_str(), s.role.name()), (sim.as_str(), "sim"));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn a_killed_sims_space_is_taken_over_under_the_next_epoch() {
    let db = database().await;
    let url = url();
    let space = format!("channel:{}:1", unique("killed"));
    let leased = Leased::space(&space);
    let (na, nb) = (unique("sim-a"), unique("sim-b"));
    let mut a = Proc::start("sim", &na, &url, &["--spaces", &space]);
    a.wait_for(&format!("plays {space}"), "played its space");
    let _b = Proc::start("sim", &nb, &url, &["--spaces", &space]);
    let held = leases::owner(&db, &leased).await.unwrap().expect("held");
    assert_eq!(held.node, na);
    // A plays on, writing snapshots; then it's killed outright.
    let wrote = until("a snapshot from A", async || leases::read_snapshot(&db, &leased).await.unwrap().filter(|s| s.epoch == held.epoch)).await;
    a.kill();
    let killed = Instant::now();
    let now = until("B taking the space over", async || leases::owner(&db, &leased).await.unwrap().filter(|o| o.node == nb)).await;
    let took = killed.elapsed();
    assert_eq!(now.epoch, held.epoch + 1, "the next epoch");
    assert!(took < Duration::from_millis(LEASE_MS * 2), "taken over {took:?} after the kill");
    // B carried on from A's last snapshot, and writes its own under the new epoch.
    let me = tester().await;
    let b = me.link(&nb, &address_of(&db, &nb).await);
    let p = playing(&status(&b).await, &space).expect("B plays it");
    let (from_epoch, from_tick) = p.resumed.expect("carried on from a snapshot");
    assert_eq!(from_epoch, held.epoch);
    assert!(from_tick >= wrote.tick);
    let ours = until("a snapshot from B", async || leases::read_snapshot(&db, &leased).await.unwrap().filter(|s| s.epoch == now.epoch)).await;
    assert!(ours.tick >= from_tick, "the world's ticks only go on");
    println!("killed: taken over {took:?} after, at epoch {}", now.epoch);
}

/// A sim whose links are reached through a proxy the test can cut, with the test linked to it.
async fn sim_behind_proxy(db: &PgPool) -> (Proc, Proxy, Link<Msg>, Node<Msg>) {
    let name = unique("sim");
    let link_port = port();
    let proxy = Proxy::start("127.0.0.1:0".parse::<SocketAddr>().unwrap(), &format!("127.0.0.1:{link_port}"), true).await.unwrap();
    let listen = format!("127.0.0.1:{link_port}");
    let advertise = proxy.addr().to_string();
    let sim = Proc::start("sim", &name, &url(), &["--link", &listen, "--advertise", &advertise]);
    let me = tester().await;
    let addr = address_of(db, &name).await;
    assert_eq!(addr, advertise, "the directory has the address it's dialled at");
    let link = me.link(&name, &addr);
    (sim, proxy, link, me)
}

async fn tally(link: &Link<Msg>, stream: u64) -> (u64, bool, u64) {
    match link.request(&Msg::Tally { stream }, Duration::from_secs(10)).await.expect("a tally") {
        Msg::Counted { received, in_order, last, .. } => (received, in_order, last),
        other => panic!("{other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn a_link_between_processes_cut_and_restored_loses_and_repeats_nothing() {
    let db = database().await;
    let (_sim, proxy, link, _me) = sim_behind_proxy(&db).await;
    const N: u64 = 6000;
    let mut n = 0;
    // Cut three times as the messages flow: those in flight at the cut, and 300 more queued behind
    // it, all go again once the link is dialled anew.
    for at in [1000, 2500, 4000] {
        while n < at {
            n += 1;
            link.send(&Msg::Count { stream: 1, n }).await.unwrap();
        }
        let connections = link.stats().connections;
        proxy.cut();
        while n < at + 300 {
            n += 1;
            link.send(&Msg::Count { stream: 1, n }).await.unwrap();
        }
        until("the link noticing the cut", async || (!link.connected()).then_some(())).await;
        proxy.restore();
        until("dialled anew", async || (link.stats().connections > connections).then_some(())).await;
    }
    while n < N {
        n += 1;
        link.send(&Msg::Count { stream: 1, n }).await.unwrap();
    }
    until("everything acknowledged", async || (link.backlog() == 0).then_some(())).await;
    assert_eq!(tally(&link, 1).await, (N, true, N), "every message once, in order");
    assert_eq!(link.stats().connections, 4, "dialled again after each cut");
    println!("cut three times: {:?}, {} connections through the proxy", link.stats(), proxy.connections());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn a_message_delivered_twice_between_processes_is_taken_once() {
    let db = database().await;
    let (_sim, proxy, link, _me) = sim_behind_proxy(&db).await;
    proxy.duplicate_every(3);
    const N: u64 = 3000;
    for n in 1..=N {
        link.send(&Msg::Count { stream: 2, n }).await.unwrap();
    }
    until("everything acknowledged", async || (link.backlog() == 0).then_some(())).await;
    assert_eq!(tally(&link, 2).await, (N, true, N), "every message once, in order");
    let doubled = proxy.duplicated();
    assert!(doubled >= N / 3, "{doubled} written twice");
    let s = status(&link).await;
    assert!(s.duplicates >= N / 3, "the sim dropped what came twice: {s:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn a_sim_cut_off_from_the_directory_stops_before_its_space_is_taken_over() {
    let db = database().await;
    let url = url();
    let space = format!("channel:{}:1", unique("cut-off"));
    let leased = Leased::space(&space);
    // A reaches the database through a proxy the test cuts; B directly.
    let (upstream, rest) = {
        let after = url.split_once('@').unwrap().1;
        let hp = after.split('/').next().unwrap().to_string();
        (hp.clone(), url.replacen(&hp, "{}", 1))
    };
    let to_db = Proxy::start("127.0.0.1:0".parse::<SocketAddr>().unwrap(), &upstream, false).await.unwrap();
    let a_url = rest.replace("{}", &to_db.addr().to_string());
    let (na, nb) = (unique("sim-a"), unique("sim-b"));
    let a = Proc::start("sim", &na, &a_url, &["--spaces", &space]);
    a.wait_for(&format!("plays {space}"), "played its space");
    let _b = Proc::start("sim", &nb, &url, &["--spaces", &space]);
    let held = leases::owner(&db, &leased).await.unwrap().expect("held");
    assert_eq!(held.node, na);
    let me = tester().await;
    let a_link = me.link(&na, &address_of(&db, &na).await);
    assert!(playing(&status(&a_link).await, &space).is_some_and(|p| p.holding));
    // Cut off from the directory: A must stop before B is granted the space.
    to_db.cut();
    let cut = Instant::now();
    let (mut a_stopped, mut b_granted) = (None, None);
    let deadline = Instant::now() + PATIENCE;
    while a_stopped.is_none() || b_granted.is_none() {
        assert!(Instant::now() < deadline, "A stopped at {a_stopped:?}, B granted at {b_granted:?}");
        if a_stopped.is_none() && playing(&status(&a_link).await, &space).is_some_and(|p| !p.holding) {
            a_stopped = Some(Instant::now());
        }
        if b_granted.is_none() && leases::owner(&db, &leased).await.unwrap().is_some_and(|o| o.node == nb) {
            b_granted = Some(Instant::now());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (stopped, granted) = (a_stopped.unwrap(), b_granted.unwrap());
    assert!(stopped < granted, "A stopped {:?} after the cut, B was granted the space {:?} after", stopped - cut, granted - cut);
    let p = playing(&status(&a_link).await, &space).unwrap();
    assert!(p.why.as_deref().is_some_and(|w| w.contains("deadline") || w.contains("Unreachable")), "{p:?}");
    let now = leases::owner(&db, &leased).await.unwrap().unwrap();
    assert_eq!(now.epoch, held.epoch + 1);
    println!("cut off: A stopped {:?} after the cut, B granted {:?} after", stopped - cut, granted - cut);
    // Back on the network, A stands by: the space stays B's.
    to_db.restore();
    tokio::time::sleep(Duration::from_millis(LEASE_MS)).await;
    let still = leases::owner(&db, &leased).await.unwrap().unwrap();
    assert_eq!((still.node.as_str(), still.epoch), (nb.as_str(), now.epoch));
}
