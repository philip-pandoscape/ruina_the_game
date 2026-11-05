//! Accounts and signing in: names with Argon2id password hashes in Postgres, and a session cookie
//! that the game's pages and its WebSocket both carry. The cookie is http-only, so the page's own
//! scripts never see it. An account holds several characters (server/src/characters.rs); registering
//! makes the first, named after the account.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use argon2::password_hash::rand_core::{OsRng, RngCore};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;

use crate::http::{database, ApiError, App, AppState};

pub const COOKIE: &str = "ruina_session";
const SESSION_DAYS: i32 = 30;
/// Wrong passwords allowed per name in FAILURE_WINDOW before it has to wait.
const MAX_FAILURES: u32 = 10;
const FAILURE_WINDOW: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: i64,
    pub username: String,
}

#[derive(Deserialize)]
pub struct Credentials {
    username: String,
    password: String,
}

#[derive(Deserialize)]
pub struct DevLogin {
    username: String,
}

/// Who the browser is signed in as, or null. (Null rather than a 401: not being signed in yet is
/// normal, and a 401 would show up as an error in the browser's console.)
pub async fn me(State(app): State<App>, headers: HeaderMap) -> Result<Json<Option<Account>>, ApiError> {
    let db = database(&app)?;
    Ok(Json(signed_in(&headers, db).await?))
}

pub async fn register(State(app): State<App>, Json(c): Json<Credentials>) -> Result<Response, ApiError> {
    let db = database(&app)?;
    let name = c.username.trim();
    check_name(name)?;
    check_password(&c.password)?;
    let hash = hash_password(c.password).await?;
    let account = create_account(db, name, &hash).await?.ok_or(ApiError(StatusCode::CONFLICT, "That name is taken."))?;
    start_session(&app, db, account).await
}

pub async fn login(State(app): State<App>, Json(c): Json<Credentials>) -> Result<Response, ApiError> {
    let db = database(&app)?;
    let key = c.username.trim().to_lowercase();
    if too_many_failures(&app, &key) {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "Too many wrong passwords. Wait a few minutes, then try again."));
    }
    let row: Option<(i64, String)> = sqlx::query_as("SELECT id, password_hash FROM accounts WHERE username_key = $1").bind(&key).fetch_optional(db).await?;
    // An unknown name takes as long to refuse as a wrong password, so timing doesn't tell anyone
    // which names exist.
    let (id, hash) = row.unwrap_or_else(|| (0, dummy_hash().to_string()));
    let right = c.password.len() <= 1024 && verify_password(c.password, hash).await;
    if !right || id == 0 {
        note_failure(&app, key);
        return Err(ApiError(StatusCode::UNAUTHORIZED, "Wrong name or password."));
    }
    app.failed_logins.lock().unwrap().remove(&key);
    sqlx::query("UPDATE accounts SET last_login_at = now() WHERE id = $1").bind(id).execute(db).await?;
    let account = account_by_id(db, id).await?;
    start_session(&app, db, account).await
}

pub async fn logout(State(app): State<App>, headers: HeaderMap) -> Result<Response, ApiError> {
    if let (Some(db), Some(token)) = (app.db.as_ref(), cookie(&headers, COOKIE)) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1").bind(token_hash(&token)).execute(db).await?;
    }
    Ok(([(header::SET_COOKIE, session_cookie(&app, "", 0))], Json(json!({ "ok": true }))).into_response())
}

/// Development only: signs in by name alone, making the account if it's new. Lets tests and
/// several test windows play as different people without typing passwords (?as=name).
pub async fn dev_login(State(app): State<App>, Json(d): Json<DevLogin>) -> Result<Response, ApiError> {
    if !app.dev_login {
        return Err(ApiError(StatusCode::NOT_FOUND, "Developer sign-in is off on this server."));
    }
    let db = database(&app)?;
    let name = d.username.trim();
    check_name(name)?;
    let existing: Option<i64> = sqlx::query_scalar("SELECT id FROM accounts WHERE username_key = $1").bind(name.to_lowercase()).fetch_optional(db).await?;
    let account = match existing {
        Some(id) => account_by_id(db, id).await?,
        None => {
            // A password nobody knows: the account is only reachable through developer sign-in.
            let hash = hash_password(random_token()).await?;
            create_account(db, name, &hash).await?.ok_or(ApiError(StatusCode::CONFLICT, "That name is taken."))?
        }
    };
    start_session(&app, db, account).await
}

/// The account a request's cookie belongs to, if it's signed in.
pub async fn signed_in(headers: &HeaderMap, db: &PgPool) -> Result<Option<Account>, sqlx::Error> {
    let Some(token) = cookie(headers, COOKIE) else {
        return Ok(None);
    };
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT a.id, a.username FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = $1 AND s.expires_at > now()")
            .bind(token_hash(&token))
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(id, username)| Account { id, username }))
}

/// Makes the account and its first character, named after it, together. None if the name is taken
/// (by another account, or by anyone's character: names show over heads).
async fn create_account(db: &PgPool, name: &str, hash: &str) -> Result<Option<Account>, sqlx::Error> {
    let mut tx = db.begin().await?;
    let id: Option<i64> = sqlx::query_scalar(
        "INSERT INTO accounts (username, username_key, password_hash) VALUES ($1, $2, $3) \
         ON CONFLICT (username_key) DO NOTHING RETURNING id",
    )
    .bind(name)
    .bind(name.to_lowercase())
    .bind(hash)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(id) = id else {
        return Ok(None);
    };
    // Returning without committing takes the account back out.
    if crate::characters::insert(&mut tx, id, name).await?.is_none() {
        return Ok(None);
    }
    tx.commit().await?;
    Ok(Some(Account { id, username: name.to_string() }))
}

async fn account_by_id(db: &PgPool, id: i64) -> Result<Account, sqlx::Error> {
    let (id, username): (i64, String) = sqlx::query_as("SELECT id, username FROM accounts WHERE id = $1").bind(id).fetch_one(db).await?;
    Ok(Account { id, username })
}

async fn start_session(app: &AppState, db: &PgPool, account: Account) -> Result<Response, ApiError> {
    let token = random_token();
    sqlx::query("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))")
        .bind(token_hash(&token))
        .bind(account.id)
        .bind(SESSION_DAYS)
        .execute(db)
        .await?;
    let cookie = session_cookie(app, &token, SESSION_DAYS as i64 * 86_400);
    Ok(([(header::SET_COOKIE, cookie)], Json(account)).into_response())
}

fn session_cookie(app: &AppState, token: &str, max_age: i64) -> String {
    let secure = if app.secure_cookies { "; Secure" } else { "" };
    format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}")
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
        .filter(|v| !v.is_empty())
}

/// Account and character names: 3 to 20 letters, digits, - and _.
pub(crate) fn check_name(name: &str) -> Result<(), ApiError> {
    if !(3..=20).contains(&name.chars().count()) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Names are 3 to 20 characters long."));
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Names use letters, digits, - and _ only."));
    }
    Ok(())
}

fn check_password(password: &str) -> Result<(), ApiError> {
    let n = password.chars().count();
    if n < 8 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Passwords need at least 8 characters."));
    }
    if n > 128 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Passwords can be at most 128 characters."));
    }
    Ok(())
}

// ---------- Guessing ----------

fn too_many_failures(app: &AppState, key: &str) -> bool {
    let mut failed = app.failed_logins.lock().unwrap();
    match failed.get(key) {
        Some((n, since)) if since.elapsed() < FAILURE_WINDOW => *n >= MAX_FAILURES,
        Some(_) => {
            failed.remove(key);
            false
        }
        None => false,
    }
}

fn note_failure(app: &AppState, key: String) {
    let mut failed = app.failed_logins.lock().unwrap();
    if failed.len() > 10_000 {
        failed.retain(|_, (_, since)| since.elapsed() < FAILURE_WINDOW);
    }
    let entry = failed.entry(key).or_insert((0, Instant::now()));
    if entry.1.elapsed() >= FAILURE_WINDOW {
        *entry = (0, Instant::now());
    }
    entry.0 += 1;
}

// ---------- Hashing ----------

/// Argon2 is slow on purpose (tens of milliseconds), so it runs off the threads serving requests.
async fn hash_password(password: String) -> Result<String, ApiError> {
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default().hash_password(password.as_bytes(), &salt).map(|h| h.to_string())
    })
    .await
    .ok()
    .and_then(|r| r.ok())
    .ok_or(ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't set that password."))
}

async fn verify_password(password: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || PasswordHash::new(&hash).is_ok_and(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok()))
        .await
        .unwrap_or(false)
}

/// Something to check unknown names against, so they cost the same as known ones.
fn dummy_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default().hash_password(b"there is no such account", &salt).map(|h| h.to_string()).unwrap_or_default()
    })
}

fn random_token() -> String {
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    raw.iter().map(|b| format!("{b:02x}")).collect()
}

fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn finds_the_session_among_other_cookies() {
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_static("theme=dark; ruina_session=abc123; other=1"));
        assert_eq!(cookie(&h, COOKIE).as_deref(), Some("abc123"));
        h.insert(header::COOKIE, HeaderValue::from_static("ruina_session="));
        assert_eq!(cookie(&h, COOKIE), None);
        assert_eq!(cookie(&HeaderMap::new(), COOKIE), None);
    }

    #[test]
    fn names_are_short_and_plain() {
        assert!(check_name("Philip_9").is_ok());
        assert!(check_name("ab").is_err());
        assert!(check_name("a-name-that-is-far-too-long").is_err());
        assert!(check_name("bad name").is_err());
        assert!(check_name("Ünïcode").is_err());
    }

    #[test]
    fn passwords_hash_and_verify() {
        let salt = SaltString::generate(&mut OsRng);
        let hash = Argon2::default().hash_password(b"lantern-light-42", &salt).unwrap().to_string();
        let parsed = PasswordHash::new(&hash).unwrap();
        assert!(Argon2::default().verify_password(b"lantern-light-42", &parsed).is_ok());
        assert!(Argon2::default().verify_password(b"wrong", &parsed).is_err());
        assert_ne!(token_hash("a"), token_hash("b"));
        assert_eq!(random_token().len(), 64);
    }
}
