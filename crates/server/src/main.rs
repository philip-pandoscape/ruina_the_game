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

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use ruina_server::db;
use ruina_server::http::{self, AppState};
use ruina_server::play::{socket, stepping};

struct Args {
    port: u16,
    /// Take connections at every address (`--listen all`), not only from this machine.
    everywhere: bool,
    /// The built game (dist/) to serve, if any.
    static_dir: Option<PathBuf>,
    /// Step each channel's players all at once (`--parallel on`).
    parallel: bool,
}

fn parse_args() -> Args {
    let env_port = std::env::var("PORT").ok().and_then(|p| p.parse().ok());
    let static_dir = std::env::var_os("STATIC_DIR").filter(|d| !d.is_empty()).map(PathBuf::from);
    let everywhere = std::env::var("LISTEN").is_ok_and(|v| v == "all");
    let parallel = std::env::var("PARALLEL").is_ok_and(|v| v == "on");
    let mut a = Args { port: env_port.unwrap_or(7777), everywhere, static_dir, parallel };
    let argv: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i + 1 < argv.len() {
        let v = &argv[i + 1];
        match argv[i].as_str() {
            "--port" => a.port = v.parse().expect("--port needs a number"),
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

fn main() {
    let args = parse_args();
    let on_railway = std::env::var_os("RAILWAY_PROJECT_ID").is_some();
    let dev_login = std::env::var("DEV_LOGIN").is_ok_and(|v| v == "1") && !on_railway;
    let secure_cookies = on_railway || std::env::var("COOKIE_SECURE").is_ok_and(|v| v == "1");
    let admin_users = http::admin_users(&std::env::var("ADMIN_USERS").unwrap_or_default());
    // Faster from a few hundred players a channel; slower below (crates/server/src/play/stepping.rs).
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
