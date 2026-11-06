//! The game server. On one port (crates/server/src/http.rs):
//!   - accounts and the open world, Emberholm, kept in Postgres (when DATABASE_URL is set)
//!   - the PvP battlefield: thousands of fighters simulated at a fixed tick rate, each connected
//!     player streamed a personal update (unless started with --battle off)
//!   - the game's built files (with --static or STATIC_DIR; in development Vite serves them)
//!
//!   cargo run --release -- --bots 10000 --virtual-clients 10000 --port 7777 --hz 20
//!
//! --virtual-clients N builds a personal update for N bots every tick as if they were connected
//! players, without sending it anywhere. That measures the server cost of a full raid.
//!
//! It listens on this machine only (so Windows' firewall never asks about it) unless started with
//! --listen all or LISTEN=all, as the Docker image is for Railway and `npm run up`.
//!
//! Environment: PORT (Railway sets it; --port wins), LISTEN (all | local), DATABASE_URL, STATIC_DIR,
//! ADMIN_USERS (the accounts, by name, comma-separated, that reach the developer pages and commands),
//! DEV_LOGIN=1 (sign in by name alone, and everyone an admin unless ADMIN_USERS names some: for
//! development; ignored on Railway),
//! COOKIE_SECURE=1 (https without Railway).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use ruina_server::http::{self, AppState};
use ruina_server::play::socket;
use ruina_server::{battle, db};

struct Args {
    /// Run the battlefield at all (--battle off for a server that only hosts the open world).
    battle: bool,
    /// Fighters on the battlefield (at least 2).
    bots: usize,
    virtual_clients: usize,
    port: u16,
    /// Take connections at every address (`--listen all`), not only from this machine.
    everywhere: bool,
    hz: u32,
    /// Monsters to scatter around the players' end of the field. Off unless asked for:
    /// putting them in by default would change every world anybody already runs.
    slimes: usize,
    /// The built game (dist/) to serve, if any.
    static_dir: Option<PathBuf>,
}

fn parse_args() -> Args {
    let env_port = std::env::var("PORT").ok().and_then(|p| p.parse().ok());
    let static_dir = std::env::var_os("STATIC_DIR").filter(|d| !d.is_empty()).map(PathBuf::from);
    let everywhere = std::env::var("LISTEN").is_ok_and(|v| v == "all");
    let mut a = Args { battle: true, bots: 10_000, virtual_clients: 0, port: env_port.unwrap_or(7777), everywhere, hz: 20, slimes: 0, static_dir };
    let argv: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i + 1 < argv.len() {
        let v = &argv[i + 1];
        match argv[i].as_str() {
            "--battle" => a.battle = v != "off",
            "--bots" => a.bots = v.parse().expect("--bots needs a number"),
            "--virtual-clients" => a.virtual_clients = v.parse().expect("--virtual-clients needs a number"),
            "--port" => a.port = v.parse().expect("--port needs a number"),
            "--listen" => {
                a.everywhere = match v.as_str() {
                    "all" => true,
                    "local" => false,
                    _ => panic!("--listen takes all or local"),
                }
            }
            "--hz" => a.hz = v.parse().expect("--hz needs a number"),
            "--slimes" => a.slimes = v.parse().expect("--slimes needs a number"),
            "--static" => a.static_dir = Some(PathBuf::from(v)),
            other => panic!("unknown argument {other}"),
        }
        i += 2;
    }
    a.bots = a.bots.clamp(2, 65_535);
    a.hz = a.hz.clamp(1, 60);
    a
}

fn main() {
    let args = parse_args();
    let on_railway = std::env::var_os("RAILWAY_PROJECT_ID").is_some();
    let dev_login = std::env::var("DEV_LOGIN").is_ok_and(|v| v == "1") && !on_railway;
    let secure_cookies = on_railway || std::env::var("COOKIE_SECURE").is_ok_and(|v| v == "1");
    let admin_users = http::admin_users(&std::env::var("ADMIN_USERS").unwrap_or_default());
    if dev_login && admin_users.is_empty() {
        println!("admins: everyone (developer sign-in is on and ADMIN_USERS names nobody)");
    } else if admin_users.is_empty() {
        println!("admins: none (ADMIN_USERS is not set)");
    } else {
        let mut names: Vec<&String> = admin_users.iter().collect();
        names.sort();
        println!("admins: {}", names.iter().map(|n| n.as_str()).collect::<Vec<_>>().join(", "));
    }

    let battle = if args.battle {
        Some(battle::start(args.bots, args.virtual_clients, args.hz, args.slimes))
    } else {
        println!("battlefield: off (--battle off)");
        None
    };

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
        let state = AppState { db, battle, world: socket::Hub::default(), dev_login, admin_users, secure_cookies, failed_logins: Mutex::new(HashMap::new()) };
        http::serve(args.port, args.everywhere, state, args.static_dir).await
    });
    if let Err(e) = result {
        eprintln!("server error: {e}");
        std::process::exit(1);
    }
}
