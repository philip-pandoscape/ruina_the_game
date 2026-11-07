//! The world on several processes, on this machine: `ruina-server` started in its roles (the
//! services, sims, a gate), finding each other through the directory in Postgres and passing the
//! tiers' messages over links, played by players over the gate's WebSocket as browsers play it; and
//! the failures the multi-server version rides out with nothing lost or done twice:
//!
//! - a player plays through a gate on a simulation in another process, and into an instance's copy,
//!   which the directory places on the sim process with the least to play;
//! - a sim process killed with a player in it: the player comes back in on the other, under the
//!   next epoch, with their life as last written;
//! - a sim process cut off from the directory with a player in it: it stops before its lease runs
//!   out, and the player comes back in on the other;
//! - every message from the gate to a sim written twice on the way: each command applied once;
//! - a link between processes cut as messages flow, and doubled: each message taken once, in order.
//!
//! The test is a process on the links too (`ruina_link::Node`), and puts proxies
//! (`ruina_link::proxy`) between processes where it cuts or doubles what passes. It needs a database
//! of its own (it lets go of every lease and forgets every process there before each test that
//! plays): `RUINA_DATABASE_URL=postgres://ruina:ruina@127.0.0.1:5478/ruina cargo test -p
//! ruina-server --test cluster -- --ignored --test-threads=1` (`npm run test:cluster`). The processes
//! take ports from 9100 to 9199.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use ruina_link::proxy::Proxy;
use ruina_link::{Config, Link, Node};
use ruina_server::cluster::Status;
use ruina_server::cluster::wire::{PROTOCOL, Wire};
use ruina_server::store::db;
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const BIN: &str = env!("CARGO_BIN_EXE_ruina-server");
/// The lease the processes play under here: 2 s, renewed every 0.4 s, a simulation stopping 0.4 s
/// before it runs out.
const LEASE_MS: u64 = 2000;
const PATIENCE: Duration = Duration::from_secs(40);

fn url() -> String {
    std::env::var("RUINA_DATABASE_URL").expect("RUINA_DATABASE_URL: these tests need Postgres, e.g. postgres://ruina:ruina@127.0.0.1:5478/ruina")
}

fn unique(what: &str) -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() % 100_000_000;
    format!("{what}{t}{}", N.fetch_add(1, Ordering::Relaxed))
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
    /// Starts a process of `role` as node `name`, on a port of its own.
    fn start(role: &str, name: &str, database: &str, extra: &[&str]) -> Proc {
        let port = port();
        let (port_s, lease) = (port.to_string(), LEASE_MS.to_string());
        let mut args = vec!["--role", role, "--node", name, "--port", port_s.as_str(), "--lease-ms", lease.as_str()];
        args.extend_from_slice(extra);
        let mut child = Command::new(BIN)
            .args(&args)
            .env("DATABASE_URL", database)
            .env("DEV_LOGIN", "1")
            .env_remove("ADMIN_USERS")
            .env_remove("ROLE")
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
        p.wait_for(if role == "gate" { "listening on" } else { "status on" }, "started");
        p
    }

    fn said(&self) -> String {
        self.said.lock().unwrap().clone()
    }

    fn wait_for(&self, needle: &str, what: &str) {
        let until = Instant::now() + PATIENCE;
        while !self.said().contains(needle) {
            assert!(Instant::now() < until, "{} never {what} ({needle:?}); it said:\n{}", self.name, self.said());
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Its status page, `/api/cluster` (the services' and the sims').
    fn page(&self) -> Value {
        let (_, body) = http(self.port, "GET", "/api/cluster", None);
        serde_json::from_str(&body).unwrap_or_else(|e| panic!("{}'s page ({e}): {body}", self.name))
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

/// One HTTP/1.1 request to this machine: the head and the body of the answer.
fn http(port: u16, method: &str, path: &str, body: Option<&str>) -> (String, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).expect("its port");
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let body = body.unwrap_or("");
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut answer = String::new();
    s.read_to_string(&mut answer).unwrap();
    let (head, body) = answer.split_once("\r\n\r\n").unwrap_or((&answer, ""));
    (head.to_string(), body.to_string())
}

async fn database() -> PgPool {
    db::connect(&url()).await.expect("the database")
}

/// Before a test that plays: every lease let go (the epochs kept) and every process forgotten, so
/// what earlier tests left can't be taken for a running world.
async fn fresh(db: &PgPool) {
    sqlx::query("UPDATE space_leases SET sim = NULL, node = NULL, address = NULL, expires_at = now() WHERE sim IS NOT NULL").execute(db).await.unwrap();
    sqlx::query("DELETE FROM nodes").execute(db).await.unwrap();
}

/// The test on the links, as a process of its own.
async fn tester() -> Node<Wire> {
    Node::<Wire>::start(unique("tester-"), "127.0.0.1:0", Config::speaking(PROTOCOL)).await.unwrap().0
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

async fn address_of(db: &PgPool, node: &str) -> String {
    until(&format!("{node} in the directory"), async || {
        sqlx::query_scalar::<_, String>("SELECT address FROM nodes WHERE id = $1").bind(node).fetch_optional(db).await.unwrap()
    })
    .await
}

async fn status(link: &Link<Wire>) -> Status {
    match link.request(&Wire::Status, Duration::from_secs(5)).await.expect("an answer") {
        Wire::Here(s) => s,
        other => panic!("{other:?}"),
    }
}

/// Who plays a space now: its process (node) and the lease's epoch.
async fn played_by(db: &PgPool, space: &str) -> Option<(String, i64)> {
    sqlx::query_as("SELECT node, epoch FROM space_leases WHERE space = $1 AND part = 0 AND sim IS NOT NULL AND expires_at > now()")
        .bind(space)
        .fetch_optional(db)
        .await
        .unwrap()
}

/// A character's coins as last written.
async fn saved_coins(db: &PgPool, character: i64) -> Option<f64> {
    sqlx::query_scalar::<_, Option<f64>>("SELECT (life->'state'->>'coins')::float8 FROM characters WHERE id = $1")
        .bind(character)
        .fetch_one(db)
        .await
        .unwrap()
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// A player, as a browser plays: signed in at a gate, its world's WebSocket open.
struct Player {
    port: u16,
    cookie: String,
    ws: Ws,
    welcome: Value,
    seq: u32,
    tick: u64,
    coins: Option<f64>,
    /// How the connection closed, once it has (1012: a service restart, come back in).
    closed: Option<u16>,
}

impl Player {
    /// Signs in by name (developer sign-in) at the gate on `port`, and comes into the world.
    async fn join(port: u16, name: &str) -> Player {
        let body = json!({ "username": name }).to_string();
        let (head, _) = tokio::task::spawn_blocking(move || http(port, "POST", "/api/dev-login", Some(&body))).await.unwrap();
        let cookie = head
            .lines()
            .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie")).map(|(_, v)| v.trim().split(';').next().unwrap().to_string()))
            .unwrap_or_else(|| panic!("signed in: {head}"));
        Player::connect(port, cookie).await
    }

    async fn connect(port: u16, cookie: String) -> Player {
        let mut req = format!("ws://127.0.0.1:{port}/ws/world").into_client_request().unwrap();
        req.headers_mut().insert("Cookie", cookie.parse().unwrap());
        let (ws, _) = tokio_tungstenite::connect_async(req).await.expect("the world's WebSocket");
        let mut p = Player { port, cookie, ws, welcome: Value::Null, seq: 0, tick: 0, coins: None, closed: None };
        p.welcome = p.wait("the welcome", |m| m["t"] == "welcome").await;
        p
    }

    /// Comes back in (after a service restart), as a browser does.
    async fn rejoin(self) -> Player {
        Player::connect(self.port, self.cookie).await
    }

    fn character(&self) -> i64 {
        self.welcome["character"]["id"].as_i64().expect("its character")
    }

    /// Its home channel's space, as the directory keys it.
    fn channel(&self) -> String {
        format!("channel:emberholm:{}", self.welcome["channel"].as_u64().expect("its channel"))
    }

    /// The next message; None once the connection has closed. A tick is answered with an input, as
    /// a browser sends what its player presses many times a second.
    async fn next(&mut self) -> Option<Value> {
        loop {
            let msg = tokio::time::timeout(PATIENCE, self.ws.next()).await.expect("the server says something");
            match msg {
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap();
                    if v["t"] == "tick" {
                        self.tick = v["tick"].as_u64().unwrap_or(self.tick);
                        if let Some(c) = v["life"]["state"]["coins"].as_f64() {
                            self.coins = Some(c);
                        }
                        self.press().await;
                    }
                    return Some(v);
                }
                Some(Ok(Message::Close(frame))) => {
                    self.closed = Some(frame.map_or(1005, |f| u16::from(f.code)));
                    return None;
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => {
                    self.closed.get_or_insert(1006);
                    return None;
                }
            }
        }
    }

    /// Waits for a message `f` picks.
    async fn wait(&mut self, what: &str, mut f: impl FnMut(&Value) -> bool) -> Value {
        loop {
            match self.next().await {
                Some(v) if f(&v) => return v,
                Some(_) => {}
                None => panic!("closed ({:?}) before {what}", self.closed),
            }
        }
    }

    /// Waits for the connection to close; how.
    async fn closing(&mut self) -> u16 {
        while self.next().await.is_some() {}
        self.closed.expect("closed")
    }

    /// One input: nothing pressed, seen at the last tick heard.
    async fn press(&mut self) {
        self.seq += 1;
        let mut b = vec![7u8, 1];
        b.extend(self.seq.to_le_bytes());
        b.extend(((self.tick * 16) as u32).to_le_bytes());
        b.extend([0u8; 10]);
        let _ = self.ws.send(Message::Binary(b.into())).await;
    }

    /// The developer panel's grant (everyone is an admin where developer sign-in is on and nobody
    /// is named one), run with the next input.
    async fn grant(&mut self, coins: f64) {
        let c = json!({ "t": "cmd", "s": self.seq + 1, "c": { "t": "grant", "coins": coins } });
        self.send(c).await;
        self.press().await;
    }

    /// Its coins, once a tick has carried its life.
    async fn coins_now(&mut self) -> f64 {
        while self.coins.is_none() {
            if self.next().await.is_none() {
                panic!("closed ({:?}) before its life came", self.closed);
            }
        }
        self.coins.unwrap()
    }

    /// Waits until its coins are `n` (the ticks carry its life when it changes).
    async fn has_coins(&mut self, n: f64) {
        let deadline = Instant::now() + PATIENCE;
        while self.coins != Some(n) {
            assert!(Instant::now() < deadline, "coins {:?}, not {n}", self.coins);
            if self.next().await.is_none() {
                panic!("closed ({:?}) with coins {:?}, not {n}", self.closed, self.coins);
            }
        }
    }

    async fn send(&mut self, v: Value) {
        self.ws.send(Message::Text(v.to_string().into())).await.unwrap();
    }
}

/// The services, sims, and a gate.
struct World {
    services: Proc,
    sims: Vec<Proc>,
    gate: Proc,
}

impl World {
    /// The services, then sims `(name, its database's address, more arguments)`, then a gate.
    fn start(sims: &[(&str, &str, &[&str])]) -> World {
        let url = url();
        let services = Proc::start("services", &unique("services-"), &url, &[]);
        let sims = sims.iter().map(|(name, db, extra)| Proc::start("sim", name, db, extra)).collect();
        let gate = Proc::start("gate", &unique("gate-"), &url, &[]);
        World { services, sims, gate }
    }

    fn sim(&mut self, name: &str) -> &mut Proc {
        self.sims.iter_mut().find(|p| p.name == name).expect("a sim of that name")
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn a_player_plays_on_simulations_in_other_processes() {
    let db = database().await;
    fresh(&db).await;
    let (a, b) = (unique("sim-a-"), unique("sim-b-"));
    let url = url();
    let world = World::start(&[(&a, &url, &[]), (&b, &url, &[])]);
    let mut p = Player::join(world.gate.port, &unique("ana")).await;
    // Their channel is played by a simulation in one of the sim processes.
    let channel = p.channel();
    let (node, _) = until("their channel played", async || played_by(&db, &channel).await).await;
    assert!(node == a || node == b, "played by {node}");
    p.wait("a tick", |m| m["t"] == "tick" && m["you"].is_object()).await;
    // What they ask goes there and back: a grant, seen in their life.
    let before = p.coins_now().await;
    p.grant(250.0).await;
    p.has_coins(before + 250.0).await;
    // Into a copy of an instance (the yard, a developer zone): the directory places it on the sim
    // process with the least to play, the other one, and the player is handed across.
    p.send(json!({ "t": "zone", "id": "yard" })).await;
    let space = p.wait("into the yard's copy", |m| m["t"] == "space").await;
    let copy: String = until("the copy played", async || {
        sqlx::query_scalar::<_, String>(
            "SELECT space FROM space_leases WHERE space LIKE 'copy:yard:%' AND sim IS NOT NULL AND expires_at > now() ORDER BY granted_at DESC LIMIT 1",
        )
        .fetch_optional(&db)
        .await
        .unwrap()
    })
    .await;
    let (copy_node, _) = played_by(&db, &copy).await.unwrap();
    assert_ne!(copy_node, node, "the copy on the other sim process: {space}");
    p.wait("a tick from the copy", |m| m["t"] == "tick").await;
    p.grant(5.0).await;
    p.has_coins(before + 255.0).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn a_sim_killed_with_a_player_in_it_and_they_come_back_on_another() {
    let db = database().await;
    fresh(&db).await;
    let (a, b) = (unique("sim-a-"), unique("sim-b-"));
    let url = url();
    let mut world = World::start(&[(&a, &url, &[]), (&b, &url, &[])]);
    let mut p = Player::join(world.gate.port, &unique("bo")).await;
    let channel = p.channel();
    let (node, epoch) = until("their channel played", async || played_by(&db, &channel).await).await;
    // Coins granted and written.
    p.wait("a tick", |m| m["t"] == "tick").await;
    let before = p.coins_now().await;
    p.grant(300.0).await;
    p.has_coins(before + 300.0).await;
    p.wait("their life written", |m| m["t"] == "saved").await;
    assert_eq!(saved_coins(&db, p.character()).await, Some(before + 300.0));
    // Its process killed outright: the player is sent back in (as a deploy does), and comes in on
    // the other sim process, under the next epoch, with their life as written.
    world.sim(&node).kill();
    let killed = Instant::now();
    assert_eq!(p.closing().await, 1012, "closed as a service restart");
    println!("killed: the player told to come back in {:?} after", killed.elapsed());
    let mut p = p.rejoin().await;
    let (now, again) = until("their channel played again", async || played_by(&db, &channel).await.filter(|(n, _)| *n != node)).await;
    assert!(again > epoch, "a newer epoch: {again} after {epoch}");
    assert!(now == a || now == b);
    p.wait("a tick", |m| m["t"] == "tick").await;
    p.has_coins(before + 300.0).await;
    // And they play on there.
    p.grant(1.0).await;
    p.has_coins(before + 301.0).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn a_sim_cut_off_from_the_directory_stops_and_its_player_comes_back_on_another() {
    let db = database().await;
    fresh(&db).await;
    let url = url();
    // A reaches the database through a proxy the test cuts.
    let (upstream, template) = {
        let after = url.split_once('@').unwrap().1;
        let hp = after.split('/').next().unwrap().to_string();
        (hp.clone(), url.replacen(&hp, "{}", 1))
    };
    let to_db = Proxy::start("127.0.0.1:0".parse::<SocketAddr>().unwrap(), &upstream, false).await.unwrap();
    let a_url = template.replace("{}", &to_db.addr().to_string());
    let a = unique("sim-a-");
    let mut world = World::start(&[(&a, &a_url, &[])]);
    let mut p = Player::join(world.gate.port, &unique("cy")).await;
    let channel = p.channel();
    let (node, epoch) = until("their channel played", async || played_by(&db, &channel).await).await;
    assert_eq!(node, a);
    p.wait("a tick", |m| m["t"] == "tick").await;
    let before = p.coins_now().await;
    p.grant(40.0).await;
    p.has_coins(before + 40.0).await;
    p.wait("their life written", |m| m["t"] == "saved").await;
    // Another sim process comes up; then A is cut off from the directory.
    let b = unique("sim-b-");
    world.sims.push(Proc::start("sim", &b, &url, &[]));
    let me = tester().await;
    let a_link = me.link(&a, &address_of(&db, &a).await);
    to_db.cut();
    let cut = Instant::now();
    // A stops before B is granted the space.
    let (mut a_stopped, mut b_granted) = (None, None);
    while a_stopped.is_none() || b_granted.is_none() {
        assert!(cut.elapsed() < PATIENCE, "A stopped at {a_stopped:?}, B granted at {b_granted:?}");
        if a_stopped.is_none() && status(&a_link).await.sims.iter().any(|s| s.space == channel && !s.holding) {
            a_stopped = Some(cut.elapsed());
        }
        if b_granted.is_none() && played_by(&db, &channel).await.is_some_and(|(n, _)| n == b) {
            b_granted = Some(cut.elapsed());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    println!("cut off: A stopped {a_stopped:?} after the cut, B granted {b_granted:?} after");
    assert!(a_stopped < b_granted);
    assert_eq!(p.closing().await, 1012);
    let mut p = p.rejoin().await;
    let (now, again) = played_by(&db, &channel).await.unwrap();
    assert_eq!(now, b);
    assert!(again > epoch);
    p.wait("a tick", |m| m["t"] == "tick").await;
    p.has_coins(before + 40.0).await;
    to_db.restore();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn every_message_to_a_sim_written_twice_and_each_command_applied_once() {
    let db = database().await;
    fresh(&db).await;
    let url = url();
    // The sim's links are reached through a proxy that writes every message twice on its way.
    let a = unique("sim-a-");
    let link_port = port();
    let proxy = Proxy::start("127.0.0.1:0".parse::<SocketAddr>().unwrap(), &format!("127.0.0.1:{link_port}"), true).await.unwrap();
    proxy.duplicate_every(1);
    let (listen, advertise) = (format!("127.0.0.1:{link_port}"), proxy.addr().to_string());
    let world = World::start(&[(&a, &url, &["--link", &listen, "--advertise", &advertise])]);
    let mut p = Player::join(world.gate.port, &unique("di")).await;
    p.wait("a tick", |m| m["t"] == "tick").await;
    let before = p.coins_now().await;
    for _ in 0..3 {
        p.grant(100.0).await;
    }
    p.has_coins(before + 300.0).await;
    // A moment more: nothing comes twice.
    for _ in 0..40 {
        p.next().await;
    }
    assert_eq!(p.coins, Some(before + 300.0));
    assert!(proxy.duplicated() > 10, "{} written twice", proxy.duplicated());
    let me = tester().await;
    let s = status(&me.link(&a, &address_of(&db, &a).await)).await;
    assert!(s.duplicates > 10, "the sim dropped what came twice: {s:?}");
}

/// A sim whose links are reached through a proxy the test can cut, with the test linked to it.
async fn sim_behind_proxy(db: &PgPool) -> (Proc, Proxy, Link<Wire>, Node<Wire>) {
    let name = unique("sim-");
    let link_port = port();
    let proxy = Proxy::start("127.0.0.1:0".parse::<SocketAddr>().unwrap(), &format!("127.0.0.1:{link_port}"), true).await.unwrap();
    let (listen, advertise) = (format!("127.0.0.1:{link_port}"), proxy.addr().to_string());
    let sim = Proc::start("sim", &name, &url(), &["--link", &listen, "--advertise", &advertise]);
    let me = tester().await;
    let addr = address_of(db, &name).await;
    assert_eq!(addr, advertise, "the directory has the address it's dialled at");
    let link = me.link(&name, &addr);
    (sim, proxy, link, me)
}

async fn tally(link: &Link<Wire>, stream: u64) -> (u64, bool, u64) {
    match link.request(&Wire::Tally { stream }, Duration::from_secs(10)).await.expect("a tally") {
        Wire::Counted { received, in_order, last, .. } => (received, in_order, last),
        other => panic!("{other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn a_link_between_processes_cut_and_doubled_loses_and_repeats_nothing() {
    let db = database().await;
    let (_sim, proxy, link, _me) = sim_behind_proxy(&db).await;
    const N: u64 = 6000;
    let mut n = 0;
    // Cut three times as the messages flow: those in flight at the cut, and 300 more queued behind
    // it, all go again once the link is dialled anew.
    for at in [1000, 2500, 4000] {
        while n < at {
            n += 1;
            link.send(&Wire::Count { stream: 1, n }).await.unwrap();
        }
        let connections = link.stats().connections;
        proxy.cut();
        while n < at + 300 {
            n += 1;
            link.send(&Wire::Count { stream: 1, n }).await.unwrap();
        }
        until("the link noticing the cut", async || (!link.connected()).then_some(())).await;
        proxy.restore();
        until("dialled anew", async || (link.stats().connections > connections).then_some(())).await;
    }
    // Then every third message written twice on the way.
    proxy.duplicate_every(3);
    while n < N {
        n += 1;
        link.send(&Wire::Count { stream: 1, n }).await.unwrap();
    }
    until("everything acknowledged", async || (link.backlog() == 0).then_some(())).await;
    assert_eq!(tally(&link, 1).await, (N, true, N), "every message once, in order");
    assert_eq!(link.stats().connections, 4, "dialled again after each cut");
    assert!(proxy.duplicated() >= 500, "{} written twice", proxy.duplicated());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres: RUINA_DATABASE_URL (npm run test:cluster)"]
async fn processes_find_each_other_through_the_directory() {
    let db = database().await;
    fresh(&db).await;
    let url = url();
    let (a, b) = (unique("sim-a-"), unique("sim-b-"));
    let world = World::start(&[(&a, &url, &[]), (&b, &url, &[])]);
    let page = world.services.page();
    for n in [&world.services.name, &a, &b, &world.gate.name] {
        assert!(page["nodes"].as_array().unwrap().iter().any(|row| row["id"] == n.as_str()), "{n} in {page}");
    }
    let me = tester().await;
    for sim in [&a, &b] {
        let s = status(&me.link(sim, &address_of(&db, sim).await)).await;
        assert_eq!((s.node.as_str(), s.role.name()), (sim.as_str(), "sim"));
    }
}
