//! The open world's connection: one per player on Emberholm. src/net/worldLink.ts is the other
//! end.
//!
//! Each character lives in a channel of Emberholm, and the server plays it (server/src/world_game.rs):
//! the browser sends only what its player presses and what they ask their island to do, and hears
//! back, 20 times a second, where it really is, what its island holds, and everyone else in the
//! channel. Islands are kept in Postgres, written by the server from its own copy.
//!
//!   server -> browser  (text) welcome {character, account, build, now, channel, dev, estates, claims}
//!                      tick {tick, you, peers, actors, arrows, meteors, events, lifeEvents?, life?}
//!                      estate {id, name, estate} | claims {claims} | left {id} | saved {at}
//!                      | reset | kicked | error {text}
//!   browser -> server  (binary) inputs: 7, count, then per input a u32 sequence number and 9 bytes
//!                      (src/net/netPlayer.ts quantize)
//!                      (text) cmd {s, c} | build {build} | reset

use std::collections::HashMap;
use std::sync::Mutex;
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
use crate::channels::CHANNEL_CAP;
use crate::http::{same_origin, App};
use crate::life::Command;
use crate::player::Build;
use crate::skills::{valid_build, SKILL_WORDS};
use crate::tuning::{HOTBAR_SLOTS, MOVEMENT_SLOTS, NO_ABILITY, NO_MOVEMENT};
use crate::world_game::{Arrival, ChannelGame, Save, TICK_HZ};

/// The biggest message a browser may send.
const MAX_MESSAGE: usize = 64 << 10;
/// The server pings this often. Browsers answer pings by themselves, even from a background tab
/// whose timers are throttled, so a connection this quiet for IDLE has gone without saying so.
const PING: Duration = Duration::from_secs(20);
const IDLE: Duration = Duration::from_secs(60);
/// Inputs in one binary message, at most.
const MAX_BATCH: usize = 32;
const SEND_INPUTS: u8 = 7;

/// Which connection is playing each character (so a second window takes over from the first),
/// and the channels.
#[derive(Default)]
pub struct Hub {
    live: Mutex<HashMap<i64, (i64, mpsc::Sender<()>)>>,
    channels: Mutex<HashMap<i32, ChannelGame>>,
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

    fn with_channel<T>(&self, id: i32, f: impl FnOnce(&mut ChannelGame) -> T) -> T {
        f(self.channels.lock().unwrap().entry(id).or_insert_with(|| ChannelGame::new(id)))
    }
}

/// Plays every channel with anyone in it, TICK_HZ times a second, on a thread of its own; and
/// writes the islands that are due a save.
pub fn spawn_world(app: App) {
    let (saves_tx, mut saves_rx) = mpsc::unbounded_channel::<Save>();
    if let Some(db) = app.db.clone() {
        tokio::spawn(async move {
            while let Some(s) = saves_rx.recv().await {
                match write_island(&db, s.character, s.session, s.island).await {
                    Ok(r) if r.rows_affected() == 1 => {
                        if let Some(out) = s.out {
                            let _ = out.try_send(json!({ "t": "saved", "at": now_ms() }).to_string());
                        }
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("could not save character {}: {e}", s.character),
                }
            }
        });
    }
    let hub = app.clone();
    std::thread::Builder::new()
        .name("world".into())
        .spawn(move || {
            let period = Duration::from_secs_f64(1.0 / TICK_HZ as f64);
            let mut next = Instant::now() + period;
            let mut saves = Vec::new();
            loop {
                {
                    let mut channels = hub.world.channels.lock().unwrap();
                    for ch in channels.values_mut() {
                        if ch.has_players() {
                            // One channel's bad moment mustn't stop all the others.
                            let id = ch.id;
                            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ch.step(&mut saves))).is_err() {
                                eprintln!("channel {id} failed a tick");
                            }
                        }
                    }
                }
                for s in saves.drain(..) {
                    let _ = saves_tx.send(s);
                }
                let now = Instant::now();
                if next > now {
                    std::thread::sleep(next - now);
                    next += period;
                } else {
                    next = now + period;
                }
            }
        })
        .expect("start the world thread");
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
    Cmd { s: u32, c: Value },
    Build { build: Value },
    Reset,
}

type Tx = SplitSink<WebSocket, Message>;

/// Takes the player out of the channel however the connection ends (unless a newer window has
/// taken their seat), and saves the island they leave behind.
struct Seat {
    app: App,
    db: PgPool,
    channel: i32,
    character: i64,
    session: i64,
}

impl Drop for Seat {
    fn drop(&mut self) {
        let island = self.app.world.with_channel(self.channel, |ch| ch.leave(self.character, self.session));
        if let Some(island) = island {
            let (db, character, session) = (self.db.clone(), self.character, self.session);
            tokio::spawn(async move {
                if let Err(e) = write_island(&db, character, session, island).await {
                    eprintln!("could not save character {character} on leaving: {e}");
                }
            });
        }
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
    if app.world.with_channel(channel, |ch| ch.estates.loaded) {
        return Ok(());
    }
    let rows: Vec<(i64, String, Option<Json<Value>>)> =
        sqlx::query_as("SELECT id, name, island->'state' FROM characters WHERE home_channel = $1 AND island IS NOT NULL").bind(channel).fetch_all(db).await?;
    app.world.with_channel(channel, |ch| {
        if ch.estates.loaded {
            return;
        }
        for (id, name, state) in rows {
            if let Some(Json(state)) = state {
                ch.add_resident(id, &name, &state);
            }
        }
        ch.estates.loaded = true;
    });
    Ok(())
}

/// A build as the browser keeps it (src/build.ts): the learned skills, weapon, hotbar and
/// movement slots. None if it isn't one, or isn't allowed.
pub fn parse_build(v: &Value) -> Option<Build> {
    let mut b = Build::default();
    b.weapon = u8::try_from(v.get("weapon")?.as_u64()?).ok()?;
    let mut skills = [0u32; SKILL_WORDS];
    for (k, w) in v.get("skills")?.as_array()?.iter().take(SKILL_WORDS).enumerate() {
        skills[k] = u32::try_from(w.as_u64()?).ok()?;
    }
    b.skills = skills;
    let slots = |key: &str, n: usize, empty: u8| -> Option<Vec<u8>> {
        let mut out = vec![empty; n];
        if let Some(list) = v.get(key).and_then(Value::as_array) {
            for (k, a) in list.iter().take(n).enumerate() {
                out[k] = u8::try_from(a.as_u64()?).ok()?;
            }
        }
        Some(out)
    };
    b.abilities.copy_from_slice(&slots("abilities", HOTBAR_SLOTS, NO_ABILITY)?);
    b.movement.copy_from_slice(&slots("movement", MOVEMENT_SLOTS, NO_MOVEMENT)?);
    valid_build(&b.skills, b.weapon, &b.abilities).then_some(b)
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
    let build_json = build.map(|j| j.0);
    let now = now_ms();

    // Into the channel's game.
    let (out, mut outbox) = mpsc::channel::<String>(256);
    let arrival = Arrival {
        character,
        session,
        name: name.clone(),
        out,
        dev: app.dev_tools,
        island: island.map(|j| j.0),
        saved_at,
        now,
        build: build_json.as_ref().and_then(parse_build).unwrap_or_default(),
    };
    let (estates, claims) = app.world.with_channel(channel, |ch| ch.join(arrival));
    let _seat = Seat { app: app.clone(), db: db.clone(), channel, character, session };
    send(
        &mut tx,
        json!({
            "t": "welcome",
            "character": { "id": character, "name": name },
            "account": account.username,
            "build": build_json,
            "now": now,
            "channel": channel,
            "dev": app.dev_tools,
            "estates": estates,
            "claims": claims,
        }),
    )
    .await?;

    let mut last_heard = Instant::now();
    let mut last_ping = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    loop {
        tokio::select! {
            msg = rx.next() => {
                last_heard = Instant::now();
                match msg {
                    Some(Ok(Message::Binary(b))) => {
                        if let Some(list) = read_inputs(&b) {
                            app.world.with_channel(channel, |ch| ch.inputs(character, list.into_iter()));
                        }
                    }
                    Some(Ok(Message::Text(text))) => match serde_json::from_str::<FromBrowser>(text.as_str()) {
                        Ok(FromBrowser::Cmd { s, c }) => match serde_json::from_value::<Command>(c) {
                            Ok(c) => {
                                if !app.world.with_channel(channel, |ch| ch.command(character, s, c)) {
                                    send(&mut tx, json!({ "t": "error", "text": "That isn't allowed here." })).await?;
                                }
                            }
                            Err(_) => send(&mut tx, json!({ "t": "error", "text": "The server didn't understand that command." })).await?,
                        },
                        Ok(FromBrowser::Build { build }) => {
                            let Some(b) = parse_build(&build) else {
                                send(&mut tx, json!({ "t": "error", "text": "That build isn't allowed." })).await?;
                                continue;
                            };
                            app.world.with_channel(channel, |ch| ch.set_build(character, b));
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
                            let Some(fresh) = app.world.with_channel(channel, |ch| ch.reset(character)) else { continue };
                            match outcome(write_island(db, character, session, fresh).await, &mut tx).await? {
                                Wrote::Yes => send(&mut tx, json!({ "t": "reset" })).await?,
                                Wrote::Replaced => return replaced(&mut tx).await,
                                Wrote::Failed => {}
                            }
                        }
                        Err(_) => send(&mut tx, json!({ "t": "error", "text": "The server didn't understand that message." })).await?,
                    },
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e.to_string()),
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
    }
    Ok(())
}

/// A batch of inputs: 7, the count, then per input a u32 sequence number (little-endian) and its
/// 9 bytes. None if it isn't one.
fn read_inputs(b: &[u8]) -> Option<Vec<(u32, [u8; 9])>> {
    if b.len() < 2 || b[0] != SEND_INPUTS {
        return None;
    }
    let n = b[1] as usize;
    if n == 0 || n > MAX_BATCH || b.len() != 2 + n * 13 {
        return None;
    }
    Some(
        (0..n)
            .map(|k| {
                let at = 2 + k * 13;
                let seq = u32::from_le_bytes(b[at..at + 4].try_into().unwrap());
                let mut raw = [0u8; 9];
                raw.copy_from_slice(&b[at + 4..at + 13]);
                (seq, raw)
            })
            .collect(),
    )
}

async fn write_island(db: &PgPool, character: i64, session: i64, island: Value) -> Result<sqlx::postgres::PgQueryResult, sqlx::Error> {
    sqlx::query("UPDATE characters SET island = $3, saved_at = now() WHERE id = $1 AND live_session = $2")
        .bind(character)
        .bind(session)
        .bind(Json(island))
        .execute(db)
        .await
}

enum Wrote {
    Yes,
    /// Another connection has taken the character over.
    Replaced,
    /// The database refused. The browser is told and keeps playing; the next save tries again.
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
    fn inputs_arrive_in_batches() {
        let mut b = vec![SEND_INPUTS, 2];
        for seq in [5u32, 6] {
            b.extend(seq.to_le_bytes());
            b.extend([127u8, 0, 1, 0, 0, 0, 0, 0, 127]);
        }
        let list = read_inputs(&b).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].0, 6);
        assert_eq!(list[0].1[8], 127);
        assert!(read_inputs(&b[..b.len() - 1]).is_none());
        assert!(read_inputs(&[SEND_INPUTS, 0]).is_none());
    }

    #[test]
    fn builds_are_read_and_checked() {
        let d = Build::default();
        let ok = json!({ "skills": d.skills, "weapon": d.weapon, "abilities": d.abilities, "movement": d.movement });
        let b = parse_build(&ok).expect("the default build");
        assert_eq!(b.skills, d.skills);
        assert!(parse_build(&json!({ "weapon": "sword" })).is_none());
        assert!(parse_build(&json!("nonsense")).is_none());
    }
}
