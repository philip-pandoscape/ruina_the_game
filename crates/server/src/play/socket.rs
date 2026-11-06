//! The open world's connection: one per player on Emberholm. src/net/worldLink.ts is the other
//! end.
//!
//! Each character lives in a channel of Emberholm, and the server plays it (crates/server/src/play/mod.rs):
//! the browser sends only what its player presses and what they ask their island to do, and hears
//! back, 20 times a second, where it really is, what its island holds, and everyone else in the
//! channel. Islands are kept in Postgres, written by the server from its own copy.
//!
//! /ws/world?character=<id> plays that character, if it's the signed-in account's; without one, the
//! character the account played last.
//!
//!   server -> browser  (text) welcome {protocol, character, account, build, now, channel, dev, estates, claims,
//!                            space: where you are (a channel, or your party's copy of a dungeon)}
//!                      tick {tick, you, peers, actors, arrows, meteors, events, lifeEvents?, life?,
//!                            tables?: the mini-game tables near you, as everyone sees them}
//!                      estate {id, name, estate} | claims {claims} | left {id} | saved {at}
//!                      | challenges {sent, waiting}: your challenge out, and one waiting for your answer
//!                      | table {table}: the game at your table as you may see it (null: you're up)
//!                      | space {space}: you've gone into a dungeon's copy, or back out (crates/server/src/play/spaces.rs)
//!                      | party {party|null}: your party as it is now | partyInvite {invite|null}
//!                      | notice {text}: something to read
//!                      | reset | kicked | error {text}
//!                      | updating: the server is stopping for an update; once the island is
//!                        written, the connection closes with 1012 (service restart)
//!   browser -> server  (binary) inputs: 7, count, then per input a u32 sequence number and 10 bytes
//!                      (src/net/netPlayer.ts quantize)
//!                      (text) cmd {s, c} | build {build} | reset
//!                      | challenge {to, game, stake, seed?, turn?} | withdraw | answer {from, accept}
//!                      | move {table, m} | concede {table}   (mini-games, crates/server/src/play/tables.rs)
//!                      | dungeon {id, enter}: through a dungeon's portal, or back out of it
//!                      | partyInvite {to?, name?} | partyAnswer {from, accept} | partyLeave
//!                      | partyKick {id} | partyLead {id}   (parties, crates/server/src/play/parties.rs)

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use argon2::password_hash::rand_core::{OsRng, RngCore};
use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade, close_code};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::types::Json;
use tokio::sync::{Notify, mpsc, watch};

use crate::accounts::characters;
use crate::accounts::{Account, signed_in};
use crate::combat::OPEN_INPUT;
use crate::http::{App, same_origin};
use crate::life::Command;
use crate::play::channels::CHANNEL_CAP;
use crate::play::spaces::Spaces;
use crate::play::{Arrival, ChannelGame, Save, TICK_HZ};
use crate::player::Build;
use crate::skills::{SKILL_WORDS, valid_build, valid_movement};
use crate::tuning::{HOTBAR_SLOTS, MOVEMENT_SLOTS, NO_ABILITY, NO_MOVEMENT};

/// The biggest message a browser may send.
const MAX_MESSAGE: usize = 64 << 10;
/// The server pings this often. Browsers answer pings by themselves, even from a background tab
/// whose timers are throttled, so a connection this quiet for IDLE has gone without saying so.
const PING: Duration = Duration::from_secs(20);
const IDLE: Duration = Duration::from_secs(60);
/// Inputs in one binary message, at most.
const MAX_BATCH: usize = 32;
const SEND_INPUTS: u8 = 7;
/// What this server speaks. A page that speaks something else is out of date: it reloads
/// (src/net/worldLink.ts WORLD_PROTOCOL).
pub const WORLD_PROTOCOL: u32 = 8;

/// Where the server is in its life. Railway starts a new server for an update, then stops this one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Running,
    /// Stopping: every browser has been told the server is being updated, and the islands are
    /// being written. Nobody new comes in.
    Updating,
    /// The islands are written: every connection closes as a service restart (1012).
    Closing,
}

/// Which connection is playing each character (so a second window takes over from the first),
/// the channels, dungeons and parties (crate::play::spaces), and whether the server is stopping.
pub struct Hub {
    live: Mutex<HashMap<i64, (i64, mpsc::Sender<()>)>>,
    spaces: Mutex<Spaces>,
    stage: watch::Sender<Stage>,
    /// Asked to stop the way SIGTERM asks (the developer endpoint, for tests).
    stop: Notify,
    /// The one queue islands are written from, in the order they were taken (spawn_world): a
    /// list is written in one transaction. Islands are queued with the channels locked, so an
    /// older copy of an island can never be written over a newer one.
    saver: Mutex<Option<mpsc::UnboundedSender<Vec<Save>>>>,
}

impl Default for Hub {
    fn default() -> Self {
        Hub { live: Mutex::default(), spaces: Mutex::default(), stage: watch::channel(Stage::Running).0, stop: Notify::new(), saver: Mutex::default() }
    }
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

    /// Whether a connection is playing this character right now.
    pub fn is_playing(&self, character: i64) -> bool {
        self.live.lock().unwrap().contains_key(&character)
    }

    /// Everyone's games, the dungeons' copies and the parties, locked for one change.
    fn with_spaces<T>(&self, f: impl FnOnce(&mut Spaces) -> T) -> T {
        // A connection that failed halfway through a change mustn't stop everyone else's.
        let mut spaces = self.spaces.lock().unwrap_or_else(|e| e.into_inner());
        if spaces.saver.is_none() {
            spaces.saver = self.saver();
        }
        f(&mut spaces)
    }

    fn with_channel<T>(&self, id: i32, f: impl FnOnce(&mut ChannelGame) -> T) -> T {
        self.with_spaces(|sp| f(sp.channel(id)))
    }

    /// The game a character is playing in right now (a channel, or a dungeon's copy), if any.
    fn with_member<T>(&self, character: i64, f: impl FnOnce(&mut ChannelGame) -> T) -> Option<T> {
        self.with_spaces(|sp| sp.game_of(character).map(f))
    }

    fn saver(&self) -> Option<mpsc::UnboundedSender<Vec<Save>>> {
        self.saver.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// A character is gone for good (deleted): their estate comes down in their channel, if that
    /// channel is running (one that isn't reads its residents without them when it starts).
    pub fn remove_resident(&self, channel: i32, character: i64) {
        let mut spaces = self.spaces.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ch) = spaces.games.get_mut(&channel) {
            ch.remove_resident(character);
        }
        // Out of their party too.
        spaces.forget(character);
    }

    pub fn stage(&self) -> Stage {
        *self.stage.borrow()
    }

    /// Stops the server the way SIGTERM does (the developer endpoint).
    pub fn ask_to_stop(&self) {
        self.stop.notify_one();
    }

    /// Resolves once ask_to_stop is called.
    pub async fn stop_asked(&self) {
        self.stop.notified().await
    }
}

/// Plays every channel with anyone in it (or a game going on), TICK_HZ times a second, on a
/// thread of its own; and writes the islands that are due a save.
pub fn spawn_world(app: App) {
    let (saves_tx, mut saves_rx) = mpsc::unbounded_channel::<Vec<Save>>();
    *app.world.saver.lock().unwrap_or_else(|e| e.into_inner()) = Some(saves_tx.clone());
    if let Some(db) = app.db.clone() {
        tokio::spawn(async move {
            while let Some(batch) = saves_rx.recv().await {
                match write_islands(&db, &batch).await {
                    Ok(written) => {
                        for (s, ok) in batch.iter().zip(written) {
                            if let (true, Some(out)) = (ok, &s.out) {
                                let _ = out.try_send(json!({ "t": "saved", "at": now_ms() }).to_string());
                            }
                        }
                    }
                    Err(e) => eprintln!("could not save characters {:?}: {e}", batch.iter().map(|s| s.character).collect::<Vec<_>>()),
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
                    let mut spaces = hub.world.spaces.lock().unwrap_or_else(|e| e.into_inner());
                    if spaces.saver.is_none() {
                        spaces.saver = Some(saves_tx.clone());
                    }
                    for ch in spaces.games.values_mut() {
                        if ch.has_players() || ch.has_tables() {
                            // One channel's bad moment mustn't stop all the others.
                            let id = ch.id;
                            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ch.step(&mut saves))).is_err() {
                                eprintln!("channel {id} failed a tick");
                            }
                        }
                        // Games paid out before the channel had the queue (it hands them over
                        // itself as they're paid): both islands together.
                        for batch in ch.take_joint() {
                            let _ = saves_tx.send(batch);
                        }
                    }
                    // Copies of dungeons long empty close; whoever is in one that isn't theirs is put out.
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| spaces.sweep(Instant::now()))).is_err() {
                        eprintln!("the dungeons' sweep failed");
                    }
                    // Queued with the channels still locked, so they're in the order they were taken.
                    for s in saves.drain(..) {
                        let _ = saves_tx.send(vec![s]);
                    }
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

/// The server is stopping (Railway stops the old server once the new one is up, and DEV_LOGIN's
/// /api/dev/stop does the same). Everyone hears that the game is being updated, so their browser
/// freezes the world; a moment later, once inputs already on their way have landed, their islands
/// are written; then their connections close as a service restart (1012), and their browsers come
/// back, on the new server, to where they were.
pub async fn stop_world(app: &App) {
    app.world.stage.send_replace(Stage::Updating);
    tokio::time::sleep(Duration::from_millis(200)).await;
    save_everyone(app).await;
    app.world.stage.send_replace(Stage::Closing);
    // A moment for the connections to close properly.
    let deadline = Instant::now() + Duration::from_secs(3);
    while app.world.count() > 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Writes the island of everyone playing right now (the server is stopping).
pub async fn save_everyone(app: &App) {
    let Some(db) = app.db.clone() else { return };
    let saves: Vec<Save> = {
        let mut spaces = app.world.spaces.lock().unwrap_or_else(|e| e.into_inner());
        spaces.games.values_mut().flat_map(|ch| ch.islands_now()).collect()
    };
    let mut written = 0;
    for s in saves {
        match write_island(&db, s.character, s.session, s.island).await {
            Ok(r) if r.rows_affected() == 1 => written += 1,
            Ok(_) => {}
            Err(e) => eprintln!("could not save character {} while stopping: {e}", s.character),
        }
    }
    println!("saved {written} islands");
}

/// Which character a browser wants to play (/ws/world?character=<id>).
#[derive(Deserialize)]
pub struct Which {
    character: Option<i64>,
}

pub async fn upgrade(State(app): State<App>, headers: HeaderMap, Query(which): Query<Which>, ws: WebSocketUpgrade) -> Response {
    let Some(db) = app.db.clone() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "this server has no database").into_response();
    };
    if !same_origin(&headers) {
        return (StatusCode::FORBIDDEN, "wrong origin").into_response();
    }
    // Stopping for an update: the browser keeps trying, and finds the new server.
    if app.world.stage() != Stage::Running {
        return (StatusCode::SERVICE_UNAVAILABLE, "the server is restarting").into_response();
    }
    let account = match signed_in(&headers, &db).await {
        Ok(Some(a)) => a,
        Ok(None) => return (StatusCode::UNAUTHORIZED, "not signed in").into_response(),
        Err(e) => {
            eprintln!("database error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "database error").into_response();
        }
    };
    let (character, name) = match characters::pick(&db, account.id, which.character).await {
        Ok(Some(c)) => c,
        Ok(None) => return (StatusCode::NOT_FOUND, "no such character").into_response(),
        Err(e) => {
            eprintln!("database error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "database error").into_response();
        }
    };
    ws.max_message_size(MAX_MESSAGE).on_upgrade(move |socket| async move {
        let session = (OsRng.next_u64() >> 1) as i64;
        let (kick, kicked) = mpsc::channel(1);
        app.world.claim(character, session, kick);
        if let Err(e) = play(socket, &app, &db, &account, (character, name), session, kicked).await {
            eprintln!("world connection for {} ended: {e}", account.username);
        }
        app.world.release(character, session);
    })
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum FromBrowser {
    Cmd {
        s: u32,
        c: Value,
    },
    Build {
        build: Value,
    },
    Reset,
    /// Mini-games (crates/server/src/play/tables.rs): challenge someone, take it back, answer one,
    /// make a move at your table, give the game up.
    Challenge {
        to: i64,
        game: String,
        stake: f64,
        #[serde(default)]
        seed: Option<u32>,
        #[serde(default)]
        turn: Option<f64>,
    },
    Withdraw,
    Answer {
        from: i64,
        accept: bool,
    },
    Move {
        table: u64,
        m: Value,
    },
    Concede {
        table: u64,
    },
    /// Through a dungeon's portal (crates/server/src/play/spaces.rs), or back out of it.
    Dungeon {
        id: String,
        enter: bool,
    },
    /// Into a developer zone, from the Admin menu (admins only: spaces.rs enter_zone), on a side
    /// (the battlefield's), or onto another side there.
    Zone {
        id: String,
        #[serde(default)]
        team: Option<u8>,
    },
    /// Parties (crates/server/src/play/parties.rs): invite someone (by id, or by name), answer an invitation,
    /// leave, remove someone, hand on the lead.
    PartyInvite {
        #[serde(default)]
        to: Option<i64>,
        #[serde(default)]
        name: Option<String>,
    },
    PartyAnswer {
        from: i64,
        accept: bool,
    },
    PartyLeave,
    PartyKick {
        id: i64,
    },
    PartyLead {
        id: i64,
    },
}

type Tx = SplitSink<WebSocket, Message>;

/// Takes the player out of their game however the connection ends (unless a newer window has
/// taken their seat), and saves the island they leave behind.
struct Seat {
    app: App,
    db: PgPool,
    character: i64,
    session: i64,
}

impl Drop for Seat {
    fn drop(&mut self) {
        // Into the queue with everything else, while the channel is still locked: a game paid out
        // a moment later is written after this, never under it.
        let saver = self.app.world.saver();
        let island = self.app.world.with_spaces(|sp| {
            let island = sp.depart(self.character, self.session)?;
            let save = Save { character: self.character, session: self.session, island, out: None };
            match &saver {
                Some(tx) => tx.send(vec![save]).err().map(|e| e.0.into_iter().next().unwrap().island),
                None => Some(save.island),
            }
        });
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
/// movement slots. None if it isn't one, or isn't allowed with `budget` skill points (in the open
/// world, what the character has earned: crate::life::progress::skill_budget).
pub fn parse_build(v: &Value, budget: u32) -> Option<Build> {
    let mut b = Build { weapon: u8::try_from(v.get("weapon")?.as_u64()?).ok()?, ..Build::default() };
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
    (valid_build(&b.skills, b.weapon, &b.abilities, budget) && valid_movement(&b.skills, &b.movement)).then_some(b)
}

async fn play(
    socket: WebSocket,
    app: &App,
    db: &PgPool,
    account: &Account,
    (character, name): (i64, String),
    session: i64,
    mut kicked: mpsc::Receiver<()>,
) -> Result<(), String> {
    let (mut tx, mut rx) = socket.split();
    let mut stage = app.world.stage.subscribe();

    let channel = home_channel(db, character).await.map_err(|e| e.to_string())?;
    load_channel(app, db, channel).await.map_err(|e| e.to_string())?;
    let world = &app.world;

    // Taking the character over: from here on only this connection's saves are written, so a
    // window it replaced can't write over it.
    let (island, build, saved_at): (Option<Json<Value>>, Option<Json<Value>>, Option<i64>) = sqlx::query_as(
        "UPDATE characters SET live_session = $2, last_played_at = now() WHERE id = $1 \
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
    let arrival =
        Arrival { character, session, name: name.clone(), out, dev: app.is_admin(account), island: island.map(|j| j.0), saved_at, now, build: build_json };
    // The build they play with comes back: the one kept, if what they've earned still covers it.
    // Into their home channel, or back into the copy of a dungeon they were in.
    let (estates, claims, build, space) = world.with_spaces(|sp| sp.arrive(channel, arrival));
    let _seat = Seat { app: app.clone(), db: db.clone(), character, session };
    send(
        &mut tx,
        json!({
            "t": "welcome",
            "protocol": WORLD_PROTOCOL,
            "character": { "id": character, "name": name },
            "account": account.username,
            "build": build,
            "now": now,
            "channel": channel,
            "dev": app.is_admin(account),
            "estates": estates,
            "claims": claims,
            "space": space,
        }),
    )
    .await?;
    // The server may have begun stopping while this connection was being set up.
    let mut told = false;
    let now = *stage.borrow_and_update();
    if let Some(done) = stopping(&mut tx, now, &mut told).await? {
        return Ok(done);
    }

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
                            world.with_member(character, |ch| ch.inputs_seen(character, list.into_iter()));
                        }
                    }
                    Some(Ok(Message::Text(text))) => match serde_json::from_str::<FromBrowser>(text.as_str()) {
                        Ok(FromBrowser::Cmd { s, c }) => match serde_json::from_value::<Command>(c) {
                            Ok(c) => {
                                if !world.with_member(character, |ch| ch.command(character, s, c)).unwrap_or(false) {
                                    send(&mut tx, json!({ "t": "error", "text": "That isn't allowed here." })).await?;
                                }
                            }
                            Err(_) => send(&mut tx, json!({ "t": "error", "text": "The server didn't understand that command." })).await?,
                        },
                        Ok(FromBrowser::Build { build }) => {
                            // Checked against the skill points this character has earned so far.
                            if !world.with_member(character, |ch| ch.set_build(character, &build)).unwrap_or(false) {
                                send(&mut tx, json!({ "t": "error", "text": "That build isn't allowed." })).await?;
                                continue;
                            }
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
                        // Starting an island over is a developer command: an admin's only.
                        Ok(FromBrowser::Reset) if !app.is_admin(account) => {}
                        Ok(FromBrowser::Reset) => {
                            let Some(fresh) = world.with_spaces(|sp| sp.reset(character)) else { continue };
                            match outcome(write_island(db, character, session, fresh).await, &mut tx).await? {
                                Wrote::Yes => send(&mut tx, json!({ "t": "reset" })).await?,
                                Wrote::Replaced => return replaced(&mut tx).await,
                                Wrote::Failed => {}
                            }
                        }
                        Ok(FromBrowser::Challenge { to, game, stake, seed, turn }) => {
                            if let Err(text) = world.with_member(character, |ch| ch.challenge_timed(character, to, &game, stake, seed, turn)).unwrap_or_else(|| Err("You aren't playing.".into())) {
                                send(&mut tx, json!({ "t": "error", "text": text })).await?;
                            }
                        }
                        Ok(FromBrowser::Withdraw) => {
                            world.with_member(character, |ch| ch.withdraw(character));
                        }
                        Ok(FromBrowser::Answer { from, accept }) => {
                            if let Err(text) = world.with_member(character, |ch| ch.answer(character, from, accept)).unwrap_or_else(|| Err("You aren't playing.".into())) {
                                send(&mut tx, json!({ "t": "error", "text": text })).await?;
                            }
                        }
                        Ok(FromBrowser::Move { table, m }) => {
                            if let Err(text) = world.with_member(character, |ch| ch.table_move(character, table, &m)).unwrap_or_else(|| Err("You aren't playing.".into())) {
                                send(&mut tx, json!({ "t": "error", "text": text })).await?;
                            }
                        }
                        Ok(FromBrowser::Concede { table }) => {
                            if let Err(text) = world.with_member(character, |ch| ch.concede(character, table)).unwrap_or_else(|| Err("You aren't playing.".into())) {
                                send(&mut tx, json!({ "t": "error", "text": text })).await?;
                            }
                        }
                        Ok(FromBrowser::Zone { id, team }) => {
                            let admin = app.is_admin(account);
                            if let Err(text) = world.with_spaces(|sp| sp.enter_zone(character, &id, admin, team)) {
                                send(&mut tx, json!({ "t": "error", "text": text })).await?;
                            }
                        }
                        Ok(FromBrowser::Dungeon { id, enter }) => {
                            let done = world.with_spaces(|sp| if enter { sp.enter_dungeon(character, &id) } else { sp.leave_dungeon(character) });
                            if let Err(text) = done {
                                send(&mut tx, json!({ "t": "error", "text": text })).await?;
                            }
                        }
                        Ok(FromBrowser::PartyInvite { to, name }) => {
                            if let Err(text) = world.with_spaces(|sp| sp.party_invite(character, to, name.as_deref())) {
                                send(&mut tx, json!({ "t": "error", "text": text })).await?;
                            }
                        }
                        Ok(FromBrowser::PartyAnswer { from, accept }) => {
                            if let Err(text) = world.with_spaces(|sp| sp.party_answer(character, from, accept)) {
                                send(&mut tx, json!({ "t": "error", "text": text })).await?;
                            }
                        }
                        Ok(FromBrowser::PartyLeave) => {
                            if let Err(text) = world.with_spaces(|sp| sp.party_leave(character)) {
                                send(&mut tx, json!({ "t": "error", "text": text })).await?;
                            }
                        }
                        Ok(FromBrowser::PartyKick { id }) => {
                            if let Err(text) = world.with_spaces(|sp| sp.party_kick(character, id)) {
                                send(&mut tx, json!({ "t": "error", "text": text })).await?;
                            }
                        }
                        Ok(FromBrowser::PartyLead { id }) => {
                            if let Err(text) = world.with_spaces(|sp| sp.party_lead(character, id)) {
                                send(&mut tx, json!({ "t": "error", "text": text })).await?;
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
            Ok(()) = stage.changed() => {
                let now = *stage.borrow_and_update();
                if let Some(done) = stopping(&mut tx, now, &mut told).await? {
                    return Ok(done);
                }
            }
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

/// A batch of inputs: 7, the count, then per input a u32 sequence number and the u32 tick (× 16)
/// the browser drew everyone else at (little-endian), and its OPEN_INPUT bytes. None if it isn't one.
fn read_inputs(b: &[u8]) -> Option<Vec<(u32, u32, [u8; OPEN_INPUT])>> {
    const EACH: usize = 8 + OPEN_INPUT;
    if b.len() < 2 || b[0] != SEND_INPUTS {
        return None;
    }
    let n = b[1] as usize;
    if n == 0 || n > MAX_BATCH || b.len() != 2 + n * EACH {
        return None;
    }
    Some(
        (0..n)
            .map(|k| {
                let at = 2 + k * EACH;
                let seq = u32::from_le_bytes(b[at..at + 4].try_into().unwrap());
                let view = u32::from_le_bytes(b[at + 4..at + 8].try_into().unwrap());
                let mut raw = [0u8; OPEN_INPUT];
                raw.copy_from_slice(&b[at + 8..at + EACH]);
                (seq, view, raw)
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

/// Writes a list of islands: one alone, or several in one transaction, so that when a game's pot
/// changes hands both players' islands are kept or neither is. Whether each was written (one a
/// newer window has taken over is that window's to write).
async fn write_islands(db: &PgPool, batch: &[Save]) -> Result<Vec<bool>, sqlx::Error> {
    if let [s] = batch {
        return Ok(vec![write_island(db, s.character, s.session, s.island.clone()).await?.rows_affected() == 1]);
    }
    let mut tx = db.begin().await?;
    let mut written = Vec::new();
    for s in batch {
        let r = sqlx::query("UPDATE characters SET island = $3, saved_at = now() WHERE id = $1 AND live_session = $2")
            .bind(s.character)
            .bind(s.session)
            .bind(Json(&s.island))
            .execute(&mut *tx)
            .await?;
        written.push(r.rows_affected() == 1);
    }
    tx.commit().await?;
    Ok(written)
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

/// The server is stopping for an update. The browser hears it first (`updating`: it freezes the
/// world); once the islands are written it's hung up on as a service restart (1012), and waits for
/// the new server. Some(()) once the connection is closed. `told`: whether it has heard already (a
/// busy connection may only notice the stop once the islands are written, and still hears it first).
async fn stopping(tx: &mut Tx, stage: Stage, told: &mut bool) -> Result<Option<()>, String> {
    if stage == Stage::Running {
        return Ok(None);
    }
    if !*told {
        *told = true;
        send(tx, json!({ "t": "updating" })).await?;
    }
    if stage == Stage::Closing {
        let _ = tx.send(Message::Close(Some(CloseFrame { code: close_code::RESTART, reason: "service restart".into() }))).await;
        return Ok(Some(()));
    }
    Ok(None)
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
            b.extend((seq * 16 + 8).to_le_bytes());
            b.extend([127u8, 0, 1, 0, 0, 0, 0, 0, 0, 127]);
        }
        let list = read_inputs(&b).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].0, 6);
        assert_eq!(list[1].1, 104);
        assert_eq!(list[0].2[9], 127);
        assert!(read_inputs(&b[..b.len() - 1]).is_none());
        assert!(read_inputs(&[SEND_INPUTS, 0]).is_none());
    }

    #[test]
    fn builds_are_read_and_checked() {
        let d = Build::default();
        let ok = json!({ "skills": d.skills, "weapon": d.weapon, "abilities": d.abilities, "movement": d.movement });
        let b = parse_build(&ok, 1).expect("the default build");
        assert_eq!(b.skills, d.skills);
        assert!(parse_build(&json!({ "weapon": "sword" }), 30).is_none());
        assert!(parse_build(&json!("nonsense"), 30).is_none());
        // Only as many skills as the points allow.
        assert!(parse_build(&ok, 0).is_none());
        let three = json!({ "skills": crate::skills::skills_from(&["sword", "cleave", "whirlwind"]), "weapon": 0 });
        assert!(parse_build(&three, 2).is_none());
        assert!(parse_build(&three, 3).is_some());
    }

    fn app() -> App {
        std::sync::Arc::new(crate::http::AppState {
            db: None,
            world: Hub::default(),
            dev_login: true,
            admin_users: Default::default(),
            secure_cookies: false,
            failed_logins: Mutex::new(HashMap::new()),
        })
    }

    #[tokio::test]
    async fn stopping_tells_every_connection_before_it_closes_them() {
        let app = app();
        // What each connection watches (play() subscribes the same way).
        let mut heard = app.world.stage.subscribe();
        assert_eq!(app.world.stage(), Stage::Running);
        let stop = tokio::spawn({
            let app = app.clone();
            async move { stop_world(&app).await }
        });
        heard.changed().await.unwrap();
        assert_eq!(*heard.borrow_and_update(), Stage::Updating, "told before anything closes");
        heard.changed().await.unwrap();
        assert_eq!(*heard.borrow_and_update(), Stage::Closing);
        // Nobody connected: it doesn't hang about waiting for anyone.
        tokio::time::timeout(Duration::from_secs(2), stop).await.expect("stopped promptly").unwrap();
    }

    #[tokio::test]
    async fn the_developer_endpoint_stops_the_server_like_a_deploy() {
        let app = app();
        let asked = tokio::spawn({
            let app = app.clone();
            async move { app.world.stop_asked().await }
        });
        // Asked before or after anyone listens, it isn't lost.
        app.world.ask_to_stop();
        tokio::time::timeout(Duration::from_secs(2), asked).await.expect("heard").unwrap();
    }

    #[test]
    fn deleting_a_character_leaves_channels_nobody_started_alone() {
        let hub = Hub::default();
        hub.remove_resident(4, 99);
        assert!(hub.spaces.lock().unwrap().games.is_empty(), "no channel made just to delete from it");
        assert!(!hub.is_playing(99));
    }
}
