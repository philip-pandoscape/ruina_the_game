//! The server's one port: the account API, the two WebSockets (the open world and the PvP
//! battlefield) and, in production, the game's own files. Railway gives a service a single port
//! ($PORT), and serving everything from one address is also what lets the sign-in cookie reach the
//! WebSocket. In development Vite serves the game and forwards /api and /ws here (vite.config.ts).
//!
//!   GET  /api/health    for Railway's health check
//!   GET  /api/me        who you are signed in as (null if nobody)
//!   POST /api/register  {username, password}
//!   POST /api/login     {username, password}
//!   POST /api/logout
//!   POST /api/dev-login {username}   development only (DEV_LOGIN=1): signs in without a password
//!   GET  /ws/world      the open world (server/src/world_socket.rs)
//!   GET  /ws/battle     the PvP battlefield (server/src/net.rs), when the server runs one

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::body::Bytes;
use axum::extract::{State, WebSocketUpgrade};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::serve::ListenerExt;
use axum::{Json, Router};
use serde_json::json;
use sqlx::PgPool;
use tokio::net::TcpListener;
use tower_http::compression::Compression;
use tower_http::services::ServeDir;

use crate::{accounts, net, world_socket};

/// The battlefield's connections, shared with its simulation thread (server/src/main.rs).
pub struct Battle {
    pub registry: net::Registry,
    pub welcome: Bytes,
}

pub struct AppState {
    /// None when no DATABASE_URL was given: the battlefield still works, accounts and the open
    /// world don't.
    pub db: Option<PgPool>,
    pub battle: Option<Battle>,
    pub world: world_socket::Hub,
    /// Sign in by name alone (?as=name in the browser). Never on Railway.
    pub dev_login: bool,
    /// Mark the cookie Secure (served over https).
    pub secure_cookies: bool,
    /// Wrong passwords per name lately, to slow down guessing.
    pub failed_logins: Mutex<HashMap<String, (u32, Instant)>>,
}

pub type App = Arc<AppState>;

pub async fn serve(port: u16, state: AppState, static_dir: Option<PathBuf>) -> std::io::Result<()> {
    let mut router = Router::new()
        .route("/api/health", get(health))
        .route("/api/me", get(accounts::me))
        .route("/api/register", post(accounts::register))
        .route("/api/login", post(accounts::login))
        .route("/api/logout", post(accounts::logout))
        .route("/api/dev-login", post(accounts::dev_login))
        .route("/ws/world", get(world_socket::upgrade))
        .route("/ws/battle", get(battle));
    if let Some(dir) = static_dir {
        println!("serving the game from {}", dir.display());
        router = router.fallback_service(Compression::new(ServeDir::new(dir)));
    }
    let router = router.with_state(Arc::new(state));

    // Both IPv6 and IPv4 where the machine has IPv6 (Railway's private network is IPv6 only).
    let listener = match TcpListener::bind(("::", port)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind(("0.0.0.0", port)).await?,
    };
    println!("listening on http://localhost:{port}");
    // Small, frequent battle updates: don't let the network stack hold them back to batch them.
    let listener = listener.tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    });
    axum::serve(listener, router).await
}

async fn health(State(app): State<App>) -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "database": app.db.is_some(), "battle": app.battle.is_some(), "playing": app.world.count() }))
}

async fn battle(State(app): State<App>, ws: WebSocketUpgrade) -> Response {
    let Some(b) = &app.battle else {
        return (StatusCode::NOT_FOUND, "this server runs no battlefield (start it with --bots)").into_response();
    };
    let (registry, welcome) = (b.registry.clone(), b.welcome.clone());
    ws.on_upgrade(move |socket| net::handle(socket, registry, welcome))
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
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, HeaderValue::from_static(v));
        }
        h
    }

    #[test]
    fn a_page_on_the_same_address_may_connect() {
        assert!(same_origin(&headers(&[("origin", "http://localhost:5173"), ("host", "localhost:5173")])));
        assert!(same_origin(&headers(&[("origin", "https://ruina.up.railway.app"), ("host", "ruina.up.railway.app")])));
        // Not from a page at all (the load test, curl).
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
