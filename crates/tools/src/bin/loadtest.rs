//! The load harness (R10.24): the world server under bots and virtual clients, measured, so every
//! change to how the server plays and talks (the wire for crowds, the tiers, borders, channels, the
//! multi-server version) is held to numbers. docs/testing.md (the stress tier) says how to run it.
//!
//!   npm run loadtest -- --plan baseline --out scratch/scale/baseline.json
//!   npm run loadtest -- --bots 256,1024 --clients 1 --parallel off,on
//!   npm run loadtest -- --plan bots --compare .plans/refactor/reports/scale-baseline.json
//!
//! For each point of a plan it starts the server afresh (a copy of target/release/ruina-server, with
//! developer sign-in, on the database DATABASE_URL or RUINA_DATABASE_URL names), signs in its
//! virtual clients by name (load0000, load0001...) and has them play:
//! - **arena**: every client in the developer zone everyone shares where two sides of bots fight
//!   (the battlefield, content/instances/battlefield.json; found in the content as the one shared
//!   developer zone with bots on both sides, its player limit and size read from it), on alternate
//!   sides; the first, the conductor, fills it with bots a group at a time, spread over each side's
//!   half (a teleport, then `bots`): skirmishers fighting across the middle, or wanderers walking about;
//! - **channels**: every client in its home channel of the world (24 live in a channel), no bots.
//!
//! Every client sends an input 60 times a second as a browser does (walking in circles, now and then
//! standing, in the arena swinging), and reads every update. After a warm-up it measures:
//! - every tick, the rules and the updates apart (the admins' stats carry each tick's times:
//!   crates/server/src/play/mod.rs), and how long the world thread spends on all its games a tick;
//! - the bytes each client receives a second, each update's size and how many peers it carries;
//! - the time from an input to the first update that acknowledges it, and between updates;
//! - the server's CPU (cores busy) and memory, the machine's load (before and during), and the
//!   harness's own CPU.
//!
//! A sweep that ramps stops after the first size that doesn't keep up: its tick past its 50 ms
//! budget, its updates less than 19 a second, or its inputs answered more than 200 ms late (at the
//! median), or no tick measured at all. Results go to `--out` as JSON (every repetition, and
//! each point's medians across them) with a Markdown summary beside it; `--compare` puts another
//! run's numbers beside these, as ratios.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::stream::{self, SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use ruina_engine::open::dungeon::{DungeonDef, dungeons};
use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Bytes, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// A tick's budget: the server ticks 20 times a second.
const BUDGET_MS: f64 = 50.0;
/// Fewer updates a second than this and the server isn't keeping up.
const KEEPING_UP: f64 = 19.0;
/// Inputs answered later than this at the median and it isn't either: a server that stalls and
/// catches up sends its updates in bursts (more than 20 a second, some of them), but its inputs
/// pile up behind each stall.
const ANSWERED_WITHIN_MS: f64 = 200.0;
/// Inputs a second, as a browser sends them.
const INPUT_HZ: f64 = 60.0;
/// An input message: 7, the count, then per input its sequence number, the tick (× 16) its sender
/// drew everyone else at, and OPEN_INPUT bytes (crates/server/src/play/socket.rs, read_inputs).
const SEND_INPUTS: u8 = 7;
const OPEN_INPUT: usize = 10;
/// Inputs' send times kept per client, by sequence number.
const RING: usize = 1024;
/// Bots spawned at a time round the conductor (a ring 3 to 5 m across: play/bots.rs).
const GROUP: u32 = 16;
/// The bot limit the server is started with: a game's every player slot
/// (crates/engine/src/combat.rs, MAX_PLAYERS).
const MAX_BOTS: u32 = 4096;
/// Ports a run moves through, one point to the next, so a server that was just stopped never
/// holds up the next.
const PORTS: u16 = 40;

/// The arena bots fight in: the developer zone everyone shares with bots on both sides (the
/// battlefield), found in the content as the server finds it, so its player limit, its size and its
/// name follow its file.
fn arena() -> &'static DungeonDef {
    dungeons()
        .iter()
        .find(|d| d.developer && d.shared && (0..2).all(|side| d.bots.iter().any(|b| b.team == side)))
        .expect("a developer zone everyone shares, with bots on both sides (content/instances/)")
}

/// How far the arena's floor reaches from its middle, each way (its widest box).
fn arena_reach() -> f64 {
    arena().boxes.iter().map(|b| b.hw.min(b.hd)).fold(0.0, f64::max)
}

/// When the harness started: every time it keeps is nanoseconds from here.
static START: OnceLock<Instant> = OnceLock::new();

/// Nanoseconds since the run began, never 0: a sent time of 0 means nothing was sent (the first
/// call starts the clock, and on Windows its first reading can be 0).
fn nanos() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_nanos() as u64 + 1
}

fn ms(ns: u64) -> f64 {
    ns as f64 / 1e6
}

// ---------------------------------------------------------------------------------------------
// What to measure.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Space {
    /// Everyone in the arena (the battlefield), bots too.
    Arena,
    /// Every client in its home channel of the world.
    Channels,
}

#[derive(Clone, Debug)]
struct Point {
    space: Space,
    bots: u32,
    brain: String,
    clients: u32,
    parallel: bool,
}

impl Point {
    /// What matches it in another run (`--compare`).
    fn key(&self) -> String {
        match self.space {
            Space::Arena => format!("{}/{}/{}/{}/{}", arena().id, self.bots, self.brain, self.clients, self.stepping()),
            Space::Channels => format!("channels/{}/{}", self.clients, self.stepping()),
        }
    }

    fn stepping(&self) -> &'static str {
        if self.parallel { "parallel" } else { "in order" }
    }

    fn label(&self) -> String {
        match self.space {
            Space::Arena => {
                let who = if self.clients == 1 { "1 client".to_string() } else { format!("{} clients", self.clients) };
                format!("{} {}s, {who}, {}", self.bots, self.brain, self.stepping())
            }
            Space::Channels => format!("{} clients in channels, {}", self.clients, self.stepping()),
        }
    }

    fn json(&self) -> Value {
        json!({
            "space": match self.space { Space::Arena => arena().id.as_str(), Space::Channels => "channels" },
            "bots": self.bots,
            "brain": self.brain,
            "clients": self.clients,
            "parallel": self.parallel,
            "key": self.key(),
            "label": self.label(),
        })
    }
}

/// Points measured one after another; a ramp stops after the first that does not keep up.
struct Sweep {
    title: String,
    points: Vec<Point>,
    ramp: bool,
}

fn in_arena(bots: u32, brain: &str, clients: u32, parallel: bool) -> Point {
    Point { space: Space::Arena, bots, brain: brain.into(), clients, parallel }
}

fn stepped(parallel: bool) -> &'static str {
    if parallel { "--parallel on" } else { "one after another" }
}

/// The plans, by name.
fn plan(name: &str) -> Option<Vec<Sweep>> {
    let bots = |brain: &str, sizes: &[u32]| -> Vec<Sweep> {
        [false, true]
            .into_iter()
            .map(|parallel| Sweep {
                title: format!("{brain}s in {}, one client watching, {}", arena().name.to_lowercase(), stepped(parallel)),
                points: sizes.iter().map(|&n| in_arena(n, brain, 1, parallel)).collect(),
                ramp: true,
            })
            .collect()
    };
    let sweeps = match name {
        "quick" => vec![Sweep { title: "a quick look".into(), points: vec![in_arena(64, "skirmisher", 1, false)], ramp: false }],
        "bots" => bots("skirmisher", &[0, 32, 64, 128, 256, 512, 1024, 2048, 4000]),
        "wanderers" => bots("wanderer", &[256, 1024, 4000]),
        "clients" => [64, 256]
            .into_iter()
            .map(|n| Sweep {
                title: format!("clients sharing {} with {n} skirmishers, one after another", arena().name.to_lowercase()),
                points: [5, 10, 20].map(|m| in_arena(n, "skirmisher", m, false)).into(),
                ramp: true,
            })
            .collect(),
        "channels" => vec![Sweep {
            title: "a world of channels: clients in their home channels (24 live in one), no bots, one after another".into(),
            points: [24, 48, 72, 96, 144, 192, 240, 480]
                .into_iter()
                .map(|m| Point { space: Space::Channels, bots: 0, brain: "none".into(), clients: m, parallel: false })
                .collect(),
            ramp: true,
        }],
        "baseline" => ["channels", "bots", "wanderers", "clients"].into_iter().flat_map(|p| plan(p).unwrap_or_default()).collect(),
        _ => return None,
    };
    Some(sweeps)
}

// ---------------------------------------------------------------------------------------------
// The command line.

struct Config {
    sweeps: Vec<Sweep>,
    /// The server to start (a copy, so a rebuild never meets a running file), or None to use a
    /// server already running at `attach`.
    exe: Option<PathBuf>,
    attach: Option<u16>,
    /// The process to watch when attached (its CPU and memory).
    pid: Option<u32>,
    database: String,
    port: u16,
    warmup: f64,
    seconds: f64,
    reps: u32,
    out: PathBuf,
    label: String,
    compare: Option<PathBuf>,
    prefix: String,
    threads: usize,
}

const HELP: &str = "loadtest: the world server under bots and virtual clients (crates/tools/src/bin/loadtest.rs)

  --plan NAME        quick | bots | wanderers | clients | channels | baseline (all four)
  --bots N,N..       or a sweep of your own: bots in the arena...
  --clients M,M..    ...with this many clients (as many as the arena takes)
  --space S          arena (default: the battlefield, the developer zone where two sides of bots
                     fight) | channels (clients in their home channels, no bots)
  --brain B          skirmisher (default) | wanderer
  --parallel P,P..   off (default) | on | off,on
  --ramp             stop the sweep after the first point past the 50 ms budget
  --reps R           repetitions of each point, each on a fresh server (default 3)
  --warmup S         seconds of play before measuring (default 5)
  --seconds S        seconds measured (default 15)
  --out FILE         results, JSON (default scratch/scale/<label>-<time>.json; Markdown beside it)
  --label TEXT       names the run (default the plan's name)
  --compare FILE     another run's results, put beside these
  --server EXE       the server to start (default target/release/ruina-server, copied first)
  --url URL          measure a server already running there instead (http://localhost:7879)
  --pid PID          ...and watch this process's CPU and memory
  --database URL     the server's database (default DATABASE_URL or RUINA_DATABASE_URL)
  --port P           the first port to start servers on (default 8900; a run moves through 40)
  --prefix TEXT      the virtual clients' names (default load: load0000, load0001...)
  --threads N        the harness's own threads (default 8)
";

fn list<T: std::str::FromStr>(v: &str, what: &str) -> Vec<T> {
    v.split(',').map(|s| s.trim().parse().unwrap_or_else(|_| panic!("{what} takes numbers, comma-separated: {v}"))).collect()
}

fn parse_args() -> Config {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.iter().any(|a| a == "--help" || a == "-h") {
        print!("{HELP}");
        std::process::exit(0);
    }
    let mut opts: BTreeMap<String, String> = BTreeMap::new();
    let mut ramp = false;
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if a == "--ramp" {
            ramp = true;
            i += 1;
            continue;
        }
        let Some(name) = a.strip_prefix("--") else { panic!("unexpected argument {a} (--help lists them)") };
        let v = argv.get(i + 1).unwrap_or_else(|| panic!("{a} needs a value"));
        opts.insert(name.to_string(), v.clone());
        i += 2;
    }
    let get = |k: &str| opts.get(k).cloned();
    let custom = get("bots").is_some() || get("clients").is_some() || get("space").is_some();
    let (sweeps, plan_name) = if custom {
        let space = match get("space").as_deref() {
            None | Some("arena") => Space::Arena,
            Some(s) if s == arena().id => Space::Arena,
            Some("channels") => Space::Channels,
            Some(s) => panic!("--space takes arena or channels, not {s}"),
        };
        let bots: Vec<u32> = if space == Space::Channels { vec![0] } else { list(&get("bots").unwrap_or_else(|| "64".into()), "--bots") };
        let clients: Vec<u32> = list(&get("clients").unwrap_or_else(|| "1".into()), "--clients");
        let brain = get("brain").unwrap_or_else(|| if space == Space::Channels { "none".into() } else { "skirmisher".into() });
        let parallels: Vec<bool> = get("parallel")
            .unwrap_or_else(|| "off".into())
            .split(',')
            .map(|p| match p.trim() {
                "on" => true,
                "off" => false,
                other => panic!("--parallel takes on and off, not {other}"),
            })
            .collect();
        let mut sweeps = Vec::new();
        for parallel in parallels {
            let mut points = Vec::new();
            for &m in &clients {
                for &n in &bots {
                    points.push(Point { space, bots: n, brain: brain.clone(), clients: m, parallel });
                }
            }
            sweeps.push(Sweep { title: format!("{} clients and bots as asked, {}", points.len(), stepped(parallel)), points, ramp });
        }
        (sweeps, "custom".to_string())
    } else {
        let name = get("plan").unwrap_or_else(|| "quick".into());
        let sweeps = plan(&name).unwrap_or_else(|| panic!("no plan called {name} (--help lists them)"));
        (sweeps, name)
    };
    for p in sweeps.iter().flat_map(|s| &s.points) {
        if p.space == Space::Arena && p.clients as usize > arena().max_players {
            panic!("{} takes {} players at most, not {}", arena().name, arena().max_players, p.clients);
        }
        if p.space == Space::Arena && p.bots + p.clients > MAX_BOTS {
            panic!("a game holds {MAX_BOTS} players and bots at most, not {}", p.bots + p.clients);
        }
    }
    let attach = get("url").map(|u| {
        let port = u.rsplit(':').next().and_then(|p| p.trim_end_matches('/').parse().ok());
        port.unwrap_or_else(|| panic!("--url needs a port: http://localhost:7879"))
    });
    let exe = if attach.is_some() { None } else { Some(get("server").map(PathBuf::from).unwrap_or_else(default_server)) };
    let database = get("database").or_else(|| std::env::var("DATABASE_URL").ok()).or_else(|| std::env::var("RUINA_DATABASE_URL").ok()).unwrap_or_default();
    if attach.is_none() && database.is_empty() {
        eprintln!("loadtest needs a database for the server it starts: --database, DATABASE_URL or RUINA_DATABASE_URL");
        std::process::exit(2);
    }
    let label = get("label").unwrap_or_else(|| plan_name.clone());
    let out = get("out").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(format!("scratch/scale/{label}-{}.json", stamp().replace([':', '-'], ""))));
    let num = |k: &str, d: f64| get(k).map_or(d, |v| v.parse().unwrap_or_else(|_| panic!("--{k} takes a number")));
    Config {
        sweeps,
        exe,
        attach,
        pid: get("pid").map(|p| p.parse().expect("--pid takes a number")),
        database,
        port: num("port", 8900.0) as u16,
        warmup: num("warmup", 5.0),
        seconds: num("seconds", 15.0),
        reps: num("reps", 3.0) as u32,
        out,
        label,
        compare: get("compare").map(PathBuf::from),
        prefix: get("prefix").unwrap_or_else(|| "load".into()),
        threads: num("threads", 8.0) as usize,
    }
}

fn default_server() -> PathBuf {
    PathBuf::from(if cfg!(windows) { "target/release/ruina-server.exe" } else { "target/release/ruina-server" })
}

/// The time now, as ISO 8601 (UTC, to the second).
fn stamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days since 1970 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

// ---------------------------------------------------------------------------------------------
// The run.

fn main() {
    let cfg = parse_args();
    START.get_or_init(Instant::now);
    // The harness and the servers it starts ahead of whatever else the machine is doing, so a
    // neighbour's build disturbs the numbers less (Windows; elsewhere as they are).
    os::above_normal_self();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(cfg.threads.max(2)).enable_all().build().expect("start tokio");
    rt.block_on(run(cfg));
}

async fn run(mut cfg: Config) {
    if let Some(dir) = cfg.out.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let logs = cfg.out.with_extension("logs");
    let _ = std::fs::create_dir_all(&logs);
    // A copy of the server, so building it again while this runs never meets a running file.
    if let Some(exe) = cfg.exe.clone() {
        let copy = logs.join(exe.file_name().expect("the server's file name"));
        if let Err(e) = std::fs::copy(&exe, &copy) {
            eprintln!("could not copy the server {}: {e} (build it: node tools/cargo.mjs build --release)", exe.display());
            std::process::exit(2);
        }
        cfg.exe = Some(copy);
    }
    let points: usize = cfg.sweeps.iter().map(|s| s.points.len()).sum();
    println!(
        "loadtest {}: {} sweeps, {points} points, {} each ({}s warm-up, {}s measured); results to {}",
        cfg.label,
        cfg.sweeps.len(),
        if cfg.reps == 1 { "once".to_string() } else { format!("{} times", cfg.reps) },
        cfg.warmup,
        cfg.seconds,
        cfg.out.display()
    );
    let mut results = json!({
        "harness": "loadtest",
        "label": cfg.label,
        "started": stamp(),
        "machine": machine(),
        "server": {
            "exe": cfg.exe.as_ref().map(|e| e.display().to_string()),
            "attached": cfg.attach,
            "commit": git(&["rev-parse", "--short", "HEAD"]),
            "branch": git(&["rev-parse", "--abbrev-ref", "HEAD"]),
        },
        "settings": { "warmup": cfg.warmup, "seconds": cfg.seconds, "reps": cfg.reps },
        "points": [],
    });
    let mut n = 0u16;
    for sweep in &cfg.sweeps {
        println!("\n{}", sweep.title);
        for p in &sweep.points {
            let mut reps = Vec::new();
            for rep in 1..=cfg.reps {
                let port = cfg.attach.unwrap_or(cfg.port + n % PORTS);
                n += 1;
                let log = logs.join(format!("{:03}-{}.log", n, p.key().replace(['/', ' '], "_")));
                let r = match measure(&cfg, p, port, &log).await {
                    Ok(r) => r,
                    Err(e) => {
                        eprintln!("  {} (rep {rep}): failed: {e}", p.label());
                        json!({ "error": e })
                    }
                };
                if r.get("error").is_none() {
                    println!("  {} (rep {rep}): {}", p.label(), brief(&r));
                }
                reps.push(r);
            }
            let median = medians(&reps);
            let over = median.get("overBudget").and_then(Value::as_bool).unwrap_or(false);
            results["points"].as_array_mut().unwrap().push(json!({ "point": p.json(), "sweep": sweep.title, "median": median, "reps": reps }));
            results["finished"] = json!(stamp());
            write_results(&cfg, &results);
            if sweep.ramp && over {
                println!("  past the budget: the rest of this sweep is skipped");
                break;
            }
        }
    }
    let summary = summary(&results, cfg.compare.as_deref());
    println!("\n{summary}");
    let md = cfg.out.with_extension("md");
    if let Err(e) = std::fs::write(&md, &summary) {
        eprintln!("could not write {}: {e}", md.display());
    }
    println!("results: {} and {}", cfg.out.display(), md.display());
}

fn write_results(cfg: &Config, results: &Value) {
    let text = serde_json::to_string_pretty(results).unwrap_or_default();
    if let Err(e) = std::fs::write(&cfg.out, format!("{text}\n")) {
        eprintln!("could not write {}: {e}", cfg.out.display());
    }
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn machine() -> Value {
    json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "threads": std::thread::available_parallelism().map_or(0, |n| n.get()),
        "cpu": std::env::var("PROCESSOR_IDENTIFIER").ok(),
        "host": std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).ok(),
    })
}

/// One repetition of a point: a fresh server (unless attached), the clients in, bots set up, a
/// warm-up, the measurement.
async fn measure(cfg: &Config, p: &Point, port: u16, log: &Path) -> Result<Value, String> {
    // The machine's load before anything of ours starts: the others sharing it.
    let before = system_busy_over(Duration::from_secs(1)).await;
    let server = match &cfg.exe {
        Some(exe) => Some(Server::start(exe, &cfg.database, port, p.parallel, log).await?),
        None => None,
    };
    let process = server.as_ref().map(|s| Proc::of_child(&s.child)).or_else(|| cfg.pid.and_then(Proc::open));
    let result = play(cfg, p, port, process.as_ref()).await;
    drop(server);
    let mut r = result?;
    r["machineBusyBefore"] = before.map_or(Value::Null, |b| json!(round(b, 3)));
    Ok(r)
}

struct Server {
    child: Child,
}

impl Server {
    async fn start(exe: &Path, database: &str, port: u16, parallel: bool, log: &Path) -> Result<Server, String> {
        let out = std::fs::File::create(log).map_err(|e| format!("{}: {e}", log.display()))?;
        let err = out.try_clone().map_err(|e| e.to_string())?;
        let child = Command::new(exe)
            .args(["--port", &port.to_string(), "--parallel", if parallel { "on" } else { "off" }, "--max-bots", &MAX_BOTS.to_string()])
            .env("DATABASE_URL", database)
            .env("DEV_LOGIN", "1")
            .env("PORT", "")
            .env_remove("ADMIN_USERS")
            .env_remove("PARALLEL")
            .env_remove("MAX_BOTS")
            .env_remove("STATIC_DIR")
            .stdin(Stdio::null())
            .stdout(out)
            .stderr(err)
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", exe.display()))?;
        os::above_normal(&child);
        let mut server = Server { child };
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Ok((200, _, body)) = http(port, "GET", "/api/health", None, None).await
                && body.contains("\"database\":true")
            {
                return Ok(server);
            }
            if let Ok(Some(status)) = server.child.try_wait() {
                return Err(format!("the server stopped as it started ({status}): see {}", log.display()));
            }
            if Instant::now() > deadline {
                return Err(format!("the server didn't answer on port {port}: see {}", log.display()));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// What a run shares with its clients: whether they're recording now.
struct Run {
    recording: AtomicBool,
}

/// One repetition's play and measurement, on the server at `port`.
async fn play(cfg: &Config, p: &Point, port: u16, process: Option<&Proc>) -> Result<Value, String> {
    let run = Arc::new(Run { recording: AtomicBool::new(false) });
    let (frames_tx, frames) = watch::channel(0u64);
    let metronome = Metronome::start(frames_tx);
    let fight = p.space == Space::Arena;

    // Everyone signed in and connected: into the arena a few at a time; into channels one at
    // a time, as a character's home channel is the first with room when it first comes in, which
    // characters arriving together race for. Channels' clients have names of their own, so they
    // fill channels of their own.
    let (names, at_once): (Vec<(usize, String)>, usize) = match p.space {
        Space::Arena => ((0..p.clients as usize).map(|k| (k, format!("{}{k:04}", cfg.prefix))).collect(), 24),
        Space::Channels => ((0..p.clients as usize).map(|k| (k, format!("{}c{k:04}", cfg.prefix))).collect(), 1),
    };
    let connected: Vec<Result<Client, String>> =
        stream::iter(names).map(|(k, name)| Client::connect(port, k, name, frames.clone(), run.clone(), fight)).buffer_unordered(at_once).collect().await;
    let mut clients = Vec::new();
    let mut failed = Vec::new();
    for c in connected {
        match c {
            Ok(c) => clients.push(c),
            Err(e) => failed.push(e),
        }
    }
    clients.sort_by_key(|c| c.state.k);
    if clients.is_empty() {
        return Err(format!("no client got in: {}", failed.first().cloned().unwrap_or_default()));
    }
    if !failed.is_empty() {
        eprintln!("  {} of {} clients couldn't get in: {}", failed.len(), p.clients, failed[0]);
    }
    wait_for(Duration::from_secs(30), || clients.iter().all(|c| c.state.game().is_some())).await;

    let mut bots_asked = 0;
    if p.space == Space::Arena {
        let (zone, reach) = (arena().id.as_str(), arena_reach());
        for c in &clients {
            let team = (c.state.k % 2) as u8;
            c.say(json!({ "t": "zone", "id": zone, "team": team }));
        }
        let all_in = wait_for(Duration::from_secs(30), || clients.iter().all(|c| c.state.game().is_some_and(|g| g.starts_with(zone)))).await;
        if !all_in {
            let out: Vec<String> = clients.iter().filter(|c| !c.state.game().is_some_and(|g| g.starts_with(zone))).map(|c| c.state.name.clone()).collect();
            return Err(format!("not everyone got into {}: {}", arena().name, out.join(", ")));
        }
        // Each client at its post, on its side's half, facing the middle.
        for c in &clients {
            let k = c.state.k as f64;
            let post = reach * 2.0 / 3.0;
            let (x, z) = (-20.0 + (k / 2.0).floor() * 4.0, if c.state.k % 2 == 0 { -post } else { post });
            c.post.lock().unwrap().replace((x, z));
            c.command(json!({ "t": "teleport", "x": x, "z": z }));
        }
        // The conductor sends the arena's own bots away, and brings the point's.
        let conductor = &clients[0];
        conductor.command(json!({ "t": "bots", "n": 0 }));
        wait_for(Duration::from_secs(10), || conductor.state.last_stats().is_some_and(|s| s["bots"].as_u64() == Some(0))).await;
        for (team, x, z, n) in layout(p.bots, reach) {
            conductor.command(json!({ "t": "teleport", "x": x, "z": z }));
            conductor.command(json!({ "t": "bots", "n": n, "brain": p.brain, "team": team }));
            bots_asked += n;
        }
        if let Some((x, z)) = *conductor.post.lock().unwrap() {
            conductor.command(json!({ "t": "teleport", "x": x, "z": z }));
        }
        let want = u64::from(bots_asked);
        let all = wait_for(Duration::from_secs(60), || conductor.state.last_stats().is_some_and(|s| s["bots"].as_u64().is_some_and(|b| b >= want))).await;
        if !all {
            let seen = conductor.state.last_stats().and_then(|s| s["bots"].as_u64()).unwrap_or(0);
            eprintln!("  only {seen} of {want} bots came in");
        }
    }
    // One client in each game reads its stats.
    let mut games: BTreeMap<String, usize> = BTreeMap::new();
    for (i, c) in clients.iter().enumerate() {
        if let Some(g) = c.state.game() {
            games.entry(g).or_insert(i);
        }
    }
    for &i in games.values() {
        clients[i].state.watching.store(true, Ordering::Relaxed);
    }

    tokio::time::sleep(Duration::from_secs_f64(cfg.warmup)).await;

    // The measurement.
    let cpu0 = process.and_then(Proc::cpu_seconds);
    let sys0 = system_times();
    let own0 = own_cpu_seconds();
    let t0 = Instant::now();
    run.recording.store(true, Ordering::Relaxed);
    let mut peak_cores: f64 = 0.0;
    let mut last_cpu = cpu0;
    let mut last_at = t0;
    let whole = cfg.seconds.ceil().max(1.0) as u32;
    for s in 1..=whole {
        let until = t0 + Duration::from_secs_f64((f64::from(s)).min(cfg.seconds));
        tokio::time::sleep_until(until.into()).await;
        let now_cpu = process.and_then(Proc::cpu_seconds);
        if let (Some(a), Some(b)) = (last_cpu, now_cpu) {
            peak_cores = peak_cores.max((b - a) / last_at.elapsed().as_secs_f64().max(1e-3));
        }
        last_cpu = now_cpu;
        last_at = Instant::now();
    }
    run.recording.store(false, Ordering::Relaxed);
    let secs = t0.elapsed().as_secs_f64();
    let cpu1 = process.and_then(Proc::cpu_seconds);
    let sys1 = system_times();
    let own1 = own_cpu_seconds();
    let memory = process.and_then(Proc::memory);
    let metronome_hz = metronome.rate();
    drop(metronome);

    let mut r = collect(&clients, secs, games.len());
    r["clientsIn"] = json!(clients.len());
    r["clientsFailed"] = json!(failed.len());
    r["botsAsked"] = json!(bots_asked);
    r["seconds"] = json!(round(secs, 2));
    r["serverCpuCores"] = match (cpu0, cpu1) {
        (Some(a), Some(b)) => json!(round((b - a) / secs, 2)),
        _ => Value::Null,
    };
    r["serverCpuPeakCores"] = if cpu0.is_some() { json!(round(peak_cores, 2)) } else { Value::Null };
    r["serverMemoryMB"] = memory.map_or(Value::Null, |m| json!(round(m.0 as f64 / 1048576.0, 1)));
    r["serverPeakMemoryMB"] = memory.map_or(Value::Null, |m| json!(round(m.1 as f64 / 1048576.0, 1)));
    r["machineBusy"] = match (sys0, sys1) {
        (Some(a), Some(b)) if b.1 > a.1 => json!(round((b.0 - a.0) / (b.1 - a.1), 3)),
        _ => Value::Null,
    };
    r["harnessCpuCores"] = match (own0, own1) {
        (Some(a), Some(b)) => json!(round((b - a) / secs, 2)),
        _ => Value::Null,
    };
    r["inputsPerSecond"] = json!(round(metronome_hz, 1));
    for c in &clients {
        c.close();
    }
    Ok(r)
}

/// Waits until `done` holds, looking every 50 ms; false if it still doesn't after `limit`.
async fn wait_for(limit: Duration, done: impl Fn() -> bool) -> bool {
    let until = Instant::now() + limit;
    loop {
        if done() {
            return true;
        }
        if Instant::now() > until {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Where the bots go: groups of GROUP, half on each side, in a grid over each side's half of an arena
/// whose floor reaches `reach` each way from its middle (the battlefield's 60 m: x from -50 to 50, 8
/// to 52 m from the middle): (side, x, z, how many).
fn layout(n: u32, reach: f64) -> Vec<(u8, f64, f64, u32)> {
    let (wide, deep) = (2.0 * (reach - 10.0), reach - 16.0);
    let mut out = Vec::new();
    for team in 0..2u8 {
        let mine = n / 2 + if team == 0 { n % 2 } else { 0 };
        let groups = mine.div_ceil(GROUP);
        if groups == 0 {
            continue;
        }
        // Columns and rows in about the half's shape (100 m by 44 in the battlefield).
        let cols = ((f64::from(groups) * wide / deep).sqrt().ceil() as u32).clamp(1, groups);
        let rows = groups.div_ceil(cols);
        for g in 0..groups {
            let (c, r) = (g % cols, g / cols);
            let x = -wide / 2.0 + wide * (f64::from(c) + 0.5) / f64::from(cols);
            let d = 8.0 + deep * (f64::from(r) + 0.5) / f64::from(rows);
            out.push((team, x, if team == 0 { -d } else { d }, GROUP.min(mine - g * GROUP)));
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// A virtual client.

/// What a client's reader and writer share, and what the run reads back.
struct ClientState {
    k: usize,
    name: String,
    /// The last input's sequence number.
    seq: AtomicU32,
    /// When each input went (ns), by sequence number.
    sent: Vec<AtomicU64>,
    /// The newest tick heard.
    last_tick: AtomicU64,
    /// Whether this client reads its game's stats (one in each game does).
    watching: AtomicBool,
    /// Whether the server has welcomed it: a browser sends no inputs before, and inputs sent early
    /// wait in the server's queue, which drains at one input a second (61 run for 60 sent).
    welcomed: AtomicBool,
    rec: Mutex<Record>,
}

#[derive(Default)]
struct Record {
    /// The game it's in, as the server last said: "channel 3", "battlefield -1".
    game: Option<String>,
    last_stats: Option<Value>,
    last_ack: u32,
    last_update: Option<u64>,
    // Counted while recording.
    bytes: u64,
    messages: u64,
    updates: u64,
    latencies: Vec<f32>,
    gaps: Vec<f32>,
    sizes: Vec<u32>,
    peers: Vec<u32>,
    stats: Vec<Value>,
    notes: Vec<String>,
}

impl ClientState {
    fn game(&self) -> Option<String> {
        self.rec.lock().unwrap().game.clone()
    }

    fn last_stats(&self) -> Option<Value> {
        self.rec.lock().unwrap().last_stats.clone()
    }

    /// The next input, as bytes on the wire.
    fn input(&self, frame: u64, fight: bool) -> Vec<u8> {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        // Everyone else drawn two ticks back, as a browser draws them; the wire keeps the low 32 bits.
        let view = (self.last_tick.load(Ordering::Relaxed).saturating_sub(2).wrapping_mul(16)) as u32;
        self.sent[seq as usize % RING].store(nanos(), Ordering::Relaxed);
        let mut b = Vec::with_capacity(2 + 8 + OPEN_INPUT);
        b.extend([SEND_INPUTS, 1]);
        b.extend(seq.to_le_bytes());
        b.extend(view.to_le_bytes());
        b.extend(walk(self.k, frame, fight));
        b
    }

    /// A message from the server, heard at `at` (ns).
    fn heard(&self, text: &str, at: u64, recording: bool) {
        let watching = self.watching.load(Ordering::Relaxed);
        let mut r = self.rec.lock().unwrap();
        if recording {
            r.bytes += text.len() as u64;
            r.messages += 1;
        }
        let Ok(m) = serde_json::from_str::<Heard>(text) else { return };
        match m.t.as_ref() {
            "tick" => {
                if let Some(t) = m.tick {
                    self.last_tick.store(t, Ordering::Relaxed);
                }
                if recording {
                    r.updates += 1;
                    if let Some(prev) = r.last_update {
                        r.gaps.push(ms(at.saturating_sub(prev)) as f32);
                    }
                    if watching {
                        r.sizes.push(text.len() as u32);
                        if let Some(p) = &m.peers {
                            r.peers.push(p.len() as u32);
                        }
                    }
                }
                r.last_update = Some(at);
                if let Some(you) = m.you {
                    if you.ack > r.last_ack {
                        // Each input this update acknowledges for the first time: how long it took.
                        if recording && you.ack - r.last_ack <= RING as u32 / 2 {
                            for seq in r.last_ack + 1..=you.ack {
                                let sent = self.sent[seq as usize % RING].load(Ordering::Relaxed);
                                if sent > 0 && at > sent {
                                    r.latencies.push(ms(at - sent) as f32);
                                }
                            }
                        }
                        r.last_ack = you.ack;
                    } else if you.ack < r.last_ack {
                        // A new game counts from where it took over.
                        r.last_ack = you.ack;
                    }
                }
                if let Some(s) = m.stats {
                    if watching && recording {
                        r.stats.push(s.clone());
                    }
                    r.last_stats = Some(s);
                }
            }
            // Where it is: its home channel, or (coming back) the copy it was in; then wherever it goes.
            "welcome" | "space" => {
                self.welcomed.store(true, Ordering::Relaxed);
                let s = m.space.unwrap_or(Value::Null);
                r.game = Some(match s["kind"].as_str() {
                    Some("dungeon") => format!("{} {}", s["dungeon"].as_str().unwrap_or("?"), s["copy"]),
                    Some(_) => format!("channel {}", s["channel"]),
                    None => format!("channel {}", m.channel.unwrap_or(0)),
                });
                // Acknowledgements count afresh in a new game.
                r.last_ack = 0;
            }
            "error" | "notice" | "kicked" | "updating" => {
                let note = format!("{}: {}", m.t, m.text.unwrap_or_default());
                if r.notes.len() < 20 {
                    r.notes.push(note);
                }
            }
            _ => {}
        }
    }
}

/// What the harness reads of a message (the rest is skipped unread).
#[derive(Deserialize)]
struct Heard<'a> {
    #[serde(borrow)]
    t: Cow<'a, str>,
    #[serde(default)]
    tick: Option<u64>,
    #[serde(default)]
    you: Option<You>,
    #[serde(default)]
    peers: Option<Vec<IgnoredAny>>,
    #[serde(default)]
    stats: Option<Value>,
    #[serde(default)]
    channel: Option<i64>,
    #[serde(default)]
    space: Option<Value>,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Deserialize)]
struct You {
    ack: u32,
}

/// What a client presses on `frame`: five seconds of walking a circle about 6 m across (each client
/// starting at its own point of it), a second standing; in a fight, a swing now and then.
fn walk(k: usize, frame: u64, fight: bool) -> [u8; OPEN_INPUT] {
    let t = frame as f64 / INPUT_HZ;
    let phase = k as f64 * 2.399_963;
    if (t + phase).rem_euclid(6.0) >= 5.0 {
        return [0; OPEN_INPUT];
    }
    let heading = phase + t * 0.8;
    let byte = |v: f64| ((v * 127.0).round().clamp(-127.0, 127.0) as i8) as u8;
    let mut buttons = 0u8;
    if fight && (frame + k as u64 * 7).is_multiple_of(90) {
        buttons |= 4;
    }
    let tau = std::f64::consts::TAU;
    let face = 1 + ((heading.rem_euclid(tau) / (tau / 255.0)).round() as u32 % 255) as u8;
    [byte(heading.sin()), byte(heading.cos()), buttons, 0, 0, 0, 0, face, 0, 0]
}

type Sink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
type Source = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

struct Client {
    state: Arc<ClientState>,
    /// Text for the server, sent between inputs.
    out: mpsc::UnboundedSender<String>,
    /// Where it stands in the arena.
    post: Mutex<Option<(f64, f64)>>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Client {
    /// Signs `name` in (developer sign-in makes the account and its character the first time),
    /// opens the world's WebSocket, and starts reading and sending.
    async fn connect(port: u16, k: usize, name: String, frames: watch::Receiver<u64>, run: Arc<Run>, fight: bool) -> Result<Client, String> {
        let body = json!({ "username": name }).to_string();
        let (status, head, answer) = http(port, "POST", "/api/dev-login", Some(&body), None).await?;
        if status != 200 {
            return Err(format!("{name}: developer sign-in answered {status}: {answer}"));
        }
        let token = head
            .lines()
            .filter_map(|l| l.split_once(':'))
            .filter(|(h, _)| h.eq_ignore_ascii_case("set-cookie"))
            .find_map(|(_, v)| v.trim().strip_prefix("ruina_session=").map(|v| v.split(';').next().unwrap_or("").to_string()))
            .ok_or_else(|| format!("{name}: no session cookie"))?;
        let mut req = format!("ws://127.0.0.1:{port}/ws/world").into_client_request().map_err(|e| e.to_string())?;
        req.headers_mut().insert("Cookie", HeaderValue::from_str(&format!("ruina_session={token}")).map_err(|e| e.to_string())?);
        let config = WebSocketConfig::default().max_message_size(Some(512 << 20)).max_frame_size(Some(512 << 20));
        let (ws, _) = tokio_tungstenite::connect_async_with_config(req, Some(config), true).await.map_err(|e| format!("{name}: {e}"))?;
        let (sink, source) = ws.split();
        let state = Arc::new(ClientState {
            k,
            name,
            seq: AtomicU32::new(0),
            sent: (0..RING).map(|_| AtomicU64::new(0)).collect(),
            last_tick: AtomicU64::new(0),
            watching: AtomicBool::new(k == 0),
            welcomed: AtomicBool::new(false),
            rec: Mutex::new(Record::default()),
        });
        let (out, texts) = mpsc::unbounded_channel();
        // The wire for crowds' acknowledgements, from the reader to the writer.
        let (acks, acked) = mpsc::unbounded_channel();
        let reader = tokio::spawn(read(source, state.clone(), run, acks));
        let writer = tokio::spawn(write(sink, state.clone(), frames, texts, acked, fight));
        Ok(Client { state, out, post: Mutex::new(None), tasks: vec![reader, writer] })
    }

    fn say(&self, v: Value) {
        let _ = self.out.send(v.to_string());
    }

    /// A command for the game (the developer panel's teleport and bots are among them).
    fn command(&self, c: Value) {
        self.say(json!({ "t": "cmd", "s": self.state.seq.load(Ordering::Relaxed), "c": c }));
    }

    fn close(&self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.close();
    }
}

async fn read(mut source: Source, state: Arc<ClientState>, run: Arc<Run>, acks: mpsc::UnboundedSender<Vec<u8>>) {
    while let Some(Ok(msg)) = source.next().await {
        let at = nanos();
        let recording = run.recording.load(Ordering::Relaxed);
        match msg {
            Message::Text(t) => state.heard(t.as_str(), at, recording),
            Message::Binary(b) => {
                if recording {
                    state.rec.lock().unwrap().bytes += b.len() as u64;
                }
                // An update on the wire for crowds, acknowledged as a browser does: over one
                // connection every update arrives, in order, so this one and all before it.
                if b.first() == Some(&ruina_wire::viewer::UPDATE) && b.len() >= 5 {
                    let seq = u32::from_le_bytes([b[1], b[2], b[3], b[4]]);
                    let _ = acks.send(ruina_wire::Ack { seq, bits: u32::MAX }.write());
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    state.rec.lock().unwrap().notes.push("the connection closed".into());
}

async fn write(
    mut sink: Sink,
    state: Arc<ClientState>,
    mut frames: watch::Receiver<u64>,
    mut texts: mpsc::UnboundedReceiver<String>,
    mut acked: mpsc::UnboundedReceiver<Vec<u8>>,
    fight: bool,
) {
    let mut last = *frames.borrow();
    loop {
        tokio::select! {
            changed = frames.changed() => {
                if changed.is_err() {
                    break;
                }
                let frame = *frames.borrow_and_update();
                // One input a frame from the welcome on; a few to catch up if this task woke late,
                // as a browser's fixed steps do.
                let due = if state.welcomed.load(Ordering::Relaxed) { frame.saturating_sub(last).min(4) } else { 0 };
                last = frame;
                for f in 0..due {
                    let msg = state.input(frame + 1 + f - due, fight);
                    if sink.send(Message::Binary(Bytes::from(msg))).await.is_err() {
                        return;
                    }
                }
            }
            Some(ack) = acked.recv() => {
                if sink.send(Message::Binary(Bytes::from(ack))).await.is_err() {
                    return;
                }
            }
            text = texts.recv() => match text {
                Some(t) => {
                    if sink.send(Message::Text(t.into())).await.is_err() {
                        return;
                    }
                }
                None => break,
            },
        }
    }
    let _ = sink.close().await;
}

/// A thread keeping time for every client's inputs: 60 frames a second by the high-resolution
/// clock (tokio's timers on Windows run on the system's 15.6 ms tick).
struct Metronome {
    stop: Arc<AtomicBool>,
    count: Arc<AtomicU64>,
    started: Instant,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Metronome {
    fn start(frames: watch::Sender<u64>) -> Metronome {
        let stop = Arc::new(AtomicBool::new(false));
        let count = Arc::new(AtomicU64::new(0));
        let (s, c) = (stop.clone(), count.clone());
        let thread = std::thread::Builder::new()
            .name("metronome".into())
            .spawn(move || {
                let period = Duration::from_secs_f64(1.0 / INPUT_HZ);
                let start = Instant::now();
                let mut frame = 0u64;
                while !s.load(Ordering::Relaxed) {
                    frame += 1;
                    let at = start + period.mul_f64(frame as f64);
                    let now = Instant::now();
                    if at > now {
                        std::thread::sleep(at - now);
                    }
                    frames.send_replace(frame);
                    c.store(frame, Ordering::Relaxed);
                }
            })
            .expect("start the metronome");
        Metronome { stop, count, started: Instant::now(), thread: Some(thread) }
    }

    /// Frames a second it has kept so far.
    fn rate(&self) -> f64 {
        self.count.load(Ordering::Relaxed) as f64 / self.started.elapsed().as_secs_f64().max(1e-3)
    }
}

impl Drop for Metronome {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// A bare HTTP/1.1 request to the server on this machine: (status, headers, body).
async fn http(port: u16, method: &str, path: &str, body: Option<&str>, cookie: Option<&str>) -> Result<(u16, String, String), String> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.map_err(|e| e.to_string())?;
    let body = body.unwrap_or("");
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
        body.len()
    );
    if let Some(c) = cookie {
        let _ = write!(req, "Cookie: {c}\r\n");
    }
    req.push_str("\r\n");
    req.push_str(body);
    s.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok((status, head.to_string(), body.to_string()))
}

// ---------------------------------------------------------------------------------------------
// The numbers.

fn round(v: f64, places: i32) -> f64 {
    let f = 10f64.powi(places);
    (v * f).round() / f
}

/// Sorted values' `p`th fraction (0.5 the median).
fn pct(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    sorted[((p * sorted.len() as f64) as usize).min(sorted.len() - 1)]
}

/// A distribution: how many, the mean, the median, the 95th and 99th percentiles, the most.
fn dist(mut xs: Vec<f64>) -> Value {
    xs.retain(|x| x.is_finite());
    xs.sort_by(f64::total_cmp);
    if xs.is_empty() {
        return json!({ "n": 0 });
    }
    let mean = xs.iter().sum::<f64>() / xs.len() as f64;
    json!({
        "n": xs.len(),
        "mean": round(mean, 3),
        "median": round(pct(&xs, 0.5), 3),
        "p95": round(pct(&xs, 0.95), 3),
        "p99": round(pct(&xs, 0.99), 3),
        "max": round(*xs.last().unwrap(), 3),
    })
}

/// What a repetition measured, from every client's record.
fn collect(clients: &[Client], secs: f64, games: usize) -> Value {
    let (mut rules, mut sends, mut ticks) = (Vec::new(), Vec::new(), Vec::new());
    let (mut sizes, mut peers, mut latencies, mut gaps) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let (mut kbps, mut ups) = (Vec::new(), Vec::new());
    let mut world_ms = 0.0;
    let (mut bots_seen, mut players_seen) = (0u64, 0u64);
    let mut notes = Vec::new();
    for c in clients {
        let r = c.state.rec.lock().unwrap();
        kbps.push(r.bytes as f64 / 1024.0 / secs);
        ups.push(r.updates as f64 / secs);
        latencies.extend(r.latencies.iter().map(|&v| f64::from(v)));
        gaps.extend(r.gaps.iter().map(|&v| f64::from(v)));
        sizes.extend(r.sizes.iter().map(|&v| f64::from(v) / 1024.0));
        peers.extend(r.peers.iter().map(|&v| f64::from(v)));
        // This game's ticks, from its stats (rules and updates apart).
        let mut mine = Vec::new();
        for s in &r.stats {
            for t in s["ticks"].as_array().into_iter().flatten() {
                let (a, b) = (t[0].as_f64().unwrap_or(f64::NAN), t[1].as_f64().unwrap_or(f64::NAN));
                rules.push(a);
                sends.push(b);
                mine.push(a + b);
            }
        }
        if !mine.is_empty() {
            world_ms += mine.iter().sum::<f64>() / mine.len() as f64;
            ticks.extend(mine);
        }
        if let Some(s) = r.stats.last() {
            bots_seen += s["bots"].as_u64().unwrap_or(0);
            players_seen += s["players"].as_u64().unwrap_or(0);
        }
        for n in &r.notes {
            if notes.len() < 10 && !notes.contains(n) {
                notes.push(n.clone());
            }
        }
    }
    let tick = dist(ticks);
    let updates = dist(ups.clone());
    let answered = dist(latencies);
    let over = tick["median"].as_f64().is_some_and(|m| m > BUDGET_MS)
        || updates["median"].as_f64().is_some_and(|u| u < KEEPING_UP)
        || answered["median"].as_f64().is_some_and(|l| l > ANSWERED_WITHIN_MS)
        || tick["n"] == json!(0);
    json!({
        "games": games,
        "botsSeen": bots_seen,
        "playersSeen": players_seen,
        "tickMs": tick,
        "rulesMs": dist(rules),
        "sendMs": dist(sends),
        "worldMsPerTick": round(world_ms, 3),
        "updatesPerSecond": updates,
        "kbPerSecond": dist(kbps),
        "updateKB": dist(sizes),
        "peersPerUpdate": dist(peers),
        "inputToUpdateMs": answered,
        "betweenUpdatesMs": dist(gaps),
        "overBudget": over,
        "notes": notes,
    })
}

/// A short line for the console.
fn brief(r: &Value) -> String {
    let f = |v: &Value| v.as_f64().map_or("-".to_string(), |x| format!("{x:.2}"));
    format!(
        "tick {} ms (p99 {}; rules {}, updates {}), world {} ms, {} updates/s, {} KB/s a client, update {} KB, input to update {} ms (p99 {}), server {} cores {} MB{}",
        f(&r["tickMs"]["median"]),
        f(&r["tickMs"]["p99"]),
        f(&r["rulesMs"]["median"]),
        f(&r["sendMs"]["median"]),
        f(&r["worldMsPerTick"]),
        f(&r["updatesPerSecond"]["median"]),
        f(&r["kbPerSecond"]["median"]),
        f(&r["updateKB"]["median"]),
        f(&r["inputToUpdateMs"]["median"]),
        f(&r["inputToUpdateMs"]["p99"]),
        f(&r["serverCpuCores"]),
        f(&r["serverMemoryMB"]),
        if r["overBudget"].as_bool() == Some(true) { ", past the budget" } else { "" }
    )
}

/// The median of the repetitions, number by number (the tick's median's spread kept as well).
fn medians(reps: &[Value]) -> Value {
    let ok: Vec<&Value> = reps.iter().filter(|r| r.get("error").is_none()).collect();
    if ok.is_empty() {
        return json!({ "error": "every repetition failed" });
    }
    fn merge(vals: &[&Value]) -> Value {
        match vals[0] {
            Value::Object(first) => {
                let mut out = serde_json::Map::new();
                for k in first.keys() {
                    let sub: Vec<&Value> = vals.iter().filter_map(|v| v.get(k)).collect();
                    if sub.len() == vals.len() {
                        out.insert(k.clone(), merge(&sub));
                    }
                }
                Value::Object(out)
            }
            Value::Number(_) => {
                let mut xs: Vec<f64> = vals.iter().filter_map(|v| v.as_f64()).collect();
                xs.sort_by(f64::total_cmp);
                json!(round(pct(&xs, 0.5), 3))
            }
            Value::Bool(_) => json!(vals.iter().filter(|v| v.as_bool() == Some(true)).count() * 2 > vals.len()),
            other => other.clone(),
        }
    }
    let mut m = merge(&ok);
    let mut spread: Vec<f64> = ok.iter().filter_map(|r| r["tickMs"]["median"].as_f64()).collect();
    spread.sort_by(f64::total_cmp);
    if let (Some(lo), Some(hi)) = (spread.first(), spread.last()) {
        m["tickMedianSpread"] = json!([lo, hi]);
    }
    m["reps"] = json!(ok.len());
    m
}

/// The results as Markdown tables, a sweep at a time; with `compare`, that run's numbers beside
/// (another run's results, or the baseline, which keeps them under `loadtest`).
fn summary(results: &Value, compare: Option<&Path>) -> String {
    let theirs: BTreeMap<String, Value> = compare
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| if v.get("loadtest").is_some() { v["loadtest"].clone() } else { v })
        .map(|v| v["points"].as_array().into_iter().flatten().filter_map(|p| Some((p["point"]["key"].as_str()?.to_string(), p["median"].clone()))).collect())
        .unwrap_or_default();
    let mut s = String::new();
    let _ = writeln!(s, "# Load test: {}\n", results["label"].as_str().unwrap_or(""));
    let _ = writeln!(
        s,
        "{} to {}, on {} ({} threads), the server at {} ({}).\n",
        results["started"].as_str().unwrap_or(""),
        results["finished"].as_str().unwrap_or(""),
        results["machine"]["host"].as_str().unwrap_or("this machine"),
        results["machine"]["threads"],
        results["server"]["commit"].as_str().unwrap_or("?"),
        results["server"]["branch"].as_str().unwrap_or("?"),
    );
    if let Some(c) = compare {
        let _ = writeln!(s, "Beside each number, in brackets, the same point in {} ({} matched).\n", c.display(), theirs.len());
    }
    let f = |v: &Value, d: usize| v.as_f64().map_or("-".to_string(), |x| format!("{x:.d$}"));
    let mut sweep = "";
    for p in results["points"].as_array().into_iter().flatten() {
        let title = p["sweep"].as_str().unwrap_or("");
        if title != sweep {
            sweep = title;
            let _ = writeln!(s, "\n## {title}\n");
            let _ = writeln!(
                s,
                "| Point | Bots, players | Tick p50 / p95 / p99 ms | Rules p50 | Updates p50 | World ms a tick | Updates/s | KB/s a client | Update KB | Input to update p50 / p95 / p99 ms | Server cores | Server MB | Machine busy before / during |"
            );
            let _ = writeln!(s, "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
        }
        let m = &p["median"];
        let key = p["point"]["key"].as_str().unwrap_or("");
        let other = theirs.get(key);
        // A number, and with a comparison the same number there.
        let cell = |path: &[&str], d: usize| -> String {
            let pick = |v: &Value| path.iter().fold(v.clone(), |v, k| v[*k].clone());
            let mine = f(&pick(m), d);
            match other.map(pick).filter(Value::is_number) {
                Some(o) => format!("{mine} ({})", f(&o, d)),
                None => mine,
            }
        };
        if m.get("error").is_some() {
            let _ = writeln!(s, "| {} | failed | | | | | | | | | | | |", p["point"]["label"].as_str().unwrap_or(""));
            continue;
        }
        let _ = writeln!(
            s,
            "| {} | {}, {} | {} / {} / {} | {} | {} | {} | {} | {} | {} | {} / {} / {} | {} | {} | {} / {} |",
            p["point"]["label"].as_str().unwrap_or(""),
            f(&m["botsSeen"], 0),
            f(&m["playersSeen"], 0),
            cell(&["tickMs", "median"], 2),
            cell(&["tickMs", "p95"], 2),
            cell(&["tickMs", "p99"], 2),
            cell(&["rulesMs", "median"], 2),
            cell(&["sendMs", "median"], 2),
            cell(&["worldMsPerTick"], 2),
            cell(&["updatesPerSecond", "median"], 1),
            cell(&["kbPerSecond", "median"], 1),
            cell(&["updateKB", "median"], 1),
            cell(&["inputToUpdateMs", "median"], 1),
            cell(&["inputToUpdateMs", "p95"], 1),
            cell(&["inputToUpdateMs", "p99"], 1),
            cell(&["serverCpuCores"], 2),
            cell(&["serverMemoryMB"], 0),
            f(&m["machineBusyBefore"], 2),
            f(&m["machineBusy"], 2),
        );
    }
    s
}

// ---------------------------------------------------------------------------------------------
// The server's CPU and memory, and the machine's load.

/// A process to watch.
struct Proc {
    #[cfg(windows)]
    handle: os::Handle,
    #[cfg(not(windows))]
    pid: u32,
}

impl Proc {
    fn of_child(child: &Child) -> Proc {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            Proc { handle: os::Handle::borrowed(child.as_raw_handle()) }
        }
        #[cfg(not(windows))]
        {
            Proc { pid: child.id() }
        }
    }

    fn open(pid: u32) -> Option<Proc> {
        #[cfg(windows)]
        {
            os::Handle::open(pid).map(|handle| Proc { handle })
        }
        #[cfg(not(windows))]
        {
            Some(Proc { pid })
        }
    }

    /// CPU time it has used, in seconds (all its threads).
    fn cpu_seconds(&self) -> Option<f64> {
        #[cfg(windows)]
        {
            os::cpu_seconds(&self.handle)
        }
        #[cfg(not(windows))]
        {
            os::cpu_seconds(self.pid)
        }
    }

    /// Its memory now and at its most (resident / working set), in bytes.
    fn memory(&self) -> Option<(u64, u64)> {
        #[cfg(windows)]
        {
            os::memory(&self.handle)
        }
        #[cfg(not(windows))]
        {
            os::memory(self.pid)
        }
    }
}

fn own_cpu_seconds() -> Option<f64> {
    os::own_cpu_seconds()
}

/// The machine's (busy, all) CPU seconds over all its cores so far.
fn system_times() -> Option<(f64, f64)> {
    os::system_times()
}

/// The machine's busy share over the next `d`.
async fn system_busy_over(d: Duration) -> Option<f64> {
    let a = system_times()?;
    tokio::time::sleep(d).await;
    let b = system_times()?;
    (b.1 > a.1).then(|| (b.0 - a.0) / (b.1 - a.1))
}

#[cfg(windows)]
mod os {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    impl FileTime {
        /// In seconds (FILETIMEs count 100 ns).
        fn secs(self) -> f64 {
            ((u64::from(self.high) << 32) | u64::from(self.low)) as f64 * 1e-7
        }
    }

    #[repr(C)]
    #[derive(Default)]
    struct MemoryCounters {
        cb: u32,
        page_faults: u32,
        peak_working_set: usize,
        working_set: usize,
        quota_peak_paged_pool: usize,
        quota_paged_pool: usize,
        quota_peak_non_paged_pool: usize,
        quota_non_paged_pool: usize,
        pagefile: usize,
        peak_pagefile: usize,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetProcessTimes(process: *mut c_void, creation: *mut FileTime, exit: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
        fn K32GetProcessMemoryInfo(process: *mut c_void, counters: *mut MemoryCounters, cb: u32) -> i32;
        fn GetSystemTimes(idle: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
        fn GetCurrentProcess() -> *mut c_void;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn SetPriorityClass(process: *mut c_void, class: u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    /// A process's handle: one the Child holds (borrowed), or one opened here (closed on drop).
    pub struct Handle {
        raw: *mut c_void,
        owned: bool,
    }

    // A process handle may be used from any thread.
    unsafe impl Send for Handle {}
    unsafe impl Sync for Handle {}

    impl Handle {
        pub fn borrowed(raw: *mut c_void) -> Handle {
            Handle { raw, owned: false }
        }

        pub fn open(pid: u32) -> Option<Handle> {
            // PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ
            let raw = unsafe { OpenProcess(0x1000 | 0x0010, 0, pid) };
            (!raw.is_null()).then_some(Handle { raw, owned: true })
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            if self.owned {
                unsafe { CloseHandle(self.raw) };
            }
        }
    }

    fn times(raw: *mut c_void) -> Option<f64> {
        let (mut c, mut e, mut k, mut u) = (FileTime::default(), FileTime::default(), FileTime::default(), FileTime::default());
        let ok = unsafe { GetProcessTimes(raw, &mut c, &mut e, &mut k, &mut u) };
        (ok != 0).then(|| k.secs() + u.secs())
    }

    pub fn cpu_seconds(h: &Handle) -> Option<f64> {
        times(h.raw)
    }

    pub fn own_cpu_seconds() -> Option<f64> {
        times(unsafe { GetCurrentProcess() })
    }

    pub fn memory(h: &Handle) -> Option<(u64, u64)> {
        let mut m = MemoryCounters { cb: std::mem::size_of::<MemoryCounters>() as u32, ..MemoryCounters::default() };
        let ok = unsafe { K32GetProcessMemoryInfo(h.raw, &mut m, m.cb) };
        (ok != 0).then_some((m.working_set as u64, m.peak_working_set as u64))
    }

    /// ABOVE_NORMAL_PRIORITY_CLASS: ahead of ordinary work, behind the system's own.
    const ABOVE_NORMAL: u32 = 0x8000;

    pub fn above_normal(child: &std::process::Child) {
        use std::os::windows::io::AsRawHandle;
        unsafe { SetPriorityClass(child.as_raw_handle(), ABOVE_NORMAL) };
    }

    pub fn above_normal_self() {
        unsafe { SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL) };
    }

    pub fn system_times() -> Option<(f64, f64)> {
        let (mut idle, mut kernel, mut user) = (FileTime::default(), FileTime::default(), FileTime::default());
        let ok = unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };
        // The kernel's time includes the idle time.
        (ok != 0).then(|| (kernel.secs() + user.secs() - idle.secs(), kernel.secs() + user.secs()))
    }
}

#[cfg(not(windows))]
mod os {
    /// Clock ticks a second in /proc (Linux's USER_HZ, 100 everywhere it runs).
    const HZ: f64 = 100.0;

    pub fn cpu_seconds(pid: u32) -> Option<f64> {
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            // After the command's name in brackets: state, then utime and stime at 12 and 13.
            let rest = stat.rsplit_once(')')?.1;
            let f: Vec<&str> = rest.split_whitespace().collect();
            return Some((f.get(11)?.parse::<f64>().ok()? + f.get(12)?.parse::<f64>().ok()?) / HZ);
        }
        // macOS: ps says it as [[dd-]hh:]mm:ss.ss.
        let out = std::process::Command::new("ps").args(["-o", "time=", "-p", &pid.to_string()]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let t = text.trim();
        let (days, t) = t.split_once('-').map_or((0.0, t), |(d, r)| (d.parse().unwrap_or(0.0), r));
        let secs = t.split(':').try_fold(0.0, |acc, p| p.parse::<f64>().ok().map(|v| acc * 60.0 + v))?;
        Some(days * 86_400.0 + secs)
    }

    pub fn own_cpu_seconds() -> Option<f64> {
        cpu_seconds(std::process::id())
    }

    /// Raising a process's priority takes privileges here: left as it is.
    pub fn above_normal(_child: &std::process::Child) {}

    pub fn above_normal_self() {}

    pub fn memory(pid: u32) -> Option<(u64, u64)> {
        if let Ok(status) = std::fs::read_to_string(format!("/proc/{pid}/status")) {
            let kb = |key: &str| status.lines().find_map(|l| l.strip_prefix(key)).and_then(|v| v.split_whitespace().next()?.parse::<u64>().ok());
            return Some((kb("VmRSS:")? * 1024, kb("VmHWM:")? * 1024));
        }
        let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &pid.to_string()]).output().ok()?;
        let rss = String::from_utf8_lossy(&out.stdout).trim().parse::<u64>().ok()? * 1024;
        Some((rss, rss))
    }

    pub fn system_times() -> Option<(f64, f64)> {
        let stat = std::fs::read_to_string("/proc/stat").ok()?;
        let cpu: Vec<f64> = stat.lines().next()?.split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
        let all: f64 = cpu.iter().sum();
        // idle and iowait
        let idle = cpu.get(3)? + cpu.get(4).unwrap_or(&0.0);
        Some(((all - idle) / HZ, all / HZ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bots_are_laid_out_on_both_halves_in_groups() {
        let l = layout(4000, 60.0);
        assert_eq!(l.iter().map(|g| g.3).sum::<u32>(), 4000);
        assert!(l.iter().all(|&(team, x, z, n)| n <= GROUP && x.abs() < 52.0 && (8.0..=52.0).contains(&z.abs()) && (team == 0) == (z < 0.0)));
        assert_eq!(layout(32, 60.0).len(), 2);
        assert!(layout(0, 60.0).is_empty());
        assert_eq!(layout(5, 60.0).iter().map(|g| g.3).sum::<u32>(), 5);
        // The arena in the content: the battlefield's 60 m each way.
        assert_eq!(arena_reach(), 60.0);
        assert!(arena().max_players >= 20);
    }

    #[test]
    fn an_input_is_what_the_server_reads() {
        let walking = walk(3, 10, true);
        assert!(walking[0] != 0 || walking[1] != 0, "moving");
        assert!(walking[7] >= 1, "facing somewhere");
        // A second in six stands still.
        let still = (0..360).filter(|&f| walk(0, f, false) == [0; OPEN_INPUT]).count();
        assert!((50..=70).contains(&still), "{still} frames standing");
        // In a fight a swing every second and a half.
        assert_eq!((0..360).filter(|&f| walk(0, f, true)[2] & 4 != 0).count(), 4);
    }

    #[test]
    fn the_server_s_messages_are_read_as_it_writes_them() {
        let state = ClientState {
            k: 0,
            name: "t".into(),
            seq: AtomicU32::new(0),
            sent: (0..RING).map(|_| AtomicU64::new(0)).collect(),
            last_tick: AtomicU64::new(0),
            watching: AtomicBool::new(true),
            welcomed: AtomicBool::new(false),
            rec: Mutex::new(Record::default()),
        };
        state.heard(r#"{"t":"welcome","channel":3,"space":{"kind":"channel","channel":3}}"#, 1, false);
        assert_eq!(state.game().as_deref(), Some("channel 3"));
        state.heard(r#"{"t":"space","space":{"kind":"dungeon","dungeon":"battlefield","name":"The Battlefield","copy":-1}}"#, 2, false);
        assert_eq!(state.game().as_deref(), Some("battlefield -1"));
        for _ in 0..3 {
            state.input(1, false);
        }
        let tick = r#"{"actors":[],"arrows":[],"events":[],"meteors":[],"peers":[{"id":-1000001,"bot":true},{"id":5}],"stats":{"bots":1,"players":1,"ticks":[[1.5,0.5],[2.0,1.0]]},"t":"tick","tick":42,"you":{"ack":2,"id":0}}"#;
        state.heard(tick, nanos() + 1_000_000, true);
        let r = state.rec.lock().unwrap();
        assert_eq!(state.last_tick.load(Ordering::Relaxed), 42);
        assert_eq!(r.last_ack, 2);
        assert_eq!(r.latencies.len(), 2, "two inputs acknowledged");
        assert_eq!(r.peers, vec![2]);
        assert_eq!(r.stats.len(), 1);
        assert_eq!(r.updates, 1);
    }

    #[test]
    fn distributions_and_medians_across_repetitions() {
        let d = dist((1..=100).map(f64::from).collect());
        assert_eq!(d["median"], json!(51.0));
        assert_eq!(d["p99"], json!(100.0));
        let reps =
            [json!({ "tickMs": { "median": 3.0 }, "overBudget": false }), json!({ "tickMs": { "median": 1.0 }, "overBudget": true }), json!({ "error": "x" })];
        let m = medians(&reps);
        assert_eq!(m["reps"], json!(2));
        assert_eq!(m["tickMedianSpread"], json!([1.0, 3.0]));
        assert_eq!(m["tickMs"]["median"], json!(3.0));
        assert!(stamp().ends_with('Z') && stamp().len() == 20);
    }
}
