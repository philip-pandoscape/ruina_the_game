//! A player's connection: one per browser window in the world. src/net/worldLink.ts is the other end.
//!
//! Each character lives in a channel of a region, played by a simulation (crates/server/src/sim):
//! the browser sends only what its player presses and what they ask their life to do, and hears
//! back, 20 times a second, where it really is, what its life holds, and everyone else in the
//! space. Lives are kept in Postgres, written by the store from the simulation's copy.
//!
//! On the way in, the connection asks the directory for the character (a newer grant: another
//! window playing them is put out), the store for their life, and the simulation the directory
//! names to take them in; then it sends the welcome. From then on what the browser sends goes to
//! that simulation (or to the social tier, for parties), until the simulation it plays in changes
//! (`Moved`).
//!
//! /ws/world?character=<id> plays that character, if it's the signed-in account's; without one, the
//! character the account played last.
//!
//!   server -> browser  (text) welcome {protocol, content: the content's hash (shared/hash.json), character,
//!                            account, build, now, channel, dev, estates, claims,
//!                            space: where you are (a channel, or your party's copy of a dungeon)}
//!                      tick {tick, you, peers, actors, arrows, meteors, events, lifeEvents?, life?,
//!                            tables?: the mini-game tables near you, as everyone sees them}
//!                      estate {id, name, estate} | claims {claims} | left {id} | saved {at}
//!                      | challenges {sent, waiting}: your challenge out, and one waiting for your answer
//!                      | table {table}: the game at your table as you may see it (null: you're up)
//!                      | space {space}: you've gone into a dungeon's copy, or back out (crates/server/src/sim/host.rs)
//!                      | party {party|null}: your party as it is now | partyInvite {invite|null}
//!                      | notice {text}: something to read
//!                      | reset | kicked | error {text}
//!                      | updating: the server is stopping for an update; once the lives are
//!                        written, the connection closes with 1012 (service restart)
//!   browser -> server  (binary) inputs: 7, count, then per input a u32 sequence number and 10 bytes
//!                      (src/net/netPlayer.ts quantize)
//!                      (text) cmd {s, c} | build {build} | reset
//!                      | challenge {to, game, stake, seed?, turn?} (game: its place in shared/minigames.json)
//!                      | withdraw | answer {from, accept}
//!                      | move {table, m} | concede {table}   (mini-games, crates/server/src/sim/tables.rs)
//!                      | dungeon {id, enter}: through a dungeon's portal, or back out of it
//!                      | partyInvite {to?, name?} | partyAnswer {from, accept} | partyLeave
//!                      | partyKick {id} | partyLead {id}   (parties, crates/server/src/social/parties.rs)

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

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
use tokio::sync::mpsc;

use ruina_world_api::directory::ToDirectory;
use ruina_world_api::gate::{Claimed, Estates, ToConn};
use ruina_world_api::input::{Input, OPEN_INPUT};
use ruina_world_api::sim::{Arrival, Ask, ToSim};
use ruina_world_api::social::ToSocial;
use ruina_world_api::store::ToStore;
use ruina_world_api::{Conn, SimId};

use super::{Event, Gate, Stage, encode};
use crate::accounts::characters;
use crate::accounts::{Account, signed_in};
use crate::content::content_hash;
use crate::http::{App, same_origin};
use crate::life::Command;
use crate::player::Build;
use crate::skills::{SKILL_WORDS, allowed};
use crate::store::now_ms;
use crate::tuning::{HOTBAR_SLOTS, MOVEMENT_SLOTS, NO_ABILITY, NO_MOVEMENT};

/// The biggest message a browser may send.
const MAX_MESSAGE: usize = 64 << 10;
/// The server pings this often. Browsers answer pings by themselves, even from a background tab
/// whose timers are throttled, so a connection this quiet for IDLE has gone without saying so.
const PING: Duration = Duration::from_secs(20);
const IDLE: Duration = Duration::from_secs(60);
/// How long the way in may take (the directory, the store and a simulation each answer once).
const WAY_IN: Duration = Duration::from_secs(15);
/// Inputs in one binary message, at most.
const MAX_BATCH: usize = 32;
const SEND_INPUTS: u8 = 7;
/// What this server speaks. A page that speaks something else is out of date: it reloads
/// (src/net/worldLink.ts WORLD_PROTOCOL). So does a page built from other content (content_hash, in
/// the welcome): what goes on the wire as a place in a bundle's list would mean something else to it.
pub const WORLD_PROTOCOL: u32 = 11;

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
    if app.gate.stage() != Stage::Running {
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
    let admin = app.is_admin(&account);
    ws.max_message_size(MAX_MESSAGE).on_upgrade(move |socket| async move {
        let gate = app.gate.clone();
        let conn = Conn { gate: gate.id, character, session: (OsRng.next_u64() >> 1) as i64 };
        if let Err(e) = play(socket, &gate, &account, conn, name, admin).await {
            eprintln!("world connection for {} ended: {e}", account.username);
        }
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
    /// Mini-games (crates/server/src/sim/tables.rs): challenge someone, take it back, answer one,
    /// make a move at your table, give the game up.
    Challenge {
        to: i64,
        game: usize,
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
    /// Through a dungeon's portal (crates/server/src/sim/host.rs), or back out of it.
    Dungeon {
        id: String,
        enter: bool,
    },
    /// Into a developer zone, from the Admin menu (admins only), on a side (the battlefield's), or
    /// onto another side there.
    Zone {
        id: String,
        #[serde(default)]
        team: Option<u8>,
    },
    /// Parties (crates/server/src/social): invite someone (by id, or by name), answer an invitation,
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

/// A connection's seat in the world: however the connection ends, the simulation it plays in lets
/// the character go (their life is written; a newer window that took their seat keeps it), the
/// directory hears it let go, and the gate forgets it.
pub struct Seat {
    gate: Arc<Gate>,
    pub conn: Conn,
    /// The simulation it plays in now (none until it was taken in).
    pub sim: Option<SimId>,
}

impl Seat {
    pub fn new(gate: Arc<Gate>, conn: Conn, tx: mpsc::Sender<Event>) -> Seat {
        gate.open(conn, tx);
        Seat { gate, conn, sim: None }
    }
}

impl Drop for Seat {
    fn drop(&mut self) {
        let post = &self.gate.post;
        if let Some(sim) = self.sim {
            post.sim(sim, ToSim::Depart { conn: self.conn });
        }
        post.directory(ToDirectory::Release { conn: self.conn });
        self.gate.close(self.conn);
    }
}

/// What a connection's way in found: the grant, the life read and where it was taken in, with the
/// estates of its home channel.
pub struct WayIn {
    pub claimed: Claimed,
    pub build: Value,
    pub space: Value,
    pub estates: Estates,
    /// What came for the connection meanwhile, to go after the welcome.
    pub held: VecDeque<Event>,
}

/// Waits for the message `pick` takes, keeping whatever else comes meanwhile.
async fn wait_for<T>(rx: &mut mpsc::Receiver<Event>, held: &mut VecDeque<Event>, mut pick: impl FnMut(ToConn) -> Result<T, Box<ToConn>>) -> Result<T, String> {
    let deadline = tokio::time::Instant::now() + WAY_IN;
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Err(_) => return Err("the server didn't answer in time".into()),
            Ok(None) => return Err("the gate is gone".into()),
            Ok(Some(Event::Msg(ToConn::Turned { text }))) => return Err(text),
            Ok(Some(Event::Msg(m))) => match pick(m) {
                Ok(t) => return Ok(t),
                Err(other) => held.push_back(Event::Msg(*other)),
            },
            // Ticks before the welcome are of no use: the next come in a moment.
            Ok(Some(Event::Tick(_))) => {}
        }
    }
}

/// The way in: the directory takes the character up for this connection (the seat's), the store
/// reads their life, and the simulation the directory names takes them in.
pub async fn way_in(seat: &mut Seat, rx: &mut mpsc::Receiver<Event>, name: &str, admin: bool) -> Result<WayIn, String> {
    let post = seat.gate.post.clone();
    let conn = seat.conn;
    let mut held = VecDeque::new();
    post.directory(ToDirectory::Claim { conn, name: name.to_string() });
    let claimed = wait_for(rx, &mut held, |m| match m {
        ToConn::Claimed(c) => Ok(*c),
        other => Err(Box::new(other)),
    })
    .await?;
    post.store(ToStore::LoadLife { character: conn.character, reply: conn });
    let (life, build, saved_at) = wait_for(rx, &mut held, |m| match m {
        ToConn::Life { life, build, saved_at } => Ok((life, build, saved_at)),
        other => Err(Box::new(other)),
    })
    .await?;
    let arrival = Arrival {
        conn,
        name: name.to_string(),
        dev: admin,
        epoch: claimed.epoch,
        party: claimed.party,
        home: claimed.home.clone(),
        life,
        build,
        saved_at,
        now: now_ms(),
    };
    seat.sim = Some(claimed.sim);
    if !post.sim(claimed.sim, ToSim::Arrive(Box::new(arrival))) {
        return Err("the place you play in is gone".into());
    }
    let (space, build, estates) = wait_for(rx, &mut held, |m| match m {
        ToConn::Arrived { space, build, estates } => Ok((space, build, estates)),
        other => Err(Box::new(other)),
    })
    .await?;
    // In a copy, the estates are their home channel's all the same: they come back to it.
    let estates = match estates {
        Some(e) => e,
        None => {
            post.sim(claimed.home_sim, ToSim::Estates { conn });
            wait_for(rx, &mut held, |m| match m {
                ToConn::Estates(e) => Ok(e),
                other => Err(Box::new(other)),
            })
            .await?
        }
    };
    let space = serde_json::to_value(&space).unwrap_or(Value::Null);
    Ok(WayIn { claimed, build, space, estates, held })
}

/// A build as it comes on the wire (src/content/build.ts): the learned skills, weapon, hotbar and
/// movement slots, by their places in the content. None if it isn't one, or isn't allowed with
/// `budget` skill points (in the open world, what the character has earned:
/// crate::life::progress::skill_budget). It is kept by id (crate::skills::saved_build).
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
    allowed(&b, budget).then_some(b)
}

async fn play(socket: WebSocket, gate: &Arc<Gate>, account: &Account, conn: Conn, name: String, admin: bool) -> Result<(), String> {
    let (mut tx, mut rx) = socket.split();
    let mut stage = gate.subscribe();
    let (events_tx, mut events) = mpsc::channel::<Event>(256);
    let mut seat = Seat::new(gate.clone(), conn, events_tx);
    let now = now_ms();
    let way = way_in(&mut seat, &mut events, &name, admin).await?;
    let post = gate.post.clone();
    send(
        &mut tx,
        json!({
            "t": "welcome",
            "protocol": WORLD_PROTOCOL,
            "content": content_hash(),
            "character": { "id": conn.character, "name": name },
            "account": account.username,
            "build": way.build,
            "now": now,
            "channel": way.claimed.channel,
            "dev": admin,
            "estates": way.estates.estates,
            "claims": way.estates.claims,
            "space": way.space,
        }),
    )
    .await?;
    // The server may have begun stopping while this connection was being set up.
    let mut told = false;
    let now = *stage.borrow_and_update();
    if let Some(done) = stopping(&mut tx, now, &mut told).await? {
        return Ok(done);
    }
    // What came meanwhile (their party, an invitation), after the welcome.
    for e in way.held {
        if let Some(done) = deliver(&mut tx, &mut seat, e, admin).await? {
            return Ok(done);
        }
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
                        if let (Some(inputs), Some(sim)) = (read_inputs(&b), seat.sim) {
                            post.sim(sim, ToSim::Inputs { conn, inputs });
                        }
                    }
                    Some(Ok(Message::Text(text))) => match serde_json::from_str::<FromBrowser>(text.as_str()) {
                        Ok(m) => {
                            if let Some(ask) = asked(m, conn, admin, post.as_ref()) {
                                match ask {
                                    Ok(ask) => {
                                        if let Some(sim) = seat.sim {
                                            post.sim(sim, ToSim::Ask { conn, ask });
                                        }
                                    }
                                    Err(text) => send(&mut tx, json!({ "t": "error", "text": text })).await?,
                                }
                            }
                        }
                        Err(_) => send(&mut tx, json!({ "t": "error", "text": "The server didn't understand that message." })).await?,
                    },
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e.to_string()),
                }
            }
            Some(e) = events.recv() => {
                if let Some(done) = deliver(&mut tx, &mut seat, e, admin).await? {
                    return Ok(done);
                }
            }
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

/// What a browser's text asks: of its game (an `Ask` for the simulation it plays in), or of the
/// social tier (sent there now: None). Err: why it can't be asked, to say to the browser.
fn asked(m: FromBrowser, conn: Conn, admin: bool, post: &dyn ruina_world_api::Transport) -> Option<Result<Ask, String>> {
    let social = |msg: ToSocial| {
        post.social(msg);
        None
    };
    Some(Ok(match m {
        FromBrowser::Cmd { s, c } => match serde_json::from_value::<Command>(c) {
            Ok(command) => Ask::Command { seq: s, command },
            Err(_) => return Some(Err("The server didn't understand that command.".into())),
        },
        FromBrowser::Build { build } => Ask::Build { build },
        // Starting a life over is a developer command: an admin's only.
        FromBrowser::Reset if !admin => return None,
        FromBrowser::Reset => Ask::Reset,
        FromBrowser::Challenge { to, game, stake, seed, turn } => Ask::Challenge { to, game, stake, seed, turn },
        FromBrowser::Withdraw => Ask::Withdraw,
        FromBrowser::Answer { from, accept } => Ask::Answer { from, accept },
        FromBrowser::Move { table, m } => Ask::Move { table, m },
        FromBrowser::Concede { table } => Ask::Concede { table },
        FromBrowser::Dungeon { id, enter } => Ask::Dungeon { id, enter },
        FromBrowser::Zone { id, team } => Ask::Zone { id, team },
        FromBrowser::PartyInvite { to, name } => return social(ToSocial::Invite { conn, to, name }),
        FromBrowser::PartyAnswer { from, accept } => return social(ToSocial::Answer { conn, from, accept }),
        FromBrowser::PartyLeave => return social(ToSocial::Leave { conn }),
        FromBrowser::PartyKick { id } => return social(ToSocial::Kick { conn, who: id }),
        FromBrowser::PartyLead { id } => return social(ToSocial::Lead { conn, who: id }),
    }))
}

/// Passes one thing on to the browser: a tick built into its update, or a message. Some(()) once
/// the connection is over (another window took the character over).
async fn deliver(tx: &mut Tx, seat: &mut Seat, e: Event, admin: bool) -> Result<Option<()>, String> {
    match e {
        Event::Tick(out) => {
            // A tick from where they were a moment ago, without them in it, is no use to them.
            if Some(out.sim) == seat.sim
                && let Some(me) = out.private_of(seat.conn.character)
            {
                tx.send(Message::Text(encode::tick(&out, me, admin).into())).await.map_err(|e| e.to_string())?;
            }
        }
        Event::Msg(ToConn::Kicked) => return replaced(tx).await.map(Some),
        // Their simulation is gone (another process plays the space now): ridden out as a deploy
        // is, the browser coming back in to where they were last saved.
        Event::Msg(ToConn::Rejoin { .. }) => {
            let mut told = false;
            stopping(tx, Stage::Updating, &mut told).await?;
            return stopping(tx, Stage::Closing, &mut told).await;
        }
        Event::Msg(m) => {
            if let ToConn::Moved { sim, .. } = &m {
                seat.sim = Some(*sim);
            }
            if let Some(text) = encode::message(&m) {
                tx.send(Message::Text(text.into())).await.map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(None)
}

/// A batch of inputs: 7, the count, then per input a u32 sequence number and the u32 tick (× 16)
/// the browser drew everyone else at (little-endian), and its OPEN_INPUT bytes. None if it isn't one.
fn read_inputs(b: &[u8]) -> Option<Vec<Input>> {
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
                Input { seq, view, raw }
            })
            .collect(),
    )
}

/// Another window took this character over: say so and hang up.
async fn replaced(tx: &mut Tx) -> Result<(), String> {
    let _ = send(tx, json!({ "t": "kicked" })).await;
    let _ = tx.send(Message::Close(None)).await;
    Ok(())
}

/// The server is stopping for an update. The browser hears it first (`updating`: it freezes the
/// world); once the lives are written it's hung up on as a service restart (1012), and waits for
/// the new server. Some(()) once the connection is closed. `told`: whether it has heard already (a
/// busy connection may only notice the stop once the lives are written, and still hears it first).
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
        assert_eq!(list[1].seq, 6);
        assert_eq!(list[1].view, 104);
        assert_eq!(list[0].raw[9], 127);
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
        let three = json!({ "skills": crate::skills::skills_from(&["sword", "cleave", "whirlwind"]), "weapon": crate::tuning::weapon_index("sword") });
        assert!(parse_build(&three, 2).is_none());
        assert!(parse_build(&three, 3).is_some());
    }
}
