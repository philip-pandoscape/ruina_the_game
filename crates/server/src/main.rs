//! The game server. On one port (crates/server/src/http.rs):
//!   - accounts and the open world, Emberholm, kept in Postgres (when DATABASE_URL is set)
//!   - the game's built files (with --static or STATIC_DIR; in development Vite serves them)
//!
//!   cargo run --release -- --port 7777
//!
//! It listens on this machine only (so Windows' firewall never asks about it) unless started with
//! --listen all or LISTEN=all, as the Docker image is for Railway and `npm run up`.
//!
//! Environment: PORT (Railway sets it; --port wins), LISTEN (all | local), DATABASE_URL, STATIC_DIR,
//! ADMIN_USERS (the accounts, by name, comma-separated, that reach the developer pages and commands),
//! DEV_LOGIN=1 (sign in by name alone, and everyone an admin unless ADMIN_USERS names some: for
//! development; ignored on Railway),
//! COOKIE_SECURE=1 (https without Railway),
//! PARALLEL=on (--parallel on: each channel steps its players all at once on the machine's cores, as
//! many as RAYON_NUM_THREADS says or all of them; play/stepping.rs).
//!
//! The world on several processes (crates/server/src/cluster, docs/deploys.md): --role all (ROLE;
//! the default: everything in this one process, as always), or gate, sim or services, each a
//! process of its own finding the others through the directory in Postgres (DATABASE_URL, needed):
//! --node <id> (NODE_ID; unique among the processes, else the role and a random number),
//! --link <address:port> (LINK_LISTEN: where its links listen; 127.0.0.1 and any free port, or
//! [::]:9000 with --listen all), --advertise <host:port> (LINK_ADVERTISE: where the others dial it;
//! on Railway RAILWAY_PRIVATE_DOMAIN and the link's port), --spaces <a,b> (SPACES: what a sim stands
//! for, as channel:emberholm:1), --lease-ms <ms> (LEASE_MS: a lease's length, 10000; renewed every
//! fifth of it, a sim stopping a fifth before it runs out).

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use ruina_server::cluster::Role;
use ruina_server::cluster::keeper::Timing;
use ruina_server::cluster::roles::{self, Options};
use ruina_server::gate::socket;
use ruina_server::http::{self, AppState};
use ruina_server::sim::stepping;
use ruina_server::store::db;

struct Args {
    port: u16,
    /// Take connections at every address (`--listen all`), not only from this machine.
    everywhere: bool,
    /// The built game (dist/) to serve, if any.
    static_dir: Option<PathBuf>,
    /// Step each channel's players all at once (`--parallel on`).
    parallel: bool,
    /// What this process plays (`--role`): everything, or one role of several processes.
    role: Role,
    node: Option<String>,
    link: Option<String>,
    advertise: Option<String>,
    spaces: Vec<String>,
    lease_ms: Option<u64>,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn list(v: &str) -> Vec<String> {
    v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect()
}

fn parse_args() -> Args {
    let env_port = std::env::var("PORT").ok().and_then(|p| p.parse().ok());
    let static_dir = std::env::var_os("STATIC_DIR").filter(|d| !d.is_empty()).map(PathBuf::from);
    let everywhere = std::env::var("LISTEN").is_ok_and(|v| v == "all");
    let parallel = std::env::var("PARALLEL").is_ok_and(|v| v == "on");
    let mut a = Args {
        port: env_port.unwrap_or(7777),
        everywhere,
        static_dir,
        parallel,
        role: env("ROLE").map(|r| r.parse().unwrap_or_else(|e: String| panic!("ROLE: {e}"))).unwrap_or_default(),
        node: env("NODE_ID"),
        link: env("LINK_LISTEN"),
        advertise: env("LINK_ADVERTISE"),
        spaces: env("SPACES").map(|s| list(&s)).unwrap_or_default(),
        lease_ms: env("LEASE_MS").map(|v| v.parse().expect("LEASE_MS needs a number")),
    };
    let argv: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i + 1 < argv.len() {
        let v = &argv[i + 1];
        match argv[i].as_str() {
            "--port" => a.port = v.parse().expect("--port needs a number"),
            "--role" => a.role = v.parse().unwrap_or_else(|e: String| panic!("{e}")),
            "--node" => a.node = Some(v.clone()),
            "--link" => a.link = Some(v.clone()),
            "--advertise" => a.advertise = Some(v.clone()),
            "--spaces" => a.spaces = list(v),
            "--lease-ms" => a.lease_ms = Some(v.parse().expect("--lease-ms needs a number")),
            "--listen" => {
                a.everywhere = match v.as_str() {
                    "all" => true,
                    "local" => false,
                    _ => panic!("--listen takes all or local"),
                }
            }
            "--static" => a.static_dir = Some(PathBuf::from(v)),
            "--parallel" => {
                a.parallel = match v.as_str() {
                    "on" => true,
                    "off" => false,
                    _ => panic!("--parallel takes on or off"),
                }
            }
            other => panic!("unknown argument {other}"),
        }
        i += 2;
    }
    a
}

/// A process of one role among several (crates/server/src/cluster/roles.rs): its links, its place in
/// the directory, its role's work, and its health and status on its port.
fn run_role(args: Args) {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("start tokio");
    let result = rt.block_on(async move {
        let Some(url) = env("DATABASE_URL") else {
            return Err(std::io::Error::other(format!("--role {} needs DATABASE_URL: the processes find each other through the directory there", args.role)));
        };
        let db = db::connect(&url).await.map_err(std::io::Error::other)?;
        let link = args.link.unwrap_or_else(|| if args.everywhere { "[::]:9000".into() } else { "127.0.0.1:0".into() });
        let link: std::net::SocketAddr =
            link.parse().map_err(|_| std::io::Error::other(format!("--link takes an address and a port (127.0.0.1:9100, [::]:9000), not {link:?}")))?;
        let advertise = args.advertise.or_else(|| env("RAILWAY_PRIVATE_DOMAIN").map(|d| format!("{d}:{}", link.port())));
        let node = args.node.unwrap_or_else(|| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u32(std::process::id());
            format!("{}-{:06x}", args.role, h.finish() & 0xff_ffff)
        });
        let lease = args.lease_ms.map_or_else(Timing::default, |ms| Timing::of(Duration::from_millis(ms)));
        println!("role: {} ({node}), the directory at the database", args.role);
        roles::run(Options { role: args.role, node, link, advertise, spaces: args.spaces, lease, port: args.port, everywhere: args.everywhere }, db).await
    });
    if let Err(e) = result {
        eprintln!("server error: {e}");
        std::process::exit(1);
    }
}

fn main() {
    let args = parse_args();
    if args.role != Role::All {
        return run_role(args);
    }
    let on_railway = std::env::var_os("RAILWAY_PROJECT_ID").is_some();
    let dev_login = std::env::var("DEV_LOGIN").is_ok_and(|v| v == "1") && !on_railway;
    let secure_cookies = on_railway || std::env::var("COOKIE_SECURE").is_ok_and(|v| v == "1");
    let admin_users = http::admin_users(&std::env::var("ADMIN_USERS").unwrap_or_default());
    // Faster from a few hundred players a channel; slower below (crates/server/src/sim/stepping.rs).
    stepping::set_parallel(args.parallel);
    println!("players: {}", if args.parallel { "stepped all at once (--parallel on)" } else { "stepped one after another" });
    if dev_login && admin_users.is_empty() {
        println!("admins: everyone (developer sign-in is on and ADMIN_USERS names nobody)");
    } else if admin_users.is_empty() {
        println!("admins: none (ADMIN_USERS is not set)");
    } else {
        let mut names: Vec<&String> = admin_users.iter().collect();
        names.sort();
        println!("admins: {}", names.iter().map(|n| n.as_str()).collect::<Vec<_>>().join(", "));
    }

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("start tokio");
    let result = rt.block_on(async move {
        let db = match std::env::var("DATABASE_URL") {
            Ok(url) if !url.is_empty() => {
                let pool = db::connect(&url).await.map_err(std::io::Error::other)?;
                db::spawn_housekeeping(pool.clone());
                println!("database: connected{}", if dev_login { " | developer sign-in on (?as=name)" } else { "" });
                Some(pool)
            }
            _ => {
                println!("database: none (DATABASE_URL is not set), so accounts and the open world are off");
                None
            }
        };
        let state = AppState { db, world: socket::Hub::default(), dev_login, admin_users, secure_cookies, failed_logins: Mutex::new(HashMap::new()) };
        http::serve(args.port, args.everywhere, state, args.static_dir).await
    });
    if let Err(e) = result {
        eprintln!("server error: {e}");
        std::process::exit(1);
    }
}
