//! The server's one port: the account API, the open world's WebSocket and, in production, the
//! game's own files. Railway gives a service a single port
//! ($PORT), and serving everything from one address is also what lets the sign-in cookie reach the
//! WebSocket. In development Vite serves the game and forwards /api and /ws here (vite.config.ts).
//!
//!   GET  /api/health    for Railway's health check
//!   GET  /api/me        who you are signed in as (null if nobody)
//!   POST /api/register  {username, password}
//!   POST /api/login     {username, password}
//!   POST /api/logout
//!   POST /api/dev-login {username}   development only (DEV_LOGIN=1): signs in without a password
//!   GET  /api/characters, POST /api/characters {name}, DELETE /api/characters/{id} {name}
//!                       your characters (crates/server/src/accounts/characters.rs)
//!   POST /api/dev/stop  development only (DEV_LOGIN=1), an admin signed in: stops the server as a
//!                       deploy does (tests)
//!   GET  /ws/world      the open world (crates/server/src/gate/socket.rs); ?character=<id>
//!   /dev/, /design/     the developer pages, for admins only (ADMIN_USERS); "not found" to anyone else

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::serve::ListenerExt;
use axum::{Json, Router};
use serde_json::json;
use sqlx::PgPool;
use tokio::net::TcpListener;
use tower::ServiceBuilder;
use tower_http::compression::Compression;
use tower_http::services::ServeDir;

use crate::accounts::{self, characters};
use crate::gate::{Gate, socket};

pub struct AppState {
    /// None when no DATABASE_URL was given: then accounts and the open world are off.
    pub db: Option<PgPool>,
    /// The gate players' connections come in through (crate::start starts it with the other tiers).
    pub gate: Arc<Gate>,
    /// Sign in by name alone (?as=name in the browser), and everyone an admin. Never on Railway.
    pub dev_login: bool,
    /// The admins, by name (lower case): they reach the developer pages (/dev/, /design/) and the
    /// developer commands (grants, warping time, teleports, starting a life over). ADMIN_USERS.
    pub admin_users: HashSet<String>,
    /// Mark the cookie Secure (served over https).
    pub secure_cookies: bool,
    /// Wrong passwords per name lately, to slow down guessing.
    pub failed_logins: Mutex<HashMap<String, (u32, Instant)>>,
}

pub type App = Arc<AppState>;

/// ADMIN_USERS as a set of names, lower case (names are unique regardless of case).
pub fn admin_users(list: &str) -> HashSet<String> {
    list.split(',').map(|n| n.trim().to_lowercase()).filter(|n| !n.is_empty()).collect()
}

impl AppState {
    /// Whether an account may use the developer pages and commands: one ADMIN_USERS names, or
    /// anyone where developer sign-in is on (development; never on Railway) and ADMIN_USERS names
    /// nobody. Naming admins on a development server leaves everyone else a player, to see the
    /// game as players do.
    pub fn is_admin(&self, account: &accounts::Account) -> bool {
        if self.admin_users.is_empty() { self.dev_login } else { self.admin_users.contains(&account.username.to_lowercase()) }
    }

    /// The account as the browser is told about it: whether it's an admin, filled in.
    pub fn told(&self, mut account: accounts::Account) -> accounts::Account {
        account.admin = self.is_admin(&account);
        account
    }
}

/// How long a browser may keep each of the game's files. The build names every script, style,
/// picture and model in /assets/ after what's in it, so a file there never changes: kept a year,
/// never asked about again. Everything else (the pages, which name those files) is asked about each
/// time, and answered "not modified" (304) unless it changed, so a new build reaches everyone at once.
async fn cache_headers(request: Request, next: Next) -> Response {
    let named_by_content = request.uri().path().starts_with("/assets/");
    let mut response = next.run(request).await;
    if response.status().is_success() || response.status() == StatusCode::NOT_MODIFIED {
        let value = if named_by_content { "public, max-age=31536000, immutable" } else { "no-cache" };
        response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    }
    response
}

/// The built game's files from `dir`: cached as `cache_headers` says, compressed (brotli or gzip, as
/// the browser takes), the developer pages only for admins.
fn game_files(app: App, dir: PathBuf) -> Router<App> {
    Router::new().fallback_service(
        ServiceBuilder::new()
            .layer(middleware::from_fn(cache_headers))
            .layer(middleware::from_fn_with_state(app, admin_pages))
            .service(Compression::new(ServeDir::new(dir))),
    )
}

/// The developer pages, /dev/ and /design/, for admins only: anyone else gets "not found", as if
/// they weren't there. The game's own files pass straight through.
async fn admin_pages(State(app): State<App>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let guarded = ["/dev", "/design"].iter().any(|p| path == *p || path.starts_with(&format!("{p}/")));
    if guarded {
        let admin = match &app.db {
            Some(db) => matches!(accounts::signed_in(request.headers(), db).await, Ok(Some(a)) if app.is_admin(&a)),
            None => app.dev_login && app.admin_users.is_empty(),
        };
        if !admin {
            return (StatusCode::NOT_FOUND, "Not found").into_response();
        }
    }
    next.run(request).await
}

pub async fn serve(port: u16, everywhere: bool, state: AppState, static_dir: Option<PathBuf>) -> std::io::Result<()> {
    let mut router = Router::new()
        .route("/api/health", get(health))
        .route("/api/me", get(accounts::me))
        .route("/api/register", post(accounts::register))
        .route("/api/login", post(accounts::login))
        .route("/api/logout", post(accounts::logout))
        .route("/api/dev-login", post(accounts::dev_login))
        .route("/api/characters", get(characters::list).post(characters::create))
        .route("/api/characters/{id}", delete(characters::delete))
        .route("/api/dev/stop", post(dev_stop))
        .route("/ws/world", get(socket::upgrade));
    let app = Arc::new(state);
    if let Some(dir) = static_dir {
        println!("serving the game from {}", dir.display());
        router = router.merge(game_files(app.clone(), dir));
    }
    let saver = app.clone();
    let asker = app.clone();
    let router = router.with_state(app);

    let listener = Listeners::open(port, everywhere)?;
    if everywhere {
        println!("listening on http://localhost:{port} (and every address this machine has)");
    } else {
        println!("listening on http://localhost:{port} (this machine only; --listen all for other machines)");
    }
    // Small, frequent updates (the world's ticks): don't let the network stack hold them back to
    // batch them.
    let listener = listener.tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    });
    // Stopped (Railway stops the old server when a new one is up): everyone hears the game is being
    // updated, their lives are written, so nothing since the last save is lost, and their
    // connections close as a service restart; their browsers come back on the new server.
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            tokio::select! {
                _ = stopped() => {}
                _ = asker.gate.stop_asked() => {}
            }
            println!("stopping: telling everyone, saving everyone's life");
            saver.gate.stop_world().await;
        })
        .await
}

/// Where the server takes its connections: one socket at every address, or this machine's own two
/// (IPv4 and IPv6). Accepts from whichever has a connection waiting.
pub struct Listeners(Vec<TcpListener>);

impl Listeners {
    /// Every address (`everywhere`: Railway, and inside Docker, where the port is passed on from
    /// outside), or this machine only. On this machine only, Windows' firewall has nothing to ask
    /// about, so starting a server (the tests start several) brings up no prompt.
    pub fn open(port: u16, everywhere: bool) -> std::io::Result<Listeners> {
        if everywhere {
            return Ok(Listeners(vec![listen_everywhere(port)?]));
        }
        // IPv6's loopback too where there is one: `localhost` is ::1 first on Windows and in Node.
        let mut all = vec![std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))?];
        if let Ok(v6) = std::net::TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, port)) {
            all.push(v6);
        }
        let mut open = Vec::with_capacity(all.len());
        for l in all {
            l.set_nonblocking(true)?;
            open.push(TcpListener::from_std(l)?);
        }
        Ok(Listeners(open))
    }
}

impl axum::serve::Listener for Listeners {
    type Io = tokio::net::TcpStream;
    type Addr = std::net::SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let waiting = self.0.iter().map(|l| Box::pin(l.accept()));
            match futures_util::future::select_all(waiting).await.0 {
                Ok(conn) => return conn,
                // As axum's own listener does: an accept that fails (out of file handles, say) is
                // tried again a moment later rather than stopping the server.
                Err(_) => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.0[0].local_addr()
    }
}

/// Listens on `port` at every address: IPv6 and IPv4 alike where the machine has IPv6 (Railway's
/// private network is IPv6 only), IPv4 where it doesn't. Linux opens an IPv6 socket to IPv4 too
/// unless told otherwise; Windows is the other way round, so it's asked for.
fn listen_everywhere(port: u16) -> std::io::Result<TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let dual = || -> std::io::Result<std::net::TcpListener> {
        let s = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP))?;
        s.set_only_v6(false)?;
        // As TcpListener::bind does on Unix: a restarted server can take its port straight back.
        #[cfg(unix)]
        s.set_reuse_address(true)?;
        s.bind(&std::net::SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, port)).into())?;
        s.listen(1024)?;
        Ok(s.into())
    };
    let std = match dual() {
        Ok(l) => l,
        Err(_) => std::net::TcpListener::bind(("0.0.0.0", port))?,
    };
    std.set_nonblocking(true)?;
    TcpListener::from_std(std)
}

/// Resolves when the server is asked to stop (Ctrl-C, or SIGTERM from Docker and Railway).
pub(crate) async fn stopped() {
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

async fn health(State(app): State<App>) -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "database": app.db.is_some(), "playing": app.gate.count() }))
}

/// Development only (DEV_LOGIN=1): stops the server the way a deploy does, so tests can watch
/// browsers ride out an update. Whoever runs the server starts it again.
async fn dev_stop(State(app): State<App>, headers: HeaderMap) -> Result<Json<serde_json::Value>, ApiError> {
    if !app.dev_login {
        return Err(ApiError(StatusCode::NOT_FOUND, "Developer tools are off on this server."));
    }
    let db = app.db.as_ref().ok_or(ApiError(StatusCode::SERVICE_UNAVAILABLE, "No database on this server."))?;
    match accounts::signed_in(&headers, db).await? {
        Some(a) if app.is_admin(&a) => {}
        Some(_) => return Err(ApiError(StatusCode::FORBIDDEN, "Only an admin can stop the server.")),
        None => return Err(ApiError(StatusCode::UNAUTHORIZED, "Sign in first.")),
    }
    app.gate.ask_to_stop();
    Ok(Json(json!({ "ok": true })))
}

/// True when a browser's request comes from a page on this same address, or from no page at all.
/// Cookies ride along on WebSocket connections, so without this another site could open one in
/// your name. The address is the Host header, or the one a proxy in front says it forwarded
/// (pages can't set either on a WebSocket handshake).
pub fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let Some(origin_host) = origin.split_once("://").map(|(_, rest)| rest.trim_end_matches('/')) else {
        return false;
    };
    [header::HOST.as_str(), "x-forwarded-host"]
        .iter()
        .filter_map(|h| headers.get(*h).and_then(|v| v.to_str().ok()))
        .any(|host| host.eq_ignore_ascii_case(origin_host))
}

/// An API failure: the status and a sentence the sign-in screen can show as it is.
pub struct ApiError(pub StatusCode, pub &'static str);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        eprintln!("database error: {e}");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "The server couldn't reach its database. Try again in a moment.")
    }
}

pub fn database(app: &AppState) -> Result<&PgPool, ApiError> {
    app.db.as_ref().ok_or(ApiError(StatusCode::SERVICE_UNAVAILABLE, "This server has no database, so accounts are off (set DATABASE_URL)."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    #[tokio::test]
    async fn hashed_files_are_kept_a_year_and_pages_are_asked_about_each_time() {
        let dir = std::env::temp_dir().join(format!("ruina-files-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("index.html"), "<!doctype html>").unwrap();
        std::fs::write(dir.join("assets").join("main-Ab12.js"), "export {}".repeat(200)).unwrap();
        let app = Arc::new(state(false, ""));
        let files = game_files(app.clone(), dir.clone()).with_state(app);
        let get = |path: &str, accept: &str| Request::builder().uri(path).header(header::ACCEPT_ENCODING, accept).body(axum::body::Body::empty()).unwrap();
        let script = files.clone().oneshot(get("/assets/main-Ab12.js", "br, gzip")).await.unwrap();
        assert_eq!(script.headers()[header::CACHE_CONTROL], "public, max-age=31536000, immutable");
        assert_eq!(script.headers()[header::CONTENT_ENCODING], "br");
        let page = files.clone().oneshot(get("/index.html", "gzip")).await.unwrap();
        assert_eq!(page.headers()[header::CACHE_CONTROL], "no-cache");
        // The developer pages stay hidden, and say nothing about caching.
        let hidden = files.oneshot(get("/dev/library.html", "gzip")).await.unwrap();
        assert_eq!(hidden.status(), StatusCode::NOT_FOUND);
        assert!(hidden.headers().get(header::CACHE_CONTROL).is_none());
        std::fs::remove_dir_all(dir).ok();
    }

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, HeaderValue::from_static(v));
        }
        h
    }

    fn state(dev_login: bool, admins: &str) -> AppState {
        let post = crate::post::Post::new();
        let gate = Gate::start(ruina_world_api::GateId(1), post.clone(), post.open_gate(ruina_world_api::GateId(1)));
        AppState { db: None, gate, dev_login, admin_users: admin_users(admins), secure_cookies: false, failed_logins: Mutex::new(HashMap::new()) }
    }

    fn account(name: &str) -> accounts::Account {
        accounts::Account { id: 1, username: name.into(), admin: false }
    }

    #[tokio::test]
    async fn admins_are_the_names_admin_users_gives_whatever_their_case() {
        let app = state(false, " Philip, ana ,,");
        assert_eq!(app.admin_users.len(), 2);
        assert!(app.is_admin(&account("philip")));
        assert!(app.is_admin(&account("PHILIP")));
        assert!(app.is_admin(&account("Ana")));
        assert!(!app.is_admin(&account("bo")));
        // What the browser is told carries it.
        assert!(app.told(account("Philip")).admin);
        assert!(!app.told(account("bo")).admin);
    }

    #[tokio::test]
    async fn nobody_is_an_admin_without_admin_users_but_everyone_is_with_developer_sign_in() {
        assert!(!state(false, "").is_admin(&account("philip")));
        assert!(state(true, "").is_admin(&account("anyone")));
    }

    #[tokio::test]
    async fn admin_users_on_a_development_server_leaves_everyone_else_a_player() {
        // How a developer (or a test) sees the game as a player does.
        let app = state(true, "boss");
        assert!(app.is_admin(&account("Boss")));
        assert!(!app.is_admin(&account("anyone")));
    }

    #[test]
    fn a_page_on_the_same_address_may_connect() {
        assert!(same_origin(&headers(&[("origin", "http://localhost:5173"), ("host", "localhost:5173")])));
        assert!(same_origin(&headers(&[("origin", "https://ruina.up.railway.app"), ("host", "ruina.up.railway.app")])));
        // Not from a page at all (curl, a script).
        assert!(same_origin(&headers(&[("host", "localhost:7777")])));
    }

    #[test]
    fn a_proxy_may_say_which_address_it_forwarded() {
        assert!(same_origin(&headers(&[("origin", "https://ruina.example"), ("host", "10.0.0.7:8080"), ("x-forwarded-host", "ruina.example")])));
    }

    #[test]
    fn another_site_may_not() {
        assert!(!same_origin(&headers(&[("origin", "https://evil.example"), ("host", "ruina.up.railway.app")])));
        assert!(!same_origin(&headers(&[("origin", "http://localhost:5173"), ("host", "localhost:7777")])));
        assert!(!same_origin(&headers(&[("origin", "null"), ("host", "localhost:7777")])));
    }
}
