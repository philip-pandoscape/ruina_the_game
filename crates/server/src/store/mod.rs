//! The store: what lasts. Characters' lives and builds, and (until land has tables of its own) what
//! a channel's residents have built, kept in Postgres (`db.rs`: the pool and the schema,
//! `crates/server/migrations/`, applied on start), or in memory for the tests (`memory.rs`).
//!
//! Every write about a character is fenced: it carries the epoch the directory granted them under,
//! and is refused if a newer grant was made since (`characters.epoch`: a newer window took them over,
//! or another simulation plays them now), so a simulation or a window that has lost a character can
//! never write over the one that has them. Writes that belong together (a mini-game's pot paid out
//! to one of two players) go in one transaction: both are kept or neither is. The store takes its
//! messages in the order they come, so a life is never written over by an older copy of itself.
//!
//! A life is read here (`Db::load_life`) and written here (`Db::write_lives`); the simulation takes it
//! up (`sim::load_island`) and puts it away (`sim::island_of`).

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use sqlx::PgPool;
use sqlx::types::Json;
use tokio::sync::mpsc;

use ruina_world_api::gate::ToConn;
use ruina_world_api::post::Answer;
use ruina_world_api::sim::ToSim;
use ruina_world_api::store::{LifeWrite, Resident, Then, ToStore};
use ruina_world_api::{CharacterId, Epoch, Millis, Transport};

/// Postgres: the pool, the schema and housekeeping.
pub mod db;
/// The tables in memory, for the tests.
pub mod memory;

/// Where what lasts is kept.
#[derive(Clone)]
pub enum Db {
    Pg(PgPool),
    Memory(Arc<Mutex<memory::Tables>>),
}

/// A character's row as read: their life, build, and when the life was saved (ms).
type LifeRow = (Option<Json<Value>>, Option<Json<Value>>, Option<i64>);

/// A character's life as saved, their build as kept, and when the life was saved.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Saved {
    pub life: Option<Value>,
    pub build: Option<Value>,
    pub saved_at: Option<Millis>,
}

/// The time now, in ms since 1970.
pub fn now_ms() -> Millis {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as Millis).unwrap_or(0)
}

impl Db {
    /// Tables in memory, and a handle to look at them (tests).
    pub fn memory() -> (Db, Arc<Mutex<memory::Tables>>) {
        let t = Arc::new(Mutex::new(memory::Tables::default()));
        (Db::Memory(t.clone()), t)
    }

    pub(crate) fn tables(t: &Mutex<memory::Tables>) -> std::sync::MutexGuard<'_, memory::Tables> {
        t.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A character's life, build and when the life was saved.
    pub async fn load_life(&self, character: CharacterId) -> Result<Saved, String> {
        match self {
            Db::Pg(db) => {
                let row: Option<LifeRow> = sqlx::query_as("SELECT island, build, (extract(epoch FROM saved_at) * 1000)::bigint FROM characters WHERE id = $1")
                    .bind(character)
                    .fetch_optional(db)
                    .await
                    .map_err(|e| e.to_string())?;
                let (life, build, saved_at) = row.ok_or("no such character")?;
                Ok(Saved { life: life.map(|j| j.0), build: build.map(|j| j.0), saved_at })
            }
            Db::Memory(t) => {
                let t = Db::tables(t);
                let c = t.characters.get(&character).ok_or("no such character")?;
                Ok(Saved { life: c.life.clone(), build: c.build.clone(), saved_at: c.saved_at })
            }
        }
    }

    /// Everyone who calls a channel home and has a life, with what they've built (in their state).
    pub async fn residents(&self, channel: u32) -> Result<Vec<Resident>, String> {
        match self {
            Db::Pg(db) => {
                let rows: Vec<(i64, String, Option<Json<Value>>)> =
                    sqlx::query_as("SELECT id, name, island->'state' FROM characters WHERE home_channel = $1 AND island IS NOT NULL")
                        .bind(channel as i32)
                        .fetch_all(db)
                        .await
                        .map_err(|e| e.to_string())?;
                Ok(rows.into_iter().filter_map(|(character, name, state)| state.map(|Json(state)| Resident { character, name, state })).collect())
            }
            Db::Memory(t) => {
                let t = Db::tables(t);
                Ok(t.characters
                    .iter()
                    .filter(|(_, c)| c.home_channel == Some(channel))
                    .filter_map(|(id, c)| Some(Resident { character: *id, name: c.name.clone(), state: c.life.as_ref()?.get("state")?.clone() }))
                    .collect())
            }
        }
    }

    /// Writes lives, each fenced by its epoch: one alone, or several in one transaction. Whether
    /// each was written (one whose epoch is stale is refused, and left as it was).
    pub async fn write_lives(&self, writes: &[LifeWrite]) -> Result<Vec<bool>, String> {
        const UPDATE: &str = "UPDATE characters SET island = $3, saved_at = now(), space = $4 WHERE id = $1 AND epoch = $2";
        match self {
            Db::Pg(db) => {
                if let [w] = writes {
                    let r = sqlx::query(UPDATE)
                        .bind(w.character)
                        .bind(w.epoch.0 as i64)
                        .bind(Json(&w.life))
                        .bind(w.space.to_string())
                        .execute(db)
                        .await
                        .map_err(|e| e.to_string())?;
                    return Ok(vec![r.rows_affected() == 1]);
                }
                let mut tx = db.begin().await.map_err(|e| e.to_string())?;
                let mut written = Vec::new();
                for w in writes {
                    let r = sqlx::query(UPDATE)
                        .bind(w.character)
                        .bind(w.epoch.0 as i64)
                        .bind(Json(&w.life))
                        .bind(w.space.to_string())
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                    written.push(r.rows_affected() == 1);
                }
                tx.commit().await.map_err(|e| e.to_string())?;
                Ok(written)
            }
            Db::Memory(t) => {
                let mut t = Db::tables(t);
                let now = now_ms();
                Ok(writes
                    .iter()
                    .map(|w| match t.characters.get_mut(&w.character) {
                        Some(c) if c.epoch == w.epoch.0 => {
                            c.life = Some(w.life.clone());
                            c.saved_at = Some(now);
                            c.space = Some(w.space.to_string());
                            true
                        }
                        _ => false,
                    })
                    .collect())
            }
        }
    }

    /// Keeps a character's build (fenced). Whether it was written.
    pub async fn write_build(&self, character: CharacterId, epoch: Epoch, build: &Value) -> Result<bool, String> {
        match self {
            Db::Pg(db) => {
                let r = sqlx::query("UPDATE characters SET build = $3 WHERE id = $1 AND epoch = $2")
                    .bind(character)
                    .bind(epoch.0 as i64)
                    .bind(Json(build))
                    .execute(db)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(r.rows_affected() == 1)
            }
            Db::Memory(t) => {
                let mut t = Db::tables(t);
                Ok(match t.characters.get_mut(&character) {
                    Some(c) if c.epoch == epoch.0 => {
                        c.build = Some(build.clone());
                        true
                    }
                    _ => false,
                })
            }
        }
    }
}

/// Starts the store: it takes its messages one at a time, in the order they come.
pub fn spawn(db: Db, post: Arc<dyn Transport>, mut inbox: mpsc::UnboundedReceiver<ToStore>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(msg) = inbox.recv().await {
            handle(&db, post.as_ref(), msg).await;
        }
    })
}

async fn handle(db: &Db, post: &dyn Transport, msg: ToStore) {
    match msg {
        ToStore::LoadLife { character, reply } => match db.load_life(character).await {
            Ok(s) => {
                post.conn(reply, ToConn::Life { life: s.life, build: s.build, saved_at: s.saved_at });
            }
            Err(e) => {
                eprintln!("could not read character {character}'s life: {e}");
                post.conn(reply, ToConn::Turned { text: "The server couldn't read your character just now. Try again in a moment.".into() });
            }
        },
        ToStore::LoadResidents { channel, reply } => {
            let residents = db.residents(channel).await.unwrap_or_else(|e| {
                eprintln!("could not read channel {channel}'s residents: {e}");
                Vec::new()
            });
            post.sim(reply, ToSim::Residents(residents));
        }
        ToStore::WriteLives { writes, then } => {
            let written = match db.write_lives(&writes).await {
                Ok(w) => w,
                Err(e) => {
                    eprintln!("could not save characters {:?}: {e}", writes.iter().map(|w| w.character).collect::<Vec<_>>());
                    vec![false; writes.len()]
                }
            };
            let at = now_ms();
            for (w, ok) in writes.iter().zip(&written) {
                if let (true, Some(conn)) = (*ok, w.tell) {
                    post.conn(conn, ToConn::Saved { at });
                }
            }
            match then {
                Then::Nothing => {}
                Then::Reset(conn) => {
                    if written.first() == Some(&true) {
                        post.conn(conn, ToConn::Reset);
                    }
                }
                Then::Answer(reply) => {
                    post.answer(reply, Answer::Written { lives: written.iter().filter(|w| **w).count() });
                }
            }
        }
        ToStore::WriteBuild { character, epoch, build } => match db.write_build(character, epoch, &build).await {
            Ok(true) => {}
            Ok(false) => eprintln!("character {character}'s build wasn't kept: their grant has moved on (epoch {})", epoch.0),
            Err(e) => eprintln!("could not keep character {character}'s build: {e}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ruina_world_api::gate::ToGate;
    use ruina_world_api::{Conn, GateId, SpaceId};
    use serde_json::json;

    fn write(character: CharacterId, epoch: u64, coins: f64) -> LifeWrite {
        LifeWrite {
            character,
            epoch: Epoch(epoch),
            life: json!({ "state": { "coins": coins } }),
            space: SpaceId::channel("emberholm", 1),
            writer: None,
            tell: None,
        }
    }

    #[tokio::test]
    async fn a_write_under_an_older_grant_is_refused() {
        let (db, tables) = Db::memory();
        {
            let mut t = Db::tables(&tables);
            t.add_character(7, "Ada");
            t.characters.get_mut(&7).unwrap().epoch = 3;
        }
        // Under the grant they hold: written.
        assert_eq!(db.write_lives(&[write(7, 3, 10.0)]).await, Ok(vec![true]));
        // A window (or a simulation) that lost them to a newer grant writes too late: refused, and
        // what's kept is the newer one's.
        assert_eq!(db.write_lives(&[write(7, 2, 999.0)]).await, Ok(vec![false]));
        assert_eq!(db.load_life(7).await.unwrap().life, Some(json!({ "state": { "coins": 10.0 } })));
        assert_eq!(Db::tables(&tables).characters[&7].space.as_deref(), Some("channel:emberholm:1"));
        // Builds are fenced the same way.
        assert_eq!(db.write_build(7, Epoch(2), &json!({ "weapon": "bow" })).await, Ok(false));
        assert_eq!(db.write_build(7, Epoch(3), &json!({ "weapon": "bow" })).await, Ok(true));
    }

    #[tokio::test]
    async fn the_store_says_what_it_wrote_and_to_whom() {
        let (db, tables) = Db::memory();
        Db::tables(&tables).add_character(7, "Ada");
        let post = crate::post::Post::new();
        let mut gate = post.open_gate(GateId(1));
        let conn = Conn { gate: GateId(1), character: 7, session: 5 };
        let mut w = write(7, 0, 5.0);
        w.tell = Some(conn);
        handle(&db, post.as_ref(), ToStore::WriteLives { writes: vec![w], then: Then::Reset(conn) }).await;
        let said: Vec<ToGate> = std::iter::from_fn(|| gate.try_recv().ok()).collect();
        assert!(matches!(said[0], ToGate::Conn { msg: ToConn::Saved { .. }, .. }));
        assert!(matches!(said[1], ToGate::Conn { msg: ToConn::Reset, .. }));
        // Stale: neither said.
        handle(&db, post.as_ref(), ToStore::WriteLives { writes: vec![write(7, 9, 1.0)], then: Then::Reset(conn) }).await;
        assert!(gate.try_recv().is_err());
    }
}
