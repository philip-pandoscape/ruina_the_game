//! The store: what lasts. Characters' lives and builds, and land (`land/`: a row a piece by where it
//! stands, the house plots' claims, the ledger, the world's market), kept in Postgres (`db.rs`: the
//! pool and the schema, `crates/server/migrations/`, applied on start, saves from before land had
//! rows moved into them), or in memory for the tests (`memory.rs`).
//!
//! Every write about a character is fenced: it carries the epoch the directory granted them under,
//! and is refused if a newer grant was made since (`characters.epoch`: a newer window took them over,
//! or another simulation plays them now), so a simulation or a window that has lost a character can
//! never write over the one that has them. Writes that belong together (a life and the land lent to
//! it, a mini-game's pot paid out to one of two players) go in one transaction: all are kept or none
//! is. The store takes its messages in the order they come, so a life is never written over by an
//! older copy of itself, and a claim is never undone by a save made before it.
//!
//! A life is read here with the land lent to it and a block of ids for what it places
//! (`Db::load_life`, `Db::holding`, `Db::reserve_ids`), and written here (`Db::write_lives`: the life
//! on the character's row, its land as rows, what it kept for the ledger as the ledger's); the
//! simulation takes it up (`sim::load_island`) and puts it away (`sim::island_of`). A region's
//! simulation reads its land (`Db::region_land`) as it starts.

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use sqlx::PgPool;
use sqlx::types::Json;
use tokio::sync::mpsc;

use ruina_world_api::gate::ToConn;
use ruina_world_api::post::Answer;
use ruina_world_api::sim::ToSim;
use ruina_world_api::store::{ClaimResult, LifeWrite, RegionLand, Then, ToStore, Transfer};
use ruina_world_api::{CharacterId, Epoch, Millis, Transport};

use crate::life::land::{House, Ids, Land, kept_inside};
use crate::life::market::Market;
use crate::life::state::LIFE_VERSION;
use land::{Fence, LifeSave};

/// Postgres: the pool, the schema and housekeeping.
pub mod db;
/// Land, the plots, the ledger and the market, as Postgres keeps them.
pub mod land;
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

    /// Everything of a character's in the world, as the engine keeps it: the land lent to their life
    /// while they play.
    pub async fn holding(&self, owner: CharacterId) -> Result<Land, String> {
        match self {
            Db::Pg(db) => land::load_holding(db, owner).await.map_err(|e| e.to_string()),
            Db::Memory(t) => Ok(Db::tables(t).holding(owner)),
        }
    }

    /// A block of ids for what a character places, no other piece in the world's.
    pub async fn reserve_ids(&self) -> Result<Ids, String> {
        match self {
            Db::Pg(db) => land::reserve_ids(db).await.map_err(|e| e.to_string()),
            Db::Memory(t) => Ok(Db::tables(t).reserve_ids()),
        }
    }

    /// Writes lives, each fenced by its epoch, each with the land lent to it and what it kept for the
    /// ledger: one alone, or several in one transaction. Whether each was written (one whose epoch is
    /// stale is refused, and left as it was).
    pub async fn write_lives(&self, writes: &[LifeWrite]) -> Result<Vec<bool>, String> {
        match self {
            Db::Pg(db) => land::save(db, &writes.iter().map(save_of).collect::<Vec<_>>()).await.map_err(|e| e.to_string()),
            Db::Memory(t) => {
                let mut t = Db::tables(t);
                let now = now_ms();
                Ok(writes.iter().map(|w| t.write_life(w, now)).collect())
            }
        }
    }

    /// A region's land: everyone's who has any in the world, by owner with their name, who holds each
    /// plot, and the world's market. (A channel plays every chunk of the world today, so a region's
    /// land is the world's; a simulation playing part of it would read its chunks: `land::load_land`.)
    pub async fn region_land(&self, _region: &str) -> Result<RegionLand, String> {
        match self {
            Db::Pg(db) => {
                let e = |e: sqlx::Error| e.to_string();
                let by_owner = land::load_land(db, None).await.map_err(e)?;
                let claims = land::plots::claims(db).await.map_err(e)?;
                let owners: Vec<i64> = by_owner.keys().copied().collect();
                let names = land::names(db, &owners).await.map_err(e)?;
                let market = land::market::load(db).await.map_err(e)?;
                Ok(RegionLand {
                    holdings: by_owner
                        .into_iter()
                        .map(|(owner, l)| (owner, names.get(&owner).cloned().unwrap_or_default(), serde_json::to_value(l).unwrap_or(Value::Null)))
                        .collect(),
                    claims: claims.into_iter().map(|(plot, (holder, name))| (plot, holder, name)).collect(),
                    market: serde_json::to_value(market).unwrap_or(Value::Null),
                })
            }
            Db::Memory(t) => Ok(Db::tables(t).region_land()),
        }
    }

    /// Claims a plot for a character, under their grant, with the house just put on it: first come in
    /// the whole world.
    pub async fn claim_plot(&self, character: CharacterId, epoch: Epoch, plot: &str, house: &House) -> Result<ClaimResult, String> {
        match self {
            Db::Pg(db) => {
                let fence = Fence::Epoch { character, epoch: epoch.0 as i64 };
                Ok(match land::plots::claim(db, plot, character, fence, house).await.map_err(|e| e.to_string())? {
                    land::plots::Claim::Yours => ClaimResult::Yours,
                    land::plots::Claim::Theirs { holder, name } => ClaimResult::Theirs { holder, name },
                    land::plots::Claim::Stale => ClaimResult::Stale,
                })
            }
            Db::Memory(t) => Ok(Db::tables(t).claim(plot, character, epoch.0 as i64, house)),
        }
    }

    /// Takes down those of these houses whose tax is unpaid too long at `at` (the world's clock), as
    /// the store has them. The plots let go, with whose they were.
    pub async fn take_down(&self, houses: &[i64], at: f64) -> Result<Vec<(String, CharacterId)>, String> {
        match self {
            Db::Pg(db) => land::plots::take_down(db, houses, at).await.map_err(|e| e.to_string()),
            Db::Memory(t) => Ok(Db::tables(t).take_down(houses, at)),
        }
    }

    /// A pack sold at a trading post at `at` (the world's clock): the world's demand there drops.
    pub async fn sold(&self, outpost: &str, pack: &str, at: f64) -> Result<(), String> {
        match self {
            Db::Pg(db) => land::market::sold(db, outpost, pack, at).await.map(|_| ()).map_err(|e| e.to_string()),
            Db::Memory(t) => {
                Db::tables(t).market.sell(outpost, pack, at);
                Ok(())
            }
        }
    }

    /// The world's market as it stands.
    pub async fn market(&self) -> Result<Market, String> {
        match self {
            Db::Pg(db) => land::market::load(db).await.map_err(|e| e.to_string()),
            Db::Memory(t) => Ok(Db::tables(t).market.clone()),
        }
    }

    /// A transfer between characters and the lives it changes, in one transaction, once: which of the
    /// lives were written, or None if it was before (nothing is written again).
    pub async fn transfer(&self, t: &Transfer, writes: &[LifeWrite]) -> Result<Option<Vec<bool>>, String> {
        match self {
            Db::Pg(db) => {
                let sides = t
                    .sides
                    .iter()
                    .map(|(character, party, coins)| land::ledger::Side {
                        character: *character,
                        party: party.clone(),
                        coins: *coins,
                        seals: 0.0,
                        items: Vec::new(),
                    })
                    .collect();
                let transfer = land::ledger::Transfer { key: t.key.clone(), kind: t.kind.clone(), sides, detail: t.detail.clone() };
                let saves: Vec<LifeSave> = writes.iter().map(save_of).collect();
                Ok(match land::ledger::transfer(db, &transfer, &saves).await.map_err(|e| e.to_string())? {
                    land::ledger::Applied::Now(written) => Some(written),
                    land::ledger::Applied::Already => None,
                })
            }
            Db::Memory(tables) => Ok(Db::tables(tables).transfer(t, writes, now_ms())),
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

/// A life as the simulation hands it over, as `land::save` writes it: under the character's grant,
/// the land apart from the life.
fn save_of(w: &LifeWrite) -> LifeSave {
    let (life, land) = land::split(&w.life);
    LifeSave { character: w.character, fence: Fence::Epoch { character: w.character, epoch: w.epoch.0 as i64 }, life, land, space: Some(w.space.to_string()) }
}

/// A life as the store keeps it, with the land lent to it beside it (`{state, land, player}`), as the
/// simulation takes it up. A save from before land had rows (its land inside its state, or beside it
/// already) is left as it is: its land is in it.
pub fn with_land(mut life: Value, holding: &Land) -> Value {
    let version = life.get("state").and_then(|s| s.get("version")).and_then(Value::as_i64).unwrap_or(0);
    if version >= LIFE_VERSION
        && kept_inside(&life)
        && let Some(o) = life.as_object_mut()
    {
        o.insert("land".into(), serde_json::to_value(holding).unwrap_or(Value::Null));
    }
    life
}

/// Tells each writer that the ledger has what the lives it wrote held: they forget it.
fn recorded(post: &dyn Transport, writes: &[LifeWrite], written: &[bool]) {
    for (w, ok) in writes.iter().zip(written) {
        if let (true, Some(writer), Some(upto)) = (*ok, &w.writer, land::last_entry(&w.life)) {
            post.sim(writer.sim, ToSim::Recorded { character: w.character, upto });
        }
    }
}

/// A character's life for the connection taking them up: with the land lent to it, and a block of
/// ids for what they place.
async fn life_for(db: &Db, character: CharacterId) -> Result<(Saved, Ids), String> {
    let mut s = db.load_life(character).await?;
    if let Some(life) = s.life.take() {
        s.life = Some(with_land(life, &db.holding(character).await?));
    }
    Ok((s, db.reserve_ids().await?))
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
        ToStore::LoadLife { character, reply } => match life_for(db, character).await {
            Ok((s, ids)) => {
                post.conn(reply, ToConn::Life { life: s.life, build: s.build, saved_at: s.saved_at, ids: Some((ids.next, ids.end)) });
            }
            Err(e) => {
                eprintln!("could not read character {character}'s life: {e}");
                post.conn(reply, ToConn::Turned { text: "The server couldn't read your character just now. Try again in a moment.".into() });
            }
        },
        ToStore::LoadLand { region, reply } => {
            let land = db.region_land(&region).await.unwrap_or_else(|e| {
                // It starts with none (whoever claims a held plot finds it held): better than not at all.
                eprintln!("could not read {region}'s land: {e}");
                RegionLand::default()
            });
            post.sim(reply, ToSim::Land(land));
        }
        ToStore::ClaimPlot { character, epoch, plot, house, reply } => {
            let result = match serde_json::from_value::<House>(house) {
                Ok(h) => db.claim_plot(character, epoch, &plot, &h).await,
                Err(e) => Err(format!("the house isn't one: {e}")),
            };
            let result = result.unwrap_or_else(|e| {
                // Not written: the claim comes back as not made, and the blueprint with it.
                eprintln!("could not claim {plot} for character {character}: {e}");
                ClaimResult::Stale
            });
            post.sim(reply, ToSim::Claim { character, plot, result });
        }
        ToStore::TakeDown { houses, at, writer } => match db.take_down(&houses, at).await {
            Ok(freed) => {
                for (plot, holder) in freed {
                    eprintln!("{}: {plot} is free, character {holder}'s house on it taken down (its tax unpaid too long)", writer.space);
                }
            }
            Err(e) => eprintln!("could not take down houses {houses:?}: {e}"),
        },
        ToStore::Sold { outpost, pack, at } => {
            if let Err(e) = db.sold(&outpost, &pack, at).await {
                eprintln!("could not lower {outpost}'s demand for {pack}: {e}");
            }
        }
        ToStore::LoadMarket { reply } => match db.market().await {
            Ok(m) => {
                post.sim(reply, ToSim::Market(serde_json::to_value(m).unwrap_or(Value::Null)));
            }
            Err(e) => eprintln!("could not read the world's market: {e}"),
        },
        ToStore::ReserveIds { character, reply } => match db.reserve_ids().await {
            Ok(ids) => {
                post.sim(reply, ToSim::Ids { character, next: ids.next, end: ids.end });
            }
            Err(e) => eprintln!("could not reserve ids for character {character}: {e}"),
        },
        ToStore::Transfer { transfer, writes } => match db.transfer(&transfer, &writes).await {
            Ok(Some(written)) => {
                let at = now_ms();
                for (w, ok) in writes.iter().zip(&written) {
                    if let (true, Some(conn)) = (*ok, w.tell) {
                        post.conn(conn, ToConn::Saved { at });
                    }
                }
                recorded(post, &writes, &written);
            }
            Ok(None) => eprintln!("transfer {} was written before: nothing is written again", transfer.key),
            Err(e) => eprintln!("could not write transfer {}: {e}", transfer.key),
        },
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
            recorded(post, &writes, &written);
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
