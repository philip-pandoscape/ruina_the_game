//! The open world's connection: one per player on Emberholm. src/net/worldLink.ts is the other
//! end.
//!
//! Each character lives in a channel of Emberholm (server/src/channels.rs). Their browser still
//! runs the island's rules and reports the island every few seconds, which the server keeps in
//! Postgres and hands back next time. It also reports where the player is about 20 times a second;
//! the server checks it against the island's ground (server/src/terrain.rs) and relays it to
//! everyone else in the channel, with what each resident has built and who holds which plot.
//!
//! JSON text messages:
//!   server -> browser  welcome {character, account, island, build, savedAt, now, channel, dev,
//!                              estates, claims}
//!                      peers {list: [{id, name, p}]} | estate {id, name, estate} | claims {claims}
//!                      left {id} | correct {x, y, z} | saved {at} | reset | kicked | error {text}
//!   browser -> server  presence {p} | save {save, build?} | build {build} | reset

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use argon2::password_hash::rand_core::{OsRng, RngCore};
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::types::Json;
use sqlx::PgPool;
use tokio::sync::mpsc;

use crate::accounts::{signed_in, Account};
use crate::channels::{estate_of, Channel, Peer, CHANNEL_CAP};
use crate::http::{same_origin, App};
use crate::terrain::{self, Terrain};

/// The biggest message a browser may send (a whole island, with room to grow).
const MAX_MESSAGE: usize = 2 << 20;
/// The biggest presence (a player, their vehicles and packs).
const MAX_PRESENCE: usize = 64 << 10;
/// Saves are written at most this often; one arriving sooner waits, and a newer one replaces it.
const MIN_SAVE_GAP: Duration = Duration::from_secs(1);
/// The server pings this often. Browsers answer pings by themselves, even from a background tab
/// whose timers are throttled, so a connection this quiet for IDLE has gone without saying so.
const PING: Duration = Duration::from_secs(20);
const IDLE: Duration = Duration::from_secs(60);
/// How often everyone hears where everyone else is.
const RELAY: Duration = Duration::from_millis(50);

/// Which connection is playing each character (so a second window takes over from the first),
/// and the channels.
#[derive(Default)]
pub struct Hub {
    live: Mutex<HashMap<i64, (i64, mpsc::Sender<()>)>>,
    channels: Mutex<HashMap<i32, Channel>>,
}

impl Hub {
    fn claim(&self, character: i64, session: i64, kick: mpsc::Sender<()>) {
        if let Some((_, old)) = self.live.lock().unwrap().insert(character, (session, kick)) {
            let _ = old.try_send(());
        }
    }

    fn release(&self, character: i64, session: i64) {
        let mut live = self.live.lock().unwrap();
        if live.get(&character).is_some_and(|(s, _)| *s == session) {
            live.remove(&character);
        }
    }

    /// Players connected right now.
    pub fn count(&self) -> usize {
        self.live.lock().unwrap().len()
    }

    fn with_channel<T>(&self, id: i32, f: impl FnOnce(&mut Channel) -> T) -> T {
        f(self.channels.lock().unwrap().entry(id).or_default())
    }
}

/// Relays everyone's latest presence to their channel, 20 times a second.
pub fn spawn_relay(app: App) {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(RELAY);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            every.tick().await;
            let mut channels = app.world.channels.lock().unwrap();
            for ch in channels.values_mut() {
                if let Some(msg) = ch.take_changed() {
                    ch.send_all(&msg, None);
                }
            }
        }
    });
}

pub async fn upgrade(State(app): State<App>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    let Some(db) = app.db.clone() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "this server has no database").into_response();
    };
    if !same_origin(&headers) {
        return (StatusCode::FORBIDDEN, "wrong origin").into_response();
    }
    let account = match signed_in(&headers, &db).await {
        Ok(Some(a)) => a,
        Ok(None) => return (StatusCode::UNAUTHORIZED, "not signed in").into_response(),
        Err(e) => {
            eprintln!("database error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "database error").into_response();
        }
    };
    ws.max_message_size(MAX_MESSAGE).on_upgrade(move |socket| async move {
        let character = account.character_id;
        let session = (OsRng.next_u64() >> 1) as i64;
        let (kick, kicked) = mpsc::channel(1);
        app.world.claim(character, session, kick);
        if let Err(e) = play(socket, &app, &db, &account, session, kicked).await {
            eprintln!("world connection for {} ended: {e}", account.username);
        }
        app.world.release(character, session);
    })
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum FromBrowser {
    Presence {
        p: Value,
    },
    Save {
        save: Value,
        #[serde(default)]
        build: Option<Value>,
    },
    Build {
        build: Value,
    },
    Reset,
}

type Tx = SplitSink<WebSocket, Message>;

/// Leaves the channel however the connection ends, unless a newer window already took the seat.
struct Seat<'a> {
    app: &'a App,
    channel: i32,
    character: i64,
    session: i64,
}

impl Drop for Seat<'_> {
    fn drop(&mut self) {
        self.app.world.with_channel(self.channel, |ch| {
            if ch.peers.get(&self.character).is_some_and(|p| p.session == self.session) {
                ch.peers.remove(&self.character);
                ch.send_all(&json!({ "t": "left", "id": self.character }).to_string(), None);
            }
        });
    }
}

/// The character's home channel: the one they were given the first time, or the first with room.
async fn home_channel(db: &PgPool, character: i64) -> Result<i32, sqlx::Error> {
    sqlx::query_scalar(
        "UPDATE characters SET home_channel = COALESCE(home_channel, \
           (SELECT c FROM generate_series(1, 100000) AS c \
            WHERE (SELECT count(*) FROM characters WHERE home_channel = c) < $2 ORDER BY c LIMIT 1)) \
         WHERE id = $1 RETURNING home_channel",
    )
    .bind(character)
    .bind(CHANNEL_CAP)
    .fetch_one(db)
    .await
}

/// Reads what everyone who lives in a channel has built, the first time anyone arrives there.
async fn load_channel(app: &App, db: &PgPool, channel: i32) -> Result<(), sqlx::Error> {
    if app.world.with_channel(channel, |ch| ch.loaded) {
        return Ok(());
    }
    let rows: Vec<(i64, String, Option<Json<Value>>)> =
        sqlx::query_as("SELECT id, name, island->'state' FROM characters WHERE home_channel = $1 AND island IS NOT NULL").bind(channel).fetch_all(db).await?;
    app.world.with_channel(channel, |ch| {
        if ch.loaded {
            return;
        }
        for (id, name, state) in rows {
            if let Some(Json(state)) = state {
                ch.set_estate(id, &name, estate_of(&state));
            }
        }
        ch.loaded = true;
    });
    Ok(())
}

/// Tells the channel what changed about this character's estate (and so who holds which plot).
fn publish_estate(app: &App, channel: i32, character: i64, name: &str, state: Option<&Value>) {
    let estate = state.map(estate_of).unwrap_or_else(|| estate_of(&Value::Null));
    app.world.with_channel(channel, |ch| {
        if ch.set_estate(character, name, estate) {
            if let Some(msg) = ch.estate_message(character) {
                ch.send_all(&msg, Some(character));
            }
            ch.send_all(&ch.claims_message(), None);
        }
    });
}

/// Checks a presence and stores it for the relay. Returns where to put the player back if their
/// position can't be right.
fn take_presence(app: &App, channel: i32, character: i64, p: &Value) -> Result<Option<(f64, f64, f64)>, &'static str> {
    let text = p.to_string();
    if !p.is_object() || text.len() > MAX_PRESENCE {
        return Err("That presence is malformed.");
    }
    let pos = &p["pos"];
    let (x, y, z) = (pos["x"].as_f64().unwrap_or(f64::NAN), pos["y"].as_f64().unwrap_or(f64::NAN), pos["z"].as_f64().unwrap_or(f64::NAN));
    let fix = terrain::correction(Terrain::emberholm(), x, y, z, terrain::spawn());
    if fix.is_none() {
        app.world.with_channel(channel, |ch| {
            if let Some(peer) = ch.peers.get_mut(&character) {
                peer.presence = Some(Arc::from(text));
                peer.dirty = true;
            }
        });
    }
    Ok(fix)
}

async fn play(socket: WebSocket, app: &App, db: &PgPool, account: &Account, session: i64, mut kicked: mpsc::Receiver<()>) -> Result<(), String> {
    let character = account.character_id;
    let name = account.character.clone();
    let (mut tx, mut rx) = socket.split();

    let channel = home_channel(db, character).await.map_err(|e| e.to_string())?;
    load_channel(app, db, channel).await.map_err(|e| e.to_string())?;

    // Taking the character over: from here on only this connection's saves are written, so a
    // window it replaced can't write over it.
    let (island, build, saved_at): (Option<Json<Value>>, Option<Json<Value>>, Option<i64>) = sqlx::query_as(
        "UPDATE characters SET live_session = $2 WHERE id = $1 \
         RETURNING island, build, (extract(epoch FROM saved_at) * 1000)::bigint",
    )
    .bind(character)
    .bind(session)
    .fetch_one(db)
    .await
    .map_err(|e| e.to_string())?;
    let island = island.map(|j| j.0);

    // Into the channel.
    let (out, mut outbox) = mpsc::channel::<String>(64);
    let _seat = Seat { app, channel, character, session };
    let (estates, claims, peers) = app.world.with_channel(channel, |ch| {
        ch.peers.insert(character, Peer { session, name: name.clone(), out, presence: None, dirty: false });
        (ch.estates_json(character), ch.claims_json(), ch.presences(character))
    });
    publish_estate(app, channel, character, &name, island.as_ref().and_then(|i| i.get("state")));
    send(
        &mut tx,
        json!({
            "t": "welcome",
            "character": { "id": character, "name": name },
            "account": account.username,
            "island": island,
            "build": build.map(|j| j.0),
            "savedAt": saved_at,
            "now": now_ms(),
            "channel": channel,
            "dev": app.dev_tools,
            "estates": estates,
            "claims": claims,
        }),
    )
    .await?;
    tx.send(Message::Text(peers.into())).await.map_err(|e| e.to_string())?;

    let mut pending: Option<(Value, Option<Value>)> = None;
    let mut last_write = Instant::now() - MIN_SAVE_GAP;
    let mut last_heard = Instant::now();
    let mut last_ping = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    loop {
        tokio::select! {
            msg = rx.next() => {
                let text = match msg {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {
                        last_heard = Instant::now();
                        continue;
                    }
                    Some(Err(e)) => return Err(e.to_string()),
                };
                last_heard = Instant::now();
                match serde_json::from_str::<FromBrowser>(text.as_str()) {
                    Ok(FromBrowser::Presence { p }) => match take_presence(app, channel, character, &p) {
                        Ok(None) => {}
                        Ok(Some((x, y, z))) => send(&mut tx, json!({ "t": "correct", "x": x, "y": y, "z": z })).await?,
                        Err(why) => send(&mut tx, json!({ "t": "error", "text": why })).await?,
                    },
                    Ok(FromBrowser::Save { save, build }) => {
                        if !valid_island(&save) {
                            send(&mut tx, json!({ "t": "error", "text": "That save is malformed." })).await?;
                            continue;
                        }
                        // Everyone else sees what was built straight away (a claimed plot most of all).
                        publish_estate(app, channel, character, &name, save.get("state"));
                        // A build waiting with an older save still counts.
                        let build = build.or_else(|| pending.take().and_then(|(_, b)| b));
                        pending = Some((save, build));
                    }
                    Ok(FromBrowser::Build { build }) => {
                        let result = sqlx::query("UPDATE characters SET build = $3 WHERE id = $1 AND live_session = $2")
                            .bind(character)
                            .bind(session)
                            .bind(Json(build))
                            .execute(db)
                            .await;
                        if let Wrote::Replaced = outcome(result, &mut tx).await? {
                            return replaced(&mut tx).await;
                        }
                    }
                    Ok(FromBrowser::Reset) => {
                        pending = None;
                        let result = sqlx::query("UPDATE characters SET island = NULL, saved_at = now() WHERE id = $1 AND live_session = $2")
                            .bind(character)
                            .bind(session)
                            .execute(db)
                            .await;
                        match outcome(result, &mut tx).await? {
                            Wrote::Yes => {
                                publish_estate(app, channel, character, &name, None);
                                send(&mut tx, json!({ "t": "reset" })).await?
                            }
                            Wrote::Replaced => return replaced(&mut tx).await,
                            Wrote::Failed => {}
                        }
                    }
                    Err(_) => send(&mut tx, json!({ "t": "error", "text": "The server didn't understand that message." })).await?,
                }
            }
            Some(text) = outbox.recv() => tx.send(Message::Text(text.into())).await.map_err(|e| e.to_string())?,
            _ = kicked.recv() => return replaced(&mut tx).await,
            _ = tick.tick() => {
                if last_heard.elapsed() > IDLE {
                    break;
                }
                if last_ping.elapsed() >= PING {
                    last_ping = Instant::now();
                    tx.send(Message::Ping(Bytes::new())).await.map_err(|e| e.to_string())?;
                }
            }
        }

        // The newest save, at most once a second.
        if pending.is_some() && last_write.elapsed() >= MIN_SAVE_GAP {
            let (save, build) = pending.take().unwrap();
            last_write = Instant::now();
            match outcome(write_island(db, character, session, save, build).await, &mut tx).await? {
                Wrote::Yes => send(&mut tx, json!({ "t": "saved", "at": now_ms() })).await?,
                Wrote::Replaced => return replaced(&mut tx).await,
                Wrote::Failed => {}
            }
        }
    }
    // Gone: keep whatever was still waiting to be written.
    if let Some((save, build)) = pending.take() {
        let _ = write_island(db, character, session, save, build).await;
    }
    Ok(())
}

async fn write_island(db: &PgPool, character: i64, session: i64, island: Value, build: Option<Value>) -> Result<sqlx::postgres::PgQueryResult, sqlx::Error> {
    sqlx::query("UPDATE characters SET island = $3, build = COALESCE($4, build), saved_at = now() WHERE id = $1 AND live_session = $2")
        .bind(character)
        .bind(session)
        .bind(Json(island))
        .bind(build.map(Json))
        .execute(db)
        .await
}

enum Wrote {
    Yes,
    /// Another connection has taken the character over.
    Replaced,
    /// The database refused. The browser is told and keeps playing; its next save tries again.
    Failed,
}

async fn outcome(result: Result<sqlx::postgres::PgQueryResult, sqlx::Error>, tx: &mut Tx) -> Result<Wrote, String> {
    match result {
        Ok(r) if r.rows_affected() == 1 => Ok(Wrote::Yes),
        Ok(_) => Ok(Wrote::Replaced),
        Err(e) => {
            eprintln!("could not save: {e}");
            send(tx, json!({ "t": "error", "text": "The server couldn't save just now. It will try again." })).await?;
            Ok(Wrote::Failed)
        }
    }
}

/// Another window took this character over: say so and hang up.
async fn replaced(tx: &mut Tx) -> Result<(), String> {
    let _ = send(tx, json!({ "t": "kicked" })).await;
    let _ = tx.send(Message::Close(None)).await;
    Ok(())
}

/// The minimum a save needs before it's worth keeping: the island's state and where you stood.
fn valid_island(v: &Value) -> bool {
    let finite = |p: &Value, k: &str| p.get(k).and_then(Value::as_f64).is_some_and(f64::is_finite);
    v.get("state").is_some_and(Value::is_object) && v.get("player").is_some_and(|p| ["x", "y", "z", "facing"].iter().all(|k| finite(p, k)))
}

async fn send(tx: &mut Tx, v: Value) -> Result<(), String> {
    tx.send(Message::Text(v.to_string().into())).await.map_err(|e| e.to_string())
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_save_needs_the_island_and_where_you_stood() {
        assert!(valid_island(&json!({ "state": { "version": 3 }, "player": { "x": 1.0, "y": 2.0, "z": -3.5, "facing": 0.2 } })));
        assert!(!valid_island(&json!({ "player": { "x": 1.0, "y": 2.0, "z": -3.5, "facing": 0.2 } })));
        assert!(!valid_island(&json!({ "state": { "version": 3 }, "player": { "x": 1.0, "y": 2.0, "z": "far" } })));
        assert!(!valid_island(&json!("an island")));
    }
}
